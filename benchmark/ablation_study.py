#!/usr/bin/env python3
"""
Ablation Study: What can we drop and still maintain coherency?

For each data category, we systematically vary the compression level
and measure how well the model can continue the session.

Parameters:
  A. Tool results: [drop, keep_summary, keep_full]
  B. Thinking blocks: [drop, keep_first_100, keep_full]
  C. Assistant text: [drop, keep_first_100, keep_full]
  D. Target truncation: [40, 80, 160, full]
  E. Tool grouping: [merge_consecutive, keep_all]
  F. Goal length: [50, 100, full]

We use N test sequences from the session and score via semantic similarity
to the ground truth continuation.
"""

import json
import os
import glob
import time
import urllib.request
import re

SERVER = "http://127.0.0.1:1234/v1/chat/completions"

# ── Load session ──
session_dir = os.path.expanduser("~/.pi/agent/sessions/--Users-femi-Documents-ilo--/")
files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")), key=os.path.getmtime)
session_path = files[-1]

with open(session_path) as f:
    entries = [json.loads(l) for l in f if l.strip()]


# Parse turns
def parse_intelligent(entries):
    """Parse with all data preserved for ablation."""
    turns = []
    current = None
    for e in entries:
        if e.get("type") != "message":
            continue
        msg = e.get("message", {})
        role = msg.get("role")
        blocks = msg.get("content", [])
        if not isinstance(blocks, list):
            blocks = [{"type": "text", "text": str(blocks)}]

        if role == "user":
            if current:
                turns.append(current)
            text = " ".join(
                b.get("text", "")
                for b in blocks
                if isinstance(b, dict) and b.get("type") == "text"
            )
            current = {
                "user": text,
                "tools": [],
                "results": [],
                "thinking": [],
                "assistant_text": [],
                "tool_sequence": [],  # tools in order for turn pairing
            }
        elif role == "assistant" and current is not None:
            for b in blocks:
                if b.get("type") == "toolCall":
                    args = b.get("arguments", {})
                    values = (
                        " | ".join(str(v) for v in args.values() if v)
                        if isinstance(args, dict)
                        else str(args)
                    )
                    current["tools"].append(
                        {"name": b.get("name", "?"), "target": values}
                    )
                elif b.get("type") == "thinking":
                    current["thinking"].append(b.get("thinking", ""))
                elif b.get("type") == "text":
                    current["assistant_text"].append(b.get("text", ""))
        elif role == "toolResult" and current is not None:
            text = " ".join(
                b.get("text", "")
                for b in blocks
                if isinstance(b, dict) and b.get("type") == "text"
            )
            current["results"].append(text)
    if current:
        turns.append(current)
    return turns


turns = parse_intelligent(entries)
print(f"Parsed {len(turns)} turns")

# ── Build test sequences ──
# Each sequence: context_turns[0:4] → prompt = turns[4].user → expected = turns[4]
test_sequences = []
for i in range(len(turns) - 6):
    ctx = turns[i : i + 5]
    if len(ctx[4]["tools"]) > 0 and len(ctx[4]["tools"]) < 20:
        test_sequences.append(
            {
                "context": ctx[:4],
                "prompt": ctx[4]["user"],
                "expected_tools": ctx[4]["tools"],
                "expected_assistant": ctx[4]["assistant_text"][0]
                if ctx[4]["assistant_text"]
                else "",
            }
        )

# Use a subset for time
test_sequences = test_sequences[:15]  # 15 test cases
print(f"Built {len(test_sequences)} test sequences")

# ── Format builder with all parameters ──


def build_context(turns, params):
    """
    Build context string with configurable parameters.

    params = {
        "results": "drop" | "first_line" | "full",
        "thinking": "drop" | "first_100" | "full",
        "assistant": "drop" | "first_100" | "full",
        "truncate": 40 | 80 | 160 | 9999,
        "grouping": "merge" | "keep",
        "goal_len": 50 | 100 | 9999,
    }
    """
    parts = []
    for i, t in enumerate(turns):
        # Goal
        goal = t["user"][: params["goal_len"]]
        parts.append(f"T{i + 1}: {goal}")

        # Tools with grouping + truncation
        if params["grouping"] == "merge":
            groups = []
            cur = None
            for tl in t["tools"]:
                key = (tl["name"], tl["target"][: params["truncate"]])
                if cur and cur["key"] == key:
                    cur["count"] += 1
                else:
                    if cur:
                        groups.append(cur)
                    cur = {
                        "key": key,
                        "name": tl["name"],
                        "target": tl["target"][: params["truncate"]],
                        "count": 1,
                    }
            if cur:
                groups.append(cur)
            for g in groups:
                c = f" ×{g['count']}" if g["count"] > 1 else ""
                parts.append(f"  {g['name']}{c}: {g['target']}")
        else:
            for tl in t["tools"]:
                parts.append(f"  {tl['name']}: {tl['target'][: params['truncate']]}")

        # Thinking
        if params["thinking"] == "full":
            for th in t["thinking"]:
                parts.append(f"  (thought: {th[:200]})")
        elif params["thinking"] == "first_100":
            for th in t["thinking"][:1]:
                parts.append(f"  (thought: {th[:100]})")

        # Assistant text
        if params["assistant"] == "full":
            for a in t["assistant_text"]:
                parts.append(f"  → {a[:200]}")
        elif params["assistant"] == "first_100":
            for a in t["assistant_text"][:1]:
                parts.append(f"  → {a[:100]}")

        # Results
        if params["results"] == "full":
            for r in t["results"]:
                parts.append(f"  result: {r[:200]}")
        elif params["results"] == "first_line":
            for r in t["results"]:
                first_line = r.split("\n")[0][:100] if r else ""
                if first_line:
                    parts.append(f"  result: {first_line}")

    return "\n".join(parts)


# ── Scoring ──


def call_llm(context, prompt):
    payload = {
        "model": "mtplx",
        "messages": [
            {"role": "system", "content": f"Previous turns:\n\n{context}"},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 400,
        "temperature": 0.3,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        SERVER, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
        return result["choices"][0]["message"].get("content", "").strip()[:1000]
    except Exception as e:
        return str(e)


def score_response(response, expected_tools, expected_assistant):
    """Score response against ground truth using keyword overlap."""
    r_lower = response.lower()
    score = 0

    # Tool type match
    exp_types = set(t["name"] for t in expected_tools)
    for et in exp_types:
        if et in r_lower:
            score += 2

    # Target match
    for t in expected_tools:
        target = t.get("target", "").lower()[:30]
        if target and target in r_lower:
            score += 1

    # Semantic intent (first 3 words of expected assistant)
    if expected_assistant:
        words = re.findall(r"\w{4,}", expected_assistant.lower())[:5]
        matched = sum(1 for w in words if w in r_lower)
        score += matched

    return min(score / max(len(exp_types), 1) * 5, 10)


# ── Ablation Study ──

# Baseline: the intent format (our current best)
BASELINE = {
    "results": "drop",
    "thinking": "drop",
    "assistant": "drop",
    "truncate": 55,
    "grouping": "merge",
    "goal_len": 100,
}

# Ablation: test each parameter independently
ablation_params = [
    # (name, param_overrides)
    ("INTENT (baseline)", {}),
    # Results
    ("+ results: first_line", {"results": "first_line"}),
    ("+ results: full", {"results": "full"}),
    # Thinking
    ("+ thinking: first_100", {"thinking": "first_100"}),
    ("+ thinking: full", {"thinking": "full"}),
    # Assistant text
    ("+ assistant: first_100", {"assistant": "first_100"}),
    ("+ assistant: full", {"assistant": "full"}),
    # Target truncation
    ("truncate: 40 chars", {"truncate": 40}),
    ("truncate: 80 chars", {"truncate": 80}),
    ("truncate: 160 chars", {"truncate": 160}),
    # Grouping
    ("no grouping (all tools)", {"grouping": "keep"}),
    # Goal length
    ("goal: 50 chars", {"goal_len": 50}),
    ("goal: full", {"goal_len": 9999}),
]

print("\n" + "=" * 75)
print("  ABLATION STUDY — What affects coherency?")
print("=" * 75)

results_log = []

for label, overrides in ablation_params:
    params = {**BASELINE, **overrides}

    # Build context and measure size
    total_context_size = 0
    total_score = 0
    test_count = 0

    for seq in test_sequences[:5]:  # 5 per condition
        context = build_context(seq["context"], params)
        total_context_size += len(context)

        response = call_llm(context, seq["prompt"])
        score = score_response(
            response, seq["expected_tools"], seq["expected_assistant"]
        )
        total_score += score
        test_count += 1
        time.sleep(0.3)

    avg_score = total_score / max(test_count, 1)
    avg_size = total_context_size / max(test_count, 1)
    eff = avg_score / max(avg_size, 1) * 1000

    results_log.append((label, avg_size, avg_score, eff))

    # Delta from baseline
    baseline_score = results_log[0][2]
    delta = avg_score - baseline_score
    delta_str = f"+{delta:.1f}" if delta > 0 else f"{delta:.1f}"

    print(
        f"\n  {label:30s} {avg_size:>8,.0f} chars  score={avg_score:.1f}  ({delta_str})  eff={eff:.2f}"
    )

# Sort by score
results_log.sort(key=lambda r: r[2], reverse=True)

print("\n" + "=" * 75)
print("  RANKED BY SCORE")
print("=" * 75)
print(f"\n  {'Condition':30s} {'Size':>8s} {'Score':>6s} {'Efficiency':>10s}")
print(f"  {'-' * 56}")
for label, size, score, eff in results_log:
    print(f"  {label:30s} {size:>8,.0f} {score:>5.1f}  {eff:>8.2f}")

print("\n" + "=" * 75)
print("  KEY QUESTIONS:")
print("  • Does adding results improve score enough to justify size?")
print("  • Does thinking add value or just noise?")
print("  • At what truncation length do returns diminish?")
print("  • Is grouping costing us accuracy?")
print("=" * 75)
