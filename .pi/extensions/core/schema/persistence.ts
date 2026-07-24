// ============================================================================
// schema/persistence.ts — Persistence table definitions
// ============================================================================
// Session, Summary, Task — stores cross-session data.
// Resource was removed in Phase 2a (replaced by Entity {type:'resource'}).
// ============================================================================

import { registerTable } from './registry';

// ── Session — a conversation session ─────────────────────

registerTable('Session', {
  type: 'node',
  properties: {
    id: 'STRING',
    display_name: 'STRING',
    turn_count: 'INT64',
    model: 'STRING',
    agent_version: 'STRING',
    created_at: 'TIMESTAMP',
    ended_at: 'TIMESTAMP',
  },
  primaryKey: 'id',
});

// ── Summary — a compacted session summary ────────────────

registerTable('Summary', {
  type: 'node',
  properties: {
    id: 'STRING',
    session_id: 'STRING',
    content: 'STRING',         // structured summary text
    token_count: 'INT64',       // how many tokens the summary consumes
    entity_refs: 'JSON',        // list of entity names referenced
    key_beliefs: 'JSON',        // list of belief IDs formed during this period
    pattern_refs: 'JSON',       // list of pattern IDs triggered
    created_at: 'TIMESTAMP',
  },
  primaryKey: 'id',
});

// ── Task — a tracked work item (plan, goal, subtask) ────

registerTable('Task', {
  type: 'node',
  properties: {
    id: 'STRING',
    title: 'STRING',
    description: 'STRING',
    priority: 'STRING',         // critical, high, medium, low
    status: 'STRING',           // pending, active, completed, cancelled
    deadline: 'DATE',
    project: 'STRING',          // project/group label
    criteria: 'STRING',         // definition of done
    parent_id: 'STRING',        // task_id of parent (for subtask hierarchy)
    goal: 'STRING',             // what outcome this task serves
    created_at: 'TIMESTAMP',
    completed_at: 'TIMESTAMP',  // when it was marked done
  },
  primaryKey: 'id',
});