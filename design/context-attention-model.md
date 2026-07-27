# Context Attention Model

## The Core Idea

Apply **Transformer-style multi-head attention** to the memory/context system.
Instead of a linear scoring function, each memory term competes for attention
from the current query, and the context window is the softmax-weighted output.

## Why This Maps

In a Transformer:

```
Attention(Q, K, V) = softmax(Q · K^T / √d) · V
```

| Transformer Concept | Context Rebuild Equivalent |
| --------------------- | --------------------------- |
| **Q** (Query) | Current user prompt + model's analysis from `context_rebuild` |
| **K** (Key) | Each memory term's metadata (embedding, type, recency, confidence) |
| **V** (Value) | The actual content to include (entity text, turn summary, claim) |
| **Attention score** | How relevant each memory term is to the current task |
| **Softmax** | Competition — only the most relevant terms fill the budget |
| **Multi-head** | Different attention heads for different memory types |

## Multi-Head Attention Over Memory

Instead of one scoring function, we have **multiple heads** that each
look at the same query from a different perspective:

```
                    ┌─────────────────────────────┐
                    │     QUERY (current task)     │
                    │  "Add JWT auth to Flask app" │
                    │  + model's analysis from     │
                    │    context_rebuild tool      │
                    └──────────┬──────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ HEAD 1           │ │ HEAD 2           │ │ HEAD 3           │
│ ENTITY ATTENTION │ │ TURN ATTENTION   │ │ CLAIM ATTENTION  │
│                  │ │                  │ │                  │
│ Q·K_entity       │ │ Q·K_turn         │ │ Q·K_claim        │
│ → entity scores  │ │ → turn scores    │ │ → claim scores   │
└────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                              ▼
                    ┌─────────────────────────────┐
                    │  CONCATENATE + RANK          │
                    │  Fill context budget (42K)   │
                    │  ┌───────────────────────┐  │
                    │  │ Entity A  (score 0.92)│  │
                    │  │ Turn 47  (score 0.87)│  │
                    │  │ Entity B  (score 0.81)│  │
                    │  │ Claim X  (score 0.76)│  │
                    │  │ Turn 12  (score 0.70)│  │
                    │  │ ...budget cap...     │  │
                    │  └───────────────────────┘  │
                    └─────────────────────────────┘
```

## The Heads

### Head 1: Entity Attention

**What it looks for:** Which known entities are relevant?
**Key space:** Entity embeddings + tags + confidence
**Query:** Current prompt + analysis
**Output:** Ranked entities for Memory Context section

```
entity_score = softmax(Q_embed · entity_embed / τ) × entity_confidence
```

### Head 2: Turn Attention

**What it looks for:** Which past turns inform this task?
**Key space:** Turn embeddings (user goal + tools used + entities touched)
**Query:** Current prompt + analysis
**Output:** Ranked compressed turns for Session Actions section

### Head 3: Claim Attention

**What it looks for:** Which stored facts/relationships matter?
**Key space:** Claim embeddings
**Query:** Current prompt + analysis
**Output:** Ranked claims to inject

### Head 4: File Attention (optional)

**What it looks for:** Which files are relevant based on history?
**Key space:** File paths + their last-modified turns
**Query:** Current prompt + analysis
**Output:** File suggestions

## The Q, K, V Construction

### Query (Q)

Built from two sources:

1. **User's raw prompt** — what they just asked
2. **Model's analysis** — from `context_rebuild` tool call's analysis field

Combined into one query embedding via ILO's BGE embedder.

### Keys (K)

Each memory term stores its own embedding (computed when stored):

```
Entity key  = embed(entity_label) ⊕ [recency, confidence, frequency]
Turn key    = embed(turn_goal)    ⊕ [recency, tool_count, success_rate]
Claim key   = embed(claim_text)   ⊕ [recidence, confidence]
```

### Values (V)

The actual content to include:

```
Entity value = "entity_name (confidence) — tags"
Turn value   = "T{N}: goal\n  tool: target\n  entity: entity"
Claim value  = "subject link_type object (confidence)"
```

## Temperature and Competition

The `τ` (temperature) parameter controls how aggressively the attention
focuses on the top items:

| τ | Behavior | Use Case |
| --- | --- | --- |
| τ → 0 | Argmax — only the single most relevant item | Minimal context, focused task |
| τ = 1.0 | Default softmax — proportional distribution | General use |
| τ → ∞ | Uniform — all items equally likely | Exploration mode |

## Implementation

The ILO server already does this! Its retrieval algorithm:

```
score = energy × link_weight × confidence × label_sim × direction / fanout
```

This is effectively an attention mechanism over the graph. The extension
just needs to:

1. Build the query from user prompt + context_rebuild analysis
2. Call ILO search with the query
3. Get scored, ranked results
4. Fill the context budget

### Code sketch

```typescript
async function attend(query: string, heads: AttentionHead[]): Promise<ScoredTerm[]> {
  const queryEmbed = await ilo.embed(query, { isQuery: true });

  const results = await Promise.all(heads.map(head =>
    head.attend(queryEmbed)
  ));

  // Flatten, deduplicate, rank globally
  const combined = results.flat();
  const ranked = combined.sort((a, b) => b.score - a.score);

  // Fill budget
  const budget = 42000; // tokens
  const context: ScoredTerm[] = [];
  let used = 0;

  for (const term of ranked) {
    if (used + term.tokens > budget) break;
    context.push(term);
    used += term.tokens;
  }

  return context;
}
```

## Benefits Over Linear Scoring

| Aspect | Linear Score | Attention Model |
| -------- | :------------: | :---------------: |
| Query-aware | ❌ Fixed weights | ✅ Dynamic per query |
| Competition | ❌ Independent | ✅ Softmax competition |
| Multi-aspect | ❌ Single score | ✅ Multi-head |
| Temperature control | ❌ None | ✅ τ parameter |
| Content-type routing | ❌ Mixed | ✅ Separate heads |
| Graceful degradation | ❌ Hard cutoff | ✅ Soft probability |
