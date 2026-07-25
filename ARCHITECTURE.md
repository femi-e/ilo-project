# ILO — Cognitive Memory Runtime: System Architecture

> **Status**: Fully implemented and running. Sidecar online, zero entities stored (fresh state).

---

## Overview

ILO is a **persistent graph memory runtime** for coding agents. It runs as a Rust sidecar alongside the pi agent, providing:
- Long-term entity-relationship memory across sessions
- Semantic retrieval via FTS + vector search + graph traversal (3-factor PPR)
- Hebbian-style learning that tunes link weights by real-time frequency × recency
- Entity/claim extraction from conversation text
- Local embedding generation via BGE-base-en-v1.5 (768-dim, Candle CPU inference)

---

## Architecture Overview

```
                         ┌─────────────────────────────┐
                         │     🧑 User (Terminal)      │
                         └────────┬──────────┬─────────┘
                                  │          │
                       stdin/stdout│          │
                                  │          │
       ┌──────────────────────────┴──────────┴──────────────────────┐
       │                                                             │
       │  ┌──────── Active ─────────┐    ┌────── Passive ─────────┐ │
       │  │                         │    │                         │ │
       │  │   pi (coding agent)     │    │  ILO (memory runtime)  │ │
       │  │   : stdio               │    │  :18090                 │ │
       │  │                         │    │                         │ │
       │  │  ┌───────────────────┐  │    │  ┌───────────────────┐  │ │
       │  │  │ ILO Extension     │──┼────┼─▶│  /remember        │  │ │
       │  │  │  (TypeScript)     │  │    │  │  /recall          │  │ │
       │  │  │                   │◄─┼────┼──│  /learn           │  │ │
       │  │  │  before_turn      │  │    │  │  /embed           │  │ │
       │  │  │  → recall memory  │  │    │  │  /extract         │  │ │
       │  │  │  → inject context │  │    │  │  /search          │  │ │
       │  │  │                   │  │    │  └───────────────────┘  │ │
       │  │  │  after_turn       │  │    │                         │ │
       │  │  │  → extract        │  │    │  ┌───────────────────┐  │ │
       │  │  │  → remember       │  │    │  │  LadybugDB        │  │ │
       │  │  │  → learn          │  │    │  │  (graph store)    │  │ │
       │  │  └───────────────────┘  │    │  └───────────────────┘  │ │
       │  │                         │    │                         │ │
       │  │  ┌───────────────────┐  │    └─────────────────────────┘ │
       │  │  │ Web Search Tool  │  │                                 │
       │  │  │  → SearXNG:18089 │  │                                 │
       │  │  └───────────────────┘  │                                 │
       │  └─────────────────────────┘                                 │
       └──────────────────────────┬───────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │     HTTP localhost:*      │
                    │  (all 127.0.0.1 only)     │
                    └─────────────┬─────────────┘
                                  │
                                  ▼
       ┌──────────────────────────────────────────────────────────────┐
       │                    ◈  Infrastructure  ◈                     │
       │                                                              │
       │  ┌──────────────────────────────────────────────────────┐   │
       │  │  mistral.rs  :1234                                  │   │
       │  │  ───────────────────────                            │   │
       │  │  POST /v1/chat/completions → LLM (Qwen3.5-9B)      │   │
       │  │  POST /v1/embeddings       → embeddings             │   │
       │  │  POST /v1/messages         → Anthropic-compat       │   │
       │  │                                                      │   │
       │  │  pi → /v1/chat (local chat)                         │   │
       │  │  ILO → /v1/embeddings (via /embed proxy)            │   │
       │  └──────────────────────────────────────────────────────┘   │
       │                                                              │
       │  ┌──────────────────────────────────────────────────────┐   │
       │  │  SearXNG  :18089  (podman/gvproxy)                  │   │
       │  │  ───────────────────────                            │   │
       │  │  pi → /search?q=... (web search tool)               │   │
       │  └──────────────────────────────────────────────────────┘   │
       │                                                              │
       │  ┌──────────────────────────────────────────────────────┐   │
       │  │  Cloud APIs                                          │   │
       │  │  ───────────────────────                            │   │
       │  │  api.anthropic.com → fallback LLM                   │   │
       │  │  api.openai.com   → fallback LLM                    │   │
       │  └──────────────────────────────────────────────────────┘   │
       └──────────────────────────────────────────────────────────────┘
```

## Interaction Protocols

| Between | Transport | Port | Purpose |
|---------|-----------|------|---------|
| User ↔ pi | stdin/stdout | — | Terminal I/O |
| pi → ILO | TCP HTTP | `:18090` | Store/retrieve memory |
| pi → mistral.rs | TCP HTTP | `:1234` | Local LLM chat |
| ILO → mistral.rs | TCP HTTP | `:1234` | Embeddings for recall |
| pi → SearXNG | TCP HTTP | `:18089` | Web search tool |
| pi → Cloud | TCP HTTPS | 443 | Fallback LLM |

All local services bound to `127.0.0.1` only — no external access.

## Data Flow Per Turn

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ONE CONVERSATION TURN                         │
│                                                                      │
│  BEFORE AGENT START:                                                 │
│                                                                      │
│  1. pi fires before_agent_start hook                                 │
│     └── ILO Extension calls ILO /recall(query)                       │
│           └── ILO needs embeddings → calls mistral.rs /v1/embeddings │
│           └── ILO runs FTS + PPR graph traversal                     │
│           └── Returns context block to pi                            │
│     └── pi injects context into system prompt                        │
│                                                                      │
│  AGENT RUNS (LLM generates response, may call tools)                 │
│                                                                      │
│  AFTER TURN END:                                                     │
│                                                                      │
│  2. pi fires turn_end hook                                           │
│     └── ILO Extension calls ILO /extract(query+response)             │
│           └── ILO runs heuristic entity/claim extraction             │
│     └── ILO Extension calls ILO /remember(turn+entities)             │
│           └── ILO needs embeddings → calls mistral.rs /v1/embeddings │
│           └── ILO stores turn + entities + claims + links in DB      │
│     └── ILO Extension calls ILO /learn(feedback)                     │
│           └── ILO runs Hebbian weight update                         │
│                                                                      │
│  BETWEEN TURNS (optional, every 50 turns):                           │
│                                                                      │
│  3. ILO runs consolidation                                           │
│     └── Scans for hub nodes (total incident weight > 5.0)            │
│     └── No-op for small graphs                                       │
└──────────────────────────────────────────────────────────────────────┘
```

## API Contracts

### pi → ILO (`:18090`)

```
POST /recall
  Request:  { "query": "what is Ailo?", "query_embedding": [0.1,...]? }
  Response: { "context": "@session [query:...]\n  [nodes: 3]\n...",
              "nodes": 3, "chars": 412 }

POST /remember
  Request:  { "query": "...", "response": "...",
              "entities": [{ "label": "Ailo", ... }],
              "claims": [{ "content": "Ailo is a memory runtime", ... }] }
  Response: { "status": "ok", "turn_id": "t_...", "entities_created": 2 }

POST /learn
  Request:  { "turn_id": "t_...", "query": "...",
              "used_labels": ["Ailo"], "retrieved_labels": ["Ailo", ...],
              "quality": 0.8 }
  Response: { "status": "ok", "edges_updated": 5 }

POST /embed
  Request:  { "text": "Ailo is a memory runtime", "is_query": true }
  Response: { "embedding": [0.021, -0.043, ...], "dim": 768 }
```

### ILO → mistral.rs (`:1234`)

```
POST /v1/embeddings
  Request:  { "model": "default", "input": "Ailo is a memory runtime" }
  Response: { "data": [{ "embedding": [0.021, -0.043, ...], "index": 0 }],
              "model": "default", "usage": { "prompt_tokens": 6 } }
```

### pi → mistral.rs (`:1234`)

```
POST /v1/chat/completions
  Request:  { "model": "default",
              "messages": [{ "role": "user", "content": "..." }],
              "stream": true }
  Response: SSE stream of { "choices": [{ "delta": { "content": "..." } }] }
```

## Port Map

| Port | Service | Bound To | Purpose |
|------|---------|----------|---------|
| `1234` | mistral.rs | `127.0.0.1` | LLM + embeddings |
| `18089` | SearXNG | `*` (gvproxy) | Web search |
| `18090` | ILO | `127.0.0.1` | Memory runtime |
```

---

## Data Model

### Node Types (3)

| Type | Label | Purpose | Initial Confidence | Storage |
|------|-------|---------|:-----------------:|---------|
| `Entity` | Arbitrary name | Real-world things (people, projects, concepts) | 0.3–0.7 | Node table |
| `Claim` | Claim text | Facts, relationships, beliefs | 0.6 | Node table |
| `Turn` | `Turn #N` | Conversation turns | 1.0 | Node table + Prop rows |

### Link Types (8)

| Type | Direction | Purpose | Initial Weight |
|------|:---------:|---------|:--------------:|
| `Ref` | Turn → Entity | Turn mentions entity | 0.7 |
| `Has` | Entity → Entity | Relationship established | 0.6 |
| `Dep` | Entity → Entity | Dependency identified | 0.5 |
| `Con` | Entity ↔ Entity | Containment / part-of | 0.4 |
| `Seq` | Turn → Turn+1 | Temporal ordering of turns | 0.9 |
| `Evidence` | Claim → Entity | Claim references entity | matches conf |
| `Context` | (entity reference) | Entity linked to context | 0.5 |
| `Refute` | Claim → Entity | Contradiction | 0.3 |

### Properties

Arbitrary key-value store attached to any node or link. Supports types: `String`, `Float`, `Int`, `Bool`, `Json`.

Link properties used by the learning system:
- `retrieved` (Float) — how many times this link has been retrieved
- `useful` (Float) — how many times it was found useful (confidence-gated)
- `last_used` (Int) — wall-clock timestamp of last use (ms since epoch)
- `first_used` (Int) — wall-clock timestamp of first use (ms since epoch)

---

## Retrieval Algorithm (3-factor PPR)

### Seed Finding Chain

```
Phase 0:    FTS search (BM25) via SearchIndex        → score 0.1–1.0
Phase 0.5:  Vector search (cosine sim) via SearchIndex → score 0.0–1.0
Phase 1:    Exact label match per query word          → score 1.0
Phase 2:    Substring label match per query word      → score 0.7
Phase 3:    Tag/subtype fallback                      → score 0.3
```

Each phase is tried in order; if it produces results, later phases are skipped.

### Graph Expansion

Best-first frontier expansion from seed nodes:

```
score = energy × link_weight × node_confidence × label_sim × direction / fanout

Where:
  energy     = activation propagating from seeds (propagated by damping)
  link_weight = Hebbian-strengthened edge weight (0.0–1.0)
  confidence = target node's confidence value (0.0–1.0)
  label_sim  = label_similarity(query, target_label):
                 exact match = 1.0, contains = 0.6, word overlap = 0.4, else 0.2
  direction  = forward link: 1.0, backward link: 0.5
  fanout     = number of edges from current node (normalizes hub dominance)
```

Parameters: `max_hops = 4`, `min_score = 0.02`, `max_nodes_per_hop = 8` (with lateral inhibition for lower-scoring nodes).

### Context Assembly

Output format injected into the LLM's system prompt:

```
@session [query: user query]
  [nodes: N]

# Focus:
  SeedEntity [confidence: 0.95]

# Related:
  ConnectedEntity [rel: 0.45]
```

Truncated to ~8000 characters budget.

---

## Learning Algorithm (Counter-Based, Real-Time Decay)

### Weight Formula

```rust
weight = frequency × recency

frequency = (useful + 1.0) / (retrieved + 2.0)   // Beta(1,1) prior
recency   = exp(-Δt_ms × ln(2) / half_life_ms)    // Real-time decay
```

### Key Properties

| Property | Value |
|----------|-------|
| Half-life (recency) | 90 days (7,776,000,000 ms) |
| Beta prior | `(1+1)/(1+2) = 0.5` — new edges start neutral |
| Confidence gating | Useful increment scaled by `√(conf_a × conf_b)` |
| Update direction | **One-directional** — only co-used pairs get strengthened |
| Passive forgetting | Recency decay handles it — no active weakening needed |
| Consolidation interval | Every 50 turns, checks for hub nodes (total incident weight > 5.0) |

### Signal Collection

Two methods:
1. **`from_explicit` (preferred)** — Agent provides explicit labels of which entities were useful. Breaks the confirmation bias loop.
2. **`from_overlap` (fallback)** — Checks which retrieved entity labels appear in the response text. Creates a confirmation bias loop if used exclusively.

---

## Entity Extraction (Heuristic)

No LLM calls needed — purely rule-based:

1. **Gazetteer matching** — Known entities from the graph matched against text (longest match wins)
2. **Pattern matching** — Capitalized multi-word phrases, acronyms, proper nouns
3. **Claim extraction** — Subject–relationship–Object patterns between entities
4. **Negation-aware** — Skips claims containing "not", "n't", "never", "no"

Link patterns: ~80 patterns across 6 relationship types (`ref`, `dep`, `con`, `evidence`, `refute`).

---

## Embedding Generation

| Property | Value |
|----------|-------|
| Model | BAAI/bge-base-en-v1.5 |
| Dimension | 768 |
| Inference | Candle (Rust ML framework), CPU |
| Performance | ~20ms per embedding (Apple M3) |
| Loading | Lazy `OnceLock` — loaded on first call |
| Download | HuggingFace Hub (cached at ~/.cache/huggingface/) |
| Query prefix | `"Represent this sentence for searching relevant passages: "` |

---

## Search Index (In-Memory)

Rebuilt on startup and after every write batch from the node cache.

### FTS (BM25)
- Inverted index from node labels
- TF-IDF with BM25 scoring (`k1=1.2`, `b=0.75`)
- Tokenization: lowercase, split on whitespace/punctuation, drop stop words (<2 chars)

### Vector
- `HashMap<NodeId, Vec<f32>>` — O(n) scan, fine for <10K nodes
- Cosine similarity, clamped to [0, 1]

---

## Process Lifecycle

| Aspect | Detail |
|--------|--------|
| Binary | `mem-arch/target/release/ilo` (23 MB, built via `cargo build --release`) |
| Socket | Unix domain socket at `var/ilo.sock` |
| Max uptime | 45 minutes (configurable via `ILO_MAX_UPTIME`) |
| Auto-restart | Up to 3 times on crash, 1s delay |
| Health check | Polls `/status` every 100ms on startup (3s timeout) |
| Shutdown | Graceful on SIGTERM, force kill after 5s |

---

## Installed LLM Tools

All registered via `ilo-tools.ts` and discoverable by the pi agent:

| Tool | What it does |
|------|-------------|
| `search` | Search memory by query, tag filter, flat mode |
| `store` | Save a belief/fact to long-term memory |
| `ingest` | Save external content (articles, files) into memory |
| `connect` | Link two entities in the knowledge graph |
| `forget` | Deprecate/remove a stored belief |
| `project_tree` | Show live directory structure (filters node_modules, target, .git) |
| `git_snapshot` | Show branch, status, recent commits |
| `git_commit` | Stage all + commit with auto-generated or custom message |
| `web_search` | Search the web via SearXNG metasearch |
| `web_scrape` | Fetch and clean a web page (Mozilla Readability) |
| `web_crawl` | Crawl a domain BFS-style, returning discovered pages |
| `task` | Create, update, and list tasks with priority |
| `diagnostics` | Run full system health report |

---

## Test Suite

| File | What it covers |
|------|---------------|
| `adversarial_test.rs` | Self-loops, circular graphs, fan-out explosion, empty queries, stop words, unicode, SQL injection, NaN/infinity, concurrent reads/writes, extreme input sizes |
| `learning_test.rs` | Weight formula correctness, Hebbian updates, recency decay, hub detection |
| `learning_value_test.rs` | Beta prior behavior, convergence, noise resistance |
| `stress_test.rs` | 5000-node graph, 100 concurrent readers/writers, retention under load |
| `weight_formula_test.rs` | Frequency calculation, recency decay curve, edge cases |
| `extract tests` | Gazetteer matching, claims, negation, stop words, unicode, empty text |
| `search tests` | FTS matching, BM25 ranking, case insensitivity, vector search |
| `retrieval tests` | Seed finding, graph expansion, context assembly, empty queries |
| `type tests` | Roundtrip serialization for all enum types, StoreError display |

---

## Current State

| Metric | Value |
|--------|-------|
| Sidecar | ✅ Running (PID active) |
| Database | ✅ Connected (LadybugDB at `var/ilo_data.lbug`) |
| Tags | 0 unique |
| Stored entities | 0 |
| Stored links | 0 |
| Stored turns | 0 |
| Search index | Empty (fresh rebuild) |
| Uptime | Varies per session (max 45 min default) |
| RUST_LOG | `info` |

---

## Key Design Decisions

1. **Wall-clock decay over turn-count decay** — A link decays based on how much real time has passed (half-life 90 days). This grounds episodic memory in reality: a link from yesterday is half as strong regardless of 5 or 500 turns in between.

2. **One-directional learning** — Only co-used pairs are strengthened. No active weakening of unused links — the Beta prior naturally drives noise edges toward 0 while useful edges converge toward 1.

3. **Heap-based PPR over matrix operations** — The graph is traversed live via best-first frontier expansion rather than computing PageRank on the full matrix. At <10K nodes this is faster and uses less memory.

4. **Lazy embedding model loading** — BGE-base-en-v1.5 is 133MB. Loading it on first embed call means ILO starts instantly and pays the cost only when semantic search is actually needed.

5. **In-memory caches + LadybugDB** — Reads go through `Mutex<HashMap>` caches (~ns). Writes go to LadybugDB (Cypher queries, ~ms). The caches are synced after every write batch. This gives hot-path read performance with durable persistence.

6. **Explicit learning signals over overlap detection** — The agent knows which entities were useful because it built the prompt. `from_explicit` bypasses the confirmation bias loop that `from_overlap` creates.

---

## Future Directions

See [mem-arch/docs/](mem-arch/docs/) for:
- [ALGORITHM_SPEC.md](mem-arch/docs/ALGORITHM_SPEC.md)
- [RETRIEVAL_AND_LEARNING.md](mem-arch/docs/RETRIEVAL_AND_LEARNING.md)
- [INTERACTION_LOOP.md](mem-arch/docs/INTERACTION_LOOP.md)
- [STRESS_TEST.md](mem-arch/docs/STRESS_TEST.md)