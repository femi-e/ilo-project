# ILO — Memory Architecture

**v1.0.0** — Rust sidecar for persistent knowledge graph memory.

## Architecture

```
┌─────────────────────┐
│   HTTP API (:18090) │
│   /remember         │
│   /recall           │
│   /entity/lookup    │
│   /entity/update    │
│   /claims           │
│   /search           │
│   /learn            │
│   /connect          │
└─────────┬───────────┘
          │
┌─────────▼───────────┐
│   LadybugDB Graph   │
│   Node / Prop / LINK│
│   tables            │
└─────────┬───────────┘
          │
┌─────────▼───────────┐
│   In-Memory Caches  │
│   Node cache        │
│   Link cache        │
│   Tag index         │
│   Search index      │
└─────────────────────┘
```

## Source Layout

```
src/
├── main.rs          # HTTP server entry point
├── lib.rs           # Module declarations
├── types.rs         # Core types: NodeRecord, LinkRecord, StoreMutation, etc.
├── store.rs         # Store trait (interface for graph operations)
├── ladybug.rs       # LadybugDB implementation (Node/Prop/LINK tables)
├── embed.rs         # Embedding generation via llama.cpp API
├── extract.rs       # Legacy heuristic extractor (deprecated)
├── retrieval.rs     # PPR-based graph traversal + FTS search
├── search.rs        # FTS + vector search index
├── learning.rs      # Counter-based link weight learning
├── config.rs        # Learning configuration
├── mock_store.rs    # In-memory store for tests
├── server/
│   ├── handlers.rs  # HTTP request handlers
│   ├── helpers.rs   # Shared mutation builders
│   └── types.rs     # Request/response types
├── bin/             # Binary entry points
└── tests/           # Integration tests
```

## Key Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| **Database** | LadybugDB | Embedded, zero-config, Cypher query language |
| **Timestamps** | INT64 (epoch seconds) | Avoids 5-variant TIMESTAMP confusion |
| **Embedding dim** | 768 (configurable via `EMBEDDING_DIM`) | Easy to change models |
| **Properties** | Separate Prop table | Flexible key-value without schema changes |
| **Claims** | LINK edges with Prop provenance | Source text stored as properties on links |
| **Retrieval** | PPR (Personalized PageRank) | 3-factor: FTS → vector → graph traversal |
| **Consolidation** | Skip-reuse on entity creation | Prevents duplicate entities |

## Build & Run

```bash
cd mem-arch
cargo build --release
./target/release/ilo
```

Starts on `http://127.0.0.1:18090`.
