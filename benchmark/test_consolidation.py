#!/usr/bin/env python3
"""Test different consolidation formats against the heaviest turn."""

import json
import os
import glob
import time
import urllib.request
import urllib.error

SERVER = "http://127.0.0.1:1234/v1/chat/completions"

# ── Load heaviest turn ──
session_dir = os.path.expanduser(os.environ.get("SESSION_DIR", "~/.pi/agent/sessions/example-session/"))
files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")), key=os.path.getmtime)
session_path = files[-1]

with open(session_path) as f:
    entries = [json.loads(l) for l in f if l.strip()]

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

# Find heaviest
heaviest = max(turns, key=lambda t: sum(len(json.dumps(e)) for e in t))
raw_size = sum(len(json.dumps(e)) for e in heaviest)
print(f"Heaviest turn: {raw_size:,} chars ({len(heaviest)} entries)")

# Extract user message
user_msg = ""
for e in heaviest:
    msg = e.get("message", {})
    if msg.get("role") == "user":
        content = msg.get("content", "")
        if isinstance(content, list):
            user_msg = " ".join(
                c.get("text", "")
                for c in content
                if isinstance(c, dict) and c.get("type") == "text"
            )
        else:
            user_msg = str(content) or ""

# ── Consolidation formats ──


def format_raw_full(entries):
    """Format A: Full raw text of the entire turn"""
    parts = []
    for e in entries:
        msg = e.get("message", {})
        role = msg.get("role", "?")
        content = msg.get("content", "")

        if role == "user":
            if isinstance(content, list):
                text = " ".join(
                    c.get("text", "")
                    for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                )
            else:
                text = str(content)
            parts.append(f"[User]: {text}")

        elif role == "assistant":
            if isinstance(content, list):
                for block in content:
                    if block.get("type") == "thinking":
                        parts.append(f"[Thinking]: {block.get('thinking', '')[:200]}")
                    elif block.get("type") == "toolCall":
                        args = block.get("arguments", {})
                        name = block.get("name", "?")
                        target = (
                            args.get("path")
                            or args.get("command")
                            or args.get("query")
                            or ""
                        )
                        parts.append(f"[ToolCall]: {name}({str(target)[:80]})")
                    elif block.get("type") == "text":
                        parts.append(f"[Assistant]: {block.get('text', '')[:200]}")

        elif role == "toolResult":
            if isinstance(content, list):
                text = " ".join(
                    c.get("text", "")
                    for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                )
            else:
                text = str(content)
            parts.append(f"[Result]: {text[:200]}")

    return "\n".join(parts)


def format_grouped_by_type(entries):
    """Format B: Group tool calls by type, summarize results"""
    reads = []
    writes = []
    bash = []
    searches = []
    recalls = []
    remaining = 0

    for e in entries:
        msg = e.get("message", {})
        role = msg.get("role")
        content = msg.get("content", [])

        if role == "assistant" and isinstance(content, list):
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
                    entry = f"{name}: {target[:60]}"
                    if name == "bash":
                        bash.append(entry)
                    elif name == "read":
                        reads.append(entry)
                    elif name in ("write", "edit"):
                        writes.append(entry)
                    elif name in ("web_search", "web_scrape"):
                        searches.append(entry)
                    elif name == "memory_search":
                        recalls.append(entry)
                    else:
                        remaining += 1

    parts = [f"[User]: {user_msg[:150]}"]
    if reads:
        parts.append(f"[Reads ({len(reads)})]: " + "; ".join(r[:40] for r in reads[:5]))
    if writes:
        parts.append("[Writes]: " + "; ".join(w[:40] for w in writes))
    if bash:
        parts.append(f"[Bash ({len(bash)})]: " + "; ".join(b[:40] for b in bash[:3]))
    if searches:
        parts.append(
            f"[Searches ({len(searches)})]: " + "; ".join(s[:40] for s in searches[:3])
        )
    if recalls:
        parts.append(
            f"[Recalls ({len(recalls)})]: " + "; ".join(r[:40] for r in recalls[:3])
        )
    if remaining:
        parts.append(f"[+{remaining} more tools]")

    return "\n".join(parts)


def format_compact_timeline(entries):
    """Format C: Compact timeline — one line per action"""
    lines = [f"Goal: {user_msg[:100]}"]
    reads = 0
    for e in entries:
        msg = e.get("message", {})
        role = msg.get("role")
        content = msg.get("content", [])

        if role == "assistant" and isinstance(content, list):
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
                    if name == "read":
                        reads += 1
                    else:
                        lines.append(f"  → {name}: {str(target)[:50]}")

    if reads:
        lines.append(f"  → read ({reads} files)")

    return "\n".join(lines)


def format_minimal(entries):
    """Format D: Minimal — just goal and file list"""
    files = set()
    tool_count = 0
    for e in entries:
        msg = e.get("message", {})
        content = msg.get("content", [])
        if msg.get("role") == "assistant" and isinstance(content, list):
            for block in content:
                if block.get("type") == "toolCall":
                    tool_count += 1
                    args = block.get("arguments", {})
                    path = args.get("path", "")
                    if path:
                        files.add(path.split("/")[-1])

    return f"Goal: {user_msg[:150]}\nTools: {tool_count}\nFiles: {', '.join(sorted(files)[:8]) or '(none)'}"


# ── Test questions ──
QUESTIONS = [
    "What was the user trying to accomplish in this session?",
    "What files were created or modified?",
    "What technical decisions were made?",
    "What commands were run and what were the results?",
]

formats = [
    ("A: Full raw", format_raw_full(heaviest)),
    ("B: Grouped by type", format_grouped_by_type(heaviest)),
    ("C: Compact timeline", format_compact_timeline(heaviest)),
    ("D: Minimal", format_minimal(heaviest)),
]


def call_llm(context, question):
    payload = {
        "model": "mtplx",
        "messages": [
            {
                "role": "system",
                "content": f"Here is a record of what happened during a session:\n\n{context}\n\nAnswer the user's question based only on the information provided above.",
            },
            {"role": "user", "content": question},
        ],
        "max_tokens": 300,
        "temperature": 0.8,
    }
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        SERVER, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read())
        content = result["choices"][0]["message"].get("content", "")
        return content[:400] if content else "(empty)"
    except Exception as e:
        return f"(error: {str(e)[:60]})"


print("=" * 70)
print("CONSOLIDATION TEST: Heaviest turn (150K chars)")
print("=" * 70)

for label, context in formats:
    ctx_size = len(context)
    print(f"\n── {label} ({ctx_size:,} chars, {ctx_size // 4:,} est. tokens) ──")

    # Score: count how many tool types are distinguishable
    tool_types = set()
    if "bash" in context.lower() or "ran" in context.lower():
        tool_types.add("bash")
    if "read" in context.lower():
        tool_types.add("read")
    if "write" in context.lower() or "edit" in context.lower():
        tool_types.add("write")
    if "search" in context.lower() or "fetch" in context.lower():
        tool_types.add("search")
    if "memory" in context.lower() or "recall" in context.lower():
        tool_types.add("memory")

    print(f"  Tool types preserved: {', '.join(sorted(tool_types)) or 'none'}")

    for q in QUESTIONS:
        answer = call_llm(context, q)
        print(f"  Q: {q[:50]}...")
        print(f"  A: {answer[:150]}...")
        time.sleep(0.5)

print("\n" + "=" * 70)
print("SIZE COMPARISON")
print("=" * 70)
for label, context in formats:
    ratio = sum(len(json.dumps(e)) for e in heaviest) / max(len(context), 1)
    print(f"  {label:25s} {len(context):>8,} chars  ({ratio:5.0f}x smaller)")
