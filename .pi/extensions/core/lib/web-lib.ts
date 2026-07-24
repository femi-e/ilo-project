// ============================================================================
// lib/web-lib.ts — Web backend: search, scrape, crawl
// ============================================================================

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { SEARXNG_PORT } from './constants';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedPage {
  title: string;
  content: string;
  url: string;
  chars: number;
}

export interface CrawledPage {
  url: string;
  title: string;
  content: string;
  chars: number;
  links: string[];
}

// ── 1. Web search (SearXNG) ─────────────────────────────

export async function searchWeb(query: string, limit: number = 5): Promise<SearchResult[]> {
  let results = await trySearch(query, limit);
  if (results) return results;
  await ensureSearXng();
  results = await trySearch(query, limit);
  if (results) return results;
  throw new Error('SearXNG is not responding. Run: podman start searxng');
}

async function trySearch(query: string, limit: number): Promise<SearchResult[] | null> {
  try {
    const url = 'http://localhost:' + SEARXNG_PORT + '/search?q=' + encodeURIComponent(query) + '&format=json';
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.results || []).slice(0, limit).map((r: any) => ({
      title: r.title || '', url: r.url || '', snippet: r.content || r.snippet || '',
    }));
  } catch { return null; }
}

async function ensureSearXng(): Promise<void> {
  const { execSync } = await import('node:child_process');
  try {
    execSync('podman start searxng 2>/dev/null || podman run -d --name searxng -p 18089:8080 searxng/searxng', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
  } catch { /* podman not installed */ }
}

// ── 2. Page fetch (HTTP + Readability) ──────────────────

export async function fetchPage(url: string): Promise<FetchedPage> {
  let validatedUrl = url.trim();
  if (!validatedUrl.startsWith('http://') && !validatedUrl.startsWith('https://')) {
    validatedUrl = 'https://' + validatedUrl;
  }

  const res = await fetch(validatedUrl, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ILO/1.0)' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + res.statusText);

  const html = await res.text();
  const doc = new JSDOM(html, { url: validatedUrl });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    const text = doc.window.document.body?.textContent || '';
    return { title: '', content: text.substring(0, 15000), url: validatedUrl, chars: Math.min(text.length, 15000) };
  }

  const text = article.content.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
  const truncated = text.substring(0, 15000);
  return { title: article.title || '', content: truncated, url: validatedUrl, chars: truncated.length };
}

// ── 3. Crawl (BFS) ──────────────────────────────────────

export async function crawlSite(seedUrl: string, depth: number = 1, limit: number = 10): Promise<CrawledPage[]> {
  let validatedUrl = seedUrl.trim();
  if (!validatedUrl.startsWith('http://') && !validatedUrl.startsWith('https://')) {
    validatedUrl = 'https://' + validatedUrl;
  }

  const baseDomain = new URL(validatedUrl).hostname;
  const visited = new Set<string>();
  const queue: { url: string; d: number }[] = [{ url: validatedUrl, d: 0 }];
  const results: CrawledPage[] = [];

  while (queue.length > 0 && results.length < limit) {
    const { url: current, d } = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    try {
      const rawHtml = await fetchRaw(current);
      const page = await fetchPage(current);
      const links = extractLinks(rawHtml, current, baseDomain);
      results.push({ url: current, title: page.title, content: page.content, chars: page.chars, links });

      if (d < depth) {
        for (const link of links) {
          if (!visited.has(link)) queue.push({ url: link, d: d + 1 });
        }
      }
    } catch { /* skip failed pages */ }
  }
  return results;
}

async function fetchRaw(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    return res.ok ? res.text() : '';
  } catch { return ''; }
}

function extractLinks(html: string, baseUrl: string, domain: string): string[] {
  const links: string[] = [];
  const regex = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      let url = match[1];
      if (url.startsWith('/')) { url = new URL(url, baseUrl).href; }
      else if (url.startsWith('http://') || url.startsWith('https://')) { /* absolute */ }
      else if (url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('javascript:')) { continue; }
      else { url = new URL(url, baseUrl).href; }
      const u = new URL(url);
      if (u.hostname === domain && !links.includes(url) && !url.includes('#')) { links.push(url); }
    } catch { /* skip */ }
  }
  return links.slice(0, 50);
}
