// ============================================================================
// lib/diagnostics.ts — In-process database diagnostics
// ============================================================================
// Uses a SEPARATE read-only LadybugDB connection so diagnostics never
// interfere with the main connection's write queue, locks, or throughput.
//
// Architecture:
//   - DiagConnection: Wraps a read-only Database + Connection
//   - Created lazily on first diagnostic query
//   - Closed explicitly with closeDiagConnection()
//   - Falls back to getDb() if read-only connection fails
//
// Provides:
//   - runDiagnostics(): Full system health report
//   - quickHealth(): Fast OK/ERROR status string
//   - pingDb(): Simple DB ping through the active connection
// ============================================================================

import { Database, Connection } from '@ladybugdb/core';
import { getDb, hasEngine } from './engine';
import { getStatus, isGpuEnabled } from './embedding';
import { checkSearXngHealth } from './web-lib';
import { walSize, walNeedsCheckpoint, listBackups, wasCleanShutdown } from './recovery';
import { EXT_VAR_DIR, EXTENSION_DIR } from './constants';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ═══════════════════════════════════════════════════════════
// Separate read-only diagnostic connection
// ═══════════════════════════════════════════════════════════

let _diagDb: Database | null = null;
let _diagConn: Connection | null = null;
let _diagFallback = false; // true if we fell back to getDb()

/**
 * Get or create the diagnostic connection.
 * Opens a read-only LadybugDB connection to the same database file.
 * If that fails (e.g., file locked for write by main connection), falls back
 * to the active getDb() connection — still works, just shares the write queue.
 */
async function getDiagConn(): Promise<Connection | null> {
  // Already have a working diag connection
  if (_diagConn) return _diagConn;

  // Already determined we must fall back
  if (_diagFallback) {
    return hasEngine() ? (getDb() as any).conn : null;
  }

  const dbPath = process.env.AILO_DB_PATH || path.join(EXT_VAR_DIR, 'ailo.lbug');

  try {
    // Open a separate read-only connection
    const db = new Database(
      dbPath,        // path
      65536,         // bufferPoolSize (64KB — tiny, just for diagnostics)
      undefined,     // enableCompression (default)
      true,          // readOnly — true! won't lock the file for writing
      undefined,     // maxDBSize (default)
      false,         // autoCheckpoint — no checkpointing needed for read-only
      undefined,     // checkpointThreshold (irrelevant for read-only)
      false,         // throwOnWalReplayFailure — graceful
      false,         // enableChecksums — skip for diag speed
      false          // enableDefaultHashIndex — don't need it
    );
    const conn = new Connection(db);
    await conn.init();

    // Quick ping to verify it works
    const pingResult = await conn.query('RETURN 1 AS ok');
    const ok = pingResult && typeof (pingResult as any).hasNext === 'function';
    if (!ok) {
      await conn.closeSync();
      await db.closeSync();
      throw new Error('Read-only connection ping failed');
    }

    _diagDb = db;
    _diagConn = conn;
    _diagFallback = false;
    return conn;
  } catch (err: any) {
    console.warn('[diagnostics] Read-only connection failed, falling back to shared:', err.message?.substring(0, 80));
    _diagFallback = true;
    // Fall back to the active connection
    return hasEngine() ? (getDb() as any).conn : null;
  }
}

/**
 * Close the diagnostic connection explicitly.
 */
export function closeDiagConnection(): void {
  if (_diagConn && !_diagFallback) {
    try { _diagConn.closeSync(); } catch {}
    _diagConn = null;
  }
  if (_diagDb && !_diagFallback) {
    try { _diagDb.closeSync(); } catch {}
    _diagDb = null;
  }
  _diagFallback = false;
}

/**
 * Perform a read-only query through the diagnostic connection.
 */
async function diagQuery(cypher: string, params?: Record<string, any>): Promise<any[]> {
  const conn = await getDiagConn();
  if (!conn) throw new Error('[diagnostics] No database connection available');

  if (params && Object.keys(params).length > 0) {
    const stmt = await conn.prepare(cypher);
    const result = await conn.execute(stmt, params);
    const rows = collectRows(result as any);
    try { (result as any)?.close(); } catch {}
    return rows;
  }

  const result = await conn.query(cypher);
  const rows = collectRows(result as any);
  try { (result as any)?.close(); } catch {}
  return rows;
}

/** Collect all rows from a QueryResult. */
function collectRows(result: any): any[] {
  const rows: any[] = [];
  if (result && typeof result.hasNext === 'function') {
    while (result.hasNext()) {
      rows.push(result.getNextSync());
    }
  }
  return rows;
}

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export interface DiagReport {
  timestamp: string;
  hostname: string;
  uptime: number;
  db: DbDiag;
  embedding: EmbedDiag;
  web: WebDiag;
  storage: StorageDiag;
  schema: SchemaDiag;
}

export interface DbDiag {
  available: boolean;
  path: string;
  /** Node counts per table label */
  nodeCounts: Record<string, number>;
  /** Edge counts per rel type */
  edgeCounts: Record<string, number>;
  /** Total nodes */
  totalNodes: number;
  /** Total edges */
  totalEdges: number;
  /** DB file size in bytes */
  dbFileSize: number;
  /** Was last shutdown clean? */
  cleanShutdown: boolean;
}

export interface EmbedDiag {
  status: string;
  model: string;
  dimension: number;
  gpuEnabled: boolean;
  gpuDevices: string[];
}

export interface WebDiag {
  searxng: string;
  playwright: boolean;
  playwrightRunning: boolean;
}

export interface StorageDiag {
  walSize: number;
  walNeedsCheckpoint: boolean;
  backupCount: number;
  varDirSize: number;
}

export interface SchemaDiag {
  tables: string[];
  toolEntities: number;
  configKeys: number;
  activeTasks: number;
  beliefCount: number;
}

// ═══════════════════════════════════════════════════════════
// Diagnostics
// ═══════════════════════════════════════════════════════════

/**
 * Run full system diagnostics through the active DB connection.
 * Returns a structured report. Never throws — errors are captured inline.
 */
export async function runDiagnostics(): Promise<DiagReport> {
  const timestamp = new Date().toISOString();

  return {
    timestamp,
    hostname: os.hostname(),
    uptime: Math.floor(os.uptime()),
    db: await collectDbStats(),
    embedding: collectEmbedStats(),
    web: await collectWebStats(),
    storage: collectStorageStats(),
    schema: await collectSchemaStats(),
  };
}

/**
 * Fast health check — returns a single-line status string.
 * Suitable for quick /status command.
 */
export async function quickHealth(): Promise<string> {
  if (!hasEngine()) return 'DB: disconnected';

  const embedStatus = getStatus();
  const dbPath = process.env.AILO_DB_PATH || path.join(EXT_VAR_DIR, 'ailo.lbug');
  const wSize = walSize(dbPath);

  // Try diag connection first (doesn't touch main write queue)
  try {
    const count = await diagQuery('MATCH (b:Belief) RETURN count(*) AS cnt');
    const beliefCount = count?.[0]?.cnt ?? 0;
    return `DB: connected | Beliefs: ${beliefCount} | Embed: ${embedStatus} | WAL: ${(wSize / 1024).toFixed(0)}KB`;
  } catch {
    // Fallback: use main connection
    return `DB: available | Embed: ${embedStatus} | WAL: ${(wSize / 1024).toFixed(0)}KB`;
  }
}

/**
 * Check whether the database can be queried.
 * Performs a simple ping query through the active connection.
 */
export async function pingDb(): Promise<boolean> {
  if (!hasEngine()) return false;
  try {
    const db = getDb();
    const rows = await db.query('RETURN 1 AS ok');
    return rows?.[0]?.ok === 1;
  } catch {
    return false;
  }
}

/**
 * Get detailed statistics about the database.
 */
async function collectDbStats(): Promise<DbDiag> {
  const dbPath = process.env.AILO_DB_PATH || path.join(EXT_VAR_DIR, 'ailo.lbug');
  const dbFileSize = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const cleanShutdown = wasCleanShutdown(dbPath);

  const result: DbDiag = {
    available: false,
    path: dbPath,
    nodeCounts: {},
    edgeCounts: {},
    totalNodes: 0,
    totalEdges: 0,
    dbFileSize,
    cleanShutdown,
  };

  let conn: Connection | null = null;
  try {
    conn = await getDiagConn();
    if (!conn) return result;
    result.available = true;

    // Node tables to probe
    const nodeTables = ['Entity', 'Belief', 'Turn', 'Config', 'Task', 'Action', 'Feedback', 'Session', 'Summary', 'Discovery', 'Pattern'];
    for (const table of nodeTables) {
      try {
        const rows = await diagQuery(`MATCH (n:${table}) RETURN count(*) AS cnt`);
        result.nodeCounts[table] = rows?.[0]?.cnt ?? 0;
      } catch {
        result.nodeCounts[table] = -1; // Table may not exist yet
      }
    }

    // Rel types to probe
    const relTypes = ['HAS_BELIEF', 'MENTIONED_IN', 'HAS_TURN', 'SUPPORTS', 'CONTRADICTS',
      'CONSOLIDATED_FROM', 'HAS_RESOURCE', 'NEXT_IN_SEQUENCE', 'DERIVED_FROM',
      'HAS_SKILL', 'REQUIRES_SKILL', 'BELONGS_TO_COURSE', 'BELONGS_TO_MODULE',
      'NEXT', 'HAS_PATTERN', 'TRIGGERED'];
    for (const rel of relTypes) {
      try {
        const rows = await diagQuery(`MATCH ()-[r:${rel}]->() RETURN count(*) AS cnt`);
        result.edgeCounts[rel] = rows?.[0]?.cnt ?? 0;
      } catch {
        result.edgeCounts[rel] = -1;
      }
    }

    result.totalNodes = Object.values(result.nodeCounts).reduce((a, b) => a + Math.max(0, b), 0);
    result.totalEdges = Object.values(result.edgeCounts).reduce((a, b) => a + Math.max(0, b), 0);
  } catch (err: any) {
    console.warn('[diagnostics] DB stats error:', err.message);
  }

  return result;
}

/**
 * Collect embedding status info.
 */
function collectEmbedStats(): EmbedDiag {
  return {
    status: getStatus(),
    model: 'bge-base-en-v1.5 (q4_k_m)',
    dimension: 768,
    gpuEnabled: isGpuEnabled(),
    gpuDevices: []
  };
}

/**
 * Collect web-related status info.
 */
async function collectWebStats(): Promise<WebDiag> {
  return {
    searxng: (await checkSearXngHealth()) ? 'available' : 'unavailable',
    playwright: false, // checked via dynamic import
    playwrightRunning: false, // not easily checked without module internals
  };
}

/**
 * Collect storage/file system statistics.
 */
function collectStorageStats(): StorageDiag {
  const dbPath = process.env.AILO_DB_PATH || path.join(EXT_VAR_DIR, 'ailo.lbug');
  const dbName = path.basename(dbPath, '.lbug');

  return {
    walSize: walSize(dbPath),
    walNeedsCheckpoint: walNeedsCheckpoint(dbPath),
    backupCount: listBackups(dbName).length,
    varDirSize: getDirSize(EXT_VAR_DIR),
  };
}

/**
 * Collect schema and data statistics.
 */
async function collectSchemaStats(): Promise<SchemaDiag> {
  const result: SchemaDiag = {
    tables: [],
    toolEntities: 0,
    configKeys: 0,
    activeTasks: 0,
    beliefCount: 0,
  };

  try {
    // List registered tables
    const rows = await diagQuery("CALL SHOW_TABLES() RETURN *");
    result.tables = (rows || []).map((r: any) => r.name || r.table_name || '').filter(Boolean);

    // Tool entities
    const toolRows = await diagQuery("MATCH (e:Entity {type: 'tool'}) RETURN count(*) AS cnt");
    result.toolEntities = toolRows?.[0]?.cnt ?? 0;

    // Config keys
    const configRows = await diagQuery('MATCH (c:Config) RETURN count(DISTINCT c.key) AS cnt');
    result.configKeys = configRows?.[0]?.cnt ?? 0;

    // Active tasks
    const taskRows = await diagQuery("MATCH (t:Task) WHERE t.status IN ['pending', 'active'] RETURN count(*) AS cnt");
    result.activeTasks = taskRows?.[0]?.cnt ?? 0;

    // Total beliefs
    const beliefRows = await diagQuery('MATCH (b:Belief) RETURN count(*) AS cnt');
    result.beliefCount = beliefRows?.[0]?.cnt ?? 0;
  } catch (err: any) {
    console.warn('[diagnostics] Schema stats error:', err.message);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

/**
 * Recursively compute the total size of a directory in bytes.
 */
function getDirSize(dirPath: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else if (entry.isFile()) {
        try { total += fs.statSync(fullPath).size; } catch {}
      }
    }
  } catch {}
  return total;
}

/**
 * Format a byte count as a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

/**
 * Format the diagnostic report as a human-readable string.
 */
export function formatDiagReport(report: DiagReport): string {
  const lines: string[] = [];
  lines.push('╔══════════════════════════════════════╗');
  lines.push('║        Ailo System Diagnostics       ║');
  lines.push('╚══════════════════════════════════════╝');
  lines.push('');
  lines.push(`Timestamp:  ${report.timestamp}`);
  lines.push(`Host:       ${report.hostname}`);
  lines.push(`Uptime:     ${formatUptime(report.uptime)}`);
  lines.push('');

  // DB section
  lines.push('── Database ──────────────────────────');
  lines.push(`  Status:      ${report.db.available ? '✅ Connected' : '❌ Unavailable'}`);
  lines.push(`  File:        ${formatBytes(report.db.dbFileSize)}`);
  lines.push(`  Clean exit:  ${report.db.cleanShutdown ? '✅ Yes' : '⚠️  No (WAL may replay)'}`);
  lines.push(`  Total nodes: ${report.db.totalNodes}`);
  lines.push(`  Total edges: ${report.db.totalEdges}`);
  for (const [table, count] of Object.entries(report.db.nodeCounts)) {
    if (count > 0) lines.push(`    ${table}: ${count}`);
  }
  lines.push('');

  // Embedding
  lines.push('── Embedding ─────────────────────────');
  lines.push(`  Status:    ${report.embedding.status}`);
  lines.push(`  Model:     ${report.embedding.model}`);
  lines.push(`  Dims:      ${report.embedding.dimension}`);
  lines.push(`  GPU:       ${report.embedding.gpuEnabled ? '✅ ' + (report.embedding.gpuDevices[0] || 'enabled') : '❌ disabled'}`);
  lines.push('');

  // Web
  lines.push('── Web ───────────────────────────────');
  lines.push(`  SearXNG:   ${report.web.searxng}`);
  lines.push('');

  // Storage
  lines.push('── Storage ───────────────────────────');
  lines.push(`  WAL:       ${formatBytes(report.storage.walSize)}${report.storage.walNeedsCheckpoint ? ' ⚠️ needs checkpoint' : ''}`);
  lines.push(`  Backups:   ${report.storage.backupCount}`);
  lines.push(`  var/ dir:  ${formatBytes(report.storage.varDirSize)}`);
  lines.push('');

  // Schema
  lines.push('── Schema ────────────────────────────');
  lines.push(`  Tables:    ${report.schema.tables.length}`);
  lines.push(`  Beliefs:   ${report.schema.beliefCount}`);
  lines.push(`  Config:    ${report.schema.configKeys} keys`);
  lines.push(`  Tools:     ${report.schema.toolEntities} entities`);
  lines.push(`  Tasks:     ${report.schema.activeTasks} active`);

  return lines.join('\n');
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}