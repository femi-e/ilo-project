-- ============================================================================
-- ILO Cognitive Runtime — LadybugDB Schema Definition
-- ============================================================================
-- Three tables: Node, Prop, LINK
--
-- This file is the canonical schema declaration. Run it against a LadybugDB
-- instance to create the database. Idempotent: safe to run on existing DB.
--
-- Usage:
--   node apply-schema.mjs /path/to/db.lbug schema/schema.sql
-- ============================================================================

-- ── Extensions ──────────────────────────────────────────
-- Extensions must be INSTALLED once, then LOADED.
-- In :memory: databases, INSTALL may fail silently.
-- Extensions are loaded on every connection.

LOAD EXTENSION JSON;     -- JSON column type for val_json
LOAD EXTENSION VECTOR;   -- HNSW vector index for Node.embedding
LOAD EXTENSION FTS;      -- Full-text search for Node.label

-- ════════════════════════════════════════════════════════════════════════
-- TABLE: Node
-- ════════════════════════════════════════════════════════════════════════
-- Every entity in the graph. Four types: entity, claim, turn, view.
--
-- Column design rationale:
--   id         — UUIDv7 (time-sortable). Generated in Rust Store layer.
--                Lexicographic sort = chronological order.
--
--   type       — Discriminator. Filtered in >90% of queries.
--                Hash-indexed for O(1) type lookups.
--
--   tags       — STRING[] for semantic labels. Consolidation merges similar
--                tags across nodes. Use list_has(n.tags, 'person') to filter.
--                Formerly called "kind", renamed because it's inherently
--                a multi-valued label that gets merged, not a single category.
--
--   label      — Universal display text. FTS-indexed for search.
--                entity: canonical name     ("Alice", "LadybugDB")
--                claim:  claim content      ("LadybugDB is a graph database")
--                turn:   "Turn #N (session)"
--                view:   view name          ("code-review")
--
--   embedding  — FLOAT[768] for vector similarity search.
--                HNSW-indexed. Nullable.
--                LadybugDB only supports vector indexes on node table
--                properties — this CANNOT be stored in Prop.
--
--   confidence — DOUBLE 0.0-1.0. Filtered in EVERY context injection query.
--                Promoted to typed column because:
--                (a) It's filtered: WHERE n.confidence > 0.8
--                (b) It's universal across all 4 types
--                (c) Avoids edge traversal + CAST for the most common filter
--
--   created_at — When the node was created.
--                Filtered: WHERE n.created_at > $date
--                Consolidation uses this for staleness checks.
--
--   updated_at — When last modified. Consolidation uses this.
--
-- What's NOT here (stored in Prop):
--   status, provenance, session_id, model, turn_index,
--   content, aliases, role, version, url, mention_count,
--   purpose, compiler_level, entity_filter, claim_filter

CREATE NODE TABLE IF NOT EXISTS Node (
  id         STRING PRIMARY KEY,        -- UUIDv7 from Rust Store layer
  type       STRING,                    -- 'entity' | 'claim' | 'turn' | 'view'
  tags       STRING[],                  -- Semantic labels for consolidation
  label      STRING,                    -- Display text (FTS-indexed)
  embedding  FLOAT[768],               -- Vector for similarity search (nullable)
  confidence DOUBLE DEFAULT 0.0,        -- Universal filter (0.0-1.0)
  created_at TIMESTAMP DEFAULT current_timestamp(),
  updated_at TIMESTAMP DEFAULT current_timestamp()
);

-- Indexes for Node
-- Hash index on type: O(1) lookup by node type
CALL CREATE_HASH_INDEX('Node', 'idx_node_type', 'type');

-- HNSW vector index: semantic similarity search on embedding
CALL CREATE_VECTOR_INDEX('Node', 'idx_node_emb', 'embedding', metric := 'cosine');

-- FTS inverted index: full-text search on label
CALL CREATE_FTS_INDEX('Node', 'idx_node_label', 'label');

-- ════════════════════════════════════════════════════════════════════════
-- TABLE: Prop
-- ════════════════════════════════════════════════════════════════════════
-- EAV (Entity-Attribute-Value) properties for both Node and Link owners.
-- Every type-specific or instance-specific value goes here.
--
-- This is the most important table for the cognitive runtime's self-knowledge.
-- The PropertyProfile query runs against Prop:
--
--   MATCH (n:Node), (p:Prop)
--   WHERE n.id = p.owner_id
--   WITH n.type AS type, p.key AS key, COUNT(*) AS freq
--   RETURN type, key, freq ORDER BY type, freq DESC
--
-- This tells the runtime: "92% of entities have a 'status' property.
-- This entity doesn't — prompt the user for it."
--
-- Column design rationale:
--
--   id         — PRIMARY KEY. NOT a UUID. Uses the inherent ID pattern:
--                Prop.id = "{owner_id}::{key}"
--                This is the KEY design decision that prevents duplicate
--                (owner_id, key) pairs at the database level, without
--                requiring a composite primary key (which LadybugDB
--                doesn't support) or a unique constraint.
--
--                Example: "e_alice::confidence" = the confidence property
--                of node e_alice.
--
--                If code tries to create a second Prop with the same
--                (owner_id, key), the PK collision naturally rejects it.
--                The Store layer then does an UPDATE instead.
--
--   owner_id   — Foreign key referencing Node.id or Link.id.
--                Denormalized on Prop for fast PropertyProfile GROUP BY
--                without traversing a graph edge.
--
--   owner_kind — 'node' or 'link'.
--                Distinguishes which table owner_id references.
--                Links can also have properties (evidence confidence,
--                context relevance, etc.)
--
--   key        — Property name. Convention: snake_case.
--                Examples: 'confidence', 'session_id', 'user_text',
--                'aliases', 'mention_count', 'purpose'
--
--   kind       — Parse hint for the Store layer.
--                'string' | 'float' | 'int' | 'bool' | 'json' | 'date'
--                Stored inline so the consumer knows how to deserialize
--                without a schema lookup.
--
--   val_str    — STRING values. Non-null when kind='string'.
--   val_float  — DOUBLE values. Non-null when kind='float'.
--   val_int    — INT64 values. Non-null when kind='int'.
--   val_bool   — BOOLEAN values. Non-null when kind='bool'.
--   val_json   — JSON values. Non-null when kind='json'.
--
--                Exactly ONE of the val_* columns is non-null per row.
--                LadybugDB stores nulls as 1 bit per column per row in
--                columnar storage, so the overhead is negligible.
--
--                Why not UNION type? LadybugDB UNION was tested:
--                ✅ Can CREATE with UNION column
--                ✅ Can INSERT (auto-tags by value type)
--                ✅ Can read back as {"tag": value}
--                ❌ CANNOT extract members: u.val.s → Binder exception
--                ❌ CANNOT filter: WHERE u.val.f > 0.8 → Binder exception
--                ❌ CANNOT index: CREATE_HASH_INDEX fails
--                Multi-typed columns are strictly more queryable.
--
--                Why not a single STRING value with CAST?
--                CAST overhead on every comparison: CAST(p.value AS FLOAT)
--                vs direct column access: p.val_float > 0.8
--                The typed column is native columnar storage — no parsing.
--
--   created_at — When the property was created.
--   updated_at — When the property was last updated.
--                Used for property-level staleness tracking.

CREATE NODE TABLE IF NOT EXISTS Prop (
  id         STRING PRIMARY KEY,        -- "{owner_id}::{key}" (inherent PK)
  owner_id   STRING,                    -- FK to Node.id or Link.id
  owner_kind STRING,                    -- 'node' | 'link'
  key        STRING,                    -- Property name (snake_case)
  kind       STRING,                    -- Parse hint: 'string'|'float'|'int'|'bool'|'json'|'date'

  -- Typed value columns (exactly one non-null per row)
  val_str    STRING,                    -- String values
  val_float  DOUBLE,                    -- Float values (no CAST needed for filtering)
  val_int    INT64,                     -- Integer values
  val_bool   BOOLEAN,                   -- Boolean values
  val_json   JSON,                      -- Complex/nested structures
                                       -- Note: LadybugDB does NOT support
                                       -- JSON path extraction (->>).
                                       -- CAST to STRING + CONTAINS works
                                       -- but is unreliable. Parse in app.

  created_at TIMESTAMP DEFAULT current_timestamp(),
  updated_at TIMESTAMP DEFAULT current_timestamp()
);

-- Indexes for Prop
-- owner_id + key: the primary lookup pattern
-- "Get all props for node X"
-- "Find property Y for node X"
CALL CREATE_HASH_INDEX('Prop', 'idx_prop_owner', 'owner_id');
CALL CREATE_HASH_INDEX('Prop', 'idx_prop_key', 'key');
CALL CREATE_HASH_INDEX('Prop', 'idx_prop_owner_key', 'owner_id,key');

-- ════════════════════════════════════════════════════════════════════════
-- TABLE: LINK
-- ════════════════════════════════════════════════════════════════════════
-- Relationships between Nodes. 8 types: 5 atomic + 3 compound.
-- All share one rel table. The `type` column discriminates.
--
-- Directionality note: LINK is always directed (from → to).
-- But semantically bidirectional types use undirected Cypher syntax:
--   MATCH (a)-[l:LINK {type:'con'}]-(b)  ← matches both directions
--
-- Column design rationale:
--
--   id         — UUIDv7. Unique identifier for the relationship.
--                Enables precise deletion and Property lookups.
--
--   type       — One of 8 values. Hash-indexed.
--                'has' | 'ref' | 'dep' | 'con' | 'seq' |
--                'evidence' | 'context' | 'refute'
--
--   tags       — STRING[] semantic qualifiers for consolidation.
--                has:  ['contains','belongs-to','owns']
--                ref:  ['cites','mentions','associates']
--                dep:  ['enables','blocks','derives']
--                con:  ['contradicts','conflicts-with']
--                seq:  ['follows','precedes','supersedes']
--                Consolidation merges similar tag arrays.
--
--   weight     — DOUBLE (0.0-1.0). Relationship strength.
--                Promoted to typed column because it's filtered in
--                WHERE clauses across multiple link types.
--                Type-specific link properties (order, resolved, 
--                provenance, layer, head) go in Prop with
--                owner_kind='link'.
--
--   created_at — Temporal tracking for consolidation.

CREATE REL TABLE IF NOT EXISTS LINK (
  FROM Node TO Node,

  id         STRING PRIMARY KEY,        -- UUIDv7
  type       STRING,                    -- 'has'|'ref'|'dep'|'con'|'seq'
                                       -- |'evidence'|'context'|'refute'
  tags       STRING[],                  -- Semantic qualifiers for consolidation
  weight     DOUBLE DEFAULT 0.0,        -- Relationship strength (0.0-1.0)
  created_at TIMESTAMP DEFAULT current_timestamp()
);

-- Hash index on type for fast relationship type filtering
CALL CREATE_HASH_INDEX('LINK', 'idx_link_type', 'type');

-- ════════════════════════════════════════════════════════════════════════
-- PROPERTY INVENTORY
-- ════════════════════════════════════════════════════════════════════════
-- These are NOT table columns. They are the key/value pairs stored in Prop
-- at runtime. Listed here for documentation and for the PropertyProfile's
-- expected prevalence analysis, which the Store layer uses to determine
-- what properties each node type typically has.

-- ── Entity properties ──────────────────────────────────────────────────
--
-- Key                  | Kind    | Prevalence | Description
-- ─────────────────────┼─────────┼────────────┼──────────────────────────
-- confidence           | float   | 100%       | 0.0-1.0, how sure we are about this entity
-- status               | string  | 92%        | active|inactive|archived|pending
-- aliases              | string  | 83%        | Comma-separated alternative names
-- mention_count        | int     | 95%        | How many times the entity has been mentioned
-- role                 | string  | 60%        | developer|designer|manager|contributor
-- version              | string  | 45%        | Version string (for tools/libraries)
-- url                  | string  | 40%        | External reference URL
-- content_hash         | string  | 35%        | SHA-256 hash for content deduplication
-- email                | string  | 25%        | Contact email
-- location             | string  | 20%        | Geographic location
-- signature            | string  | 15%        | Function/method signature
-- path                 | string  | 10%        | File system path
-- source_section       | string  | 30%        | Heading/section label for course material
-- source_line_start    | int     | 25%        | Starting line number in source file
-- source_line_end      | int     | 25%        | Ending line number in source file

-- ── Claim properties ───────────────────────────────────────────────────
--
-- Key                  | Kind    | Prevalence | Description
-- ─────────────────────┼─────────┼────────────┼──────────────────────────
-- content              | string  | 100%       | The claim text (stored in full)
-- confidence           | float   | 100%       | 0.0-1.0 confidence in the claim
-- provenance           | string  | 100%       | user.confirmed|system.inferred|
--                      |         |            | system.extracted|system.bootstrap
-- last_referenced      | date    | 100%       | When the claim was last referenced
-- type_sub             | string  | 80%        | fact|preference|observation|
--                      |         |            | gap|rule|inference|correction

-- ── Turn properties ────────────────────────────────────────────────────
--
-- Key                  | Kind    | Prevalence | Description
-- ─────────────────────┼─────────┼────────────┼──────────────────────────
-- session_id           | string  | 100%       | Session identifier
-- turn_index           | int     | 100%       | Position in the session (0-indexed)
-- user_text            | string  | 100%       | The user's message text
-- response_text        | string  | 100%       | The assistant's response text
-- model                | string  | 100%       | Which LLM generated the response
-- tokens_in            | int     | 100%       | Number of prompt tokens
-- tokens_out           | int     | 100%       | Number of generated tokens
-- duration_ms          | int     | 90%        | Generation time in milliseconds

-- ── View properties ────────────────────────────────────────────────────
--
-- Key                  | Kind    | Prevalence | Description
-- ─────────────────────┼─────────┼────────────┼──────────────────────────
-- purpose              | string  | 100%       | What this view is for
-- compiler_level       | string  | 100%       | Injection points: B|C|G|BlockOut
-- entity_filter        | json    | 80%        | Filter criteria for entities
-- claim_filter         | json    | 80%        | Filter criteria for claims
-- time_window          | string  | 80%        | Lookback window: '1h'|'1d'|'7d'|'30d'

-- ── Link properties (owner_kind = 'link') ──────────────────────────────
--
-- Link type   | Key         | Kind    | Description
-- ────────────┼─────────────┼─────────┼──────────────────────────────────
-- has         | order       | int     | Position in a sequence
-- ref         | kind        | string  | cites|mentions|associates
-- ref         | context     | string  | Surrounding text or reason for the reference
-- dep         | kind        | string  | enables|blocking|derives
-- con         | resolved    | bool    | Whether the conflict has been resolved
-- seq         | kind        | string  | follow_up|supersedes
-- seq         | gap         | int     | Temporal gap between events
-- evidence    | confidence  | float   | How much the source supports the claim
-- evidence    | provenance  | string  | How the evidence was established
-- evidence    | layer       | int     | Which transformer
-- evidence    | layer       | int     | Which transformer layer captured this
-- evidence    | head        | int     | Which attention head captured this
-- context     | turn_index  | int     | Which turn the reference occurred in
-- context     | relevance   | float   | Relevance score (0.0-1.0)
-- refute      | resolved    | bool    | Whether the refutation has been resolved

-- ════════════════════════════════════════════════════════════════════════
-- APPENDIX: LadybugDB Limitations Discovered During Testing
-- ════════════════════════════════════════════════════════════════════════
-- These were verified against LadybugDB v0.17.1 and informed the schema
-- design decisions above.

-- 1. Composite Primary Keys: NOT SUPPORTED
--    CREATE NODE TABLE T (a STRING, b STRING, PRIMARY KEY (a, b))
--    → Parser exception: extraneous input ',' expecting {')', SP'}
--    Solution: Use inherent ID: T.id = a + "::" + b as single STRING PK

-- 2. UNION Type: STORAGE ONLY, NOT QUERYABLE
--    CREATE NODE TABLE T (val UNION(s STRING, f DOUBLE))
--    → Can INSERT: val: 3.14 (auto-tagged as DOUBLE)
--    → Can READ: returns {"tag": 3.14}
--    → Cannot FILTER: WHERE val.f > 0.8 → Binder exception
--    → Cannot EXTRACT: val.s → Binder exception
--    Solution: Use multi-typed columns (val_str, val_float, val_int, etc.)

-- 3. JSON Path Extraction (->>): NOT SUPPORTED
--    WHERE n.metadata->>'key' = 'value'
--    → Parser exception
--    Solution: CAST(val_json AS STRING) CONTAINS 'text' (unreliable)
--    Best practice: Parse JSON in the application (Store) layer.

-- 4. Variable-Length Traversal: MAX = 30
--    MATCH (a)-[l:LINK*1..50]->(b)
--    → Binder exception: "Upper bound of rel l exceeds maximum: 30"
--    Solution: Store layer limits traversal depth to 30.
--    For longer paths, use iterative approach (multiple queries).

-- 5. DETACH DELETE Cascade: DOES NOT INCLUDE PROPS
--    MATCH (n:Node {id:$id}) DETACH DELETE n
--    → Deletes Node and incident LINKs
--    → Does NOT delete Prop nodes (they survive as orphans)
--    Solution: Store layer cascades explicitly:
--      MATCH (p:Prop) WHERE p.owner_id = $id DELETE p
--      MATCH (n:Node {id:$id}) DETACH DELETE n

-- 6. Hash Index Availability: EXTENSION-DEPENDENT
--    CALL CREATE_HASH_INDEX('T', 'ix', 'col')
--    → Requires VECTOR extension to be INSTALLED and LOADED
--    → Fails silently in :memory: databases
--    Solution: Call LOAD EXTENSION VECTOR before creating indexes.
--    On persistent databases, run schema.sql which includes LOAD.

-- 7. FTS Index on JSON/UNION Columns: NOT SUPPORTED
--    Indexes only work on STRING columns (or STRING[] for hash indexes)
--    Cannot create FTS index on val_json or on UNION columns
--    Solution: FTS index on Node.label only.
--    For claim content search, store truncated content in label
--    and full content in Prop with kind='string'.

-- 8. No FK Enforcement
--    Prop.owner_id can reference a non-existent Node or Link
--    No CASCADE DELETE from Node to Prop
--    Solution: Store layer handles referential integrity manually.
--    This is by design — keeps the database simpler and faster.
-- ============================================================================
