#!/usr/bin/env python3
"""ILO Graph Property Sweep — Find what actually affects metrics."""
import csv, math, random, time
from collections import defaultdict

random.seed(42)
ACT_THRESHOLD = 0.005
BACKWARD_DISCOUNT = 0.5

class Node:
    __slots__ = ('nid','label','confidence')
    def __init__(self,nid,label,conf): self.nid=nid; self.label=label; self.confidence=conf

class Link:
    __slots__ = ('lid','from_n','to_n','weight')
    def __init__(self,lid,f,t,w): self.lid=lid; self.from_n=f; self.to_n=t; self.weight=w

class Graph:
    def __init__(self):
        self.nodes={}; self.links={}; self.out=defaultdict(list); self.inn=defaultdict(list)
    def add(self,n): self.nodes[n.nid]=n
    def connect(self,f,t,w):
        lid=f"{f}->{t}"; self.links[lid]=Link(lid,f,t,w)
        self.out[f].append(lid); self.inn[t].append(lid)
    def incident(self,nid):
        e=[]
        for lid in self.out.get(nid,[]):
            if lid in self.links: e.append(self.links[lid])
        for lid in self.inn.get(nid,[]):
            if lid in self.links:
                l=self.links[lid]
                if l.from_n!=l.to_n: e.append(l)
        return e
    def stats(self):
        degs=[len(self.out.get(n,[]))+len(self.inn.get(n,[])) for n in self.nodes]
        in_degs=[len(self.inn.get(n,[])) for n in self.nodes]
        out_degs=[len(self.out.get(n,[])) for n in self.nodes]
        return {'n':len(self.nodes),'e':len(self.links),'avg_deg':sum(degs)/max(len(degs),1),
                'max_deg':max(degs) if degs else 0,'max_in':max(in_degs) if in_degs else 0,
                'hub_ratio':sum(1 for d in degs if d>10)/max(len(degs),1),
                'density':len(self.links)/max(len(self.nodes)**2,1)*100}

def gen_graph(nodes, avg_deg, hub_strength=0.0):
    """Generate graph with controllable properties.
    hub_strength: 0.0 = uniform, 1.0 = strong preferential attachment"""
    g=Graph()
    words=["alice","bob","carol","dave","eve","project","task","bug",
           "meeting","doc","code","review","deploy","test","api","ui"]
    for i in range(nodes):
        g.add(Node(f"n{i}",f"{words[i%len(words)]}_{i}",round(0.5+random.random()*0.45,2)))

    all_n=list(g.nodes.keys())
    for i in range(nodes):
        n_edges=max(1,int(random.gauss(avg_deg,1)))
        cand=[n for n in all_n if n!=f"n{i}"]
        if cand:
            # Vary between uniform and preferential
            base_w=[1.0]*len(cand)
            pref_w=[len(g.out.get(n,[]))+len(g.inn.get(n,[]))+1 for n in cand]
            ws=[(1-hub_strength)*bw + hub_strength*pw for bw,pw in zip(base_w,pref_w)]
            probs=[w/sum(ws) for w in ws]
            chosen=set(random.choices(cand,weights=probs,k=min(n_edges,len(cand))))
            for c in chosen:
                g.connect(f"n{i}",c,round(0.2+random.random()*0.6,2))
    return g

def add_deep_path(g, path_len=4):
    """Embed a known query→...→answer path, return (qid, ans_id)."""
    g.add(Node("q","query",0.95))
    prev="q"
    for i in range(1,path_len):
        nid=f"h{i}"; g.add(Node(nid,f"hop{i}",0.85+random.random()*0.1))
        g.connect(prev,nid,round(0.5+random.random()*0.3,2)); prev=nid
    g.add(Node("ans","answer",0.90))
    g.connect(prev,"ans",0.8)
    g.add(Node("dist","distractor",0.70))
    g.connect("q","dist",0.7)
    return "q","ans"

def spread(seeds, graph, max_hops=4):
    act={}; depths={}; fired=set()
    for sid,sc in seeds:
        if sid in graph.nodes:
            e=graph.nodes[sid].confidence*sc; act[sid]=act.get(sid,0.0)+e; depths[sid]=0
    for hop in range(1,max_hops+1):
        nxt={}; ndep={}
        for nid,energy in list(act.items()):
            if energy<ACT_THRESHOLD or nid in fired: continue
            fired.add(nid)
            edges=graph.incident(nid)
            if not edges: continue
            fan=len(edges)
            for link in edges:
                is_fwd=link.from_n==nid
                target=link.to_n if is_fwd else link.from_n
                if target==nid: continue
                prop=energy*link.weight*(1.0 if is_fwd else BACKWARD_DISCOUNT)/fan
                if prop<ACT_THRESHOLD: continue
                nxt[target]=nxt.get(target,0.0)+prop
                cd=depths.get(nid,0)+1
                if target not in ndep or cd<ndep[target]: ndep[target]=cd
        srt=sorted(nxt.items(),key=lambda x:-x[1])
        if len(srt)>4:
            top=srt[3][1]
            for i,(ni,en) in enumerate(srt):
                if i>=4:
                    d=ndep.get(ni,1); dp=0.3 if d>=3 else 1.0
                    s=(top-en)*0.3*dp; nxt[ni]=max(0.0,en-s)
        for ni,en in nxt.items():
            if en>=ACT_THRESHOLD:
                act[ni]=act.get(ni,0.0)+en
                if ni not in depths or ndep.get(ni,999)<depths.get(ni,999):
                    depths[ni]=ndep.get(ni,0)
        if not any(e>=ACT_THRESHOLD for e in nxt.values()): break
    return [(nid,act.get(nid,0),depths.get(nid,0)) for nid in act]

def run():
    print("="*80)
    print("ILO GRAPH PROPERTY SWEEP — What actually drives metrics?")
    print("="*80)

    # Vary: nodes (3 levels) × avg_degree (3 levels) × hub_strength (3 levels)
    node_levels=[50, 200, 500]
    deg_levels=[2, 5, 10]
    hub_levels=[0.0, 0.5, 0.95]

    rows=[]
    print(f"\n{'N':>5} {'E':>6} {'AvgDeg':>7} {'MaxDeg':>7} {'MaxIn':>6} {'Hubs':>6} {'Density':>8} "
          f"{'Time':>6} {'Act':>5} {'AnsAct':>8} {'Ans/Dist':>8} {'D4?':>4}")
    print("-"*80)

    configs_run=0
    for N in node_levels:
        for deg in deg_levels:
            for hub in hub_levels:
                configs_run+=1
                # Generate fresh graph for each config
                g=gen_graph(N, deg, hub)
                qid,ans=add_deep_path(g)
                st=g.stats(); seeds=[(qid,1.0)]

                # 5 runs, median
                times=[]; cnts=[]; aacts=[]; dacts=[]
                for _ in range(5):
                    t0=time.perf_counter()
                    r=spread(seeds,g,4)
                    t1=time.perf_counter()
                    times.append((t1-t0)*1e6); cnts.append(len(r))
                    aacts.append(next((a for n,a,d in r if n==ans),0.0))
                    dacts.append(next((a for n,a,d in r if n=="dist"),0.0))
                mt=sorted(times)[2]; mc=sorted(cnts)[2]
                ma=sorted(aacts)[2]; md=sorted(dacts)[2]
                adr=ma/max(md,0.0001)

                print(f"{st['n']:>5} {st['e']:>6} {st['avg_deg']:>7.2f} {st['max_deg']:>7} "
                      f"{st['max_in']:>6} {st['hub_ratio']:>6.3f} {st['density']:>7.4f} "
                      f"{mt:>6.0f} {mc:>5} {ma:>8.4f} {adr:>8.2f} {'Y' if ma>=ACT_THRESHOLD else 'N':>4}")
                rows.append({'N':N,'E':st['e'],'avg_deg':st['avg_deg'],'max_deg':st['max_deg'],
                            'max_in':st['max_in'],'hub_ratio':st['hub_ratio'],'density':st['density'],
                            'time_us':mt,'activated':mc,'ans_act':ma,'ans_dist_ratio':adr})

    # Write CSV
    with open('/tmp/ilo_properties.csv','w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['N','E','avg_deg','max_deg','max_in','hub_ratio','density',
                                       'time_us','activated','ans_act','ans_dist_ratio'])
        w.writeheader(); w.writerows(rows)

    print(f"\nRan {configs_run} configurations")
    print("\n── ANALYSIS ──")
    print("Correlation between graph properties and key metrics:")

    # Quick manual analysis
    # Group by N to see if N alone drives anything
    for prop in ['avg_deg','max_deg','hub_ratio','density']:
        # Check if variation in this property correlates with metrics
        vals=[r[prop] for r in rows]
        acts=[r['ans_act'] for r in rows]
        ratios=[r['ans_dist_ratio'] for r in rows]
        # Simple: split high/low and compare
        mid=sorted(vals)[len(vals)//2]
        high_act=[a for v,a in zip(vals,acts) if v>mid]
        low_act=[a for v,a in zip(vals,acts) if v<=mid]
        if high_act and low_act:
            diff=sum(high_act)/len(high_act)-sum(low_act)/len(low_act)
            print(f"  {prop}: high-avg act={sum(high_act)/len(high_act):.4f} "
                  f"low-avg act={sum(low_act)/len(low_act):.4f} diff={diff:.4f}")

    # Find best config for testing
    best=max(rows,key=lambda r:r['ans_act']+0.1*math.log(r['E']+1))
    print(f"\n→ Best config for deep-path testing:")
    print(f"  N={best['N']}, E={best['E']}, avg_deg={best['avg_deg']:.1f}")
    print(f"  ans_act={best['ans_act']:.4f}, ans/dist={best['ans_dist_ratio']:.2f}")

    # Config that balances all needs
    # Need: ans_act>threshold, non-trivial deg, reasonable density
    viable=[r for r in rows if r['ans_act']>=ACT_THRESHOLD and r['avg_deg']>=3 and r['N']>=100]
    if viable:
        balanced=sorted(viable,key=lambda r: abs(r['avg_deg']-5)+abs(r['N']-200))[0]
        print(f"\n→ Balanced config for general testing:")
        print(f"  N={balanced['N']}, E={balanced['E']}, avg_deg={balanced['avg_deg']:.1f}")
        print(f"  max_deg={balanced['max_deg']}, max_in={balanced['max_in']}, density={balanced['density']:.4f}")
        print(f"  time={balanced['time_us']:.0f}µs, ans_act={balanced['ans_act']:.4f}")

    print(f"\nFull report: /tmp/ilo_properties.csv")

if __name__=='__main__': run()
