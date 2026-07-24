// ============================================================================
// lib/web-lib.ts — Web backend: search, fetch, render, crawl
// ============================================================================
// Provides the backend implementations for web, scrape, and crawl tools.
// - searchWeb: SearXNG metasearch via Docker in WSL (auto-manages WSL lifecycle)
// - fetchPage: safeFetch + Readability extraction
// - tryPlaywright: lazy-start headless Chromium for JS rendering
// - scrapePipeline: Layer 1 (direct) → Layer 2 (Playwright) fallback
// - crawlSite: BFS link-following with limits
//
// Lifecycle: SearXNG runs in a Docker container with --restart=unless-stopped
// inside WSL. When WSL is up, SearXNG is available. After 10 min of no
// searches, WSL is terminated (wsl --terminate Ubuntu) to free all memory.
// Next search auto-wakes WSL, Docker, and SearXNG (~3s cold start).
//
// Dependencies: lib/security.ts, lib/clean.ts
// Optional: playwright (for JS rendering, lazy-loaded)
// ============================================================================

import { validateUrl, safeFetch } from './security';
import { extractReadability, extractCssSelector, cleanBoilerplate, detectContentType } from './clean';
import { SEARXNG_PORT, CRAWL_MAX_PAGES, CRAWL_MAX_DEPTH } from './constants';

// ═══════════════════════════════════════════════════════════
// WSL idle timer — terminates WSL after 10 min of no searches
// Docker + SearXNG auto-start with --restart=unless-stopped
// ═══════════════════════════════════════════════════════════

let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _wslProcess: import('child_process').ChildProcess | null = null;
const WSL_IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Spawn a persistent WSL background process to prevent systemd from
 * shutting down Docker when no terminals are connected.
 * See: https://github.com/microsoft/WSL/issues/9667
 */
/** Guard: WSL functionality is Windows-only */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/** Prefix docker commands with WSL on Windows, run natively on other platforms */
function dockerCmd(cmd: string): string {
  return isWindows() ? `wsl -d Ubuntu -- ${cmd}` : cmd;
}

export function keepWslAlive(): void {
  if (!isWindows()) return; // WSL only on Windows
  if (_wslProcess) return; // Already alive
  import('node:child_process').then(({ spawn }) => {
    _wslProcess = spawn('wsl', ['-d', 'Ubuntu', '--', 'sleep', 'infinity'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    _wslProcess.on('exit', () => { _wslProcess = null; });
  });
}

function stopWslProcess(): void {
  if (_wslProcess) {
    _wslProcess.kill();
    _wslProcess = null;
  }
}

function resetIdleTimer(): void {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(() => {
    stopWslProcess();
    if (isWindows()) {
      import('node:child_process').then(({ execSync }) => {
        try {
          execSync('wsl --terminate Ubuntu', { timeout: 5000, windowsHide: true, stdio: 'ignore' });
          console.log('[web-lib] WSL terminated after idle');
        } catch { /* WSL may already be off */ }
      });
    }
  }, WSL_IDLE_TIMEOUT);
}

/**
 * Quick check if SearXNG is responding on localhost.
 * Short timeout (2s) so it's not a bottleneck.
 */
export async function checkSearXngHealth(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${SEARXNG_PORT}/search?q=ping&format=json`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

export interface FetchedPage {
  title: string;
  content: string;
  url: string;
  chars: number;
  source: 'readability' | 'playwright' | 'raw' | 'selector';
  contentType?: string;
}

export interface CrawlResult {
  url: string;
  title: string;
  content: string;
  chars: number;
  links: string[];
}

// ═══════════════════════════════════════════════════════════
// 1. SearXNG search — optimistic (no setup on happy path)
// ═══════════════════════════════════════════════════════════

/**
 * Try a search immediately. If SearXNG responds, great. If not,
 * run the full WSL/Docker/SearXNG setup and retry once.
 */
export async function searchWeb(query: string, limit: number = 5): Promise<SearchResult[]> {
  // Optimistic: try searching immediately without any setup overhead
  let results = await trySearch(query, limit);
  
  // If that failed (SearXNG not running), do full setup and retry
  if (!results) {
    await ensureSearXngAvailable();
    results = await trySearch(query, limit);
  }
  
  if (!results) {
    throw new Error(
      `SearXNG is not responding. The system tried to auto-recover.\n` +
      `If this persists, try: podman restart searxng`
    );
  }
  
  resetIdleTimer();
  return results;
}

/**
 * Pure search — returns null if SearXNG is unavailable, no side effects.
 */
async function trySearch(query: string, limit: number): Promise<SearchResult[] | null> {
  try {
    const encoded = encodeURIComponent(query);
    const url = `http://localhost:${SEARXNG_PORT}/search?q=${encoded}&format=json&language=en-US`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) return null;
    const data = await response.json() as any;
    return (data.results || []).slice(0, limit).map((r: any) => ({
      title: r.title || '', url: r.url || '',
      snippet: r.content || r.snippet || '', engine: r.engine || '',
    }));
  } catch {
    return null;
  }
}

/**
 * Full recovery: ensure WSL, Docker, and SearXNG are all running.
 * Only called when the optimistic search fails.
 */
async function ensureSearXngAvailable(): Promise<void> {
  keepWslAlive();

  // Step 1: Try starting existing container (fast path)
  const { execSync } = await import('node:child_process');
  // Step 1a: Try docker start first
  try {
    execSync(dockerCmd(`docker start searxng 2>/dev/null`),
      { timeout: 5000, windowsHide: true, stdio: 'ignore' }
    );
  } catch {}

  // Step 1b: Check if it came up
  for (let i = 0; i < 4; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://localhost:${SEARXNG_PORT}/search?q=ping&format=json`, {
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) return;
    } catch {}
  }

  // Step 2: Container didn't come up — force recreate

  try {
    execSync(dockerCmd(`sh -c "docker rm -f searxng 2>/dev/null; ` +
      `docker run -d --restart=no --memory=256m --cpus=0.5 ` +
      `--name searxng -p ${SEARXNG_PORT}:8080 ` +
      `-v ~/searxng-config/settings.yml:/etc/searxng/settings.yml:ro ` +
      `searxng/searxng"`),
      { timeout: 20000, windowsHide: true, stdio: 'ignore' }
    );
  } catch {}

  // Step 3: Wait for boot
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://localhost:${SEARXNG_PORT}/search?q=ping&format=json`, {
        signal: AbortSignal.timeout(2000)
      });
      if (res.ok) return;
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════
// 2. Safe page fetch + extraction
// ═══════════════════════════════════════════════════════════

export async function fetchPage(
  url: string,
  options?: { extract?: string; limit?: number }
): Promise<FetchedPage> {
  const extract = options?.extract || 'auto';
  const limit = options?.limit || 15000;

  const result = await safeFetch(url);
  if (!result.ok) throw new Error(result.error);

  const html = result.buffer.toString('utf-8');
  let title = '';
  let content = '';
  let source: 'readability' | 'raw' | 'selector' = 'raw';

  if (extract === 'readability' || (extract === 'auto' && detectContentType(html) === 'readability')) {
    const extracted = extractReadability(html, url);
    if (extracted) { title = extracted.title; content = extracted.textContent; source = 'readability'; }
  }

  if (!content && extract && !extract.startsWith('auto') && !extract.startsWith('readability') && !extract.startsWith('raw')) {
    const selected = extractCssSelector(html, extract);
    if (selected) {
      const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
      title = titleMatch ? titleMatch[1].trim() : '';
      content = selected; source = 'selector';
    }
  }

  if (!content || extract === 'raw') {
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    title = titleMatch ? titleMatch[1].trim() : '';
    content = html.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  }

  content = cleanBoilerplate(content);
  if (content.length > limit) content = content.substring(0, limit) + '... [truncated]';

  return { title: title || url, content, url: result.finalUrl, chars: content.length, source, contentType: result.contentType };
}

// ═══════════════════════════════════════════════════════════
// 3. Playwright JS rendering (optional, lazy-start)
// ═══════════════════════════════════════════════════════════

let playwrightBrowser: any = null;
let playwrightAvailable: boolean | null = null;

/**
 * Check if playwright package is installed without loading it.
 * Uses dynamic import() which caches the result — first call checks, subsequent calls are instant.
 */
async function isPlaywrightAvailable(): Promise<boolean> {
  if (playwrightAvailable !== null) return playwrightAvailable;
  try {
    await import('playwright');
    playwrightAvailable = true;
  } catch {
    playwrightAvailable = false;
  }
  return playwrightAvailable;
}

export async function tryPlaywright(url: string): Promise<{ html: string; title: string } | null> {
  if (!(await isPlaywrightAvailable())) return null;

  const validated = validateUrl(url);
  if (!validated.ok) { console.warn('[web-lib] Playwright blocked:', validated.error); return null; }

  let context: any = null;
  try {
    const { chromium } = await import('playwright');
    if (!playwrightBrowser) {
      playwrightBrowser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
               '--disable-blink-features=AutomationControlled', '--disable-web-security'],
      });
    }
    context = await playwrightBrowser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    const html = await page.content();
    const title = await page.title();
    return { html, title };
  } catch (err: any) {
    console.warn('[web-lib] Playwright failed:', err.message?.substring(0, 80));
    return null;
  } finally {
    if (context) {
      try { await context.close(); } catch {}
    }
  }
}

export async function stopPlaywright(): Promise<void> {
  if (playwrightBrowser) {
    try { await playwrightBrowser.close(); } catch {}
    playwrightBrowser = null;
  }
}

// ═══════════════════════════════════════════════════════════
// 4. Scrape pipeline (Layer 1 → Layer 2)
// ═══════════════════════════════════════════════════════════

export async function scrapePipeline(
  url: string,
  options?: { extract?: string; limit?: number }
): Promise<FetchedPage> {
  // Layer 1: Direct fetch
  try {
    const page = await fetchPage(url, options);
    if (page.chars > 200 && (page.source === 'readability' || page.source === 'selector')) return page;
    if (page.chars > 500) return page;
  } catch (err: any) {
    console.warn(`[scrape] Direct fetch failed: ${err.message?.substring(0, 60)}`);
  }

  // Layer 2: Playwright JS rendering
  const rendered = await tryPlaywright(url);
  if (rendered) {
    const extracted = extractReadability(rendered.html, url);
    if (extracted && extracted.textContent.length > 200) {
      return {
        title: rendered.title || url,
        content: cleanBoilerplate(extracted.textContent).substring(0, options?.limit || 15000),
        url, chars: extracted.textContent.length, source: 'playwright',
      };
    }
  }

  throw new Error(`Failed to fetch content from ${url}: page may be blocked or require JavaScript`);
}

// ═══════════════════════════════════════════════════════════
// 5. Crawl (BFS link following)
// ═══════════════════════════════════════════════════════════

function extractInternalLinks(html: string, baseOrigin: string): string[] {
  const links = new Set<string>();
  const hrefRegex = /<a[^>]+href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    try {
      const href = match[1];
      if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;
      const resolved = new URL(href, baseOrigin).href;
      const parsed = new URL(resolved);
      if (parsed.origin !== baseOrigin) continue;
      if (/\.(pdf|zip|tar|gz|exe|msi|dmg|apk|ipa|iso)$/i.test(parsed.pathname)) continue;
      if (parsed.hash) continue;
      links.add(resolved);
    } catch { /* skip invalid */ }
  }
  return [...links];
}

export async function crawlSite(url: string, depth: number = 1, limit: number = 10): Promise<CrawlResult[]> {
  const finalDepth = Math.min(depth, CRAWL_MAX_DEPTH);
  const finalLimit = Math.min(limit, CRAWL_MAX_PAGES);

  const validated = validateUrl(url);
  if (!validated.ok) throw new Error(validated.error);

  const baseOrigin = validated.parsed.origin;
  const visited = new Set<string>();
  const results: CrawlResult[] = [];
  const queue: Array<{ url: string; level: number }> = [{ url, level: 0 }];

  while (queue.length > 0 && results.length < finalLimit) {
    const { url: currentUrl, level: currentLevel } = queue.shift()!;
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);

    try {
      const page = await scrapePipeline(currentUrl, { extract: 'readability' });
      if (!page.content || page.content.length < 50) continue;

      let links: string[] = [];
      if (currentLevel < finalDepth) {
        try {
          const rawFetch = await safeFetch(currentUrl);
          if (rawFetch.ok) links = extractInternalLinks(rawFetch.buffer.toString('utf-8'), baseOrigin);
        } catch {}
      }

      results.push({ url: currentUrl, title: page.title, content: page.content, chars: page.chars, links });

      if (currentLevel < finalDepth) {
        for (const link of links) {
          if (!visited.has(link) && results.length < finalLimit) queue.push({ url: link, level: currentLevel + 1 });
        }
      }
    } catch (err: any) {
      console.warn(`[crawl] Skipped ${currentUrl}: ${err.message?.substring(0, 60)}`);
    }
  }

  if (results.length === 0) throw new Error(`No pages could be crawled from ${url}`);
  return results;
}