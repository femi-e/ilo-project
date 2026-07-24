#!/usr/bin/env python3
"""Final validation of the 4-factor scoring formula.
Formula: cumulative = 0.85 × prev + 0.15 × (type_relevance × edge_weight × confidence × label_similarity)"""
import csv, math, random, statistics, time
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph

random.seed(42)

# ── Core helpers (same as guided_retrieval.py) ──

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

# ── FINAL RETRIEVAL WITH 4-FACTOR SCORING ──

DAMPING = 0.85

def retrieve_final(query, graph, min_score=0.02, max_hops=4):
    """4-factor PPR-style retrieval."""
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
        collected.append((nid,cscore,depth,path,graph.props.get(nid,{})))
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

            # Four factors
            tr = 1.0 if ltype in etypes else 0.3
            ew = w
            tc = td['conf']
            tl = td.get('label','')
            tp = graph.props.get(target,{})
            ls = label_sim(query, tl, td.get('subtype'), tp)

            product = tr * ew * tc * ls
            new_score = DAMPING * cscore + (1-DAMPING) * product

            if new_score >= min_score:
                frontier.append((target,depth+1,new_score,path+[target]))
                visited.add(target)

    collected.sort(key=lambda x:-x[1])
    return collected

# ── BRUTE FORCE TESTS ──

def run():
    print("="*70)
    print("FINAL 4-FACTOR FORMULA — Brute Force Validation")
    print("="*70)

    # ── Test A: Query coverage (100 varied queries) ──
    print("\n── TEST A: Query Coverage (100 queries × 5 runs = 500 retrievals) ──")
    categories = defaultdict(lambda: {'ok':0,'total':0,'ranks':[]})
    g = generate_ilo_graph(200)
    
    people = [n for n,d in g.nodes.items() if d.get('subtype')=='person']
    projects = [n for n,d in g.nodes.items() if d.get('subtype')=='project']
    tools = [n for n,d in g.nodes.items() if d.get('subtype')=='tool']
    concepts = [n for n,d in g.nodes.items() if d.get('subtype')=='concept']
    all_ent = people + projects + tools + concepts
    
    def lbl(nid): return g.nodes[nid].get('label', nid)
    
    query_forms = [
        ("Tell me about {e}", "simple_lookup"),
        ("What is {e}?", "simple_lookup"),
        ("What projects does {p} work on?", "relation"),
        ("Who works on {pr}?", "relation"),
        ("What depends on {t}?", "relation"),
        ("What evidence supports {c}?", "relation"),
        ("What contradicts {c}?", "relation"),
        ("XYZ nonexistent entity", "no_match"),
        ("", "empty"),
        ("the and or but not maybe", "stop_words"),
    ]
    
    queries = []
    for tmpl, cat in query_forms:
        for _ in range(10):
            if "{e}" in tmpl and all_ent:
                queries.append((tmpl.replace("{e}", lbl(random.choice(all_ent))), cat))
            elif "{p}" in tmpl and people:
                queries.append((tmpl.replace("{p}", lbl(random.choice(people))), cat))
            elif "{pr}" in tmpl and projects:
                queries.append((tmpl.replace("{pr}", lbl(random.choice(projects))), cat))
            elif "{t}" in tmpl and tools:
                queries.append((tmpl.replace("{t}", lbl(random.choice(tools))), cat))
            elif "{c}" in tmpl and concepts:
                queries.append((tmpl.replace("{c}", lbl(random.choice(concepts))), cat))
            elif "XYZ" in tmpl or tmpl == "" or tmpl == "the and or but not maybe":
                # Fixed queries: run 10 times each
                queries.append((tmpl, cat))
                if len([q for q,c in queries if c==cat]) >= 10: break
    
    for q, cat in queries[:100]:
        for _ in range(5):
            g2 = generate_ilo_graph(200)
            r = retrieve_final(q, g2)
            ok = len(r) > 0 and r[0][1] > 0
            categories[cat]['ok'] += 1 if ok else 0
            categories[cat]['total'] += 1
            categories[cat]['ranks'].append(len(r))
    
    print(f"{'Category':<20} {'Success':>10} {'Rate':>8} {'Avg results':>12}")
    print("-"*50)
    for cat, d in sorted(categories.items()):
        rate = d['ok']/d['total']*100 if d['total']>0 else 0
        avg = statistics.mean(d['ranks']) if d['ranks'] else 0
        print(f"  {cat:<20} {d['ok']:>3}/{d['total']:<3} {rate:>7.1f}% {avg:>12.1f}")

    # ── Test B: Ground truth rank ──
    print("\n── TEST B: Ground Truth Ranking ──")
    print(f"  {'Query':<45} {'Avg Rank':>10} {'Found%':>8}")
    print("  " + "-"*63)
    
    ground_truth = [
        ("What projects does Alice work on?", lambda nid,nd,g: nd.get('subtype')=='project' and nd.get('conf',0)>0.7),
        ("Tell me about Rust", lambda nid,nd,g: nd.get('label','').lower()=='rust'),
        ("What depends on Candle?", lambda nid,nd,g: nd.get('subtype') in ('tool','language')),
        ("What evidence supports Hebbian Learning?", lambda nid,nd,g: nd.get('label','').lower()=='hebbian learning'),
        ("What contradicts spreading activation?", lambda nid,nd,g: nd.get('label','').lower()=='spreading activation'),
    ]
    
    all_ranks = []
    for query, verify in ground_truth:
        ranks = []
        for _ in range(10):
            g = generate_ilo_graph(200)
            r = retrieve_final(query, g)
            found = False
            for rank,(nid,score,depth,path,props) in enumerate(r):
                nd = g.nodes.get(nid)
                if nd and verify(nid,nd,g):
                    ranks.append(rank+1); found=True; break
            if not found: ranks.append(999)
        avg = statistics.mean(ranks)
        found = sum(1 for rr in ranks if rr < 999)/len(ranks)*100
        all_ranks.append(avg)
        print(f"  {query:<45} {avg:>10.2f} {found:>7.0f}%")
    
    print(f"\n  Average rank across all queries: {statistics.mean(all_ranks):.2f}")

    # ── Test C: Scoring stability ──
    print("\n── TEST C: Score Distribution ──")
    all_scores = []
    for _ in range(10):
        g = generate_ilo_graph(200)
        r = retrieve_final("What projects does Alice work on?", g)
        all_scores.extend([s for _,s,_,_,_ in r])
    
    if all_scores:
        print(f"  Min: {min(all_scores):.3f}")
        print(f"  P25: {sorted(all_scores)[len(all_scores)//4]:.3f}")
        print(f"  P50: {sorted(all_scores)[len(all_scores)//2]:.3f}")
        print(f"  P75: {sorted(all_scores)[len(all_scores)*3//4]:.3f}")
        print(f"  Max: {max(all_scores):.3f}")
        print(f"  Scores are in 0-1 range: {'✅' if max(all_scores) <= 1.0 else '❌'}")

    # ── Test D: Latency ──
    print(f"\n── TEST D: Latency (300 retrievals) ──")
    times = []
    for i in range(30):
        g = generate_ilo_graph(200)
        t0 = time.perf_counter()
        for _ in range(10):
            retrieve_final("What projects does Alice work on?", g)
        t1 = time.perf_counter()
        times.append((t1-t0)*1e6/10)  # per retrieval
    
    print(f"  P50: {sorted(times)[len(times)//2]:.1f}µs")
    print(f"  P95: {sorted(times)[int(len(times)*0.95)]:.1f}µs")

    print(f"\n{'='*70}")
    print(f"TEST COMPLETE")
    print(f"{'='*70}")

if __name__ == '__main__':
    run()
