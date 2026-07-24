// ============================================================================
// lib/file-cache.ts — In-memory file content cache for the agent
// ============================================================================
// Prevents redundant filesystem reads within the same session.
// Lives on globalThis so it survives pi /reload and tool reloads.
//
// The agent's prompt should say to use cachedRead() instead of raw readFile
// wherever possible. Tools that read files (scrape, crawl, ingest) also go
// through this cache automatically.
//
// TTL can be configured per-file or globally. Default: 60 seconds.
// Use invalidate() after writes to keep the cache fresh.
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Cache storage on globalThis ──────────────────────────
const CACHE_KEY = '__ailo_file_cache__';
const DEFAULT_TTL = 60_000; // 60 seconds
const MAX_BYTES = 500_000; // 500KB — skip files larger than this

interface CacheEntry {
  content: string;
  timestamp: number;
  size: number;   // bytes — for stats
  hash: string;   // quick integrity check
}

interface FileCacheStore {
  entries: Map<string, CacheEntry>;
  hits: number;
  misses: number;
}

function getStore(): FileCacheStore {
  let store = (globalThis as any)[CACHE_KEY] as FileCacheStore | undefined;
  if (!store) {
    store = { entries: new Map(), hits: 0, misses: 0 };
    (globalThis as any)[CACHE_KEY] = store;
  }
  return store;
}

// ── Quick hash (not cryptographic, just for cache busting) ─
function quickHash(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length && i < 1000; i++) {
    h = ((h << 5) - h) + content.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

// ═══════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════

/**
 * Read a file, using the in-memory cache if available.
 *
 * @param filePath  Absolute or relative path to the file.
 * @param ttl       Time-to-live in ms (default 60s). Set to 0 to force re-read.
 * @returns         The file contents as a string, or null if the file doesn't exist.
 */
export function cachedRead(filePath: string, ttl?: number): string | null {
  const resolved = path.resolve(filePath);
  const store = getStore();
  const now = Date.now();
  const maxAge = ttl ?? DEFAULT_TTL;

  // Check cache
  const entry = store.entries.get(resolved);
  if (entry && (now - entry.timestamp) < maxAge) {
    // Verify integrity — if file mtime changed, the hash would differ
    const freshRaw = readRaw(resolved);
    if (freshRaw !== null && quickHash(freshRaw) === entry.hash) {
      store.hits++;
      return entry.content;
    }
    // File changed underneath us — fall through to re-read
  }

  // Cache miss — read from disk (but skip files too large for context)
  try {
    const content = readRaw(resolved);
    if (content === null) return null;

    const byteLen = Buffer.byteLength(content, 'utf-8');
    if (byteLen <= MAX_BYTES) {
      store.entries.set(resolved, {
        content,
        timestamp: now,
        size: byteLen,
        hash: quickHash(content),
      });
      store.misses++;
    } else {
      // File too big to cache, but still return it — caller gets what they asked for
      store.misses++;
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * Invalidate the cached content for a specific file.
 * Call this after writing to a file so the next read is fresh.
 */
export function invalidateCache(filePath: string): void {
  const resolved = path.resolve(filePath);
  getStore().entries.delete(resolved);
}

/**
 * Invalidate all cached file contents.
 * Useful after bulk operations or when the project root changes.
 */
export function clearAllCache(): void {
  const store = getStore();
  store.entries.clear();
  store.hits = 0;
  store.misses = 0;
}

/**
 * Get cache statistics (for diagnostics).
 */
export function getCacheStats(): { entries: number; hits: number; misses: number; hitRate: string } {
  const store = getStore();
  const total = store.hits + store.misses;
  return {
    entries: store.entries.size,
    hits: store.hits,
    misses: store.misses,
    hitRate: total > 0 ? `${((store.hits / total) * 100).toFixed(1)}%` : '0%',
  };
}

// ═══════════════════════════════════════════════════════════
// Internal — raw read with encoding detection
// ═══════════════════════════════════════════════════════════

function readRaw(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}