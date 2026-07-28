# ILO — Offline Memory Architecture

**v1.0.0** — Persistent memory for AI coding agents, running fully offline on Apple Silicon.

## Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│  35B A3B    │    │   4B MTPLX   │    │   bge v1.5  │
│  Chat Model │    │  Extraction  │    │  Embeddings │
│  :1234      │    │  :1236       │    │  :1235      │
└─────────────┘    └──────────────┘    └─────────────┘
       │                   │                  │
       └───────────────────┼──────────────────┘
                           ▼
                    ┌──────────────┐
                    │  ILO Sidecar │
                    │  Graph DB    │
                    │  :18090      │
                    └──────────────┘
```

## Services

| Port | Model | Purpose | Type |
| --- | --- | --- | --- |
| 1234 | Qwen3.6-35B-A3B MTPLX | Main conversation | LLM |
| 1235 | bge-base-en-v1.5 | Memory recall (vector search) | Embedding |
| 1236 | Qwen3.5-4B MTPLX | Entity + claim extraction with source text | LLM |
| 18090 | ILO Rust sidecar | Memory graph storage + retrieval | Database |

## Quick Start

```bash
# Start all services (handled by pi extension automatically)
pi

# Or manually:
mtplx serve --model Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed --port 1234
llama-server --port 1235 --embeddings --model ~/models/embeddings/bge-base-en-v1.5-q8_0.gguf
mtplx serve --model Youssofal/Qwen3.5-4B-MTPLX-Optimized-Speed --port 1236 --reasoning off
./mem-arch/target/release/ilo
```

## Components

- **`pi-extension/`** — Pi extension that orchestrates memory recall, extraction, and tool integration
- **`mem-arch/`** — Rust sidecar with LadybugDB-backed graph storage, vector search, and PPR retrieval
- **`benchmark/`** — Performance and ablation test suite
- **`docs/`** — Architecture and design documentation

## Data Flow

```
User Turn → Recall Memory → Extract Entities+Claims → Store in ILO → Respond
                ↑                                    ↕
           Past memories                     Graph Database (ILO)
```

- Extraction runs in background — never blocks the response
- Duplicate entities are automatically skipped (consolidation)
- Claims carry `source_text` provenance from the conversation
