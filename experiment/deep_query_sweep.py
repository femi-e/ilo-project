#!/usr/bin/env python3
"""Parameter sweep for DEEP queries (depth 2-5).
Uses embedded paths in realistic graphs to test multi-hop retrieval."""
import math, random, statistics, time
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph, embed_paths

# Re-use the parametrised retrieve
from param_sweep import retrieve_p, find_seeds, classify_intent, INTENT_EDGES

random.seed(42)

print("="*70)
print("DEEP QUERY PARAMETER SWEEP")
print("="*70)

# ── Generate test cases with known path depths ──
def generate_deep_test_cases(n_cases=40):
    """Generate test cases where the answer is at known depth."""
    cases = []  # (query_name, src_id, tgt_id, depth)
    for _ in range(n_cases):
        g = generate_ilo_graph(200)
        paths = embed_paths(g, n_paths=4)
        for src, tgt, depth in paths:
            cases.append((f"depth_{depth}", src, tgt, depth, g))
    return cases

# ── Evaluate a config against all test cases ──
def eval_on_deep_cases(cases, damping, min_score, max_hops, type_penalty):
    ranks_by_depth = defaultdict(list)
    for name, src, tgt, depth, g in cases:
        # Use the source entity's label as the query
        src_label = g.nodes.get(src, {}).get('label', src)
        query = f"Tell me about {src_label}"
        
        r = retrieve_p(query, g, damping, min_score, max_hops, type_penalty)
        
        found = False
        for rank, (nid, scr, d, path, lbl, props, ntype) in enumerate(r[:200]):
            if nid == tgt:
                ranks_by_depth[depth].append(rank + 1)
                found = True
                break
        if not found:
            ranks_by_depth[depth].append(999)
    return ranks_by_depth

# ── Generate test cases ──
print("\n── Generating deep test cases... ──")
all_cases = generate_deep_test_cases(60)
# Count by depth
depth_counts = defaultdict(int)
for _, _, _, d, _ in all_cases:
    depth_counts[d] += 1
for d in sorted(depth_counts.keys()):
    print(f"  Depth {d}: {depth_counts[d]} cases")
print(f"  Total: {len(all_cases)} cases")

# ── Phase 1: Baseline ──
print("\n── PHASE 1: Baseline (default parameters) ──")
baseline_ranks = eval_on_deep_cases(all_cases, 0.85, 0.02, 4, 0.3)
print(f"  {'Depth':>6} {'Avg Rank':>10} {'Found%':>8} {'Median':>8}")
print(f"  {'-'*35}")
for d in sorted(baseline_ranks.keys()):
    r = baseline_ranks[d]
    avg = statistics.mean(r)
    med = sorted(r)[len(r)//2]
    found = sum(1 for rr in r if rr < 999)/len(r)*100
    status = "✅" if avg < 5 and found > 80 else "⚠" if found > 50 else "❌"
    print(f"  {status} {d:>5} {avg:>10.2f} {found:>7.0f}% {med:>8.0f}")

# ── Phase 2: Damping sweep by depth ──
print("\n── PHASE 2: Damping Effect by Depth ──")
for damp in [0.70, 0.80, 0.85, 0.90, 0.95]:
    ranks = eval_on_deep_cases(all_cases, damp, 0.02, 4, 0.3)
    print(f"\n  damping={damp:.2f}:")
    print(f"  {'Depth':>6} {'Avg Rank':>10} {'Found%':>8}")
    for d in sorted(ranks.keys()):
        r = ranks[d]
        avg = statistics.mean(r)
        found = sum(1 for rr in r if rr < 999)/len(r)*100
        status = "✅" if avg < 5 and found > 80 else "⚠" if found > 50 else "❌"
        print(f"  {status} {d:>5} {avg:>10.2f} {found:>7.0f}%")

# ── Phase 3: Type penalty sweep by depth ──
print("\n── PHASE 3: Type Penalty Effect by Depth ──")
for tp in [0.1, 0.3, 0.5, 0.7, 1.0]:
    ranks = eval_on_deep_cases(all_cases, 0.85, 0.02, 4, tp)
    print(f"\n  type_penalty={tp:.1f}:")
    print(f"  {'Depth':>6} {'Avg Rank':>10} {'Found%':>8}")
    for d in sorted(ranks.keys()):
        r = ranks[d]
        avg = statistics.mean(r)
        found = sum(1 for rr in r if rr < 999)/len(r)*100
        status = "✅" if avg < 5 and found > 80 else "⚠" if found > 50 else "❌"
        print(f"  {status} {d:>5} {avg:>10.2f} {found:>7.0f}%")

# ── Phase 4: Max hops effect by depth ──
print("\n── PHASE 4: Max Hops Effect by Depth ──")
for mh in [2, 3, 4, 5, 6]:
    ranks = eval_on_deep_cases(all_cases, 0.85, 0.02, mh, 0.3)
    print(f"\n  max_hops={mh}:")
    print(f"  {'Depth':>6} {'Avg Rank':>10} {'Found%':>8}")
    for d in sorted(ranks.keys()):
        r = ranks[d]
        avg = statistics.mean(r)
        found = sum(1 for rr in r if rr < 999)/len(r)*100
        status = "✅" if avg < 5 and found > 80 else "⚠" if found > 50 else "❌"
        print(f"  {status} {d:>5} {avg:>10.2f} {found:>7.0f}%")

# ── Phase 5: Combined best ──
print("\n── PHASE 5: Optimal Configuration ──")
# Test combinations that might work best for deep queries
candidates = [
    ("Default", 0.85, 0.02, 4, 0.3),
    ("Low damp + low pen", 0.75, 0.02, 5, 0.2),
    ("High damp + high hops", 0.90, 0.01, 6, 0.3),
    ("Aggressive deep", 0.80, 0.005, 5, 0.1),
    ("Conservative", 0.90, 0.05, 3, 0.5),
]

for name, damp, ms, mh, tp in candidates:
    ranks = eval_on_deep_cases(all_cases, damp, ms, mh, tp)
    print(f"\n  {name}: d={damp} ms={ms} mh={mh} tp={tp}")
    print(f"  {'Depth':>6} {'Avg Rank':>10} {'Found%':>8}")
    overall_rank = 0; overall_count = 0
    for d in sorted(ranks.keys()):
        r = ranks[d]
        avg = statistics.mean(r)
        found = sum(1 for rr in r if rr < 999)/len(r)*100
        overall_rank += sum(rr for rr in r if rr < 999)
        overall_count += sum(1 for rr in r if rr < 999)
        print(f"  {'':>2} {d:>3} {avg:>10.2f} {found:>7.0f}%")
    overall = overall_rank / max(overall_count, 1) if overall_count else 999
    print(f"  {'':>2} {'ALL':>3} {overall:>10.2f}")
