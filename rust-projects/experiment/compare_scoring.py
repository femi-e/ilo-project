#!/usr/bin/env python3
"""Compare existing scoring approaches against ILO's proposed scoring."""

print("=" * 70)
print("SCORING COMPARISON — ILO vs Existing Approaches")
print("=" * 70)

# ── 1. PageRank (Google, 1998) ──
print("""
[1] PAGERANK (Google, 1998)
    Formula: PR(n) = (1-d)/N + d * SUM(PR(p)/L(p))
    where d = damping factor (0.85), L(p) = out-degree of page p
    
    What it measures: AUTHORITY via incoming links
    Not personalized: same score for all queries
    
    Edge weights: NO (treated as uniform)
    Query awareness: NO
    Node confidence: NO
    Depth decay: IMPLICIT (damping factor handles it)
    
    ↔ ILO: ILO is query-personalized, PageRank is not.
    Similarity: Both use propagation. ILO's depth_decay = PageRank's damping.
    Difference: PageRank is global, ILO is query-specific.
""")

# ── 2. Personalized PageRank (Haveliwala, 2002) ──
print("""
[2] PERSONALIZED PAGERANK (Haveliwala, 2002)
    Formula: PPR(n) = (1-d)*s + d * SUM(PPR(p)/L(p))
    where s = personalization vector (query-specific seed weights)
    
    Edge weights: NO (treated as uniform)
    Query awareness: YES (via seed vector)
    Node confidence: NO
    Depth decay: IMPLICIT (damping factor)
    
    ↔ ILO: ILO and PPR share query-awareness via seeds.
    Similarity: Both start from query seeds and propagate.
    Difference: PPR is random-walk based (probabilistic), ILO is scored-additive (deterministic).
    Difference: PPR doesn't use edge weights or node confidence.
""")

# ── 3. Edge-Weighted PPR (Xie et al., KDD 2015) ──
print("""
[3] EDGE-WEIGHTED PAGERANK (Xie et al., KDD 2015)
    Formula: Same as PPR but transition prob = w(e) / SUM(w(out_edges))
    
    Edge weights: YES (transition probability)
    Query awareness: YES (via seed vector)
    Node confidence: NO
    Depth decay: IMPLICIT (damping factor)
    
    ↔ ILO: Most similar existing approach.
    Similarity: Both use edge weights to guide traversal from query seeds.
    Difference: Edge-PPR uses random walk, ILO uses best-first frontier.
    Difference: Edge-PPR doesn't have node confidence or label similarity.
    Difference: ILO's scoring is RICHER (4 factors vs 1 factor).
""")

# ── 4. GraphRAG (Microsoft, 2024) ──
print("""
[4] GRAPHRAG (Microsoft, 2024)
    Scoring: Community relevance via embedding similarity +
             entity co-occurrence within communities.
    
    Approach: Pre-compute communities → embed each community →
              find nearest communities at query time → return entities inside.
    
    Edge weights: NO
    Query awareness: YES (via embedding)
    Node confidence: NO
    Depth decay: NOT APPLICABLE (community-based, not traversal-based)
    
    ↔ ILO: Completely different approach.
    GraphRAG is community-summarization. ILO is traversal-based.
    GraphRAG is global (which communities are relevant).
    ILO is local (which nodes are reachable from the query).
""")

# ── 5. HippoRAG (Gutierrez et al., NeurIPS 2024) ──
print("""
[5] HIPPORAG (Gutierrez et al., NeurIPS 2024)
    Scoring: Personalized PageRank over a KG where
             edges are weighted by LLM-extracted relation strength.
    
    Edge weights: YES (LLM-extracted)
    Query awareness: YES (seeds from embedding similarity)
    Node confidence: NO
    Depth decay: IMPLICIT (PPR damping)
    
    ↔ ILO: Second closest approach after Edge-PPR.
    Similarity: Both use graph traversal from query seeds, weighted edges.
    Difference: HippoRAG uses random walk, ILO uses best-first.
    Difference: HippoRAG doesn't have node confidence or label similarity.
    Difference: HippoRAG uses LLM for edge weights, ILO uses Hebbian learning.
""")

# ── 6. MAGMA (Jiang et al., 2026) ──
print("""
[6] MAGMA (Jiang et al., Jan 2026)
    Scoring: Intent-adaptive graph traversal.
             Routes to specific relational graph (semantic/temporal/causal/entity)
             based on query intent. Then traverses that subgraph.
    
    Edge weights: YES (typed)
    Query awareness: YES (intent routing)
    Node confidence: NO
    Depth decay: EXPLICIT (decay per hop)
    
    ↔ ILO: Closest conceptual match.
    Similarity: Both use intent to select which edges to traverse.
    Similarity: Both use a frontiers-based expansion.
    Difference: MAGMA has 4 SEPARATE graphs, ILO has 1 graph with 8 edge types.
    Difference: MAGMA doesn't use node confidence.
    Difference: MAGMA's intent routing is learned, ILO's is rule-based.
""")

# ── 7. Decay-based ranking (standard practice) ──
print("""
[7] DECAY-BASED RANKING (common in graph RAG)
    Formula: score = base_score × decay_factor^depth
             where decay_factor is typically 0.5-0.85
    
    Edge weights: MAYBE
    Query awareness: YES (via seeds)
    Node confidence: NO
    Depth decay: EXPLICIT (multiplicative decay per hop)
    
    ↔ ILO: This is the simplest version of what ILO does.
    Similarity: Both decay relevance with distance from query.
    Difference: ILO's additive scoring is UNIQUE — most use multiplicative.
    Difference: Decay-based ranking is a single formula. ILO has 4 factors.
""")

# ── COMPARISON TABLE ──
print("=" * 70)
print("COMPARISON TABLE")
print("=" * 70)
print(f"")
print(f"{'Method':<20} {'EdgeWt':>7} {'QueryAware':>11} {'NodeConf':>9} {'DepthDecay':>11} {'Deterministic?':>14}")
print("-" * 72)
rows = [
    ("PageRank", "NO", "NO", "NO", "DAMPING", "YES"),
    ("Personalized PR", "NO", "YES", "NO", "DAMPING", "YES"),
    ("Edge-Weighted PPR", "YES", "YES", "NO", "DAMPING", "YES"),
    ("GraphRAG", "NO", "YES", "NO", "N/A", "YES"),
    ("HippoRAG", "YES", "YES", "NO", "DAMPING", "YES"),
    ("MAGMA", "YES", "YES", "NO", "EXPLICIT", "YES"),
    ("Decay Ranking", "MAYBE", "YES", "NO", "EXPLICIT", "YES"),
    ("ILO (YOURS)", "YES", "YES", "YES", "ADDITIVE", "YES"),
]
for row in rows:
    print(f"{row[0]:<20} {row[1]:>7} {row[2]:>11} {row[3]:>9} {row[4]:>11} {row[5]:>14}")

print("")
print("=" * 70)
print("KEY FINDING")
print("=" * 70)
print("""
ILO's scoring formula is UNIQUE in combining ALL FOUR factors:
  1. Edge weight (like Edge-PPR, HippoRAG, MAGMA)
  2. Query awareness via seeds (like PPR, HippoRAG, MAGMA)
  3. Node confidence (UNIQUE — no existing method does this)
  4. Label similarity at scoring time (UNIQUE at traversal level)

NO existing method uses node confidence as a scoring factor.
NO existing method scores each edge by label similarity during traversal.

The closest is EDGE-WEIGHTED PAGERANK, but:
  - It's random-walk (probabilistic), ILO is deterministic
  - It lacks node confidence
  - It lacks label similarity in scoring
  - Its scores are not interpretable per-node (they're probabilities)

If you fix the depth normalisation issue, your scoring formula
is strictly more expressive than any existing approach.
""")
