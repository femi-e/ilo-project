#!/usr/bin/env python3
"""
Five-Dimension Preservation Score.
Tests a format once, measures across 5 dimensions.
Baseline is cached — only retest when format changes.
"""

import json
import os
import glob
import time
import urllib.request
import re
import hashlib

SERVER = "http://127.0.0.1:1234/v1/chat/completions"
CACHE_FILE = os.path.join(os.path.dirname(__file__), "baseline_cache.json")

# ── Session parsing ──
session_dir = os.path.expanduser("~/.pi/agent/sessions/--Users-femi-Documents-ilo--/")
files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")), key=os.path.getmtime)
session_path = files[-1]

with open(session_path) as f:
    entries = [json.loads(l) for l in f if l.strip()]


def parse_turns():
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
            current = {"user": text, "tools": [], "results": [], "assistant_text": []}
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


turns = parse_turns()
print(f"Session: {len(turns)} turns")

# Build test sequences (context=4 turns, target=5th turn's ground truth)
seqs = []
for i in range(len(turns) - 6):
    ctx = turns[i : i + 5]
    tl = ctx[4]["tools"]
    if len(tl) > 0 and len(tl) < 15:
        seqs.append(
            {
                "ctx": ctx[:4],
                "prompt": ctx[4]["user"],
                "gt_tools": tl,
                "gt_text": ctx[4]["assistant_text"][0]
                if ctx[4]["assistant_text"]
                else "",
            }
        )

# Use fixed seed for reproducibility
import random

random.Random(42).shuffle(seqs)
seqs = seqs[:12]
print(f"Test sequences: {len(seqs)}")

# ── Format builders ──


def build_intent_format(turns_list):
    """The intent format (baseline)."""
    parts = []
    for i, t in enumerate(turns_list):
        parts.append(f"T{i + 1}: {t['user'][:100]}")
        grps = []
        cur = None
        for tl in t["tools"]:
            key = (tl["name"], tl["target"][:55])
            if cur and cur["key"] == key:
                cur["count"] += 1
            else:
                if cur:
                    grps.append(cur)
                cur = {
                    "key": key,
                    "name": tl["name"],
                    "target": tl["target"][:55],
                    "count": 1,
                }
        if cur:
            grps.append(cur)
        for g in grps:
            c = f" ×{g['count']}" if g["count"] > 1 else ""
            parts.append(f"  {g['name']}{c}: {g['target']}")
    return "\n".join(parts)


def build_optimal_format(turns_list):
    """Optimal format: 40-char truncation + first-line results."""
    parts = []
    for i, t in enumerate(turns_list):
        parts.append(f"T{i + 1}: {t['user']}")
        grps = []
        cur = None
        for tl in t["tools"]:
            key = (tl["name"], tl["target"][:40])
            if cur and cur["key"] == key:
                cur["count"] += 1
            else:
                if cur:
                    grps.append(cur)
                cur = {
                    "key": key,
                    "name": tl["name"],
                    "target": tl["target"][:40],
                    "count": 1,
                }
        if cur:
            grps.append(cur)
        for g in grps:
            c = f" ×{g['count']}" if g["count"] > 1 else ""
            parts.append(f"  {g['name']}{c}: {g['target']}")
        if t["results"]:
            for r in t["results"][:3]:
                fl = r.split("\n")[0][:80] if r else ""
                if fl:
                    parts.append(f"  → {fl}")
    return "\n".join(parts)


# ── 5-dimension scorer ──


def score_response(response, gt_tools, gt_text):
    """Score a response across 5 dimensions. Each 0-3."""

    rl = response.lower()
    tool_names = set(t["name"] for t in gt_tools)
    tool_targets = [
        t.get("target", "").lower()[:30] for t in gt_tools if t.get("target")
    ]

    # 1. Tool Recall (0-3): Did the model remember which tools?
    found_tools = sum(1 for t in tool_names if t in rl)
    tool_score = min(found_tools / max(len(tool_names), 1) * 3, 3)

    # 2. Target Accuracy (0-3): Did the model remember what was acted on?
    found_targets = sum(1 for tg in tool_targets if tg and tg in rl)
    target_score = (
        min(found_targets / max(len(tool_targets), 1) * 3, 3) if tool_targets else 1.5
    )

    # 3. Goal Continuity (0-3): Did the model understand the intent?
    goal_words = set()
    for t in gt_tools:
        if t["name"] in ("bash", "read", "write", "edit"):
            tg = t.get("target", "").lower().split("/")[-1].split(".")[0]
            if len(tg) > 3:
                goal_words.add(tg)
    found_goal = sum(1 for w in goal_words if w in rl) if goal_words else 1
    goal_score = min(found_goal / max(len(goal_words), 1) * 3, 3) if goal_words else 1.5

    # 4. Decision Recall (0-3): Did the model remember why?
    if gt_text:
        key_phrases = re.findall(r"\b\w{5,}\b", gt_text.lower())
        key_phrases = [
            w
            for w in key_phrases
            if w
            not in (
                "there",
                "their",
                "about",
                "which",
                "would",
                "should",
                "could",
                "after",
                "before",
                "other",
                "these",
                "those",
            )
        ][:8]
        found_phrases = sum(1 for p in key_phrases if p in rl) if key_phrases else 0
        decision_score = (
            min(found_phrases / max(len(key_phrases), 1) * 3, 3) if key_phrases else 1.5
        )
    else:
        decision_score = 1.5

    # 5. Temporal Order (0-3): Does the response reference sequence?
    has_sequence = any(
        p in rl
        for p in ["first", "then", "next", "after", "finally", "step", "1.", "2."]
    )
    order_score = 2.5 if has_sequence else 1.0

    return {
        "tool_recall": round(tool_score, 1),
        "target_accuracy": round(target_score, 1),
        "goal_continuity": round(goal_score, 1),
        "decision_recall": round(decision_score, 1),
        "temporal_order": round(order_score, 1),
    }


def composite_score(dims):
    """Combine 5 dimensions into 0-10."""
    raw = sum(dims.values())
    return round(raw / 15 * 10, 1)


# ── LLM call ──


def call_llm(context, prompt):
    payload = {
        "model": "mtplx",
        "messages": [
            {"role": "system", "content": f"Session:\n\n{context}"},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 400,
        "temperature": 0.3,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        SERVER, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
    return result["choices"][0]["message"].get("content", "").strip()[:1000]


# ── Test a format ──


def test_format(name, builder, cache_key=None):
    """Run a format through all sequences, return scores."""

    if cache_key:
        try:
            with open(CACHE_FILE) as f:
                cache = json.load(f)
            if cache.get("_cache_key") == cache_key and cache.get("_name") == name:
                dims = {k: v for k, v in cache.items() if not k.startswith("_")}
                sz = cache.get("_size", 0)
                print(f"  (cached) {name}: {composite_score(dims)}/10  ({sz:,}c)")
                return dims, sz
        except:
            pass

    all_dims = {
        "tool_recall": [],
        "target_accuracy": [],
        "goal_continuity": [],
        "decision_recall": [],
        "temporal_order": [],
    }
    all_sizes = []

    for sq in seqs:
        ctx = builder(sq["ctx"])
        all_sizes.append(len(ctx))
        resp = call_llm(ctx, sq["prompt"])
        dims = score_response(resp, sq["gt_tools"], sq["gt_text"])
        for k in all_dims:
            all_dims[k].append(dims[k])
        time.sleep(0.25)

    avg_dims = {k: round(sum(v) / len(v), 2) for k, v in all_dims.items()}
    avg_size = round(sum(all_sizes) / len(all_sizes))

    if cache_key:
        cache = {"_cache_key": cache_key, "_name": name, "_size": avg_size, **avg_dims}
        with open(CACHE_FILE, "w") as f:
            json.dump(cache, f, indent=2)

    print(f"  {name:25s} {composite_score(avg_dims):>5.1f}/10  ({avg_size:,}c)")
    return avg_dims, avg_size


# ── MAIN ──

# Compute cache key from the format builder code
baseline_code = open(__file__).read() + str(len(seqs))
cache_key = hashlib.md5(baseline_code.encode()).hexdigest()[:12]

print(f"\nCache key: {cache_key}\n")

# Test baseline
baseline_dims, baseline_size = test_format(
    "BASELINE (intent)", build_intent_format, cache_key
)

# Test optimal
optimal_dims, optimal_size = test_format("OPTIMAL", build_optimal_format)

# Summary
print(f"\n{'=' * 60}")
print(f"  {'Dimension':20s} {'Baseline':>10s} {'Optimal':>10s} {'Delta':>8s}")
print(f"  {'-' * 50}")
for dim in [
    "tool_recall",
    "target_accuracy",
    "goal_continuity",
    "decision_recall",
    "temporal_order",
]:
    b = baseline_dims[dim]
    o = optimal_dims[dim]
    d = o - b
    print(f"  {dim:20s} {b:>10.2f} {o:>10.2f} {d:>+8.2f}")

b_total = composite_score(baseline_dims)
o_total = composite_score(optimal_dims)
print(f"  {'-' * 50}")
print(
    f"  {'COMPOSITE':20s} {b_total:>10.1f} {o_total:>10.1f} {o_total - b_total:>+8.1f}"
)
print(f"  {'Context size':20s} {baseline_size:>10,}c {optimal_size:>10,}c")
print(f"{'=' * 60}")
