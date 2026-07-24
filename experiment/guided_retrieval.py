#!/usr/bin/env python3
"""ILO Guided Retrieval — Your algorithm. Your design. Cleansed and tested."""
import csv, math, random, statistics, time
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph

random.seed(42)

# ── Intent → edge type mapping (your design) ──
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

def label_sim(query, label, subtype=None, props=None):
    """Your scoring: label + type + property similarity."""
    q=query.lower(); l=label.lower()
    if q==l: return 1.0
    if l in q or q in l: return 0.6
    qw=set(q.split()); lw=set(l.split())
    if qw&lw: return 0.4
    # Type match (query mentions "project" and node is a project)
    if subtype:
        for word,st in [("project","project"),("person","person"),("tool","tool"),
                        ("language","language"),("concept","concept")]:
            if word in q and st==subtype: return 0.5
    # Property check
    if props:
        for v in props.values():
            if isinstance(v,str) and (q in v.lower() or v.lower() in q): return 0.5
    return 0.2

def find_seeds(query, graph):
    q=query.lower(); seeds=[]
    for nid,nd in graph.nodes.items():
        lbl=nd.get('label','').lower()
        if not lbl: continue  # skip empty labels
        if q==lbl: seeds.append((nid,1.0))
        elif q in lbl or lbl in q: seeds.append((nid,0.7))
    dedup={}
    for nid,s in seeds:
        if nid not in dedup or s>dedup[nid]: dedup[nid]=s
    r=[(n,s) for n,s in dedup.items()]; r.sort(key=lambda x:-x[1])
    return r[:5]

def retrieve(query, graph, min_score=0.05, max_hops=4):
    """Your guided retrieval algorithm."""
    intent=classify_intent(query)
    etypes=INTENT_EDGES.get(intent,INTENT_EDGES['generic'])
    seeds=find_seeds(query,graph)
    if not seeds: return []

    visited=set(); frontier=[]  # (nid, depth, cumulative_score, path)
    for nid,s in seeds:
        frontier.append((nid,0,s,[nid])); visited.add(nid)

    collected=[]  # (nid, score, depth, path, properties)

    while frontier:
        frontier.sort(key=lambda x:-x[2])
        nid,depth,cscore,path=frontier.pop(0)
        
        # Read properties of reached node
        props=graph.props.get(nid,{})
        collected.append((nid,cscore,depth,path,props))
        
        if depth>=max_hops: continue
        nd=graph.nodes.get(nid)
        if not nd: continue
        
        # Outgoing edges
        for lid in graph.out.get(nid,[]):
            if lid not in graph.links: continue
            frm,to,ltype,w,age=graph.links[lid]
            if to in visited: continue
            if ltype not in etypes: continue
            td=graph.nodes.get(to)
            tc=td['conf'] if td else 0.5
            tl=td.get('label','') if td else ''
            tp=graph.props.get(to,{})
            ls=label_sim(query,tl,td.get('subtype') if td else None,tp)
            score=w*tc*ls
            # Use additive score, not multiplicative, to prevent vanishing
            additive = cscore + score
            if additive >= min_score:
                frontier.append((to,depth+1,additive,path+[to]))
                visited.add(to)
        
        # Incoming edges
        for lid in graph.inn.get(nid,[]):
            if lid not in graph.links: continue
            frm,to,ltype,w,age=graph.links[lid]
            if frm in visited: continue
            if ltype not in etypes: continue
            td=graph.nodes.get(frm)
            tc=td['conf'] if td else 0.5
            tl=td.get('label','') if td else ''
            tp=graph.props.get(frm,{})
            ls=label_sim(query,tl,td.get('subtype') if td else None,tp)
            score=w*tc*ls
            additive = cscore + score
            if additive >= min_score:
                frontier.append((frm,depth+1,additive,path+[frm]))
                visited.add(frm)

    collected.sort(key=lambda x:-x[1])
    return collected

def run():
    print("="*70)
    print("GUIDED RETRIEVAL — YOUR ALGORITHM")
    print("="*70)
    
    tests=[
        ("Alice's projects","What projects does Alice work on?","project"),
        ("Rust deps","What depends on Rust?","dependency"),
        ("LadybugDB info","Tell me about LadybugDB","reference"),
        ("Hebbian evidence","What evidence supports Hebbian Learning?","evidence"),
        ("Generic search","What do you know about graphs?","generic"),
        ("Conflict check","What contradicts spreading activation?","conflict"),
    ]
    
    for short,q,intent in tests:
        etypes=INTENT_EDGES.get(intent,[])
        print(f"\n── {short} ──")
        print(f"  Query: {q}")
        print(f"  Intent: {intent} → edges: {etypes}")
        
        times=[]; counts=[]; tops=[]
        for _ in range(20):
            g=generate_ilo_graph(200)
            t0=time.perf_counter()
            r=retrieve(q,g)
            t1=time.perf_counter()
            times.append((t1-t0)*1e6)
            counts.append(len(r))
            tops.append(r[0][1] if r else 0)
        
        mt=sorted(times)[10]; mc=sorted(counts)[10]; mtop=sorted(tops)[10]
        print(f"  Results: median {mc} nodes, top score={mtop:.3f}, {mt:.0f}µs")
        print(f"  Time range: {min(times):.0f}-{max(times):.0f}µs")
        
        # Show first few results
        g=generate_ilo_graph(200)
        r=retrieve(q,g)
        if r:
            print(f"  Top 5 results:")
            for nid,score,depth,path,props in r[:5]:
                label=g.nodes.get(nid,{}).get('label',nid)
                print(f"    {label} ({nid}) score={score:.3f} depth={depth} props={len(props)}")

if __name__=='__main__': run()
