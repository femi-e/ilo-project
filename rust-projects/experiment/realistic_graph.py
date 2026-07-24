#!/usr/bin/env python3
"""ILO Realistic Graph Generator + Benchmark.
Produces graphs matching real ILO deployments with entities, turns, claims, views.
Tests retrieval across varying depths and densities."""
import csv, math, random, time
from collections import defaultdict

random.seed(42)
ACT_THRESHOLD = 0.005
BACKWARD_DISCOUNT = 0.5

class Graph:
    def __init__(self):
        self.nodes = {}; self.props = {}
        self.links = {}; self.out = defaultdict(list); self.inn = defaultdict(list)

    def add_node(self, nid, ntype, subtype="", conf=0.9, label=""):
        self.nodes[nid] = {'type':ntype, 'subtype':subtype, 'conf':conf, 'label':label}
        self.props[nid] = {}

    def add_prop(self, nid, key, value):
        if nid in self.props: self.props[nid][key] = value

    def connect(self, frm, to, ltype, weight=0.5, age=5000):
        lid = f"{frm}->{to}"
        self.links[lid] = (frm, to, ltype, weight, age)
        self.out[frm].append(lid); self.inn[to].append(lid)

    def incident(self, nid):
        e = []
        for lid in self.out.get(nid,[]):
            if lid in self.links: e.append(self.links[lid])
        for lid in self.inn.get(nid,[]):
            if lid in self.links:
                l = self.links[lid]
                if l[0] != l[1]: e.append(l)
        return e

    def degree(self, nid):
        return len(self.out.get(nid,[])) + len(self.inn.get(nid,[]))

    def stats(self):
        degs = [self.degree(n) for n in self.nodes]
        types = {}; link_types = {}
        for n in self.nodes.values(): types[n['type']] = types.get(n['type'],0)+1
        for l in self.links.values(): link_types[l[2]] = link_types.get(l[2],0)+1
        return {'nodes':len(self.nodes),'links':len(self.links),
                'avg_deg':sum(degs)/max(len(degs),1),'max_deg':max(degs) if degs else 0,
                'types':types,'link_types':link_types}

def generate_ilo_graph(N=200):
    g = Graph()
    n_entities = max(1, int(N*0.40)); n_turns = max(1, int(N*0.35))
    n_claims = max(1, int(N*0.15))

    # Named entities
    named = [("Alice","person",0.95),("Bob","person",0.92),("Carol","person",0.88),
             ("Dave","person",0.85),("Eve","person",0.90),("Frank","person",0.87),
             ("ILO","project",0.95),("Cognee","project",0.85),("LadybugDB","tool",0.93),
             ("Candle","tool",0.88),("Metal","tool",0.85),("Rust","language",0.94),
             ("Python","language",0.90),("GPT4","tool",0.92),("Claude","tool",0.90),
             ("Knowledge Graphs","concept",0.91),("RAG","concept",0.93),
             ("Hebbian Learning","concept",0.82),("Spreading Activation","concept",0.85)]

    people=["Grace","Heidi","Ivan","Judy","Karl","Liam","Mia","Nina"]
    projects=["Atlas","Zephyr","Nova","Orion","Vega","Aether"]
    tools=["Docker","K8s","Redis","Postgres","Kafka","Spark"]

    hot, warm, cold = [], [], []
    for i in range(n_entities):
        if i<len(named):
            name,stype,conf=named[i]
        else:
            pool = people if i%4==0 else (projects if i%4==1 else (tools if i%4==2 else ["Entropy","Causality","Feedback","Resilience"]))
            name=f"{pool[(i-len(named))%len(pool)]}_{i}"
            stype=["person","project","tool","concept"][i%4]
            conf=round(0.6+random.random()*0.38,2)
        nid=f"e_{name.lower().replace(' ','_')}"
        g.add_node(nid,"entity",stype,conf,name)
        g.add_prop(nid,"confidence",conf)
        g.add_prop(nid,"status",random.choice(["active","active","active","inactive","archived"]))
        g.add_prop(nid,"created_at",random.randint(0,5000))
        if i<n_entities*0.2: hot.append(nid)
        elif i<n_entities*0.5: warm.append(nid)
        else: cold.append(nid)

    # Turns
    turns=[]
    for i in range(n_turns):
        nid=f"t{i}"; turns.append(nid)
        g.add_node(nid,"turn","",1.0,f"Turn#{i}")
        g.add_prop(nid,"session_id",f"session_{i//10}")
        g.add_prop(nid,"turn_index",i%10)

    # Claims
    claims=[]
    for i in range(n_claims):
        nid=f"c{i}"; claims.append(nid)
        g.add_node(nid,"claim","",round(0.6+random.random()*0.38,2))
        g.add_prop(nid,"provenance",random.choice(["user.confirmed","system.inferred","system.extracted"]))

    # Views
    for name,filters in [("code-review",["person","tool","project"]),("planning",["project","concept"]),
                          ("research",["concept","tool"]),("general",["person","project","tool","concept"])]:
        g.add_node(f"v_{name}","view","",1.0,name)
        g.add_prop(f"v_{name}","purpose",f"Filter for {name}")

    # Connect: turn→entity (ref) — EXTREME power-law bias
    # Hot entities (20%) should get ~80% of all ref edges
    # Power-law: hot = 50x weight, warm = 5x, cold = 1x
    all_e = hot + warm + cold
    wt = {e: (50 if e in hot else (5 if e in warm else 1)) for e in all_e}
    # Add mega-hubs: 2-3 entities get 200x (they're the most mentioned)
    mega = random.sample(hot, min(2, len(hot)))
    for m in mega:
        wt[m] = 200
    total_wt = sum(wt.values())
    probs = [wt[e]/total_wt for e in all_e]
    for tid in turns:
        n_refs = random.randint(2, 5)
        # Some turns are "hot" (important conversations) and reference more entities
        if random.random()<0.2:
            n_refs = random.randint(6, 10)
        chosen = set()
        while len(chosen) < n_refs:
            chosen.add(random.choices(all_e, weights=probs, k=1)[0])
        for e in chosen:
            g.connect(tid,e,"ref",round(0.4+random.random()*0.5,2),random.randint(0,9000))

    # Connect: entity→entity (has) — power-law + triangle closure
    for p in [n for n in all_e if g.nodes[n]['subtype']=='person']:
        targets=[n for n in all_e if g.nodes[n]['subtype']=='project']
        k = random.randint(1,3)
        # Weight toward popular projects
        proj_wt = {t: g.degree(t)+1 for t in targets}
        proj_total = sum(proj_wt.values())
        chosen = set()
        while len(chosen) < min(k, len(targets)):
            chosen.add(random.choices(targets, weights=[proj_wt[t]/proj_total for t in targets], k=1)[0])
        for t in chosen:
            w = round(0.5+random.random()*0.4,2)
            g.connect(p,t,"has",w,random.randint(0,5000))
            # Triangle closure: if another person links to the same project,
            # link the two people with some probability
            for p2 in [n for n in all_e if g.nodes[n]['subtype']=='person' and n!=p]:
                if any(l[0]==p2 and l[1]==t and l[2]=='has' for l in g.links.values()):
                    if random.random()<0.3:
                        g.connect(p,p2,"has",round(0.3+random.random()*0.3,2),5000)

    # Tool→language (dep)
    for t in [n for n in all_e if g.nodes[n]['subtype']=='tool']:
        targets=[n for n in all_e if g.nodes[n]['subtype']=='language']
        if targets:
            # Popular languages get more dep links
            lang_wt = {l: g.degree(l)+1 for l in targets}
            lang_total = sum(lang_wt.values())
            chosen = random.choices(targets, weights=[lang_wt[l]/lang_total for l in targets], k=random.randint(0,2))
            for c in set(chosen):
                g.connect(t,c,"dep",round(0.4+random.random()*0.4,2),5000)

    # Concept→concept (con) — sparse contradictions
    ce = [n for n in all_e if g.nodes[n]['subtype']=='concept']
    for i in range(len(ce)):
        for j in range(i+1, len(ce)):
            if random.random()<0.05:
                g.connect(ce[i],ce[j],"con",round(0.3+random.random()*0.3,2),5000)

    # Add super-hub: pick the hottest entity and connect it to everything
    if hot:
        super_hub = max(hot, key=lambda n: g.degree(n))
        n_extra = random.randint(10, 20)
        extras = random.sample([n for n in all_e if n != super_hub], min(n_extra, len(all_e)-1))
        for e in extras:
            g.connect(super_hub, e, "has", round(0.2+random.random()*0.3,2), 5000)

    # Connect: claim→entity (evidence)
    for c in claims:
        chosen = set()
        while len(chosen) < random.randint(1,3):
            chosen.add(random.choices(all_e, weights=probs, k=1)[0])
        for e in chosen:
            g.connect(c,e,"evidence",round(0.5+random.random()*0.4,2),5000)

    # Connect: view→entity (context)
    vmap={"code-review":["person","tool","project"],"planning":["project","concept"],
          "research":["concept","tool"],"general":["person","project","tool","concept"]}
    for vname,vtypes in vmap.items():
        matching=[n for n in all_e if g.nodes[n]['subtype'] in vtypes]
        n_select = min(len(matching), random.randint(3,6))
        # Bias toward popular entities
        match_wt = {m: g.degree(m)+1 for m in matching}
        match_total = sum(match_wt.values())
        chosen = set()
        while len(chosen) < n_select:
            chosen.add(random.choices(matching, weights=[match_wt[m]/match_total for m in matching], k=1)[0])
        for e in chosen:
            g.connect(f"v_{vname}",e,"context",1.0,5000)

    return g

def embed_paths(g, n_paths=5):
    """Embed query→answer paths at depths 2-5 through the graph."""
    all_e=[n for n in g.nodes if g.nodes[n]['type']=='entity']
    if len(all_e)<6: return []
    paths=[]
    for depth in range(2,min(2+n_paths,6)):
        src=random.choice(all_e[:len(all_e)//2])
        tgt=random.choice(all_e[len(all_e)//2:])
        if src==tgt: continue
        prev=src
        for h in range(1,depth):
            bridge=f"_p{depth}_{h}"
            g.add_node(bridge,"entity","concept",0.90,f"p{depth}h{h}")
            g.connect(prev,bridge,"ref",0.8,5000)
            prev=bridge
        g.connect(prev,tgt,"ref",0.8,5000)
        dist=f"_d{depth}"
        if dist not in g.nodes: g.add_node(dist,"entity","concept",0.60,f"dist{depth}")
        g.connect(src,dist,"ref",0.7,5000)
        paths.append((src,tgt,depth))
    return paths

def spread(graph,seeds,max_hops=5,inhibit_m=4,inhibit_beta=0.3,depth_protect=True):
    act={};dep={};fired=set()
    for sid,sc in seeds:
        if sid in graph.nodes:
            e=graph.nodes[sid]['conf']*sc;act[sid]=act.get(sid,0.0)+e;dep[sid]=0
    for hop in range(1,max_hops+1):
        nxt={};ndep={}
        for nid,energy in list(act.items()):
            if energy<ACT_THRESHOLD or nid in fired: continue
            fired.add(nid)
            for l in graph.incident(nid):
                frm,to,lt,w,age=l;is_f=frm==nid;tgt=to if is_f else frm
                if tgt==nid: continue
                p=energy*w*(1.0 if is_f else BACKWARD_DISCOUNT)/max(len(graph.incident(nid)),1)
                if p<ACT_THRESHOLD: continue
                nxt[tgt]=nxt.get(tgt,0.0)+p
                cd=dep.get(nid,0)+1
                if tgt not in ndep or cd<ndep[tgt]: ndep[tgt]=cd
        srt=sorted(nxt.items(),key=lambda x:-x[1])
        if len(srt)>inhibit_m:
            top=srt[inhibit_m-1][1]
            for i,(ni,en) in enumerate(srt):
                if i>=inhibit_m:
                    d=ndep.get(ni,1);dp=0.3 if depth_protect and d>=3 else 1.0
                    nxt[ni]=max(0.0,en-(top-en)*inhibit_beta*dp)
        for ni,en in nxt.items():
            if en>=ACT_THRESHOLD:
                act[ni]=act.get(ni,0.0)+en
                if ni not in dep or ndep.get(ni,999)<dep.get(ni,999): dep[ni]=ndep.get(ni,0)
        if not any(e>=ACT_THRESHOLD for e in nxt.values()): break
    return [(n,act.get(n,0),dep.get(n,0)) for n in act]

def run():
    print("="*70)
    print("ILO REALISTIC GRAPH — Structure & Retrieval Benchmark")
    print("="*70)

    for scale_name, N in [("Small",80),("Medium",200),("Large",500)]:
        print(f"\n── {scale_name} (N≈{N}) ──")
        g=generate_ilo_graph(N)
        stats=g.stats()

        print(f"  Nodes: {stats['nodes']} ({', '.join(f'{k}={v}' for k,v in stats['types'].items())})")
        print(f"  Links: {stats['links']} ({', '.join(f'{k}={v}' for k,v in stats['link_types'].items())})")
        print(f"  Avg deg: {stats['avg_deg']:.1f}, Max deg: {stats['max_deg']}")

        # Degree distribution
        degs=[g.degree(n) for n in g.nodes]
        print(f"  Degree distribution: min={min(degs)} p25={sorted(degs)[len(degs)//4]} "
              f"p50={sorted(degs)[len(degs)//2]} p75={sorted(degs)[len(degs)*3//4]} max={max(degs)}")

        # Embed paths and test retrieval
        paths=embed_paths(g,5)
        print(f"  Embedded {len(paths)} query paths")

        # Test retrieval at each depth
        print(f"\n  {'Depth':>6} {'AnsAct':>8} {'DistAct':>8} {'A/D':>6} {'ActN':>5} {'Timeµs':>8} {'Status':>8}")
        print(f"  {'-'*55}")
        for src,tgt,depth in paths:
            seeds=[(src,1.0)]
            t0=time.perf_counter()
            r=spread(g,seeds,depth+1)
            t1=time.perf_counter()
            aa=next((a for n,a,dd in r if n==tgt),0.0)
            da=next((a for n,a,dd in r if n==f"_d{depth}"),0.0)
            ok="✅" if aa>=ACT_THRESHOLD else "❌"
            print(f"  {depth:>6} {aa:>8.4f} {da:>8.4f} {aa/max(da,0.0001):>6.2f} "
                  f"{len(r):>5} {(t1-t0)*1e6:>8.0f} {ok:>8}")

    print("\n── COMPARISON WITH RANDOM GRAPH ──")
    # Build a random graph of similar size for comparison
    N=200
    g_real=generate_ilo_graph(N)
    st=g_real.stats()
    degs_real=[g_real.degree(n) for n in g_real.nodes]
    print(f"  Realistic: {st['nodes']} nodes, {st['links']} links, "
          f"avg_deg={st['avg_deg']:.1f}, p50_deg={sorted(degs_real)[len(degs_real)//2]}")

    # Random graph for comparison
    from collections import defaultdict as dd
    nodes_r={};out_r=dd(list)
    for i in range(200):
        nodes_r[f"n{i}"]=round(0.5+random.random()*0.45,2)
    for i in range(200):
        for _ in range(max(1,int(random.gauss(4,1)))):
            t=random.choice([f"n{j}" for j in range(200) if j!=i])
            out_r[f"n{i}"].append(t)
    E_r=sum(len(v) for v in out_r.values())
    degs_r=[len(out_r.get(n,[])) for n in nodes_r]
    print(f"  Random:    200 nodes, {E_r} links, "
          f"avg_deg={sum(degs_r)/len(degs_r):.1f}, p50_deg={sorted(degs_r)[len(degs_r)//2]}")
    print(f"\n  Key difference: Realistic has multi-type nodes, power-law degrees,")
    print(f"  meaningful link types (ref/has/dep/con/seq/evidence/context),")
    print(f"  and embedded properties — not uniform random connectivity.")

if __name__=='__main__': run()
