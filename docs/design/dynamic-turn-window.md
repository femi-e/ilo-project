# Dynamic Turn Window — The Shifting Sequence

## Core Concept

Each turn is a unit in a shifting sequence. The context window is a
priority queue of turns. When budget is exceeded, the lowest-scored turn
gets evicted — no compression, no lossy summaries, just full turns that
naturally fall out when they're no longer valuable.

```
Context Window (priority queue, sorted by score):
┌──────────────────────────────────────────────────────┐
│  Turn │ Content          │ Score │ Why It Stays      │
├──────────────────────────────────────────────────────┤
│  T-0  │ System Prompt    │  ∞    │ Always pinned     │
│  T-1  │ Hard Rules       │  ∞    │ Always pinned     │
│  T-2  │ Latest turn      │ 0.95  │ Newest + relevant │
│  T-3  │ 2nd latest       │ 0.82  │ Recent            │
│  T-4  │ Old relevant     │ 0.78  │ High relevance    │
│  T-5  │ 3rd latest       │ 0.71  │ Recent            │
│  T-6  │ 4th latest       │ 0.55  │ Recent            │
│  T-7  │ Old turn #2      │ 0.32  │ Low score, stale  │
├──────────────────────────────────────────────────────┤
│  BUDGET LINE ── 262K tokens ──────────────────────    │
│  T-8  │ Old turn #3      │ 0.12  │ EVICTED           │
│  T-9  │ Earliest turn    │ 0.05  │ EVICTED           │
└──────────────────────────────────────────────────────┘
```

## What Changes

| Aspect | Current (FIFO) | Proposed (Scored Queue) |
| -------- | :--------------: | :----------------------: |
| Eviction policy | Oldest first | Lowest score first |
| Compression | Lossy (Session Actions) | None (full turns) |
| Session file usage | Only source | Source + ILO scoring |
| Cross-session | None | ILO bridges sessions |
| Window shape | Fixed (last N) | Dynamic (best N) |

## The Turn Structure

```typescript
interface ScoredTurn {
  id: string;
  type: "turn" | "entity" | "claim" | "system" | "rule";
  content: string;         // Full lossless content
  recency: number;         // 0.0-1.0 (newest = 1.0)
  relevance: number;       // 0.0-1.0 (from ILO search)
  confidence: number;      // 0.0-1.0 (from ILO)
  session_id: string;
  turn_index: number;
  timestamp: number;
  entities: string[];
  tools_used: string[];
}
```

## Scoring Function

```
turn_score = w₁ × recency + w₂ × relevance + w₃ × confidence

  w₁ = 0.4  (recency)
  w₂ = 0.4  (relevance)
  w₃ = 0.2  (confidence)
```

### Recency

```
recency = exp(-Δt / half_life)
half_life = 30 minutes
```

| Age | Recency |
| ----- | :-------: |
| 1 min | 0.98 |
| 5 min | 0.85 |
| 30 min | 0.37 |
| 2 hrs | 0.02 |

### Relevance

ILO searches the turn's content against the current query.
An old turn about JWT scoring 0.92 relevance when the query is
"add token refresh" — even 50 turns later.

## Eviction Policy

```
1. New turn arrives
2. Add to queue
3. Re-score ALL turns against current query
4. If over budget → evict lowest-scored turn
5. Repeat until within budget
```

## Example

```
Turn 1: "Add JWT auth"              → Queue: [T1(0.95)]
Turn 2: "Design user model"         → Queue: [T2(0.92), T1(0.88)]
Turn 3: "Login endpoint"            → Queue: [T3(0.94), T1(0.85), T2(0.80)]
...
Turn 25: "Fix the JWT refresh"      → ILO finds T1(rel=0.95), T3(rel=0.85)
                                   → Queue: [T25(0.95), T1(0.92), T3(0.88)]
                                   → T2-T22 evicted (low recency + low relevance)
```

Old JWT turns **resurrect** because they're relevant again.
Deployment turns fall out because they're no longer needed.

## Cross-Session

New session starts:

1. ILO searches all past sessions for relevant turns
2. High-scoring turns get pulled in with full content
3. Low-scoring turns => only the entity stays (lightweight)

## Related Research

See design/context-attention-model.md for the multi-head attention
mapping (entities, turns, claims, files as separate attention heads
over the ILO graph).
