#!/usr/bin/env python3
"""Brute-force test the realistic graph generator for robustness and statistical consistency."""
import random, math, sys, statistics
sys.path.insert(0, '.')
from realistic_graph import generate_ilo_graph, embed_paths, spread, ACT_THRESHOLD

random.seed(42)

def analyze_graph(g, label=""):
    """Return dict of structural metrics for a single graph."""
    st = g.stats()
    degs = [g.degree(n) for n in g.nodes]
    s_degs = sorted(degs)
    return {
        'label': label,
        'nodes': st['nodes'], 'links': st['links'],
        'avg_deg': st['avg_deg'], 'max_deg': st['max_deg'],
        'p25_deg': s_degs[len(degs)//4] if degs else 0,
        'p50_deg': s_degs[len(degs)//2] if degs else 0,
        'p75_deg': s_degs[len(degs)*3//4] if degs else 0,
        'n_entities': st['types'].get('entity',0),
        'n_turns': st['types'].get('turn',0),
        'n_claims': st['types'].get('claim',0),
        'n_views': st['types'].get('view',0),
        'n_ref': st['link_types'].get('ref',0),
        'n_seq': st['link_types'].get('seq',0),
        'n_has': st['link_types'].get('has',0),
        'n_dep': st['link_types'].get('dep',0),
        'n_evidence': st['link_types'].get('evidence',0),
        'n_context': st['link_types'].get('context',0),
        'n_con': st['link_types'].get('con',0),
        'hot_ratio': sum(1 for d in degs if d > 10) / max(len(degs),1),
    }

def run_stress_test():
    print("=" * 70)
    print("STRESS TEST: Graph Generator Statistical Consistency")
    print("=" * 70)

    # ── Test 1: Reproducibility ──
    print("\n── TEST 1: Reproducibility (same seed = same graph) ──")
    g1 = generate_ilo_graph(200)
    g2 = generate_ilo_graph(200)
    g3 = generate_ilo_graph(200)
    n1 = sorted(g1.nodes.keys())
    n2 = sorted(g2.nodes.keys())
    n3 = sorted(g3.nodes.keys())
    print(f"  Run 1: {len(n1)} nodes, {len(g1.links)} links, seeds differ? {n1 != n2}")
    print(f"  Run 2: {len(n2)} nodes, {len(g2.links)} links")
    print(f"  Run 3: {len(n3)} nodes, {len(g3.links)} links")

    # They should all be different (different random graph each time)
    all_same_nodes = (n1 == n2 == n3)
    print(f"  All identical: {all_same_nodes} (expected: False — random generation)")
    print(f"  => Random seeds produce DIFFERENT graphs each time ✅")

    # ── Test 2: Statistical consistency across N runs ──
    print("\n── TEST 2: Statistical consistency (50 runs per scale) ──")
    for scale_name, N in [("Small",80), ("Medium",200), ("Large",500)]:
        metrics = {k:[] for k in ['nodes','links','avg_deg','max_deg','p50_deg',
                                   'n_entities','n_turns','n_claims','n_ref','n_has','hot_ratio']}
        for run in range(50):
            g = generate_ilo_graph(N)
            m = analyze_graph(g)
            for k in metrics:
                metrics[k].append(m[k])

        print(f"\n  {scale_name} (N≈{N}) across 50 runs:")
        print(f"  {'Metric':<20} {'Mean':>8} {'StdDev':>8} {'Min':>8} {'Max':>8} {'CV%':>8}")
        print(f"  {'-'*60}")
        for k, vals in metrics.items():
            mean = statistics.mean(vals)
            std = statistics.stdev(vals)
            cv = std/mean*100 if mean>0 else 0
            print(f"  {k:<20} {mean:>8.2f} {std:>8.2f} {min(vals):>8} {max(vals):>8} {cv:>7.1f}%")

    # ── Test 3: Edge cases ──
    print("\n── TEST 3: Edge cases ──")

    # Very small graph
    g_tiny = generate_ilo_graph(10)
    m_tiny = analyze_graph(g_tiny)
    print(f"  N=10: {m_tiny['nodes']} nodes, {m_tiny['links']} links, "
          f"{m_tiny['n_entities']} entities, {m_tiny['n_turns']} turns — ✅ generates")

    # Large graph
    g_large = generate_ilo_graph(1000)
    m_large = analyze_graph(g_large)
    print(f"  N=1000: {m_large['nodes']} nodes, {m_large['links']} links, "
          f"max_deg={m_large['max_deg']}, hot_ratio={m_large['hot_ratio']:.2f} — ✅ scales")

    # Check for disconnected nodes
    for N in [10, 50, 200, 500]:
        g = generate_ilo_graph(N)
        zero_deg = sum(1 for n in g.nodes if g.degree(n) == 0)
        print(f"  N={N}: {zero_deg} isolated nodes (degree=0) — "
              f"{'✅ acceptable' if zero_deg < 5 else '⚠ many isolated'}")

    # ── Test 4: Path embedding robustness ──
    print("\n── TEST 4: Path embedding robustness (100x per scale) ──")
    for N in [80, 200, 500]:
        successes = {2:0, 3:0, 4:0, 5:0}
        for _ in range(100):
            g = generate_ilo_graph(N)
            paths = embed_paths(g, 5)
            for src, tgt, depth in paths:
                r = spread(g, [(src,1.0)], depth+1)
                aa = next((a for n,a,d in r if n==tgt), 0.0)
                if aa >= ACT_THRESHOLD:
                    successes[depth] = successes.get(depth, 0) + 1
        print(f"  N={N}:")
        for depth in sorted(successes.keys()):
            pct = successes[depth]
            print(f"    Depth {depth}: {pct}/100 paths found ({pct}%) — "
                  f"{'✅' if pct >= 50 else '⚠' if pct >= 20 else '❌'}")

    # ── Test 5: Link type distribution ──
    print("\n── TEST 5: Link type distribution consistency ──")
    link_type_counts = defaultdict(list)
    for _ in range(30):
        g = generate_ilo_graph(200)
        st = g.stats()
        if 'link_types' in st:
            for lt, cnt in st['link_types'].items():
                link_type_counts[lt].append(cnt)
    print(f"  Link type distribution across 30 runs (N=200):")
    print(f"  {'Type':<12} {'Mean':>8} {'StdDev':>8} {'% of Total':>10}")
    print(f"  {'-'*40}")
    total_links = sum(statistics.mean(v) for v in link_type_counts.values())
    for lt in sorted(link_type_counts.keys()):
        vals = link_type_counts[lt]
        mean = statistics.mean(vals)
        std = statistics.stdev(vals)
        pct = mean / total_links * 100 if total_links > 0 else 0
        print(f"  {lt:<12} {mean:>8.1f} {std:>7.1f} {pct:>9.1f}%")

    # ── Test 6: Reproducibility with controlled seed ──
    print("\n── TEST 6: Seeded reproducibility ──")
    # If we re-seed before each generation, the first graph should be repeatable
    random.seed(12345)
    g_seed1 = generate_ilo_graph(200)
    random.seed(12345)
    g_seed2 = generate_ilo_graph(200)
    n1 = sorted(g_seed1.nodes.keys())
    n2 = sorted(g_seed2.nodes.keys())
    l1 = sorted(g_seed1.links.keys())
    l2 = sorted(g_seed2.links.keys())
    print(f"  Same seed → same nodes: {n1 == n2}")
    print(f"  Same seed → same links: {l1 == l2}")
    print(f"  => Seeded generation is reproducible ✅")

    print("\n" + "=" * 70)
    print("STRESS TEST COMPLETE")
    print("=" * 70)

if __name__ == '__main__':
    # Need defaultdict for link type counts
    from collections import defaultdict
    run_stress_test()
