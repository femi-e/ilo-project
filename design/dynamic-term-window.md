# Dynamic Term Window — The Shifting Sequence

## Core Concept

Each turn is a **term** in a shifting sequence. The context window is a
priority queue of terms. When budget is exceeded, the lowest-scored term
gets evicted — no compression, no lossy summaries, just full turns that
naturally fall out when they're no longer valuable.

```
Context Window (priority queue, sorted by score):
┌──────────────────────────────────────────────────────┐
│  Term  │ Content          │ Score │ Why It Stays      │
├──────────────────────────────────────────────────────┤
│  T-0   │ System Prompt    │  ∞    │ Always pinned     │
│  T-1   │ Hard Rules       │  ∞    │ Always pinned     │
│  T-2   │ Latest turn      │ 0.95  │ Newest + relevant │
│  T-3   │ 2nd latest       │ 0.82  │ Recent            │
│  T-4   │ Old relevant     │ 0.78  │ High relevance    │
│  T-5   │ 3rd latest       │ 0.71  │ Recent            │
│  T-6   │ 4th latest       │ 0.55  │ Recent            │
│  T-7   │ Old turn #2      │ 0.32  │ Low score, stale  │
├──────────────────────────────────────────────────────┤
│  BUDGET LINE ── 262K tokens ──────────────────────    │
│  T-8   │ Old turn #3      │ 0.12  │ ❌ EVICTED        │
│  T-9   │ Earliest turn    │ 0.05  │ ❌ EVICTED        │
└──────────────────────────────────────────────────────┘
```

## What Changes vs Your Existing Architecture

| Current (FIFO + Session Actions) | Proposed (Scored Term Queue) |
| ---------------------------------- | ------------------------------ |
| Drops oldest turns regardless | Drops LOWEST-SCORED turns |
| Compresses old turns (lossy) | Keeps full turns (lossless) |
| Session Actions is extra work | No compression needed |
| Session file is only source | ILO is the scoring oracle |
| No cross-session awareness | ILO scores across sessions |
| Fixed window (last N turns) | Dynamic window (best N terms) |

## The Term Structure

Each term in the queue:

```typescript
interface Term {
  id: string;              // Unique ID
  type: "turn" | "entity" | "claim" | "system" | "rule";
  content: string;         // Full content (lossless)
  
  // Scoring metadata
  recency: number;         // 0.0-1.0 (newest = 1.0)
  relevance: number;       // 0.0-1.0 (from ILO search)
  confidence: number;      // 0.0-1.0 (from ILO Hebbian learning)
  
  // Cross-session metadata
  session_id: string;      // Which session it came from
  turn_index: number;      // Turn number within that session
  timestamp: number;       // When it was created
  
  // Entity links
  entities: string[];      // Entities this term references
  tools_used: string[];    // Tools used in this term
}
```

## Scoring Function

```
term_score = w₁ × recency + w₂ × relevance × w₃ × confidence

Defaults (starting point):
  w₁ = 0.4  (recency — recent turns are usually relevant)
  w₂ = 0.4  (relevance — semantic match to current task)
  w₃ = 0.2  (confidence — ILO's learned importance)
```

### Recency Computation

```
recency = exp(-Δt / half_life)

Δt = time since this term was added
half_life = 30 minutes (tunable)
```

A turn from 30 minutes ago scores 0.37.
A turn from 5 minutes ago scores 0.85.
A turn from 2 hours ago scores 0.02.

### Relevance Computation

When a new query arrives, ILO searches across ALL terms:

```
relevance = ilo.search(current_query, terms)
```

This means an old turn about JWT auth gets HIGH relevance when the
current query is "add token refresh" — even if it's 50 turns old.

## The Eviction Policy

```
1. New term arrives (user sends prompt)
2. Add term to queue
3. Calculate score for ALL terms based on current query
4. If total tokens > budget:
     Sort terms by score (ascending)
     Remove lowest-scored term
     Repeat until within budget
5. Re-sort by natural order for LLM consumption
```

### Example Over Time

```
Turn 1: "Add JWT auth"              → Queue: [T1] (score 0.95)
Turn 2: "Design the user model"     → Queue: [T2(0.92), T1(0.88)]  
Turn 3: "Write the login endpoint"  → Queue: [T3(0.94), T1(0.85), T2(0.80)]
Turn 4: "Add role-based permissions" → Queue: [T4(0.93), T3(0.82), T1(0.78), T2(0.72)]
Turn 5: "Set up CI/CD pipeline"     → Queue: [T5(0.91), T4(0.80), T3(0.75), T1(0.70), T2(0.60)]
                                     ↑ T2 is now lowest → stays but at bottom

... 20 turns later about deployment ...

Turn 25: "Actually, let's fix the JWT refresh" 
         → ILO search returns T1(relevance=0.95) and T3(relevance=0.85)
         → Queue: [T25(0.95), T1(0.92), T3(0.88), T24(0.72), T23(0.65)]
         → T2 through T22 are evicted (low recency AND low relevance)
```

The old JWT turns **resurrect** because they're relevant to the new query —
even though they're 24 turns old. The deployment turns fall out because
they're no longer relevant.

## Cross-Session Integration

When starting a NEW session:

```
1. User types first prompt
2. ILO.search(query) returns relevant entities from ALL past sessions
3. These entities get scored and added to the term queue
4. If relevant enough, full turn content is pulled from the session file
5. If not relevant enough (score below threshold), only the entity stays

Cross-session terms have lower recency but potentially high relevance:
  term_score = 0.4 × 0.01 + 0.4 × 0.92 + 0.2 × 0.85 = 0.57
               (low recency)  (high relevance)  (good confidence)
```

## Implementation Sketch

```typescript
class TermWindow {
  private terms: Term[];
  private budget: number = 200_000; // tokens
  private weights = { recency: 0.4, relevance: 0.4, confidence: 0.2 };

  async addTerm(newTerm: Term, currentQuery: string) {
    this.terms.push(newTerm);
    
    // Re-score all terms against current query
    const queryEmbed = await ilo.embed(currentQuery, { isQuery: true });
    for (const term of this.terms) {
      const relevance = await ilo.searchRelevance(queryEmbed, term.id);
      const recency = this.computeRecency(term.timestamp);
      term.score = (
        this.weights.recency * recency +
        this.weights.relevance * relevance +
        this.weights.confidence * term.confidence
      );
    }

    // Evict lowest-scored until within budget
    while (this.totalTokens() > this.budget) {
      this.terms.sort((a, b) => a.score - b.score);
      this.terms.shift(); // Remove lowest
    }
  }

  getContext(): string {
    // Return terms in natural order for the LLM
    return this.terms
      .sort((a, b) => b.turn_index - a.turn_index)
      .map(t => t.content)
      .join('\n');
  }
}
```

## What This Solves

| Problem | How |
| --------- | ----- |
| Context window overflow | Evict lowest-scored terms, not just oldest |
| Lossy compression | Never compress — just keep/evict whole terms |
| Cross-session memory | ILO search finds relevant terms from any session |
| Dynamic relevance | Terms rescore on every new query |
| Natural forgetting | Old irrelevant terms decay via recency + low relevance |
| Topic shifts | Old topic terms stay but drop as new topics dominate |
| Topic resurrections | When old topic returns, ILO brings relevant terms back |
