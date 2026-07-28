# ILO Pi Extension

**v1.0.0** — Pi coding agent extension for persistent memory.

## Structure

```
src/
├── index.ts              # Entry point — registers hooks, providers, tools
├── events/
│   ├── context.ts        # before_provider_request pipeline coordinator
│   ├── turn.ts           # Turn lifecycle hooks
│   └── hooks.ts          # Input event hooks
├── lifecycle/
│   ├── manager.ts        # Server process lifecycle (MTPLX, llama.cpp, ILO)
│   └── constants.ts      # Ports, paths, and configuration
├── pipeline/
│   ├── recall.ts         # Memory retrieval from ILO
│   ├── extract.ts        # Entity extraction via 4B model
│   ├── extract-and-store.ts  # Extract + consolidate + store pipeline
│   ├── score.ts          # Chunk scoring (deprecated)
│   └── convert.ts        # Memory → system role conversion
├── client/
│   ├── ilo-client.ts     # ILO HTTP API client
│   └── context-rebuild-llm.ts  # 4B model API client
└── tools/
    ├── memory-tools.ts   # memory_search, memory_store, entity tools
    ├── task.ts           # Task management tool
    └── diagnostics.ts    # System diagnostics tool
```

## Key Files

| File | Purpose |
| --- | --- |
| `events/context.ts` | Pipeline: recall → extraction → consolidation → conversion |
| `pipeline/extract-and-store.ts` | 4B extraction with dedup consolidation |
| `client/ilo-client.ts` | All ILO API calls (entity CRUD, claims, search, recall) |
| `client/context-rebuild-llm.ts` | 4B MTPLX model caller with source_text support |
| `lifecycle/manager.ts` | Auto-starts MTPLX, llama-server embedding, and ILO sidecar |

## Configuration

| Env Var | Default | Purpose |
| --- | --- | --- |
| `ILO_4B_MODEL` | `Youssofal/Qwen3.5-4B-MTPLX-Optimized-Speed` | 4B model for extraction |
| `ILO_DISABLE_EVICTION` | auto | Force disable extraction on cloud APIs |
| `ILO_4B_TIMEOUT` | 15000 | 4B model timeout (ms) |
