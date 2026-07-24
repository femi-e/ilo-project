#!/usr/bin/env python3
"""Test context window budgets against real queries on the simulated graph.
Measures what fits at each budget level, what gets cut, and verifies the
sliding window + graph context combination works."""
from realistic_sim_graph import build
from final_retrieval import retrieve, find_seeds, classify_intent, INTENT_EDGES

# Reuse Anchor assembly from anchor_content.py
from anchor_content import select_context, _find_connection_label, _find_link_type

def simulate_sliding_window(query, graph, recent_turns, max_chars=8000):
    """Simulate the full context: graph retrieval + recent turns.
    Returns the assembled text and what was excluded."""
    
    # 1. Graph retrieval
    intent = classify_intent(query)
    results = retrieve(query, graph)
    graph_ctx = select_context(results, graph, query, intent, max_chars=max_chars)
    
    # 2. Recent conversation turns
    turn_entries = []
    for i, turn_text in enumerate(recent_turns):
        entry = f"  [{i+1}] user: {turn_text}"
        turn_entries.append(entry)
    turns_ctx = "# Recent conversation:\n" + "\n".join(turn_entries)
    
    # 3. Full context with budget
    system = "@session [intent: " + intent + "]\n"
    
    full = system + graph_ctx + "\n\n" + turns_ctx
    
    # 4. What gets excluded
    if len(full) > max_chars:
        excluded_chars = len(full) - max_chars
        full = full[:max_chars] + "\n... [truncated]"
    else:
        excluded_chars = 0
    
    return full, excluded_chars, len(graph_ctx), len(turns_ctx)

def run():
    print("=" * 70)
    print("CONTEXT BUDGET STRESS TEST — Realistic Simulated Graph")
    print("=" * 70)
    
    g = build()
    
    # ── Test 1: Graph context at different budgets ──
    print("\n── TEST 1: Graph Context Size by Budget ──")
    
    queries = [
        "What projects does Alice work on?",
        "What depends on ILO?",
        "Tell me about Alice and Bob",
        "What does Nova depend on?",
    ]
    
    for budget in [2000, 4000, 8000]:
        print(f"\n  Budget: {budget} chars")
        print(f"  {'Query':<40} {'Used':>8} {'% of budget':>12} {'Entities':>9}")
        print(f"  {'-'*70}")
        
        for query in queries:
            intent = classify_intent(query)
            results = retrieve(query, g)
            ctx = select_context(results, g, query, intent, max_chars=budget)
            used = len(ctx)
            pct = used / budget * 100 if budget > 0 else 0
            # Count entities mentioned
            n_entities = sum(1 for line in ctx.split('\n') if ':' in line and line.strip()[0].isalpha() and not line.strip().startswith('#'))
            status = "✅" if used <= budget else "❌"
            print(f"  {status} {query:<38} {used:>6} {pct:>10.0f}% {n_entities:>8}")
    
    # ── Test 2: Sliding window simulation ──
    print("\n── TEST 2: Sliding Window + Graph Context ──")
    
    # Simulate a conversation
    conversation = [
        "Hey, what projects is Alice working on?",
        "Can you tell me more about ILO?",
        "What does ILO depend on?",
        "Does Bob work on ILO too?",
        "What about Nova?",
        "Is that related to Atlas?",
        "Who's managing all these projects?",
        "What does Frank think about the progress?",
        "How's the Zephyr project going?",
        "What does Zephyr depend on?",
        "Is Eve working on that?",
        "Tell me about the Atlas data platform",
        "Does Atlas use Kafka?",
        "Who's working on Nova with Dave?",
        "What's the relationship between all these projects?",
    ]
    
    # Test different window sizes
    for window_size in [5, 10, 15]:
        # The current query comes from the last turn
        current_query = conversation[-1]
        
        # Recent turns (sliding window)
        if len(conversation) >= window_size:
            recent = conversation[-window_size:-1]  # exclude current
        else:
            recent = conversation[:-1]
        
        # Build context
        max_budget = 8000
        intent = classify_intent(current_query)
        results = retrieve(current_query, g)
        graph_ctx = select_context(results, g, current_query, intent, max_chars=4000)
        
        # Build turn section
        turn_lines = []
        for i, turn_text in enumerate(recent):
            idx = len(conversation) - window_size + i + 1
            turn_lines.append(f"  [{idx}] user: {turn_text}")
        turns_text = "# Recent:\n" + "\n".join(turn_lines)
        
        full = f"@session [intent: {intent}]\n" + graph_ctx + "\n\n" + turns_text
        
        if len(full) > max_budget:
            full = full[:max_budget] + "\n... [truncated]"
        
        print(f"\n  Window: {window_size} recent turns, Budget: {max_budget} chars")
        print(f"  Query: \"{current_query}\"")
        print(f"  Graph ctx: {len(graph_ctx)} chars  Turns: {len(turns_text)} chars  Total: {len(full)} chars")
        print(f"  Fits in budget: {'✅' if len(full) <= max_budget else '❌'}")
        
        # Show what the LLM would see (first 5 lines + last 3)
        lines = full.split('\n')
        print(f"  First lines:")
        for l in lines[:5]:
            print(f"    {l[:70]}")
        print(f"  Recent turns shown:")
        for l in lines[-3:]:
            print(f"    {l[:70]}")
    
    # ── Test 3: Budget priority (graph vs turns) ──
    print("\n── TEST 3: Budget Priority ──")
    print("  Priority: Graph context first, turns fill remainder")
    print(f"  {'Budget':>8} {'Graph first':>15} {'Then turns':>12} {'Total':>8} {'Status':>8}")
    print(f"  {'-'*51}")
    
    for budget in [2000, 3000, 5000, 8000]:
        # Graph gets 70% of budget, turns get 30%
        graph_budget = int(budget * 0.7)
        turn_budget = budget - graph_budget
        
        query = "What does ILO depend on?"
        intent = classify_intent(query)
        results = retrieve(query, g)
        ctx = select_context(results, g, query, intent, max_chars=graph_budget)
        
        # Build a small turn section
        sample_turns = [
            "  [1] user: Tell me about ILO",
            "  [2] user: What does it depend on?",
        ]
        turn_text = "# Recent:\n" + "\n".join(sample_turns)
        
        full = f"@session [intent: {intent}]\n" + ctx + "\n\n" + turn_text
        fits = "✅" if len(full) <= budget else f"❌ (by {len(full)-budget})"
        
        print(f"  {budget:>8} {graph_budget:>10}ch {turn_budget:>10}ch {len(full):>8} {fits:>8}")

    print(f"\n{'='*70}")
    print(f"BUDGET TEST COMPLETE")
    print(f"{'='*70}")

if __name__ == '__main__':
    run()
