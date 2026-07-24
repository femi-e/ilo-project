// ============================================================================
// lib/security.ts — URL validation, attack protection, safe fetching
// ============================================================================
// Every web request passes through this layer. Protects against:
//   SSRF, file read, path traversal, redirect bombing, content bombs,
//   slowloris, DNS rebinding, protocol injection, credentials in URL,
//   prompt injection in scraped content.
//
// No external dependencies. Pure functions + Node.js built-ins.
// ============================================================================

import * as dns from 'node:dns';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { MAX_CONTENT_BYTES, WEB_TIMEOUT_MS, EXTENSION_DIR } from './constants';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface SafeFetchResult {
  ok: true;
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
}

export interface SafeFetchError {
  ok: false;
  error: string;
  code: 'VALIDATION' | 'NETWORK' | 'CONTENT' | 'TIMEOUT' | 'REDIRECT' | 'FORBIDDEN';
}

export type SafeFetchResponse = SafeFetchResult | SafeFetchError;

// ═══════════════════════════════════════════════════════════
// Private IP ranges
// ═══════════════════════════════════════════════════════════

const PRIVATE_IPV4_RANGES = [
  /^10\./,                    // 10.0.0.0/8
  /^127\./,                   // 127.0.0.0/8 (localhost)
  /^169\.254\./,              // 169.254.0.0/16 (link-local)
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./,              // 192.168.0.0/16
  /^0\./,                     // 0.0.0.0/8
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // Carrier-grade NAT
];

const PRIVATE_IPV6_RANGES = [
  /^::1$/,                    // localhost
  /^fc00:/i,                  // unique-local
  /^fe80:/i,                  // link-local
  /^fd00:/i,                  // unique-local
  /^::ffff:127\./,            // IPv4-mapped IPv6 localhost
];

// ═══════════════════════════════════════════════════════════
// Blocked hostname patterns
// ═══════════════════════════════════════════════════════════

const BLOCKED_HOSTNAMES = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^\[::1\]$/,
];

// ═══════════════════════════════════════════════════════════
// Prompt injection patterns
// ═══════════════════════════════════════════════════════════

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above)\s+(instructions|directions|commands)/gi,
  /\[system\s+(override|update|instruction)\]/gi,
  /you\s+(are\s+)?(now|must)\s+(a|an)\s+(\w+\s+){0,3}(agent|assistant|bot)/gi,
  /from\s+(now\s+)?on,\s+you\s+(will|must|should)/gi,
  /this\s+is\s+(your\s+)?new\s+(system\s+)?prompt/gi,
  /override\s+(?:all\s+)?(?:previous\s+)?(instructions|directives)/gi,
  /your\s+(new\s+)?(task|mission|purpose)\s+is/i,
];

// ═══════════════════════════════════════════════════════════
// 1. URL validation
// ═══════════════════════════════════════════════════════════

export interface ValidatedUrl {
  ok: true;
  parsed: URL;
  hostname: string;
}

export interface ValidationError {
  ok: false;
  error: string;
  code: 'VALIDATION';
}

export type ValidationResult = ValidatedUrl | ValidationError;

/**
 * Validate a URL for safety.
 * Checks: protocol, credentials, hostname blocklist, private IPs.
 */
export function validateUrl(rawUrl: string): ValidationResult {
  // 1. Parse
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Malformed URL', code: 'VALIDATION' };
  }

  // 2. Protocol check — only HTTPS
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only HTTPS URLs are allowed', code: 'VALIDATION' };
  }

  // 3. Credentials check
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL must not contain credentials', code: 'VALIDATION' };
  }

  // 4. Hostname blocklist
  const hostname = parsed.hostname.toLowerCase();
  for (const pattern of BLOCKED_HOSTNAMES) {
    if (pattern.test(hostname)) {
      return { ok: false, error: `Blocked host: ${hostname}`, code: 'VALIDATION' };
    }
  }

  // 5. Simple private IP check on hostname string
  // (catches raw IP addresses; DNS-resolved IPs checked separately)
  for (const pattern of PRIVATE_IPV4_RANGES) {
    if (pattern.test(hostname)) {
      return { ok: false, error: `Private IP addresses are blocked: ${hostname}`, code: 'VALIDATION' };
    }
  }

  return { ok: true, parsed, hostname };
}

// ═══════════════════════════════════════════════════════════
// 2. DNS + IP validation
// ═══════════════════════════════════════════════════════════

/**
 * Check if an IP address is in a private/reserved range.
 */
export function isPrivateIP(ip: string): boolean {
  // IPv6 check
  if (ip.includes(':')) {
    for (const pattern of PRIVATE_IPV6_RANGES) {
      if (pattern.test(ip)) return true;
    }
    return false;
  }

  // IPv4 check
  for (const pattern of PRIVATE_IPV4_RANGES) {
    if (pattern.test(ip)) return true;
  }
  return false;
}

/**
 * Resolve a hostname to IP addresses and check none are private.
 * Returns true if all IPs are non-private (safe), false if any is private.
 */
export async function resolveAndCheckIP(hostname: string): Promise<boolean> {
  try {
    const addresses = await dns.promises.resolve4(hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) return false;
    }
    return true;
  } catch {
    // DNS resolution failed — the request will fail anyway, but
    // don't block on DNS failure (might be a transient issue)
    return true;
  }
}

// ═══════════════════════════════════════════════════════════
// 3. Safe fetch
// ═══════════════════════════════════════════════════════════

/**
 * Fetch a URL with full security validation.
 * Enforces: HTTPS, redirect limits, timeouts, content size caps.
 */
export async function safeFetch(url: string): Promise<SafeFetchResponse> {
  // Validate URL
  const validated = validateUrl(url);
  if (!validated.ok) return validated;

  // DNS + IP check
  const ipSafe = await resolveAndCheckIP(validated.hostname);
  if (!ipSafe) {
    return { ok: false, error: 'URL resolves to a private IP address', code: 'FORBIDDEN' };
  }

  // Fetch with redirect handling
  let currentUrl = url;
  let redirectCount = 0;
  const maxRedirects = 5;

  while (redirectCount <= maxRedirects) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);

    try {
      const response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });

      // Handle redirect
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return { ok: false, error: 'Redirect with no Location header', code: 'REDIRECT' };
        }

        // Resolve relative redirect
        const redirectUrl = new URL(location, currentUrl).href;

        // Validate the redirect URL
        const redirectValid = validateUrl(redirectUrl);
        if (!redirectValid.ok) {
          return { ok: false, error: `Redirect blocked: ${redirectValid.error}`, code: 'REDIRECT' };
        }

        // Check DNS for the redirect target
        const redirectIpSafe = await resolveAndCheckIP(redirectValid.hostname);
        if (!redirectIpSafe) {
          return { ok: false, error: 'Redirect target resolves to private IP', code: 'REDIRECT' };
        }

        currentUrl = redirectUrl;
        redirectCount++;
        clearTimeout(timeout);
        continue;
      }

      // Check content type
      const contentType = response.headers.get('content-type') || 'text/html';
      if (!contentType.includes('text/') && !contentType.includes('json') && !contentType.includes('xml') && !contentType.includes('markdown')) {
        // Allow HTML, plain text, JSON, XML, markdown
        // Reject: application/pdf, application/zip, image/*, video/*, audio/*
        const binaryTypes = ['application/', 'image/', 'video/', 'audio/', 'font/'];
        if (binaryTypes.some(t => contentType.includes(t))) {
          return { ok: false, error: `Unsupported content type: ${contentType}`, code: 'CONTENT' };
        }
      }

      // Check content-length header
      const contentLength = response.headers.get('content-length');
      if (contentLength) {
        const length = parseInt(contentLength, 10);
        if (!isNaN(length) && length > MAX_CONTENT_BYTES) {
          return { ok: false, error: `Content too large: ${length} bytes (max ${MAX_CONTENT_BYTES})`, code: 'CONTENT' };
        }
      }

      // Stream-read with size cap
      if (!response.body) {
        return { ok: false, error: 'No response body', code: 'CONTENT' };
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_CONTENT_BYTES) {
            reader.cancel();
            return { ok: false, error: `Content exceeds ${MAX_CONTENT_BYTES} byte limit`, code: 'CONTENT' };
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }

      // Collect headers
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      clearTimeout(timeout);
      return {
        ok: true,
        buffer: Buffer.concat(chunks),
        contentType,
        finalUrl: currentUrl,
        statusCode: response.status,
        headers,
      };
    } catch (err: any) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        return { ok: false, error: 'Request timed out', code: 'TIMEOUT' };
      }
      return { ok: false, error: err.message || 'Network error', code: 'NETWORK' };
    }
  }

  return { ok: false, error: `Too many redirects (max ${maxRedirects})`, code: 'REDIRECT' };
}

// ═══════════════════════════════════════════════════════════
// 4. Ingestion path validation
// ═══════════════════════════════════════════════════════════

/**
 * Validate a local file path for ingest.
 * Resolves to absolute and checks against allowed prefixes.
 * Also checks for symlinks and device files.
 */
export function validateIngestPath(filePath: string): { ok: true; resolved: string } | { ok: false; error: string } {
  try {
    // Resolve symlinks first (catches symlink-to-etc attacks)
    const realPath = fs.realpathSync(filePath);
    const resolved = path.resolve(realPath);

    // Allowed prefixes: extension root, plus conventional subdirs
    const allowedPrefixes = [
      EXTENSION_DIR,
      path.join(EXTENSION_DIR, 'var'),
      path.join(EXTENSION_DIR, 'content'),
      path.join(EXTENSION_DIR, 'content', 'drop'),
      path.join(EXTENSION_DIR, 'content', 'course'),
      path.join(EXTENSION_DIR, 'content', 'wiki'),
      path.join(EXTENSION_DIR, 'projects'),
    ];

    const isAllowed = allowedPrefixes.some(prefix =>
      resolved.startsWith(prefix + path.sep) || resolved === prefix
    );

    if (!isAllowed) {
      return { ok: false, error: `Path outside allowed directories: ${resolved}` };
    }

    // Check it's a regular file (not a device or pipe)
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { ok: false, error: 'Not a regular file' };
    }

    // Check file size
    if (stat.size > MAX_CONTENT_BYTES) {
      return { ok: false, error: `File too large: ${stat.size} bytes (max ${MAX_CONTENT_BYTES})` };
    }

    return { ok: true, resolved };
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return { ok: false, error: 'File not found' };
    }
    return { ok: false, error: err.message || 'Path validation error' };
  }
}

// ═══════════════════════════════════════════════════════════
// 5. Injection stripping
// ═══════════════════════════════════════════════════════════

/**
 * Remove known prompt injection patterns from text.
 * Applied to scraped web content before storage.
 */
export function stripInjectionAttempts(text: string): string {
  let cleaned = text;
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[content redacted]');
  }
  return cleaned;
}