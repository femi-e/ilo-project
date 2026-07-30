# Retrieval & Learning

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

---

## Retrieval Algorithm

One algorithm handles all queries. Four steps regardless of input:

```
1. FIND SEEDS (from most to least specific)
2. SCORE neighbours: type_relevance × edge_weight × target_confidence × label_similarity
3. EXPAND best-first frontier
4. RETURN ranked nodes + properties
```

### Step 1: Seed Finding

Each step is attempted in order. First non-empty result wins.

```
TRY 1: VIEW MATCH
  Condition: query matches a View node's name or purpose
  Action:   return all entities linked to that View

TRY 2: LABEL MATCH
  Condition: query matches node.label (exact or substring)
  Action:   return matching nodes, scored 1.0 for exact, 0.7 for substring

TRY 3: TAG/PROPERTY MATCH
  Condition: query matches a node's tag, alias, or description
  Action:   return matching nodes, scored 0.5

TRY 4: SUBTYPE KEYWORD MATCH
  Condition: query contains a known subtype keyword
  Action:   return all entities with matching subtype, scored 0.3

TRY 5: RECENCY FALLBACK
  Condition: no seeds found by any above step
  Action:   return 5 most recently modified nodes, scored 0.1
```

### Step 2: Scoring

For each candidate edge from a frontier node to a neighbour:

```
score = type_relevance × edge_weight × target_confidence × label_similarity
```

| Factor | Range | Description |
| -------- | :-----: | ------------- |
| type_relevance | 0.3–1.0 | 1.0 if edge type matches query intent, 0.3 if not |
| edge_weight | 0.0–1.0 | LINK.weight, dynamic via Hebbian learning |
| target_confidence | 0.0–1.0 | Node.confidence |
| label_similarity | 0.2–1.0 | 1.0 exact match, 0.6 substring, 0.4 subtype, 0.2 default |

No hard cutoffs on edge types. Non-matching types get discounted but not eliminated.

### Step 3: Expansion

```
frontier = [(seed_id, depth=0, score, path=[seed_id])]

while frontier not empty:
  pop highest-score node
  add to collected results

  if depth >= max_hops (default 4): skip expansion

  for each incident edge NOT yet visited:
    calculate neighbour_score using formula above
    cumulative = current_score + neighbour_score   # additive
    add to frontier with depth+1
```

A **fired set** prevents re-activation of already-visited nodes, eliminating infinite propagation loops through graph cycles.

### Step 4: Return

```
return collected results sorted by cumulative score descending
  each result includes:
    - node_id
    - score
    - depth
    - path (list of node ids traversed)
    - properties
```

### Query Type Coverage

| Query type | Example | Seed source | Status |
| ----------- | --------- | ------------ | -------- |
| Named entity | "Tell me about Alice" | Label match | ✅ |
| Relation | "What projects does Alice work on?" | Label match + edge boost | ✅ |
| Abstract | "What projects exist?" | View match or subtype | ✅ |
| Complex | "Is there a project and a tool?" | View match or subtype | ✅ |
| Empty/stop | "" or "the and or" | Recency fallback | ✅ |
| No match | "XYZ nonexistent" | Recency fallback | ✅ |

---

## Detailed Retrieval Loop

### Constants

| Constant | Default | Purpose |
| ---------- | --------- | --------- |
| `ACTIVATION_THRESHOLD` | 0.005 | Minimum energy to remain activated |
| `BACKWARD_DISCOUNT` | 0.5 | Incoming edges carry half the energy of outgoing |
| `INHIBIT_M` | 4 | Top M nodes survive lateral inhibition |
| `INHIBIT_BETA` | 0.3 | Suppression strength |
| `MAX_HOPS` | 4 | Maximum propagation depth |
| `MAX_SEEDS` | 5 | Maximum number of seed nodes |
| `TEMPORAL_HALF_LIFE` | 10,000 units | Half-life for temporal link decay |

### Step-by-Step

```
RETRIEVAL LOOP

STEP 1 — PARSE
  Input:  user query string
  Output: parsed entities, temporal refs, intent

STEP 2 — SEED FINDING
  Input:  extracted entities
  Output: Vec<(NodeId, match_score)>

  For each extracted entity:
    1. Exact match on Node.label (score = 1.0)
    2. Substring match (score = 0.7)
    3. Vector similarity search on Node.embedding
    4. Deduplicate by NodeId, keep highest score
    5. Sort by score × Node.confidence

STEP 3 — SEED ACTIVATION
  Input:  seeds Vec<(NodeId, match_score)>
  Output: activation HashMap<NodeId, f64>

  For each seed:
    energy = node.confidence × match_score
    activation[node_id] += energy
    depth[node_id] = 0

STEP 4 — SPREADING ACTIVATION
  Input:  activation map, depth map
  Output: updated activation map

  for hop in 1..=MAX_HOPS:
    next = empty
    for each (node_id, energy) in activation:
      edges = incident_edges(node_id)
      fan = edges.len()
      for each link in edges:
        target = link.to if link.from == node_id else link.from
        discount = 1.0 if outgoing else BACKWARD_DISCOUNT
        propagated = energy × link.weight × discount / fan
        if propagated ≥ ACTIVATION_THRESHOLD:
          next[target] += propagated

    # Lateral inhibition
    sorted = sort(next by energy desc)
    for each node past INHIBIT_M:
      suppression = (top_act - energy) × INHIBIT_BETA
      next[node] = max(0, energy - suppression)

    if next is empty: break
    activation = next

STEP 5 — CONFIDENCE GATING
  For each activated node:
    score = activation × node.confidence
  Sort by score descending
  Truncate to fit token budget

STEP 6 — CONTEXT ASSEMBLY
  For each candidate (in rank order):
    emit type, label, score, and path
```

### Energy Propagation Math

```
activated[node] = Σ over incident edges of:

    source_energy × edge.weight × direction_discount × temporal_factor
    ─────────────────────────────────────────────────────────────────
                              fan_out(source)

Where:
    direction_discount = 1.0 outgoing, 0.5 incoming
    temporal_factor    = 1 / (1 + age × 0.0001)
```

---

## Learning Loop

### Purpose

After the LLM generates a response, update the graph so future retrievals improve. Strengthen useful paths, weaken unused ones, and consolidate patterns into durable knowledge.

### Constants

| Constant | Default | Purpose |
| ---------- | --------- | --------- |
| `HEBBIAN_ETA` | 0.1 | Learning rate for weight strengthening |
| `DECAY_LAMBDA` | 0.001 | Per-turn global decay on all links |
| `NEGATIVE_FB_ETA` | 0.02 | Strength reduction for unused retrievals |
| `CONSOLIDATION_INTERVAL` | 50 turns | How often to check for consolidation |
| `HUB_THRESHOLD` | 5.0 | Total incident weight before a node is a "hub" |

### Step-by-Step

```
LEARNING LOOP

STEP 1 — SIGNAL COLLECTION
  After the LLM responds, determine which retrieved nodes
  were actually USEFUL.

  Methods (in order of accuracy):
    1. Entity overlap — does the response contain labels
       or aliases of retrieved nodes?
    2. Citation check — does the response explicitly
       reference a node's content?
    3. Next-turn confirmation — did the user confirm
       or correct the information?

  Output:
    used_nodes: Vec<NodeId>     (retrieved AND useful)
    unused_nodes: Vec<NodeId>   (retrieved but NOT useful)

STEP 2 — HEBBIAN STRENGTHENING
  "Neurons that fire together, wire together."

  For each co-used pair (a, b):
    link = find_link_between(a, b)
    if link exists:
      w = link.weight
      conf_a = Node(a).confidence
      conf_b = Node(b).confidence
      kalman_gain = 1.0 - (conf_a + conf_b) / 2.0
      delta = HEBBIAN_ETA × (1.0 - w) × kalman_gain
      link.weight = clamp(w + delta, 0.0, 1.0)

  Kalman gain ensures:
    - High-confidence nodes update SLOWLY (stable knowledge)
    - Low-confidence nodes update QUICKLY (still learning)
    - A saturated link (w≈1.0) barely changes

STEP 3 — SYNAPTIC DECAY
  Every turn, ALL link weights decay slightly:
    link.weight = link.weight × (1.0 - DECAY_LAMBDA)

  Effect:
    - Frequently used links stay stable or grow
    - Rarely used links fade toward zero (the forgetting curve)

STEP 4 — NEGATIVE FEEDBACK
  Nodes that were retrieved but NOT used have their
  outgoing connections slightly weakened:
    for each unused_node:
      for each outgoing LINK:
        link.weight = link.weight × (1.0 - NEGATIVE_FB_ETA)

  This is weaker than strengthening (η_neg < η_pos)
  to prevent one bad retrieval from destroying a useful link.

STEP 5 — CONSOLIDATION (periodic)
  Every CONSOLIDATION_INTERVAL turns:
    1. Find hub nodes (total incident LINK.weight > HUB_THRESHOLD)
    2. For each hub, cluster its neighbours
    3. If cluster is dense:
       a. Create new semantic node summarising the cluster
       b. Link original nodes to the new node
       c. Decay original inter-node links (pattern now captured)

  This prevents graph explosion — detail is compressed into
  conceptual knowledge, like biological memory consolidation.
```

### Interaction Between Loops

```
Turn N:
  User: "Why am I anxious?"
  RETRIEVAL:  Parse → Seeds → Activate anxiety → Spread to turns
  LLM: "Looking back at our conversation about deadlines..."
  LEARNING:   Strengthen anxiety↔turn link, decay unused paths

Turn N+1:
  User: "What about the deadlines?"
  RETRIEVAL:  Seeds now reach schedule faster (strengthened path)
```

### Performance Expectations

| Operation | Scale | Expected Latency |
| ----------- | ------- | ----------------- |
| Seed finding | 5 seeds from 1000 nodes | <1ms |
| Per hop propagation | 10 nodes × 5 edges | <0.1ms |
| Full retrieval (4 hops) | 200-node graph | ~0.4ms |
| Hebbian update | 4 pairs + 50 links decay | ~0.05ms |
| Database write batch | 1 turn + 5 mutations | 5-10ms |
