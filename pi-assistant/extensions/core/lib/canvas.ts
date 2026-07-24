// ============================================================================
// lib/canvas.ts — Universal Canvas LMS content sync via Playwright
// ============================================================================
// Handles ALL Canvas page types: wiki pages, quizzes, assignments, discussions.
// Extracts embedded H5P modules (carousels, fill-in-blanks, drag-drop, etc.),
// videos (Wistia), and hidden transcripts from all content containers.
// ============================================================================

import type { Page, BrowserContext } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Course metadata ─────────────────────────────────────
const COURSE_MAP: Record<string, string> = {
  '997':  'LSE_DA101', '1027': 'LSE_DA201', '1065': 'LSE_DA301',
};
const COURSE_DIR_NAMES: Record<string, string> = {
  '997':  'course-1', '1027': 'course-2', '1065': 'course-3',
};

// ── Types ───────────────────────────────────────────────

export interface ModuleItem {
  itemId: string;
  title: string;
  type: string;       // wiki_page, quiz, assignment, discussion, sub_header, other
  indent: number;
  moduleLabel: string;
}

export interface EmbeddedModule {
  type: 'video' | 'h5p' | 'transcript' | 'other';
  title: string;
  url: string;
  content?: string;
}

export interface PageResult {
  title: string;
  slug: string;
  content: string;      // Readability HTML
  textContent: string;  // plain text
  chars: number;
  url: string;
  moduleLabel: string;
  sectionNum: string;
  embedded: EmbeddedModule[];
}

export interface SyncResult {
  courseId: string; courseLabel: string;
  pagesDownloaded: number; pagesSkipped: number; errors: number; totalChars: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Parse modules page — extract all items with their types and IDs
// ═══════════════════════════════════════════════════════════════════════════

export async function parseModulesPage(page: Page, courseId: string) {
  await page.goto(`https://fourthrev.instructure.com/courses/${courseId}/modules`, {
    waitUntil: 'domcontentloaded', timeout: 20000,
  });
  await page.waitForTimeout(3000);

  // Expand all modules
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, a'))
      .find(b => b.textContent?.toLowerCase().includes('expand all') ||
                 b.textContent?.toLowerCase().includes('collapse all'));
    if (btn) (btn as HTMLElement).click();
  });
  await page.waitForTimeout(2000);

  const result = await page.evaluate(() => {
    const moduleNames: string[] = [];
    const items: Array<{ itemId: string; title: string; type: string; indent: number; moduleIdx: number }> = [];

    document.querySelectorAll('.context_module').forEach((mod, modIdx) => {
      const header = mod.querySelector('.collapse_module_link, .ig-header-title');
      moduleNames.push(header?.textContent?.trim() || `Module ${modIdx + 1}`);

      mod.querySelectorAll('.context_module_item').forEach(el => {
        const link = el.querySelector('a[href*="/modules/items/"]');
        const href = link?.getAttribute('href') || '';
        const match = href.match(/\/modules\/items\/(\d+)/);
        if (!match) return;

        const titleEl = el.querySelector('.module-item-title');
        const title = titleEl?.textContent?.trim() || link?.textContent?.trim() || '';
        const cls = el.className;

        let type = 'other';
        if (cls.includes('wiki_page')) type = 'wiki_page';
        else if (cls.includes('quiz')) type = 'quiz';
        else if (cls.includes('assignment')) type = 'assignment';
        else if (cls.includes('discussion')) type = 'discussion';
        else if (cls.includes('sub_header')) type = 'sub_header';
        else if (cls.includes('file')) type = 'file';

        const indentMatch = cls.match(/indent_(\d+)/);
        items.push({
          itemId: match[1],
          title,
          type,
          indent: indentMatch ? parseInt(indentMatch[1], 10) : 0,
          moduleIdx: modIdx,
        });
      });
    });

    return { moduleNames, items };
  });

  return {
    items: result.items.map(item => ({
      ...item,
      moduleLabel: result.moduleNames[item.moduleIdx] || `Module ${item.moduleIdx + 1}`,
    })),
    moduleNames: result.moduleNames,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Universal content extraction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find the best content container across ALL Canvas page types.
 * Priority: .user_content > #content > [role="main"] > .ic-Layout-contentMain
 */
/**
 * Get visible text from an H5P frame, stripping scripts/config noise.
 */
async function getCleanH5PText(frame: any): Promise<string> {
  return frame.evaluate(() => {
    const root = document.querySelector('.h5p-content, .h5p-question, .h5p-scenario, [class*="h5p-"]');
    if (!root) return (document.body.innerText || '').trim().substring(0, 15000);
    const clone = root.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(
      'script, style, [class*="metadata"], [class*="footer"], [class*="actions"], [class*="fullscreen"]'
    ).forEach(el => el.remove());
    return (clone.textContent || '').trim().substring(0, 15000);
  });
}

/**
 * Reveal hidden transcripts and dialog content on the page.
 */
async function revealHiddenContent(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Click transcript toggle buttons
    document.querySelectorAll('a, button, span, div').forEach(el => {
      if (el.textContent?.toLowerCase().includes('transcript') &&
          ['A', 'BUTTON'].includes(el.tagName)) {
        try { (el as HTMLElement).click(); } catch {}
      }
    });
    // Force-reveal hidden dialog divs
    document.querySelectorAll(
      '[id*="transcript"], .enhanceable_content, .dialog, [style*="display: none"]'
    ).forEach(el => {
      (el as HTMLElement).style.setProperty('display', 'block', 'important');
      (el as HTMLElement).style.setProperty('visibility', 'visible', 'important');
    });
  });
  await page.waitForTimeout(500);
}

/**
 * Extract embedded media from the page: videos, H5P iframes, transcripts.
 */
async function extractEmbedded(page: Page): Promise<EmbeddedModule[]> {
  const embedded: EmbeddedModule[] = [];

  // ── Step A: Find iframes (videos + H5P) from the content container ──
  const iframeData = await page.evaluate(() => {
    const container = document.querySelector(
      '.user_content, #content, [role="main"], .ic-Layout-contentMain, .show-content.user_content'
    );
    if (!container) return [];
    const results: Array<{ type: string; title: string; url: string }> = [];
    container.querySelectorAll('iframe').forEach(f => {
      const src = f.getAttribute('src') || '';
      const title = f.getAttribute('title') || '';
      if (src.includes('wistia'))
        results.push({ type: 'video', title: title || 'Wistia video', url: src });
      else if (src.includes('h5p.com'))
        results.push({ type: 'h5p', title: title || 'H5P interactive module', url: src });
      else if (src.includes('youtube') || src.includes('vimeo'))
        results.push({ type: 'video', title: title || 'Video', url: src });
      else
        results.push({ type: 'other', title: title || 'Embedded content', url: src });
    });
    return results;
  });
  for (const item of iframeData) {
    embedded.push(item as EmbeddedModule);
  }

  // ── Step B: Find transcripts from revealed dialog divs ──
  const transcriptData = await page.evaluate(() => {
    const results: Array<{ title: string; content: string }> = [];
    document.querySelectorAll('[id*="transcript"]').forEach(el => {
      if (el.tagName === 'BUTTON' || el.tagName === 'A') return;
      const text = el.textContent?.trim();
      if (!text || text.length < 40) return;
      let heading = '';
      let prev = el.previousElementSibling;
      for (let i = 0; i < 5 && prev; i++) {
        if (['H1','H2','H3','H4','H5','H6'].includes(prev.tagName)) {
          heading = prev.textContent?.trim() || ''; break;
        }
        prev = prev.previousElementSibling;
      }
      results.push({
        title: heading || el.id?.replace('transcript_', 'Transcript ') || 'Transcript',
        content: text.substring(0, 8000),
      });
    });
    return results;
  });
  for (const td of transcriptData) {
    embedded.push({ type: 'transcript', title: td.title, url: '', content: td.content });
  }

  return embedded;
}

/**
 * Extract ALL H5P content from embedded iframes.
 * Universal approach: clicks ALL interactive elements (carousels, accordions, etc.)
 * to trigger lazy loading, then extracts clean text.
 */
async function extractH5PContent(page: Page, embedded: EmbeddedModule[]): Promise<void> {
  await page.waitForTimeout(3000);

  for (const frame of page.frames()) {
    if (!frame.url().includes('h5p.com')) continue;

    try {
      const allTexts: string[] = [];

      // ── Phase 1: Single pass — extract-then-click for each slide ──
      // Each extraction captures the CURRENT visible slide via innerText
      // Then we click Next to reveal the next slide
      for (let slide = 0; slide < 20; slide++) {
        // Extract current slide (visible-only via innerText)
        const slideText = await frame.evaluate(() => (document.body.innerText || '').trim());
        if (slideText.length > 30) allTexts.push(slideText);
        
        // Click Next to load the next slide
        const clicked = await frame.evaluate(() => {
          const next = document.querySelector('[aria-label*="next" i]');
          if (next) { (next as HTMLElement).click(); return true; }
          return false;
        });
        if (!clicked) break;
        await new Promise(r => setTimeout(r, 500));
      }

      // ── Phase 2: Click non-navigation buttons (Check, Show solution, etc.) ──
      for (let round = 0; round < 5; round++) {
        const before = await frame.evaluate(() => document.body.innerText.length);
        await frame.evaluate(() => {
          document.querySelectorAll('button, [role="button"]').forEach(el => {
            const label = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
            if (label.includes('next') || label.includes('previous') || label.includes('slide') || 
                label.includes('tab') || label.includes('fullscreen')) return;
            if ((el as HTMLElement).offsetParent !== null) {
              try { (el as HTMLElement).click(); } catch {}
            }
          });
        });
        await new Promise(r => setTimeout(r, 500));
        const afterText = await frame.evaluate(() => (document.body.innerText || '').trim());
        if (afterText.length > 30) allTexts.push(afterText);
        const after = await frame.evaluate(() => document.body.innerText.length);
        if (after <= before) break;
      }

      // Match to embedded item
      const h5pId = frame.url().split('/').filter(s => /^\d+$/.test(s)).pop();
      let match = h5pId
        ? embedded.find(e => e.type === 'h5p' && (e.url || '').includes(h5pId))
        : undefined;
      if (!match) match = embedded.find(e => e.type === 'h5p' && e.url === frame.url());
      if (!match) match = embedded.find(e => e.type === 'h5p' && !e.content);

      if (match) {
        // Dedup: compare by LAST 300 chars (the unique content, not the shared title)
        const seen = new Set<string>();
        const unique = allTexts.filter(t => {
          const key = t.substring(t.length - 200);
          if (seen.has(key)) return false;
          seen.add(key);
          return t.length > 30;
        });
        // For carousels: keep ALL unique text states
        const combined = unique.join('\n\n———\n\n');
        match.content = combined.substring(0, 15000);
        console.log(`    [H5P] Extracted (${match.content.length} chars, ${unique.length} states): ${match.content.substring(0, 60)}...`);
      }
    } catch (err: any) {
      console.log(`    [H5P] Error: ${err.message.substring(0, 60)}`);
    }
  }
}

/**
 * Extract the main page content using Readability.
 */
async function extractMainContent(page: Page, url: string): Promise<{ content: string; textContent: string; chars: number } | null> {
  const html = await page.content();
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.textContent || article.textContent.length < 50) return null;
  return {
    content: article.content || '',
    textContent: article.textContent || '',
    chars: article.textContent.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Download a single page (universal — works for ALL page types)
// ═══════════════════════════════════════════════════════════════════════════

export async function downloadPage(
  page: Page,
  context: BrowserContext,
  courseId: string,
  item: ModuleItem,
): Promise<PageResult | null> {
  try {
    const url = `https://fourthrev.instructure.com/courses/${courseId}/modules/items/${item.itemId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const slugMatch = finalUrl.match(/\/pages\/([^?]+)/);
    const slug = slugMatch ? decodeURIComponent(slugMatch[1]) : '';

    // Get page title from ANY heading
    const pageTitle = await page.evaluate(() => {
      const titleEl = document.querySelector('.page-title, h1, h2:first-child');
      return titleEl?.textContent?.trim() || document.title || '';
    });
    const actualTitle = pageTitle || item.title;

    // Reveal hidden content
    await revealHiddenContent(page);

    // Extract embedded media (videos, H5P iframes, transcripts)
    const embedded = await extractEmbedded(page);

    // Extract H5P content from iframes
    await extractH5PContent(page, embedded);

    // Extract main content via Readability
    const mainContent = await extractMainContent(page, finalUrl);
    if (!mainContent) {
      console.log(`    ⚠️  No content for "${item.title}"`);
      return null;
    }

    return {
      title: actualTitle,
      slug,
      content: mainContent.content,
      textContent: mainContent.textContent,
      chars: mainContent.chars,
      url: finalUrl,
      moduleLabel: item.moduleLabel,
      sectionNum: '',
      embedded,
    };
  } catch (err: any) {
    console.log(`    ❌ Error downloading "${item.title}": ${err.message.substring(0, 80)}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Utilities
// ═══════════════════════════════════════════════════════════════════════════

function getModuleNumber(label: string): number {
  const m = label.match(/Module\s+(\d+)/i);
  if (m) return parseInt(m[1], 10);
  if (label.toLowerCase().includes('survey')) return 0;
  const n = label.match(/^(\d+)/);
  if (n) return parseInt(n[1], 10);
  let h = 0;
  for (let i = 0; i < label.length; i++) { h = ((h << 5) - h) + label.charCodeAt(i); h |= 0; }
  return Math.abs(h) % 100 + 10;
}

function extractSectionNum(title: string): string {
  const m = title.match(/^(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : '';
}

function getOutputDir(courseId: string): string {
  return path.resolve('course', COURSE_DIR_NAMES[courseId] || `course-${courseId}`);
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/\./g, '-dot-').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function checkExistingFiles(courseId: string): number {
  const dir = getOutputDir(courseId);
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const sub of fs.readdirSync(dir).filter(d => d.startsWith('module-'))) {
    const subPath = path.join(dir, sub);
    if (!fs.statSync(subPath).isDirectory()) continue;
    count += fs.readdirSync(subPath).filter(f => f.endsWith('.md')).length;
  }
  return count;
}

function checkExisting(courseId: string, title: string, sectionNum: string): string | null {
  const dir = getOutputDir(courseId);
  if (!fs.existsSync(dir)) return null;
  for (const sub of fs.readdirSync(dir).filter(d => d.startsWith('module-'))) {
    const subPath = path.join(dir, sub);
    if (!fs.statSync(subPath).isDirectory()) continue;
    for (const file of fs.readdirSync(subPath).filter(f => f.endsWith('.md'))) {
      try {
        const c = fs.readFileSync(path.join(subPath, file), 'utf-8');
        const tm = c.match(/^title: "(.+)"$/m);
        if (tm && tm[1] === title) return path.join(subPath, file);
        if (sectionNum && file.startsWith(sectionNum + ' ')) return path.join(subPath, file);
      } catch {}
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. HTML → Markdown
// ═══════════════════════════════════════════════════════════════════════════

function htmlToMarkdown(html: string): string {
  if (!html) return '';
  return html
    .replace(/<h1[^>]*>([^<]*)<\/h1>/gi, '# $1\n\n')
    .replace(/<h2[^>]*>([^<]*)<\/h2>/gi, '## $1\n\n')
    .replace(/<h3[^>]*>([^<]*)<\/h3>/gi, '### $1\n\n')
    .replace(/<h4[^>]*>([^<]*)<\/h4>/gi, '#### $1\n\n')
    .replace(/<strong[^>]*>([^<]*)<\/strong>/gi, '**$1**')
    .replace(/<em[^>]*>([^<]*)<\/em>/gi, '*$1*')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, '[$2]($1)')
    .replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)')
    .replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '![Image]($1)')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<li[^>]*>([^<]*)<\/li>/gi, '- $1\n')
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, '$1\n').replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '$1\n')
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n\n')
    .replace(/<code[^>]*>([^<]*)<\/code>/gi, '`$1`')
    .replace(/<hr[^>]*>/gi, '---\n\n')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '> $1\n\n')
    .replace(/<\/?div[^>]*>/gi, '\n').replace(/<\/?span[^>]*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–')
    .replace(/\n{4,}/g, '\n\n\n').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Save as markdown
// ═══════════════════════════════════════════════════════════════════════════

export function savePageAsMarkdown(result: PageResult, courseId: string, sectionNum: string): string {
  const dir = getOutputDir(courseId);
  const moduleNum = getModuleNumber(result.moduleLabel);
  const fullDir = path.join(dir, `module-${moduleNum}`);
  fs.mkdirSync(fullDir, { recursive: true });

  const section = sectionNum || extractSectionNum(result.title);
  const cleanTitle = result.title.replace(/^[\d. ]+/, '').trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ');
  const filename = section ? `${section} ${cleanTitle}.md` : `${slugify(result.title)}.md`;
  const filePath = path.join(fullDir, filename);
  const now = new Date().toISOString().split('T')[0];

  const parts: string[] = [
    '---',
    `source: "${result.url}"`,
    `course_id: "${courseId}"`,
    `module: ${moduleNum}`,
    `title: "${result.title}"`,
    `created: ${now}`,
    '---',
    '',
    `# ${result.title}`,
    '',
    htmlToMarkdown(result.content),
  ];

  if (result.embedded?.length > 0) {
    parts.push('\n\n---\n## Embedded Content\n');
    for (const em of result.embedded) {
      if (em.type === 'video')
        parts.push(`\n### 📹 ${em.title}\n- **URL**: ${em.url}\n`);
      else if (em.type === 'h5p')
        parts.push(`\n### 🧩 ${em.title}\n- **URL**: ${em.url}\n${em.content ? '\n**Content**:\n' + em.content + '\n' : ''}`);
      else if (em.type === 'transcript')
        parts.push(`\n### 📝 ${em.title}\n\n${em.content || ''}\n`);
      else
        parts.push(`\n### 🔗 ${em.title}\n- **URL**: ${em.url}\n`);
    }
  }

  fs.writeFileSync(filePath, parts.join('\n'), 'utf-8');
  return filePath;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Sync one course
// ═══════════════════════════════════════════════════════════════════════════

export async function syncCourse(
  page: Page, context: BrowserContext, courseId: string,
  onProgress?: (msg: string) => void,
  startModule?: number,
  endModule?: number,
): Promise<SyncResult> {
  const log = (m: string) => { console.log(m); onProgress?.(m); };
  const label = COURSE_MAP[courseId] || `Course ${courseId}`;
  log(`\n=== Syncing ${label} (${courseId}) ===`);

  const { items, moduleNames } = await parseModulesPage(page, courseId);
  const contentTypes = ['wiki_page', 'quiz', 'assignment', 'discussion'];
  let content = items.filter(i => contentTypes.includes(i.type));
  
  // Filter by module range
  if (startModule || endModule) {
    content = content.filter(i => {
      const modNum = getModuleNumber(i.moduleLabel);
      if (startModule && modNum < startModule) return false;
      if (endModule && modNum > endModule) return false;
      return true;
    });
  }
  
  // Check existing files first to skip already-downloaded content
  const existingCount = checkExistingFiles(courseId);
  if (existingCount > 0 && !startModule) {
    log(`  Existing files: ${existingCount}`);
  }

  log(`  Modules: ${moduleNames.length}`);
  log(`  Content items: ${content.length} (${items.filter(i => i.type === 'wiki_page').length} pages, ${items.filter(i => i.type === 'quiz').length} quizzes, ${items.filter(i => i.type === 'assignment').length} assignments)`);

  if (content.length === 0) {
    return { courseId: courseId, courseLabel: label, pagesDownloaded: 0, pagesSkipped: 0, errors: 0, totalChars: 0 };
  }

  let downloaded = 0, skipped = 0, errors = 0, totalChars = 0;

  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    const icon = item.type === 'wiki_page' ? '📄' : item.type === 'quiz' ? '❓' : item.type === 'assignment' ? '📋' : '💬';
    log(`  [${i + 1}/${content.length}] ${icon} "${item.title.substring(0, 50)}"`);

    const result = await downloadPage(page, context, courseId, item);
    if (!result) { errors++; continue; }

    const sectionNum = extractSectionNum(item.title);
    const existingPath = checkExisting(courseId, result.title, sectionNum);
    if (existingPath && fs.existsSync(existingPath)) {
      log(`    ⏭️  Already exists: ${path.basename(existingPath)}`);
      skipped++; continue;
    }

    const filePath = savePageAsMarkdown(result, courseId, sectionNum);
    log(`    ✅ ${path.basename(filePath)} (${result.chars} chars, ${result.embedded?.length || 0} embedded)`);
    downloaded++;
    totalChars += result.chars;
    await new Promise(r => setTimeout(r, 500));
  }

  log(`\n  ✅ ${label}: ${downloaded} new, ${skipped} skipped, ${errors} errors`);
  return { courseId: courseId, courseLabel: label, pagesDownloaded: downloaded, pagesSkipped: skipped, errors, totalChars };
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Sync multiple courses
// ═══════════════════════════════════════════════════════════════════════════

export async function syncCourses(
  page: Page, context: BrowserContext, courseIds: string[],
  onProgress?: (msg: string) => void,
  startModule?: number,
  endModule?: number,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const cid of courseIds) {
    results.push(await syncCourse(page, context, cid, onProgress, startModule, endModule));
  }
  return results;
}
