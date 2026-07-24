// ============================================================================
// tools/file-cache.ts — Cached file read tool for the agent
// ============================================================================
// The agent should use `read_cached` instead of the built-in `read` for files
// it expects to reference multiple times in a session. The cache lives on
// globalThis and survives pi /reload, so repeated reads within the TTL window
// are instant.
//
// Also provides `cache_invalidate` for clearing stale entries after writes.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { cachedRead, invalidateCache, clearAllCache, getCacheStats } from '../lib/file-cache';
import type { ToolDefinition } from '../lib/tool-registry';

// ── Tool definition ──────────────────────────────────────

export const readCachedToolDef: ToolDefinition = {
  name: 'read_cached',
  label: 'Read Cached',
  description: 'Read a file with in-memory caching. Repeated reads of the same file within the TTL return instantly. Preferred over the built-in read tool for files read multiple times in a session.',
  category: 'retrieval',
  aliases: 'file, read, cached, cache',
  promptSnippet: 'Read a file with caching (avoids redundant disk reads)',
  promptGuidelines: [
    'Use read_cached instead of the built-in read tool when you expect to reference the same file more than once.',
    'The cache lives on globalThis and survives pi /reload.',
    'Default TTL is 60 seconds. Set ttl=0 to force a fresh read.',
    'If you modified a file and need the fresh version, set ttl=0 or use cache_invalidate first.',
  ],
  register: registerReadCachedTool,
};

export const cacheInvalidateToolDef: ToolDefinition = {
  name: 'cache_invalidate',
  label: 'Cache Invalidate',
  description: 'Clear cached file contents. Use after editing a file to ensure the next read_cached gets fresh content.',
  category: 'retrieval',
  aliases: 'clear, invalidate, refresh, cache',
  promptSnippet: 'Clear cached file contents after edits',
  promptGuidelines: [
    'Use cache_invalidate after any edit() or write() call to keep the cache fresh.',
    'Accepts a specific file path or "all" to clear everything.',
  ],
  register: registerCacheInvalidateTool,
};

export const cacheStatsToolDef: ToolDefinition = {
  name: 'cache_stats',
  label: 'Cache Stats',
  description: 'Show file cache hit/miss statistics.',
  category: 'retrieval',
  aliases: 'stats, cache, performance',
  promptSnippet: 'Show file cache performance statistics',
  promptGuidelines: [
    'Use to see how effective the file cache is at avoiding redundant reads.',
    'A high hit rate means fewer filesystem reads overall.',
  ],
  register: registerCacheStatsTool,
};

// ── Registration functions ───────────────────────────────

export function registerReadCachedTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'read_cached',
    label: 'Read Cached',
    description: 'Read a file with in-memory caching. Repeated reads within the TTL are instant.',
    promptSnippet: readCachedToolDef.promptSnippet,
    promptGuidelines: readCachedToolDef.promptGuidelines,
    parameters: Type.Object({
      path: Type.String({ description: 'File path to read' }),
      ttl: Type.Optional(Type.Number({ description: 'Cache TTL in ms (default 60000, 0 = force fresh read)' })),
      offset: Type.Optional(Type.Number({ description: 'Starting line number (1-indexed)' })),
      limit: Type.Optional(Type.Number({ description: 'Number of lines to return' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal): Promise<any> {
      const filePath = (params.path || '').trim();
      if (!filePath) return { content: [{ type: 'text', text: 'path is required' }], details: {}, isError: true };

      const content = cachedRead(filePath, params.ttl);
      if (content === null) return { content: [{ type: 'text', text: `File not found: ${filePath}` }], details: {}, isError: true };

      const lines = content.split('\n');
      const totalLines = lines.length;

      let resultLines = lines;
      if (params.offset) {
        const start = Math.max(0, params.offset - 1);
        const end = params.limit ? start + params.limit : undefined;
        resultLines = lines.slice(start, end);
      }

      const fileContent = resultLines.join('\n');
      const stats = getCacheStats();
      return {
        content: [{ type: 'text', text: fileContent }],
        details: {
          path: filePath,
          totalLines,
          lineCount: resultLines.length,
          _cache: { hitRate: stats.hitRate, cachedEntries: stats.entries },
        },
      };
    },
  });
}

export function registerCacheInvalidateTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'cache_invalidate',
    label: 'Cache Invalidate',
    description: 'Clear cached file contents.',
    promptSnippet: cacheInvalidateToolDef.promptSnippet,
    promptGuidelines: cacheInvalidateToolDef.promptGuidelines,
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Specific file path to invalidate, or "all" to clear everything' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal): Promise<any> {
      const target = (params.path || '').trim().toLowerCase();
      if (target === 'all' || target === '') {
        clearAllCache();
        return { content: [{ type: 'text', text: 'Entire file cache cleared' }], details: { status: 'ok' } };
      }
      invalidateCache(params.path);
      const stats = getCacheStats();
      return {
        content: [{ type: 'text', text: `Invalidated cache for: ${params.path}` }],
        details: { status: 'ok', cacheEntries: stats.entries },
      };
    },
  });
}

export function registerCacheStatsTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'cache_stats',
    label: 'Cache Stats',
    description: 'Show file cache hit/miss statistics.',
    promptSnippet: cacheStatsToolDef.promptSnippet,
    promptGuidelines: cacheStatsToolDef.promptGuidelines,
    parameters: Type.Object({}),
    async execute(): Promise<any> {
      const stats = getCacheStats();
      return {
        content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
        details: stats,
      };
    },
  });
}