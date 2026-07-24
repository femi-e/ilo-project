// ============================================================================
// lib/constants.ts — Shared paths and constants
// ============================================================================
// Paths are computed from the extension location at import time so they
// work regardless of the current working directory.
// ============================================================================

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

/** Root project directory (ilo/). From lib/ up 4 levels. */
export const EXTENSION_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', '..', '..', '..'
);

/** Extension source directory (.pi/extensions/core/). */
export const EXT_SRC_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', '..'
);

/** Runtime data directory (ilo/var/). */
export const EXT_VAR_DIR = path.join(EXTENSION_DIR, 'var');

/** SearXNG metasearch port (Docker/Podman: 18089 → 8080). */
export const SEARXNG_PORT = 18089;

/** Max search results to return. */
export const SEARXNG_DEFAULT_LIMIT = 5;
export const SEARXNG_MAX_LIMIT = 20;