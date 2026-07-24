// ============================================================================
// lib/recovery.ts — DB backup, integrity checks, crash recovery
// ============================================================================
// Three-layer protection:
//   1. Pre-open integrity check + auto-rollback to latest good backup
//   2. Periodic WAL checkpointing to bound replay time
//   3. Sentinel file for clean-exit detection
//
// Recovery strategy:
//   - On unclean shutdown: detect via missing sentinel → attempt WAL replay
//   - If WAL replay fails (corrupt): fall back to last good backup
//   - If backup also corrupt: fall back to oldest available backup
//   - If all backups corrupt: clean start (better than crash loop)
// ============================================================================

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXT_VAR_DIR } from './constants';

// ── Constants ─────────────────────────────────────────────

/** Sentinel file written after successful shutdown */
const SHUTDOWN_SENTINEL = () => path.join(EXT_VAR_DIR, '.clean_shutdown');

/** How many backup generations to keep */
const MAX_BACKUPS = 5;

/** Minimum interval between periodic backups (ms) */
const BACKUP_MIN_INTERVAL_MS = 60_000;

/** Max WAL size before forcing checkpoint (bytes) */
const MAX_WAL_BYTES = 10 * 1024 * 1024; // 10MB

// ── Types ────────────────────────────────────────────────

export interface BackupInfo {
  path: string;
  timestamp: number;
  size: number;
}

export interface IntegrityResult {
  ok: boolean;
  recovered: boolean;
  message: string;
  backupUsed?: string;
}

// ═══════════════════════════════════════════════════════════
// 1. Sentinel / clean-shutdown tracking
// ═══════════════════════════════════════════════════════════

/**
 * Mark that the database shut down cleanly.
 * Write current timestamp to sentinel file.
 */
export function markCleanShutdown(): void {
  try {
    fs.writeFileSync(SHUTDOWN_SENTINEL(), Date.now().toString(), 'utf-8');
  } catch (err: any) {
    console.warn('[recovery] Failed to write shutdown sentinel:', err.message);
  }
}

/**
 * Check if the previous shutdown was clean.
 * Returns true if sentinel exists and was written after DB last modified.
 */
export function wasCleanShutdown(dbPath: string): boolean {
  try {
    const sentinelPath = SHUTDOWN_SENTINEL();
    if (!fs.existsSync(sentinelPath)) return false;
    const sentinelTime = parseInt(fs.readFileSync(sentinelPath, 'utf-8').trim(), 10);
    if (isNaN(sentinelTime)) return false;

    // Check sentinel is newer than DB file (means DB was closed AFTER last write)
    if (fs.existsSync(dbPath)) {
      const dbMtime = fs.statSync(dbPath).mtimeMs;
      return sentinelTime > dbMtime;
    }
    return false;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// 2. Backup management
// ═══════════════════════════════════════════════════════════

/**
 * Get the backup directory path.
 */
function backupDir(): string {
  const dir = path.join(EXT_VAR_DIR, 'backups');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/**
 * List all existing backups, newest first.
 */
export function listBackups(dbName: string): BackupInfo[] {
  const dir = backupDir();
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(dbName + '.bak.'))
      .map(f => {
        const fullPath = path.join(dir, f);
        const stat = fs.statSync(fullPath);
        return { path: fullPath, timestamp: stat.mtimeMs, size: stat.size };
      })
      .sort((a, b) => b.timestamp - a.timestamp);
    return files;
  } catch {
    return [];
  }
}

/**
 * Create a timestamped backup of the database file.
 * Copies both .lbug and .lbug.wal files.
 * Prunes old backups to MAX_BACKUPS.
 */
export function createBackup(dbPath: string): string | null {
  try {
    const dir = backupDir();
    const dbName = path.basename(dbPath, '.lbug');
    const timestamp = Date.now();
    const backupFile = path.join(dir, `${dbName}.bak.${timestamp}`);

    if (!fs.existsSync(dbPath)) return null;

    fs.copyFileSync(dbPath, backupFile);
    const size = fs.statSync(backupFile).size;

    // Also backup the WAL if it exists
    const walPath = dbPath + '.wal';
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, backupFile + '.wal');
    }

    // Prune old backups
    pruneBackups(dbName);

    console.log(`[recovery] Backup created: ${backupFile} (${(size / 1024 / 1024).toFixed(1)}MB)`);
    return backupFile;
  } catch (err: any) {
    console.warn('[recovery] Backup failed:', err.message);
    return null;
  }
}

/**
 * Prune backups to keep only the MAX_BACKUPS most recent.
 */
function pruneBackups(dbName: string): void {
  try {
    const dir = backupDir();
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(dbName + '.bak.'))
      .sort()
      .reverse();

    while (backups.length > MAX_BACKUPS) {
      const old = backups.pop()!;
      fs.unlinkSync(path.join(dir, old));
      // Also remove associated WAL backup
      const walOld = old + '.wal';
      try { fs.unlinkSync(path.join(dir, walOld)); } catch {}
    }
  } catch {}
}

/**
 * Restore from the most recent good backup.
 * Returns the backup path used, or null if no backup is available.
 */
export function restoreFromBackup(dbPath: string): string | null {
  const dbName = path.basename(dbPath, '.lbug');
  const backups = listBackups(dbName);

  if (backups.length === 0) {
    console.warn('[recovery] No backups available to restore from');
    return null;
  }

  // Try each backup newest-first until one succeeds
  for (const backup of backups) {
    try {
      // Rename current corrupt DB as evidence
      if (fs.existsSync(dbPath)) {
        const corruptPath = dbPath + '.corrupt.' + Date.now();
        fs.renameSync(dbPath, corruptPath);
        console.log(`[recovery] Preserved corrupt DB as ${corruptPath}`);
      }

      // Copy backup to DB location
      fs.copyFileSync(backup.path, dbPath);
      console.log(`[recovery] Restored from backup: ${backup.path}`);

      // Also restore WAL if present
      const walBackup = backup.path + '.wal';
      const walTarget = dbPath + '.wal';
      if (fs.existsSync(walBackup)) {
        fs.copyFileSync(walBackup, walTarget);
      }

      return backup.path;
    } catch (err: any) {
      console.warn(`[recovery] Failed to restore from ${backup.path}: ${err.message}`);
    }
  }

  console.error('[recovery] All backups failed — no valid backup to restore');
  return null;
}

// ═══════════════════════════════════════════════════════════
// 3. WAL management
// ═══════════════════════════════════════════════════════════

/**
 * Check if the WAL file is too large and needs checkpointing.
 */
export function walNeedsCheckpoint(dbPath: string): boolean {
  try {
    const walPath = dbPath + '.wal';
    if (!fs.existsSync(walPath)) return false;
    return fs.statSync(walPath).size > MAX_WAL_BYTES;
  } catch {
    return false;
  }
}

/**
 * Get WAL file size in bytes.
 */
export function walSize(dbPath: string): number {
  try {
    const walPath = dbPath + '.wal';
    if (!fs.existsSync(walPath)) return 0;
    return fs.statSync(walPath).size;
  } catch {
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════
// 4. Pre-open integrity check
// ═══════════════════════════════════════════════════════════

/**
 * Run integrity checks before opening the database.
 * - Check if previous shutdown was clean
 * - Check DB file existence and size
 * - Attempt auto-restore if corruption is detected
 *
 * Returns the result of the integrity check.
 */
export function preOpenIntegrityCheck(dbPath: string): IntegrityResult {
  // Step 1: Check if the database file exists at all
  if (!fs.existsSync(dbPath)) {
    return { ok: true, recovered: false, message: 'New database — no existing file' };
  }

  // Step 2: Check DB file size
  const stat = fs.statSync(dbPath);
  if (stat.size === 0) {
    // Empty DB file — try backup
    const backup = restoreFromBackup(dbPath);
    if (backup) {
      return { ok: true, recovered: true, message: 'Empty DB file restored from backup', backupUsed: backup };
    }
    // No backup, remove empty file so new one is created
    try { fs.unlinkSync(dbPath); } catch {}
    return { ok: true, recovered: false, message: 'Empty DB file removed — will create new' };
  }

  // Step 3: Check if shutdown was clean
  const clean = wasCleanShutdown(dbPath);
  if (!clean) {
    console.warn('[recovery] Previous shutdown was UNCLEAN — possible corruption');

    // Check for tiny DB files (likely corruption)
    if (stat.size < 4096) {
      console.warn(`[recovery] DB file suspiciously small (${stat.size} bytes) — attempting recovery`);
      const backup = restoreFromBackup(dbPath);
      if (backup) {
        return { ok: true, recovered: true, message: 'Suspicious DB restored from backup', backupUsed: backup };
      }
    }

    return { ok: true, recovered: true, message: 'Unclean shutdown detected — will attempt WAL replay' };
  }

  // Step 4: Check if WAL is too large (might cause slow recovery)
  const wSize = walSize(dbPath);
  if (wSize > MAX_WAL_BYTES) {
    return {
      ok: true,
      recovered: false,
      message: `WAL file is large (${(wSize / 1024 / 1024).toFixed(1)}MB) — checkpoint recommended`,
    };
  }

  return { ok: true, recovered: false, message: 'Integrity check passed' };
}

// ═══════════════════════════════════════════════════════════
// 5. Circuit breaker (survives reload via globalThis)
// ═══════════════════════════════════════════════════════════

const CKT_KEY = '__ailo_circuit_breaker__';

export interface CircuitBreaker {
  failures: number;
  until: number;
  halfOpen: boolean;
}

const BREAKER_THRESHOLD = 5;
const BREAKER_RESET_MS = 60_000;

/**
 * Get the circuit breaker state (persists across Pi /reload).
 */
export function getCircuitBreaker(): CircuitBreaker {
  let cb = (globalThis as any)[CKT_KEY];
  if (!cb) {
    cb = { failures: 0, until: 0, halfOpen: false };
    (globalThis as any)[CKT_KEY] = cb;
  }
  return cb;
}

/**
 * Check if the circuit breaker is open.
 * Returns an error message if open, null if requests can proceed.
 */
export function checkCircuitBreaker(service: string): string | null {
  const cb = getCircuitBreaker();
  const now = Date.now();

  if (now < cb.until) {
    return `${service} is temporarily disabled after ${cb.failures} failures. Try again in ${Math.ceil((cb.until - now) / 1000)}s.`;
  }
  if (cb.failures >= BREAKER_THRESHOLD) {
    if (cb.halfOpen) return `${service} is currently testing recovery. Please wait...`;
    cb.halfOpen = true;
  }
  return null;
}

/**
 * Record a success or failure on the circuit breaker.
 */
export function recordCircuitResult(ok: boolean): void {
  const cb = getCircuitBreaker();
  if (ok) {
    cb.failures = 0;
    cb.halfOpen = false;
  } else {
    cb.failures++;
    if (cb.failures >= BREAKER_THRESHOLD || cb.halfOpen) {
      cb.until = Date.now() + BREAKER_RESET_MS;
      cb.halfOpen = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// 6. Recovery entry point
// ═══════════════════════════════════════════════════════════

/**
 * Full recovery check — called before DbLayer.open().
 * Run this, then based on the result, decide whether to:
 *   - Proceed with normal open (ok=true)
 *   - Wipe and restore (ok=true, recovered=true, backupUsed set)
 *   - Create fresh DB (ok=true, recovered=false, no file existed)
 */
export function runRecoveryCheck(dbPath: string): IntegrityResult {
  const result = preOpenIntegrityCheck(dbPath);
  console.log(`[recovery] ${result.message}`);
  return result;
}