# ILO Architecture Overview

## System Purpose

ILO is a persistent memory and context management system for a collaborative personal assistant agent. It enables the agent to remember entities and relationships across sessions, dynamically manage its context window to stay within the model's effective reasoning capacity, and extract structured knowledge from conversations.

## Core Components

```
┌─────────────────────────────────────────────────────────────────────┐
│  PI AGENT                                                           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Extension (TypeScript)                                       │   │
│  │  ├── context_rebuild tool registration                       │   │
│  │  ├── context event (tool gating + scored queue)              │   │
│  │  ├── turn_end event (ILO storage + learning)                 │   │
│  │  └── before_provider_request (memory role conversion)        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                           │ HTTP                                    │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  ILO Sidecar (Rust)                                          │   │
│  │  ├── Graph store (LadybugDB)                                 │   │
│  │  ├── Entity/claim extraction (fallback)                      │   │
│  │  ├── 3-factor PPR retrieval                                  │   │
│  │  ├── Hebbian learning                                        │   │
│  │  └── Embedding server proxy                                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                           │ HTTP                                    │
│                           ▼                                         │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  LLM (local or cloud)                                        │   │
│  │  ├── context_rebuild (analysis + extraction + scoring)       │   │
│  │  └── Execution with full tools                               │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Context Window Structure

```
Total budget: ~80-100K tokens (40% of model's raw limit, keeps model in smart zone)

┌──────────────────────────────────────────────────────────────┐
│  SYSTEM PROMPT (~750 tok)  [always pinned, cached]            │
│    Collaborative personal assistant identity                  │
│    Memory system instructions                                 │
│    Two-phase execution flow                                   │
│    Working style                                              │
├──────────────────────────────────────────────────────────────┤
│  STABLE MEMORY (~2K tok)  [pinned, cached until topic shift] │
│    High-confidence cross-session entities                     │
│    User node and persistent links                             │
├──────────────────────────────────────────────────────────────┤
│  SCORED QUEUE (~70K tok)  [dynamic, fresh each turn]         │
│    Turn chunks (full content)                                 │
│    Memory chunks (role: "memory", entities + claims)          │
│    All scored equally by: 0.5×model + 0.3×recency + 0.2×overlap│
│    Lowest-scored evicted when over budget                     │
├──────────────────────────────────────────────────────────────┤
│  DASHBOARD (~2K tok)  [shown during context_rebuild only]    │
│    Window usage: X%                                           │
│    Chunk list: ID, Type, Score                                │
├──────────────────────────────────────────────────────────────┤
│  CURRENT USER PROMPT  [always pinned]                         │
└──────────────────────────────────────────────────────────────┘
```

## Execution Flow

```
1. USER SENDS PROMPT
2. CONTEXT EVENT: gate tools to [context_rebuild only]
   - Build dashboard
   - Send system prompt + scored queue + dashboard + user prompt
3. MODEL CALLS context_rebuild
   - Returns: analysis, plan, chunk_scores, extracted_entities, extracted_claims
   - Each claim has: subject, relationship_raw, object, category (1 of 7), confidence
4. EXTENSION INTERCEPTS
   - Store entities/claims in ILO with 7-category links
   - Re-score all chunks against model's analysis
   - Evict lowest-scored if over budget
   - Unlock full tools
5. MODEL EXECUTES with full tools + cleaned context
6. TURN_END EVENT
   - Store turn in ILO
   - Hebbian learning: update link weights
   - Extract entities/claims (LLM fallback)
```

## Dynamic Budget Detection

```typescript
async function getUsableBudget(): number {
  // Prefer pi's model registry (cloud models)
  if (ctx.model?.contextWindow) {
    return min(ctx.model.contextWindow * 0.4, 100000);
  }
  // Fallback: query local server
  const resp = await fetch("/v1/models");
  const data = await resp.json();
  const nCtx = data.data[0].meta?.n_ctx_train // llama.cpp
            || data.data[0].context_length;   // MTPLX
  if (nCtx) return min(nCtx * 0.4, 100000);
  // Hard fallback
  return 80000;
}
```

## Key Design Decisions

| Decision | Choice | Rationale |
| ---------- | -------- | ----------- |
| Eviction trigger | Always on | Keeps model in smart zone, never hits dumb zone |
| Pinned entities | None | Everything competes equally, momentum decides relevance |
| Scoring | Uniform across all chunks | Single formula: 0.5×model + 0.3×recency + 0.2×overlap |
| Half-life | 60 minutes | Matches long session patterns |
| Link types | 7 categories + raw string | Validated against 150 queries (100% coverage, 0.79 reliability) |
| Extraction | LLM primary, Rust fallback | LLM quality significantly higher |
| Per-category scoring | Deferred | Categories route attention heads, not scoring |
| Memory role | Custom `role: "memory"` | Competes with turns in scored queue |
| Cross-session | ILO bridges via entity scores | Entities survive sessions, turns resurrect on relevance |

## Supported LLM Backends

| Backend | Context Detection | Tool Calling | Notes |
| --------- | :----------------: | :------------: | ------- |
| llama.cpp | `/v1/models` → `meta.n_ctx_train` | Requires `enable_thinking: false` | Fastest for 35B A3B MoE |
| MTPLX | `/v1/models` → `context_length` | Requires `enable_thinking: false` | MTP speculative decoding |
| Cloud (pi) | `ctx.model?.contextWindow` | Native support | Higher cost, no thinking bug |

## Migration

Old ILO data with legacy LinkTypes (8-value enum) is left as-is. Schema is updated to support new fields (7-category enum + relationship string). Old and new link types coexist in the database. No migration script needed.
