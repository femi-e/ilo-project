#!/usr/bin/env python3
"""Parameter sweep for final ILO retrieval algorithm.
Tests damping × min_score × max_hops × type_penalty to find optimal combination."""
import math, random, statistics, time, itertools
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph

# Re-use the final retrieval code
from final_retrieval import retrieve, find_seeds, classify_intent, INTENT_EDGES, DAMPING

random.seed(42)

# ── Parameterised version of retrieve ──
def retrieve_p(query, graph, damping=0.85, min_score=0.02, max_hops=4, type_penalty=0.3):
    """Same as retrieve() but with configurable parameters."""
    from final_retrieval import label_sim
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
        nd=graph.nodes.get(nid)
        collected.append((nid,cscore,depth,path,nd.get('label','') if nd else nid,
                         graph.props.get(nid,{}),nd.get('type','') if nd else ''))
        if depth>=max_hops: continue
        if not nd: continue
        
        edges=[]
        for lid in graph.out.get(nid,[]):
            if lid in graph.links: edges.append((*graph.links[lid],'out'))
        for lid in graph.inn.get(nid,[]):
            if lid in graph.links:
                l=graph.links[lid]; edges.append((l[0],l[1],l[2],l[3],l[4],'in'))
        
        for frm,to,ltype,w,age,direction in edges:
            target=to if direction=='out' else frm
            if target in visited: continue
            td=graph.nodes.get(target)
            if not td: continue
            
            tr=1.0 if ltype in etypes else type_penalty
            ew=w; tc=td['conf']
            ls=label_sim(query,td.get('label',''),td.get('subtype'),graph.props.get(target,{}))
            product=tr*ew*tc*ls
            new_score=damping*cscore+(1-damping)*product
            
            if new_score>=min_score:
                frontier.append((target,depth+1,new_score,path+[target]))
                visited.add(target)
    
    collected.sort(key=lambda x:-x[1])
    return collected

# ── Ground truth cases ──
GROUND_TRUTH = [
    ("What projects does Alice work on?", lambda nid,nd,g: nd.get('subtype')=='project' and nd.get('conf',0)>0.7),
    ("Tell me about Rust", lambda nid,nd,g: nd.get('label','').lower()=='rust'),
    ("What depends on Candle?", lambda nid,nd,g: nd.get('subtype') in ('tool','language')),
    ("hebbian learning", lambda nid,nd,g: nd.get('label','').lower()=='hebbian learning'),
    ("Tell me about Alice and Bob", lambda nid,nd,g: nd.get('label','') in ('Alice','Bob')),
]

def evaluate_config(damping, min_score, max_hops, type_penalty, trials=10):
    """Evaluate a single parameter configuration."""
    ranks=[]
    for gt_query, verify in GROUND_TRUTH:
        for _ in range(trials):
            g=generate_ilo_graph(200)
            r=retrieve_p(gt_query,g,damping,min_score,max_hops,type_penalty)
            found=False
            for rank,(nid,scr,depth,path,lbl,props,ntype) in enumerate(r[:100]):
                nd=g.nodes.get(nid)
                if nd and verify(nid,nd,g):
                    ranks.append(rank+1); found=True; break
            if not found: ranks.append(999)
    return statistics.mean(ranks), ranks

print("="*70)
print("PARAMETER SWEEP — 4 factors × multiple levels")
print("="*70)

# ── Phase 1: Individual parameter sensitivity ──
print("\n── PHASE 1: Individual Parameter Sweeps ──")

defaults = {'damping':0.85, 'min_score':0.02, 'max_hops':4, 'type_penalty':0.3}

sweep_results = {}

for param_name, values, param_label in [
    ('damping', [0.70, 0.75, 0.80, 0.85, 0.90, 0.95], "Damping"),
    ('min_score', [0.001, 0.005, 0.01, 0.02, 0.05, 0.1], "Min Score"),
    ('max_hops', [2, 3, 4, 5, 6, 8], "Max Hops"),
    ('type_penalty', [0.1, 0.2, 0.3, 0.5, 0.7, 1.0], "Type Penalty"),
]:
    print(f"\n  {param_label} sweep (others at default):")
    print(f"  {'Value':>10} {'Avg Rank':>10} {'Found%':>8} {'Score':>8}")
    print(f"  {'-'*36}")
    
    results=[]
    for val in values:
        kwargs = defaults.copy()
        kwargs[param_name] = val
        avg_rank, all_ranks = evaluate_config(**kwargs, trials=8)
        found_pct = sum(1 for r in all_ranks if r < 999)/len(all_ranks)*100 if all_ranks else 0
        # Composite: lower rank = better, higher found% = better
        score = (1.0 / max(avg_rank, 0.1)) * 0.6 + (found_pct/100.0) * 0.4
        results.append((val, avg_rank, found_pct, score))
        print(f"  {val:>10.3f} {avg_rank:>10.2f} {found_pct:>7.0f}% {score:>8.3f}")
    
    sweep_results[param_name] = results
    
    # Best value
    best = max(results, key=lambda x: x[3])
    print(f"  {'→ Best:':>10} {best[0]:>8}  (rank={best[1]:.2f}, score={best[3]:.3f})")

# ── Phase 2: 2-factor interaction ──
print("\n── PHASE 2: Damping × Type Penalty Interaction ──")
print("  Question: do damping and type_penalty interact?")
print(f"  {'Damping':>8} {'TypePen':>8} {'Avg Rank':>10} {'Found%':>8}")
print(f"  {'-'*36}")
for damp in [0.80, 0.85, 0.90]:
    for tp in [0.2, 0.3, 0.5]:
        avg_rank, all_ranks = evaluate_config(damp, 0.02, 4, tp, trials=6)
        found = sum(1 for r in all_ranks if r<999)/len(all_ranks)*100 if all_ranks else 0
        print(f"  {damp:>8.2f} {tp:>8.2f} {avg_rank:>10.2f} {found:>7.0f}%")

# ── Phase 3: Final best config ──
print(f"\n── PHASE 3: Best Config Validation ──")
best_configs = [
    ("Default (0.85/0.02/4/0.3)", 0.85, 0.02, 4, 0.3),
    ("High damp+low pen (0.90/0.02/4/0.2)", 0.90, 0.02, 4, 0.2),
    ("High hops+low thresh (0.85/0.01/6/0.3)", 0.85, 0.01, 6, 0.3),
    ("Conservative (0.80/0.05/4/0.5)", 0.80, 0.05, 4, 0.5),
]

for name, damp, ms, mh, tp in best_configs:
    avg_rank, all_ranks = evaluate_config(damp, ms, mh, tp, trials=12)
    found = sum(1 for r in all_ranks if r<999)/len(all_ranks)*100 if all_ranks else 0
    print(f"  {name:<40} rank={avg_rank:>6.2f} found={found:.0f}%")

print(f"\n── FINAL ANSWER ──")
# Pick the best from Phase 1 individually
best_damp = max(sweep_results['damping'], key=lambda x:x[3])
best_ms = max(sweep_results['min_score'], key=lambda x:x[3])
best_mh = max(sweep_results['max_hops'], key=lambda x:x[3])
best_tp = max(sweep_results['type_penalty'], key=lambda x:x[3])
print(f"  Best damping:       {best_damp[0]:.3f}")
print(f"  Best min_score:     {best_ms[0]:.3f}")
print(f"  Best max_hops:      {best_mh[0]:.0f}")
print(f"  Best type_penalty:  {best_tp[0]:.3f}")
print(f"\n  Recommended: damping={best_damp[0]:.2f}, min_score={best_ms[0]:.3f},")
print(f"               max_hops={best_mh[0]:.0f}, type_penalty={best_tp[0]:.2f}")
