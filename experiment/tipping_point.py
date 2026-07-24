#!/usr/bin/env python3
"""Find tipping point: how many extra connections kill deep retrieval."""
import math, random, time
from collections import defaultdict

random.seed(42)
ACT_THRESHOLD=0.005; BACK=0.5

class G:
    def __init__(self):
        self.n={}; self.l={}; self.o=defaultdict(list); self.inn=defaultdict(list)
    def add(self,i,c): self.n[i]=c
    def con(self,f,t,w):
        k=f"{f}->{t}"; self.l[k]=(f,t,w); self.o[f].append(k); self.inn[t].append(k)
    def inc(self,i):
        e=[]
        for k in self.o.get(i,[]):
            if k in self.l: e.append(self.l[k])
        for k in self.inn.get(i,[]):
            if k in self.l:
                l=self.l[k]
                if l[0]!=l[1]: e.append(l)
        return e
    def deg(self,i): return len(self.o.get(i,[]))+len(self.inn.get(i,[]))

def gen(N,deg):
    g=G()
    for i in range(N): g.add(f"n{i}",round(0.5+random.random()*0.45,2))
    for i in range(N):
        ne=max(1,int(random.gauss(deg,1)))
        for _ in range(min(ne,N-1)):
            t=random.choice([f"n{j}" for j in range(N) if j!=i])
            g.con(f"n{i}",t,round(0.2+random.random()*0.6,2))
    return g

def add_path(g,N,extra):
    """Add deep path with `extra` random connections per path node."""
    g.add("q",0.95); g.add("h1",0.90); g.add("h2",0.90); g.add("h3",0.90)
    g.add("ans",0.90); g.add("dist",0.70)
    g.con("q","h1",0.6); g.con("h1","h2",0.7)
    g.con("h2","h3",0.7); g.con("h3","ans",0.8)
    g.con("q","dist",0.7)
    for pn in ["q","h1","h2","h3","ans","dist"]:
        for _ in range(extra):
            rn=f"n{random.randint(0,N-1)}"
            if rn!=pn: g.con(pn,rn,round(0.2+random.random()*0.6,2))
    return "q","ans"

def spread(seeds,g,max_hops):
    act={}; dep={}; fired=set()
    for sid,sc in seeds:
        if sid in g.n:
            e=g.n[sid]*sc; act[sid]=act.get(sid,0.0)+e; dep[sid]=0
    for _ in range(1,max_hops+1):
        nxt={}; ndep={}
        for nid,energy in list(act.items()):
            if energy<ACT_THRESHOLD or nid in fired: continue
            fired.add(nid)
            edges=g.inc(nid)
            if not edges: continue
            fan=len(edges)
            for frm,to,w in edges:
                is_f=frm==nid; tgt=to if is_f else frm
                if tgt==nid: continue
                p=energy*w*(1.0 if is_f else BACK)/fan
                if p<ACT_THRESHOLD: continue
                nxt[tgt]=nxt.get(tgt,0.0)+p
                cd=dep.get(nid,0)+1
                if tgt not in ndep or cd<ndep[tgt]: ndep[tgt]=cd
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
                if ni not in dep or ndep.get(ni,999)<dep.get(ni,999): dep[ni]=ndep.get(ni,0)
        if not any(e>=ACT_THRESHOLD for e in nxt.values()): break
    return [(nid,act.get(nid,0),dep.get(nid,0)) for nid in act]

print("="*70)
print("TIPPOINT ANALYSIS — How many extra connections kill deep retrieval?")
print("="*70)
print("\nFinding: at what fan-out level does the depth-4 answer vanish?")
print()

N=200
for deg in [3,5,10,20]:
    print(f"\n── Background density: deg={deg} ──")
    print(f"{'ExtraConn':>10} {'FanQ':>6} {'FanH3':>6} {'AnsAct':>8} {'ActNodes':>9} {'Status':>10}")
    print("-"*55)
    for extra in range(0,8):
        all_acts=[]
        all_cnts=[]
        for trial in range(5):
            g=gen(N,deg)
            qid,ans=add_path(g,N,extra)
            r=spread([(qid,1.0)],g,4)
            aa=next((a for n,a,d in r if n==ans),0.0)
            all_acts.append(aa); all_cnts.append(len(r))
        
        med_act=sorted(all_acts)[2]
        med_cnt=sorted(all_cnts)[2]
        fan_q=g.deg("q")
        fan_h3=g.deg("h3")
        status="✅" if med_act>=ACT_THRESHOLD else "❌"
        print(f"{extra:>10} {fan_q:>6} {fan_h3:>6} {med_act:>8.4f} {med_cnt:>9} {status:>10}")

print("\n── TIPPING POINTS ──")
print("Extra connections that cause the depth-4 answer to be lost:")
for deg in [3,5,10,20]:
    for extra in range(0,8):
        died_at=None
        for trial in range(5):
            g=gen(N,deg)
            qid,ans=add_path(g,N,extra)
            r=spread([(qid,1.0)],g,4)
            aa=next((a for n,a,d in r if n==ans),0.0)
            if aa<ACT_THRESHOLD:
                died_at=extra; break
        if died_at is not None:
            print(f"  deg={deg:>2}: answer dies at extra_conn={extra}, path node degree ≈ {2+extra}")
            break
    else:
        print(f"  deg={deg:>2}: answer survives even at extra_conn=7")

print("\n── RECOMMENDATION ──")
print("  For realistic testing: use extra_conn=2-3 (path nodes have degree ~5)")
print("  This matches real ILO: entities referenced in 2-3 different turns")
print("  → At this connectivity, the answer survives but is stressed")
