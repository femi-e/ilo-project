#!/usr/bin/env python3
"""ILO Final Retrieval Algorithm — Multi-seed, 4-factor scoring, realistic graphs."""
import math, random, statistics, time, re
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph

DAMPING = 0.85

# ── INTENT CLASSIFICATION ──
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
    if any(w in q for w in["project","works on","works for","job","role"]):return"project"
    if any(w in q for w in["depend","need","require","prerequisite","blocked"]):return"dependency"
    if any(w in q for w in["conflict","contradict","disagree","versus"]):return"conflict"
    if any(w in q for w in["evidence","proof","support","show","demonstrate"]):return"evidence"
    if any(w in q for w in["mention","about","refer","said","talked"]):return"reference"
    if any(w in q for w in["before","after","timeline","sequence","order","when"]):return"sequence"
    if any(w in q for w in["contain","part of","belong","include"]):return"composition"
    if any(w in q for w in["context","related","around","background"]):return"context"
    return"generic"

# ── LABEL SIMILARITY ──
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

# ── SEED FINDING WITH QUERY DECOMPOSITION ──
def find_seeds(query, graph):
    """Find seeds. Handles multi-entity queries by decomposing.
    Falls back to intent-based entity discovery when no label matches."""
    # Try full query first
    seeds = _find_label_matches(query, graph)
    if seeds: return seeds
    
    # Decompose: extract "entity and entity" or "entity, entity" patterns
    parts = _decompose_query(query)
    for part in parts:
        seeds = _find_label_matches(part, graph)
        if seeds: return seeds
    
    # Fallback: search each word with >2 chars
    words = [w for w in re.findall(r'\b[a-zA-Z]{2,}\b', query.lower())
             if w not in {'the','and','or','for','about','with','tell','what','how','why','when'}]
    for word in words:
        seeds = _find_label_matches(word, graph)
        if seeds: return seeds
    
    # INTENT-BASED FALLBACK: if query mentions a type, find all entities of that type
    q = query.lower()
    type_map = {
        'project': ['project','projects'],
        'person': ['person','people','who'],
        'tool': ['tool','tools'],
        'language': ['language','languages'],
        'concept': ['concept','concepts'],
    }
    for keyword, synonyms in type_map.items():
        matched = False
        for syn in synonyms:
            if syn in q: matched = True; break
        if matched:
            candidates = []
            for nid, nd in graph.nodes.items():
                if nd.get('subtype') == keyword:
                    candidates.append((nid, 0.4))  # lower weight than label match
            if candidates:
                candidates.sort(key=lambda x: -x[1])
                return candidates[:5]
    
    return []

def _find_label_matches(term, graph):
    """Simple label matching for a single search term."""
    t=term.lower().strip()
    if not t: return []
    # Skip common words that cause false matches
    if t in {'the','and','or','for','about','with','tell','what','how','why','when','are','but','not','all','can','has','had','was','were','its','their'}: return []
    seeds=[]
    for nid,nd in graph.nodes.items():
        lbl=nd.get('label','').lower()
        if not lbl: continue
        if t==lbl: seeds.append((nid,1.0))
        elif t in lbl or lbl in t: seeds.append((nid,0.7))
    dedup={}
    for nid,s in seeds:
        if nid not in dedup or s>dedup[nid]: dedup[nid]=s
    r=[(n,s) for n,s in dedup.items()]; r.sort(key=lambda x:-x[1])
    return r[:5]

def _decompose_query(query):
    """Extract searchable terms from a multi-entity query."""
    q=query.lower()
    # Pattern: "x and y" → [x, y]
    parts=[]
    # Try splitting on " and " or " or "
    for sep in [" and ", " or ", ", "]:
        if sep in q:
            candidates = [p.strip() for p in q.split(sep)]
            # Filter to only meaningful words
            candidates = [c for c in candidates if len(c)>2 and c not in 
                         {'the','for','about','tell','what','how','why','when','with'}]
            if candidates:
                return candidates
    # Try extracting known entity types
    for word in q.split():
        word=word.strip('?,!.;:')
        if len(word)>2 and word not in {'the','and','for','about','tell','what','how'}:
            parts.append(word)
    return parts

# ── MAIN RETRIEVAL ──
def retrieve(query, graph, damping=DAMPING, min_score=0.02, max_hops=4):
    """Full retrieval: find seeds, expand with 4-factor PPR scoring."""
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
            
            tr=1.0 if ltype in etypes else 0.3
            ew=w; tc=td['conf']
            ls=label_sim(query,td.get('label',''),td.get('subtype'),graph.props.get(target,{}))
            product=tr*ew*tc*ls
            new_score=damping*cscore+(1-damping)*product
            
            if new_score>=min_score:
                frontier.append((target,depth+1,new_score,path+[target]))
                visited.add(target)
    
    collected.sort(key=lambda x:-x[1])
    return collected

if __name__=='__main__':
    print("═"*70)
    print("FINAL ILO RETRIEVAL — Full Validation")
    print("═"*70)
    
    # ── TEST 1: Multi-seed queries ──
    print("\n── TEST 1: Multi-Seed Queries ──")
    test_queries = [
        "Tell me about Alice and Bob",
        "What projects does Alice work on?",
        "Tell me about Rust and Candle",
        "What depends on Candle?",
        "Tell me about LadybugDB",
        "alice bob project",
        "hebbian learning spreading activation",
    ]
    
    for q in test_queries:
        g=generate_ilo_graph(200)
        r=retrieve(q,g)
        seeds=find_seeds(q,g)
        n=len(r)
        top3=[lbl for _,_,_,_,lbl,_,_ in r[:3]]
        print(f"\n  Query: {q}")
        print(f"  Seeds: {[s[0] for s in seeds]}")
        print(f"  Results: {n}")
        print(f"  Top 3: {top3}")
    
    # ── TEST 2: Ground truth ranking on realistic graphs ──
    print("\n── TEST 2: Ground Truth Ranking (20 runs each) ──")
    cases = [
        ("What projects does Alice work on?", lambda nid,nd,g: nd.get('subtype')=='project' and nd.get('conf',0)>0.7),
        ("Tell me about Rust", lambda nid,nd,g: nd.get('label','').lower()=='rust'),
        ("What depends on Candle?", lambda nid,nd,g: nd.get('subtype') in ('tool','language')),
        ("hebbian learning", lambda nid,nd,g: nd.get('label','').lower()=='hebbian learning'),
    ]
    
    results=[]; all_ranks=[]
    for query,verify in cases:
        ranks=[]
        for _ in range(20):
            g=generate_ilo_graph(200)
            r=retrieve(query,g)
            found=False
            for rank,(nid,scr,depth,path,lbl,props,ntype) in enumerate(r):
                nd=g.nodes.get(nid)
                if nd and verify(nid,nd,g):
                    ranks.append(rank+1); found=True; break
            if not found: ranks.append(999)
        avg_rank=statistics.mean(ranks)
        found_pct=sum(1 for rr in ranks if rr<999)/len(ranks)*100
        all_ranks.append(avg_rank)
        status="✅" if avg_rank<5 else "⚠" if avg_rank<50 else "❌"
        print(f"  {status} {query:<45} avg_rank={avg_rank:>6.2f} found={found_pct:.0f}%")
    
    print(f"\n  Overall avg rank: {statistics.mean(all_ranks):.2f}")
    
    # ── TEST 3: Latency ──
    print(f"\n── TEST 3: Latency (100 retrievals on N=200) ──")
    times=[]
    g=generate_ilo_graph(200)
    for _ in range(100):
        t0=time.perf_counter()
        retrieve("What projects does Alice work on?",g)
        t1=time.perf_counter()
        times.append((t1-t0)*1e6)
    print(f"  P50: {sorted(times)[50]:.1f}µs")
    print(f"  P95: {sorted(times)[95]:.1f}µs")
    print(f"  Max: {max(times):.1f}µs")
    
    # ── TEST 4: Score distribution ──
    print(f"\n── TEST 4: Score Distribution on Realistic Graph ──")
    all_scores=[]
    for _ in range(20):
        g=generate_ilo_graph(200)
        r=retrieve("alice",g)
        all_scores.extend([s for _,s,_,_,_,_,_ in r])
    s=sorted(all_scores)
    if s:
        print(f"  P1:  {s[int(len(s)*0.01)]:.4f}")
        print(f"  P50: {s[len(s)//2]:.4f}")
        print(f"  P99: {s[int(len(s)*0.99)]:.4f}")
        print(f"  Saturated at 1.0: {sum(1 for sc in s if sc>0.95)}/{len(s)}")
        print(f"  Range: {min(s):.4f} - {max(s):.4f}")
    
    print(f"\n{'═'*70}")
    print(f"VALIDATION COMPLETE")
    print(f"{'═'*70}")
