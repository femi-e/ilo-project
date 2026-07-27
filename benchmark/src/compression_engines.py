"""All 7 compression techniques for context evaluation."""

import re

# ── Technique A: Full Raw ──────────────────────────────────


def technique_a_full_raw(turns: list[dict]) -> str:
    """Complete unmodified message history (baseline)."""
    from .session_extractor import format_turns_as_raw

    return format_turns_as_raw(turns)


# ── Technique B: Pi Compaction ─────────────────────────────


def technique_b_pi_compaction(turns: list[dict]) -> str:
    """Simulate pi-style compaction: free-text summary."""
    summary_parts = ["## Session Summary"]

    goals = []
    files = []
    for t in turns:
        msg = t.get("user_message", "") or ""
        goals.append(msg[:150])
        for tc in t.get("tool_calls", []):
            inp = tc.get("input", tc.get("arguments", {}))
            if isinstance(inp, dict):
                path = inp.get("path", "")
                if path:
                    files.append(path)

    files = list(set(files))

    summary_parts.append("### Goals\n" + "\n".join(f"- {g}" for g in goals[:5]))
    summary_parts.append(
        "### Files Modified\n" + "\n".join(f"- {f}" for f in files[:10])
    )

    return "\n\n".join(summary_parts)


# ── Technique C: Structured State ──────────────────────────


def extract_turn_state(turn: dict) -> dict:
    """Extract structured state from a single turn."""
    user_msg = turn.get("user_message", "") or ""

    # Extract goal from user message
    goal = user_msg[:200].strip()

    # Extract files changed from tool calls
    files_changed = set()
    for tc in turn.get("tool_calls", []):
        inp = tc.get("input", tc.get("arguments", {}))
        if isinstance(inp, dict):
            path = inp.get("path", "")
            if path:
                files_changed.add(path)

    def _content_str(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                c.get("text", "") if isinstance(c, dict) else str(c)
                for c in content
            )
        return str(content) if content else ""

    # Extract decisions from assistant reasoning
    decisions = []
    for msg in turn.get("assistant_messages", []):
        reasoning = msg.get("reasoning", "") or ""
        if reasoning:
            # Look for decision-indicating phrases
            decision_patterns = [
                r"(?:chose|decided|selected|opted for|using|because)[^.]*\.",
                r"(?:better to|prefer|recommend|should use)[^.]*\.",
            ]
            for pattern in decision_patterns:
                matches = re.findall(pattern, reasoning, re.IGNORECASE)
                decisions.extend(matches[:2])

    # Extract tools used
    tools_used = []
    for tc in turn.get("tool_calls", []):
        tools_used.append(tc.get("name", "unknown"))

    # Determine status
    status = "completed" if len(turn.get("tool_calls", [])) > 0 else "pending"

    # Extract next steps from assistant content
    next_steps = []
    for msg in turn.get("assistant_messages", []):
        content = _content_str(msg.get("content", ""))
        next_patterns = [
            r"(?:next|then|after that|following up|下一步)[^.]*\.",
        ]
        for pattern in next_patterns:
            matches = re.findall(pattern, content, re.IGNORECASE)
            next_steps.extend(matches[:2])

    return {
        "goal": goal,
        "files_changed": list(files_changed)[:5],
        "decisions": decisions[:3],
        "tools_used": list(set(tools_used)),
        "status": status,
        "next_steps": next_steps[:2],
    }


def technique_c_structured_state(turns: list[dict]) -> str:
    """Per-turn structured state: goal, files, decisions, status."""
    parts = ["## Session State (structured by turn)"]

    for i, turn in enumerate(turns):
        state = extract_turn_state(turn)
        parts.append(
            f"### Turn {turn.get('turn_index', i + 1)}\n"
            f"  **Goal**: {state['goal'][:100]}\n"
            f"  **Files**: {', '.join(state['files_changed']) or '(none)'}\n"
            f"  **Decisions**: {'; '.join(state['decisions'][:2]) or '(none)'}\n"
            f"  **Tools**: {', '.join(state['tools_used'][:4]) or '(none)'}\n"
            f"  **Status**: {state['status']}\n"
            f"  **Next**: {'; '.join(state['next_steps'][:1]) or '(none)'}"
        )

    return "\n\n".join(parts)


# ── Technique D: Minimal State ─────────────────────────────


def technique_d_minimal_state(turns: list[dict]) -> str:
    """Just files changed + last decision per turn."""
    parts = ["## Minimal Session State"]

    for i, turn in enumerate(turns):
        state = extract_turn_state(turn)
        files = state["files_changed"]
        decisions = state["decisions"]
        parts.append(
            f"Turn {turn.get('turn_index', i + 1)}: "
            f"[{'|'.join(files[:3]) or '(no files)'}] "
            f"{decisions[0] if decisions else ''}"
        )

    return "\n".join(parts)


# ── Technique E: Hybrid FIFO ───────────────────────────────


def technique_e_hybrid_fifo(turns: list[dict]) -> str:
    """Last 3 turns raw + structured state for rest."""
    from .session_extractor import format_turn_as_text

    keep_raw = 3
    parts = []

    if len(turns) > keep_raw:
        structured = turns[:-keep_raw]
        raw = turns[-keep_raw:]
        parts.append(technique_c_structured_state(structured))
        parts.append("## Recent Turns (raw)")
        for t in raw:
            parts.append(format_turn_as_text(t))
    else:
        # All turns fit, no compression needed
        from .session_extractor import format_turns_as_raw

        return format_turns_as_raw(turns)

    return "\n\n---\n\n".join(parts)


# ── Technique F: Drop ──────────────────────────────────────


def technique_f_drop(_turns: list[dict]) -> str:
    """No context — cold start."""
    return ""


# ── Technique G: Semantic Centroid ─────────────────────────


def score_turn(
    turn: dict, centroid_text: str, turn_index: int, total_turns: int
) -> float:
    """Score a turn by importance."""
    recency = turn_index / max(total_turns, 1)

    # Semantic similarity via simple word overlap (no external deps)
    user_msg = (turn.get("user_message", "") or "").lower()
    centroid_words = set(centroid_text.lower().split())
    turn_words = set(user_msg.split())
    overlap = len(centroid_words & turn_words) / max(
        len(centroid_words | turn_words), 1
    )

    # Tool density (more tools = more action)
    tool_count = len(turn.get("tool_calls", []))
    tool_density = min(tool_count / 3, 1.0)

    # Weighted score
    return 0.5 * recency + 0.3 * overlap + 0.2 * tool_density


def technique_g_semantic_centroid(turns: list[dict]) -> str:
    """Keep most important turns by semantic-temporal scoring."""
    if not turns:
        return ""

    # Use first turn's user message as centroid
    centroid_text = turns[0].get("user_message", "") or ""

    scored = []
    for i, turn in enumerate(turns):
        s = score_turn(turn, centroid_text, i, len(turns))
        scored.append((s, turn))

    scored.sort(reverse=True)

    # Keep top 50% of turns by score
    keep_count = max(len(turns) // 2, 1)
    selected = [turn for _, turn in scored[:keep_count]]

    # Restore chronological order
    selected.sort(key=lambda t: t.get("turn_index", 0))

    from .session_extractor import format_turns_as_raw

    return format_turns_as_raw(selected)


# ── Dispatch ───────────────────────────────────────────────

TECHNIQUE_MAP = {
    "A": ("Full Raw (baseline)", technique_a_full_raw),
    "B": ("Pi Compaction", technique_b_pi_compaction),
    "C": ("Structured State", technique_c_structured_state),
    "D": ("Minimal State", technique_d_minimal_state),
    "E": ("Hybrid FIFO", technique_e_hybrid_fifo),
    "F": ("Drop (cold start)", technique_f_drop),
    "G": ("Semantic Centroid", technique_g_semantic_centroid),
}


def compress(turns: list[dict], technique_id: str) -> tuple[str, str]:
    """Apply a compression technique and return (label, compressed_text)."""
    if technique_id not in TECHNIQUE_MAP:
        raise ValueError(
            f"Unknown technique: {technique_id}. Options: {list(TECHNIQUE_MAP.keys())}"
        )

    label, fn = TECHNIQUE_MAP[technique_id]
    result = fn(turns)
    return label, result
