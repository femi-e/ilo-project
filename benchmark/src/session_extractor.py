"""Parse pi session JSONL files into structured turns."""

import json
import glob
import os
from typing import Any


def find_most_recent_session(session_dir: str) -> str:
    """Find the most recent .jsonl session file."""
    files = sorted(
        glob.glob(os.path.join(session_dir, "*.jsonl")), key=os.path.getmtime
    )
    if not files:
        raise FileNotFoundError(f"No session files found in {session_dir}")
    return files[-1]


def extract_turns(session_path: str) -> list[dict[str, Any]]:
    """Parse a pi session JSONL into structured turns.

    Each turn = one user message + all assistant/tool responses that follow.
    """
    if not os.path.exists(session_path):
        raise FileNotFoundError(f"Session file not found: {session_path}")

    entries = []
    try:
        with open(session_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError as e:
                        print(f"  [warn] skipping invalid JSON line: {e}")
    except OSError as e:
        raise IOError(f"Failed to read session file: {e}")

    turns = []
    current = None

    for entry in entries:
        if entry.get("type") != "message":
            continue

        msg = entry.get("message", {})
        role = msg.get("role")

        if role == "user":
            # Save previous turn
            if current is not None:
                turns.append(current)

            # Start new turn
            content = msg.get("content", "")
            if isinstance(content, list):
                text = " ".join(
                    c.get("text", "")
                    for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                )
            else:
                text = str(content) if content else ""

            current = {
                "turn_index": len(turns) + 1,
                "user_message": text,
                "assistant_messages": [],
                "tool_calls": [],
                "tool_results": [],
            }

        elif role == "assistant" and current is not None:
            raw_content = msg.get("content", "")
            if isinstance(raw_content, list):
                # Parse inline tool calls from content array
                inline_tool_calls = []
                text_parts = []
                thinking_parts = []
                for item in raw_content:
                    item_type = item.get("type", "")
                    if item_type == "toolCall":
                        inline_tool_calls.append(
                            {
                                "name": item.get("name", "unknown"),
                                "arguments": item.get("arguments", {}),
                                "id": item.get("id", ""),
                            }
                        )
                        current["tool_calls"].append(inline_tool_calls[-1])
                    elif item_type == "text":
                        text_parts.append(item.get("text", ""))
                    elif item_type == "thinking":
                        thinking_parts.append(item.get("thinking", ""))

                assistant_entry = {
                    "content": "".join(text_parts) if text_parts else "",
                    "reasoning": "\n".join(thinking_parts)
                    if thinking_parts
                    else msg.get("reasoning_content", ""),
                    "tool_calls": inline_tool_calls,
                }
            else:
                assistant_entry = {
                    "content": str(raw_content) if raw_content else "",
                    "reasoning": msg.get("reasoning_content", ""),
                    "tool_calls": msg.get("tool_calls", []),
                }
            current["assistant_messages"].append(assistant_entry)

        elif role == "tool_result" and current is not None:
            result_content = msg.get("content", "")
            if isinstance(result_content, list):
                result_text = " ".join(
                    c.get("text", "")
                    for c in result_content
                    if isinstance(c, dict) and c.get("type") == "text"
                )
            else:
                result_text = str(result_content) if result_content else ""

            current["tool_results"].append(
                {
                    "content": result_text,
                    "tool_name": msg.get("tool_name", "unknown"),
                }
            )

        elif role == "tool" and current is not None:
            # Tool call (before result)
            current["tool_calls"].append(
                {
                    "name": msg.get("name", "unknown"),
                    "arguments": msg.get("arguments", {}),
                    "input": msg.get("input", {}),
                }
            )

    if current is not None:
        turns.append(current)

    return turns


def split_at_turn(
    turns: list[dict], cut_index: int
) -> tuple[list[dict], list[dict], list[dict]]:
    """Split turns at cut point.

    Returns:
        (pre_history, post_task, post_ground_truth)
    """
    pre = turns[:cut_index]
    post = turns[cut_index:]

    # First post-cut turn is the task prompt
    task = [post[0]] if post else []
    # Rest is ground truth continuation
    ground_truth = post[1:] if len(post) > 1 else []

    return pre, task, ground_truth


def format_turn_as_text(turn: dict) -> str:
    """Format a turn as readable text for injection."""
    lines = []
    lines.append(f"[User]: {turn['user_message']}")

    for msg in turn["assistant_messages"]:
        if msg["reasoning"]:
            lines.append(f"[Assistant thinking]: {msg['reasoning']}")
        if msg["content"]:
            lines.append(f"[Assistant]: {msg['content']}")

    for tc in turn["tool_calls"]:
        args = json.dumps(tc.get("arguments", tc.get("input", {})))
        lines.append(f"[Tool call]: {tc['name']}({args[:200]})")

    for tr in turn["tool_results"]:
        content = tr.get("content", "")
        if isinstance(content, str):
            lines.append(f"[Tool result]: {content[:300]}")

    return "\n".join(lines)


def format_turns_as_raw(turns: list[dict]) -> str:
    """Format all turns as raw text (Technique A)."""
    parts = [format_turn_as_text(t) for t in turns]
    return "\n\n---\n\n".join(parts)
