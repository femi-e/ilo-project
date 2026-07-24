#!/usr/bin/env python3
"""Brute-force stress test of the guided retrieval algorithm.
Finds failure modes and suggests tweaks. Does NOT modify the algorithm."""
import csv, math, random, statistics, time
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph, embed_paths, Graph
from guided_retrieval import retrieve, classify_intent, INTENT_EDGES, find_seeds, label_sim

random.seed(42)

def brute_force():
    print("="*70)
    print("BRUTE FORCE STRESS TEST — Guided Retrieval Algorithm")
    print("="*70)

    # ── TEST 1: Coverage — what types of query succeed or fail? ──
    print("\n── TEST 1: Query Coverage (100 varied queries) ──")
    
    query_templates = [
        # (query, expected_intent, category)
        ("What is {entity}?", "reference", "simple_lookup"),
        ("Tell me about {entity}", "reference", "simple_lookup"),
        ("What projects does {person} work on?", "project", "relation"),
        ("Who works on {project}?", "membership", "relation"),
        ("What depends on {tool}?", "dependency", "relation"),
        ("What contradicts {concept}?", "conflict", "relation"),
        ("What evidence supports {concept}?", "evidence", "relation"),
        ("When did {person} mention {project}?", "reference", "temporal"),
        ("What does {person} think about {tool}?", "reference", "opinion"),
        ("Is {tool} related to {concept}?", "reference", "boolean"),
    ]
    
    # Find available entities in a generated graph
    g = generate_ilo_graph(200)
    people = [n for n,d in g.nodes.items() if d.get('subtype')=='person']
    projects = [n for n,d in g.nodes.items() if d.get('subtype')=='project']
    tools = [n for n,d in g.nodes.items() if d.get('subtype')=='tool']
    concepts = [n for n,d in g.nodes.items() if d.get('subtype')=='concept']
    all_entities = people + projects + tools + concepts
    
    # Get their labels
    def label_of(nid): return g.nodes[nid].get('label', nid)
    
    queries = []
    for tmpl, intent, cat in query_templates:
        for _ in range(10):
            if "{person}" in tmpl and people:
                p = label_of(random.choice(people))
                q = tmpl.replace("{person}", p)
            elif "{project}" in tmpl and projects:
                p = label_of(random.choice(projects))
                q = tmpl.replace("{project}", p)
            elif "{tool}" in tmpl and tools:
                t = label_of(random.choice(tools))
                q = tmpl.replace("{tool}", t)
            elif "{concept}" in tmpl and concepts:
                c = label_of(random.choice(concepts))
                q = tmpl.replace("{concept}", c)
            elif "{entity}" in tmpl and all_entities:
                e = label_of(random.choice(all_entities))
                q = tmpl.replace("{entity}", e)
            else:
                continue
            queries.append((q, intent, cat))
    
    # Run and track results
    results_by_category = defaultdict(list)
    failures = []
    
    for q, expected_intent, cat in queries[:100]:
        intent = classify_intent(q)
        g2 = generate_ilo_graph(200)
        try:
            r = retrieve(q, g2)
            n_results = len(r)
            top_score = r[0][1] if r else 0
            intent_match = intent == expected_intent
        except Exception as e:
            n_results = -1
            top_score = 0
            intent_match = False
            failures.append((q, str(e)))
        
        results_by_category[cat].append({
            'query': q, 'intent': intent, 'expected': expected_intent,
            'intent_match': intent_match, 'n_results': n_results,
            'top_score': top_score, 'ok': n_results > 0 and top_score > 0
        })
    
    for cat, results in sorted(results_by_category.items()):
        ok = sum(1 for r in results if r['ok'])
        total = len(results)
        im = sum(1 for r in results if r['intent_match'])
        avg_results = statistics.mean([r['n_results'] for r in results]) if results else 0
        print(f"  {cat:<20}: {ok}/{total} successful ({ok/total*100:.0f}%)  "
              f"intent_match={im/total*100:.0f}%  avg_results={avg_results:.1f}")
    
    if failures:
        print(f"\n  Exceptions: {len(failures)}")
        for q, e in failures[:3]:
            print(f"    \"{q[:60]}\" → {e}")
    
    # ── TEST 2: Edge type coverage ──
    print("\n── TEST 2: Edge Type Coverage (does each intent find results?) ──")
    intents = list(INTENT_EDGES.keys())
    for intent in intents:
        etypes = INTENT_EDGES[intent]
        # Generate a query for each intent
        if intent == "generic":
            q = "What is there to know?"
        elif intent == "project":
            q = "What projects exist?"
        elif intent == "dependency":
            q = "What depends on what?"
        elif intent == "conflict":
            q = "What conflicts exist?"
        elif intent == "evidence":
            q = "What evidence is there?"
        elif intent == "reference":
            q = "What has been mentioned?"
        elif intent == "sequence":
            q = "What happened when?"
        elif intent == "composition":
            q = "What contains what?"
        elif intent == "context":
            q = "What is related?"
        else:
            q = f"Things about {intent}"
        
        successes = 0
        for _ in range(10):
            g = generate_ilo_graph(200)
            r = retrieve(q, g)
            if r and r[0][1] > 0:
                successes += 1
        
        print(f"  {intent:<15} edges={str(etypes):<30} {successes}/10 found results {'✅' if successes>=5 else '⚠' if successes>0 else '❌'}")
    
    # ── TEST 3: Seed finding accuracy ──
    print("\n── TEST 3: Seed Finding Accuracy ──")
    g = generate_ilo_graph(200)
    
    test_labels = []
    for nid, nd in list(g.nodes.items())[:20]:
        lbl = nd.get('label', '')
        if lbl:
            test_labels.append((lbl, nid))
    
    exact_matches = 0
    partial_matches = 0
    misses = 0
    
    for lbl, nid in test_labels:
        seeds = find_seeds(lbl, g)
        found = any(s[0] == nid for s in seeds)
        if seeds and seeds[0][0] == nid:
            exact_matches += 1
        elif found:
            partial_matches += 1
        else:
            misses += 1
    
    print(f"  Tested {len(test_labels)} entity labels:")
    print(f"    Exact match (seed[0]==target): {exact_matches}/{len(test_labels)}")
    print(f"    Found in seeds: {exact_matches+partial_matches}/{len(test_labels)}")
    print(f"    Missed: {misses}")
    
    # Test seed finding for non-exact queries
    print(f"\n  Non-exact query test (\"Alice\" → should find Alice entity):")
    seeds = find_seeds("Alice", g)
    alice_found = any('alice' in s[0].lower() for s in seeds)
    print(f"    Found Alice entity: {alice_found} (seeds: {[s[0] for s in seeds[:3]]})")
    
    # ── TEST 4: Scoring diagnostic — trace scores through a path ──
    print("\n── TEST 4: Score Path Tracing ──")
    print("  Following propagation scores to see where they vanish:")
    
    g = generate_ilo_graph(200)
    # Find Alice entity
    alice = None
    for nid, nd in g.nodes.items():
        if nd.get('label') == 'Alice':
            alice = nid
            break
    
    if alice:
        r = retrieve("What projects does Alice work on?", g)
        print(f"  Alice entity: {alice}")
        print(f"  Total nodes retrieved: {len(r)}")
        print(f"  Top 3 scores: {[(n, f'{s:.3f}', d) for n,s,d,p,pp in r[:3]]}")
        
        # Check how many unique edges Alice has and what types
        alice_edges = []
        for lid in g.out.get(alice, []):
            if lid in g.links: alice_edges.append(g.links[lid])
        for lid in g.inn.get(alice, []):
            if lid in g.links: alice_edges.append(g.links[lid])
        
        edge_types = defaultdict(list)
        for e in alice_edges:
            edge_types[e[2]].append(e[3])  # type → [weight]
        print(f"  Alice's incident edges by type:")
        for etype, weights in sorted(edge_types.items()):
            avg_w = statistics.mean(weights) if weights else 0
            print(f"    {etype}: {len(weights)} edges, avg weight={avg_w:.2f}")
    
    # ── TEST 5: Extreme query types ──
    print("\n── TEST 5: Edge Case Queries (stress boundaries) ──")
    
    edge_cases = [
        ("Alice", "single_word"),  # single word, matches entity
        ("XYZ nonexistent entity", "no_match"),  # no matching entity
        ("", "empty"),  # empty string
        ("a", "single_char"),  # single char
        ("What?@#$%", "special_chars"),  # special chars
        ("A" * 100, "very_long"),  # very long
        ("Is there a project and a tool and a person all at once?", "complex"),
        ("the and or but not maybe", "stop_words"),
    ]
    
    for q, case_type in edge_cases:
        g = generate_ilo_graph(200)
        try:
            r = retrieve(q, g)
            n = len(r)
            ts = r[0][1] if r else 0
            status = "✅" if n > 0 else "⚠"
        except Exception as e:
            n = -1
            ts = 0
            status = f"❌ {str(e)[:40]}"
        print(f"  {case_type:<20} \"{q[:50]}\" → {n} results, top={ts:.3f} {status}")

if __name__ == '__main__':
    brute_force()
