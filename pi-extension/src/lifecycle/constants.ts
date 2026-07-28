// ============================================================================
// lib/constants.ts — Shared paths and constants
// ============================================================================
// Paths are computed from the extension location at import time so they
// work regardless of the current working directory.
// ============================================================================

import { fileURLToPath } from "node:url";
import * as path from "node:path";

/** Root project directory (ilo/). From pi-extension/src/lifecycle/ up 3 levels. */
export const EXTENSION_DIR = path.resolve(
	fileURLToPath(new URL(".", import.meta.url)),
	"..",
	"..",
	"..",
);

/** Extension source directory (.pi/extensions/core/). */
export const EXT_SRC_DIR = path.resolve(
	fileURLToPath(new URL(".", import.meta.url)),
	"..",
	"..",
);

/** Runtime data directory (ilo/var/). */
export const EXT_VAR_DIR = path.join(EXTENSION_DIR, "var");

/** SearXNG metasearch port (Docker/Podman: 18089 → 8080). */
export const SEARXNG_PORT = 18089;

/** Max search results to return. */
export const SEARXNG_DEFAULT_LIMIT = 5;
export const SEARXNG_MAX_LIMIT = 20;

/** Starting port for local inference server discovery (llama.cpp, etc.). */
export const LOCAL_CHAT_PORT_START = 1234;

/** Ending port for local inference server discovery (inclusive). */
export const LOCAL_CHAT_PORT_END = 1240;

/** Default embedding server port (llama.cpp embedding model). */
export const LOCAL_EMBED_PORT = 1235;
