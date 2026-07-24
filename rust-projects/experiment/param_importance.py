#!/usr/bin/env python3
"""Parameter importance analysis — which parameters most affect retrieval quality?
Method: start with minimal formula, add one parameter at a time, measure improvement."""

import math, random, statistics, time
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph

random.seed(42)

# ── Reusable retrieval core with configurable scoring ──

def label_sim(query, label, subtype=None, props=None):
    q=query.lower(); l=label.lower()
    if q==l: return 1.0
    if l in q or q in l: return 0.6
    qw=set(q.split()); lw=set(l.split())
    if qw&lw: return 0.4
    if subtype:
        for word,st in [("project","project"),("person","person"),("tool","tool"),
                        ("language","language"),("concept","concept")]:
            if word in q and st==subtype: return 0.5
    if props:
        for v in props.values():
            if isinstance(v,str) and (q in v.lower() or v.lower() in q): return 0.5
    return 0.2

def classify_intent(q):
    q=q.lower()
    if any(w in q for w in["project","works on","works for","employed","job","role"]):return"project"
    if any(w in q for w in["depend","need","require","prerequisite","blocked"]):return"dependency"
    if any(w in q for w in["conflict","contradict","disagree","versus"]):return"conflict"
    if any(w in q for w in["evidence","proof","support","show","demonstrate"]):return"evidence"
    if any(w in q for w in["mention","about","refer","said","talked"]):return"reference"
    if any(w in q for w in["before","after","timeline","sequence","order","when"]):return"sequence"
    if any(w in q for w in["contain","part of","belong","include","member"]):return"composition"
    if any(w in q for w in["context","related","around","background"]):return"context"
    return"generic"

INTENT_EDGES = {
    "project":["has","ref"],"membership":["has","ref"],"employment":["has","ref"],
    "dependency":["dep"],"requirement":["dep"],
    "conflict":["con","refute"],
    "evidence":["evidence"],"support":["evidence"],
    "reference":["ref","context"],"mention":["ref"],
    "sequence":["seq"],"timeline":["seq"],
    "composition":["has"],"hierarchy":["has"],
    "context":["context","ref"],
    "generic":["has","ref","dep","evidence","context"],
}

def find_seeds(query, graph):
    q=query.lower(); seeds=[]
    for nid,nd in graph.nodes.items():
        lbl=nd.get('label','').lower()
        if not lbl: continue
        if q==lbl: seeds.append((nid,1.0))
        elif q in lbl or lbl in q: seeds.append((nid,0.7))
    dedup={}
    for nid,s in seeds:
        if nid not in dedup or s>dedup[nid]: dedup[nid]=s
    r=[(n,s) for n,s in dedup.items()]; r.sort(key=lambda x:-x[1])
    return r[:5]

# ── Parameterised scoring formula ──
# Each parameter can be independently enabled/disabled with weight coefficient

def retrieve_param(query, graph, params, min_score=0.05, max_hops=4):
    """Retrieval where params dict controls which factors are used.
    params = {
        'edge_weight': weight,
        'node_confidence': weight,
        'label_similarity': weight,
        'type_relevance': weight,
        'node_type_bonus': weight,
        'recency_bonus': weight,
        'hub_penalty': weight,
        'path_diversity': weight,
        'depth_penalty': power,
    }
    """
    intent=classify_intent(query)
    etypes=INTENT_EDGES.get(intent,INTENT_EDGES['generic'])
    seeds=find_seeds(query,graph)
    if not seeds: return []

    visited=set(); frontier=[]
    for nid,s in seeds:
        frontier.append((nid,0,s,[nid])); visited.add(nid)
    collected=[]

    while frontier:
        frontier.sort(key=lambda x:-x[2])
        nid,depth,cscore,path=frontier.pop(0)
        collected.append((nid,cscore,depth,path))
        if depth>=max_hops: continue
        nd=graph.nodes.get(nid)
        if not nd: continue

        edges=[]
        for lid in graph.out.get(nid,[]):
            if lid in graph.links: edges.append((*graph.links[lid],'out'))
        for lid in graph.inn.get(nid,[]):
            if lid in graph.links:
                l=graph.links[lid]
                edges.append((l[0],l[1],l[2],l[3],l[4],'in'))

        for frm,to,ltype,w,age,direction in edges:
            target=to if direction=='out' else frm
            if target in visited: continue
            td=graph.nodes.get(target)
            if not td: continue

            # ── Compute each factor ──
            factors = []

            # Edge weight
            ew = w
            factors.append(ew * params.get('edge_weight', 1.0))

            # Node confidence
            tc = td['conf']
            factors.append(tc * params.get('node_confidence', 1.0))

            # Label similarity
            tl=td.get('label','')
            tp=graph.props.get(target,{})
            ls=label_sim(query,tl,td.get('subtype'),tp)
            factors.append(ls * params.get('label_similarity', 1.0))

            # Type relevance
            tr = 1.0 if ltype in etypes else 0.3
            factors.append(tr * params.get('type_relevance', 1.0))

            # Node type bonus (entity > turn > claim > view)
            type_bonus_map = {'entity':1.0, 'turn':0.7, 'claim':0.6, 'view':0.5}
            ntb = type_bonus_map.get(td.get('type',''), 0.5)
            factors.append(ntb * params.get('node_type_bonus', 0.0))

            # Recency bonus (newer = better)
            age_hours = age if age else 5000
            rec = 1.0 / (1.0 + age_hours * 0.0001)
            factors.append(rec * params.get('recency_bonus', 0.0))

            # Hub penalty (in-degree)
            ideg = len(graph.inn.get(target, []))
            hub_p = 1.0 / (1.0 + math.sqrt(ideg) * 0.1)
            factors.append(hub_p * params.get('hub_penalty', 0.0))

            # Path diversity (how many different paths reach this node)
            path_div = 1.0  # simplified
            factors.append(path_div * params.get('path_diversity', 0.0))

            # Depth penalty
            dp = 1.0 / ((1 + depth) ** params.get('depth_penalty', 1.0))

            # Combine: weighted product with depth penalty
            product = 1.0
            for f in factors:
                if f > 0: product *= f
            if sum(1 for f in factors if f > 0) == 0: product = 0.0
            
            new_score = cscore * (1.0 - 0.15) + 0.15 * product * dp

            if new_score >= min_score:
                frontier.append((target,depth+1,new_score,path+[target]))
                visited.add(target)

    collected.sort(key=lambda x:-x[1])
    return collected

# ── Ground truth queries ──
GROUND_TRUTH = [
    {"query":"What projects does Alice work on?", "intent":"project",
     "verify":lambda nid,nd,g: nd.get('subtype')=='project' and nd.get('conf',0)>0.7},
    {"query":"Tell me about Rust", "intent":"reference",
     "verify":lambda nid,nd,g: nd.get('label','').lower()=='rust'},
    {"query":"What depends on Candle?", "intent":"dependency",
     "verify":lambda nid,nd,g: nd.get('subtype') in ('tool','language')},
    {"query":"What evidence supports Hebbian Learning?", "intent":"evidence",
     "verify":lambda nid,nd,g: nd.get('label','').lower()=='hebbian learning'},
]

def evaluate_params(params, label, trials=12):
    """Test a parameter configuration against ground truth."""
    scores = []
    for gt in GROUND_TRUTH:
        ranks = []
        for _ in range(trials):
            g = generate_ilo_graph(200)
            r = retrieve_param(gt['query'], g, params)
            found = False
            for rank,(nid,score,depth,path) in enumerate(r):
                nd = g.nodes.get(nid)
                if nd and gt['verify'](nid,nd,g):
                    ranks.append(rank+1); found=True; break
            if not found: ranks.append(999)
        avg_rank = statistics.mean(ranks)
        scores.append(avg_rank)
    return statistics.mean(scores)

def run():
    print("="*70)
    print("PARAMETER IMPORTANCE ANALYSIS")
    print("="*70)
    print("\nMethod: start with bare minimum formula, add one parameter at a time.")
    print("Each parameter tested at weight=1.0 (fully enabled).")
    print("Lower composite rank = better retrieval.\n")

    # Baseline: only edge_weight and depth_penalty (PPR-style skeleton)
    baseline_params = {
        'edge_weight': 1.0, 'node_confidence': 0.0, 'label_similarity': 0.0,
        'type_relevance': 0.0, 'node_type_bonus': 0.0, 'recency_bonus': 0.0,
        'hub_penalty': 0.0, 'path_diversity': 0.0, 'depth_penalty': 1.0,
    }
    
    print("── Phase 1: Baseline (only edge_weight + depth_penalty) ──")
    baseline = evaluate_params(baseline_params, "baseline", 10)
    print(f"  Baseline composite rank: {baseline:.2f}\n")

    # Test each parameter by adding it to baseline
    candidates = [
        ('node_confidence', 'node.confidence'),
        ('label_similarity', 'label_sim(query, target)'),
        ('type_relevance', 'edge.type matches intent'),
        ('node_type_bonus', 'entity > turn > claim > view'),
        ('recency_bonus', 'newer edges carry more weight'),
        ('hub_penalty', 'penalise high in-degree nodes'),
        ('path_diversity', 'reward nodes reached via multiple paths'),
    ]

    print("── Phase 2: Individual parameter impact (add to baseline) ──")
    print(f"  {'Parameter':<20} {'Improvement':>13} {'New rank':>10} {'Effect':>10}")
    print(f"  {'-'*55}")
    
    results = [('(baseline)', 0, baseline, '')]
    
    for param_key, param_desc in candidates:
        test_params = baseline_params.copy()
        test_params[param_key] = 1.0
        rank = evaluate_params(test_params, param_key, 10)
        improvement = baseline - rank  # positive = better
        effect = "✅ HELPS" if improvement > 1.0 else ("⚠ MAYBE" if improvement > 0 else "❌ HURTS")
        print(f"  {param_desc:<20} {improvement:>+8.2f}  {rank:>8.2f}  {effect:>10}")
        results.append((param_desc, improvement, rank, effect))
    
    # ── Phase 3: Combined best ──
    print("\n── Phase 3: Combined best parameters ──")
    # Start with parameters that helped, add them all
    best_params = baseline_params.copy()
    for param_key, param_desc in candidates:
        test_params = baseline_params.copy()
        test_params[param_key] = 1.0
        rank = evaluate_params(test_params, param_key, 5)
        if rank < baseline:  # improved
            best_params[param_key] = 1.0
            print(f"  Keeping {param_desc}")
    
    best_rank = evaluate_params(best_params, "best combo", 10)
    print(f"  Combined rank: {best_rank:.2f} (starting baseline: {baseline:.2f})")
    print(f"  Total improvement: {baseline - best_rank:+.2f}\n")
    
    print("── Phase 4: Ablation (remove each from best) ──")
    print(f"  {'Removed':<20} {'Rank change':>13} {'New rank':>10}")
    print(f"  {'-'*45}")
    
    for param_key, param_desc in candidates:
        if best_params.get(param_key, 0) > 0:
            ablation = best_params.copy()
            ablation[param_key] = 0.0
            rank = evaluate_params(ablation, f"no {param_desc}", 8)
            change = best_rank - rank  # positive = this parameter matters
            print(f"  {param_desc:<20} {change:>+8.2f}  {rank:>8.2f}")
    
    print(f"\n── FINAL PARAMETER RANKING ──")
    print(f"  (ranked by importance: higher = more impact on retrieval quality)")

if __name__ == '__main__':
    run()
