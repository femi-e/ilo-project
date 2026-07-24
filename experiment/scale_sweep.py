#!/usr/bin/env python3
"""ILO Scale Sweep — Find optimal graph size for testing."""
import csv, math, random, time, sys
from collections import defaultdict

random.seed(42)

ACT_THRESHOLD = 0.005
BACKWARD_DISCOUNT = 0.5

class Node:
    __slots__ = ('nid', 'label', 'confidence')
    def __init__(self, nid, label, conf): self.nid=nid; self.label=label; self.confidence=conf

class Link:
    __slots__ = ('lid','from_n','to_n','weight')
    def __init__(self, lid, frm, to, w): self.lid=lid; self.from_n=frm; self.to_n=to; self.weight=w

class Graph:
    def __init__(self):
        self.nodes={}; self.links={}; self.out=defaultdict(list); self.inn=defaultdict(list)
    def add(self, n): self.nodes[n.nid]=n
    def connect(self, f, t, w):
        lid=f"{f}->{t}"; self.links[lid]=Link(lid,f,t,w)
        self.out[f].append(lid); self.inn[t].append(lid)
    def incident(self, nid):
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
        return {'nodes':len(self.nodes),'links':len(self.links),
                'avg_deg':sum(degs)/max(len(degs),1),'max_deg':max(degs) if degs else 0}

def random_graph(num_nodes, avg_deg=3.0):
    g=Graph()
    words=["alice","bob","carol","dave","eve","project","task","bug",
           "meeting","doc","code","review","deploy","test","api","ui"]
    for i in range(num_nodes):
        g.add(Node(f"n{i}",f"{words[i%len(words)]}_{i}",round(0.5+random.random()*0.45,2)))
    for i in range(num_nodes):
        targets=max(1,int(random.gauss(avg_deg,1)))
        cand=[n for n in g.nodes if n!=f"n{i}"]
        ws=[len(g.out.get(n,[]))+len(g.inn.get(n,[]))+1 for n in cand]
        probs=[w/sum(ws) for w in ws]
        for c in set(random.choices(cand,weights=probs,k=min(targets,len(cand)))):
            g.connect(f"n{i}",c,round(0.2+random.random()*0.6,2))
    return g

def deep_path_graph(path_len=4):
    g=Graph()
    g.add(Node("q","query",0.95))
    prev="q"
    for i in range(1,path_len):
        g.add(Node(f"h{i}",f"hop{i}",0.85+random.random()*0.1))
        g.connect(prev,f"h{i}",0.5+random.random()*0.3); prev=f"h{i}"
    g.add(Node("ans","answer",0.90))
    g.connect(prev,"ans",0.8)
    g.add(Node("dist","distractor",0.70))
    g.connect("q","dist",0.7)
    return g,"q","ans"

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
        # Inhibition
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
    print("="*70)
    print("ILO GRAPH SCALE SWEEP — Finding optimal test scale")
    print("="*70)
    hdr=f"{'Nodes':>8} {'Links':>8} {'AvgDeg':>8} {'MaxDeg':>8} Time(us) ActCnt AnsAct  Ans/Dist  D4?"
    print(hdr); print("-"*70)

    scales=[10,25,50,75,100,150,200,300,500,750,1000,1500,2000]
    rows=[]
    for nn in scales:
        dpg,qid,ans=deep_path_graph(4)
        g=random_graph(nn,3.0)
        for n in dpg.nodes.values():
            if n.nid not in g.nodes: g.nodes[n.nid]=n
        for l in dpg.links.values():
            nlid=f"{l.from_n}->{l.to_n}"
            if nlid not in g.links:
                g.links[nlid]=l; g.out[l.from_n].append(nlid); g.inn[l.to_n].append(nlid)

        st=g.stats(); seeds=[(qid,1.0)]
        times=[]; ans_acts=[]; dist_acts=[]; act_cnts=[]
        for _ in range(10):
            t0=time.perf_counter()
            r=spread(seeds,g,4)
            t1=time.perf_counter()
            times.append((t1-t0)*1e6); act_cnts.append(len(r))
            aa=next((a for nid,a,d in r if nid==ans),0.0); ans_acts.append(aa)
            da=next((a for nid,a,d in r if nid=="dist"),0.0); dist_acts.append(da)
        mt=sorted(times)[5]; ma=sorted(act_cnts)[5]
        m_ans=sorted(ans_acts)[5]; m_dist=sorted(dist_acts)[5]
        d4=m_ans>=ACT_THRESHOLD; adr=m_ans/max(m_dist,0.0001)
        print(f"{st['nodes']:>8} {st['links']:>8} {st['avg_deg']:>8.2f} {st['max_deg']:>8} "
              f"{mt:>8.0f} {ma:>6} {m_ans:>6.4f} {adr:>8.2f} {'Y' if d4 else 'N':>4}")
        rows.append({'nodes':st['nodes'],'links':st['links'],'time_us':mt,
                     'ans_act':m_ans,'ans_dist_ratio':adr,'d4':d4,'activated':ma})

    # Write CSV
    with open('/tmp/ilo_scale.csv','w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['nodes','links','time_us','ans_act','ans_dist_ratio','d4','activated'])
        w.writeheader(); w.writerows(rows)

    # Find knee point
    print("\n── FINDING KNEE POINT ──")
    print("Criterion: smallest scale where ans/dist ratio > 2.0 AND ans_act > threshold")
    best=None
    for r in rows:
        if r['ans_dist_ratio']>2.0 and r['ans_act']>=ACT_THRESHOLD:
            if best is None: best=r
    if best:
        print(f"→ Optimal test scale: {best['nodes']} nodes, {best['links']} links")
        print(f"  (ans/dist={best['ans_dist_ratio']:.2f}, time={best['time_us']:.0f}µs)")
        print(f"→ Recommended experiment scale: {best['nodes']} nodes")
        print(f"→ Equivalent Props: ~{best['nodes']*6} (avg 6 props per node)")
        print(f"→ Equivalent Links: ~{best['links']}")
    else:
        # Fallback: use 200 nodes (known to work from Rust harness)
        print("→ No clear knee. Using 200 nodes (empirically validated in Rust harness)")
        print("→ Equivalent Props: ~1200")
        print("→ Equivalent Links: ~600")

    print(f"\nReport saved to: /tmp/ilo_scale.csv")

if __name__=='__main__': run()
