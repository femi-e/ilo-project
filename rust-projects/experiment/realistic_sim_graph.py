#!/usr/bin/env python3
"""Build a realistic simulated ILO graph with meaningful relationships."""
import random
from collections import defaultdict

random.seed(42)

class Graph:
    def __init__(self):
        self.nodes = {}; self.props = {}
        self.links = {}; self.out = defaultdict(list); self.inn = defaultdict(list)
    def add(self, nid, ntype, subtype, conf, label):
        self.nodes[nid] = {'type':ntype,'subtype':subtype,'conf':conf,'label':label}
        self.props[nid] = {}
    def prop(self, nid, k, v):
        if nid in self.props: self.props[nid][k] = v
    def connect(self, f, t, lt, w=0.5, age=5000):
        lid = f"{f}->{t}"
        self.links[lid] = (f, t, lt, w, age)
        self.out[f].append(lid); self.inn[t].append(lid)
    def deg(self, n): return len(self.out.get(n,[]))+len(self.inn.get(n,[]))
    def incident(self, n):
        e=[]
        for lid in self.out.get(n,[]):
            if lid in self.links: e.append(self.links[lid])
        for lid in self.inn.get(n,[]):
            if lid in self.links:
                l=self.links[lid]
                if l[0]!=l[1]: e.append(l)
        return e

def build():
    g = Graph()
    
    # ── PEOPLE (who they are, what they do) ──
    people = [
        ("alice", 0.95, "Data Scientist", "Alice"),
        ("bob", 0.92, "Data Engineer", "Bob"),
        ("carol", 0.88, "Product Manager", "Carol"),
        ("dave", 0.85, "ML Engineer", "Dave"),
        ("eve", 0.90, "Software Engineer", "Eve"),
        ("frank", 0.87, "Engineering Manager", "Frank"),
    ]
    for nid, conf, role, label in people:
        g.add(f"p_{nid}", "entity", "person", conf, label)
        g.prop(f"p_{nid}", "role", role)
        g.prop(f"p_{nid}", "confidence", conf)
        g.prop(f"p_{nid}", "status", "active")
    
    # ── PROJECTS ──
    projects = [
        ("ilo", 0.95, "active", "ILO Cognitive Runtime"),
        ("atlas", 0.87, "active", "Data Platform"),
        ("zephyr", 0.83, "active", "Analytics Pipeline"),
        ("nova", 0.78, "active", "ML Infrastructure"),
    ]
    for nid, conf, status, label in projects:
        g.add(f"pr_{nid}", "entity", "project", conf, label)
        g.prop(f"pr_{nid}", "confidence", conf)
        g.prop(f"pr_{nid}", "status", status)
    
    # ── TOOLS ──
    tools = [
        ("candle", 0.94, "Rust ML framework"),
        ("python", 0.95, "Programming language"),
        ("rust", 0.94, "Programming language"),
        ("k8s", 0.88, "Container orchestration"),
        ("postgres", 0.90, "Database"),
        ("kafka", 0.85, "Message queue"),
        ("docker", 0.89, "Container runtime"),
        ("spark", 0.82, "Data processing"),
    ]
    for nid, conf, desc in tools:
        g.add(f"t_{nid}", "entity",
              "tool" if nid in ("candle","docker","k8s","kafka","spark","postgres") else "language",
              conf, nid.upper() if nid != "k8s" else "K8s")
        g.prop(f"t_{nid}", "description", desc)
        g.prop(f"t_{nid}", "confidence", conf)
    
    # ── MEANINGFUL RELATIONSHIPS ──
    
    # Alice → works on → ILO, Atlas
    g.connect("p_alice", "pr_ilo", "has", 0.9, 8000)
    g.connect("p_alice", "pr_atlas", "has", 0.7, 6000)
    
    # Bob → works on → ILO, Zephyr
    g.connect("p_bob", "pr_ilo", "has", 0.8, 7500)
    g.connect("p_bob", "pr_zephyr", "has", 0.85, 7000)
    
    # Carol → Product Manager → Atlas, Nova
    g.connect("p_carol", "pr_atlas", "has", 0.8, 5000)
    g.connect("p_carol", "pr_nova", "has", 0.7, 4000)
    
    # Dave → works on → Nova, ILO
    g.connect("p_dave", "pr_nova", "has", 0.75, 5500)
    g.connect("p_dave", "pr_ilo", "has", 0.6, 4500)
    
    # Eve → works on → Zephyr
    g.connect("p_eve", "pr_zephyr", "has", 0.8, 6500)
    
    # Frank → leads → ILO, Atlas
    g.connect("p_frank", "pr_ilo", "has", 0.95, 8500)
    g.connect("p_frank", "pr_atlas", "has", 0.85, 7000)
    
    # ILO depends on Candle, Rust, Python
    g.connect("pr_ilo", "t_candle", "dep", 0.9, 8000)
    g.connect("pr_ilo", "t_rust", "dep", 0.85, 7500)
    g.connect("pr_ilo", "t_python", "dep", 0.8, 7000)
    
    # Atlas depends on Python, Spark, Postgres, Kafka
    g.connect("pr_atlas", "t_python", "dep", 0.9, 6000)
    g.connect("pr_atlas", "t_spark", "dep", 0.8, 5000)
    g.connect("pr_atlas", "t_postgres", "dep", 0.85, 4500)
    g.connect("pr_atlas", "t_kafka", "dep", 0.7, 4000)
    
    # Zephyr depends on Python, Spark, Docker
    g.connect("pr_zephyr", "t_python", "dep", 0.85, 6500)
    g.connect("pr_zephyr", "t_spark", "dep", 0.8, 6000)
    g.connect("pr_zephyr", "t_docker", "dep", 0.7, 5500)
    
    # Nova depends on Candle, Python, K8s
    g.connect("pr_nova", "t_candle", "dep", 0.85, 5000)
    g.connect("pr_nova", "t_python", "dep", 0.8, 4500)
    g.connect("pr_nova", "t_k8s", "dep", 0.8, 4000)
    
    # Tool→language dep edges
    g.connect("t_candle", "t_rust", "dep", 0.9, 8000)
    g.connect("t_spark", "t_python", "dep", 0.85, 6000)
    g.connect("t_k8s", "t_docker", "dep", 0.8, 5000)
    g.connect("t_kafka", "t_python", "dep", 0.7, 4000)
    
    # Cross-project dependencies
    g.connect("pr_ilo", "pr_atlas", "dep", 0.6, 7000)
    g.connect("pr_zephyr", "pr_atlas", "dep", 0.5, 6000)
    
    # ── CONVERSATION TURNS ──
    conversations = [
        # (speaker, entities_mentioned, content, turn_index)
        ("alice", ["pr_ilo","pr_atlas","t_candle"], "Working on ILO, using Candle for the ML backend", 1),
        ("bob", ["pr_ilo","pr_zephyr","t_spark"], "Building the data pipeline for ILO, using Spark", 2),
        ("frank", ["pr_ilo","pr_atlas","p_alice","p_bob"], "Alice and Bob are doing great work on ILO and Atlas", 3),
        ("dave", ["pr_nova","t_candle","t_k8s"], "Nova ML infra uses Candle and K8s", 4),
        ("alice", ["pr_ilo","p_frank","t_rust"], "Frank suggested we use more Rust for ILO", 5),
        ("carol", ["pr_atlas","pr_nova","p_dave","t_python"], "Product review: Atlas and Nova progress with Dave on Python", 6),
        ("eve", ["pr_zephyr","t_python","t_spark"], "Zephyr analytics pipeline in Python on Spark", 7),
        ("bob", ["pr_ilo","t_postgres","t_kafka"], "ILO data layer: Postgres + Kafka integration", 8),
        ("frank", ["pr_ilo","pr_nova","p_dave","p_alice"], "Strategic: ILO-Nova integration with Dave and Alice", 9),
        ("alice", ["pr_ilo","t_candle","p_bob"], "Candle is working well for ILO, Bob helped with the data layer", 10),
        ("dave", ["pr_nova","pr_atlas","t_k8s","t_docker"], "Nova deployment on K8s with Docker", 11),
        ("carol", ["pr_atlas","pr_zephyr","t_postgres","p_eve"], "Atlas-Zephyr integration via Postgres, Eve involved", 12),
        ("eve", ["pr_zephyr","p_bob","t_spark"], "Zephyr query optimisation with Bob", 13),
        ("alice", ["pr_ilo","pr_nova","t_candle","t_rust"], "ILO inference pipeline: Candle → Rust → deployment", 14),
        ("frank", ["pr_ilo","pr_atlas","pr_zephyr","p_alice","p_bob","p_carol"], "Q1 review: ILO on track, Atlas needs work, Zephyr good", 15),
    ]
    
    for i, (speaker, topics, content, idx) in enumerate(conversations):
        tid = f"t{i}"
        g.add(tid, "turn", "", 1.0, f"Turn #{idx}")
        g.prop(tid, "session_id", f"project_chat_{idx // 10}")
        g.prop(tid, "turn_index", idx)
        g.prop(tid, "user_text", f"{speaker}: {content}")
        # Connect turn to speaker
        g.connect(tid, f"p_{speaker}", "ref", 0.9, idx * 500)
        # Connect turn to each mentioned entity
        for topic_id in topics:
            w = 0.5 + random.random() * 0.4
            g.connect(tid, topic_id, "ref", round(w,2), idx * 500)
        # Temporal ordering
        if i > 0:
            g.connect(f"t{i-1}", tid, "seq", 0.9, idx * 500)
    
    # ── CLAIMS (facts extracted from conversation) ──
    claims = [
        ("Alice works on ILO", "user.confirmed", "fact", ["p_alice","pr_ilo"], 0.95),
        ("Bob works on ILO and Zephyr", "user.confirmed", "fact", ["p_bob","pr_ilo","pr_zephyr"], 0.90),
        ("ILO depends on Candle", "system.extracted", "fact", ["pr_ilo","t_candle"], 0.90),
        ("Atlas depends on Postgres and Kafka", "system.extracted", "fact", ["pr_atlas","t_postgres","t_kafka"], 0.85),
        ("Frank manages the ILO team", "user.confirmed", "fact", ["p_frank","pr_ilo"], 0.93),
        ("Nova uses Candle and K8s", "system.extracted", "fact", ["pr_nova","t_candle","t_k8s"], 0.80),
        ("Dave works on Nova", "user.confirmed", "fact", ["p_dave","pr_nova"], 0.85),
        ("Carol manages Atlas and Nova products", "user.confirmed", "fact", ["p_carol","pr_atlas","pr_nova"], 0.88),
        ("Zephyr depends on Python and Spark", "system.extracted", "fact", ["pr_zephyr","t_python","t_spark"], 0.80),
        ("Eve works on Zephyr", "user.confirmed", "fact", ["p_eve","pr_zephyr"], 0.90),
        ("ILO inference pipeline uses Candle to Rust", "system.inferred", "inference", ["pr_ilo","t_candle","t_rust"], 0.75),
        ("Atlas and Zephyr share Python infrastructure", "system.inferred", "inference", ["pr_atlas","pr_zephyr","t_python"], 0.70),
    ]
    for i, (content, provenance, type_sub, entities, conf) in enumerate(claims):
        cid = f"c{i}"
        g.add(cid, "claim", "", conf, content)
        g.prop(cid, "provenance", provenance)
        g.prop(cid, "type_sub", type_sub)
        g.prop(cid, "confidence", conf)
        for eid in entities:
            g.connect(cid, eid, "evidence", conf, 5000)
    
    # ── VIEWS ──
    views = [
        ("code-review", ["person","tool","project"], "Filter for code review context"),
        ("planning", ["project","concept"], "Project planning and roadmap"),
        ("research", ["concept","tool"], "Research and exploration"),
        ("technical", ["tool","language","project"], "Technical architecture"),
    ]
    for name, filters, purpose in views:
        g.add(f"v_{name}", "view", "", 1.0, name)
        g.prop(f"v_{name}", "purpose", purpose)
        g.prop(f"v_{name}", "entity_filter", ",".join(filters))
        # Connect view to matching entities
        for nid, nd in g.nodes.items():
            if nd.get('type') == 'entity' and nd.get('subtype') in filters:
                g.connect(f"v_{name}", nid, "context", 1.0, 5000)
    
    return g

if __name__ == '__main__':
    g = build()
    print("═══ REALISTIC SIMULATED GRAPH ═══")
    types = defaultdict(int)
    subtypes = defaultdict(int)
    link_types = defaultdict(int)
    for n in g.nodes.values(): types[n['type']] += 1; subtypes[n['subtype']] += 1
    for l in g.links.values(): link_types[l[2]] += 1
    print(f"Nodes: {len(g.nodes)} ({', '.join(f'{k}={v}' for k,v in sorted(types.items()))})")
    print(f"Edges: {len(g.links)} ({', '.join(f'{k}={v}' for k,v in sorted(link_types.items()))})")
    degs = [g.deg(n) for n in g.nodes]
    print(f"Avg degree: {sum(degs)/len(degs):.1f}, Max: {max(degs)}")
    print(f"Subtypes: {dict(subtypes)}")
    
    # Verify: query for Alice's projects should find ILO, Atlas
    print("\n═══ SANITY CHECK: Alice's projects ═══")
    print("\n═══ SANITY CHECK: ILO dependencies ═══")
    r = retrieve("What depends on ILO?", g)
    for nid,score,depth,path,label,props,ntype in r[:10]:
        nd = g.nodes.get(nid, {})
        print(f"  {nd.get('label', nid):20} score={score:.3f} depth={depth}")
    
    # Verify: multi-seed query
    print("\n═══ SANITY CHECK: Alice and Bob ═══")
    r = retrieve("Tell me about Alice and Bob", g)
    for nid,score,depth,path,label,props,ntype in r[:5]:
        nd = g.nodes.get(nid, {})
        print(f"  {nd.get('label', nid):20} score={score:.3f} depth={depth}")
    
    print("\n═══ Graph is ready for Anchor context testing ═══")

if __name__ == '__main__':
    g = build()
    print("═══ REALISTIC SIMULATED GRAPH ═══")
    types = defaultdict(int)
    subtypes = defaultdict(int)
    link_types = defaultdict(int)
    for n in g.nodes.values(): types[n['type']] += 1; subtypes[n['subtype']] += 1
    for l in g.links.values(): link_types[l[2]] += 1
    print(f"Nodes: {len(g.nodes)} ({', '.join(f'{k}={v}' for k,v in sorted(types.items()))})")
    print(f"Edges: {len(g.links)} ({', '.join(f'{k}={v}' for k,v in sorted(link_types.items()))})")
    degs = [g.deg(n) for n in g.nodes]
    print(f"Avg degree: {sum(degs)/len(degs):.1f}, Max: {max(degs)}")
    
    from final_retrieval import retrieve
    print("\n═══ Alice's projects ═══")
    r = retrieve("What projects does Alice work on?", g)
    for nid,s,d,pl,lb,pp,nt in r[:10]:
        print(f"  {lb:20} score={s:.3f} depth={d}")
    
    print("\n═══ ILO dependencies ═══")
    r = retrieve("What depends on ILO?", g)
    for nid,s,d,pl,lb,pp,nt in r[:10]:
        print(f"  {lb:20} score={s:.3f} depth={d}")
    
    print("\n═══ Alice and Bob ═══")
    r = retrieve("Tell me about Alice and Bob", g)
    for nid,s,d,pl,lb,pp,nt in r[:5]:
        print(f"  {lb:20} score={s:.3f} depth={d}")
