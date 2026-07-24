#!/usr/bin/env python3
"""ILO Retrieval & Learning Parameters — Catalogue with analysis."""
import math, statistics, random
from data_driven_test import *
from realistic_graph_canonical import generate_ilo_graph, embed_paths, spread, ACT_THRESHOLD

random.seed(42)

def describe_param(name, domain, default, rationale, sensitivity, fix_status):
    return {'name':name,'domain':domain,'default':default,'rationale':rationale,
            'sensitivity':sensitivity,'fix_status':fix_status}

params = [
    # ── PROPAGATION ──
    describe_param("max_hops", "1-10 (int)", 4,
        "Maximum number of propagation iterations. Higher = deeper answers reachable but more noise.",
        "HIGH: depth-5+ answers never found at 4 hops. This is the binding constraint.",
        "needs_improvement"),
    describe_param("activation_threshold", "0.001-0.05 (float)", 0.005,
        "Minimum activation energy for a node to remain in the active set. Lower = more noise but deeper reach.",
        "MODERATE: lowering to 0.001 may help depth-5 but adds noise nodes.",
        "acceptable"),
    describe_param("backward_discount", "0.0-1.0 (float)", 0.5,
        "Multiplier for energy flowing along incoming (reverse-direction) edges. 1.0 = symmetric.",
        "LOW: tested 0.3-1.0, minimal effect on deep retrieval.",
        "acceptable"),

    # ── INHIBITION ──
    describe_param("inhibit_m", "1-20 (int)", 4,
        "Number of top-activated nodes that survive lateral inhibition per hop. Higher = more context but more noise.",
        "HIGH: determines whether deep answers survive alongside shallow distractors.",
        "tuning_needed"),
    describe_param("inhibit_beta", "0.0-1.0 (float)", 0.3,
        "Strength of lateral inhibition. 0.0 = no inhibition, 1.0 = aggressive.",
        "HIGH: together with inhibit_m this determines the precision/recall tradeoff.",
        "tuning_needed"),
    describe_param("depth_protect", "True/False (bool)", True,
        "If True, nodes at depth >= 3 get reduced inhibition (depth_factor multiplier).",
        "MODERATE: protects deep answers but may also protect deep noise.",
        "acceptable"),
    describe_param("depth_factor", "0.0-1.0 (float)", 0.3,
        "Inhibition multiplier for protected (deep) nodes. 0.0 = no inhibition for deep, 1.0 = normal.",
        "MODERATE: 0.3 found to be good balance, but untested against varies graph structures.",
        "acceptable"),

    # ── TEMPORAL ──
    describe_param("temporal_decay", "True/False (bool)", True,
        "If True, older links carry less energy during propagation.",
        "LOW: affects which turn is prioritised, not whether answer is found.",
        "acceptable"),
    describe_param("temporal_half_life", "100-100000 (int, time units)", 10000,
        "Time units after which a link carries 50% energy. Shorter = more recency bias.",
        "LOW: affects ranking, not retrieval success. Tune per domain.",
        "acceptable"),

    # ── SEED FINDING ──
    describe_param("max_seeds", "1-20 (int)", 5,
        "Maximum number of seed nodes to activate from a query.",
        "MODERATE: more seeds = more paths explored, but more noise.",
        "acceptable"),
    describe_param("exact_match_weight", "0.5-1.0 (float)", 1.0,
        "Weight multiplier for exact label matches.",
        "LOW: exact matches are rare and reliable.",
        "acceptable"),
    describe_param("fuzzy_match_weight", "0.3-1.0 (float)", 0.7,
        "Weight multiplier for substring/vector matches.",
        "LOW: fuzzy matches are secondary to exact.",
        "acceptable"),

    # ── CONTEXT ASSEMBLY ──
    describe_param("token_budget", "256-8192 (int, chars)", 2048,
        "Maximum characters in the assembled context block.",
        "LOW: affects how many nodes appear, not which are found.",
        "acceptable"),
    describe_param("include_paths", "True/False (bool)", True,
        "If True, include evidence paths (trace of how each node was reached).",
        "LOW: presentation only, doesn't affect retrieval.",
        "acceptable"),

    # ── FIXES (from stress test) ──
    describe_param("use_fired_set", "True/False (bool)", True,
        "Prevents re-activating nodes that have already propagated. Eliminates infinite cycles.",
        "CRITICAL: without this, propagation never terminates on cyclic graphs.",
        "implemented"),
    describe_param("in_degree_atten", "0.0-1.0 (float)", 0.0,
        "Attenuates activation of hub nodes by dividing by (1 + sqrt(in_degree) * factor). Higher = less hub dominance.",
        "HIGH: addresses hub domination problem. Currently DISABLED (0.0).",
        "needs_implementation"),
    describe_param("recursive_seeding", "0-5 (int, depth to fork at)", 0,
        "If > 0, at this depth fork a fresh propagation from the best node. Resets energy budget.",
        "HIGH: most promising fix for depth-5+ retrieval failure. Currently DISABLED (0).",
        "needs_implementation"),

    # ── LEARNING ──
    describe_param("hebbian_eta", "0.01-0.5 (float)", 0.1,
        "Learning rate for Hebbian weight strengthening.",
        "HIGH: determines how fast connections form. Too fast = oscillation, too slow = no learning.",
        "tuning_needed"),
    describe_param("decay_lambda", "0.0001-0.01 (float)", 0.001,
        "Per-turn global decay rate on all link weights.",
        "HIGH: determines forgetting rate. Must balance with hebbian_eta.",
        "tuning_needed"),
    describe_param("oja_coeff", "0.0-0.1 (float)", 0.0,
        "Oja's rule coefficient. Prevents weight saturation by adding -w² term. 0 = disabled.",
        "HIGH: prevents all weights from converging to 1.0. Currently DISABLED (0.0).",
        "needs_implementation"),
    describe_param("neg_fb_eta", "0.0-0.1 (float)", 0.02,
        "Strength of negative feedback for retrieved-but-unused nodes.",
        "MODERATE: helps prune noise, but too strong = destroys useful exploratory paths.",
        "acceptable"),
    describe_param("conf_gated_decay", "True/False (bool)", False,
        "If True, high-confidence nodes decay more slowly than low-confidence nodes.",
        "MODERATE: helps prevent catastrophic forgetting of important knowledge. Currently DISABLED.",
        "needs_implementation"),
    describe_param("consolidation_interval", "10-500 (int, turns)", 50,
        "How often to check for consolidation (compressing dense clusters into semantic nodes).",
        "LOW: periodic maintenance, not latency-critical.",
        "acceptable"),
    describe_param("hub_threshold", "1.0-20.0 (float)", 5.0,
        "Total incident LINK.weight above which a node is considered a hub for consolidation.",
        "LOW: consolidation tuning, not retrieval-critical.",
        "acceptable"),
]

# ── GROUP ANALYSIS ──
print("="*70)
print("ILO RETRIEVAL & LEARNING PARAMETERS — Complete Catalogue")
print("="*70)

groups = {}
for p in params:
    g = p['sensitivity']
    groups.setdefault(g, []).append(p)

for g in ['CRITICAL','HIGH','MODERATE','LOW']:
    if g in groups:
        print(f"\n── {g} SENSITIVITY ──")
        for p in groups[g]:
            status_icon = {"implemented":"✅","needs_implementation":"❌",
                          "tuning_needed":"⚙","acceptable":"✓","needs_improvement":"⚠"}
            icon = status_icon.get(p['fix_status'],"❓")
            print(f"  {icon} {p['name']:<25} default={p['default']:<10} domain={p['domain']:<25}")
            print(f"    {p['rationale']}")

print(f"\n{'='*70}")
print(f"PARAMETER COUNT: {len(params)} total")
for s in ['CRITICAL','HIGH','MODERATE','LOW']:
    c = len(groups.get(s,[]))
    print(f"  {s}: {c}")
for s in ['implemented','needs_implementation','tuning_needed','acceptable','needs_improvement']:
    c = sum(1 for p in params if p['fix_status']==s)
    print(f"  {s}: {c}")

print(f"\n── PARAMETERS THAT NEED WORK ──")
for p in params:
    if p['fix_status'] in ['needs_implementation','needs_improvement']:
        print(f"  ❌ {p['name']}: {p['rationale']}")
print(f"\n── PARAMETERS THAT NEED TUNING ──")
for p in params:
    if p['fix_status'] == 'tuning_needed':
        print(f"  ⚙ {p['name']}: {p['rationale']}")
