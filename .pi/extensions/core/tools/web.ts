// ============================================================================
// tools/web.ts — web, scrape, crawl tools
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { searchWeb, scrapePipeline, crawlSite } from '../lib/web-lib';
import { ingestContent } from './ingest';
import type { ToolDefinition } from '../lib/tool-registry';

// ── Tool definitions (for central registry) ──────────────

export const webToolDef: ToolDefinition = {
  name: 'web',
  label: 'Web',
  description: 'Search the web via SearXNG for current information not in stored knowledge',
  category: 'research',
  aliases: 'search web, internet search, browse',
  promptSnippet: 'Search the web for current information',
  promptGuidelines: [
    'Use web for CURRENT or time-sensitive information not found in stored knowledge.',
    'Always try search first — stored lookups are faster and free.',
    'SearXNG auto-starts in background if not running (first search may have a delay).',
    'Set fetch:true to automatically read the full content of each result.',
    'Set store:true to permanently save fetched content.',
  ],
  register: registerWebTool,
};

export const scrapeToolDef: ToolDefinition = {
  name: 'scrape',
  label: 'Scrape',
  description: 'Fetch and clean the full text content of a web page with optional storage',
  category: 'research',
  aliases: 'fetch, extract, read url',
  promptSnippet: 'Fetch and clean a web page, optionally store it',
  promptGuidelines: [
    'Use scrape to fetch the full cleaned text of a web page.',
    'Set store:true to persist the content to the knowledge base.',
    'Extract options: auto (default), readability, raw, or a CSS selector like "article.main".',
  ],
  register: registerScrapeTool,
};

export const crawlToolDef: ToolDefinition = {
  name: 'crawl',
  label: 'Crawl',
  description: 'Follow internal links from a URL to build a complete picture of a site',
  category: 'research',
  aliases: 'spider, site crawl, collect',
  promptSnippet: 'Follow links from a URL to collect content across pages',
  promptGuidelines: [
    'Use crawl to understand entire documentation sites or multi-page resources.',
    'Limited to 100 pages and depth 3 to prevent runaway crawling.',
    'Set store:true to persist all crawled pages as searchable knowledge.',
  ],
  register: registerCrawlTool,
};

// ── Registration functions ───────────────────────────────

export function registerWebTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'web',
    label: 'Web',
    description: 'Search the web using SearXNG metasearch. Auto-starts SearXNG if not running.',
    promptSnippet: webToolDef.promptSnippet,
    promptGuidelines: webToolDef.promptGuidelines,
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
      limit: Type.Optional(Type.Number({ description: 'Max results (default 5)' })),
      fetch: Type.Optional(Type.Boolean({ description: 'Auto-fetch each result URL (default false)' })),
      store: Type.Optional(Type.Boolean({ description: 'Auto-ingest fetched content (default false)' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const results = await searchWeb(params.query, params.limit || 5);
      if (results.length === 0) return { content: [{ type: 'text', text: 'No web search results found.' }], details: {} };

      const lines = results.map((r, i) =>
        `  ${i + 1}. ${r.title || 'untitled'}\n     ${r.url}\n     ${(r.snippet || '').substring(0, 150)}`
      );
      let output = `Top ${results.length} result(s):\n${lines.join('\n')}`;

      // Auto-fetch each result
      if (params.fetch && results.length > 0) {
        onUpdate?.({ content: [{ type: 'text', text: `Fetching ${Math.min(results.length, 3)} result(s)...` }] });
        const fetched: string[] = [];
        for (const r of results.slice(0, 3)) {
          try {
            const page = await scrapePipeline(r.url, { limit: 5000 });
            const ingest = await registerIngestInline(page.content, page.url, page.title);
            fetched.push(`  ${page.title}: ${page.chars} chars${ingest ? ' (stored)' : ''}`);
          } catch (e: any) {
            fetched.push(`  ${r.url}: ${e.message?.substring(0, 60)}`);
          }
        }
        if (fetched.length > 0) {
          output += '\n\nFetched:\n' + fetched.join('\n');
        }
      }

      return { content: [{ type: 'text', text: output }], details: {} };
    },
  });
}

export function registerScrapeTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'scrape',
    label: 'Scrape',
    description: 'Fetch the full content of a web page. Supports Readability and CSS selectors.',
    promptSnippet: scrapeToolDef.promptSnippet,
    promptGuidelines: scrapeToolDef.promptGuidelines,
    parameters: Type.Object({
      url: Type.String({ description: 'Full URL (HTTPS only)' }),
      extract: Type.Optional(Type.String({ description: 'Extraction method: auto, readability, raw, or CSS selector' })),
      store: Type.Optional(Type.Boolean({ description: 'Store to knowledge base (default false)' })),
      limit: Type.Optional(Type.Number({ description: 'Max characters (default 15000)' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const page = await scrapePipeline(params.url, {
        extract: params.extract || 'auto',
        limit: params.limit || 15000,
      });
      let output = `Fetched "${page.title}" (${page.chars} chars, ${page.source}):\n\n${page.content}`;

      if (params.store) {
        await registerIngestInline(page.content, page.url, page.title);
        output += '\n\n(Stored to knowledge base)';
      }

      return { content: [{ type: 'text', text: output }], details: {} };
    },
  });
}

export function registerCrawlTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'crawl',
    label: 'Crawl',
    description: 'Follow internal links from a URL to build a complete picture. Optionally ingest all pages.',
    promptSnippet: crawlToolDef.promptSnippet,
    promptGuidelines: crawlToolDef.promptGuidelines,
    parameters: Type.Object({
      url: Type.String({ description: 'Seed URL to start crawling from' }),
      depth: Type.Optional(Type.Number({ description: 'Max link depth (default 1, max 3)' })),
      limit: Type.Optional(Type.Number({ description: 'Max pages (default 10, max 100)' })),
      store: Type.Optional(Type.Boolean({ description: 'Ingest all pages to knowledge base (default false)' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const pages = await crawlSite(params.url, params.depth || 1, params.limit || 10);

      let stored = 0;
      if (params.store) {
        for (const page of pages) {
          try {
            await registerIngestInline(page.content, page.url, page.title);
            stored++;
          } catch {}
        }
      }

      const summary = `Crawled ${pages.length} pages from ${new URL(params.url).hostname}` +
        ` (depth: ${params.depth || 1})` +
        (stored > 0 ? `, ${stored} stored` : '');

      const pageList = pages.map((p, i) =>
        `  ${i + 1}. ${p.title || p.url} (${p.chars} chars)`
      );

      return { content: [{ type: 'text', text: `${summary}\n\nPages:\n${pageList.join('\n')}` }], details: {} };
    },
  });
}

// ── Inline ingest for web tool auto-store ─────────────

async function registerIngestInline(content: string, _url: string, _title: string): Promise<boolean> {
  try {
    const result = await ingestContent(content, 'web-research', 'web_research');
    return result.ingested;
  } catch (err: any) {
    console.warn('[web] Ingest failed:', err.message?.substring(0, 60));
    return false;
  }
}
