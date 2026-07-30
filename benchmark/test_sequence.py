#!/usr/bin/env python3
"""
Sequence test: Use 4 turns as context, predict the 5th turn's outcome.
Compare multiple compression formats against ground truth.
"""

import json
import os
import glob
import time
import urllib.request
import re

SERVER = "http://127.0.0.1:1234/v1/chat/completions"

# Load session
session_dir = os.path.expanduser(os.environ.get("SESSION_DIR", "~/.pi/agent/sessions/example-session/"))
files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")), key=os.path.getmtime)
session_path = files[-1]
with open(session_path) as f:
    entries = [json.loads(l) for l in f if l.strip()]

# Parse turns with full data preservation
turns = []
current = []
for e in entries:
    if e.get("type") != "message":
        continue
    msg = e.get("message", {})
    if msg.get("role") == "user":
        if current:
            turns.append(current)
        current = [e]
    else:
        current.append(e)
if current:
    turns.append(current)

print(f"Session has {len(turns)} turns")

# Pick 5 consecutive turns that form a clear arc
# Turns 4-8: setting up Optimized Config (were about locking in settings)
SEQ_START = 4
seq_turns = turns[SEQ_START : SEQ_START + 5]
print(f"Using turns {SEQ_START} to {SEQ_START + 4}")

# ── Extract structured data per turn ──


def extract_full(turn):
    """Extract everything needed: user msg, tools, results, assistant text."""
    user_msg = ""
    tools = []
    assistant_text = ""

    for e in turn:
        msg = e.get("message", {})
        role = msg.get("role")
        content = msg.get("content", [])

        if role == "user":
            if isinstance(content, list):
                user_msg = " ".join(
                    c.get("text", "")
                    for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                )
            else:
                user_msg = str(content) or ""

        elif role == "assistant" and isinstance(content, list):
            for block in content:
                if block.get("type") == "toolCall":
                    name = block.get("name", "?")
                    args = block.get("arguments", {})
                    target = (
                        args.get("path")
                        or args.get("command")
                        or args.get("query")
                        or ""
                    )
                    tools.append({"type": name, "target": target[:80]})
                elif block.get("type") == "text":
                    assistant_text += block.get("text", "")

        elif role == "toolResult" and isinstance(content, list) and tools:
            text = " ".join(
                c.get("text", "")
                for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
            last = tools[-1]
            if not last.get("result"):
                last["result"] = text[:80] if text and text != "(-)" else "(-)"

    return {"user": user_msg, "tools": tools, "assistant": assistant_text[:200]}


seq_data = [extract_full(t) for t in seq_turns]

# Print the arc
print("\n=== SEQUENCE ARC ===")
for i, d in enumerate(seq_data):
    print(f"Turn {SEQ_START + i}: {d['user'][:80]}...")
    print(f"  Tools: {len(d['tools'])} → {d['assistant'][:80]}...")

# ── FORMAT DEFINITIONS ──


def fmt_A_raw(turns_data):
    """Format A: Full raw — every tool with result snippet."""
    parts = []
    for i, d in enumerate(turns_data):
        parts.append(f"T{i + 1}: {d['user'][:120]}")
        for t in d["tools"]:
            r = t.get("result", "") or ""
            r_str = f" → {r[:60]}" if r and r != "(-)" else ""
            parts.append(f"  {t['type']}: {t['target'][:55]}{r_str}")
        if d["assistant"]:
            parts.append(f"  → {d['assistant'][:80]}")
    return "\n".join(parts)


def fmt_B_intent_grouped(turns_data):
    """Format B: Best performer — grouped consecutive tools with intent."""
    parts = []
    for i, d in enumerate(turns_data):
        parts.append(f"T{i + 1}: {d['user'][:100]}")
        groups = []
        cur = None
        for t in d["tools"]:
            key = (t["type"], t.get("target", "")[:30])
            if cur and cur["key"] == key:
                cur["count"] += 1
            else:
                if cur:
                    groups.append(cur)
                cur = {
                    "key": key,
                    "type": t["type"],
                    "target": t.get("target", "")[:40],
                    "count": 1,
                }
        if cur:
            groups.append(cur)

        for g in groups:
            c = f" ×{g['count']}" if g["count"] > 1 else ""
            r = ""  # Skip results for compactness
            parts.append(f"  {g['type']}{c}: {g.get('target', '')[:45]}")
        if d["assistant"]:
            parts.append(f"  → {d['assistant'][:60]}")
    return "\n".join(parts)


def fmt_C_tool_types(turns_data):
    """Format C: Only tool types with counts, no targets."""
    from collections import Counter

    parts = []
    for i, d in enumerate(turns_data):
        types = Counter(t["type"] for t in d["tools"])
        t_str = ", ".join(f"{t}×{c}" for t, c in types.most_common())
        parts.append(f"T{i + 1}: [{t_str}] — {d['user'][:80]}")
    return "\n".join(parts)


def fmt_D_minimal(turns_data):
    """Format D: One line per turn — goal only."""
    parts = []
    for i, d in enumerate(turns_data):
        parts.append(f"T{i + 1}: {d['user'][:100]}")
    return "\n".join(parts)


def fmt_E_entities(turns_data):
    """Format E: Only files and tool counts (ILO-entity style)."""
    from collections import Counter

    parts = []
    for i, d in enumerate(turns_data):
        types = Counter(t["type"] for t in d["tools"])
        files = list(
            set(
                t["target"].split("/")[-1]
                for t in d["tools"]
                if t["type"] in ("read", "write", "edit") and "/" in t.get("target", "")
            )
        )
        t_str = ", ".join(f"{t}×{c}" for t, c in types.most_common()[:5])
        f_str = ", ".join(files[:5]) if files else "none"
        intent = d["user"][:60]
        parts.append(f"T{i + 1}: [{t_str}] files:{f_str} — {intent}")
    return "\n".join(parts)


# ── The test ──
# Context = first 4 turns, Prompt = 5th turn's user message
# Expected = 5th turn's actual tools + assistant response (ground truth)
# We'll score by how well the model's response matches the expected tools/actions

context_turns = seq_data[:4]  # Turns 1-4
test_turn = seq_data[4]  # Turn 5
user_prompt = test_turn["user"]
expected_tools = test_turn["tools"]
expected_assistant = test_turn["assistant"]

print("\n\n=== TEST SETUP ===")
print("Context: Turns 1-4 (user's arc leading to the prompt)")
print(f'Prompt: "{user_prompt[:100]}..."')
print(f"Expected tools: {[t['type'] for t in expected_tools]}")
print(f"Expected outcome: {expected_assistant[:100]}...")


def call_llm(context, prompt):
    payload = {
        "model": "mtplx",
        "messages": [
            {"role": "system", "content": f"Previous turns:\n\n{context}"},
            {"role": "user", "content": prompt},
        ],
        "max_tokens": 500,
        "temperature": 0.3,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        SERVER, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
    return result["choices"][0]["message"].get("content", "").strip()[:500]


def score_response(response, expected_tools, expected_assistant):
    """Score how well the response matches expected outcome."""
    r_lower = response.lower()
    score = 0

    # Check if response references the right tool types
    expected_types = set(t["type"] for t in expected_tools)
    for et in expected_types:
        if et in r_lower:
            score += 2

    # Check if response references specific targets
    for t in expected_tools:
        target = t.get("target", "").lower()[:30]
        if target and target in r_lower:
            score += 1

    # Check if response intent matches expected assistant text
    if expected_assistant:
        key_words = set(re.findall(r"\w{4,}", expected_assistant.lower()))
        matched = sum(1 for w in key_words if w in r_lower)
        score += matched / max(len(key_words), 1) * 3

    return min(score, 10)


print("\n" + "=" * 70)
print("SEQUENCE TEST — 5 formats × 1 continuation")
print("=" * 70)

formats = [
    ("A: Raw full", fmt_A_raw),
    ("B: Intent grouped", fmt_B_intent_grouped),
    ("C: Tool types only", fmt_C_tool_types),
    ("D: Goals only", fmt_D_minimal),
    ("E: ILO-entity style", fmt_E_entities),
]

results = []

for label, fn in formats:
    context = fn(context_turns)
    ctx_size = len(context)
    ratio = sum(sum(len(json.dumps(e)) for e in seq_turns[:4]) for _ in [1]) // max(
        ctx_size, 1
    )

    print(f"\n── {label} ({ctx_size:,} chars, ~{ratio}x smaller) ──")
    print(f"  Context: {context[:130]}...")

    response = call_llm(context, user_prompt)
    score = score_response(response, expected_tools, expected_assistant)
    results.append((label, ctx_size, score, response[:200]))

    print(f"  Response: {response[:250]}...")
    print(f"  Score: {score:.1f}/10")
    time.sleep(0.5)

print("\n" + "=" * 70)
print("RESULTS")
print("=" * 70)
print(f"{'Format':25s} {'Size':>7s} {'Ratio':>6s} {'Score':>6s}")
print("-" * 50)
results.sort(key=lambda r: r[2], reverse=True)
for label, size, score, _ in results:
    ratio = sum(sum(len(json.dumps(e)) for e in seq_turns[:4]) for _ in [1]) // max(
        size, 1
    )
    print(f"{label:25s} {size:>7,} {ratio:>5}x {score:>5.1f}/10")

print(f"\nExpected tools: {[t['type'] for t in expected_tools]}")
print(f"Expected outcome: {expected_assistant[:100]}...")
print("=" * 70)
