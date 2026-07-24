#!/usr/bin/env python3
"""Define what goes into the Anchor context block — query-adaptive content selection."""
import time, statistics
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph
from final_retrieval import retrieve, find_seeds, classify_intent, INTENT_EDGES, label_sim, DAMPING

DAMPING = 0.85

def select_context(results, graph, query, intent, max_chars=1200):
    """Select what goes into the Anchor context block.
    Only includes what the LLM needs to answer the query."""
    parts = []
    
    # ── 1. Session header (compact) ──
    parts.append(f"@session [intent: {intent}]")
    parts.append("")
    
    # ── 2. Seed entities (the query match) ──
    seeds = [(nid, score, label, props, ntype) 
             for nid, score, depth, path, label, props, ntype in results if depth == 0]
    
    if seeds:
        parts.append("# Focus:")
        for nid, score, label, props, ntype in seeds[:3]:
            safe_id = label.lower().replace(" ", "-").replace("_", "-")[:25] if label else nid[:15]
            subtype = graph.nodes.get(nid, {}).get('subtype', ntype)
            conf = props.get('confidence', '')
            parts.append(f"{safe_id}:{subtype}  [conf: {conf}]")
        parts.append("")
    
    # ── 3. DIRECT ANSWER (entities matching query intent) ──
    # For "project" intent: show entities with subtype="project" connected to seeds
    if intent in ('project', 'membership', 'employment'):
        parts.append("# Projects/Works On:")
        shown = set()
        for nid, score, depth, path, label, props, ntype in results:
            if depth == 0: continue
            nd = graph.nodes.get(nid, {})
            if nd.get('subtype') != 'project': continue
            if label in shown: continue
            shown.add(label)
            # Show what seed connects to this
            connected_to = _find_connection_label(graph, nid, [s[0] for s in seeds])
            parts.append(f"  {label}  (via {connected_to})")
            for k in ['status']:
                if k in props: parts.append(f"    [{k}: {props[k]}]")
        
        if not shown:
            parts.append("  (no projects found)")
        parts.append("")
    
    elif intent in ('dependency', 'requirement'):
        parts.append("# Dependencies:")
        shown = set()
        for nid, score, depth, path, label, props, ntype in results:
            if depth == 0: continue
            nd = graph.nodes.get(nid, {})
            if nd.get('subtype') not in ('tool', 'language'): continue
            if label in shown: continue
            shown.add(label)
            src = _find_connection_label(graph, nid, [s[0] for s in seeds])
            parts.append(f"  {label}  depends on {src}")
        
        if not shown:
            parts.append("  (no dependencies found)")
        parts.append("")
    
    elif intent in ('evidence', 'support'):
        parts.append("# Evidence:")
        for nid, score, depth, path, label, props, ntype in results:
            if ntype != 'claim': continue
            if depth == 0: continue
            parts.append(f"  [provenance: {props.get('provenance', 'N/A')}]")
            parts.append(f"  [confidence: {props.get('confidence', 'N/A')}]")
        parts.append("")
    
    elif intent in ('reference', 'mention'):
        # Show directly related entities
        parts.append("# Related:")
        shown = set()
        for nid, score, depth, path, label, props, ntype in results:
            if depth == 0: continue
            if ntype != 'entity': continue
            if label in shown: continue
            shown.add(label)
            subtype = graph.nodes.get(nid, {}).get('subtype', '')
            parts.append(f"  {label}:{subtype}  [rel: {score:.2f}]")
        parts.append("")
    
    # Generic cases
    else:
        parts.append("# Related entities:")
        shown = set()
        for nid, score, depth, path, label, props, ntype in results[:15]:
            if depth == 0: continue
            if label in shown: continue
            shown.add(label)
            subtype = graph.nodes.get(nid, {}).get('subtype', '') or ntype
            parts.append(f"  {label}:{subtype}  [rel: {score:.2f}]")
        parts.append("")
    
    # ── 4. Evidence paths (compact, max 5) ──
    paths_output = []
    for nid, score, depth, path, label, props, ntype in results:
        if depth < 1 or depth > 5: continue
        if len(path) < 2: continue
        if len(paths_output) >= 5: break
        
        # Build a path string using labels
        path_labels = []
        for p in path:
            p_node = graph.nodes.get(p, {})
            path_labels.append(p_node.get('label', p)[:20])
        path_str = " → ".join(path_labels)
        
        # Determine link type between penultimate and final node
        if len(path) >= 2:
            lt = _find_link_type(graph, path[-2], nid)
            paths_output.append(f"  {path_str}  [{lt}]")
    
    if paths_output:
        parts.append("# Evidence path:")
        for p in paths_output:
            parts.append(p)
        parts.append("")
    
    # ── 5. Minimal supporting turns (max 3) ──
    turns = [(nid, score, depth, label, props)
             for nid, score, depth, path, label, props, ntype in results
             if ntype == 'turn' and depth > 0]
    
    if turns and len(parts) < 30:  # only if we have space
        parts.append("# Recent context:")
        turns.sort(key=lambda x: -x[1])
        for nid, score, depth, label, props in turns[:3]:
            # What entities does this turn connect?
            connected = []
            for lid in graph.out.get(nid, []):
                if lid in graph.links:
                    frm, to, ltype, w, age = graph.links[lid]
                    tn = graph.nodes.get(to, {})
                    connected.append(tn.get('label', to)[:15])
            conn_str = ", ".join(connected[:3])
            parts.append(f"  {label}: {conn_str}")
        parts.append("")
    
    text = "\n".join(parts)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n... [truncated]"
    return text


def _find_connection_label(graph, target_id, seed_ids):
    """Find which seed connects to this target."""
    for sid in seed_ids:
        for lid in graph.out.get(sid, []):
            if lid in graph.links:
                frm, to, ltype, w, age = graph.links[lid]
                if to == target_id:
                    tn = graph.nodes.get(target_id, {})
                    sn = graph.nodes.get(sid, {})
                    return sn.get('label', sid)[:20]
    return "unknown"

def _find_link_type(graph, from_id, to_id):
    for lid in graph.out.get(from_id, []):
        if lid in graph.links:
            frm, to, ltype, w, age = graph.links[lid]
            if to == to_id: return ltype
    for lid in graph.inn.get(from_id, []):
        if lid in graph.links:
            frm, to, ltype, w, age = graph.links[lid]
            if frm == to_id: return ltype
    return "ref"


def run():
    print("="*70)
    print("ANCHOR CONTENT — Query-Adaptive Context Selection")
    print("="*70)
    
    test_cases = [
        ("What projects does Alice work on?", "project"),
        ("What depends on Candle?", "dependency"),
        ("Tell me about Alice", "reference"),
        ("Tell me about Alice and Bob", "reference"),
        ("hebbian learning spreading activation", "reference"),
        ("What evidence supports Hebbian Learning?", "evidence"),
    ]
    
    for query, intent in test_cases:
        print(f"\n── Query: {query} ──")
        print(f"  Intent: {intent}")
        g = generate_ilo_graph(200)
        
        # Run retrieval
        results = retrieve(query, g)
        
        # Select context
        ctx = select_context(results, g, query, intent)
        
        print(f"\n{ctx}")
        print(f"\n  Total: {len(ctx)} chars ({len(ctx)//4} est. tokens)")
        print(f"  Lines: {len(ctx.splitlines())}")

if __name__ == '__main__':
    run()
