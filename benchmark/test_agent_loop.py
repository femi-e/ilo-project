#!/usr/bin/env python3
from collections import Counter

"""
Mini agent loop test: Feed compressed context + prompt, capture tool calls,
compare against expected ground truth.
"""
import json
import os
import glob
import time
import urllib.request
import re

SERVER = "http://127.0.0.1:1234/v1/chat/completions"

# Load session
session_dir = os.path.expanduser("~/.pi/agent/sessions/--Users-femi-Documents-ilo--/")
files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")), key=os.path.getmtime)
session_path = files[-1]
with open(session_path) as f:
    entries = [json.loads(l) for l in f if l.strip()]

# Parse turns
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

# Find a good 5-turn sequence where turn 5 has CLEAR tool actions
# Look for turns with edit, write, or specific bash commands
for start_idx in range(len(turns) - 5):
    seq = turns[start_idx : start_idx + 5]
    # Check if turn 5 (index 4) has tool calls
    last_turn_tools = 0
    for e in seq[4]:
        msg = e.get("message", {})
        content = msg.get("content", [])
        if msg.get("role") == "assistant" and isinstance(content, list):
            for block in content:
                if block.get("type") == "toolCall":
                    last_turn_tools += 1
    if last_turn_tools >= 3 and last_turn_tools <= 10:
        SEQ_START = start_idx
        break
else:
    SEQ_START = 0  # Fallback

seq_turns = turns[SEQ_START : SEQ_START + 5]
print(f"Using turns {SEQ_START} to {SEQ_START + 4}")


def extract_turn_data(turn):
    user_msg = ""
    tools = []
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
                    tools.append({"type": name, "target": target[:60]})

    return {"user": user_msg[:150], "tools": tools}


seq_data = [extract_turn_data(t) for t in seq_turns]
context_turns = seq_data[:4]
test_turn = seq_data[4]

user_prompt = test_turn["user"]
expected_tools = test_turn["tools"]

print(f"\nPrompt: {user_prompt[:100]}...")
print(f"Expected tools ({len(expected_tools)}):")
for t in expected_tools[:8]:
    print(f"  {t['type']}: {t['target'][:50]}")
if len(expected_tools) > 8:
    print(f"  ... and {len(expected_tools) - 8} more")

# ── FORMAT DEFINITIONS ──


def fmt_raw(turns_data):
    parts = []
    for i, d in enumerate(turns_data):
        parts.append(f"T{i + 1}: {d['user'][:120]}")
        for t in d["tools"]:
            parts.append(f"  {t['type']}: {t['target'][:55]}")
    return "\n".join(parts)


def fmt_intent(turns_data):
    """Grouped consecutive tools (best performer)."""
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
            parts.append(f"  {g['type']}{c}: {g.get('target', '')[:45]}")
    return "\n".join(parts)


def fmt_counts(turns_data):
    """Tool types only."""
    from collections import Counter

    parts = []
    for i, d in enumerate(turns_data):
        types = Counter(t["type"] for t in d["tools"])
        t_str = ", ".join(f"{t}×{c}" for t, c in types.most_common())
        parts.append(f"T{i + 1}: [{t_str}] — {d['user'][:80]}")
    return "\n".join(parts)


def fmt_goals(turns_data):
    parts = [f"T{i + 1}: {d['user'][:100]}" for i, d in enumerate(turns_data)]
    return "\n".join(parts)


# ── MINI AGENT LOOP ──


def run_agent_turn(system_context, user_prompt, max_loops=8):
    """
    Mini agent loop: send prompt, get tool calls, return results.
    Returns list of tool calls the model made.
    """
    messages = [
        {
            "role": "system",
            "content": f"Previous session:\n\n{system_context}\n\nYou have access to tools. Use them to continue the work.",
        },
        {"role": "user", "content": user_prompt},
    ]

    tool_calls_made = []

    for loop in range(max_loops):
        payload = {
            "model": "mtplx",
            "messages": messages,
            "max_tokens": 300,
            "temperature": 0.3,
        }
        data = json.dumps(payload).encode()
        req = urllib.request.Request(
            SERVER, data=data, headers={"Content-Type": "application/json"}
        )

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.loads(resp.read())
        except Exception:
            break

        content = result["choices"][0]["message"].get("content", "")

        # Check if response contains tool call indicators
        # In our format, the model outputs calls as text since we're not using function calling
        # Look for patterns like "read: file.py" or "bash: command"
        tool_pattern = re.findall(
            r"(read|bash|write|edit|web_search|memory_search):\s*(.+)", content
        )

        for tool_type, tool_target in tool_pattern:
            tool_calls_made.append(
                {"type": tool_type, "target": tool_target.strip()[:60]}
            )

        # Check if model is done (no more tool calls indicated)
        if len(tool_pattern) == 0:
            break

    return tool_calls_made


def score_tool_calls(predicted, expected):
    """Score predicted tool calls against expected ground truth."""
    if not predicted:
        return 0

    expected_types = Counter(t["type"] for t in expected)
    predicted_types = Counter(t["type"] for t in predicted)

    # Score: are the right tool types used?
    type_score = 0
    for t, c in expected_types.items():
        predicted_count = predicted_types.get(t, 0)
        type_score += min(predicted_count, c) / max(c, 1) * 3

    # Score: are the right targets referenced?
    target_score = 0
    for t in expected:
        exp_target = t.get("target", "").lower()[:30]
        if not exp_target:
            continue
        for p in predicted:
            pred_target = p.get("target", "").lower()[:30]
            if exp_target in pred_target or pred_target in exp_target:
                target_score += 1
                break

    target_score = (
        target_score / max(len([t for t in expected if t.get("target")]), 1) * 3
    )

    # Score: proportion of calls matched
    call_ratio = min(len(predicted) / max(len(expected), 1), 1) * 4

    return min(type_score + target_score + call_ratio, 10)


print("\n" + "=" * 70)
print("AGENT LOOP TEST — Can the model actually DO the next steps?")
print("=" * 70)

formats = [
    ("A: Raw", fmt_raw),
    ("B: Intent grouped", fmt_intent),
    ("C: Tool counts", fmt_counts),
    ("D: Goals only", fmt_goals),
]

for label, fn in formats:
    context = fn(context_turns)
    ctx_size = len(context)
    raw_total = sum(len(json.dumps(e)) for e in seq_turns[:4])

    print(
        f"\n── {label} ({ctx_size:,} chars, {raw_total // max(ctx_size, 1)}x smaller) ──"
    )

    tool_calls = run_agent_turn(context, user_prompt)
    score = score_tool_calls(tool_calls, expected_tools)

    print(f"  Tool calls made ({len(tool_calls)}):")
    for tc in tool_calls[:6]:
        print(f"    {tc['type']}: {tc['target'][:55]}")
    if len(tool_calls) > 6:
        print(f"    ... and {len(tool_calls) - 6} more")

    print(f"  Score: {score:.1f}/10")
    time.sleep(1)

print("\n" + "=" * 70)
print("EXPECTED (ground truth):")
for t in expected_tools[:8]:
    print(f"  {t['type']}: {t['target'][:55]}")
print("=" * 70)
