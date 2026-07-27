#!/usr/bin/env python3
"""
Five-Dimension Preservation Score — targeted probes per dimension.
Baseline (raw format) is cached. Future formats compare against it.
"""

import json
import os
import glob
import time
import urllib.request
import re

SERVER = "http://127.0.0.1:1234/v1/chat/completions"
CACHE_FILE = os.path.join(os.path.dirname(__file__), "baseline_cache.json")

# ── Session ──
session_dir = os.path.expanduser("~/.pi/agent/sessions/--Users-femi-Documents-ilo--/")
files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")), key=os.path.getmtime)
session_path = files[-1]
with open(session_path) as f:
    entries = [json.loads(l) for l in f if l.strip()]

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
                current["tools"].append({"name": b.get("name", "?"), "target": values})
    elif role == "toolResult" and current is not None:
        text = " ".join(
            b.get("text", "")
            for b in blocks
            if isinstance(b, dict) and b.get("type") == "text"
        )
        current["results"].append(text)
if current:
    turns.append(current)
print(f"{len(turns)} turns")

# Test sequences
seqs = []
for i in range(len(turns) - 6):
    ctx = turns[i : i + 5]
    tl = ctx[4]["tools"]
    if tl and len(tl) < 15:
        seqs.append(
            {
                "ctx": ctx[:4],
                "gt_tools": tl,
                "gt_text": ctx[4]["assistant_text"][0]
                if ctx[4]["assistant_text"]
                else "",
            }
        )
import random

random.Random(42).shuffle(seqs)
seqs = seqs[:8]
print(f"{len(seqs)} test sequences")

# ── FORMATS ──


def fmt_raw(turns_list):
    """Raw: full tool names + full targets."""
    return "\n".join(
        f"T{i + 1}: {t['user']}\n"
        + "\n".join(f"  {tl['name']}: {tl['target']}" for tl in t["tools"])
        for i, t in enumerate(turns_list)
    )


def fmt_baseline(turns_list):
    """Intent format (our baseline)."""
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


def fmt_optimal(turns_list):
    """Optimal: 40-char truncation + first-line results."""
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


# ── TARGETED PROBES ──

PROBES = {
    "tool_recall": "List every tool type that was used. Just the names, comma-separated.",
    "target_accuracy": "What specific files, URLs, or commands were acted on? List them.",
    "goal_continuity": "What was the user trying to accomplish? Summarize in one sentence.",
    "decision_recall": "What key decisions were made during this session?",
    "temporal_order": "In what order did the main actions happen? List the sequence.",
}


def score_dimension(response, dimension, gt_tools, gt_text):
    """Score a single dimension response against ground truth."""
    rl = response.lower()

    if dimension == "tool_recall":
        gt_names = set(t["name"] for t in gt_tools)
        found = sum(1 for n in gt_names if n in rl)
        return min(found / max(len(gt_names), 1) * 3, 3)

    if dimension == "target_accuracy":
        targets = [t.get("target", "").lower() for t in gt_tools if t.get("target")]
        # Extract key entities (filenames, URLs, commands)
        entities = []
        for tg in targets:
            parts = tg.replace("://", " ").replace("/", " ").replace("|", " ").split()
            for p in parts:
                if len(p) > 4 and p not in (
                    "http",
                    "https",
                    "www",
                    "com",
                    "org",
                    "the",
                    "this",
                    "that",
                    "with",
                ):
                    entities.append(p)
        entities = list(set(entities))[:10]
        if not entities:
            return 1.5
        found = sum(1 for e in entities if e in rl)
        return min(found / len(entities) * 3, 3)

    if dimension == "goal_continuity":
        # Check if response mentions the right topic
        topics = set()
        for t in gt_tools:
            tg = t.get("target", "").lower()
            words = re.findall(r"\b\w{4,}\b", tg)[:3]
            topics.update(words)
        topics = topics - {
            "that",
            "this",
            "with",
            "from",
            "have",
            "been",
            "what",
            "which",
            "there",
            "their",
            "about",
            "other",
            "into",
            "over",
            "than",
            "then",
            "also",
            "when",
            "where",
            "after",
            "before",
            "could",
            "would",
            "should",
        }
        if not topics:
            return 2.0
        found = sum(1 for t in topics if t in rl)
        return min(found / max(len(topics), 1) * 3, 3)

    if dimension == "decision_recall":
        if gt_text:
            phrases = re.findall(r"\b\w{5,}\b", gt_text.lower())
            phrases = [
                w
                for w in phrases
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
                    "first",
                    "then",
                    "next",
                    "also",
                    "when",
                    "where",
                    "being",
                    "doing",
                    "having",
                )
            ][:8]
            found = sum(1 for p in phrases if p in rl) if phrases else 0
            return min(found / max(len(phrases), 1) * 3, 3) if phrases else 1.5
        return 1.5

    if dimension == "temporal_order":
        seq_words = [
            "first",
            "then",
            "next",
            "after",
            "finally",
            "started",
            "began",
            "subsequently",
            "later",
            "before",
            "step",
            "1.",
            "2.",
        ]
        has_seq = sum(1 for w in seq_words if w in rl.split())
        if has_seq >= 3:
            return 3.0
        if has_seq >= 1:
            return 2.0
        return 1.0

    return 0


def composite(dims):
    scores = [v for k, v in dims.items() if k in PROBES]
    return round(sum(scores) / 15 * 10, 1)


# ── LLM ──


def call_llm(context, question):
    payload = {
        "model": "mtplx",
        "messages": [
            {"role": "system", "content": f"Session:\n{context}"},
            {"role": "user", "content": question},
        ],
        "max_tokens": 200,
        "temperature": 0.3,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        SERVER, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
    return result["choices"][0]["message"].get("content", "").strip()[:500]


# ── TEST A FORMAT ──


def test_format(name, builder, cache=False):
    """Run a format through all sequences and probes."""
    if cache:
        try:
            with open(CACHE_FILE) as f:
                c = json.load(f)
            if c.get("_name") == name and c.get("_count") == len(seqs):
                print(f"  (cached) {name}: {composite(c)}/10")
                return c
        except:
            pass

    all_dims = {d: [] for d in PROBES}
    sizes = []

    for sq in seqs:
        ctx = builder(sq["ctx"])
        sizes.append(len(ctx))
        for dim, question in PROBES.items():
            resp = call_llm(ctx, question)
            s = score_dimension(resp, dim, sq["gt_tools"], sq["gt_text"])
            all_dims[dim].append(s)
            time.sleep(0.15)

    avg = {d: round(sum(v) / len(v), 2) for d, v in all_dims.items()}
    avg["_size"] = round(sum(sizes) / len(sizes))
    avg["_name"] = name
    avg["_count"] = len(seqs)
    avg["_dims"] = list(PROBES.keys())

    if cache:
        with open(CACHE_FILE, "w") as f:
            json.dump(avg, f, indent=2)

    print(f"  {name:30s} {composite(avg):>5.1f}/10  ({avg['_size']:,}c)")
    return avg


# ── RUN ──

print(f"\n{'-' * 60}")
print(f"  {'Dimension':25s} {'RAW':>8s} {'BASELINE':>10s} {'OPTIMAL':>10s}")
print(f"  {'-' * 55}")

raw_dims = test_format("RAW (full conversation)", fmt_raw, cache=True)
base_dims = test_format("BASELINE (intent format)", fmt_baseline, cache=True)
opt_dims = test_format("OPTIMAL", fmt_optimal)

print(f"  {'-' * 55}")
for dim in PROBES:
    r = raw_dims[dim]
    b = base_dims.get(dim, 0)
    o = opt_dims.get(dim, 0)
    print(f"  {dim:25s} {r:>8.2f} {b:>10.2f} {o:>10.2f}")

print(f"  {'-' * 55}")
print(
    f"  {'COMPOSITE':25s} {composite(raw_dims):>8.1f} {composite(base_dims):>10.1f} {composite(opt_dims):>10.1f}"
)
print(
    f"  {'Context size':25s} {raw_dims['_size']:>8,}c {base_dims['_size']:>10,}c {opt_dims['_size']:>10,}c"
)
print(f"{'-' * 60}")

print(f"\nBaseline cached to: {CACHE_FILE}")
