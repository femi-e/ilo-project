// ============================================================================
// lib/errors.ts — Structured error types for the entire system
// ============================================================================
// Central error classification used by db.ts, tools, and all lib modules.
// No dependencies. Pure types + functions.
//
// Error codes map to recovery strategies:
//   DB_UNAVAILABLE → reconnect
//   LOCK_CONTENTION → retry with backoff
//   NOT_FOUND → return empty, not error
//   VALIDATION → surface to user
//   STORAGE → surface to user, log
//   NETWORK → retry or degrade
//   UNKNOWN → log, surface
// ============================================================================

// ── Error codes ────────────────────────────────────────

export type ErrorCode =
  | 'DB_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'LOCK_CONTENTION'
  | 'STORAGE'
  | 'NETWORK'
  | 'UNKNOWN';

// ── Error types ────────────────────────────────────────

export interface ToolError {
  ok: false;
  error: string;
  code?: ErrorCode;
}

export type ToolResult = string | ToolError;

// ── Factory functions ──────────────────────────────────

/** Create a ToolError from any error value. */
export function toolError(err: any, defaultCode: ErrorCode = 'UNKNOWN'): ToolError {
  return {
    ok: false,
    error: err?.message || String(err || 'Unknown error'),
    code: inferErrorCode(err, defaultCode),
  };
}

/** Create a validation error. */
export function validationError(msg: string): ToolError {
  return { ok: false, error: msg, code: 'VALIDATION' };
}

/** Create a not-found error. */
export function notFoundError(entity: string, id: string): ToolError {
  return { ok: false, error: `${entity} not found: ${id}`, code: 'NOT_FOUND' };
}

// ── Error classification ───────────────────────────────

/** Check if an error indicates a dead database connection. */
export function isConnDead(err: any): boolean {
  if (!err) return false;
  const msg = err?.message || String(err);
  return msg.includes('Connection is closed')
      || msg.includes('connection is closed')
      || msg.includes('Database is closed')
      || msg.includes('database is closed')
      || msg.includes('Could not set lock')
      || msg.includes('lock on file')
      || msg.includes('Error 33')
      || msg.includes('Cannot start a new write transaction')
      || msg.includes('Only one write transaction')
      || msg.includes('ongoing asynchronous initialization');
}

/** Infer an error code from an error message. */
function inferErrorCode(err: any, defaultCode: ErrorCode = 'UNKNOWN'): ErrorCode {
  if (!err) return defaultCode;
  const msg = (err.message || String(err)).toLowerCase();
  
  if (msg.includes('lock') || msg.includes('33') || msg.includes('busy') || msg.includes('violation'))
    return 'LOCK_CONTENTION';
  if (msg.includes('not found') || msg.includes('no results'))
    return 'NOT_FOUND';
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('refused') || msg.includes('fetch'))
    return 'NETWORK';
  if (msg.includes('invalid') || msg.includes('validation') || msg.includes('required'))
    return 'VALIDATION';
  if (msg.includes('write') || msg.includes('flush') || msg.includes('checkpoint') || msg.includes('io exception'))
    return 'STORAGE';
  if (msg.includes('connect') || msg.includes('not initialised') || msg.includes('not available'))
    return 'DB_UNAVAILABLE';
  
  return defaultCode;
}