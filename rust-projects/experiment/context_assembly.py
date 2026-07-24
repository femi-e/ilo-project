#!/usr/bin/env python3
"""Redesigned context assembly — clean, prioritised, path-grouped Anchor output."""
import math, random, time, re
from collections import defaultdict
from realistic_graph_canonical import generate_ilo_graph
from final_retrieval import retrieve, find_seeds, classify_intent, INTENT_EDGES

DAMPING = 0.85

# ── ANCHOR CONTEXT ASSEMBLY — REDESIGNED ──

def assemble_context(results, graph, query, intent, max_chars=1500):
    """Produce Anchor-format context from retrieval results.
    Design:
      1. Session header (metadata)
      2. Seed entities (what was asked about)
      3. Key relationships (entity→entity connections, grouped by type)
      4. Supporting evidence (relevant claims and turns, limited)
      5. Path chains (how everything connects)
    """
    parts = []
    
    # ── 1. Session header ──
    parts.append("@_session")
    parts.append(f"  [query: {query}]")
    parts.append(f"  [intent: {intent}]")
    # Count by type
    types = defaultdict(int)
    for _, _, _, _, _, _, ntype in results:
        types[ntype] += 1
    parts.append(f"  [entities: {types.get('entity',0)}  turns: {types.get('turn',0)}  claims: {types.get('claim',0)}]")
    parts.append("")
    
    # ── 2. Seed entities (depth=0, the things directly matched to query) ──
    seeds = [(nid, score, label, props, ntype) 
             for nid, score, depth, path, label, props, ntype in results if depth == 0]
    
    if seeds:
        parts.append("# Matched entities:")
        for nid, score, label, props, ntype in seeds[:5]:
            safe_id = label.lower().replace(" ", "-").replace("_", "-")[:30]
            if not safe_id: safe_id = nid[:20]
            subtype = graph.nodes.get(nid, {}).get('subtype', ntype)
            parts.append(f"{safe_id}:{subtype}")
            # Show confidence and key properties
            for k in ['confidence','status']:
                if k in props:
                    parts.append(f"  [{k}: {props[k]}]")
        
        parts.append("")
    
    # ── 3. Entity relationships (entity→entity, grouped by link type) ──
    entity_links = []  # (from_label, to_label, link_type, weight)
    entity_set = set()
    
    for nid, score, depth, path, label, props, ntype in results:
        if ntype != 'entity': continue
        if depth == 0: continue  # skip seeds, already shown
        if len(path) < 2: continue
        
        # Find the direct parent in the path
        parent_id = path[-2] if len(path) >= 2 else None
        if not parent_id: continue
        
        parent_node = graph.nodes.get(parent_id)
        parent_label = parent_node.get('label', parent_id) if parent_node else parent_id
        link_type = _find_link_type(graph, parent_id, nid)
        
        current_label = label or nid
        entity_set.add(current_label)
        
        # Show the relationship
        if link_type == 'ref':
            # ref edges are implicit — the LLM sees the connection
            entity_links.append((parent_label, current_label, link_type, score, props))
        elif link_type in ('has', 'dep', 'con', 'evidence'):
            # These are explicit relationships worth showing
            entity_links.append((parent_label, current_label, link_type, score, props))
    
    # Only show entities that have meaningful relationships
    if entity_links:
        parts.append("# Relationships:")
        
        # Group by link type, show most interesting first
        link_priority = {'has': 0, 'dep': 1, 'evidence': 2, 'con': 3, 'ref': 4}
        entity_links.sort(key=lambda x: (link_priority.get(x[2], 9), -x[3]))
        
        shown_pairs = set()
        for parent, current, ltype, score, props in entity_links[:15]:
            pair_key = f"{parent}→{current}"
            if pair_key in shown_pairs: continue
            shown_pairs.add(pair_key)
            
            current_clean = current[:30]
            parent_clean = parent[:30]
            
            if ltype == 'has':
                parts.append(f"  {current_clean} (via {parent_clean})")
            elif ltype == 'dep':
                parts.append(f"  {current_clean} depends on {parent_clean}")
            elif ltype == 'evidence':
                parts.append(f"  {current_clean} supports {parent_clean}")
            elif ltype == 'con':
                parts.append(f"  {current_clean} contradicts {parent_clean}")
            else:
                parts.append(f"  {current_clean} (related to {parent_clean})")
        
        parts.append("")
    
    # ── 4. Supporting evidence (best turns and claims) ──
    # Turns
    turns = [(nid, score, depth, label, props) 
             for nid, score, depth, path, label, props, ntype in results 
             if ntype == 'turn' and depth > 0]
    
    if turns:
        parts.append("# Conversation turns:")
        turns.sort(key=lambda x: -x[1])
        for nid, score, depth, label, props in turns[:5]:
            # Show what entities this turn connects to
            connected_to = []
            for lid in graph.out.get(nid, []):
                if lid in graph.links:
                    frm, to, ltype, w, age = graph.links[lid]
                    to_node = graph.nodes.get(to, {})
                    to_label = to_node.get('label', to)[:20]
                    connected_to.append(to_label)
            connected_str = ", ".join(connected_to[:3]) if connected_to else ""
            parts.append(f"  {label}: {connected_str} [relevance: {score:.2f}]")
        parts.append("")
    
    # Claims
    claims = [(nid, score, depth, label, props) 
              for nid, score, depth, path, label, props, ntype in results 
              if ntype == 'claim' and depth > 0]
    
    if claims:
        parts.append("# Facts:")
        claims.sort(key=lambda x: -x[1])
        for nid, score, depth, label, props in claims[:5]:
            provenance = props.get('provenance', '')
            type_sub = props.get('type_sub', '')
            parts.append(f"  [confidence: {props.get('confidence', 'N/A')}]")
            parts.append(f"  [type: {type_sub}]" if type_sub else "")
            parts.append(f"  # from {provenance}" if provenance else "")
        parts.append("")
    
    # ── 5. Quick reference (all entities found, compact) ──
    entities = [(nid, score, depth, label, props, ntype) 
                for nid, score, depth, path, label, props, ntype in results 
                if ntype == 'entity' and depth > 0]
    
    if entities:
        parts.append("# Other entities in context:")
        entities.sort(key=lambda x: -x[1])
        for nid, score, depth, label, props, ntype in entities[:10]:
            subtype = graph.nodes.get(nid, {}).get('subtype', '')
            parts.append(f"  {label or nid[:20]}:{subtype} [confidence: {props.get('confidence','N/A')}]")
        parts.append("")
    
    # Assemble
    text = "\n".join(parts)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n--- [context truncated] ---"
    
    return text


def _find_link_type(graph, from_id, to_id):
    """Find the link type between two nodes."""
    for lid in graph.out.get(from_id, []):
        if lid in graph.links:
            frm, to, ltype, w, age = graph.links[lid]
            if to == to_id: return ltype
    for lid in graph.inn.get(from_id, []):
        if lid in graph.links:
            frm, to, ltype, w, age = graph.links[lid]
            if frm == to_id: return ltype
    for lid in graph.out.get(to_id, []):
        if lid in graph.links:
            frm, to, ltype, w, age = graph.links[lid]
            if to == from_id: return ltype
    return "ref"


def run():
    print("="*70)
    print("REDESIGNED CONTEXT ASSEMBLY — Test")
    print("="*70)
    
    queries = [
        "What projects does Alice work on?",
        "What depends on Candle?",
        "Tell me about Alice and Bob",
        "hebbian learning spreading activation",
    ]
    
    for query in queries:
        print(f"\n── Query: {query} ──")
        intent = classify_intent(query)
        g = generate_ilo_graph(200)
        results = retrieve(query, g)
        
        ctx = assemble_context(results, g, query, intent)
        print(f"\n{ctx}")
        print(f"\n  Context length: {len(ctx)} chars")
        
        # Quality check
        lines = ctx.split("\n")
        problems = []
        if any(len(l) > 80 for l in lines if l and not l.startswith("#")):
            problems.append("line > 80 chars")
        if sum(1 for l in lines if 'ref @' in l) > 30:
            problems.append("too many ref entries")
        if len(ctx) > 2000:
            problems.append("over 2000 chars")
        
        if problems:
            print(f"  Issues: {', '.join(problems)}")
        else:
            print(f"  ✅ Clean output")

    # ── Token efficiency comparison ──
    print("\n── Token Efficiency (estimated, ~4 chars/token) ──")
    for query in queries:
        g = generate_ilo_graph(200)
        results = retrieve(query, g)
        # Old-style: flat list of labels
        old_style = "\n".join([f"{lbl} ({sd:.2f})" for _,sd,_,_,lbl,_,_ in results[:50]])
        old_tokens = len(old_style) / 4
        # New Anchor style
        intent = classify_intent(query)
        new_style = assemble_context(results, g, query, intent)
        new_tokens = len(new_style) / 4
        print(f"  {query[:40]:<42} Old: {old_tokens:.0f} tok  New: {new_tokens:.0f} tok  "
              f"Saved: {old_tokens - new_tokens:.0f} tok ({(old_tokens-new_tokens)/old_tokens*100:.0f}%)")

if __name__ == '__main__':
    run()
