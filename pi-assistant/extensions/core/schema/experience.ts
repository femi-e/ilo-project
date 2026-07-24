// ============================================================================
// schema/experience.ts — Experience table definitions
// ============================================================================
// Action, Feedback — stores what the system experienced.
// Registers tables. Unused until Phase 3 (feedback) and Phase 4 (discovery).
// ============================================================================

import { registerTable } from './registry';

// ── Action — a tool call within a turn ───────────────────

registerTable('Action', {
  type: 'node',
  properties: {
    id: 'STRING',
    session_id: 'STRING',
    turn_id: 'STRING',
    tool_name: 'STRING',
    args: 'JSON',
    result: 'JSON',
    duration_ms: 'INT64',
    status: 'STRING',
    dedup_key: 'STRING',
    timestamp: 'TIMESTAMP',
  },
  primaryKey: 'id',
  // Zone maps handle non-PK dedup_key lookups automatically.
  // A secondary HASH index would be ideal, but LadybugDB's HASH extension
  // for secondary indexes is not available in this build, and the built-in
  // HASH INDEX syntax is limited to primary keys (one per table).
  indexes: [],
});

// ── NEXT — temporal ordering of actions within a session ─

registerTable('NEXT', {
  type: 'rel',
  from: 'Action',
  to: 'Action',
});

// ── Feedback — evaluation signal for a turn ──────────────

registerTable('Feedback', {
  type: 'node',
  properties: {
    id: 'STRING',
    session_id: 'STRING',
    turn_index: 'INT64',
    signal: 'STRING',        // correction, acceptance, continuation, error_retry, neutral
    target_id: 'STRING',     // which belief/entity/discovery this feedback targets
    delta: 'DOUBLE',         // confidence change applied
    source: 'STRING',        // input (keyword), input (semantic), input (hybrid)
    timestamp: 'TIMESTAMP',
  },
  primaryKey: 'id',
});