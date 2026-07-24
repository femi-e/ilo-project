#!/usr/bin/env python3
"""ILO Density Stress Test — How does graph density affect retrieval?"""
import csv, math, random, time
from collections import defaultdict

random.seed(42)
ACT_THRESHOLD = 0.005
BACKWARD_DISCOUNT = 0.5

class Graph:
    def __init__(self):
        self.nodes={}; self.links={}; self.out=defaultdict(list); self.inn=defaultdict(list)
    def add(self,nid,conf): self.nodes[nid]=conf
    def connect(self,f,t,w):
        lid=f"{f}->{t}"; self.links[lid]=(f,t,w)
        self.out[f].append(lid); self.inn[t].append(lid)
    def incident(self,nid):
        e=[]
        for lid in self.out.get(nid,[]):
            if lid in self.links: e.append(self.links[lid])
        for lid in self.inn.get(nid,[]):
            if lid in self.links:
                l=self.links[lid]
                if l[0]!=l[1]: e.append(l)
        return e
    def degree(self,nid): return len(self.out.get(nid,[])) + len(self.inn.get(nid,[]))

def gen(N, deg):
    g=Graph()
    for i in range(N): g.add(f"n{i}",round(0.5+random.random()*0.45,2))
    for i in range(N):
        n_edges=max(1,int(random.gauss(deg,1)))
        for _ in range(min(n_edges,N-1)):
            t=random.choice([f"n{j}" for j in range(N) if j!=i])
            g.connect(f"n{i}",t,round(0.2+random.random()*0.6,2))
    return g

def embed_path(g):
    """Embed a known deep path: q→h1→h2→h3→ans + distractor"""
    g.add("q",0.95); g.add("h1",0.90); g.add("h2",0.90); g.add("h3",0.90)
    g.add("ans",0.90); g.add("dist",0.70)
    g.connect("q","h1",0.6); g.connect("h1","h2",0.7)
    g.connect("h2","h3",0.7); g.connect("h3","ans",0.8)
    g.connect("q","dist",0.7)
    return "q","ans"

def spread(seeds, graph, max_hops, inhibit_m=4, inhibit_beta=0.3, depth_protect=True):
    act={}; depths={}; fired=set()
    for sid,sc in seeds:
        if sid in graph.nodes:
            e=graph.nodes[sid]*sc; act[sid]=act.get(sid,0.0)+e; depths[sid]=0
    for hop in range(1,max_hops+1):
        nxt={}; ndep={}
        for nid,energy in list(act.items()):
            if energy<ACT_THRESHOLD or nid in fired: continue
            fired.add(nid)
            edges=graph.incident(nid)
            if not edges: continue
            fan=len(edges)
            for frm,to,w in edges:
                is_fwd=frm==nid; target=to if is_fwd else frm
                if target==nid: continue
                prop=energy*w*(1.0 if is_fwd else BACKWARD_DISCOUNT)/fan
                if prop<ACT_THRESHOLD: continue
                nxt[target]=nxt.get(target,0.0)+prop
                cd=depths.get(nid,0)+1
                if target not in ndep or cd<ndep[target]: ndep[target]=cd
        srt=sorted(nxt.items(),key=lambda x:-x[1])
        if len(srt)>inhibit_m:
            top=srt[inhibit_m-1][1]
            for i,(ni,en) in enumerate(srt):
                if i>=inhibit_m:
                    d=ndep.get(ni,1); dp=0.3 if depth_protect and d>=3 else 1.0
                    s=(top-en)*inhibit_beta*dp; nxt[ni]=max(0.0,en-s)
        for ni,en in nxt.items():
            if en>=ACT_THRESHOLD:
                act[ni]=act.get(ni,0.0)+en
                if ni not in depths or ndep.get(ni,999)<depths.get(ni,999):
                    depths[ni]=ndep.get(ni,0)
        if not any(e>=ACT_THRESHOLD for e in nxt.values()): break
    return [(nid,act.get(nid,0),depths.get(nid,0)) for nid in act]

def run():
    print("="*70)
    print("DENSITY STRESS TEST — How density affects retrieval")
    print("="*70)
    
    # Test matrix: 3 scales × 6 density levels
    tests = [
        (50, [2,4,6,10,15,20]),
        (200, [2,4,6,10,15,20]),
        (500, [2,4,6,10,15,20]),
    ]
    
    print(f"\n{'N':>4} {'Deg':>5} {'E':>7} {'Den%':>7} {'Time':>6} {'Act':>5} {'AnsAct':>8} {'Ans/Dist':>8} {'FanOut':>7}")
    print("-"*65)
    rows=[]
    
    for N, degs in tests:
        for deg in degs:
            g=gen(N,deg)
            qid,ans=embed_path(g)
            seeds=[(qid,1.0)]
            
            # Measure
            t0=time.perf_counter()
            r=spread(seeds,g,4)
            t1=time.perf_counter()
            dt=(t1-t0)*1e6
            n_act=len(r)
            aa=next((a for n,a,d in r if n==ans),0.0)
            da=next((a for n,a,d in r if n=="dist"),0.0)
            adr=aa/max(da,0.0001)
            
            # Avg fan-out along the embedded path
            fan_out=0; cnt=0
            for nid in ["q","h1","h2","h3","ans"]:
                if nid in g.nodes:
                    fan_out+=g.degree(nid); cnt+=1
            avg_fan=fan_out/max(cnt,1)
            
            E=len(g.links); maxE=N*(N-1)
            dens=E/maxE*100 if maxE>0 else 0
            
            flag=""
            if aa<ACT_THRESHOLD: flag=" ❌"
            elif adr<0.05: flag=" ⚠"
            
            print(f"{N:>4} {deg:>5} {E:>7} {dens:>6.3f}% {dt:>6.0f} {n_act:>5} {aa:>8.4f} {adr:>8.2f} {avg_fan:>7.1f}{flag}")
            rows.append({'N':N,'deg':deg,'E':E,'density':dens,'time_us':dt,
                        'activated':n_act,'ans_act':aa,'ans_dist_ratio':adr,'avg_fan':avg_fan})
    
    # Analysis
    print("\n── ANALYSIS ──")
    
    # Find tipping point where answer is lost
    print("\nDensity tipping points:")
    for N in [50,200,500]:
        n_rows=[r for r in rows if r['N']==N]
        lost=None
        for r in n_rows:
            if r['ans_act']<ACT_THRESHOLD:
                lost=r; break
        if lost:
            print(f"  N={N}: Answer LOST at density {lost['density']:.2f}% (deg={lost['deg']})")
        else:
            last=n_rows[-1]
            print(f"  N={N}: Answer SURVIVED up to {last['density']:.2f}% (deg={last['deg']})")
    
    # Correlation
    d_vals=[r['density'] for r in rows]
    a_vals=[r['ans_act'] for r in rows]
    if len(d_vals)>1:
        # Simple correlation
        mean_d=sum(d_vals)/len(d_vals); mean_a=sum(a_vals)/len(a_vals)
        num=sum((d-mean_d)*(a-mean_a) for d,a in zip(d_vals,a_vals))
        den=math.sqrt(sum((d-mean_d)**2 for d in d_vals))*math.sqrt(sum((a-mean_a)**2 for a in a_vals))
        corr=num/den if den>0 else 0
        print(f"\n  Correlation density→ans_act: {corr:+.3f}")
        print(f"  (Negative = denser graphs reduce answer activation)")
    
    print(f"\n  Verdict: {'Denser graphs degrade deep retrieval' if corr<0 else 'Density has minimal effect'}")
    
    # Export
    with open('/tmp/ilo_density.csv','w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['N','deg','E','density','time_us','activated','ans_act','ans_dist_ratio','avg_fan'])
        w.writeheader(); w.writerows(rows)
    print(f"\nExported: /tmp/ilo_density.csv")

if __name__=='__main__': run()

def embed_path_connected(g, N, extra_edges=2):
    """Embed a deep path AND connect each path node to `extra_edges` random nodes."""
    g.add("q",0.95); g.add("h1",0.90); g.add("h2",0.90); g.add("h3",0.90)
    g.add("ans",0.90); g.add("dist",0.70)
    g.connect("q","h1",0.6); g.connect("h1","h2",0.7)
    g.connect("h2","h3",0.7); g.connect("h3","ans",0.8)
    g.connect("q","dist",0.7)
    # Connect path nodes to random graph nodes (this stresses the algorithm)
    for pn in ["q","h1","h2","h3","ans","dist"]:
        for _ in range(extra_edges):
            rn = f"n{random.randint(0,N-1)}"
            if rn != pn:
                g.connect(pn, rn, round(0.2+random.random()*0.6,2))
    return "q","ans"

def run2():
    print("\n" + "="*70)
    print("DENSITY STRESS TEST V2 — Path CONNECTED to graph")
    print("="*70)
    
    # Single scale (N=200), vary density AND connection strength
    N=200
    print(f"\n{'Deg':>5} {'E':>7} {'Den%':>7} {'Time':>6} {'Act':>5} {'AnsAct':>8} {'Ans/Dist':>8} {'PathEdges':>10}")
    print("-"*60)
    rows=[]
    
    for deg in [2,4,6,10,15,20,25,30]:
        for conn in [0,1,3,5]:  # how many extra edges FROM path TO graph
            g=gen(N,deg)
            qid,ans=embed_path_connected(g, N, conn)
            seeds=[(qid,1.0)]
            
            t0=time.perf_counter()
            r=spread(seeds,g,4)
            t1=time.perf_counter()
            dt=(t1-t0)*1e6
            n_act=len(r)
            aa=next((a for n,a,d in r if n==ans),0.0)
            da=next((a for n,a,d in r if n=="dist"),0.0)
            adr=aa/max(da,0.0001)
            
            E=len(g.links); maxE=N*(N-1)
            dens=E/maxE*100 if maxE>0 else 0
            
            flag=""
            if aa<ACT_THRESHOLD: flag=" ❌"
            elif adr<0.05: flag=" ⚠"
            
            if conn==0:  # baseline (disconnected path)
                print(f"{deg:>5} {E:>7} {dens:>6.3f}% {dt:>6.0f} {n_act:>5} {aa:>8.4f} {adr:>8.2f} [disconnected]")
            if conn==3:
                print(f"{deg:>5} {E:>7} {dens:>6.3f}% {dt:>6.0f} {n_act:>5} {aa:>8.4f} {adr:>8.2f} [conn=3]{flag}")
            rows.append({'N':N,'deg':deg,'conn':conn,'density':dens,'time_us':dt,
                        'activated':n_act,'ans_act':aa,'ans_dist_ratio':adr})
    
    print("\n── ANALYSIS ──")
    # Compare disconnected vs connected at each density
    print("Effect of connecting path to graph (at N=200):")
    for deg in [4,10,20]:
        base=[r for r in rows if r['deg']==deg and r['conn']==0]
        conn3=[r for r in rows if r['deg']==deg and r['conn']==3]
        conn5=[r for r in rows if r['deg']==deg and r['conn']==5]
        if base and conn3:
            b=base[0]; c3=conn3[0]
            print(f"  deg={deg:>2} ({b['density']:.2f}%): disconnected ans={b['ans_act']:.4f} → conn=3 ans={c3['ans_act']:.4f} (Δ={c3['ans_act']-b['ans_act']:+.4f})")
    
    # Correlation for connected graphs
    conn_rows=[r for r in rows if r['conn']>0]
    if conn_rows:
        d_vals=[r['density'] for r in conn_rows]
        a_vals=[r['ans_act'] for r in conn_rows]
        mean_d=sum(d_vals)/len(d_vals); mean_a=sum(a_vals)/len(a_vals)
        num=sum((d-mean_d)*(a-mean_a) for d,a in zip(d_vals,a_vals))
        den=math.sqrt(sum((d-mean_d)**2 for d in d_vals))*math.sqrt(sum((a-mean_a)**2 for a in a_vals))
        corr=num/den if den>0 else 0
        print(f"\n  Correlation density→ans_act (connected graphs): {corr:+.3f}")
        print(f"  → {'Density hurts retrieval' if corr<0 else 'Density has minimal effect on deep path'}")
    
    with open('/tmp/ilo_density_v2.csv','w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['N','deg','conn','density','time_us','activated','ans_act','ans_dist_ratio'])
        w.writeheader(); w.writerows(rows)

if __name__!='__main__':
    pass
else:
    run()
    run2()
