// ============================================================================
// schema/registry.ts — Idempotent DDL registration + application
// ============================================================================
// Modules call registerTable() at import time to declare their tables.
// applySchema() runs at every session_start and converges the database
// to match the registered definitions using:
//   CREATE TABLE IF NOT EXISTS (catch "already exists")
//   ALTER TABLE ADD COLUMN IF NOT EXISTS (catch "already exists")
//   CREATE INDEX IF NOT EXISTS (via SHOW_INDEXES check)
//
// No sentinel files. No version bumps. No data loss.
// ============================================================================

import type { DbLayer } from '../lib/db';

// ── Types ────────────────────────────────────────────────

export interface IndexDef {
  name: string;
  cypher: string;
}

export interface NodeTableDef {
  type: 'node';
  properties: Record<string, string>;
  primaryKey: string;
  indexes?: IndexDef[];
}

export interface RelTableDef {
  type: 'rel';
  from: string;
  to: string;
  properties?: Record<string, string>;
}

export type TableDef = NodeTableDef | RelTableDef;

// ── Registry state ───────────────────────────────────────

const registry: Record<string, TableDef> = {};

/** Register a table definition. Called at module import time. */
export function registerTable(name: string, def: TableDef): void {
  registry[name] = def;
}

/** Get all registered tables (for testing). */
export function getRegisteredTables(): Record<string, TableDef> {
  return { ...registry };
}

/** Reset the registry (for testing isolation). */
export function resetRegistry(): void {
  Object.keys(registry).forEach(k => delete registry[k]);
}

// ── Schema application ───────────────────────────────────

/**
 * Apply all registered table definitions to the database.
 * Runs at every session_start. Idempotent — safe to call repeatedly.
 */
export async function applySchema(db: DbLayer): Promise<void> {
  // ── Phase 1: Create all node tables first ──
  for (const [name, def] of Object.entries(registry)) {
    if (def.type === 'node') {
      await ensureNodeTable(db, name, def);
    }
  }

  // ── Phase 1b: Create all rel tables second (nodes must exist) ──
  for (const [name, def] of Object.entries(registry)) {
    if (def.type === 'rel') {
      await ensureRelTable(db, name, def);
    }
  }

  // ── Phase 2: Add columns to existing tables ──
  for (const [name, def] of Object.entries(registry)) {
    if (def.type === 'node') {
      await ensureNodeColumns(db, name, def);
    } else if (def.type === 'rel' && def.properties) {
      await ensureRelColumns(db, name, def);
    }
  }

  // ── Phase 3: Create indexes ──
  for (const [name, def] of Object.entries(registry)) {
    if (def.type === 'node' && def.indexes) {
      await ensureIndexes(db, name, def.indexes);
    }
  }
}

// ── Table creation ───────────────────────────────────────

async function ensureNodeTable(db: DbLayer, name: string, def: NodeTableDef): Promise<void> {
  const cols = Object.entries(def.properties)
    .map(([prop, type]) => `\`${prop}\` ${type}`)
    .join(', ');
  const sql = `CREATE NODE TABLE IF NOT EXISTS ${name} (${cols}, PRIMARY KEY (${def.primaryKey}))`;

  try {
    await db.exec(sql);
  } catch (err: any) {
    if (err.message?.includes('already exists') || err.message?.includes('already has table')) {
      return; // Table exists — columns will be handled in Phase 2
    }
    // Rethrow unexpected errors
    throw err;
  }
}

async function ensureRelTable(db: DbLayer, name: string, def: RelTableDef): Promise<void> {
  const propClause = def.properties
    ? ', ' + Object.entries(def.properties).map(([p, t]) => `\`${p}\` ${t}`).join(', ')
    : '';
  const sql = `CREATE REL TABLE IF NOT EXISTS ${name} (FROM ${def.from} TO ${def.to}${propClause})`;

  try {
    await db.exec(sql);
  } catch (err: any) {
    if (err.message?.includes('already exists') || err.message?.includes('already has table')) {
      return;
    }
    throw err;
  }
}

// ── Column addition ──────────────────────────────────────

async function ensureNodeColumns(db: DbLayer, name: string, def: NodeTableDef): Promise<void> {
  for (const [prop, type] of Object.entries(def.properties)) {
    try {
      await db.exec(`ALTER TABLE ${name} ADD \`${prop}\` ${type}`);
    } catch (err: any) {
      if (err.message?.includes('already exists') || err.message?.includes('already has property')) {
        continue; // Column exists — skip
      }
      throw err;
    }
  }
}

async function ensureRelColumns(db: DbLayer, name: string, def: RelTableDef): Promise<void> {
  for (const [prop, type] of Object.entries(def.properties || {})) {
    try {
      await db.exec(`ALTER TABLE ${name} ADD \`${prop}\` ${type}`);
    } catch (err: any) {
      if (err.message?.includes('already exists') || err.message?.includes('already has property')) {
        continue;
      }
      throw err;
    }
  }
}

// ── Index creation ───────────────────────────────────────

async function ensureIndexes(db: DbLayer, tableName: string, indexes: IndexDef[]): Promise<void> {
  // Get existing indexes for this table
  let existingIndexes: string[] = [];
  try {
    const rows = await db.query("CALL SHOW_INDEXES() RETURN *");
    existingIndexes = (rows || [])
      .filter((r: any) => r['table name'] === tableName || r.table_name === tableName)
      .map((r: any) => r['index name'] || r.index_name || '');
  } catch {
    // SHOW_INDEXES might not be available on first run — skip check
  }

  for (const ix of indexes) {
    if (existingIndexes.includes(ix.name)) continue;
    try {
      await db.exec(ix.cypher);
    } catch (err: any) {
      // Index creation can fail for many reasons (already exists, missing extension, etc.)
      // Log but don't crash — the system can function without some indexes
      console.warn(`[schema] Index ${ix.name} not created: ${err.message?.substring(0, 80)}`);
    }
  }
}