# Context Rebuild Architecture

## Overview

Replaces FIFO slide + compaction with a **reason-then-reconstruct** pattern.
The model reasons about what context it needs, then we build the window from ILO.

## Flow

```
User sends prompt
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│ 1. context EVENT (tool gate)                                     │
│    - Strip all tools except `context_rebuild`                    │
│    - Model has only one option                                   │
│                                                                  │
│    System Prompt: [always present]                               │
│    Hard Rules:    [always present]                               │
│    Memory Context: [current entities from ILO]                   │
│    Message:       [current user prompt only]                     │
│    Tools:         [context_rebuild only]                         │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│ 2. LLM processes (context_rebuild tool only)                      │
│    - Model thinks/reasons about the task                         │
│    - Calls context_rebuild(analysis, plan, entities_needed)      │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│ 3. tool_call EVENT (intercept + rebuild)                         │
│    ├─ Store reasoning in ILO                                     │
│    ├─ Score context priority                                     │
│    ├─ Reconstruct context window from ILO                        │
│    └─ Unlock full tools                                          │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│ 4. LLM executes with full tools + rebuilt context                 │
│    System Prompt: [always present]                               │
│    Hard Rules:    [always present]                               │
│    Memory Context: [scored + ranked entities from ILO]           │
│    Session Actions: [compressed history, scored + ranked]        │
│    Raw Turns:     [last N (3-5) turns, full content]             │
│    Tools:         [full set]                                     │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│ 5. turn_end EVENT (store + learn)                                │
│    ├─ Extract entities, claims from turn                         │
│    ├─ Store in ILO graph                                         │
│    └─ Hebbian learning: update weights                           │
└──────────────────────────────────────────────────────────────────┘
```

## The Term Scoring Model

Each "term" is a piece of context that can be included or excluded.
Terms are: entities, claims, turns (compressed as Session Actions).

### Scoring Function

```
term_score = w₁ × recency + w₂ × relevance + w₃ × confidence + w₄ × frequency

Where:
  recency    = exp(-Δt / half_life)       # 90-day half-life (matches ILO)
  relevance  = cosine_sim(term_embed, query_embed)  # From ILO vector search
  confidence = ILO node confidence (0.0-1.0)        # Hebbian-learned
  frequency  = clamp(useful/retrieved, 0, 1)        # Beta prior from ILO
```

### Default Weights (starting point, tunable)

| Weight | Value | Rationale |
| -------- | :-----: | ----------- |
| w₁ (recency) | 0.3 | Recent context is more relevant |
| w₂ (relevance) | 0.4 | Semantic match to current task |
| w₃ (confidence) | 0.2 | Trusted facts should persist |
| w₄ (frequency) | 0.1 | Commonly used terms are important |

### Context Window Budget

```
262K total context window:

┌──────────────────────────────────────┬─────────┬────────┐
│ Section                              │  Tokens │ Always │
├──────────────────────────────────────┼─────────┼────────┤
│ System Prompt                        │    2,000│ ✅ Yes │
│ Hard Rules                           │    1,000│ ✅ Yes │
│ Memory Context (ranked entities)     │    5,000│  ⚠️  │
│ Session Actions (compressed turns)   │   10,000│  ⚠️  │
│ Raw Turns (last N)                   │   25,000│  ⚠️  │
│ Free / Response space                │  219,000│        │
├──────────────────────────────────────┼─────────┼────────┤
│ Total                                │  262,000│        │
└──────────────────────────────────────┴─────────┴────────┘
```

### What Goes Into Each Slot

#### Memory Context (up to 5K tokens)

Entities from ILO, scored and ranked by `term_score`:

```
## Memory Context
  - jwt_handler (0.95) — auth, tokens         [score: 0.87]
  - login_route (0.88) — routes, api          [score: 0.72]
  - src/auth.py (0.82) — file                 [score: 0.65]
  - ...
```

Takes top N entities until budget is exhausted.

#### Session Actions (up to 10K tokens)

Compressed turn history from ILO Turn nodes:

```
## Session Actions (8.2K tokens · 47 turns)

  T47: Now add refresh token support
    edited: src/auth.py (+15 lines · refresh token endpoint)
    entity: jwt_handler (0.92)
    ran: pytest (8/8 passed · 1.2s)

  T46: Update the frontend to use it
    read: src/frontend/auth.js (skimming · 200 lines)
    entity: auth_frontend (0.75)
    ...
```

Turns are scored by relevance to the current prompt, not just FIFO order.
If a turn from 30 steps ago is highly relevant, it stays.

#### Raw Turns (last 3-5, up to 25K tokens)

Full raw conversation for the most recent turns.
These are NOT scored — they're always the latest turns.

### The Priority Queue

```
         High Priority                          Low Priority
    ┌──────────┬──────────┬──────────┬──────────┬──────────┐
    │  Entity  │  Entity  │   Turn   │   Turn   │  Entity  │
    │ score=0.9│ score=0.8│ score=0.7│ score=0.3│ score=0.1│
    ├──────────┴──────────┴──────────┴──────────┴──────────┤
    │                 Token budget limit                    │
    └──────────────────────────────────────────────────────┘
    
    Included in context ──────────┤ Excluded (in ILO only)
```

Terms above the budget threshold stay in context.
Terms below it are only accessible via `memory_search` tool.

## Example: The Flow in Detail

### User sends

```
"Add JWT auth to the Flask app"
```

### Step 1: `context` event gates tools

Only `context_rebuild` is available. Model processes:

- System prompt: base system + hard rules
- Memory Context: current entities from ILO
- User message: "Add JWT auth to the Flask app"
- Tools: [context_rebuild]

### Step 2: Model calls `context_rebuild`

```json
{
  "analysis": "User wants JWT auth for a Flask app. I need to...",
  "plan": "1. Check existing routes\n2. Add auth middleware\n3. Add login endpoint",
  "entities_needed": ["src/routes.py", "src/models.py", "flask_jwt_extended"]
}
```

### Step 3: `tool_call` intercepts, rebuilds context

1. Stores analysis + plan in ILO
2. Queries ILO for relevant entities:
   - `src/routes.py` (relevance: 0.92) → score: 0.88 → INCLUDED
   - `src/models.py` (relevance: 0.85) → score: 0.82 → INCLUDED
   - `src/config.py` (relevance: 0.70) → score: 0.68 → INCLUDED
   - `src/auth.py` (relevance: 0.45) → score: 0.52 → INCLUDED
   - `old_feature_x` (relevance: 0.10) → score: 0.15 → DROPPED
3. Gets recent 3 raw turns (already in context)
4. Gets compressed turns from ILO, scores and ranks
5. Unlocks full tool set

### Step 4: Model executes with rebuilt context

Full context window:

```
System Prompt
Hard Rules
Memory Context (entities scored and ranked)
Session Actions (compressed turn history)
Raw Turns (last 3)
User message
Tools: [read, bash, edit, write, ...]
```

### Step 5: Turn ends, ILO stores everything

`turn_end` fires, extracts entities and claims, stores in ILO.

## Implementation Plan

### Files to create/modify

1. **`benchmark/test_context_rebuild.py`** — Full end-to-end test
2. **`.pi/extensions/core/lib/context-rebuild.ts`** — Core logic:
   - `scoreTerm()` — scoring function
   - `reconstructContext()` — build context window from ILO
   - `prioritizeQueue()` — ranked priority queue
3. **`.pi/extensions/core/events/context.ts`** — Modify to:
   - Add tool gating phase
   - Call `reconstructContext()` after `context_rebuild`
4. **`.pi/extensions/core/tools/context-rebuild.ts`** — Tool definition

### Test Plan

1. Unit test scoring function (known inputs → expected rankings)
2. Integration test (full cycle with Qwen3.6-35B-A3B)
3. Ablation benchmark (compare against FIFO-only and pi compaction)
4. Long session test (50+ turns, verify context window stays under budget)
