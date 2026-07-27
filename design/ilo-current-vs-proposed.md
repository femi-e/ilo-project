# ILO Architecture — Current vs Proposed

## 1. Context Window Composition

### Current

```
SYSTEM PROMPT (pi default + ILO injections + tools + rules)
    └── All baked into one block via before_agent_start

CONVERSATION HISTORY (all turns, grows unbounded)
    ├── user messages
    ├── assistant messages (text + tool calls)
    └── tool results
    
MEMORY CONTEXT (top 5 entities from ILO search)
    └── Injected into system prompt

CURRENT USER PROMPT
```

### Proposed

```
SYSTEM PROMPT (custom, consolidated, always pinned)

CONVERSATION (scored queue, always-run eviction)
    ├── Turns (full content, scored individually)
    ├── Memory chunks (role: "memory", compete with turns)
    │   ├── Entities with link summaries
    │   └── Claims with categories
    └── All scored by: weight × confidence × direction

CURRENT USER PROMPT (always pinned)
```

## 2. Entity/Claim Extraction

### Current

```rust
// Rust heuristic (extract.rs):
tokenize → gazetteer match → pattern match → claim extraction
  - 5 hardcoded link patterns
  - Flat confidence (0.30 for everything)
  - No entity types
  - No semantic understanding
  - 0 claims extracted from real conversation tests
```

### Proposed

```typescript
// LLM extraction (via context_rebuild tool):
{
  extracted_entities: [
    { name: "jwt_handler", type: "component", confidence: 0.95, tags: ["auth"] }
  ],
  extracted_claims: [
    { subject: "login_route", relationship: "depends_on", 
      object: "jwt_handler", category: "Depends", confidence: 0.95 }
  ]
}
  - Semantic understanding
  - Entity types (component, tool, concept, etc.)
  - 7 relationship categories
  - Confidence 0.85-0.98 vs flat 0.30
  
Rust extractor → fallback only (LLM unavailable / API calls)
```

## 3. Link Type System

### Current

```rust
enum LinkType {
    Relates,      // generic, meaningless
    Depends,      // one of 8 equally vague types
    Contradicts,  // barely used
    Refutes,      // barely used
    Contains,     // overlaps with Relates
    Supports,     // overlaps with Relates
    Mentions,     // structural (turn→entity)
    Precedes,     // structural (turn→turn)
}
// 8 types, no semantic grounding, no raw string preserved
// Not used in scoring formula
```

### Proposed

```rust
enum LinkType {
    Depends,     // A requires B, A uses B
    Intends,     // user wants to X, user aims to X
    Implements,  // A creates B, A builds B
    Contains,    // A contains B, A is part of B
    Relates,     // A is similar to B
    References,  // A calls B, A references B
    Precedes,    // A precedes B (temporal)
}
// 7 categories, validated against 150 real queries (100% coverage)
// Raw relationship string preserved alongside category
// Categories determine attention head routing, NOT scoring

struct LinkRecord {
    id: String,
    from: String,
    to: String,
    type_: LinkType,         // one of 7 categories
    relationship: String,    // raw: "depends on" (empty for structural)
    tags: Vec<String>,
    weight: f64,
    confidence: f64,         // from LLM extraction
    created_at: NaiveDateTime,
}
```

## 4. Two-Turn Pattern (context_rebuild)

### Current

```
Doesn't exist. No gating, no reasoning phase, no self-guided eviction.
Pi's compaction is the only context management (lossy, FIFO).
```

### Proposed

```
TURN 1: REASON
  Tools available: [context_rebuild only]
  Model calls context_rebuild(analysis, plan, chunk_scores, 
                              extracted_entities, extracted_claims)
  → Model tells us what's relevant + extracts knowledge

EVICTION
  Extension re-scores all chunks against model's analysis
  Evicts lowest-scored if over budget
  Stores entities/claims in ILO with 7-category links

TURN 2: EXECUTE
  Tools available: [full set]
  Cleaner context, relevant chunks only
  Model executes with full tool access
```

## 5. Scored Turn Queue

### Current

```
Built-in pi compaction:
  - FIFO: oldest turns dropped when nearing limit
  - Lossy: summarizes old turns (free-text)
  - No scoring, no resurrection
```

### Proposed

```
Always-run scored queue:
  - All chunks compete equally (turns, memory, entities)
  - Score = weight × confidence × direction (standard formula)
  - Lowest-scored evicted when over ~80K budget
  - Old turns can resurrect via ILO if relevant again
  - Always-run: never reaches dumb zone
```

## 6. Cross-Session

### Current

```
No cross-session capability.
Each session starts fresh. ILO stores entities but they aren't
actively pulled into new sessions.
```

### Proposed

```
New session starts:
  → ILO searches all past sessions for relevant entities
  → Entities with high relevance get pulled into memory context
  → Links from past sessions show dependency chains
  → Full turns from past sessions available if relevance > threshold
```

## 7. Memory Role

### Current

```
Memory context injected into system prompt via before_agent_start.
Not stored as messages. Not scored. Never evicted.
```

### Proposed

```
Memory chunks stored as custom role: "memory" messages.
Converted to role: "system" at provider boundary.
Compete with turns in the scored queue.
Can be evicted when low-scored.
```

## Implementation Order

```
1. types.rs — new LinkType enum, LinkRecord with relationship field
2. store.rs — find_links filter changes to &str
3. ladybug.rs — Cypher queries updated
4. helpers.rs — use new LinkType values
5. extract.rs — demote to fallback
6. handlers.rs — accept LLM extraction format
7. retrieval.rs — minimal changes (filter param only)
8. Pi extension — context_rebuild tool with extraction fields
9. Pi extension — scored turn queue
10. Pi extension — memory role messages
```
