# Context Rebuild System

## Two-Turn Pattern

Every user request follows a two-turn execution cycle.

### Turn 1: Reason

The model receives the system prompt, scored context queue, dashboard, and user prompt. Only the `context_rebuild` tool is available.

```
System Prompt (collaborative personal assistant)
Memory Context (high-confidence entities)
Scored Queue (turns + memory chunks)
Dashboard:
  Window: 45,231 / 100,000 (45%)
  Chunks:
    [turn_47]   turn  0.92
    [mem_jwt]   entity  0.88
    [turn_12]   turn  0.31
    [mem_ci_cd] entity  0.12

User: "I need to fix the refresh token endpoint."

Tools: [context_rebuild]
```

The model calls `context_rebuild` with:

```typescript
{
  analysis: "The user wants to fix the refresh token endpoint...",
  plan: "1. Check jwt_handler\n2. Update refresh logic\n3. Test",
  chunk_scores: {
    "turn_47": 0.95,
    "mem_jwt": 0.90,
    "turn_12": 0.30,  // less relevant
    "mem_ci_cd": 0.05 // evict this
  },
  extracted_entities: [
    { name: "refresh_token", type: "component", confidence: 0.95 },
    { name: "jwt_handler", type: "component", confidence: 0.92 }
  ],
  extracted_claims: [
    {
      subject: "refresh_token",
      relationship: "depends_on",
      object: "jwt_handler",
      category: "Depends",
      confidence: 0.95
    }
  ]
}
```

### Turn 2: Execute

The extension stores the extracted entities/claims, re-scores all chunks, evicts low-scored ones, and unlocks full tools. The model proceeds with a cleaner context.

```
System Prompt (same)
Memory Context (updated with new entities)
Scored Queue (re-scored, low chunks evicted):
  [turn_47]   turn  0.95
  [mem_jwt]   entity  0.92
  [mem_refresh] entity  0.88  (new)
  --- mem_ci_cd evicted ---
  --- turn_12 evicted ---

User: "I need to fix the refresh token endpoint."

Tools: [full set: memory_search, memory_store, web_search, ...]
```

## Scoring Formula

All chunks in the queue use a single scoring formula:

```
score = (0.5 × model_score) + (0.3 × recency) + (0.2 × entity_overlap)
```

| Component | Weight | Source | Behavior |
| ----------- | :------: | -------- | ---------- |
| model_score | 0.5 | context_rebuild | Model's own relevance judgment |
| recency | 0.3 | `exp(-Δt / 3600)` | 60-minute half-life |
| entity_overlap | 0.2 | ILO query | Fraction of entities still active in memory |

### Example

| Chunk | Model Score | Recency | Overlap | Final | Status |
| ------- | :-----------: | :-------: | :-------: | :-----: | :------: |
| "Fixed JWT" (5 min) | 0.92 | 0.94 | 0.85 | 0.91 | Kept |
| "Added tests" (15 min) | 0.85 | 0.84 | 0.80 | 0.84 | Kept |
| "CI/CD setup" (20 min) | 0.12 | 0.79 | 0.10 | 0.30 | Evicted |
| "User model" (45 min) | 0.78 | 0.53 | 0.65 | 0.68 | Kept |
| "Initial setup" (2 hrs) | 0.05 | 0.14 | 0.00 | 0.07 | Evicted |

## Dashboard Format

Shown to the model during the context_rebuild phase only. Provides context window awareness.

```
Window: 45,231 / 100,000 (45%)

Chunks:
  [turn_47]     turn      0.92
  [mem_jwt]     entity    0.88
  [mem_auth]    claim     0.85
  [turn_46]     turn      0.72
  [turn_12]     turn      0.31
  [mem_ci_cd]   entity    0.12
```

The dashboard is trimmed to show only what the model actually uses: chunk ID, type, and current score. ~2K tokens overhead for ~80 chunks.

## Eviction Policy

- **Trigger**: Always on — every turn, check if over budget
- **Budget**: 40% of model's raw context window (capped at 100K)
- **Action**: Evict lowest-scored chunks until within budget
- **Pattern**: Gradual — usually 1-3 chunks per turn in deep sessions
- **Resurrection**: Evicted entities stay in ILO; if relevant again, they score high and re-enter

## Prompt Caching

Stable prefix (system prompt + pinned entities) gets cached. The scored queue and dashboard are in the fresh tail.

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
