#!/usr/bin/env python3
"""
Universal session formatter — zero hardcoded keys.
Extracts turns using the three universal patterns:
  1. user_input (text blocks in user messages)
  2. agent_actions (toolCall + thinking + text in assistant messages)
  3. tool_results (text blocks in toolResult messages)
"""

import json
import os
import glob
from collections import Counter


def parse_session(path):
    """Parse a pi session file into structured turns."""
    with open(path) as f:
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
            current = {
                "user_input": _extract_text(blocks),
                "agent_actions": [],
                "tool_results": [],
            }

        elif role == "assistant" and current is not None:
            for block in blocks:
                if block.get("type") == "toolCall":
                    args = block.get("arguments", {})
                    if isinstance(args, dict):
                        values = " | ".join(str(v)[:80] for v in args.values() if v)
                    else:
                        values = str(args)[:80]
                    current["agent_actions"].append(
                        {
                            "type": "tool",
                            "name": block.get("name", "?"),
                            "target": values,
                        }
                    )
                elif block.get("type") == "thinking":
                    think = block.get("thinking", "")
                    current["agent_actions"].append(
                        {"type": "think", "target": think[:100] if think else ""}
                    )
                elif block.get("type") == "text":
                    text = block.get("text", "")
                    current["agent_actions"].append(
                        {"type": "say", "target": text[:100] if text else ""}
                    )

        elif role == "toolResult" and current is not None:
            result_text = _extract_text(blocks)
            current["tool_results"].append(result_text[:120])

    if current:
        turns.append(current)
    return turns


def _extract_text(blocks):
    """Universal text extractor — works for user and toolResult messages."""
    text = " ".join(
        b.get("text", "")
        for b in blocks
        if isinstance(b, dict) and b.get("type") == "text"
    )
    return text.strip()


# ── FORMATS (using universal data) ──


def format_raw(turns):
    """Format A: Show every action in order."""
    parts = []
    for i, turn in enumerate(turns):
        parts.append(f"T{i + 1}: {turn['user_input'][:120]}")
        for a in turn["agent_actions"]:
            if a["type"] == "tool":
                parts.append(f"  {a['name']}: {a['target'][:60]}")
            elif a["type"] == "think":
                parts.append(f"  (thought: {a['target'][:60]})")
        for r in turn["tool_results"]:
            parts.append(f"  → {r[:60]}")
    return "\n".join(parts)


def format_intent(turns):
    """Format B: Group consecutive tools, skip thinking."""
    parts = []
    for i, turn in enumerate(turns):
        parts.append(f"T{i + 1}: {turn['user_input'][:100]}")

        # Group consecutive same tool calls
        tools_only = [a for a in turn["agent_actions"] if a["type"] == "tool"]
        groups = []
        cur = None
        for a in tools_only:
            key = (a["name"], a.get("target", "")[:50])
            if cur and cur["key"] == key:
                cur["count"] += 1
            else:
                if cur:
                    groups.append(cur)
                cur = {
                    "key": key,
                    "name": a["name"],
                    "target": a.get("target", "")[:55],
                    "count": 1,
                }
        if cur:
            groups.append(cur)

        for g in groups:
            c = f" ×{g['count']}" if g["count"] > 1 else ""
            parts.append(f"  {g['name']}{c}: {g['target'][:55]}")
    return "\n".join(parts)


def format_compact(turns):
    """Format C: One line per turn — goal + tool types."""
    parts = []
    for i, turn in enumerate(turns):
        types = Counter(a["name"] for a in turn["agent_actions"] if a["type"] == "tool")
        t_str = ", ".join(f"{t}×{c}" for t, c in types.most_common(5))
        parts.append(f"T{i + 1}: [{t_str}] {turn['user_input'][:80]}")
    return "\n".join(parts)


# ── TEST ──
if __name__ == "__main__":
    session_dir = os.path.expanduser(
        os.path.expanduser(os.environ.get("SESSION_DIR", "~/.pi/agent/sessions/example-session/"))
    )
    files = sorted(
        glob.glob(os.path.join(session_dir, "*.jsonl")), key=os.path.getmtime
    )
    session_path = files[-1]

    print("=" * 65)
    print("  UNIVERSAL SESSION FORMATTER")
    print("=" * 65)

    turns = parse_session(session_path)

    total_raw = os.path.getsize(session_path)

    print(f"\n  Session: {os.path.basename(session_path)}")
    print(f"  Turns:   {len(turns)}")
    print(f"  Source:  {total_raw:,} bytes")

    for label, fn, name in [
        ("A: Raw timeline", format_raw, "raw"),
        ("B: Intent grouped", format_intent, "intent"),
        ("C: Compact", format_compact, "compact"),
    ]:
        output = fn(turns)
        size = len(output)
        ratio = total_raw // max(size, 1)
        print(f"\n  {label}: {size:,} chars ({ratio}x smaller)")

    # Sample output
    print("\n── Sample (first 3 turns, intent format) ──")
    print(format_intent(turns[:3]))

    # Count unique tool types captured
    all_tools = set()
    for turn in turns:
        for a in turn["agent_actions"]:
            if a["type"] == "tool":
                all_tools.add(a["name"])

    print(f"\n  Tool types captured: {', '.join(sorted(all_tools))}")
    print(f"  Total: {len(all_tools)} tool types — no hardcoded keys needed")

    # Show what was lost
    total_tools = sum(
        len([a for a in t["agent_actions"] if a["type"] == "tool"]) for t in turns
    )
    total_thinking = sum(
        len([a for a in t["agent_actions"] if a["type"] == "think"]) for t in turns
    )
    total_results = sum(len(t["tool_results"]) for t in turns)

    print(f"\n  Total tool calls: {total_tools}")
    print(f"  Total thinking blocks: {total_thinking} (dropped in intent format)")
    print(f"  Total tool results: {total_results} (dropped in all formats)")
