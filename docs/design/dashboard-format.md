# Dashboard Format — What The Model Sees About Its Context

## Purpose

The model is blind to its own context size, structure, and composition.
The dashboard gives it explicit metadata so it can make informed
relevance scoring decisions during context_rebuild.

## Format

Injected into the user prompt alongside the user's message,
before the model calls context_rebuild:

```
## Context Dashboard

Window: 45,231 / 100,000 tokens used (45%)

Chunks:
  [mem_e_jwt_handler]     entity    320 tok  age: 12min  entities: 2    score: 0.92
  [mem_c_auth_dep]        claim     180 tok  age: 12min  entities: 2    score: 0.88
  [turn_47]               turn     2,100 tok age: 3min   tools: bash    score: 0.85
  [turn_46]               turn     1,800 tok age: 8min   tools: read    score: 0.72
  [turn_45]               turn     1,500 tok age: 15min  tools: edit    score: 0.55
  [turn_12]               turn     2,400 tok age: 48min  tools: search  score: 0.31
  [mem_e_ci_cd]           entity    280 tok  age: 2h     entities: 3    score: 0.12
```

## Fields

| Field | Meaning | Example |
| ------- | --------- | --------- |
| Chunk ID | Unique identifier | `turn_47`, `mem_e_jwt_handler` |
| Type | turn, entity, claim | `entity`, `turn` |
| Size | Token count | `2,100 tok` |
| Age | Time since creation | `3min`, `48min`, `2h` |
| Entities | Entity count (turns) | `entities: 2` |
| Tools | Tools used (turns) | `tools: bash` |
| Score | Current relevance score | `score: 0.92` |

## When It's Shown

The dashboard is shown in the context_rebuild prompt:

- Every turn, so the model can re-score chunks
- Not shown during execution phase (Turn 2)
- Only chunks in the current context window, not everything in ILO

## The context_rebuild Prompt

```
## Context Dashboard
{ dashboard }

## Current Task
{ user's message }

Evaluate each chunk's relevance and call context_rebuild with:
- chunk_scores: { "turn_47": 0.95, "mem_e_jwt_handler": 0.90, ... }
- extracted_entities: [...]
- extracted_claims: [...]
```

## Models Uses The Dashboard To

1. See how full the window is (45% → no pressure, 85% → evict aggressively)
2. See which chunks are old/stale (age: 2h → may be irrelevant)
3. See which chunks have high entity overlap with current task
4. Score each chunk for relevance
5. Identify entities and claims that should be stored

## Why Not Show Everything

The dashboard is compact by design:

- One line per chunk (~80 chars)
- At ~80K budget with ~1K avg chunk → ~80 lines → ~6K tokens
- This is worth the cost — without it the model is blind
