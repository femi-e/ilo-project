// ============================================================================
// tools/web-scrape.ts — Web scrape tool
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fetchPage } from '../lib/web-lib';

export function registerWebScrapeTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'web_scrape',
    label: 'Web Scrape',
    description: 'Fetch and clean the full text content of a web page. Uses Mozilla Readability to extract article content, stripping navigation, ads, and sidebars.',
    parameters: Type.Object({
      url: Type.String({ description: 'Full URL (HTTPS only) of the page to fetch' }),
    }),
    execute: async (_id, params) => {
      try {
        const page = await fetchPage(params.url);
        const header = `Title: ${page.title || '(no title)'}\nURL: ${page.url}\nChars: ${page.chars}\n\n`;
        return { content: [{ type: 'text', text: header + page.content }], details: { title: page.title, chars: page.chars } };
      } catch (err: any) {
        return { content: [{ type: 'text', text: `Failed to fetch ${params.url}: ${err.message}` }], details: {} };
      }
    },
  });
}
