#!/usr/bin/env python3
"""Test: can the model continue coherently from compressed turn history?"""

import json
import os
import glob
import urllib.request

SERVER = "http://127.0.0.1:1234/v1/chat/completions"

# Load session
session_dir = os.path.expanduser(os.environ.get("SESSION_DIR", "~/.pi/agent/sessions/example-session/"))
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

# Pick 4 CONSECUTIVE turns that form a coherent arc
# Turns 1-4: context window research → testing → results discussion
arc_turns = turns[1:5]  # 4 turns
print(f"Using turns 1-4 ({sum(len(t) for t in arc_turns)} entries)")


def extract_turn_data(turn):
    """Extract user msg + tools from a turn."""
    tools = []
    user_msg = ""
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
        elif role == "toolResult" and isinstance(content, list) and tools:
            text = " ".join(
                c.get("text", "")
                for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
            last = tools[-1]
            if not last.get("result"):
                last["result"] = text[:60] if text else "(-)"
    return user_msg, tools


# ── THREE FORMATS ──


def format_raw_full(turns_data):
    """Format A: Full raw text of all turns."""
    parts = []
    for i, (user_msg, tools) in enumerate(turns_data):
        parts.append(f"Turn {i + 1}: {user_msg[:120]}")
        for t in tools:
            r = t.get("result", "") or ""
            r_str = f" → {r[:60]}" if r and r != "(-)" else ""
            parts.append(f"  {t['type']}: {t['target'][:55]}{r_str}")
    return "\n".join(parts)


def format_intent_grouped(turns_data):
    """Format B: Group consecutive same-type tools, show intent."""
    parts = []
    for i, (user_msg, tools) in enumerate(turns_data):
        parts.append(f"T{i + 1}: {user_msg[:100]}")

        # Group consecutive tools
        groups = []
        cur = None
        for t in tools:
            if cur and cur["type"] == t["type"]:
                cur["count"] += 1
                if t.get("target") and t["target"] != cur.get("target", ""):
                    cur["target"] = t["target"][:40]
            else:
                if cur:
                    groups.append(cur)
                cur = {**t, "count": 1}
        if cur:
            groups.append(cur)

        for g in groups:
            c = f" ×{g['count']}" if g["count"] > 1 else ""
            r = g.get("result", "") or ""
            r_str = f" → {r[:50]}" if r and r != "(-)" else ""
            parts.append(f"  {g['type']}{c}: {g.get('target', '?')[:45]}{r_str}")
    return "\n".join(parts)


def format_ilostyle(turns_data):
    """Format C: ILO-style entity counts (current storage)."""
    from collections import Counter

    parts = []
    for i, (user_msg, tools) in enumerate(turns_data):
        types = Counter(t["type"] for t in tools)
        files = list(
            set(
                t["target"]
                for t in tools
                if t["type"] in ("read", "write", "edit") and "/" in t["target"]
            )
        )
        f_str = ", ".join(f.split("/")[-1] for f in files[:3])
        t_str = ", ".join(f"{t}×{c}" for t, c in types.most_common())
        parts.append(f"T{i + 1}: [{t_str}] files:{f_str or 'none'} — {user_msg[:60]}")
    return "\n".join(parts)


# Extract data for all 4 turns
turns_data = [extract_turn_data(t) for t in arc_turns]

# Print sizes
print(
    f"\nRaw sizes per turn: {[sum(len(json.dumps(e)) for e in t) for t in arc_turns]}"
)
print(
    f"Total raw: {sum(sum(len(json.dumps(e)) for e in t) for t in arc_turns):,} chars"
)

for label, fn in [
    ("Raw full", format_raw_full),
    ("Intent grouped", format_intent_grouped),
    ("ILO-style", format_ilostyle),
]:
    ctx = fn(turns_data)
    print(
        f"{label}: {len(ctx):,} chars ({sum(sum(len(json.dumps(e)) for e in t) for t in arc_turns) // max(len(ctx), 1)}x smaller)"
    )


# ── TEST ──
def call_llm(system_context, user_prompt):
    payload = {
        "model": "mtplx",
        "messages": [
            {
                "role": "system",
                "content": f"Previous session turns:\n\n{system_context}",
            },
            {"role": "user", "content": user_prompt},
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
        return result["choices"][0]["message"].get("content", "").strip()[:400]
    except Exception as e:
        return f"(error: {e})"


# The follow-up prompt tests if the model understood the context
follow_up = "Given everything we've done so far with the context window settings, what should we try next? Be specific about what setting to change and why."

print("\n" + "=" * 70)
print("CONTINUATION TEST — Can model continue coherently?")
print("=" * 70)

for label, fn in [
    ("A: Raw full", format_raw_full),
    ("B: Intent grouped", format_intent_grouped),
    ("C: ILO-style", format_ilostyle),
]:
    context = fn(turns_data)
    print(f"\n── {label} ({len(context):,} chars) ──")
    print(f"  Context preview: {context[:150]}...")
    print()

    answer = call_llm(context, follow_up)
    print(f"  Follow-up: {follow_up[:60]}...")
    print(f"  Response: {answer[:350]}")

print("\n" + "=" * 70)
print("SCORING (manual): Does the response correctly reference:")
print("  - The current context window size (262K)?")
print("  - The testing already done (32K→64K→128K→262K)?")
print("  - Suggest a logical next step?")
print("=" * 70)
