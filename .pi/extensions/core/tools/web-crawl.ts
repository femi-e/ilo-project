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
    description: 'Follow links from a URL to build a complete picture of a site. Crawls same-domain pages BFS-style. Returns all discovered pages with their titles, URLs, and character counts. Use when you need to explore a documentation site or discover all pages in a section.',
    promptSnippet: 'Crawl a website to discover all pages (BFS, same-domain)',
    promptGuidelines: [
      'Use web_crawl when you need to explore an entire documentation site or discover the structure of a website.',
      'For a single page, use web_scrape instead of web_crawl.',
      'The crawl is limited to the same domain as the seed URL and follows links BFS-style up to the specified depth.',
      'After crawling, use web_scrape on specific pages of interest, then memory_ingest to save them.',
    ],
    parameters: Type.Object({
      url: Type.String({ description: 'Seed URL to start crawling from' }),
      depth: Type.Optional(Type.Number({ description: 'Max link depth (default 1, max 3). Depth 1 = seed page only. Depth 2 = seed + linked pages.' })),
      limit: Type.Optional(Type.Number({ description: 'Max pages to crawl (default 10, max 50)' })),
    }),
    execute: async (_id, params) => {
      const depth = Math.min(params.depth || 1, 3);
      const limit = Math.min(params.limit || 10, 50);
      try {
        const pages = await crawlSite(params.url, depth, limit);
        if (pages.length === 0) return { content: [{ type: 'text', text: 'No pages found.' }], details: {} as any };

        const summary = ['Crawled ' + pages.length + ' pages from ' + params.url + ':\n'];
        for (const p of pages) {
          summary.push('  - ' + (p.title || '(no title)'));
          summary.push('    ' + p.url);
          summary.push('    ' + p.chars + ' chars');
        }
        return { content: [{ type: 'text', text: summary.join('\n') }], details: { total: pages.length } };
      } catch (err: any) {
        return { content: [{ type: 'text', text: 'Crawl failed: ' + err.message }], details: {} as any };
      }
    },
  });
}
