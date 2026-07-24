#!/usr/bin/env python3
"""Systematic scoring formula optimisation.
Tests 8+ formula variants against ground-truth queries on realistic graphs.
Finds which variant best ranks correct answers at the top."""

import csv, math, random, statistics, time
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph, embed_paths, Graph

random.seed(42)

# ── Scoring formula variants to test ──

def score_v1_type_relevance(etype, intent): return 1.0 if etype in intent else 0.3
def score_v1(prev, depth, tr, ew, tc, ls):
    """Current ILO: additive, no normalisation"""
    return prev + tr * ew * tc * ls

def score_v2(prev, depth, tr, ew, tc, ls):
    """Depth-normalised: divide by depth"""
    return (prev + tr * ew * tc * ls) / (1 + depth)

def score_v3(prev, depth, tr, ew, tc, ls):
    """Multiplicative: product accumulates"""
    return prev * (tr * ew * tc * ls)

def score_v4(prev, depth, tr, ew, tc, ls):
    """Weighted sum: equal weights"""
    return prev + (tr + ew + tc + ls) / 4

def score_v5(prev, depth, tr, ew, tc, ls):
    """PageRank-style: prev decays, new info adds"""
    return 0.85 * prev + 0.15 * (tr * ew * tc * ls)

def score_v6(prev, depth, tr, ew, tc, ls):
    """Decay-based: exponential decay per hop"""
    return prev + (tr * ew * tc * ls) * (0.5 ** depth)

def score_v7(prev, depth, tr, ew, tc, ls):
    """Log-weighted: logarithmic decay per hop"""
    return prev + (tr * ew * tc * ls) / math.log2(2 + depth)

def score_v8(prev, depth, tr, ew, tc, ls):
    """Min-factor: worst factor dominates"""
    return prev + min(tr, ew, tc, ls)

def score_v9(prev, depth, tr, ew, tc, ls):
    """Confidence-scaled: trust * similarity dominates"""
    return prev + (tc * ls) * (0.7 + 0.3 * ew * tr)

def score_v10(prev, depth, tr, ew, tc, ls):
    """Bounded additive: cap at 1.0 per hop"""
    return min(1.0, prev + tr * ew * tc * ls)

VARIANTS = [
    ("V1 Additive (current)", score_v1),
    ("V2 Depth-normalised", score_v2),
    ("V3 Multiplicative", score_v3),
    ("V4 Weighted sum", score_v4),
    ("V5 PPR-style", score_v5),
    ("V6 Exponential decay", score_v6),
    ("V7 Log-weighted", score_v7),
    ("V8 Min-factor", score_v8),
    ("V9 Confidence-scaled", score_v9),
    ("V10 Capped additive", score_v10),
]

# ── Ground-truth queries ──
# Each query has: query string, intent, expected answer type, how to verify
GROUND_TRUTH = [
    {
        "query": "What projects does Alice work on?",
        "intent": "project",
        "verify": lambda nid, nd: nd.get('subtype') == 'project' and nd.get('conf',0) > 0.7,
        "desc": "find high-conf projects"
    },
    {
        "query": "Tell me about Rust",
        "intent": "reference",
        "verify": lambda nid, nd: nd.get('label','').lower() == 'rust',
        "desc": "find exact entity"
    },
    {
        "query": "What depends on Candle?",
        "intent": "dependency",
        "verify": lambda nid, nd: nd.get('subtype') in ('tool','language'),
        "desc": "find tools/languages depending on Candle"
    },
    {
        "query": "What do you know about LadybugDB?",
        "intent": "reference",
        "verify": lambda nid, nd: nd.get('label','').lower() == 'ladybugdb',
        "desc": "find exact entity"
    },
]

# ── Modified retrieve that accepts custom scoring function ──
def retrieve_custom(query, graph, score_fn, min_score=0.05, max_hops=4):
    """Same as retrieve() but uses custom score_fn instead of hardcoded formula."""
    from guided_retrieval import classify_intent, INTENT_EDGES, find_seeds, label_sim
    
    intent = classify_intent(query)
    etypes = INTENT_EDGES.get(intent, INTENT_EDGES['generic'])
    seeds = find_seeds(query, graph)
    if not seeds:
        return []
    
    visited = set()
    frontier = []
    for nid, s in seeds:
        frontier.append((nid, 0, s, [nid]))
        visited.add(nid)
    
    collected = []
    
    while frontier:
        frontier.sort(key=lambda x: -x[2])
        nid, depth, cscore, path = frontier.pop(0)
        
        props = graph.props.get(nid, {})
        collected.append((nid, cscore, depth, path, props))
        
        if depth >= max_hops:
            continue
        nd = graph.nodes.get(nid)
        if not nd:
            continue
        
        # Process incident edges
        edges = []
        for lid in graph.out.get(nid, []):
            if lid in graph.links: edges.append((*graph.links[lid], 'out'))
        for lid in graph.inn.get(nid, []):
            if lid in graph.links:
                l = graph.links[lid]
                edges.append((l[0], l[1], l[2], l[3], l[4], 'in'))
        
        for frm, to, ltype, w, age, direction in edges:
            target = to if direction == 'out' else frm
            if target in visited: continue
            
            # Type relevance
            tr = 1.0 if ltype in etypes else 0.3
            td = graph.nodes.get(target)
            if not td: continue
            tc = td['conf']
            tl = td.get('label', '')
            tp = graph.props.get(target, {})
            ls = label_sim(query, tl, td.get('subtype'), tp)
            
            # Use the custom scoring function
            new_score = score_fn(cscore, depth, tr, w, tc, ls)
            
            if new_score >= min_score:
                frontier.append((target, depth + 1, new_score, path + [target]))
                visited.add(target)
    
    collected.sort(key=lambda x: -x[1])
    return collected

def evaluate_variant(variant_name, score_fn, trials=20):
    """Test a scoring variant against all ground-truth queries.
    Returns: average rank of correct answer, average score, etc."""
    
    results = {}
    for gt in GROUND_TRUTH:
        query = gt["query"]
        verify = gt["verify"]
        
        correct_ranks = []
        correct_scores = []
        
        for _ in range(trials):
            g = generate_ilo_graph(200)
            results_list = retrieve_custom(query, g, score_fn)
            
            # Find rank of first correct answer
            found = False
            for rank, (nid, score, depth, path, props) in enumerate(results_list):
                nd = g.nodes.get(nid)
                if nd and verify(nid, nd):
                    correct_ranks.append(rank + 1)  # 1-indexed
                    correct_scores.append(score)
                    found = True
                    break
            if not found:
                correct_ranks.append(999)  # not found = worst rank
                correct_scores.append(0.0)
        
        avg_rank = statistics.mean(correct_ranks)
        avg_score = statistics.mean(correct_scores)
        found_pct = sum(1 for r in correct_ranks if r < 999) / len(correct_ranks) * 100
        
        results[gt["desc"]] = {
            'avg_rank': avg_rank,
            'avg_score': avg_score,
            'found_pct': found_pct,
        }
    
    return results

def run():
    print("=" * 70)
    print("SCORING FORMULA OPTIMISATION — 10 variants × 4 ground-truth queries")
    print("=" * 70)
    
    all_results = {}
    
    for name, fn in VARIANTS:
        print(f"\n── {name} ──")
        results = evaluate_variant(name, fn, 15)
        all_results[name] = results
        
        for desc, metrics in results.items():
            print(f"  {desc:<35} rank={metrics['avg_rank']:>6.2f}  "
                  f"score={metrics['avg_score']:>6.3f}  "
                  f"found={metrics['found_pct']:>5.1f}%")
    
    # ── Ranking ──
    print("\n" + "=" * 70)
    print("OVERALL RANKING — Best scoring formula")
    print("=" * 70)
    print(f"\n{'Rank':<6} {'Variant':<25} {'Avg Rank':>10} {'Avg Score':>10} {'Found%':>8} {'Score':>8}")
    print("-" * 67)
    
    # Compute composite score: low rank + high score + high found%
    variant_scores = []
    for name, results in all_results.items():
        avg_rank = statistics.mean([r['avg_rank'] for r in results.values()])
        avg_score = statistics.mean([r['avg_score'] for r in results.values()])
        avg_found = statistics.mean([r['found_pct'] for r in results.values()])
        # Composite: lower rank is better, higher score is better, higher found% is better
        # Normalise each to 0-1 scale, then average
        composite = (1.0 / max(avg_rank, 0.1)) * 0.4 + (avg_score) * 0.3 + (avg_found / 100.0) * 0.3
        variant_scores.append((name, avg_rank, avg_score, avg_found, composite))
    
    variant_scores.sort(key=lambda x: -x[4])
    
    for i, (name, rank, score, found, comp) in enumerate(variant_scores):
        medal = ["🥇","🥈","🥉"][i] if i < 3 else f"{i+1}."
        print(f"  {medal:<6} {name:<25} {rank:>10.2f} {score:>10.3f} {found:>7.1f}% {comp:>8.3f}")

if __name__ == '__main__':
    run()
