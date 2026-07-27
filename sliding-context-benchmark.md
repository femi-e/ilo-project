# Sliding Context Benchmark: Research-Backed Design

## Research Foundation

### Key Papers & Tools

| Source | Key Insight | What We Borrow |
| -------- | ------------- | ---------------- |
| **Solo.io: Compression vs Compaction** | Compaction throws data away. True compression preserves structure. | Structured state (C) is compression, not compaction. |
| **LoCoBench-Agent** | 8K interactive scenarios across 10 languages. Multi-turn eval. | Test structure: turn extraction → context injection → scoring. |
| **LongMemCode** | Benchmarks memory systems for coding agents specifically. | Our task design: completion, bug fix, refactor, feature add. |
| **U-Fold** | Identifies failure modes: constraints and intermediate facts get lost. | Our tests explicitly check for these failure modes. |
| **STAE** | Semantic-temporal hybrid eviction: score by importance + recency. | Technique G below uses semantic scoring, not just FIFO. |
| **LOCA-bench** | "Context rot" — reliability degrades as context grows. | We measure this by comparing early vs late performance. |
| **Aionis** | 7-metric state-preserving compression baseline. | Our metrics: state recall, decision consistency, actionability. |

### The Six Techniques (Revised)

Based on research, I've refined the techniques:

| ID | Technique | Description | Research Basis | Est. Size (10 turns) |
| :--: | ----------- | ------------- | --------------- | :--------------------: |
| **A** | **Full raw** | Complete history (baseline) | LoCoBench agent standard | **~42,000 chars** |
| **B** | **Pi compaction** | LLM free-text summary | Current pi approach | **~2,000 chars** |
| **C** | **Structured state** | Per-turn: goal, files, decisions, status | Aionis state-preservation | **~4,000 chars** |
| **D** | **Minimal state** | Files changed + last 3 decisions | U-Fold constraint preservation | **~1,500 chars** |
| **E** | **Semantic FIFO** | Last 3 raw + structured for rest | STAE recency bias | **~15,400 chars** |
| **F** | **Drop** | Nothing (cold start at cut point) | Floor baseline | **0 chars** |
| **G** | **Semantic centroid** | Top 50% of turns by semantic importance | STAE centroid scoring | **~21,000 chars** |

### Technique G: Semantic Centroid (Research-Driven)

Instead of FIFO dropping, score each turn by semantic importance:

```python
def score_turn(turn, centroid_embedding):
    """Score a turn by relevance to task goal"""
    # Recency bonus (newer = more important)
    recency = turn.index / total_turns  # 0.0 to 1.0
    
    # Semantic similarity to overall task goal
    turn_embedding = embed(turn.user_message)
    similarity = cosine_similarity(turn_embedding, centroid_embedding)
    
    # Tool density bonus (more tools = more action)
    tool_density = len(turn.tool_calls) / max_tools
    
    return 0.5 * recency + 0.3 * similarity + 0.2 * tool_density
```

Keep only turns above the median score. This preserves important context even if it's old.

## Detailed Design

### Step 1: Session Extraction

Input: Pi session JSONL file.

```python
def extract_session(path):
    """Parse JSONL into structured turns"""
    entries = [json.loads(l) for l in open(path)]
    
    turns = []
    current_turn = {
        "user_message": None,
        "assistant_messages": [],
        "tool_calls": [],
        "tool_results": [],
        "timestamp": None,
    }
    
    for entry in entries:
        if entry["type"] != "message":
            continue
        msg = entry.get("message", {})
        role = msg.get("role")
        
        if role == "user":
            if current_turn["user_message"]:
                turns.append(current_turn)
                current_turn = {...}  # Fresh turn
            current_turn["user_message"] = msg["content"]
        elif role == "assistant":
            current_turn["assistant_messages"].append(msg)
        elif role == "tool_result":
            current_turn["tool_results"].append(msg)
    
    turns.append(current_turn)
    return turns
```

### Step 2: Compression Engines

**Technique C — Structured State Extractor:**

```python
def extract_structured_state(turn):
    """Extract goal, files, decisions, status from a turn"""
    # Heuristic: parse tool calls for files
    files_changed = set()
    for tool in turn["tool_calls"]:
        path = tool.get("input", {}).get("path", "")
        if path:
            files_changed.add(path)
    
    # Heuristic: parse user message for goal
    user_msg = turn["user_message"] or ""
    goal = user_msg[:200]  # First 200 chars
    
    # Heuristic: decisions from assistant reasoning
    decisions = []
    for msg in turn["assistant_messages"]:
        reasoning = msg.get("reasoning_content", "")
        if reasoning:
            # Extract decision-like phrases
            for phrase in ["chose", "decided", "using", "because"]:
                if phrase in reasoning.lower():
                    decisions.append(extract_sentence(reasoning, phrase))
    
    return {
        "goal": goal,
        "files": list(files_changed)[:5],
        "decisions": decisions[:3],
        "tool_count": len(turn["tool_calls"]),
        "status": "completed" if len(turn["tool_calls"]) > 0 else "pending",
    }
```

**Technique G — Semantic Scorer:**

```python
def score_and_select_turns(turns, max_tokens=200000):
    """Keep most important turns using semantic-temporal scoring"""
    # Extract overall task goal from first user message
    centroid = embed(turns[0]["user_message"])
    
    scored = []
    for i, turn in enumerate(turns):
        score = score_turn(turn, centroid, i, len(turns))
        scored.append((score, turn))
    
    scored.sort(reverse=True)  # Highest score first
    
    # Greedily select until budget exhausted
    selected = []
    total = 0
    for score, turn in scored:
        size = estimate_tokens(turn)
        if total + size <= max_tokens:
            selected.append(turn)
            total += size
    
    # Restore chronological order
    selected.sort(key=lambda t: t["timestamp"])
    return selected
```

### Step 3: Test Prompts (Revised)

Based on U-Fold's identified failure modes:

| ID | Test | What It Measures | Failure Mode |
| :--: | ------ | ------------------ | ------------- |
| **P1** | *Find the file we edited and add a new field* | File state retention | Dropped file context |
| **P2** | *Why did we use X instead of Y?* | Decision recall | Lost intermediate facts |
| **P3** | *Continue the task — what's the next step?* | Task continuity | Lost planning context |
| **P4** | *What constraints did the user specify?* | Constraint awareness | U-Fold's key failure |
| **P5** | *What tools/approaches failed?* | Failure memory | Repeated mistakes |
| **P6** | *Re-implement the last function we wrote* | Code state retention | Hallucinated code |

### Step 4: Scoring Rubric (Revised)

Each test scored 0-3 across two axes:

**Precision** (is it correct?):

| Score | Meaning |
| :-----: | --------- |
| 3 | Matches ground truth exactly |
| 2 | Gets the idea, minor deviation |
| 1 | Related but wrong direction |
| 0 | Hallucination or contradiction |

**Recall** (did it miss anything?):

| Score | Meaning |
| :-----: | --------- |
| 3 | All relevant information present |
| 2 | Most information present |
| 1 | Key information missing |
| 0 | Critical information missing |

Combined: `(Precision + Recall) / 2` → final score 0-3

### Step 5: Running the Benchmark

```bash
# For each technique [A, B, C, D, E, F, G]:
#   For each test prompt [P1, P2, P3, P4, P5, P6]:
#     Run 3 times (to account for temperature variance)
#     Score precision + recall
#     Record average

python3 run_benchmark.py \
  --session ~/.pi/agent/sessions/--path--/session.jsonl \
  --cut-turn 10 \
  --techniques A,B,C,D,E,F,G \
  --runs 3 \
  --output results.json
```

### Step 6: Results & Analysis

**Primary metric:** Average score across all tests for each technique.

**Secondary metrics:**

- **Precision vs Recall ratio**: Does a technique favor correctness over completeness?
- **Failure mode breakdown**: Which tests did each technique fail on?
- **Size-efficiency frontier**: Score vs tokens used (Pareto optimality)

**Expected results (hypothesis):**

```
Score
 3.0 │ A ─────────● (full raw, baseline)
     │            │
 2.5 │ G ────●    │ (semantic centroid)
     │      │    │
 2.0 │ E ─●──│────│── (hybrid FIFO)
     │    │  │    │
 1.5 │ C ──│──│──│── (structured state)
     │  │  │  │  │
 1.0 │ B ─│──│──│──│ (pi compaction)
     ││  │  │  │  │
 0.5 │ D ─│──│──│──│── (minimal state)
     ││  │  │  │  │
 0.0 │ F ───────────── (none)
     └──────────────────── Size (log scale)
      0   1K   4K   15K  42K
```

### Validation Strategy

| Validity Type | How We Test | Pass Criteria |
| --------------- | ------------- | :-------------: |
| **Internal** | Same session, same cut point, 3 runs per test | Variance < 0.5 across runs |
| **External** | Run on 3 different sessions | Same technique ranking across sessions |
| **Construct** | Full raw scores highest, None scores lowest | Confirmed ordering |
| **Discriminant** | Techniques should produce distinct scores | 95% confidence intervals non-overlapping |

### Implementation Roadmap

| Phase | What | Time |
| :-----: | ------ | :----: |
| 1 | Session extractor + compression engines | 3-4 hours |
| 2 | Test runner + MTPLX integration | 2 hours |
| 3 | Run full benchmark (7 techniques × 6 tests × 3 runs = 126 LLM calls) | ~2 hours (at 72 tok/s) |
| 4 | Score + analyze results | 2 hours |
| 5 | Report findings | 1 hour |

Want to start building? Phase 1 is the session extractor and compression engines.
