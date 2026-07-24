// ============================================================================
// schema/core.ts — Core table definitions
// ============================================================================
// Entity, Belief, Turn, Config — the tables needed for the system to function.
// Also registers core indexes: entity HNSW, belief HNSW + FTS, entity HASH.
// ============================================================================

import { registerTable } from './registry';
import { EMBEDDING_DIM } from '../lib/constants';

// ── Entity — a thing the user cares about ────────────────

registerTable('Entity', {
  type: 'node',
  properties: {
    id: 'STRING',
    name: 'STRING',
    type: 'STRING',            // project, tool, concept, person, technology, resource, course, behavior
    confidence: 'DOUBLE',      // 0.0-1.0, how sure we are this entity matters
    mention_count: 'INT64',    // how many times it's been mentioned
    momentum: 'DOUBLE',        // rising/falling trend (-1.0 to 1.0)
    aliases: 'STRING',          // comma-separated: "ladybug,ladybugdb"
    embedding: `FLOAT[${EMBEDDING_DIM}]`,
    url: 'STRING',             // source URL for ingested content (type:'resource')
    path: 'STRING',            // local file path for ingested content
    kind: 'STRING',            // web_page, file, course, code, text
    content_hash: 'STRING',      // SHA-256 of full source content (for dedup)
    course_id: 'STRING',        // course identifier e.g. "1027"
    module: 'INT64',            // course module number
    section: 'STRING',          // course section identifier e.g. "1.1"
    tags: 'STRING',            // comma-separated tags for categorization
    created_at: 'TIMESTAMP',
  },
  primaryKey: 'id',
  indexes: [
    {
      name: 'idx_entity_emb',
      cypher: `CALL CREATE_VECTOR_INDEX('Entity', 'idx_entity_emb', 'embedding', metric := 'cosine')`,
    },
  ],
});

// ── HAS_BELIEF — Entity has this belief ──────────────────

registerTable('HAS_BELIEF', {
  type: 'rel',
  from: 'Entity',
  to: 'Belief',
});

// ── MENTIONED_IN — Entity was discussed in this turn ─────

registerTable('MENTIONED_IN', {
  type: 'rel',
  from: 'Entity',
  to: 'Turn',
});

// ── HAS_TURN — Session contains this turn ────────────────

registerTable('HAS_TURN', {
  type: 'rel',
  from: 'Session',
  to: 'Turn',
});

// ── Belief — a fact about an entity ──────────────────────

registerTable('Belief', {
  type: 'node',
  properties: {
    id: 'STRING',
    content: 'STRING',         // the belief text
    confidence: 'DOUBLE',      // 0.0-1.0
    entity: 'STRING',          // which entity this belief is about
    provenance: 'STRING',      // user.confirmed, system.inferred, system.extracted, system.bootstrap
    embedding: `FLOAT[${EMBEDDING_DIM}]`,
    last_referenced: 'TIMESTAMP',
    content_hash: 'STRING',      // SHA-256 of chunk content (for dedup)
    source_section: 'STRING',   // heading label: "Solving Problems with Python"
    source_line_start: 'INT64', // line number in source file
    source_line_end: 'INT64',   // line number in source file
    created_at: 'TIMESTAMP',
  },
  primaryKey: 'id',
  indexes: [
    {
      name: 'idx_belief_emb',
      cypher: `CALL CREATE_VECTOR_INDEX('Belief', 'idx_belief_emb', 'embedding', metric := 'cosine')`,
    },
    {
      name: 'idx_belief_content',
      cypher: `CALL CREATE_FTS_INDEX('Belief', 'idx_belief_content', ['content'], stemmer := 'english')`,
    },
  ],
});

// ── SUPPORTS — Belief A reinforces Belief B ──────────────

registerTable('SUPPORTS', {
  type: 'rel',
  from: 'Belief',
  to: 'Belief',
  properties: {
    weight: 'DOUBLE',
    session_id: 'STRING',
  },
});

// ── CONTRADICTS — Belief A conflicts with Belief B ───────

registerTable('CONTRADICTS', {
  type: 'rel',
  from: 'Belief',
  to: 'Belief',
  properties: {
    weight: 'DOUBLE',
    session_id: 'STRING',
  },
});

// ── CONSOLIDATED_FROM — This belief was merged from another ─

registerTable('CONSOLIDATED_FROM', {
  type: 'rel',
  from: 'Belief',
  to: 'Belief',
});

// ── HAS_RESOURCE — Entity links to a source document entity ──

registerTable('HAS_RESOURCE', {
  type: 'rel',
  from: 'Entity',
  to: 'Entity',
});

// ── NEXT_IN_SEQUENCE — ordered relationship between sections/modules ──

registerTable('NEXT_IN_SEQUENCE', {
  type: 'rel',
  from: 'Entity',
  to: 'Entity',
  properties: {
    order: 'INT64',
  },
});

// ── DERIVED_FROM — belief provenance chain ──

registerTable('DERIVED_FROM', {
  type: 'rel',
  from: 'Belief',
  to: 'Belief',
  properties: {
    weight: 'DOUBLE',
    strategy: 'STRING',
  },
});

// ── HAS_SKILL — entity possesses this skill ──

registerTable('HAS_SKILL', {
  type: 'rel',
  from: 'Entity',
  to: 'Entity',
});

// ── REQUIRES_SKILL — entity requires this skill ──

registerTable('REQUIRES_SKILL', {
  type: 'rel',
  from: 'Entity',
  to: 'Entity',
});

// ── BELONGS_TO_COURSE — entity is part of this course ──

registerTable('BELONGS_TO_COURSE', {
  type: 'rel',
  from: 'Entity',
  to: 'Entity',
});

// ── BELONGS_TO_MODULE — entity is part of this module ──

registerTable('BELONGS_TO_MODULE', {
  type: 'rel',
  from: 'Entity',
  to: 'Entity',
});

// ── Turn — a single exchange in a conversation ──────────

registerTable('Turn', {
  type: 'node',
  properties: {
    id: 'STRING',
    session_id: 'STRING',
    turn_index: 'INT64',
    user_text: 'STRING',
    response_text: 'STRING',
    model: 'STRING',
    tokens_in: 'INT64',
    tokens_out: 'INT64',
    timestamp: 'TIMESTAMP',
  },
  primaryKey: 'id',
});

// ── Config — system parameters ──────────────────────────

registerTable('Config', {
  type: 'node',
  properties: {
    id: 'STRING',
    key: 'STRING',
    value: 'STRING',           // JSON-encoded value
    version: 'INT64',
    scope: 'STRING',           // core, adaptive, discovery
    mutable: 'STRING',         // fixed, flexible
    updated_at: 'TIMESTAMP',
  },
  primaryKey: 'id',
});