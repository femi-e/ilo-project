// ============================================================================
// lib/constants.ts — Shared constants across all modules
// ============================================================================
// Runtime-tunable values are stored in Config nodes in the DB.
// This file only contains compile-time constants that cannot change.
// Paths that depend on the extension location are computed at import time
// so the extension is fully self-contained (no dependency on CWD).
// ============================================================================

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/**
 * The root directory of the ailo extension itself.
 * Computed from this module's location, so it works regardless of CWD.
 */
/**
 * The project root directory (ailo/).
 * From .pi/extensions/core/lib/ up 4 levels:
 *   lib/ -> core/ -> extensions/ -> .pi/ -> project root
 */
export const EXTENSION_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', '..', '..', '..'
);

/**
 * The extension source directory (.pi/extensions/core/).
 */
export const EXT_SRC_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', '..'
);

/**
 * The var/ directory at the project root (self-contained data storage).
 */
export const EXT_VAR_DIR = path.join(EXTENSION_DIR, 'var');

/** Embedding vector dimension (768 for BGE-base/nomic). */
export const EMBEDDING_DIM = 768;

/** Default embedding model name (informational — actual path is in embedding.ts). */
export const EMBED_MODEL = 'bge-base-en-v1.5';

/** Default SearXNG port (podman: podman run -d -p 18089:8080 searxng/searxng) */
export const SEARXNG_PORT = 18089;

/** Playwright/Browserless port for JS rendering */
export const PLAYWRIGHT_PORT = 4000;

/** Max pages to crawl in a single crawl operation */
export const CRAWL_MAX_PAGES = 100;

/** Max link depth for crawling */
export const CRAWL_MAX_DEPTH = 3;

/** Timeout for web requests in milliseconds */
export const WEB_TIMEOUT_MS = 15000;

/** Max content bytes for fetched/scraped content */
export const MAX_CONTENT_BYTES = 5_000_000;

/** Path to the scratchpad JSON file (inside the extension's var/) */
export const SCRATCHPAD_PATH = path.join(EXT_VAR_DIR, 'scratchpad.json');

/** Default chunk sizes for content ingestion */
export const CHUNK_TARGET_SIZE = 1500;
export const CHUNK_OVERLAP = 100;
export const CHUNK_HARD_MAX = 2000;