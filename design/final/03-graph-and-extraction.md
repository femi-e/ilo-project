# Graph Model and Extraction System

## ILO Graph Schema

### Nodes

| Type | Purpose | Key Fields |
| ------ | --------- | ------------ |
| `Entity` | People, projects, topics, tasks, tools, files | id, label, confidence, tags, embedding |
| `Claim` | Statements about entities and their relationships | id, label (the claim text), confidence |
| `Turn` | Conversation turns | id, turn_index, user_text, response_text, model, tokens_in, tokens_out |

### Links

```rust
struct LinkRecord {
    id: LinkId,
    from: NodeId,
    to: NodeId,
    type_: LinkType,         // One of 7 categories
    relationship: String,    // Raw string: "depends on", "wants to fix"
    tags: Vec<String>,
    weight: f64,             // Hebbian-learned
    confidence: f64,         // From LLM extraction
    created_at: NaiveDateTime,
}
```

### Link Type Taxonomy

7 categories, validated against 150 real queries (100% coverage, 0.79 test-retest reliability).

| Category | Meaning | LLM Relationship Strings | Example |
| ---------- | --------- | -------------------------- | --------- |
| `Depends` | A requires B | depends on, uses, requires, needs | `login_route depends_on jwt_handler` |
| `Intends` | User wants to X | wants to, aims to, needs to, plans to | `user wants to fix refresh token` |
| `Implements` | A creates B | implements, creates, builds, writes, sets up | `assistant implements jwt_handler` |
| `Contains` | A contains B | contains, has, is part of, belongs to | `project contains auth module` |
| `Relates` | A is similar to B | is similar to, is related to, connects to | `sliding_window relates to FIFO` |
| `References` | A calls B | calls, invokes, references, mentions | `agent calls context_rebuild` |
| `Precedes` | A happens before B | precedes, follows, happens before | `setup precedes deployment` |

### Structural Links (Separate System)

These links track provenance and ordering. They are handled deterministically by the extension, not extracted by the LLM.

| Category | Source | Purpose |
| ---------- | -------- | --------- |
| Turn → Entity (auto) | Extension | Which turn mentions which entity |
| Turn → Turn (auto) | Extension | Temporal ordering of turns |
| Claim → Entity (auto) | Extension | Which entities a claim references |

### Link Categories vs Scoring

Categories are used for **attention head routing**, not scoring.

- All links use the same scoring formula: `weight × confidence × direction`
- Categories determine which attention head fires during context reconstruction
- The raw `relationship` string is preserved for queryability and debugging
- Per-category scoring is deferred — can be added later if data shows it would help

### Category Distribution (from validation)

| Category | Usage | Head Weight |
| ---------- | :-----: | :-----------: |
| Intends | 58.8% | 0.58 |
| Depends | 14.1% | 0.14 |
| Contains | 9.6% | 0.10 |
| Relates | 6.4% | 0.06 |
| References | 3.9% | 0.04 |
| Implements | 3.5% | 0.04 |
| Precedes | 3.5% | 0.04 |

## Entity Extraction

### Primary Path: LLM (via context_rebuild)

The LLM extracts entities and claims during the context_rebuild call. This replaces the Rust heuristic as the primary extraction path.

```typescript
// From context_rebuild tool output:
{
  extracted_entities: [
    { name: "refresh_token", type: "component", confidence: 0.95, tags: ["auth"] }
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

### Fallback Path: Rust Heuristic

The Rust heuristic extractor (in `extract.rs`) runs when:

- The LLM is unavailable
- The request comes from outside the agent (direct API calls)
- As a secondary pass to catch entities the LLM missed in tool output text

### Heuristic Fallback (Future Concept)

Track LLM extraction decisions into a training dataset. This data can later be used to build a rule-based heuristic that approximates the LLM's judgment, enabling the system to function when the LLM is unavailable. Not implemented now.

## User Entity

An explicit `Entity` node for the user is created on first session and persists across all sessions.

```
Node: { type: Entity, label: "user", confidence: 1.0, tags: ["user", "persistent"] }
```

All `Intends` links flow from this node:

```
user --[Intends]--> refresh_token
user --[Intends]--> jwt_handler  
user --[Intends]--> setup_project
```

This enables the system to track the user's current goals across topic shifts and sessions. Old Intends links decay naturally via the scoring formula's recency component.

## Memory Chunks as Custom Role

Memory chunks (entities + claims) are injected into the conversation history as custom `role: "memory"` messages.

```typescript
// Internal representation (pi session):
{
  role: "memory",
  content: "## Memory Context\n- jwt_handler (0.95) — handles JWT tokens\n- user intends to fix refresh_token",
  customType: "memory_context"
}

// Converted at provider boundary (before_provider_request):
{
  role: "system",
  content: "[Memory Context]\n## Memory Context\n- jwt_handler (0.95) — handles JWT tokens\n- user intends to fix refresh_token"
}
```

Memory chunks compete with turns in the scored queue and can be evicted when low-scored. They are not pinned.

## Graph Traversal

### Current Algorithm (unchanged)

The 3-factor PPR retrieval algorithm follows all links from seed nodes, scoring by:

```
propagation = energy × link.weight × node.confidence × label_similarity × direction / fanout
```

### Category Filtering (new)

The `find_links()` method can optionally filter by category:

```rust
// Follow all links (default, same as current)
find_links(node_id, None)

// Follow only dependency links
find_links(node_id, Some("Depends"))

// Follow only intent links
find_links(node_id, Some("Intends"))
```

Default behavior is unchanged: `None` returns all links.
