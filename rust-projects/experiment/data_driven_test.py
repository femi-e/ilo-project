#!/usr/bin/env python3
"""Data-driven stress test for the realistic graph generator.
Computes metrics first, generates text from computed values only."""
import math, random, statistics, sys
from collections import defaultdict
sys.path.insert(0, '.')
from realistic_graph import generate_ilo_graph, Graph

random.seed(42)

def degree_distribution(g):
    degs = [g.degree(n) for n in g.nodes]
    s = sorted(degs)
    n = len(s)
    return {
        'min': s[0], 'max': s[-1], 'mean': sum(s)/n,
        'p25': s[n//4], 'p50': s[n//2], 'p75': s[3*n//4],
        'p90': s[int(n*0.9)], 'p99': s[int(n*0.99)],
        'gini': gini_coefficient(s),
    }

def gini_coefficient(xs):
    xs = sorted(xs)
    n = len(xs)
    if n == 0 or sum(xs) == 0: return 0.0
    return (2 * sum((i+1)*v for i,v in enumerate(xs))) / (n * sum(xs)) - (n+1)/n

def power_law_exponent(g):
    """Estimate power-law exponent alpha from degree distribution.
    Uses maximum likelihood estimator for continuous power law (Clauset et al.)."""
    degs = [g.degree(n) for n in g.nodes if g.degree(n) > 0]
    if len(degs) < 10: return None
    n = len(degs)
    xmin = min(degs)
    # MLE for continuous power law
    sum_log = sum(math.log(d/xmin) for d in degs)
    alpha = 1 + n * (sum_log ** -1) if sum_log > 0 else None
    return alpha

def clustering_coefficient(g):
    """Average local clustering coefficient. Measures small-world property."""
    total_c = 0.0
    n_considered = 0
    for nid in g.nodes:
        neighbors = set()
        for lid in g.out.get(nid,[]):
            if lid in g.links: neighbors.add(g.links[lid][1])
        for lid in g.inn.get(nid,[]):
            if lid in g.links: neighbors.add(g.links[lid][0])
        k = len(neighbors)
        if k < 2: continue
        # Count edges between neighbors
        edges = 0
        for n1 in neighbors:
            for n2 in neighbors:
                if n1 >= n2: continue
                if any(l[0]==n1 and l[1]==n2 for l in g.links.values()) or \
                   any(l[0]==n2 and l[1]==n1 for l in g.links.values()):
                    edges += 1
        total_c += 2 * edges / (k * (k-1))
        n_considered += 1
    return total_c / n_considered if n_considered > 0 else 0.0

def avg_shortest_path(g, sample_size=100):
    """Compute average shortest path length from a sample of nodes (BFS from each).
    Approximates Watts-Strogatz small-world property."""
    nodes = list(g.nodes.keys())
    if len(nodes) < 2: return 0.0
    # Sample a subset for speed
    if len(nodes) > sample_size:
        sample = random.sample(nodes, sample_size)
    else:
        sample = nodes
    total_dist = 0
    n_pairs = 0
    for src in sample:
        # BFS to all reachable nodes
        visited = {src: 0}
        queue = [src]
        while queue:
            cur = queue.pop(0)
            for lid in g.out.get(cur,[]):
                if lid in g.links:
                    nxt = g.links[lid][1]
                    if nxt not in visited:
                        visited[nxt] = visited[cur] + 1
                        queue.append(nxt)
            for lid in g.inn.get(cur,[]):
                if lid in g.links:
                    nxt = g.links[lid][0]
                    if nxt not in visited and nxt != cur:
                        visited[nxt] = visited[cur] + 1
                        queue.append(nxt)
        for d in visited.values():
            if d > 0:
                total_dist += d
                n_pairs += 1
    return total_dist / n_pairs if n_pairs > 0 else 0.0

def connectivity_analysis(g):
    """Measure graph connectivity: largest component, isolated nodes."""
    nodes = list(g.nodes.keys())
    if not nodes: return {}
    visited_all = set()
    components = []
    for start in nodes:
        if start in visited_all: continue
        # BFS
        comp = set()
        stack = [start]
        while stack:
            n = stack.pop()
            if n in comp: continue
            comp.add(n)
            for lid in g.out.get(n,[]):
                if lid in g.links:
                    t = g.links[lid][1]
                    if t not in comp: stack.append(t)
            for lid in g.inn.get(n,[]):
                if lid in g.links:
                    t = g.links[lid][0]
                    if t not in comp: stack.append(t)
        visited_all.update(comp)
        components.append(comp)
    components.sort(key=len, reverse=True)
    largest = len(components[0]) / len(nodes) * 100 if components else 0
    isolated = sum(1 for n in g.nodes if g.degree(n) == 0)
    num_components = len(components)
    return {
        'largest_component_pct': largest,
        'num_components': num_components,
        'isolated_nodes': isolated,
    }

def link_type_analysis(g):
    """Measure distribution of link types."""
    counts = defaultdict(int)
    for l in g.links.values():
        counts[l[2]] += 1
    total = sum(counts.values())
    return {k: {'count': v, 'pct': v/total*100} for k,v in sorted(counts.items())}

def node_type_analysis(g):
    """Measure distribution of node types."""
    counts = defaultdict(int)
    for n in g.nodes.values():
        counts[n['type']] += 1
    return dict(counts)

def property_coverage(g):
    """Measure what fraction of nodes have properties."""
    n_with_props = sum(1 for nid in g.nodes if g.props.get(nid, {}))
    avg_props = statistics.mean([len(g.props.get(nid,{})) for nid in g.nodes]) if g.nodes else 0
    return {
        'pct_with_props': n_with_props / len(g.nodes) * 100 if g.nodes else 0,
        'avg_props_per_node': avg_props,
    }

def small_world_quotient(g):
    """Compute small-world quotient: (C/C_random) / (L/L_random).
    Values > 1 indicate small-world properties."""
    C = clustering_coefficient(g)
    L = avg_shortest_path(g)
    # Estimate random graph equivalents
    n = len(g.nodes)
    e = len(g.links)
    k = 2*e/n if n > 0 else 0
    C_random = k / n if n > 0 else 0
    L_random = math.log(n) / math.log(k) if k > 1 and n > 1 else 0
    if C_random == 0 or L_random == 0: return None
    C_ratio = C / C_random
    L_ratio = L / L_random if L_random > 0 else float('inf')
    return C_ratio / L_ratio if L_ratio > 0 else None

def run():
    print("=" * 70)
    print("DATA-DRIVEN GRAPH GENERATOR STRESS TEST")
    print("=" * 70)

    scales = [("Tiny", 30), ("Small", 80), ("Medium", 200), ("Large", 500)]
    all_metrics = {}

    for scale_name, N in scales:
        print(f"\n── {scale_name} (N≈{N}) — 30 runs each ──")

        run_metrics = {k:[] for k in ['nodes','links','avg_deg','max_deg','gini','alpha',
                                       'clustering','path_length','small_world',
                                       'largest_comp','isolated','n_ref','n_has',
                                       'n_evidence','n_seq','n_dep','n_context',
                                       'pct_entity','pct_turn','pct_claim',
                                       'prop_coverage']}

        for run_idx in range(30):
            g = generate_ilo_graph(N)
            dd = degree_distribution(g)
            conn = connectivity_analysis(g)
            lta = link_type_analysis(g)
            nta = node_type_analysis(g)
            pc = property_coverage(g)

            run_metrics['nodes'].append(len(g.nodes))
            run_metrics['links'].append(len(g.links))
            run_metrics['avg_deg'].append(dd['mean'])
            run_metrics['max_deg'].append(dd['max'])
            run_metrics['gini'].append(dd['gini'])
            run_metrics['alpha'].append(power_law_exponent(g) or 0)
            run_metrics['clustering'].append(clustering_coefficient(g))
            run_metrics['path_length'].append(avg_shortest_path(g, 50))
            run_metrics['small_world'].append(small_world_quotient(g) or 0)
            run_metrics['largest_comp'].append(conn['largest_component_pct'])
            run_metrics['isolated'].append(conn['isolated_nodes'])
            run_metrics['n_ref'].append(lta.get('ref',{}).get('count',0))
            run_metrics['n_has'].append(lta.get('has',{}).get('count',0))
            run_metrics['n_evidence'].append(lta.get('evidence',{}).get('count',0))
            run_metrics['n_seq'].append(lta.get('seq',{}).get('count',0))
            run_metrics['n_dep'].append(lta.get('dep',{}).get('count',0))
            run_metrics['n_context'].append(lta.get('context',{}).get('count',0))
            run_metrics['pct_entity'].append(nta.get('entity',0)/len(g.nodes)*100)
            run_metrics['pct_turn'].append(nta.get('turn',0)/len(g.nodes)*100)
            run_metrics['pct_claim'].append(nta.get('claim',0)/len(g.nodes)*100)
            run_metrics['prop_coverage'].append(pc['pct_with_props'])

        all_metrics[scale_name] = run_metrics

        # Generate summary from computed values
        report = {}
        for k, vals in run_metrics.items():
            vals = [v for v in vals if v is not None and not (isinstance(v,float) and math.isnan(v))]
            if vals:
                report[k] = (statistics.mean(vals), statistics.stdev(vals) if len(vals)>1 else 0,
                             min(vals), max(vals))

        print(f"  {'Metric':<25} {'Mean':>10} {'Std':>8} {'Min':>8} {'Max':>8} {'CV%':>7}")
        print(f"  {'-'*68}")
        for k in sorted(report.keys()):
            mn, sd, lo, hi = report[k]
            cv = sd/mn*100 if mn>0 else 0
            print(f"  {k:<25} {mn:>10.3f} {sd:>8.3f} {lo:>8} {hi:>8} {cv:>6.1f}%")

    # Cross-scale consistency analysis (computed from actual data)
    print("\n── CROSS-SCALE CONSISTENCY ──")
    print(f"  {'Metric':<25} {'Tiny':>10} {'Small':>10} {'Med':>10} {'Large':>10}")
    print(f"  {'-'*65}")
    check_metrics = ['avg_deg','gini','clustering','largest_comp','pct_entity','pct_turn','pct_claim']
    for k in check_metrics:
        vals = []
        for sn in ['Tiny','Small','Medium','Large']:
            mn, _, _, _ = report = list(all_metrics[sn][k]) if k in all_metrics[sn] else (0,0,0,0)
            # Recompute
            vals_list = all_metrics[sn][k]
            vals_list = [v for v in vals_list if v is not None]
            m = statistics.mean(vals_list) if vals_list else 0
            vals.append(m)
        print(f"  {k:<25} {vals[0]:>10.3f} {vals[1]:>10.3f} {vals[2]:>10.3f} {vals[3]:>10.3f}")

    # Literature comparison (from known values)
    print("\n── LITERATURE COMPARISON ──")
    print(f"  Reference values from real-world semantic networks and KGs:")
    lit = [
        ("Power-law exponent α", "2.0-3.0 (real networks)", 2.5, all_metrics['Medium']['alpha']),
        ("Gini coefficient", "0.6-0.8 (power-law)", 0.7, all_metrics['Medium']['gini']),
        ("Clustering coeff C", "0.1-0.3 (small-world)", 0.2, all_metrics['Medium']['clustering']),
        ("Small-world quotient", "> 1.0 (small-world)", 2.0, all_metrics['Medium']['small_world']),
        ("Largest component %", "> 90% (connected)", 95.0, all_metrics['Medium']['largest_comp']),
    ]
    print(f"  {'Metric':<30} {'Expected':<25} {'Target':>8} {'Actual':>8} {'Status':>8}")
    print(f"  {'-'*80}")
    for name, expected, target, vals in lit:
        vals = [v for v in vals if v is not None and not (isinstance(v,float) and math.isnan(v))]
        actual = statistics.mean(vals) if vals else 0
        ok = abs(actual-target)/max(target,0.001) < 0.5
        print(f"  {name:<30} {expected:<25} {target:>8.2f} {actual:>8.2f} {'✅' if ok else '❌'}")

if __name__ == '__main__':
    run()
