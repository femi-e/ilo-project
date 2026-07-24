// ============================================================================
// lib/clean.ts — Content extraction, boilerplate removal, chunking
// ============================================================================
// Extracts clean article content from HTML using Mozilla Readability.
// Removes navigation, ads, cookie banners, boilerplate.
// Chunks content by structural units (headings, functions, paragraphs).
//
// Dependencies: @mozilla/readability, jsdom
// ============================================================================

import * as crypto from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { CHUNK_TARGET_SIZE, CHUNK_OVERLAP, CHUNK_HARD_MAX } from './constants';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface ExtractedContent {
  title: string;
  content: string;        // Full readable content
  excerpt: string;        // Short description
  textContent: string;    // Plain text without formatting
  byline?: string;        // Author if found
  siteName?: string;      // Site name if found
  length: number;         // Content length in chars
}

export interface ChunkResult {
  content: string;
  label: string;
  hash: string;
}

export type ContentKind = 'markdown' | 'code' | 'plain' | 'web';

// ═══════════════════════════════════════════════════════════
// 1. Readability extraction (jsdom + Mozilla Readability)
// ═══════════════════════════════════════════════════════════

/**
 * Extract clean article content from raw HTML using Mozilla Readability.
 * Returns null if extraction fails or content is too short.
 */
export function extractReadability(html: string, url?: string): ExtractedContent | null {
  try {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('error', () => {}); // Suppress jsdom errors

    const dom = new JSDOM(html, {
      url: url || 'https://localhost',
      virtualConsole,
    });

    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) return null;

    // Skip if extracted content is too short (likely a failed extraction)
    if ((article.textContent || '').length < 50) return null;

    const result: ExtractedContent = {
      title: article.title || '',
      content: article.content || '',
      excerpt: article.excerpt || '',
      textContent: article.textContent || '',
      byline: article.byline || undefined,
      siteName: article.siteName || undefined,
      length: (article.textContent || '').length,
    };

    return result;
  } catch (err: any) {
    console.warn('[clean] Readability extraction failed:', err.message?.substring(0, 80));
    return null;
  }
}

/**
 * Extract content from HTML using a CSS selector.
 * Returns the text content of all matching elements.
 */
export function extractCssSelector(html: string, selector: string): string | null {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const elements = doc.querySelectorAll(selector);

    if (elements.length === 0) return null;

    const parts: string[] = [];
    for (const el of elements) {
      const text = el.textContent?.trim();
      if (text) parts.push(text);
    }

    return parts.join('\n\n');
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 2. Boilerplate cleaning
// ═══════════════════════════════════════════════════════════

const BOILERPLATE_PATTERNS = [
  /^skip to content$/im,
  /^cookie( settings| policy| consent)?$/im,
  /^accept( all)?( cookies)?$/im,
  /^reject( all)?( cookies)?$/im,
  /^manage( my)? (cookie|preferences)$/im,
  /^this website uses cookies/i,
  /^we use cookies/i,
  /^by clicking .+ you agree/i,
  /^sign up|^sign in|^log in|^register/i,
  /^(subscribe|follow|share|tweet|like) /i,
  /^advertisement$/im,
  /^sponsored( content| story)?$/im,
  /^(related|recommended|trending) (articles?|posts?|stories)/i,
  /^you might also (like|enjoy|be interested)/i,
  /^(follow|connect with) us on/i,
  /^all rights reserved/i,
  /^privacy policy|^terms of service|^terms and conditions/i,
  /^© \d{4}/,
  /^share this/i,
  /^(back to|return to) (top|navigation)/im,
  /^loading\.\.\.$/im,
  /^menu$/im,
  /^navigation$/im,
  /^search(\.\.\.)?$/im,
  /^email address$/im,
];

/**
 * Clean boilerplate text from extracted content.
 * Removes nav text, ads, cookie banners, duplicate lines.
 */
export function cleanBoilerplate(text: string): string {
  if (!text) return '';

  const lines = text.split('\n');
  const filtered: string[] = [];
  let prevLine = '';
  let blankCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      blankCount++;
      if (blankCount > 2) continue; // Max 2 blank lines in a row
      filtered.push('');
      continue;
    }
    blankCount = 0;

    // Check against boilerplate patterns
    if (BOILERPLATE_PATTERNS.some(p => p.test(line))) continue;

    // Remove consecutive duplicate lines
    if (line === prevLine) continue;
    prevLine = line;

    // Remove very short lines that look like nav items
    // (single words or short phrases, capitalized)
    if (line.length < 4 && /^[A-Z][a-z]+$/.test(line)) continue;

    filtered.push(line);
  }

  return filtered.join('\n');
}

// ═══════════════════════════════════════════════════════════
// 3. Content type detection
// ═══════════════════════════════════════════════════════════

/**
 * Detect the best extraction strategy for HTML content.
 * Returns 'readability' if the page has article-like structure,
 * 'raw' if it's generic, or a CSS selector string if explicit.
 */
export function detectContentType(html: string): 'readability' | 'raw' | string {
  const lowerHtml = html.toLowerCase();

  // Check for article-specific elements
  const hasArticle = lowerHtml.includes('<article');
  const hasMain = lowerHtml.includes('<main');
  const hasEntry = lowerHtml.includes('entry-content') || lowerHtml.includes('post-content');
  const hasStory = lowerHtml.includes('story-body') || lowerHtml.includes('story-content');

  // Score-based detection
  let score = 0;
  if (hasArticle) score += 3;
  if (hasMain) score += 1;
  if (hasEntry || hasStory) score += 2;
  if (lowerHtml.includes('<h1') || lowerHtml.includes('<h2')) score += 1;
  if (lowerHtml.includes('<p')) score += 1;

  // Low score means it might not be an article
  if (score < 3) return 'raw';

  return 'readability';
}

// ═══════════════════════════════════════════════════════════
// 4. Content chunking
// ═══════════════════════════════════════════════════════════

type FileLang = 'markdown' | 'python' | 'ts_js' | 'r' | 'go' | 'sql' | 'plain';

function detectLang(ext: string): FileLang {
  const e = ext.toLowerCase();
  if (['.md', '.qmd', '.rmd', '.markdown'].includes(e)) return 'markdown';
  if (e === '.py') return 'python';
  if (['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs'].includes(e)) return 'ts_js';
  if (['.r', '.R'].includes(e)) return 'r';
  if (e === '.go') return 'go';
  if (e === '.sql') return 'sql';
  return 'plain';
}

/**
 * Chunk content by structural units.
 * markdown → split by headings
 * code → split by function/class boundaries
 * plain → split by paragraphs
 */
export function chunkContent(text: string, ext: string, options?: { maxChars?: number; overlapChars?: number; docTitle?: string }): ChunkResult[] {
  const lang = detectLang(ext);
  const maxChars = options?.maxChars ?? CHUNK_TARGET_SIZE;
  const overlapChars = options?.overlapChars ?? CHUNK_OVERLAP;

  switch (lang) {
    case 'markdown': return chunkMarkdown(text, maxChars, overlapChars, options?.docTitle);
    case 'python':
    case 'ts_js':
    case 'r':
    case 'go':
    case 'sql': return chunkCode(text, maxChars);
    default: return chunkPlain(text, maxChars, overlapChars);
  }
}

// ── Markdown chunking (by headings) ────────────────────

function chunkMarkdown(content: string, maxChars: number, overlapChars: number, docTitle?: string): ChunkResult[] {
  const body = content.replace(/^---[\s\S]*?---\n*/, '').trim();
  const lines = body.split('\n');

  // Parse heading sections, respecting code fences
  const sections: Array<{ label: string; bodyLines: string[] }> = [];
  let current: { label: string; bodyLines: string[] } = { label: '', bodyLines: [] };
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      current.bodyLines.push(line);
      continue;
    }
    if (!inFence) {
      const m = line.match(/^(#{1,6})\s+(.+)/);
      if (m) {
        if (current.label === '' && current.bodyLines.length > 0) {
          sections.push(current);
        } else if (current.label !== '') {
          sections.push(current);
        }
        current = { label: line, bodyLines: [] };
        continue;
      }
    }
    current.bodyLines.push(line);
  }
  if ((current.label === '' && current.bodyLines.some(l => l.trim().length > 0)) || current.label !== '') {
    sections.push(current);
  }

  if (sections.length === 0) return chunkPlain(body, maxChars, overlapChars);

  // Build doc prefix for context
  const docPrefix = docTitle ? `[${docTitle}]\n` : '';

  // Build chunks with label prefix
  const chunks: ChunkResult[] = [];
  for (const sec of sections) {
    const header = sec.label;
    const bodyText = sec.bodyLines.join('\n');
    const available = Math.min(maxChars, CHUNK_HARD_MAX) - header.length - 2;

    if (bodyText.length <= available) {
      chunks.push({
        content: docPrefix + header + '\n\n' + bodyText,
        label: header.replace(/^#+\s*/, ''),
        hash: crypto.createHash('sha256').update(docPrefix + header + '\n' + bodyText).digest('hex'),
      });
    } else {
      const subChunks = splitIntoBuckets(bodyText, available);
      for (const sub of subChunks) {
        chunks.push({
          content: docPrefix + header + '\n\n' + sub,
          label: header.replace(/^#+\s*/, ''),
          hash: crypto.createHash('sha256').update(docPrefix + header + '\n' + sub).digest('hex'),
        });
      }
    }
  }

  // Apply overlap
  for (let i = 1; i < chunks.length; i++) {
    const tail = chunks[i - 1].content.slice(-overlapChars);
    if (tail.trim()) {
      chunks[i] = { ...chunks[i], content: tail + '\n\n' + chunks[i].content };
    }
  }

  return chunks;
}

// ── Code chunking (by function/class boundaries) ────────

const DECL_REGEXES: Record<string, RegExp> = {
  python: /^\s*(?:class\s+\w+|(?:async\s+)?def\s+\w+)/,
  ts_js: /^\s*(?:(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+\w+|(?:export\s+(?:default\s+)?)?class\s+\w+|(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+[\w$]+(?:\s*:\s*[^{=]+)?\s*=\s*(?:\([^)]*\)|\w+)\s*=>\s*[({]|(?:export\s+)?interface\s+\w+|(?:export\s+)?type\s+\w+\s*=)/,
  r: /^(?:\w+\s*<-\s*function\s*\(|setClass\s*\(\s*["']\w+["'])/,
  go: /^\s*(?:func\s+(?:\([^)]*\)\s+)?\w+|type\s+\w+|const\s+|var\s+)/,
  sql: /^\s*(?:CREATE\b|ALTER\b|DROP\b|SELECT\b|INSERT\b|UPDATE\b|DELETE\b|WITH\b)/i,
};

function chunkCode(content: string, maxChars: number): ChunkResult[] {
  const declRegex = DECL_REGEXES.ts_js; // Default
  const lines = content.split('\n');
  const sections: Array<{ label: string; bodyLines: string[] }> = [];
  let current: { label: string; bodyLines: string[] } = { label: '', bodyLines: [] };

  for (const line of lines) {
    if (declRegex.test(line) && current.bodyLines.length > 0) {
      if (current.label || current.bodyLines.length > 0) {
        sections.push(current);
      }
      current = { label: line.trim(), bodyLines: [line] };
    } else {
      current.bodyLines.push(line);
    }
  }
  if (current.bodyLines.length > 0) {
    sections.push(current);
  }

  if (sections.length === 0) return chunkPlain(content, maxChars, 0);

  const chunks: ChunkResult[] = [];
  for (const sec of sections) {
    const bodyText = sec.bodyLines.join('\n');
    const maxAllow = Math.min(maxChars, CHUNK_HARD_MAX);
    if (bodyText.length <= maxAllow) {
      chunks.push({
        content: bodyText,
        label: sec.label,
        hash: crypto.createHash('sha256').update(bodyText).digest('hex'),
      });
    } else {
      const subChunks = splitIntoBuckets(bodyText, maxAllow);
      for (const sub of subChunks) {
        chunks.push({
          content: sub,
          label: sec.label,
          hash: crypto.createHash('sha256').update(sub).digest('hex'),
        });
      }
    }
  }

  return chunks;
}

// ── Plain text chunking (by paragraphs) ────────────────

function chunkPlain(content: string, maxChars: number, overlapChars: number): ChunkResult[] {
  // Split by double newlines (paragraphs)
  const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const chunks: ChunkResult[] = [];
  const actualMax = Math.min(maxChars, CHUNK_HARD_MAX);

  let currentChunk: string[] = [];
  let currentLen = 0;

  for (const para of paragraphs) {
    if (currentLen + para.length > actualMax && currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join('\n\n'),
        label: '',
        hash: crypto.createHash('sha256').update(currentChunk.join('\n\n')).digest('hex'),
      });
      currentChunk = [];
      currentLen = 0;
    }
    currentChunk.push(para);
    currentLen += para.length;
  }

  if (currentChunk.length > 0) {
    chunks.push({
      content: currentChunk.join('\n\n'),
      label: '',
      hash: crypto.createHash('sha256').update(currentChunk.join('\n\n')).digest('hex'),
    });
  }

  // Apply overlap
  for (let i = 1; i < chunks.length; i++) {
    const tail = chunks[i - 1].content.slice(-overlapChars);
    if (tail.trim()) {
      chunks[i] = { ...chunks[i], content: tail + '\n\n' + chunks[i].content };
    }
  }

  return chunks.length > 0 ? chunks : [{ content, label: '', hash: crypto.createHash('sha256').update(content).digest('hex') }];
}

// ── Helpers ────────────────────────────────────────────

function splitIntoBuckets(text: string, bucketSize: number): string[] {
  const buckets: string[] = [];
  const paragraphs = text.split(/\n\s*\n/);

  let current: string[] = [];
  let currentLen = 0;

  for (const para of paragraphs) {
    if (currentLen + para.length > bucketSize && current.length > 0) {
      buckets.push(current.join('\n\n'));
      current = [];
      currentLen = 0;
    }
    current.push(para);
    currentLen += para.length;
  }
  if (current.length > 0) {
    buckets.push(current.join('\n\n'));
  }

  return buckets.length > 0 ? buckets : [text.substring(0, bucketSize)];
}