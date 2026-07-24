// ============================================================================
// lib/db.ts — Single-connection database layer with write queue
// ============================================================================
// Owns one LadybugDB Connection. Provides exec/query/addNode/addEdge
// with unified retry, write serialization, and prepared statement cleanup.
//
// Design:
//   - ONE Connection — simplifies state management
//   - Write queue (Promise chain) — serializes writes to prevent Error 33
//   - Reads pass through immediately (not queued)
//   - 3 retry attempts for writes, 2 for reads, with backoff on contention
//   - Connection lifecycle (open/close/reconnect/destroy) managed here
//   - Persistent handle on globalThis survives Pi /reload
// ============================================================================

import { Database, Connection, QueryResult } from '@ladybugdb/core';
import * as crypto from 'node:crypto';
import { isConnDead } from './errors';

// ── JSON column types — these need CAST in Cypher ────────

const JSON_COLS = new Set(['payload', 'extra', 'args', 'result', 'structured', 'value']);

// ── Persistent handle key (survives Pi /reload) ──────────

const PERSISTENT_KEY = '__ailo_persistent_db__';

interface PersistentHandle {
  db: Database | null;
  conn: Connection | null;
}

function getPersistent(): PersistentHandle | null {
  return (globalThis as any)[PERSISTENT_KEY] ?? null;
}

function setPersistent(h: PersistentHandle): void {
  (globalThis as any)[PERSISTENT_KEY] = h;
}

// ═══════════════════════════════════════════════════════════
// DbLayer
// ═══════════════════════════════════════════════════════════

export class DbLayer {
  private db: Database | null = null;
  private conn: Connection | null = null;
  private dbPath: string;
  private ready = false;
  private closing = false;

  // ── Write queue — serializes writes via Promise chain ──
  private writeQueue: Promise<void> = Promise.resolve();
  private consecutiveWriteFailures = 0;
  private readonly MAX_CONSECUTIVE_FAILURES = 3;
  private writeCount = 0;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // Try to reuse persistent handle (survives reload)
    const existing = getPersistent();
    if (existing?.db && existing?.conn) {
      this.db = existing.db;
      this.conn = existing.conn;
      this.ready = true;
    }
  }

  // ── Public status ─────────────────────────────────────

  public isAvailable(): boolean {
    return this.ready && !this.closing;
  }

  // ── Lifecycle ─────────────────────────────────────────

  public async open(): Promise<boolean> {
    if (this.db && this.conn) {
      this.ready = true;
      return true;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      let dbHandle: Database | null = null;
      let connHandle: Connection | null = null;
      try {
        // Always use throwOnWalReplayFailure=false so WAL issues don't
        // block DB opening. LadybugDB replays what it can and skips
        // problematic entries. We checkpoint afterwards to flush the WAL.
        dbHandle = new Database(
          this.dbPath,               // path
          268435456,                 // bufferPoolSize (256MB)
          undefined,                 // enableCompression (default true)
          false,                     // readOnly
          undefined,                 // maxDBSize
          true,                      // autoCheckpoint
          5 * 1024 * 1024,           // checkpointThreshold (5MB)
          false,                     // throwOnWalReplayFailure — graceful
          true,                      // enableChecksums
          true                       // enableDefaultHashIndex
        );
        connHandle = new Connection(dbHandle);

        // Eagerly init the connection so WAL replay issues surface here
        // (inside the retry loop) rather than on the first query.
        await connHandle.init();

        // Checkpoint to flush any partially-replayed WAL entries
        try {
          await connHandle.query('CHECKPOINT');
        } catch {
          // Best-effort — the DB is open and functional
        }

        this.db = dbHandle;
        this.conn = connHandle;
        setPersistent({ db: this.db, conn: this.conn });
        this.ready = true;
        this.consecutiveWriteFailures = 0;
        return true;
      } catch (err: any) {
        const msg = err.message || '';
        const isLock = msg.includes('lock') || msg.includes('33');
        if (attempt < 3 && isLock) {
          await this.sleep(attempt * 200);
          continue;
        }
        console.warn(`[db] Open attempt ${attempt}: ${msg}`);
        // Clean up handles on failure
        if (connHandle) { try { connHandle.closeSync(); } catch {} }
        if (dbHandle) { try { dbHandle.closeSync(); } catch {} }
        this.db = null;
        this.conn = null;
      }
    }
    this.ready = false;
    return false;
  }

  public async reconnect(): Promise<boolean> {
    if (this.closing) return false;
    try {
      try { this.conn?.closeSync(); } catch {}
      this.conn = new Connection(this.db!);
      setPersistent({ db: this.db, conn: this.conn });
      this.ready = true;
      this.consecutiveWriteFailures = 0;
      return true;
    } catch {
      this.ready = false;
      return this.open();
    }
  }

  public close(): void {
    this.closing = true;
    this.ready = false;
    try { this.conn?.closeSync(); } catch {}
    try { this.db?.closeSync(); } catch {}
    this.conn = null;
    this.db = null;
    setPersistent({ db: null, conn: null });
  }

  /**
   * Checkpoint the database to flush the WAL.
   * Best-effort — failures are swallowed.
   */
  public async checkpoint(): Promise<void> {
    try {
      await this.exec('CHECKPOINT');
    } catch {
      // Best-effort
    }
  }

  public destroy(): void {
    this.close();
  }

  // ── Writes (serialized through the queue) ─────────────

  public async exec(sql: string, params?: Record<string, any>): Promise<void> {
    if (!this.conn || this.closing) throw new Error('[db] Not connected');

    // Wrap in the write queue to prevent concurrent writes
    const writeOp = async () => {
      await this.execInternal(sql, params);
      this.consecutiveWriteFailures = 0;
    };

    const errorOp = async (err: any) => {
      this.consecutiveWriteFailures++;
      if (this.consecutiveWriteFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[db] ${this.consecutiveWriteFailures} consecutive write failures, reconnecting...`);
        try { await this.reconnect(); } catch {}
      }
      throw err;
    };

    return new Promise<void>((resolve, reject) => {
      this.writeQueue = this.writeQueue
        .then(writeOp, errorOp)
        .then(() => {
          resolve();
          this.trackWrite();
        })
        .catch((err) => reject(err));
    });
  }

  /**
   * Track writes and trigger checkpoint when threshold is crossed.
   * Fire-and-forget — never blocks the caller.
   */
  private trackWrite(): void {
    this.writeCount++;
    if (this.writeCount % 50 !== 0) return; // Check every 50 writes
    this.maybeCheckpoint(); // fire-and-forget
  }

  /**
   * If WAL exceeds ~2MB, run CHECKPOINT to flush it.
   * Best-effort — failures are swallowed.
   */
  private async maybeCheckpoint(): Promise<void> {
    if (!this.conn || this.closing) return;
    try {
      const { statSync, existsSync } = await import('node:fs');
      const walPath = this.dbPath + '.wal';
      if (!existsSync(walPath)) return;
      if (statSync(walPath).size < 2 * 1024 * 1024) return; // < 2MB, skip
      await this.execInternal('CHECKPOINT', {});
    } catch { /* best-effort */ }
  }

  private async execInternal(sql: string, params?: Record<string, any>): Promise<void> {
    if (!this.conn) throw new Error('[db] Not connected');
    
    await this.withRetry(3, async (attempt) => {
      if (params && Object.keys(params).length > 0) {
        const stmt = await this.conn!.prepare(sql);
        const r = await this.conn!.execute(stmt, params);
        cleanupStatement(r);
        cleanupStmt(stmt);
      } else {
        const r = await this.conn!.query(sql) as unknown as QueryResult;
        try { r?.close(); } catch {}
      }
    }, { allowReconnect: true, allowReloadExts: true });
  }

  // ── Reads (no queue — pass through immediately) ───────

  public async query(cypher: string, params?: Record<string, any>): Promise<any[]> {
    if (!this.conn || this.closing) throw new Error('[db] Not connected');
    
    const rows = await this.withRetry(2, async () => {
      if (params && Object.keys(params).length > 0) {
        const stmt = await this.conn!.prepare(cypher);
        const r = await this.conn!.execute(stmt, params);
        const result = collectRows(r);
        cleanupStmt(stmt);
        return result;
      }
      const result = await this.conn!.query(cypher) as unknown as QueryResult;
      const resultRows = collectRows(result);
      try { result?.close(); } catch {}
      return resultRows;
    }, { allowReconnect: true });
    
    return rows;
  }

  // ── Convenience methods ──────────────────────────────

  public async addNode(label: string, props: Record<string, any>): Promise<string> {
    if (!props.id) props.id = crypto.randomUUID();
    const { cols, params } = buildColumns(props);
    await this.exec(`CREATE (:${label} {${cols.join(', ')}})`, params);
    return props.id;
  }

  public async addEdge(
    fromLabel: string, fromProp: string, fromVal: string,
    toLabel: string, toProp: string, toVal: string,
    relType: string, relProps: Record<string, any> = {}
  ): Promise<void> {
    const rp: string[] = [];
    const params: Record<string, any> = { fromVal, toVal };
    
    for (const [k, v] of Object.entries(relProps)) {
      if (v === null || v === undefined) continue;
      if (JSON_COLS.has(k)) {
        rp.push(`\`${k}\`: CAST($${k} AS JSON)`);
        params[k] = typeof v === 'string' ? v : JSON.stringify(v);
      } else {
        rp.push(`\`${k}\`: $${k}`);
        params[k] = v;
      }
    }
    
    const rpStr = rp.length > 0 ? ` {${rp.join(', ')}}` : '';
    await this.exec(
      `MATCH (a:${fromLabel} {\`${fromProp}\`: $fromVal}) MATCH (b:${toLabel} {\`${toProp}\`: $toVal}) CREATE (a)-[:${relType}${rpStr}]->(b)`,
      params
    );
  }

  /**
   * Install and load required extensions.
   * LadybugDB 0.17+ requires INSTALL before LOAD EXTENSION.
   * Best-effort: the system can partially function without some extensions.
   */
  public async loadExts(): Promise<void> {
    if (!this.conn) return;
    for (const ext of ['VECTOR', 'FTS']) {
      try {
        // LadybugDB 0.17+ requires INSTALL before LOAD EXTENSION
        await this.conn.query(`INSTALL ${ext}`);
        await this.conn.query(`LOAD EXTENSION ${ext}`);
      } catch (err: any) {
        const msg = err?.message || '';
        // Already installed is fine, unknown extension is fine to skip
        if (msg.includes('already installed') || msg.includes('not an official extension')) continue;
        console.warn(`[db] Extension ${ext} not available: ${msg.substring(0, 100)}`);
      }
    }
  }

  // ── Unified retry helper ───────────────────────────

  /**
   * Execute an operation with retry on transient errors.
   * Handles connection death, write contention, and missing extensions.
   */
  private async withRetry<T>(
    maxAttempts: number,
    fn: (attempt: number) => Promise<T>,
    opts: { allowReconnect?: boolean; allowReloadExts?: boolean } = {}
  ): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (err: any) {
        const isContention = (err?.message || '').includes('Cannot start a new write transaction');
        const isExt = opts.allowReloadExts && (
          (err?.message || '').includes('extension is not loaded') ||
          (err?.message || '').includes('has not been installed')
        );
        const canRetry = attempt < maxAttempts - 1;

        if (canRetry && (isConnDead(err) || isContention || isExt)) {
          const delay = isContention ? (attempt + 1) * 100 : 200;
          await this.sleep(delay);
          if (isExt) {
            await this.loadExts();
            // Give the extension a moment to settle
            await this.sleep(50);
          }
          else if (opts.allowReconnect && !isContention) await this.reconnect();
          continue;
        }
        throw err;
      }
    }
    throw new Error('[db] Operation failed after ' + maxAttempts + ' attempts');
  }

  // ── Utility ──────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

function buildColumns(props: Record<string, any>) {
  const cols: string[] = [];
  const params: Record<string, any> = {};
  
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (k === 'id') {
      cols.unshift(`\`id\`: $id`);
      params.id = v;
      continue;
    }
    if (JSON_COLS.has(k)) {
      cols.push(`\`${k}\`: CAST($${k} AS JSON)`);
      params[k] = typeof v === 'string' ? v : JSON.stringify(v);
    } else {
      cols.push(`\`${k}\`: $${k}`);
      params[k] = v;
    }
  }
  
  return { cols, params };
}

function collectRows(result: any): any[] {
  const rows: any[] = [];
  const qr = result as QueryResult;
  if (qr && typeof qr.hasNext === 'function') {
    while (qr.hasNext()) {
      rows.push(qr.getNextSync());
    }
  }
  return rows;
}

function cleanupStatement(result: any): void {
  try { (result as QueryResult)?.close(); } catch {}
}

function cleanupStmt(stmt: any): void {
  if (stmt) {
    (stmt as any)._preparedStatement = null;
    (stmt as any)._connection = null;
  }
}