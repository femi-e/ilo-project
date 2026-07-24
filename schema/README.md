# ILO Cognitive Runtime — Database Schema

## Overview

ILO is a cognitive runtime: a deterministic layer that wraps an LLM to provide persistent memory, identity, and runtime learning across sessions. It uses a 3-table graph schema on LadybugDB that translates graph state to/from LLM internals via a bidirectional compiler.

```
Node  ──LINK──→  Node    (graph relationships between entities)
  │
  └── (owner_id foreign key, NOT a graph edge)
       │
       Prop              (EAV properties for Nodes and Links)
```

### The Three Tables

| Table | Type | Records | Purpose |
|-------|------|---------|---------|
| `Node` | Node table | Entities, claims, turns, views | Every "thing" in the graph |
| `Prop` | Node table | Key-value properties | All type-specific data (EAV pattern) |
| `LINK` | Rel table | 8 relationship types | Connections between nodes |

### Design Principles

**1. Minimal fixed columns on Node**
Only columns that are universal across ALL 4 types (entity, claim, turn, view) AND queried in Cypher WHERE clauses. Everything type-specific goes in Prop.

**2. EAV pattern for flexibility**
The Entity-Attribute-Value pattern (Prop table) means any node can have any property without schema changes. No ALTER TABLE migrations ever.

**3. No HAS edge**
Prop references its owner via `owner_id` foreign key. A graph edge (HAS) was removed as redundant — the FK + hash index gives identical query patterns without an extra write operation.

**4. Inherent deterministic primary key**
Prop.id = `{owner_id}::{key}`. Same (owner, key) always produces the same PK string. LadybugDB rejects duplicate PKs natively — no separate unique constraint needed.

**5. Typed value columns (not UNION, not single STRING)**
LadybugDB's UNION type was tested and rejected: you can insert into it and read it back, but you CANNOT filter by member (`WHERE u.val.f > 0.8` gives Binder exception). Instead: `val_str`, `val_float`, `val_int`, `val_bool`, `val_json` — one non-null per row, columnar null storage (1 bit per column).

## Architecture Context

### The 4 Node Types

| Type | Represents | Stored in label | Stored in Prop |
|------|-----------|-----------------|----------------|
| `entity` | A person, tool, concept, project, etc. | Canonical name | confidence, status, aliases, role, etc. |
| `claim` | A fact, preference, observation, rule | Claim text (truncated) | content (full), provenance, type_sub |
| `turn` | A single exchange in a conversation | "Turn #N (session)" | session_id, turn_index, user_text, model |
| `view` | An attention filter for the compiler | View name | purpose, compiler_level, entity_filter |

### The 8 Link Types

| Type | Kind | Direction | Meaning | Example |
|------|------|-----------|---------|---------|
| `has` | atomic | → | Contains, owns, belongs to | Project → Task |
| `ref` | atomic | → | References, mentions, associates | Turn → Entity mentioned |
| `dep` | atomic | → | Depends on, supported by | Code → Library it imports |
| `con` | atomic | ↔ | Contradicts, conflicts with | Claim A ↔ Claim B |
| `seq` | atomic | → | Follows in time | Turn 1 → Turn 2 |
| `evidence` | compound | → | Claim references source as support | Claim → Document |
| `context` | compound | → | Container holds contained reference | Session → Entity discussed |
| `refute` | compound | → | New info replaces old info | Correction → Original claim |

Note: `con` is semantically bidirectional. Query with undirected syntax: `MATCH (a)-[l:LINK {type:'con'}]-(b)`

### Compiler Flow (Graph → LLM → Graph)

```
1. User Input
2. STORE READ: extract entities, load View, gather Claims
3. Compiler Forward: Graph state → LLM internals
   - Entity    → Residual stream (Point B, ly=8, sparse top-k)
   - Claim     → FFN output (Point G, ly=12, dense)
   - Turn      → KV cache prefill (Point D)
   - View      → Attention mask (Point E)
4. LLM GENERATION (Candle + Metal GPU)
5. Compiler Backward: LLM signals → Graph updates
   - Attention weights → entity mention_count
   - Logit lens → new entity detection
   - Logit entropy → claim confidence update
6. STORE WRITE: create Turn node, update entities, create Links
7. Output response
```

## Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    RUST STORE LAYER                          │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │              In-Memory Caches                      │      │
│  │                                                    │      │
│  │  node_cache:  HashMap<NodeId, CachedNode>          │      │
│  │    → get_property(id, key) = O(1) HashMap get      │      │
│  │    → property count = .properties.len()            │      │
│  │    → 0.006µs vs 400µs DB round-trip (73,000x)     │      │
│  │                                                    │      │
│  │  link_index:  HashMap<NodeId, Vec<CachedLink>>     │      │
│  │    → traverse(id, type) = O(degree)                │      │
│  │    → No DB query for graph traversal               │      │
│  │                                                    │      │
│  │  PropertyProfile: HashMap<(type, tag, key), Stats> │      │
│  │    → get_missing(node) = props >50% prevalence     │      │
│  │    → get_anomalous(node) = props <10% prevalence   │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │              Public Operations                     │      │
│  │                                                    │      │
│  │  create_node(type, tags, label, embedding?)        │      │
│  │  get_node(id) → CachedNode                        │      │
│  │  find_nodes(type) → Vec<NodeId>                   │      │
│  │  search_vector(embedding, limit) → Vec<NodeId>    │      │
│  │                                                    │      │
│  │  set_property(owner_id, key, value)  [upsert]     │      │
│  │  get_property(owner_id, key) → Option<PropValue>   │      │
│  │  get_all_properties(owner_id) → HashMap            │      │
│  │  get_missing(node) → Vec<String>                   │      │
│  │  get_anomalous(node) → Vec<String>                 │      │
│  │                                                    │      │
│  │  create_link(from, to, type) [no self-loops]      │      │
│  │  delete_link(id)                                   │      │
│  │  find_links(from_id, type?) → Vec<CachedLink>     │      │
│  │  find_links_to(to_id, type?) → Vec<CachedLink>    │      │
│  │  traverse(from_id, type, max_depth) → Vec<NodeId> │      │
│  └──────────────────────────────────────────────────┘      │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │              Maintenance                          │      │
│  │                                                    │      │
│  │  rebuild_cache()     ← on startup                 │      │
│  │  rebuild_profile()   ← on startup + periodic      │      │
│  │  consolidate()       ← prune stale, merge dups    │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
        │
        │  (bulk Cypher queries at startup only)
        ▼
┌─────────────────────────────────────────────────────────────┐
│                    LADYBUGDB                                  │
│  Columnar storage  |  HNSW vector index  |  CSR adjacency   │
│  Serializable ACID |  FTS inverted index  |  Hash indexes    │
└─────────────────────────────────────────────────────────────┘
```

## Stress Test Validation

All 24 edge case tests ran against live LadybugDB v0.17.1. Results:

| Category | Tests | Passed | Status |
|----------|-------|--------|--------|
| Schema creation | 1 | 1 | ✅ |
| Core operations (nodes, props, links) | 4 | 4 | ✅ |
| Query patterns (8 patterns) | 8 | 8 | ✅ |
| PropertyProfile analysis | 1 | 1 | ✅ |
| Scale (100 nodes, 600 props, 99 links) | 4 | 4 | ✅ |
| Edge cases (self-link, circular, delete, null) | 6 | 5 | ⚠️ |
| **Total** | **24** | **23** | **95.8%** |

### The 1 Known Failure

`CAST(val_json AS STRING) CONTAINS 'text'` — LadybugDB serializes JSON values in a format that breaks the string match. Parse JSON in the application layer instead of relying on CONTAINS.

### Key Performance Numbers

```
Cypher query (edge + filter):          ~400 µs    (any DB round-trip)
HashMap cache (Rust in-memory):        ~0.006 µs  (73,000x faster)

100 turns + 600 props batch write:     77 ms
Find turns by session_id (100 hits):   5 ms
Get all props for one node (6 props):  1 ms
30-hop chain traversal:                 2.6 ms
PropertyProfile (600 props GROUP BY):  <1 ms
```
