// ============================================================================
// tools/ingest.ts — Unified content ingestion pipeline
// ============================================================================
// 7-step pipeline:
//   1. Source detection (kind, provenance, confidence from path/url/content)
//   2. Content hashing + dedup (file-level + chunk-level)
//   3. Structure-aware chunking (by headings/functions/paragraphs)
//   4. Entity creation (source, topic, course/module entities)
//   5. Embedding + belief storage (with per-kind provenance)
//   6. Graph enrichment (tagging, course links)
//   7. Batch course mode (directory scan, prerequisite edges)
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getDb } from '../lib/engine';
import { embed } from '../lib/embedding';
import { validateIngestPath, stripInjectionAttempts } from '../lib/security';
import { chunkContent } from '../lib/clean';
import type { ChunkResult } from '../lib/clean';
import { readConfig } from '../lib/context';
import { EXT_VAR_DIR } from '../lib/constants';
import type { ToolDefinition } from '../lib/tool-registry';

// ═══════════════════════════════════════════════════════════
// Source type configuration
// ═══════════════════════════════════════════════════════════

interface SourceTypeConfig {
  provenance: string;
  confidence: number;
}

const SOURCE_CONFIGS: Record<string, SourceTypeConfig> = {
  raw_course:     { provenance: 'course_material', confidence: 0.9 },
  personal_note:  { provenance: 'user_written',    confidence: 0.6 },
  web_research:   { provenance: 'web_research',    confidence: 0.5 },
  code:           { provenance: 'ingested',        confidence: 0.7 },
  user_text:      { provenance: 'user_supplied',   confidence: 0.7 },
  cv_document:    { provenance: 'user_written',    confidence: 0.95 },
  job_listing:    { provenance: 'web_research',    confidence: 0.5 },
};

function getSourceConfig(kind: string): SourceTypeConfig {
  return SOURCE_CONFIGS[kind] || { provenance: 'ingested', confidence: 0.7 };
}

// ═══════════════════════════════════════════════════════════
// Content hashing
// ═══════════════════════════════════════════════════════════

function contentHash(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ═══════════════════════════════════════════════════════════
// Frontmatter extraction
// ═══════════════════════════════════════════════════════════

interface ExtractedFrontmatter {
  title?: string;
  aliases?: string[];
  tags?: string[];
  status?: string;
  source?: string;
  course_id?: string;
  confidence?: number;
  created?: string;
}

function extractFrontmatter(content: string): ExtractedFrontmatter {
  const fm: ExtractedFrontmatter = {};
  // Normalize line endings first (handle Windows \r\n)
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return fm;

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');

    switch (key) {
      case 'title': fm.title = val; break;
      case 'aliases': fm.aliases = val.split(',').map(s => s.trim().replace(/^\[|\]$/g, '').replace(/^["']|["']$/g, '')).filter(Boolean); break;
      case 'tags': fm.tags = val.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean); break;
      case 'status': fm.status = val; break;
      case 'source': fm.source = val; break;
      case 'course_id': fm.course_id = val; break;
      case 'confidence': fm.confidence = parseFloat(val); break;
      case 'created': fm.created = val; break;
    }
  }
  return fm;
}

// ═══════════════════════════════════════════════════════════
// Source kind detection
// ═══════════════════════════════════════════════════════════

interface SourceDetection {
  kind: string;
  isCourse: boolean;
  courseId: string;
  module: number;
  section: string;
}

function detectSourceKind(filePath: string, basename: string, frontmatter: ExtractedFrontmatter): SourceDetection {
  // Priority 1: Explicit course file pattern {N}.{N}.{N} Topic.md
  const courseMatch = basename.match(/^(\d+)\.(\d+)(?:\.(\d+))?\s+(.+)\.md$/i);
  if (courseMatch) {
    const moduleNum = parseInt(courseMatch[1], 10);
    const sectionStr = courseMatch[2];
    const subsection = courseMatch[3] || '';
    const section = subsection ? `${sectionStr}.${subsection}` : sectionStr;
    const cid = frontmatter.course_id || frontmatter.source?.match(/courses\/(\d+)/)?.[1] || 'unknown';
    return { kind: 'raw_course', isCourse: true, courseId: cid, module: moduleNum, section };
  }

  // Priority 2: Path contains course/ or raw/ (from ailov2 structure)
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPath.includes('/course/') || normalizedPath.includes('/raw/')) {
    const cid = frontmatter.course_id || frontmatter.source?.match(/courses\/(\d+)/)?.[1] || 'unknown';
    // Try to extract module number from path
    const modMatch = normalizedPath.match(/module[-\s](\d+)/i);
    const moduleNum = modMatch ? parseInt(modMatch[1], 10) : 0;
    return { kind: 'raw_course', isCourse: true, courseId: cid, module: moduleNum, section: '' };
  }

  // Priority 3: Path contains notes/ or my-notes/ or journal/
  if (normalizedPath.includes('/notes/') || normalizedPath.includes('/my-notes/') || normalizedPath.includes('/journal/')) {
    return { kind: 'personal_note', isCourse: false, courseId: '', module: 0, section: '' };
  }

  // Priority 4: Path contains cv/ or resume/
  if (normalizedPath.includes('/cv/') || normalizedPath.includes('/resume/')) {
    return { kind: 'cv_document', isCourse: false, courseId: '', module: 0, section: '' };
  }

  return { kind: 'file', isCourse: false, courseId: '', module: 0, section: '' };
}

// ═══════════════════════════════════════════════════════════
// Canvas course number mapping
// ═══════════════════════════════════════════════════════════

/** Maps Canvas course numbers from URL paths to user-facing course labels. */
const CANVAS_COURSE_MAP: Record<string, string> = {
  '997': 'course-1',
  '1027': 'course-2',
  '1065': 'course-3',
};

// ═══════════════════════════════════════════════════════════
// Tag inference
// ═══════════════════════════════════════════════════════════

function inferTags(sourceUrl: string, isCourse: boolean, courseId: string, module: number, explicitTags: string[], title?: string): Set<string> {
  const tags = new Set<string>(explicitTags || []);
  if (sourceUrl.includes('github')) tags.add('github');
  if (sourceUrl.includes('docs') || sourceUrl.includes('documentation')) tags.add('documentation');
  if (sourceUrl.includes('ladybugdb')) tags.add('ladybugdb');
  if (isCourse && courseId) {
    tags.add(`course_${courseId}`);
    const mappedLabel = CANVAS_COURSE_MAP[courseId];
    if (mappedLabel) tags.add(mappedLabel);
  }
  if (isCourse && module >= 0) tags.add(`module-${module}`);
  
  // Extract detailed topic tags from title using n-grams
  if (title) {
    const topicPart = title.replace(/^[\d.\s]+/, '').trim();
    if (topicPart && topicPart.length > 2) {
      // Normalize: lowercase, remove special chars except spaces/hyphens
      const normalized = topicPart.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
      const words = normalized.split(/\s+/).filter(w => w.length > 2);
      
      // Stop words to filter
      const stopWords = new Set([
        'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from',
        'is','are','was','were','be','been','been','have','has','had','do','does','did',
        'will','would','can','could','should','may','might','shall','this','that','these',
        'those','its','your','our','their','what','which','who','whom','when','where',
        'why','how','all','each','every','both','few','more','most','some','any','no','not',
        'only','very','just','also','well','even','still','already','into','than','then',
        'about','after','before','between','through','during','without','within','across',
        'using','based','such','because','other','another','being','done','made','way',
        'new','used','including','related','various','within','without','along'
      ]);
      
      // Generate n-grams (1, 2, and 3 word phrases)
      const ngrams: string[] = [];
      
      // 1-grams: individual meaningful words
      for (const w of words) {
        if (w.length > 3 && !stopWords.has(w) && !/^(practic|activ|introduc|understand|overview|basics?)$/i.test(w)) {
          ngrams.push(w);
        }
      }
      
      // 2-grams: word pairs — only if BOTH words are meaningful (no stop words)
      for (let i = 0; i < words.length - 1; i++) {
        if (stopWords.has(words[i]) || stopWords.has(words[i + 1])) continue;
        ngrams.push(words[i] + '-' + words[i + 1]);
      }
      
      // 3-grams: word triples — only if ALL words are meaningful
      for (let i = 0; i < words.length - 2; i++) {
        if (stopWords.has(words[i]) || stopWords.has(words[i + 1]) || stopWords.has(words[i + 2])) continue;
        if (words[i].match(/^(practic|activ)$/)) continue;
        ngrams.push(words[i] + '-' + words[i + 1] + '-' + words[i + 2]);
      }
      
      for (const ng of ngrams) {
        tags.add(ng);
      }
    }
  }
  
  return tags;
}

// ═══════════════════════════════════════════════════════════
// Entity creation helpers
// ═══════════════════════════════════════════════════════════

async function ensureCourseEntity(db: any, courseId: string): Promise<string> {
  const name = `course_${courseId}`;
  const existing = await db.query('MATCH (e:Entity {name: $name}) RETURN e.id', { name });
  if (existing.length > 0) return existing[0].id;

  const id = crypto.randomUUID();
  await db.addNode('Entity', {
    id, name, type: 'course', confidence: 1.0,
    mention_count: 0, momentum: 0, created_at: new Date().toISOString(),
  });
  return id;
}

async function ensureModuleEntity(db: any, courseId: string, moduleNum: number): Promise<string> {
  const name = `course_${courseId}_module_${moduleNum}`;
  const existing = await db.query('MATCH (e:Entity {name: $name}) RETURN e.id', { name });
  if (existing.length > 0) return existing[0].id;

  const id = crypto.randomUUID();
  await db.addNode('Entity', {
    id, name, type: 'module', confidence: 1.0,
    mention_count: 0, momentum: 0, created_at: new Date().toISOString(),
  });
  return id;
}

async function ensureTopicEntity(db: any, topicName: string): Promise<string | null> {
  if (!topicName || topicName.length < 2) return null;
  const existing = await db.query('MATCH (e:Entity {name: $name}) RETURN e.id', { name: topicName });
  if (existing.length > 0) return existing[0].id;

  const id = crypto.randomUUID();
  await db.addNode('Entity', {
    id, name: topicName, type: 'topic', confidence: 0.5,
    mention_count: 0, momentum: 0, created_at: new Date().toISOString(),
  });
  return id;
}

// ═══════════════════════════════════════════════════════════
// Tool definition
// ═══════════════════════════════════════════════════════════

export const ingestToolDef: ToolDefinition = {
  name: 'ingest',
  label: 'Ingest',
  description: 'Import a file, URL, or text as searchable knowledge. Auto-detects content type.',
  category: 'ingest',
  aliases: 'import, consume, load',
  promptSnippet: 'Ingest content into the knowledge base',
  promptGuidelines: [
    'Use ingest to permanently store content from files, web pages, or pasted text.',
    'Auto-detects: markdown files, code files, course material, and plain text.',
    'Course files (named {N}.{N}.{N} Topic.md) get special module/section organization.',
    'Set replace:true to re-ingest content and replace existing beliefs (e.g. after a chunking fix).',
  ],
  register: registerIngestTool,
};

// ═══════════════════════════════════════════════════════════
// Registration function
// ═══════════════════════════════════════════════════════════

export function registerIngestTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'ingest',
    label: 'Ingest',
    description: 'Import a file, URL, or text as searchable knowledge. Auto-detects content type.',
    promptSnippet: ingestToolDef.promptSnippet,
    promptGuidelines: ingestToolDef.promptGuidelines,
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: 'Source URL (optional if path is provided)' })),
      path: Type.Optional(Type.String({ description: 'Local file path to ingest' })),
      content: Type.Optional(Type.String({ description: 'Raw text content to ingest' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Tags for categorization' })),
      kind: Type.Optional(Type.String({ description: 'Override kind detection: raw_course, personal_note, web_research, code, cv_document, job_listing, file, text' })),
      course_id: Type.Optional(Type.String({ description: 'Course ID for course material (auto-detected from path if omitted)' })),
      module_count: Type.Optional(Type.Number({ description: 'If set with a directory path, batch-ingest all course files' })),
      replace: Type.Optional(Type.Boolean({ description: 'If true, remove existing beliefs for this content before re-ingesting (default false)' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const db = getDb();
      const now = new Date().toISOString();

      // ── Batch course mode ────────────────────────────────
      if (params.module_count && params.path) {
        return ingestCourseDirectory(db, params.path, params.course_id || 'unknown', params.module_count, params.kind);
      }

      // ── Step 1: Source detection ─────────────────────────
      let sourceContent = '';
      let sourceUrl = '';
      let ext = '.txt';
      let explicitKind = params.kind || '';

      if (params.path) {
        const validated = validateIngestPath(params.path);
        if (!validated.ok) return { content: [{ type: 'text', text: validated.error }], details: {} };
        sourceContent = fs.readFileSync(validated.resolved, 'utf-8');
        sourceUrl = params.path;
        ext = path.extname(params.path).toLowerCase();
      } else if (params.url) {
        sourceContent = params.content || '';
        sourceUrl = params.url;
        explicitKind = explicitKind || 'web_research';
      } else if (params.content) {
        sourceContent = params.content;
        explicitKind = explicitKind || 'user_text';
      } else {
        return { content: [{ type: 'text', text: 'Must provide either content, path, or url.' }], details: {} };
      }

      if (!sourceContent.trim()) return { content: [{ type: 'text', text: 'No content to ingest.' }], details: {} };

      // Injection strip
      sourceContent = stripInjectionAttempts(sourceContent);

      // Extract frontmatter
      const frontmatter = extractFrontmatter(sourceContent);

      // Detect source kind from path/name if not explicitly overridden
      let detection: SourceDetection;
      if (explicitKind) {
    // Still detect source metadata for module/section extraction
    const srcBasename = params.path ? path.basename(params.path) : '';
    const autoDetect = detectSourceKind(sourceUrl, srcBasename, frontmatter);
    detection = {
      kind: explicitKind,
      isCourse: explicitKind === 'raw_course',
      courseId: params.course_id || frontmatter.course_id || autoDetect.courseId || '',
      module: autoDetect.module,
      section: autoDetect.section,
    };
      } else {
        const basename = params.path ? path.basename(params.path) : '';
        detection = detectSourceKind(sourceUrl, basename, frontmatter);
        // Use explicit course_id if provided
        if (params.course_id) detection.courseId = params.course_id;
      }

      const kind = detection.kind;

      // Normalize ext for chunking: course material and notes use markdown chunking
      if (ext === '.md' || kind === 'raw_course' || kind === 'personal_note' || kind === 'cv_document') {
        ext = '.md';
      }

      // ── Step 2: Content hashing + dedup ──────────────────
      const fileHash = contentHash(sourceContent);

      // If replace mode: find and remove existing resource + beliefs for this content
      if (params.replace) {
        try {
          const existing = await db.query(
            "MATCH (e:Entity {content_hash: $hash}) RETURN e.id AS id, e.name AS name LIMIT 1",
            { hash: fileHash }
          );
          if (existing.length > 0) {
            const oldId = existing[0].id;
            // Delete all associated Belief nodes and their edges
            await db.exec(
              "MATCH (e:Entity {id: $id})-[r:HAS_BELIEF]->(b:Belief) DELETE r, b",
              { id: oldId }
            );
            // DETACH DELETE the resource entity itself (removes remaining edges)
            await db.exec(
              "MATCH (e:Entity {id: $id}) DETACH DELETE e",
              { id: oldId }
            );
            console.log("[ingest] Replaced existing resource: " + existing[0].name);
          }
        } catch { /* first ingest or replace on non-existent — proceed normally */ }
      } else {
        // File-level dedup: skip if same path + hash already ingested
        if (params.path) {
          try {
            const existing = await db.query(
              "MATCH (e:Entity {content_hash: $hash, path: $path}) RETURN e.name AS name LIMIT 1",
              { hash: fileHash, path: params.path }
            );
            if (existing.length > 0) {
              return { content: [{ type: "text", text: "Already ingested: " + existing[0].name + " (content unchanged, skipped)" }], details: {} };
            }
          } catch { /* first ingest — no content_hash column yet for old data */ }
        }
      }

      // ── Step 3: Structure-aware chunking ────────────────
      const sections = chunkContent(sourceContent, ext, { docTitle: frontmatter.title });

      // ── Step 4: Entity creation ─────────────────────────
      // Determine resource entity name
      const resourceName = [
        sourceUrl.split('/').filter(Boolean).pop(),
        sourceUrl,
        `ingested-${Date.now()}`,
      ].find(s => s && s.length > 0) || `ingested-${Date.now()}`;

      const resourceId = crypto.randomUUID();
      const sourceConfig = getSourceConfig(kind);

      const entityProps: any = {
        id: resourceId,
        name: resourceName,
        type: 'resource',
        confidence: frontmatter.confidence ?? sourceConfig.confidence,
        mention_count: 0, momentum: 0,
        content_hash: fileHash,
        url: params.url || '',
        path: params.path || '',
        kind,
        course_id: detection.courseId || undefined,
        module: detection.module > 0 ? detection.module : undefined,
        section: detection.section || undefined,
        tags: (frontmatter.tags || params.tags || []).join(','),
        created_at: frontmatter.created || now,
      };
      await db.addNode('Entity', entityProps);

      // Create course entity link (if course material)
      let courseEntityId: string | null = null;
      if (detection.isCourse && detection.courseId) {
        courseEntityId = await ensureCourseEntity(db, detection.courseId);
        await db.addEdge('Entity', 'id', courseEntityId, 'Entity', 'id', resourceId, 'BELONGS_TO_COURSE');
      }

      // Create module entity link (if course material with module)
      let moduleEntityId: string | null = null;
      if (detection.isCourse && detection.module > 0) {
        moduleEntityId = await ensureModuleEntity(db, detection.courseId, detection.module);
        await db.addEdge('Entity', 'id', moduleEntityId, 'Entity', 'id', resourceId, 'BELONGS_TO_MODULE');
      }

      // ── Step 5: Embedding + belief storage ──────────────
      const chunkCount = await storeChunks(db, resourceId, resourceName, sections, sourceConfig, now);

      // ── Step 6: Graph enrichment — tagging ──────────────
      const tagSet = inferTags(sourceUrl, detection.isCourse, detection.courseId, detection.module, params.tags || frontmatter.tags || [], frontmatter.title);

      // Add tags from frontmatter
      if (frontmatter.tags) {
        for (const t of frontmatter.tags) tagSet.add(t);
      }

      // Create tag entities and link via HAS_RESOURCE
      for (const tag of tagSet) {
        try {
          const existing = await db.query('MATCH (e:Entity {name: $name}) RETURN e.id', { name: tag });
          let tagId: string;
          if (existing.length > 0) {
            tagId = existing[0].id;
          } else {
            tagId = crypto.randomUUID();
            await db.addNode('Entity', {
              id: tagId, name: tag, type: 'concept', confidence: 0.5,
              mention_count: 0, momentum: 0, created_at: now,
            });
          }
          await db.addEdge('Entity', 'id', tagId, 'Entity', 'id', resourceId, 'HAS_RESOURCE');
        } catch {}
      }

      // Try to create topic entities from chunk labels (concept extraction)
      const seenTopics = new Set<string>();
      for (const sec of sections) {
        if (sec.label && sec.label.length > 2 && !seenTopics.has(sec.label.toLowerCase())) {
          seenTopics.add(sec.label.toLowerCase());
          try {
            const topicId = await ensureTopicEntity(db, sec.label);
            if (topicId) {
              await db.addEdge('Entity', 'id', topicId, 'Entity', 'id', resourceId, 'HAS_RESOURCE');
            }
          } catch {}
        }
      }

      const tagNames = [...tagSet].join(', ');
      const result = `Ingested "${resourceName}" — ${chunkCount} chunk(s), ${tagSet.size} tagged.`;
      return { content: [{ type: 'text', text: tagNames ? `${result} Tags: ${tagNames}` : result }], details: {} };
    },
  });
}

// ═══════════════════════════════════════════════════════════
// Chunk storage (Step 5)
// ═══════════════════════════════════════════════════════════

async function storeChunks(
  db: any,
  resourceId: string,
  resourceName: string,
  sections: ChunkResult[],
  config: SourceTypeConfig,
  now: string,
): Promise<number> {
  let chunkCount = 0;

  for (let i = 0; i < sections.length; i += 10) {
    const batch = sections.slice(i, i + 10);
    const texts = batch.map(s => s.content.substring(0, 1000));
    const vectors = await embed(texts);

    for (let j = 0; j < batch.length; j++) {
      const sec = batch[j];
      const chunkHash = sec.hash; // Already computed by chunkContent

      // Chunk-level dedup: skip if this exact text was already stored
      try {
        const dup = await db.query(
          'MATCH (b:Belief {content_hash: $hash}) RETURN b.id LIMIT 1',
          { hash: chunkHash }
        );
        if (dup.length > 0) {
          // Link existing belief to new source entity
          try {
            await db.addEdge('Entity', 'id', resourceId, 'Belief', 'id', dup[0].id, 'HAS_BELIEF');
          } catch {}
          continue;
        }
      } catch { /* content_hash column may not exist for old data */ }

      const beliefId = crypto.randomUUID();
      await db.addNode('Belief', {
        id: beliefId,
        content: sec.content,
        content_hash: chunkHash,
        confidence: config.confidence,
        entity: resourceName,
        provenance: config.provenance,
        embedding: vectors?.[j] || null,
        source_section: sec.label || undefined,
        last_referenced: now,
        created_at: now,
      });
      await db.addEdge('Entity', 'id', resourceId, 'Belief', 'id', beliefId, 'HAS_BELIEF');
      chunkCount++;
    }
  }

  return chunkCount;
}

// ═══════════════════════════════════════════════════════════
// Batch course mode (Step 7)
// ═══════════════════════════════════════════════════════════

async function ingestCourseDirectory(
  db: any,
  dirPath: string,
  courseId: string,
  moduleCount: number,
  kindOverride?: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: {} }> {
  const validated = validateIngestPath(dirPath);
  if (!validated.ok) return { content: [{ type: 'text', text: validated.error }], details: {} };

  // Scan for course files matching {N}.{N}.{N} Topic.md
  const allFiles = fs.readdirSync(validated.resolved);
  const courseFiles = allFiles
    .filter(f => f.match(/^\d+\.\d+(\.\d+)?\s+.+\.md$/i))
    .sort();

  if (courseFiles.length === 0) {
    return { content: [{ type: 'text', text: `No course files found matching the pattern {N}.{N}.{N} Topic.md in ${dirPath}` }], details: {} };
  }

  // Ensure course entity
  const courseEntityId = await ensureCourseEntity(db, courseId);

  // Track entities per module for prerequisite linking
  const moduleEntities = new Map<number, string>();
  const sectionEntities: Array<{ module: number; order: number; entityId: string }> = [];

  let totalChunks = 0;
  let fileCount = 0;

  for (const file of courseFiles) {
    const filePath = path.join(validated.resolved, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) continue;

    const ext = path.extname(file).toLowerCase();
    const frontmatter = extractFrontmatter(content);
    const cleaned = stripInjectionAttempts(content);
    const fileHash = contentHash(cleaned);

    // File-level dedup
    try {
      const existing = await db.query(
        'MATCH (e:Entity {content_hash: $hash, path: $path}) RETURN e.id LIMIT 1',
        { hash: fileHash, path: filePath }
      );
      if (existing.length > 0) continue;
    } catch {}

    // Chunk
    const sections = chunkContent(cleaned, ext, { docTitle: frontmatter.title });

    // Extract module/section from filename
    const match = file.match(/^(\d+)\.(\d+)(?:\.(\d+))?\s+(.+)\.md$/i);
    const moduleNum = match ? parseInt(match[1], 10) : 1;
    const sectionStr = match ? match[2] : '0';
    const subsection = match?.[3] || '';
    const section = subsection ? `${sectionStr}.${subsection}` : sectionStr;

    const kind = kindOverride || 'raw_course';
    const config = getSourceConfig(kind);
    const resourceName = file;
    const resourceId = crypto.randomUUID();

    // Create resource entity
    await db.addNode('Entity', {
      id: resourceId,
      name: resourceName,
      type: 'resource',
      confidence: frontmatter.confidence ?? config.confidence,
      mention_count: 0, momentum: 0,
      content_hash: fileHash,
      path: filePath,
      kind,
      course_id: courseId,
      module: moduleNum,
      section,
      tags: [frontmatter.tags || [], `course_${courseId}`, `module-${moduleNum}`].flat().filter(Boolean).join(','),
      created_at: frontmatter.created || new Date().toISOString(),
    });

    // Link to course
    await db.addEdge('Entity', 'id', courseEntityId, 'Entity', 'id', resourceId, 'BELONGS_TO_COURSE');

    // Ensure module entity and link
    if (!moduleEntities.has(moduleNum)) {
      const modId = await ensureModuleEntity(db, courseId, moduleNum);
      moduleEntities.set(moduleNum, modId);
    }
    const modId = moduleEntities.get(moduleNum)!;
    await db.addEdge('Entity', 'id', modId, 'Entity', 'id', resourceId, 'BELONGS_TO_MODULE');

    // Store chunks
    const chunks = await storeChunks(db, resourceId, resourceName, sections, config, new Date().toISOString());
    totalChunks += chunks;
    sectionEntities.push({ module: moduleNum, order: parseInt(section, 10), entityId: resourceId });
    fileCount++;
  }

  // Create NEXT_IN_SEQUENCE edges between sections within each module
  const sectionsByModule = new Map<number, Array<{ order: number; entityId: string }>>();
  for (const se of sectionEntities) {
    if (!sectionsByModule.has(se.module)) sectionsByModule.set(se.module, []);
    sectionsByModule.get(se.module)!.push(se);
  }

  for (const [, sections] of sectionsByModule) {
    sections.sort((a, b) => a.order - b.order);
    for (let i = 0; i < sections.length - 1; i++) {
      try {
        await db.addEdge('Entity', 'id', sections[i].entityId, 'Entity', 'id', sections[i + 1].entityId, 'NEXT_IN_SEQUENCE', { order: i });
      } catch {}
    }
  }

  // Create PREREQUISITE edges between sequential modules
  const sortedModules = [...moduleEntities.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < sortedModules.length - 1; i++) {
    try {
      await db.addEdge('Entity', 'id', sortedModules[i][1], 'Entity', 'id', sortedModules[i + 1][1], 'NEXT_IN_SEQUENCE', { order: i });
    } catch {}
  }

  return {
    content: [{ type: 'text', text: `Ingested course ${courseId}: ${fileCount} files, ${totalChunks} chunks, ${moduleEntities.size} modules.` }],
    details: {},
  };
}

// ═══════════════════════════════════════════════════════════
// Programmatic ingest (for learn command)
// ═══════════════════════════════════════════════════════════

export interface IngestFileResult {
  ingested: boolean;
  name: string;
  chunks: number;
  message: string;
}

/**
 * Ingest a single file by path, auto-detecting kind.
 * Used by the learn command. Returns whether it was ingested or skipped.
 */
export async function ingestFile(filePath: string, kindOverride?: string, replace?: boolean): Promise<IngestFileResult> {
  const db = getDb();
  const now = new Date().toISOString();

  // Validate path
  const validated = validateIngestPath(filePath);
  if (!validated.ok) return { ingested: false, name: filePath, chunks: 0, message: validated.error };

  const sourceContent = fs.readFileSync(validated.resolved, 'utf-8');
  if (!sourceContent.trim()) return { ingested: false, name: filePath, chunks: 0, message: 'Empty file' };

  const cleaned = stripInjectionAttempts(sourceContent);
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);
  const frontmatter = extractFrontmatter(cleaned);
  const fileHash = contentHash(cleaned);

  // File-level dedup
  if (replace) {
    // Replace mode: delete existing resource + beliefs for this content
    try {
      const existing = await db.query(
        "MATCH (e:Entity {content_hash: $hash}) RETURN e.id AS id, e.name AS name LIMIT 1",
        { hash: fileHash }
      );
      if (existing.length > 0) {
        const oldId = existing[0].id;
        await db.exec("MATCH (e:Entity {id: $id})-[r:HAS_BELIEF]->(b:Belief) DELETE r, b", { id: oldId });
        await db.exec("MATCH (e:Entity {id: $id}) DETACH DELETE e", { id: oldId });
        console.log("[ingest] Replaced existing file: " + existing[0].name);
      }
    } catch {}
  } else {
    // Normal dedup: skip if content unchanged
    try {
      const existing = await db.query(
        "MATCH (e:Entity {content_hash: $hash, path: $path}) RETURN e.name AS name LIMIT 1",
        { hash: fileHash, path: filePath }
      );
      if (existing.length > 0) {
        return { ingested: false, name: existing[0].name, chunks: 0, message: "Already ingested" };
      }
    } catch {}
  }

  // Detect kind
  let detection: SourceDetection;
  if (kindOverride) {
    const autoDetect = detectSourceKind(filePath, basename, frontmatter);
    detection = {
      kind: kindOverride, isCourse: kindOverride === 'raw_course',
      courseId: frontmatter.course_id || autoDetect.courseId || '',
      module: autoDetect.module,
      section: autoDetect.section,
    };
  } else {
    detection = detectSourceKind(filePath, basename, frontmatter);
  }

  const kind = detection.kind;
  const sourceConfig = getSourceConfig(kind);
  const sections = chunkContent(cleaned, ext, { docTitle: frontmatter.title });

  // Create source entity
  const resourceName = basename || `ingested-${Date.now()}`;
  const resourceId = crypto.randomUUID();

  await db.addNode('Entity', {
    id: resourceId,
    name: resourceName,
    type: 'resource',
    confidence: frontmatter.confidence ?? sourceConfig.confidence,
    mention_count: 0, momentum: 0,
    content_hash: fileHash,
    path: filePath,
    kind,
    course_id: detection.courseId || undefined,
    module: detection.module > 0 ? detection.module : undefined,
    section: detection.section || undefined,
    tags: (frontmatter.tags || []).join(','),
    created_at: frontmatter.created || now,
  });

  // Course/module links
  if (detection.isCourse && detection.courseId) {
    const courseId = await ensureCourseEntity(db, detection.courseId);
    await db.addEdge('Entity', 'id', courseId, 'Entity', 'id', resourceId, 'BELONGS_TO_COURSE');
    if (detection.module > 0) {
      const modId = await ensureModuleEntity(db, detection.courseId, detection.module);
      await db.addEdge('Entity', 'id', modId, 'Entity', 'id', resourceId, 'BELONGS_TO_MODULE');
    }
  }

  // Store chunks
  const chunkCount = await storeChunks(db, resourceId, resourceName, sections, sourceConfig, now);

  // Tags
  const tagSet = inferTags(filePath, detection.isCourse, detection.courseId, detection.module, frontmatter.tags || [], frontmatter.title);
  for (const tag of tagSet) {
    try {
      const existing = await db.query('MATCH (e:Entity {name: $name}) RETURN e.id', { name: tag });
      const tagId = existing.length > 0 ? existing[0].id : await (async () => {
        const id = crypto.randomUUID();
        await db.addNode('Entity', { id, name: tag, type: 'concept', confidence: 0.5, mention_count: 0, momentum: 0, created_at: now });
        return id;
      })();
      await db.addEdge('Entity', 'id', tagId, 'Entity', 'id', resourceId, 'HAS_RESOURCE');
    } catch {}
  }

  return { ingested: true, name: resourceName, chunks: chunkCount, message: '' };
}

/**
 * Ingest content from a string (not a file). Writes to a temp file
 * then calls ingestFile internally.
 */
export async function ingestContent(
  content: string,
  name: string,
  kindOverride?: string
): Promise<IngestFileResult> {
  const tmpPath = path.join(EXT_VAR_DIR, `.ingest-${crypto.randomUUID().split('-')[0]}.html`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    return await ingestFile(tmpPath, kindOverride);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}
