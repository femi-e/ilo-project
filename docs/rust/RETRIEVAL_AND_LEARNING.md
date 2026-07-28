# ILO Cognitive Runtime — Retrieval & Learning Loops

## Overview

ILO has two complementary loops that form the core of its cognitive memory system.

```
                    ┌──────────────────────┐
                    │   RETRIEVAL LOOP      │  (per turn, synchronous)
                    │   Query → Context     │
                    └──────────┬───────────┘
                               │
                               ▼ LLM generates response
                               │
                    ┌──────────┴───────────┐
                    │   LEARNING LOOP       │  (per turn, sync or async)
                    │   Feedback → Update   │
                    └──────────────────────┘
```

The retrieval loop is **fast and synchronous** — it must complete before the LLM responds.
The learning loop is **slower and may be async** — it updates the graph after the response.

Both loops operate over the same graph schema:

```
Node (entity, claim, turn, view)
  ├── id: STRING PK (UUIDv7)
  ├── type: STRING (entity|claim|turn|view)
  ├── tags: STRING[]
  ├── label: STRING
  ├── embedding: FLOAT[768] (nullable)
  ├── confidence: DOUBLE (0.0-1.0)
  └── created_at, updated_at: TIMESTAMP

Prop (owner_id::key → value)
  ├── id: STRING PK ("{owner_id}::{key}")
  ├── owner_id: STRING FK (Node.id or Link.id)
  ├── owner_kind: STRING (node|link)
  ├── key: STRING
  ├── kind: STRING (string|float|int|bool|json|date)
  └── val_str|val_float|val_int|val_bool|val_json

LINK (directed, from → to)
  ├── id: STRING PK (UUIDv7)
  ├── type: STRING (has|ref|dep|con|seq|evidence|context|refute)
  ├── tags: STRING[]
  ├── weight: DOUBLE (0.0-1.0) ← **Hebbian strength**
  └── created_at: TIMESTAMP
```

---

## 1. Retrieval Loop

### Purpose

Given a user query, produce a **ContextBlock** — a structured, linearised subgraph that the LLM can reason over. The loop activates relevant nodes via energy propagation through the graph, then assembles the results into the Anchor linearisation language.

### Constants (defaults, configurable per View)

| Constant | Default | Purpose |
|----------|---------|---------|
| `ACTIVATION_THRESHOLD` | 0.005 | Minimum energy for a node to remain activated |
| `BACKWARD_DISCOUNT` | 0.5 | Incoming edges carry half the energy of outgoing |
| `INHIBIT_M` | 4 | Top M nodes survive lateral inhibition |
| `INHIBIT_BETA` | 0.3 | Suppression strength |
| `DEPTH_PROTECT` | true | Nodes at depth >= 3 get reduced inhibition |
| `DEPTH_FACTOR` | 0.3 | Inhibition multiplier for protected nodes |
| `TEMPORAL_DECAY` | true | Older links carry less energy |
| `TEMPORAL_HALF_LIFE` | 10,000 (time units) | Half-life for link decay |
| `MAX_HOPS` | 4 | Maximum propagation depth |
| `MAX_SEEDS` | 5 | Maximum number of seed nodes |
| `TOKEN_BUDGET` | 2048 | Max characters in assembled context |

### Step-by-Step

```
┌──────────────────────────────────────────────────────────────────┐
│  RETRIEVAL LOOP                                                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌────────────┐                                                    │
│  │ STEP 1     │  QUERY PARSING                                     │
│  │ PARSE      │  Input:  user query string                         │
│  │            │  Output: parsed query with:                        │
│  │            │    - entities: Vec<String> (extracted terms)       │
│  │            │    - temporal: Option<String> (time references)    │
│  │            │    - intent: String (question,command,statement)   │
│  │            │                                                    │
│  │  Method:   │  Simple: split on whitespace, filter short words   │
│  │            │  Advanced: LLM-based entity extraction             │
│  └─────┬──────┘                                                    │
│        ▼                                                           │
│  ┌────────────┐                                                    │
│  │ STEP 2     │  SEED FINDING                                      │
│  │ SEED       │  Input:  extracted entities                        │
│  │            │  Output: Vec<(NodeId, match_score)>                │
│  │            │                                                    │
│  │  For each extracted entity:                                     │
│  │    1. Exact match on Node.label (score = 1.0)                   │
│  │    2. Substring match (score = 0.7)                             │
│  │    3. Vector similarity search on Node.embedding (score = sim)  │
│  │    4. Deduplicate by NodeId, keep highest score                 │
│  │    5. Sort by score × Node.confidence                           │
│  │    6. Truncate to MAX_SEEDS                                     │
│  │                                                    │
│  │  Note: Exact match has priority. Only fall back to              │
│  │  vector search if no exact match found.                         │
│  └─────┬──────┘                                                    │
│        ▼                                                           │
│  ┌────────────┐                                                    │
│  │ STEP 3     │  SEED ACTIVATION                                   │
│  │ ACTIVATE   │  Input:  seeds Vec<(NodeId, match_score)>          │
│  │            │  Output: activation HashMap<NodeId, f64>           │
│  │            │                                                    │
│  │  For each seed (node_id, match_score):                          │
│  │    energy = node.confidence × match_score                        │
│  │    activation[node_id] += energy                                │
│  │    depth[node_id] = 0                                           │
│  │    path[node_id] = [node_id]                                     │
│  │    source_seed[node_id] = node_id                               │
│  └─────┬──────┘                                                    │
│        ▼                                                           │
│  ┌────────────┐                                                    │
│  │ STEP 4     │  SPREADING ACTIVATION (iterative)                  │
│  │ SPREAD     │  Input:  activation map, depth map                 │
│  │            │  Output: updated activation map                    │
│  │            │                                                    │
│  │  for hop in 1..=MAX_HOPS:                                       │
│  │    next = empty_map                                             │
│  │    for each (node_id, energy) in activation:                    │
│  │      edges = incident_edges(node_id)  # both directions        │
│  │      fan = edges.len()                                          │
│  │      for each link in edges:                                    │
│  │        if link.from == node_id → target = link.to, dir=OUT     │
│  │        else → target = link.from, dir=IN                       │
│  │        discount = 1.0 if OUT else BACKWARD_DISCOUNT            │
│  │        temporal = decay(link.turn_time) if TEMPORAL else 1.0   │
│  │        propagated = energy × link.weight × discount            │
│  │                      × temporal / fan                          │
│  │        if propagated ≥ ACTIVATION_THRESHOLD:                    │
│  │          next[target] += propagated                            │
│  │          depth[target] = min(depth[target], current_depth+1)    │
│  │          source_seed[target] = source_seed[node_id]             │
│  │                                                                │
│  │    # Lateral inhibition                                        │
│  │    sorted = sort(next by energy desc)                          │
│  │    for each node past INHIBIT_M:                                │
│  │      d = depth[node]                                           │
│  │      protection = DEPTH_FACTOR if d>=3 && DEPTH_PROTECT else 1 │
│  │      suppression = (top_act - energy) × INHIBIT_BETA           │
│  │                       × protection                             │
│  │      next[node] = max(0, energy - suppression)                 │
│  │                                                                │
│  │    # Filter and propagate to next hop                          │
│  │    activation = next where energy ≥ ACTIVATION_THRESHOLD       │
│  │    if activation is empty: break                               │
│  │                                                                │
│  │  Note: Propagation follows BOTH directions along LINK edges    │
│  │  because real graph edges are directed (turn→entity) but       │
│  │  semantically energy should flow entity→turn as well.          │
│  └─────┬──────┘                                                    │
│        ▼                                                           │
│  ┌────────────┐                                                    │
│  │ STEP 5     │  CONFIDENCE GATING                                 │
│  │ GATE       │  Input:  activated nodes with energy values        │
│  │            │  Output: filtered and ranked candidates             │
│  │            │                                                    │
│  │  For each activated node:                                       │
│  │    score = activation × node.confidence                         │
│  │  Sort by score descending                                       │
│  │  Truncate to fit within TOKEN_BUDGET                            │
│  └─────┬──────┘                                                    │
│        ▼                                                           │
│  ┌────────────┐                                                    │
│  │ STEP 6     │  CONTEXT ASSEMBLY                                  │
│  │ ASSEMBLE   │  Input:  ranked candidates with paths               │
│  │            │  Output: ContextBlock (Anchor-format text)          │
│  │            │                                                    │
│  │  For each candidate (in rank order):                            │
│  │    type_tag = infer from node_id prefix / source_seed           │
│  │    emit: "  {indent}[{type}] {label} (score: {score:.4})"      │
│  │    if path.len() > 1:                                          │
│  │      emit: "  {indent}  via: {path → arrow → format}"          │
│  │    if token budget exceeded: stop                                │
│  │                                                                │
│  │  Format specification (Anchor language, see ANCHOR_SPEC.md):   │
│  │    https://github.com/ilo/runtime/blob/main/docs/ANCHOR_SPEC.md │
│  └─────┬──────┘                                                    │
│        ▼                                                           │
│  ┌────────────┐                                                    │
│  │ OUTPUT     │  ContextBlock → LLM prompt                          │
│  └────────────┘                                                    │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

### Energy Propagation Math

```
activated[node] = Σ over incident edges of:

    source_energy × edge.weight × direction_discount × temporal_factor
    ─────────────────────────────────────────────────────────────────
                              fan_out(source)

Where:

    source_energy       = current activation of the source node
    edge.weight         = LINK.weight (Hebbian strength, 0.0-1.0)
    direction_discount  = 1.0 for outgoing edges, BACKWARD_DISCOUNT (0.5) for incoming
    temporal_factor     = 1 / (1 + age × 0.0001)  (if temporal decay enabled)
    fan_out(source)     = total incident edges of the source node

After each hop:

    Lateral inhibition:
        top M nodes survive, rest are suppressed by:
        suppressed = energy - (top_act - energy) × β × depth_factor

        depth_factor = DEPTH_FACTOR (0.3) if depth >= 3 else 1.0

    Confidence gating (final):
        score = activation × node.confidence
```

---

## 2. Learning Loop

### Purpose

After the LLM generates a response, update the graph so that future retrievals improve. Strengthen paths that proved useful, weaken paths that didn't, and periodically consolidate frequent patterns into durable knowledge.

### Constants

| Constant | Default | Purpose |
|----------|---------|---------|
| `HEBBIAN_ETA` | 0.1 | Learning rate for weight strengthening |
| `DECAY_LAMBDA` | 0.001 | Per-turn global decay on all links |
| `NEGATIVE_FB_ETA` | 0.02 | Strength reduction for unused retrievals |
| `CONSOLIDATION_INTERVAL` | 50 turns | How often to check for consolidation |
| `HUB_THRESHOLD` | 5.0 | Total incident weight before a node is a "hub" |

### Step-by-Step

```
┌──────────────────────────────────────────────────────────────────┐
│  LEARNING LOOP                                                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌────────────┐                                                    │
│  │ STEP 1     │  SIGNAL COLLECTION                                 │
│  │ SIGNAL     │  Input:  Turn record, retrieval results            │
│  │            │  Output: co_used_pairs, unused_retrieved           │
│  │            │                                                    │
│  │  After the LLM responds, determine which retrieved nodes       │
│  │  were actually USEFUL:                                         │
│  │                                                    │
│  │  Methods (in order of accuracy):                               │
│  │    1. Entity overlap — does the response contain labels        │
│  │       or aliases of retrieved nodes?                           │
│  │    2. Citation check — does the response explicitly            │
│  │       reference a node's content?                              │
│  │    3. Next-turn confirmation — did the user confirm            │
│  │       or correct the information?                              │
│  │                                                    │
│  │  Output:                                                       │
│  │    used_nodes: Vec<NodeId>      (retrieved AND useful)         │
│  │    unused_nodes: Vec<NodeId>    (retrieved but NOT useful)     │
│  │    co_used_pairs: Vec<(NodeId,NodeId)>  (pairs used together)  │
│  └─────┬──────┘                                                    │
│        ▼                                                           │
│  ┌────────────┐                                                    │
│  │ STEP 2     │  HEBBIAN STRENGTHENING                             │
│  │ STRENGTHEN │  Input:  co_used_pairs                             │
│  │            │  Output: updated LINK.weights                       │
│  │            │                                                    │
│  │  "Neurons that fire together, wire together."                   │
│  │                                                    │
│  │  For each co-used pair (a, b):                                  │
│  │    link = find_link_between(a, b)                               │
│  │    if link exists:                                              │
│  │      w = link.weight                                            │
│  │      conf_a = Node(a).confidence                                │
│  │      conf_b = Node(b).confidence                                │
│  │      kalman_gain = 1.0 - (conf_a + conf_b) / 2.0               │
│  │      delta = HEBBIAN_ETA × (1.0 - w) × kalman_gain             │
│  │      link.weight = clamp(w + delta, 0.0, 1.0)                  │
│  │                                                    │
│  │  The Kalman gain ensures:                                       │
│  │    - High-confidence nodes update SLOWLY (stable knowledge)     │
│  │    - Low-confidence nodes update QUICKLY (still learning)       │
│  │    - A saturated link (w≈1.0) barely changes at all            │
│  │                                                    │
│  │  Example:                                                       │
│  │    w=0.3, conf=(0.5,0.5) → kg=0.5 → Δ=0.035 → w=0.335        │
│  │    w=0.9, conf=(0.9,0.9) → kg=0.1 → Δ=0.001 → w=0.901        │
│  └─────┬──────┘                                                    │
│        ▼                                                           │
│  ┌────────────┐                                                    │
│  │ STEP 3     │  SYNAPTIC DECAY                                    │
│  │ DECAY      │  Input:  all LINKs                                 │
│  │            │  Output: all LINK.weights reduced                   │
│  │            │                                                    │
│  │  Every turn, ALL link weights decay slightly:                   │
│  │    link.weight = link.weight × (1.0 - DECAY_LAMBDA)             │
│  │                                                    │
│  │  Effect over time:                                              │
│  │    - A link used every turn: strengthened by Hebbian,           │
│  │      slightly decayed. Net: stable or growing.                  │
│  │    - A link used once: decays to ~72% after 100 turns          │
│  │      If never re-strengthened, eventually fades to 0.            │
│  │    - This│    - This is the **forgetting curve** — a core property of
│      biological memory.
│  └─────┬──────┘
│        ▼
│  ┌────────────┐
│  │ STEP 4     │  NEGATIVE FEEDBACK
│  │ NEGATIVE   │  Input:  unused_retrieved nodes
│  │            │  Output: weakened LINK.weights
│  │            │
│  │  Nodes that were retrieved but NOT used should have their
│  │  outgoing connections slightly weakened:
│  │
│  │    for each unused_node:
│  │      for each outgoing LINK from unused_node:
│  │        link.weight = link.weight × (1.0 - NEGATIVE_FB_ETA)
│  │
│  │  This is weaker than Hebbian strengthening (η_neg < η_pos)
│  │  to prevent one bad retrieval from destroying a useful link.
│  └─────┬──────┘
│        ▼
│  ┌────────────┐
│  │ STEP 5     │  CONSOLIDATION (periodic)
│  │ CONSOLIDATE│  Input:  graph
│  │            │  Output: compressed semantic nodes (if triggered)
│  │            │
│  │  Every CONSOLIDATION_INTERVAL turns:
│  │    1. Find hub nodes: total incident LINK.weight > HUB_THRESHOLD
│  │    2. For each hub, cluster its neighbours
│  │    3. If cluster is dense (high internal connectivity):
│  │       a. LLM summarises the cluster into a new semantic node
│  │       b. Create new Entity node with the summary as label
│  │       c. Link original nodes to the new node via LINK:has
│  │       d. Decay the original inter-node links (pattern now
│  │          captured by the semantic node)
│  │    4. Archive nodes with confidence < 0.2 and age > 30d
│  │
│  │  This prevents graph explosion — turn-level detail is
│  │  compressed into conceptual knowledge, like biological
│  │  memory consolidation during sleep.
│  └─────┬──────┘
│        ▼
│  ┌────────────┐
│  │ STEP 6     │  WRITE BATCH
│  │ COMMIT     │  All updates are written atomically:
│  │            │
│  │    BEGIN TRANSACTION
│  │      Turn node created (if conversational)
│  │      LINK.weights updated
│  │      New semantic nodes created (if consolidation)
│  │      Archived nodes marked
│  │    COMMIT
│  │
│  │  Atomicity guarantee: either all updates land or none do.
│  │  LadybugDB's WAL handles crash recovery transparently.
│  │  The Turn node documents the entire learning cycle for audit.
│  └────────────┘
│
└──────────────────────────────────────────────────────────────────┘
```

### Consolidation Example

```
Before consolidation:
  Turn#140 → [ref] → anxiety (conf=0.92)
  Turn#142 → [ref] → anxiety
  Turn#145 → [ref] → anxiety
  Turn#150 → [ref] → anxiety
  Turn#140 → [ref] → schedule (conf=0.90)
  Turn#142 → [ref] → work_project (conf=0.85)

  Hub detection: Turn#140 has high total incident weight
  Cluster: {Turn#140, Turn#142, Turn#145, Turn#150} ∪
           {anxiety, schedule, work_project}

After consolidation:
  [NEW] Episode("March deadline stress") {confidence: 0.88}
    Turn#140 → [has] → Episode
    Turn#142 → [has] → Episode
    anxiety  → [has] → Episode
    schedule → [has] → Episode
    work_project → [has] → Episode

  Turn-to-Turn links decay (pattern captured by Episode node)
  Future queries for "anxiety" now reach "schedule" via Episode
  in fewer hops.
```

---

## 3. Interaction Between Loops

```
Turn N:
  User: "Why am I anxious?"
  ┌── RETRIEVAL ────────────────────────────────────────────┐
  │  Parse → Seeds: ["anxiety"]                             │
  │  Activate: anxiety(0.92) → Turn#140(0.32) → ...        │
  │  Result: {anxiety, Turn#140, schedule, work_project}    │
  └─────────────────────────────────────────────────────────┘
  LLM: "Looking back at our conversation about deadlines..."
  ┌── LEARNING ─────────────────────────────────────────────┐
  │  Used: {anxiety, Turn#140, schedule}                    │
  │  Unused: {work_project}                                 │
  │  Hebbian: anxiety↔Turn#140: 0.7→0.701,                  │
  │           Turn#140↔schedule: 0.5→0.501                 │
  │  Decay: all links × 0.999                               │
  │  Negative: work_project→* × 0.98                        │
  └─────────────────────────────────────────────────────────┘

Turn N+1:
  User: "What about the deadlines?"
  ┌── RETRIEVAL ────────────────────────────────────────────┐
  │  Seeds: ["deadlines"] → schedule (weight now 0.501)     │
  │  Higher activation than last turn → reaches faster      │
  └─────────────────────────────────────────────────────────┘
```

---

## 4. Open Decisions

| Decision | Options | Current Choice | Rationale |
|----------|---------|---------------|-----------|
| **Sync vs Async learning** | Sync: block after every turn. Async: background thread. | **Sync for prototype** | Simplest. Switch to async if latency exceeds 5ms. |
| **Usage signal** | Entity overlap / Citation check / Next-turn confirm | **Entity overlap** | No prompt changes needed. Works out of the box. |
| **Consolidation trigger** | Time-based / Graph-structure / LLM-initiated | **Time + structure** | Check every 50 turns, only consolidate if hubs exist. |
| **Backward direction discount** | 1.0 (same as forward) / 0.5 (half) / 0.0 (disabled) | **0.5** | Entities should reach their turns, but forward edges are stronger. |
| **Depth protection threshold** | Depth 2 / Depth 3 / Depth 4 | **Depth 3** | Hops 1-2 are distractors, hops 3+ are deep answers. |
| **Temporal decay model** | Linear / Exponential / Sigmoid | **1/(1+age×0.0001)** | Smooth decay, doesn't kill old data completely. |

---

## 5. Performance Expectations

| Operation | Scale | Expected Latency | Cache Speedup |
|-----------|-------|-----------------|---------------|
| Seed finding | 5 seeds from 1000 nodes | <1ms (hash lookup) | N/A |
| Per hop propagation | 10 activated nodes × 5 edges | <0.1ms | N/A |
| Full retrieval (4 hops) | 200-node graph | **~0.4ms** (measured) | N/A |
| Hebbian update | 4 pairs + 50 links decay | **~0.05ms** | N/A |
| LadybugDB write_batch | 1 turn + 5 mutations | 5-10ms (DB write) | N/A |
| LadybugDB read (cache miss) | 1 node | 400µs | 73,000x vs cache |
| LadybugDB read (cache hit) | 1 node | 0.006µs | |

The retrieval loop is **not the bottleneck**. The bottleneck will be:
1. LLM generation time (seconds)
2. LadybugDB write time (milliseconds) if learning is sync
3. LLM-based entity extraction (if used)
