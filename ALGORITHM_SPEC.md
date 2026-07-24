# ILO Retrieval Algorithm — Final Specification

## Overview

One algorithm. All queries. The same four steps regardless of input:

```
1. FIND SEEDS (from most to least specific)
2. SCORE neighbours: type_relevance × edge_weight × target_confidence × label_similarity
3. EXPAND best-first frontier
4. RETURN ranked nodes + properties
```

---

## Step 1: Seed Finding (Chain of Fallbacks)

Each step is attempted in order. First non-empty result wins.

```
TRY 1: VIEW MATCH
  Condition: query string matches a View node's name or purpose property
  Action:   return all entities linked to that View via context edges

TRY 2: LABEL MATCH
  Condition: query string matches node.label (exact or substring)
  Action:   return matching nodes, scored 1.0 for exact, 0.7 for substring

TRY 3: TAG/PROPERTY MATCH
  Condition: query string matches a node's tag, alias, or description property
  Action:   return matching nodes, scored 0.5

TRY 4: SUBTYPE KEYWORD MATCH
  Condition: query contains a known subtype keyword ("project", "person", "tool", "concept")
  Action:   return all entities with matching subtype, scored 0.3

TRY 5: RECENCY FALLBACK
  Condition: no seeds found by any above step
  Action:   return 5 most recently created/modified nodes, scored 0.1
```

---

## Step 2: Scoring

For each candidate edge from a frontier node to a neighbour:

```
score = type_relevance × edge_weight × target_confidence × label_similarity

where:
  type_relevance    = 1.0 if edge type matches query intent
                      0.3 if edge type does NOT match (soft filter, not a hard cutoff)
  edge_weight       = LINK.weight (0.0 to 1.0, dynamic via Hebbian learning)
  target_confidence = Node.confidence (0.0 to 1.0)
  label_similarity  = how well the target's identity matches the query
                      1.0 exact label match
                      0.6 substring or word overlap
                      0.4 subtype match (e.g., query="project" entity is a project)
                      0.2 default
```

No hard cutoffs on edge types. Non-matching types get discounted but not eliminated.

---

## Step 3: Expansion

```
frontier = [(seed_id, depth=0, score, path=[seed_id])]

while frontier not empty:
  pop highest-score node
  add to collected results
  
  if depth >= max_hops (default 4): skip expansion
  
  for each incident edge NOT yet visited:
    calculate neighbour_score using formula above
    cumulative = current_score + neighbour_score   # additive, not multiplicative
    add to frontier with depth+1
```

---

## Step 4: Return

```
return collected results sorted by cumulative score descending
  each result includes:
    - node_id
    - score
    - depth
    - path (list of node ids traversed)
    - properties (key-value pairs from the node)
```

---

## Configuration (per query, data-driven)

| Parameter | Source | Default |
|-----------|--------|---------|
| max_hops | Query intent or 4 | 4 |
| min_score | Query intent or 0.05 | 0.05 |
| intent→edge_types | INTENT_EDGES map | all types |
| type_relevance (matching) | INTENT_EDGES | 1.0 |
| type_relevance (non-matching) | global | 0.3 |
| seed_chain | chain defined above | full chain |

Views are stored as graph nodes. Their entity_filter property is the data source for seed step 1. No hardcoded lists.

---

## What This Handles (Validated)

| Query type | Example | Seed source | Edge types | Works? |
|-----------|---------|------------|------------|--------|
| Named entity | "Tell me about Alice" | Label match | All, soft filter | ✅ |
| Relation | "What projects does Alice work on?" | Label match (Alice) | has+ref boosted | ✅ |
| Abstract | "What projects exist?" | View match or subtype keyword | Permissive | ✅ (fixed) |
| Complex | "Is there a project and a tool?" | View match or subtype | Permissive | ✅ (fixed) |
| Empty/stop | "" or "the and or" | Recency fallback | Permissive | ✅ (fixed) |
| No match | "XYZ nonexistent" | Recency fallback | Permissive | ✅ (fixed) |
