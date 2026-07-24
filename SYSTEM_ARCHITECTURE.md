# ILO Cognitive Runtime — System Architecture & Roadmap

## Mission
A persistent memory and cognition framework for improving long-term recall
and understanding for LLMs.

## Architecture
- Sidecar process (Rust binary) running alongside the agent
- Communication via HTTP (axum) on localhost
- Language-agnostic — any agent framework can call it
- No injection hooks — pure context retrieval
- LadybugDB as the graph database backend

---

## API Endpoints

### Phase 1 — Core (prototype)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/remember` | POST | Store a turn + learn from it |
| `/recall` | POST | Retrieve context for a query |
| `/status` | GET | Health check, node/link counts |
| `/nodes` | GET/POST | List all nodes / create a node |
| `/nodes/{id}` | GET/PATCH/DELETE | CRUD on a single node |
| `/links` | GET/POST | List all links / create a link |
| `/links/{id}` | GET/PATCH/DELETE | CRUD on a single link |

### Phase 2 — Advanced

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/views` | GET/POST | List views / create a view |
| `/views/{id}` | GET/PATCH/DELETE | CRUD on a single view |
| `/traverse` | POST | Walk from a node by N hops, return subgraph |
| `/query` | POST | Run raw Cypher against LadybugDB |
| `/consolidate` | POST | Trigger graph consolidation manually |
| `/train` | POST | Supply feedback signal (which nodes were useful) |
| `/reset` | POST | Clear all data (dev only) |
| `/config` | GET | Show active configuration |

---

## Retrieval Algorithm (3-factor PPR)

```
Input:  query string
Output: Anchor-format context block + ranked nodes

1. Seed Finding (chain):
   Full query → label match
   Decomposed query → label match
   Word search → label match
   Intent-based subtype fallback

2. Expansion (best-first frontier):
   Score per hop = damping × prev + (1-damping) × (EW × NC × LS)
   where:
     EW  = LINK.weight (0.0-1.0, Hebbian-strengthened)
     NC  = Node.confidence (0.0-1.0)
     LS  = label_similarity(query, target_label, subtype, properties) (0.2-1.0)
   Damping = 0.85
   Max hops = 4
   Min score = 0.02

3. Context Assembly (Anchor format):
   @session [metadata]
   # Focus: seed entities with properties
   # Entities: query-relevant nodes grouped by type
   # Evidence path: seed → ... → answer
   # Recent: supporting turns (max 3-5)

4. Sliding Window:
   15 recent turns in context
   Graph context prioritised over turns
   Old turns remain in graph (retrievable)
```

---

## Node & Edge Schema

### Node Types

| Type | Subtypes | Created When | Initial Confidence |
|------|----------|-------------|:------------------:|
| entity | person, project, tool, language, concept | First mention in conversation | 0.7 |
| turn | — | Every conversational exchange | 1.0 |
| claim | fact, inference, observation, rule | LLM states a fact | 0.6 |
| view | — | System configuration | 1.0 |

### Link Types

| Type | Direction | Created When | Initial Weight |
|------|:---------:|-------------|:--------------:|
| ref | Turn → Entity | Turn mentions entity | 0.7 |
| has | Entity → Entity | Relationship established | 0.6 |
| dep | Entity → Entity | Dependency identified | 0.5 |
| con | Entity ↔ Entity | Contradiction detected | 0.4 |
| seq | Turn → Turn+1 | Consecutive turns | 0.9 |
| evidence | Claim → Entity | Claim references entity | matches claim confidence |
| context | View → Entity | View is defined | 1.0 |

---

## Learning Loop (Outer)

| Parameter | Value | Status |
|-----------|-------|--------|
| Hebbian eta | 0.1 | ✅ Tested |
| Decay lambda | 0.001 | ✅ Tested |
| Oja coefficient | 0.01 | ⏳ Needs tuning |
| Confidence-gated decay | True (factor=0.9) | ⏳ Needs tuning |
| Negative feedback eta | 0.02 | ✅ Tested |
| Signal collection | entity overlap (Method A) | ⏳ Needs real data |
| Consolidation interval | 50 turns | ⏳ Needs real data |

---

## Configuration

All configuration is stored as View node properties:

| Property | Default | Description |
|----------|---------|-------------|
| max_hops | 4 | Maximum propagation depth |
| damping | 0.85 | PPR damping factor |
| min_score | 0.02 | Minimum score to include |
| context_budget | 8000 | Max chars for Anchor output |
| window_size | 15 | Recent turns to include |
| include_paths | true | Show evidence paths in output |
| include_turns | true | Show recent turns in output |
| entity_filter | (all) | Comma-separated subtype list |
| purpose | "" | Human-readable description |

---

## Implementation Status

| Component | Status |
|-----------|--------|
| Scoring formula | ✅ Validated (3-factor PPR) |
| Seed finding | ✅ Designed, basic implementation |
| Context assembly | ✅ Anchor format, path-grouped |
| Sliding window | ✅ Budget tested |
| Hebbian learning | ✅ Algorithm tested (Rust harness) |
| Store trait (Rust) | ❌ Not started |
| Axum HTTP server | ❌ Not started |
| LadybugDB integration | ❌ Not started |
| API endpoints | ❌ Not started |
| Learning loop | ⏳ Partial — signal collection needs real data |
| Dynamic View config | ⏳ Schema defined, not coded |
