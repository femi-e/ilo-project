// ============================================================================
// tools/web-crawl.ts — Web crawl tool
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { crawlSite } from '../lib/web-lib';

export function registerWebCrawlTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'web_crawl',
    label: 'Web Crawl',
    description: 'Follow links from a URL to build a complete picture of a site. Crawls same-domain pages BFS-style. Returns all discovered pages with their titles.',
    parameters: Type.Object({
      url: Type.String({ description: 'Seed URL to start crawling from' }),
      depth: Type.Optional(Type.Number({ description: 'Max link depth (default 1, max 3)' })),
      limit: Type.Optional(Type.Number({ description: 'Max pages to crawl (default 10, max 50)' })),
    }),
    execute: async (_id, params) => {
      const depth = Math.min(params.depth || 1, 3);
      const limit = Math.min(params.limit || 10, 50);
      try {
        const pages = await crawlSite(params.url, depth, limit);
        if (pages.length === 0) return { content: [{ type: 'text', text: 'No pages found.' }], details: {} };

        const summary = [`Crawled ${pages.length} pages from ${params.url}:\n`];
        for (const p of pages) {
          summary.push(`  - ${p.title || '(no title)'}`);
          summary.push(`    ${p.url}`);
          summary.push(`    ${p.chars} chars`);
        }
        return { content: [{ type: 'text', text: summary.join('\n') }], details: { total: pages.length } };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Crawl failed: ${err.message}` }], details: {} };
      }
    },
  });
}
