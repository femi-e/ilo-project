# ILO — Cognitive Memory Runtime for AI Agents

**v1.0.0** — Persistent knowledge graph memory with full-text search, vector retrieval, PPR graph traversal, and Hebbian learning. Embedded in Rust, built for AI agents.

[![Rust](https://img.shields.io/badge/language-Rust-orange?logo=rust)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why ILO?

Most agent memory systems are vector stores with nicer branding. Real agents need:

- **Structured relationships** — not just "similar text" but *why did I decide this?*
- **Multiple retrieval signals** — vectors, text search, and graph traversal working together
- **Memory that learns** — link weights that strengthen with use (Hebbian learning)
- **A runtime, not a library** — embedded database with HTTP API, ready to integrate

ILO is a Rust sidecar that gives AI agents persistent, queryable memory in a single binary.

## Quick Start

### 1. Build

```bash
git clone https://github.com/yourname/ilo.git
cd ilo
cargo build --release
```

### 2. Run

```bash
./target/release/ilo
```

Starts on `http://127.0.0.1:18090`.

### 3. Store a memory

```bash
curl -X POST http://127.0.0.1:18090/remember \
  -H "Content-Type: application/json" \
  -d '{"query": "What architecture decisions were made?",
       "entities": [{"label": "API Design", "tags": ["decision", "architecture"]}],
       "claims": [{"content": "We chose FastAPI for its async support",
                    "entities": ["API Design"]}]}'
```

### 4. Retrieve memories

```bash
curl -X POST http://127.0.0.1:18090/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "Why did we choose FastAPI?"}'
```

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                    AI Agent / Client                    │
│         (any framework — HTTP API consumer)             │
└────────────────────────┬───────────────────────────────┘
                         │ HTTP API (:18090)
┌────────────────────────▼───────────────────────────────┐
│                    ILO Sidecar                          │
│                                                         │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  HTTP API │  │   Search     │  │  Learning Engine │  │
│  │  (Axum)   │  │ FTS + Vector │  │  (Hebbian)      │  │
│  └─────┬─────┘  └──────┬───────┘  └────────┬─────────┘  │
│        └───────────────┼────────────────────┘           │
│                        ▼                                │
│  ┌──────────────────────────────────────────────────┐   │
│  │              LadybugDB Graph Store                │   │
│  │    Nodes · Properties · Links · Tags · Indexes    │   │
│  └──────────────────────────────────────────────────┘   │
│            │                  │                           │
│     ┌──────▼──────┐   ┌──────▼──────┐                   │
│     │  Embeddings  │   │   Search    │                   │
│     │ (llama.cpp)  │   │   Indexes   │                   │
│     └─────────────┘   └─────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

## Features

| Capability | ILO |
| --- | --- |
| **Graph DB + FTS + Vector** in one binary | ✅ Single embedded sidecar |
| **PPR graph traversal** | ✅ Personalized PageRank with lateral inhibition |
| **Hebbian learning** | ✅ Link weights strengthen with use, decay without |
| **Single-instance enforcement** | ✅ BSD flock |
| **4-factor retrieval** | ✅ FTS → Vector → Label → Recency chain of fallbacks |
| **Memory lifecycle** | ✅ Create, retrieve, consolidate, learn, decay |

## Documentation

| Document | What it covers |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, context window, two-turn pattern, API, schema |
| [RETRIEVAL_AND_LEARNING.md](docs/RETRIEVAL_AND_LEARNING.md) | Seed finding, spreading activation, Hebbian learning, consolidation |
| [GRAPH_AND_EXTRACTION.md](docs/GRAPH_AND_EXTRACTION.md) | Graph schema, entity extraction, link types, memory chunks |
| [DESIGN_VALIDATION.md](docs/DESIGN_VALIDATION.md) | Research validation for all 8 design decisions |
| [FAILURE_ANALYSIS.md](docs/FAILURE_ANALYSIS.md) | Known failure modes, mitigations, and testing requirements |
| [SESSION_ACTIONS_FORMAT.md](docs/SESSION_ACTIONS_FORMAT.md) | Compressed session history format (19x compression) |

## Benchmark Suite

ILO includes a Python benchmark suite in `benchmark/` that validates memory performance across multiple dimensions:

- **Ablation study** — impact of each retrieval signal
- **Context rebuild** — memory reconstruction after eviction
- **Entity injection** — extraction accuracy
- **Consolidation** — deduplication across turns
- **Extraction comparison** — LLM vs heuristic methods
- **Stress testing** — high-frequency memory operations

```bash
cd benchmark
python run.py
```

## Configuration

| Env Variable | Default | Purpose |
| --- | --- | --- |
| `ILO_PORT` | `18090` | HTTP server port |
| `ILO_DB_PATH` | `./var/ilo_data.lbug` | Database file location |
| `ILO_MAX_UPTIME` | `0` (unlimited) | Auto-shutdown after N minutes |
| `EMBEDDING_DIM` | `768` | Embedding vector dimension |

## License

MIT
