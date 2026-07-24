// ============================================================================
// schema/discovery.ts — Discovery table definitions
// ============================================================================
// Discovery, Pattern — stores pending findings and confirmed workflows.
// Registers tables. Unused until Phase 4.
// ============================================================================

import { registerTable } from './registry';

// ── Discovery — a pending finding that needs user validation ─

registerTable('Discovery', {
  type: 'node',
  properties: {
    id: 'STRING',
    type: 'STRING',            // entity, pattern, gap, trend, contradiction
    content: 'STRING',         // human-readable description
    structured: 'JSON',        // machine-readable data
    confidence: 'DOUBLE',      // 0.0-1.0, starts low
    needs_review: 'BOOLEAN',
    discovered_at: 'TIMESTAMP',
    resolved_at: 'TIMESTAMP',
    outcome: 'STRING',         // accepted, rejected, corrected, expired
    session_id: 'STRING',
  },
  primaryKey: 'id',
});

// ── Pattern — a confirmed workflow ──────────────────────

registerTable('Pattern', {
  type: 'node',
  properties: {
    id: 'STRING',
    trigger: 'STRING',         // what user says before the sequence
    sequence: 'JSON',          // array of tool names
    frequency: 'INT64',        // how many times observed
    confidence: 'DOUBLE',
    success_rate: 'DOUBLE',    // how often the pattern leads to acceptance
    created_at: 'TIMESTAMP',
  },
  primaryKey: 'id',
});

// ── HAS_PATTERN — Entity has this workflow pattern ───────

registerTable('HAS_PATTERN', {
  type: 'rel',
  from: 'Entity',
  to: 'Pattern',
});

// ── TRIGGERED — This pattern predicts this action ────────

registerTable('TRIGGERED', {
  type: 'rel',
  from: 'Pattern',
  to: 'Action',
});