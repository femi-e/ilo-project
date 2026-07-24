// ============================================================================
// lib/ilo-tools.ts — LLM-invokable tools for ILO
// ============================================================================
// These tools let the LLM interact with the ILO knowledge graph during
// generation: search memory, store facts, link entities, manage tasks, etc.
// ============================================================================
// Naming convention: {domain}_{action}
//   memory_*  — semantic memory operations (search, store, ingest)
//   entity_*  — direct graph entity operations (lookup, connect, update, forget)
//   web_*     — internet access (search, scrape, crawl)
//   project_* — project-level operations (tree)
//   git_*     — git operations (snapshot, commit)
//   system_*  — system operations (diagnostics)
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ilo } from './ilo-client';

const asyncExec = promisify(exec);
const GIT_TIMEOUT = 10000;

export function registerIloTools(api: ExtensionAPI): void {
  // ═══════════════════════════════════════════════════════════════
  // MEMORY TOOLS — semantic memory (past conversations, facts)
  // ═══════════════════════════════════════════════════════════════

  // ── memory_search: Full recall (FTS + vector + PPR) ──────
  api.registerTool({
    name: 'memory_search',
    label: 'Memory Search',
    description: 'Search persistent memory for entities, facts, and past conversations matching your query. Uses full-text search and graph traversal to find connected information. Returns structured context with relevance scores and relationship paths.',
    promptSnippet: 'Search persistent memory for past conversations, entities, and stored facts',
    promptGuidelines: [
      'Use memory_search to recall information from past conversations, stored entities, and knowledge graph connections.',
      'For finding current live information from the internet, use web_search instead of memory_search.',
      'For full details on a single specific entity (tags, properties), use entity_lookup instead of memory_search.',
      'Be specific in your query — include entity names and key terms for best results.',
      'If memory_search returns relevant results, you can follow up with entity_lookup to get full details on any entity.',
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'What to search for — describe the entity, fact, or conversation in natural language' }),
      list: Type.Optional(Type.Boolean({ description: 'Set to true for a flat list of matches without graph relationship exploration. Use when you want a catalogue of results (e.g., "list all tasks"). Default: false (shows connections between entities).' })),
      tag: Type.Optional(Type.String({ description: 'Filter by tag — narrow results to a specific category like "project", "task", or "person"' })),
    }),
    execute: async (_id, params) => {
      // Best-effort: embed the query for vector search, fall back to FTS-only
      let queryEmb: number[] | undefined;
      try {
        const emb = await ilo.embed(params.query, true);
        if (emb.ok && emb.data?.embedding?.length) {
          queryEmb = emb.data.embedding;
        }
      } catch {
        // Embedding failure is non-fatal — falls back to FTS + label match
      }

      const res = await ilo.search(params.query, params.list, params.tag, queryEmb);
      if (!res.ok) return { content: [{ type: 'text', text: `Search failed: ${res.error}` }], details: {} as any };
      if (!res.data?.context) return { content: [{ type: 'text', text: 'No results found in memory.' }], details: {} as any };
      return { content: [{ type: 'text', text: res.data.context }], details: { total: res.data.total } };
    },
  });

  // ── memory_store: Store a fact as entity + claim ───────
  api.registerTool({
    name: 'memory_store',
    label: 'Memory Store',
    description: 'Store a fact, entity, or belief in persistent long-term memory (ILO graph). Creates an entity node and a linked claim so future memory_search calls can find it.',
    promptSnippet: 'Store facts and entities into persistent long-term memory',
    promptGuidelines: [
      'Use memory_store when the user explicitly asks you to remember something for later, or when you discover important facts about a project, person, or concept that should persist across sessions.',
      'For ingesting large external content (web articles, files) use memory_ingest instead of memory_store.',
      'The entity parameter is the subject of the fact (e.g., "database schema" or "Alice"). The content is the actual fact text to store.',
    ],
    parameters: Type.Object({
      content: Type.String({ description: 'The fact text to store as a claim' }),
      entity: Type.Optional(Type.String({ description: 'The entity label this claim is about (default: "general")' })),
      confidence: Type.Optional(Type.Number({ description: 'Confidence level 0.0 to 1.0 (default 0.5). Use higher values for confirmed facts, lower for speculation.' })),
    }),
    execute: async (_id, params) => {
      const content = (params.content || '').trim();
      if (!content) return { content: [{ type: 'text', text: 'No content provided.' }], details: {} as any };
      const entity = params.entity || 'general';
      const conf = params.confidence ?? 0.5;

      const res = await ilo.batch({
        entities: [{ label: entity, confidence: conf, tags: [] }],
        claims: [{ content, confidence: conf, provenance: 'user_confirmed', entities: [entity] }],
      });

      if (!res.ok) {
        return { content: [{ type: 'text', text: `Store failed: ${res.error}` }], details: {} as any };
      }

      return { content: [{ type: 'text', text: `Stored entity "${entity}" with claim: ${content}` }], details: { entity, claim: content, confidence: conf } };
    },
  });

  // ── memory_ingest: Ingest external content ─────────────
  api.registerTool({
    name: 'memory_ingest',
    label: 'Memory Ingest',
    description: 'Save external content (web articles, files, notes, documentation) into memory as entities and claims. The content is automatically parsed and linked into the knowledge graph without creating a conversation turn.',
    promptSnippet: 'Ingest external content (articles, docs, notes) into memory',
    promptGuidelines: [
      'Use memory_ingest when you want to save external content (web pages, documentation, notes) into long-term memory so it can be found by future memory_search calls.',
      'Unlike memory_store which stores a single fact, memory_ingest processes full text content and extracts multiple entities and claims from it.',
      'Use web_scrape first to fetch page content, then pass it to memory_ingest.',
    ],
    parameters: Type.Object({
      content: Type.String({ description: 'The full text content to ingest' }),
      source: Type.String({ description: 'A label identifying the source (URL, filename, or short description)' }),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Optional tags for categorization (e.g., ["documentation", "api"])' })),
    }),
    execute: async (_id, params) => {
      // Extract entities and claims from text via /extract
      const extractRes = await ilo.extract(params.content);
      if (!extractRes.ok) return { content: [{ type: 'text', text: `Extraction failed: ${extractRes.error}` }], details: {} as any };

      const extracted = extractRes.data!;
      const entities = extracted.entities.map((e: any) => ({
        label: e.name,
        tags: params.tags || [],
        confidence: e.confidence,
      }));
      const claims = extracted.claims.map((c: any) => ({
        content: `${c.subject} ${c.link_type} ${c.object}`,
        confidence: c.confidence,
        entities: [c.subject, c.object],
      }));

      // Store via /batch
      const batchRes = await ilo.batch({ entities, claims });
      if (!batchRes.ok) return { content: [{ type: 'text', text: `Ingest failed: ${batchRes.error}` }], details: {} as any };

      return {
        content: [{ type: 'text', text: `Ingested ${extracted.n_entities} entities and ${extracted.n_claims} claims from ${params.source}.` }],
        details: { entities_created: extracted.n_entities, claims_created: extracted.n_claims },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // ENTITY TOOLS — direct graph operations on entities
  // ═══════════════════════════════════════════════════════════════

  // ── entity_lookup: Look up a single entity ─────────────
  api.registerTool({
    name: 'entity_lookup',
    label: 'Entity Lookup',
    description: 'Look up a single entity by name and return its full details: ID, confidence, tags, properties, and related links. Use when you need structured data about one specific entity rather than a search across many.',
    promptSnippet: 'Look up full details on a single entity by name',
    promptGuidelines: [
      'Use entity_lookup when you need the full structured details (tags, properties, confidence) of a single specific entity.',
      'Use memory_search instead when you need to find entities by description or explore relationships between entities.',
      'After memory_search returns interesting results, use entity_lookup on promising entity names for their full details.',
    ],
    parameters: Type.Object({
      name: Type.String({ description: 'The exact entity name to look up (case-insensitive)' }),
    }),
    execute: async (_id, params) => {
      const res = await ilo.lookup(params.name);
      if (!res.ok) return { content: [{ type: 'text', text: `Lookup failed: ${res.error}` }], details: {} as any };
      if (res.data?.error) return { content: [{ type: 'text', text: `Entity "${params.name}" not found in memory.` }], details: {} as any };
      const d = res.data;
      const linkSummary = (d.links || []).slice(0, 10).map((l: any) => `${l.type} ${l.from !== d.id ? l.from : l.to}`).join(', ');
      return {
        content: [{ type: 'text', text: `Found: ${d.label}\nID: ${d.id}\nType: ${d.type}\nConfidence: ${d.confidence}\nTags: ${(d.tags || []).join(', ') || '(none)'}\nProperties: ${JSON.stringify(d.properties || {})}\nLinks (${(d.links || []).length}): ${linkSummary || 'none'}` }],
        details: { id: d.id, name: d.label, confidence: d.confidence, tags: d.tags, properties: d.properties, links: d.links },
      };
    },
  });

  // ── entity_connect: Link two entities ─────────────────
  api.registerTool({
    name: 'entity_connect',
    label: 'Entity Connect',
    description: 'Create a directed link between two entities in the knowledge graph. Use this to record relationships you discover between concepts, people, or things.',
    promptSnippet: 'Link two entities with a relationship in the knowledge graph',
    promptGuidelines: [
      'Use entity_connect to create a relationship link between two entities in the knowledge graph.',
      'Choose the link_type that best describes the relationship: relates, depends, contradicts, refutes, contains, supports, mentions, precedes.',
      'Both entities should already exist in memory (created via memory_store or memory_ingest). Create them first if needed.',
    ],
    parameters: Type.Object({
      from: Type.String({ description: 'Source entity label' }),
      to: Type.String({ description: 'Target entity label' }),
      link_type: Type.Optional(Type.String({ description: 'Link type: relates (reference), depends (dependency), contradicts, refutes, contains, supports, mentions, precedes. Default: relates' })),
    }),
    execute: async (_id, params) => {
      const res = await ilo.createLink(params.from, params.to, params.link_type || 'relates', 0.5);
      if (!res.ok) return { content: [{ type: 'text', text: `Connect failed: ${res.error}` }], details: {} as any };
      return { content: [{ type: 'text', text: `Linked ${params.from} → ${params.to} (${params.link_type || 'relates'}).` }], details: res.data || {} };
    },
  });

  // ── entity_update: Update entity properties ───────────
  api.registerTool({
    name: 'entity_update',
    label: 'Entity Update',
    description: 'Update an existing entity\'s properties, tags, or confidence. Use to correct or enrich stored information.',
    promptSnippet: 'Update an entity\'s properties, tags, or confidence',
    promptGuidelines: [
      'Use entity_update to modify an existing entity\'s properties (like status, priority) or add/change tags.',
      'To remove/forget an entity entirely, use entity_forget instead.',
      'Always check if the entity exists first with entity_lookup before updating.',
    ],
    parameters: Type.Object({
      name: Type.String({ description: 'Entity label to update (case-insensitive)' }),
      properties: Type.Record(Type.String(), Type.Any(), { description: 'Key-value properties to set on the entity' }),
      tags: Type.Optional(Type.Array(Type.String(), { description: 'Replace the entity\'s tags with this new list' })),
      confidence: Type.Optional(Type.Number({ description: 'New confidence level 0.0 to 1.0' })),
    }),
    execute: async (_id, params) => {
      // Resolve label to ID via lookup, then PATCH
      const lookup = await ilo.lookup(params.name);
      if (!lookup.ok || lookup.data?.error) {
        return { content: [{ type: 'text', text: `Entity "${params.name}" not found.` }], details: {} as any };
      }
      const id = lookup.data.id;
      const res = await ilo.updateEntity(id, {
        tags: params.tags,
        confidence: params.confidence,
        properties: params.properties,
      });
      if (!res.ok) {
        return { content: [{ type: 'text', text: `Update failed: ${res.error}` }], details: {} as any };
      }
      return { content: [{ type: 'text', text: `Updated entity "${params.name}".` }], details: { id, status: 'ok' } };
    },
  });

  // ── entity_forget: Forget an entity ───────────────────
  api.registerTool({
    name: 'entity_forget',
    label: 'Entity Forget',
    description: 'Mark an entity as forgotten/deprecated in the knowledge graph. The entity and its claims are preserved but flagged so they no longer appear in normal memory_search results.',
    promptSnippet: 'Deprecate or remove a stored entity from active memory',
    promptGuidelines: [
      'Use entity_forget when the user wants to delete, remove, or correct a previously stored fact or entity.',
      'This marks the entity as forgotten rather than deleting it, so the information is preserved but excluded from normal searches.',
      'To just update an entity\'s properties instead, use entity_update.',
    ],
    parameters: Type.Object({
      content: Type.String({ description: 'The fact or claim text to deprecate' }),
      entity: Type.Optional(Type.String({ description: 'Entity label the claim is about (default: "general")' })),
    }),
    execute: async (_id, params) => {
      const entity = params.entity || 'general';
      // Resolve label to ID, then PATCH with forgotten property
      const lookup = await ilo.lookup(entity);
      if (!lookup.ok || lookup.data?.error) {
        return { content: [{ type: 'text', text: `Entity "${entity}" not found.` }], details: {} as any };
      }
      const res = await ilo.updateEntity(lookup.data.id, { properties: { forgotten: true } });
      if (!res.ok) {
        return { content: [{ type: 'text', text: `Forget failed: ${res.error}` }], details: {} as any };
      }
      return { content: [{ type: 'text', text: `Marked entity "${entity}" as forgotten.` }], details: { entity } };
    },
  });

  // ═══════════════════════════════════════════════════════════════
  // WEB TOOLS — internet access
  // ═══════════════════════════════════════════════════════════════
  // (web_search, web_scrape, web_crawl are registered in tools/*.ts)

  // ═══════════════════════════════════════════════════════════════
  // PROJECT TOOLS
  // ═══════════════════════════════════════════════════════════════

  // ── project_tree: Directory structure ─────────────────
  api.registerTool({
    name: 'project_tree',
    label: 'Project Tree',
    description: 'Show the current project directory tree. Filters out build artifacts (target, node_modules, .git) so you can see the project structure clearly.',
    promptSnippet: 'Show the project directory tree (filters build artifacts)',
    promptGuidelines: [
      'Use project_tree when you need to understand the project structure, find file locations, or navigate the codebase.',
      'The output filters out target/, node_modules/, .git/, and rust-projects/ to keep the view focused on source files.',
    ],
    parameters: Type.Object({
      depth: Type.Optional(Type.Number({ description: 'Max directory depth (default 3). Increase for deeper exploration.' })),
    }),
    execute: async (_id, params) => {
      const depth = params.depth ?? 3;
      try {
        const root = process.cwd();
        const { stdout } = await asyncExec(
          'find . -maxdepth ' + depth + " -not -path '*/target/*' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/rust-projects/*' | sort",
          { cwd: root, timeout: 5000 }
        );
        return { content: [{ type: 'text', text: stdout }], details: { depth } };
      } catch (err: any) {
        return { content: [{ type: 'text', text: 'Failed to get tree: ' + err.message }], details: {} as any };
      }
    },
  });

  // ── git_snapshot: Current git state ─────────────────
  api.registerTool({
    name: 'git_snapshot',
    label: 'Git Snapshot',
    description: 'Show current git branch, status, and recent commits. Provides a quick overview of the repository state before making changes.',
    promptSnippet: 'Show current git branch, status, and recent commits',
    promptGuidelines: [
      'Use git_snapshot before making changes to understand the current git state.',
      'Use git_commit after making meaningful progress to save changes.',
    ],
    parameters: Type.Object({}),
    execute: async (_id, _params) => {
      try {
        const root = process.cwd();
        const [branchRes, statusRes, logRes] = await Promise.all([
          asyncExec('git branch --show-current 2>/dev/null || echo "(no branch)"', { cwd: root, timeout: 5000 }),
          asyncExec('git status --short 2>/dev/null || echo "(not a git repo)"', { cwd: root, timeout: 5000 }),
          asyncExec('git log --oneline -5 2>/dev/null || echo "(no commits)"', { cwd: root, timeout: 5000 }),
        ]);
        const branch = branchRes.stdout.trim();
        const status = statusRes.stdout.trim();
        const log = logRes.stdout.trim();

        const lines = [
          'Branch: ' + branch,
          '',
          '-- Status --',
          status || '(clean)',
          '',
          '-- Recent Commits --',
          log,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }], details: { branch } };
      } catch (err: any) {
        return { content: [{ type: 'text', text: 'Git error: ' + err.message }], details: {} as any };
      }
    },
  });

  // ── git_commit: Stage + commit with auto message ────
  api.registerTool({
    name: 'git_commit',
    label: 'Git Commit',
    description: 'Stage all changes and commit with a generated message. If no message is provided, one is generated from the diff.',
    promptSnippet: 'Stage all changes and commit',
    promptGuidelines: [
      'Use git_commit after making meaningful progress to save changes to the repository.',
      'Run git_snapshot first to review what will be committed.',
      'You can provide an optional commit message, or leave it blank to auto-generate one from the diff.',
    ],
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: 'Optional override commit message. If omitted, one is generated from the diff.' })),
    }),
    execute: async (_id, params) => {
      try {
        const root = process.cwd();

        // Stage all
        await asyncExec('git add -A', { cwd: root, timeout: GIT_TIMEOUT });

        // Check if anything to commit
        const { stdout: hasChanges } = await asyncExec('git diff --cached --stat 2>/dev/null', { cwd: root, timeout: 5000 });
        if (!hasChanges.trim()) {
          return { content: [{ type: 'text', text: 'Nothing to commit — working tree clean.' }], details: {} as any };
        }

        // Generate message from diff if not provided
        let message = params.message;
        let fileCount = 0;
        if (!message) {
          const { stdout: diff } = await asyncExec('git diff --cached --no-color | head -100', { cwd: root, timeout: 5000 });
          const files = hasChanges.split('\n').map(l => l.trim()).filter(Boolean);
          const firstFile = files[0]?.split('|')[0]?.trim() || '';
          fileCount = files.length;
          message = 'update: ' + fileCount + ' file' + (fileCount > 1 ? 's' : '') + ' changed (' + firstFile + (fileCount > 1 ? ', ...' : '') + ')';
        }

        // Commit
        await asyncExec('git commit -m "' + message.replace(/"/g, '\\"') + '"', { cwd: root, timeout: GIT_TIMEOUT });
        const { stdout: sha } = await asyncExec('git rev-parse --short HEAD', { cwd: root, timeout: 5000 });

        return {
          content: [{ type: 'text', text: 'Committed ' + sha + ': ' + message }],
          details: { sha, message, files: fileCount } as any,
        };
      } catch (err: any) {
        return { content: [{ type: 'text', text: 'Commit failed: ' + err.message }], details: {} as any };
      }
    },
  });
}
