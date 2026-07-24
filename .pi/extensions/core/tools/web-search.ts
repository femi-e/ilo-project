// ============================================================================
// tools/web-search.ts — Web search tool
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { searchWeb } from '../lib/web-lib';

export function registerWebSearchTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description: 'Search the web for current information using SearXNG metasearch. Results include titles, URLs, and snippets. Does NOT fetch full pages — use web_scrape for that.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query — describe what you need in natural language' }),
      limit: Type.Optional(Type.Number({ description: 'Max results (default 5, max 20)' })),
    }),
    execute: async (_id, params) => {
      const limit = Math.min(params.limit || 5, 20);
      try {
        const results = await searchWeb(params.query, limit);
        if (results.length === 0) return { content: [{ type: 'text', text: 'No web search results found.' }], details: {} as any };

        const lines = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.substring(0, 200)}`
        );
        const output = `Top ${results.length} result(s) for "${params.query}":\n\n${lines.join('\n\n')}`;
        return { content: [{ type: 'text', text: output }], details: { total: results.length } };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Search failed: ${err.message}` }], details: {} as any };
      }
    },
  });
}
