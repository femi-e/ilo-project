# ILO Architecture

## System Purpose

ILO is a persistent memory and context management system for AI agents. It enables agents to remember entities and relationships across sessions, dynamically manage their context window to stay within the model's effective reasoning capacity, and extract structured knowledge from conversations.

## Core Components

```
┌──────────────────────────────────────────────────────────────────────┐
│  AI AGENT / CLIENT                                                    │
│  (any agent framework — HTTP API consumer)                           │
└──────────────────────────┬───────────────────────────────────────────┘
                           │ HTTP (:18090)
┌──────────────────────────▼───────────────────────────────────────────┐
│  ILO Sidecar (Rust)                                                   │
│                                                                       │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐                │
│  │  HTTP API  │  │   Search     │  │  Learning Engine  │               │
│  │  (Axum)    │  │ FTS + Vector │  │  (Hebbian)       │               │
│  └─────┬─────┘  └──────┬───────┘  └────────┬─────────┘               │
│        └───────────────┼────────────────────┘                         │
│                        ▼                                              │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │              LadybugDB Graph Store                            │    │
│  │    Nodes · Properties · Links · Tags · Indexes                │    │
│  └──────────────────────────────────────────────────────────────┘    │
│            │                  │                                      │
│     ┌──────▼──────┐   ┌──────▼──────┐                               │
│     │  Embeddings   │   │   Search    │                               │
│     │ (llama.cpp)   │   │   Indexes   │                               │
│     └─────────────┘   └─────────────┘                               │
└──────────────────────────────────────────────────────────────────────┘
```

## Context Window Structure

The agent works within a bounded context window — typically 40% of the model's raw limit — kept in the model's effective reasoning zone.

```
Total budget: ~80-100K tokens (40% of model's raw limit)

┌──────────────────────────────────────────────────────────────┐
│  SYSTEM PROMPT (~750 tok)  [always pinned, cached]           │
│    Agent identity and working style                          │
│    Memory system instructions                                │
├──────────────────────────────────────────────────────────────┤
│  STABLE MEMORY (~2K tok)  [pinned, cached until topic shift] │
│    High-confidence cross-session entities                    │
├──────────────────────────────────────────────────────────────┤
│  SCORED QUEUE (~70K tok)  [dynamic, fresh each turn]         │
│    Turn chunks (full content)                                │
│    Memory chunks (entities + claims)                         │
│    All scored equally: model_score × 0.5 + recency × 0.3     │
│      + entity_overlap × 0.2                                  │
│    Lowest-scored evicted when over budget                    │
├──────────────────────────────────────────────────────────────┤
│  DASHBOARD (~2K tok)  [shown during context rebuild only]    │
│    Window usage: X%                                          │
│    Chunk list: ID, Type, Score                               │
├──────────────────────────────────────────────────────────────┤
│  CURRENT USER PROMPT  [always pinned]                        │
└──────────────────────────────────────────────────────────────┘
```

## Two-Turn Execution Pattern

Every user request follows a two-turn cycle: **reason first, then act**.

### Turn 1: Reason

The model receives the system prompt, scored context queue, dashboard, and user prompt for analysis. Only the `context_rebuild` tool is available.

```
System Prompt
Memory Context (high-confidence entities)
Scored Queue (turns + memory chunks)
Dashboard:
  Window: 45,231 / 100,000 (45%)
  Chunks:
    [turn_47]   turn    0.92
    [mem_jwt]   entity  0.88
    [turn_12]   turn    0.31
    [mem_ci_cd] entity  0.12

User: "I need to fix the refresh token endpoint."

Tools: [context_rebuild]
```

The model calls `context_rebuild` with analysis, plan, chunk scores, extracted entities, and claims.

### Turn 2: Execute

The sidecar stores extracted entities and claims, re-scores all chunks, evicts low-scored ones, and unlocks full tools. The model proceeds with a cleaner, more focused context.

```
System Prompt (same)
Memory Context (updated with new entities)
Scored Queue (re-scored, low chunks evicted):
  [turn_47]   turn    0.95
  [mem_jwt]   entity  0.92
  [mem_refresh] entity  0.88  (new)
  --- mem_ci_cd evicted ---
  --- turn_12 evicted ---

User: "I need to fix the refresh token endpoint."
```

## Scoring Formula

All chunks in the queue use a single scoring formula:

```
score = (0.5 × model_score) + (0.3 × recency) + (0.2 × entity_overlap)
```

| Component | Weight | Source | Behavior |
| ----------- | :------: | -------- | ---------- |
| model_score | 0.5 | LLM analysis | Model's own relevance judgment |
| recency | 0.3 | `exp(-Δt / 3600)` | 60-minute half-life |
| entity_overlap | 0.2 | ILO query | Fraction of entities still active in memory |

## Eviction Policy

- **Trigger**: Always on — every turn, check if over budget
- **Budget**: 40% of model's raw context window (capped at 100K tokens)
- **Action**: Evict lowest-scored chunks until within budget
- **Pattern**: Gradual — 1-3 chunks per turn in deep sessions
- **Resurrection**: Evicted entities stay in ILO's graph; if relevant again, they score high and re-enter

## Prompt Caching

The stable prefix (system prompt + pinned entities) gets cached. The scored queue and dashboard live in the fresh tail.

```
┌──────────────────────────────────────┐ ← cache start
│ SYSTEM PROMPT (always same)          │ ← cached
├──────────────────────────────────────┤
│ PINNED ENTITIES (rarely change)      │ ← usually cached
├──────────────────────────────────────┤ ← cache boundary
│ SCORED QUEUE (changes per turn)      │ ← fresh
│ DASHBOARD (changes per turn)         │ ← fresh
│ CURRENT USER PROMPT                  │ ← fresh
└──────────────────────────────────────┘
```

## API Endpoints

All endpoints are served over HTTP on `localhost:18090`.

| Method | Endpoint | Purpose |
| -------- | ---------- | --------- |
| POST | `/remember` | Store entities, claims, and turn data |
| POST | `/recall` | Retrieve contextual memory for a query |
| POST | `/search` | Full-text, vector, and hybrid search |
| POST | `/entity/lookup` | Look up entity details |
| POST | `/entity/update` | Update entity properties |
| POST | `/connect` | Create relationships between entities |
| POST | `/learn` | Update link weights via Hebbian learning |
| POST | `/ingest` | Bulk import content with extraction |
| POST | `/embed` | Generate embeddings |
| GET | `/health` | Health check |

### REST CRUD Endpoints

| Method | Endpoint | Purpose |
| -------- | ---------- | --------- |
| GET | `/v1/entities` | List entities with filters |
| POST | `/v1/entities` | Batch create entities |
| GET | `/v1/entities/:id` | Get entity with links |
| PATCH | `/v1/entities/:id` | Update entity |
| DELETE | `/v1/entities/:id` | Delete entity (cascading) |
| POST | `/v1/claims` | Batch create claims |
| GET | `/v1/claims/:id` | Get claim details |
| PATCH | `/v1/claims/:id` | Update claim |
| DELETE | `/v1/claims/:id` | Delete claim |
| POST | `/v1/links` | Create links |
| GET | `/v1/links/:id` | Get link details |
| PATCH | `/v1/links/:id` | Update link |
| DELETE | `/v1/links/:id` | Delete link |
| POST | `/v1/batch` | Atomic batch operations |

## Node & Edge Schema

ILO models knowledge as a directed property graph with four node types and seven link types.

### Node Types

| Type | Subtypes | Created When | Initial Confidence |
| ------ | ---------- | ------------- | :------------------: |
| entity | person, project, tool, language, concept | First mention in conversation | 0.7 |
| turn | — | Every conversational exchange | 1.0 |
| claim | fact, inference, observation, rule | Agent states a fact | 0.6 |
| view | — | System configuration | 1.0 |

### Link Types

| Type | Direction | Created When | Initial Weight |
| ------ | :---------: | ------------- | :--------------: |
| ref | Turn → Entity | Turn mentions entity | 0.7 |
| has | Entity → Entity | Relationship established | 0.6 |
| dep | Entity → Entity | Dependency identified | 0.5 |
| con | Entity ↔ Entity | Contradiction detected | 0.4 |
| seq | Turn → Turn+1 | Consecutive turns | 0.9 |
| evidence | Claim → Entity | Claim references entity | matches claim confidence |
| context | View → Entity | View is defined | 1.0 |

## Configuration

| Parameter | Default | Description |
| ----------- | --------- | ------------- |
| `ILO_PORT` | 18090 | HTTP server port |
| `ILO_DB_PATH` | ./var/ilo_data.lbug | Database file location |
| `ILO_MAX_UPTIME` | 0 (unlimited) | Auto-shutdown after N minutes |
| `EMBEDDING_DIM` | 768 | Embedding vector dimension |

### Learning Parameters

| Parameter | Value | Description |
| ----------- | ------- | ------------- |
| Hebbian eta | 0.1 | Learning rate for weight strengthening |
| Decay lambda | 0.001 | Per-turn global decay on all links |
| Oja coefficient | 0.01 | Oja's rule normalization |
| Negative feedback eta | 0.02 | Strength reduction for unused retrievals |
| Consolidation interval | 50 turns | How often to check for pattern consolidation |
