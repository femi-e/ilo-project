#!/usr/bin/env python3
"""Adaptive max_hops, path-grouped context assembly, Anchor-format output."""
import math, random, statistics, time, re
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph, embed_paths

# ── Reuse retrieval components ──
from final_retrieval import retrieve, find_seeds, label_sim, classify_intent, INTENT_EDGES

DAMPING = 0.85

# ── 1. ADAPTIVE MAX_HOPS ──
def retrieve_adaptive(query, graph, damping=DAMPING, min_score=0.02, 
                      min_hops=2, max_hops=6, target_min_nodes=10):
    """Retrieve with adaptive hop count.
    Starts at min_hops, expands if not enough useful nodes found yet."""
    for hops in range(min_hops, max_hops + 1):
        r = retrieve(query, graph, damping, min_score, hops)
        # Count "useful" nodes (non-zero depth, non-zero score)
        useful = sum(1 for _, s, d, _, _, _, _ in r if d > 0 and s > 0.1)
        if useful >= target_min_nodes or hops == max_hops:
            return r, hops
    return r, max_hops

# ── 2. PATH EXTRACTION ──
def extract_paths(collected):
    """Extract unique paths from the flat result list.
    Returns dict: path_key → [(node_id, score, depth, label, properties)]
    """
    paths = {}
    for nid, score, depth, path, label, props, ntype in collected:
        if len(path) >= 2:
            path_key = " → ".join(path[:3])  # key by first 3 nodes
            if path_key not in paths:
                paths[path_key] = []
            paths[path_key].append((nid, score, depth, label, props, ntype, path))
    return paths

# ── 3. ANCHOR-FORMAT CONTEXT ASSEMBLY ──
def context_to_anchor(results, graph, query, hops_used, max_chars=2000):
    """Convert retrieval results to Anchor-format context block.
    Groups by path, uses @ref syntax for relationships."""
    lines = []
    lines.append("@_session")
    lines.append(f"  [query: {query}]")
    lines.append(f"  [hops: {hops_used}]")
    lines.append(f"  [nodes: {len(results)}]")
    lines.append("")
    
    # Track which entities we've already output
    emitted = set()
    
    # Group results by depth from seed
    seed_ids = set()
    seed_entities = {}
    
    for nid, score, depth, path, label, props, ntype in results:
        if depth == 0:
            safe_id = nid.replace("e_", "").replace("_", "-")[:30]
            seed_ids.add(safe_id)
            seed_entities[safe_id] = (nid, label, props, ntype)
    
    # Output seed entities first
    for safe_id in sorted(seed_entities.keys())[:3]:
        nid, label, props, ntype = seed_entities[safe_id]
        if safe_id in emitted: continue
        emitted.add(safe_id)
        subtype = graph.nodes.get(nid, {}).get('subtype', ntype) if nid in graph.nodes else ntype
        lines.append(f"{safe_id}:{subtype}")
        lines.append(f"  [confidence: {props.get('confidence', 'N/A')}]")
        if 'status' in props:
            lines.append(f"  [status: {props['status']}]")
        emitted.add(safe_id)
    
    # Output paths as chains
    paths_output = set()
    
    for nid, score, depth, path, label, props, ntype in results:
        if depth == 0: continue
        if depth > 5: continue  # skip very deep nodes for brevity
        
        # Build a path chain
        if len(path) >= 2:
            # Create chain: entity → [link] → entity
            prev_safe = path[0].replace("e_", "").replace("_", "-")[:30]
            curr_safe = nid.replace("e_", "").replace("_", "-")[:30]
            curr_label = label[:20] if label else curr_safe
            
            chain_key = f"{prev_safe}→{curr_safe}"
            if chain_key in paths_output: continue
            paths_output.add(chain_key)
            
            # Determine link type from graph
            link_type = find_link_type(graph, path[0], nid)
            
            if curr_safe in emitted:
                # Already emitted, just show the link
                lines.append(f"  {link_type} @{curr_safe}  # via {prev_safe}")
            else:
                # New entity
                emitted.add(curr_safe)
                subtype = graph.nodes.get(nid, {}).get('subtype', ntype) if nid in graph.nodes else ntype
                lines.append("")
                lines.append(f"{curr_safe}:{subtype}")
                if 'confidence' in props:
                    lines.append(f"  [confidence: {props['confidence']}]")
                if 'status' in props:
                    lines.append(f"  [status: {props['status']}]")
                lines.append(f"  {link_type} @{prev_safe}")
                # Show a brief path
                path_labels = []
                for p in path[-3:]:
                    p_node = graph.nodes.get(p, {})
                    path_labels.append(p_node.get('label', p)[:15])
                lines.append(f"  # path: {' → '.join(path_labels)}")
    
    # Check for saturation
    text = "\n".join(lines)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n... [context truncated]"
    
    return text

def find_link_type(graph, from_id, to_id):
    """Find the link type between two nodes."""
    for lid in graph.out.get(from_id, []):
        if lid in graph.links:
            frm, to, ltype, w, age = graph.links[lid]
            if to == to_id: return ltype
    for lid in graph.inn.get(from_id, []):
        if lid in graph.links:
            frm, to, ltype, w, age = graph.links[lid]
            if frm == to_id: return ltype
    return "ref"  # default

# ── 4. COMPREHENSIVE TEST ──
def run():
    print("="*70)
    print("ADAPTIVE HOPS + ANCHOR CONTEXT — Full Test")
    print("="*70)
    
    queries = [
        "Tell me about Alice",
        "What projects does Alice work on?",
        "Tell me about Rust",
        "Tell me about Alice and Bob",
        "hebbian learning spreading activation",
        "What depends on Candle?",
    ]
    
    for query in queries:
        print(f"\n── Query: {query} ──")
        g = generate_ilo_graph(200)
        
        # Standard retrieval (fixed hops=4)
        t0 = time.perf_counter()
        r_std, _ = retrieve_adaptive(query, g, min_hops=4, max_hops=4)
        t_std = (time.perf_counter() - t0) * 1e6
        
        # Adaptive retrieval
        t0 = time.perf_counter()
        r_adapt, hops_used = retrieve_adaptive(query, g)
        t_adapt = (time.perf_counter() - t0) * 1e6
        
        seeds = find_seeds(query, g)
        
        print(f"  Seeds: {[s[0] for s in seeds]}")
        print(f"  Standard (fixed 4): {len(r_std)} nodes, {t_std:.0f}µs")
        print(f"  Adaptive ({hops_used} hops): {len(r_adapt)} nodes, {t_adapt:.0f}µs")
        
        # Generate Anchor context
        ctx = context_to_anchor(r_adapt, g, query, hops_used)
        print(f"\n  Anchor context ({len(ctx)} chars):")
        print(f"  {ctx[:600]}")
        if len(ctx) > 600:
            print(f"  ... [{len(ctx)-600} more chars]")
    
    # ── Test adaptive vs fixed max_hops ──
    print("\n── Adaptive vs Fixed: Deep Query Test ──")
    
    for depth in [2, 3, 4, 5]:
        successes_adapt = 0
        successes_fixed = 0
        hops_used_list = []
        
        for _ in range(30):
            g = generate_ilo_graph(200)
            paths = embed_paths(g, n_paths=4)
            matching = [(s,t,d) for s,t,d in paths if d == depth]
            if not matching: continue
            
            src, tgt, _ = matching[0]
            src_label = g.nodes.get(src, {}).get('label', src)
            query = f"Tell me about {src_label}"
            
            # Adaptive
            r_adapt, hops = retrieve_adaptive(query, g)
            hops_used_list.append(hops)
            found_adapt = any(n == tgt for n,_,_,_,_,_,_ in r_adapt)
            if found_adapt: successes_adapt += 1
            
            # Fixed (4 hops)
            r_fixed, _ = retrieve_adaptive(query, g, min_hops=4, max_hops=4)
            found_fixed = any(n == tgt for n,_,_,_,_,_,_ in r_fixed)
            if found_fixed: successes_fixed += 1
        
        avg_hops = statistics.mean(hops_used_list) if hops_used_list else 0
        print(f"  Depth {depth}: adaptive={successes_adapt}/30 ({successes_adapt*100//30}%) "
              f"fixed={successes_fixed}/30 ({successes_fixed*100//30}%) "
              f"avg_hops={avg_hops:.1f}")
    
    print(f"\n{'='*70}")
    print(f"TEST COMPLETE")
    print(f"{'='*70}")

if __name__ == '__main__':
    run()
