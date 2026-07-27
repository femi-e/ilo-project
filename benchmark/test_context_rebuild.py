"""
test_context_rebuild.py — Test context reconstruction quality vs raw context

Tests:
1. Turn storage: reconstruct vs store — preserves info better?
2. Context rebuild: can we match raw context quality with less tokens?
3. Metrics: token efficiency, retention, response quality

Usage:
    python benchmark/test_context_rebuild.py [--session FILE] [--turns N]
"""

import json
import urllib.request
import argparse
import os

# ── Config ─────────────────────────────────────────────

BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL = "/Users/femi/models/qwen3.5-9b/Qwen_Qwen3.5-9B-Q4_K_M.gguf"
SESSION_DIR = os.path.expanduser("~/.pi/agent/sessions/--Users-femi-Documents-ilo--/")

# ── Session parser ─────────────────────────────────────


def extract_turns(session_file):
    entries = []
    with open(session_file) as f:
        for line in f:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    msgs = [e["message"] for e in entries if e.get("type") == "message"]
    turns = []
    current_user = None
    current_tools = []
    current_results = []
    current_asst_text = ""

    for msg in msgs:
        role = msg.get("role", "")
        content = msg.get("content", [])
        if not isinstance(content, list):
            continue

        if role == "user":
            if current_user is not None:
                turns.append(
                    {
                        "user": current_user,
                        "assistant": current_asst_text,
                        "tools": current_tools[:],
                        "results": current_results[:],
                    }
                )
            user_text = ""
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    user_text = item.get("text", "")
                    break
            current_user = user_text
            current_tools = []
            current_results = []
            current_asst_text = ""

        elif role == "assistant":
            for item in content:
                if isinstance(item, dict):
                    if item.get("type") == "text":
                        current_asst_text += item.get("text", "")
                    elif item.get("type") == "toolCall":
                        tc = item.get("toolCall", {})
                        current_tools.append(
                            {
                                "name": tc.get("name", "?"),
                                "arguments": tc.get("arguments", {}),
                            }
                        )

        elif role == "tool":
            for item in content:
                if isinstance(item, dict) and item.get("type") == "toolResult":
                    tr = item.get("toolResult", {})
                    result_text = ""
                    for c in tr.get("content") or []:
                        if isinstance(c, dict) and c.get("type") == "text":
                            result_text = c.get("text", "")[:80]
                            break
                    current_results.append(
                        {
                            "toolCallId": tr.get("toolCallId", "?"),
                            "isError": tr.get("isError", False),
                            "text": result_text,
                        }
                    )

    if current_user is not None:
        turns.append(
            {
                "user": current_user,
                "assistant": current_asst_text,
                "tools": current_tools[:],
                "results": current_results[:],
            }
        )

    return turns


# ── Context builders ───────────────────────────────────


def build_raw_context(turns, target_idx, window=5):
    start = max(0, target_idx - window)
    ctx_turns = turns[start:target_idx]
    lines = []
    for i, t in enumerate(ctx_turns):
        lines.append(f"T{start + i + 1}: {t['user']}")
        if t["assistant"]:
            lines.append(f"  Assistant: {t['assistant'][:200]}")
        for tool in t["tools"]:
            args_str = json.dumps(tool["arguments"])[:60]
            lines.append(f"  Tool: {tool['name']}({args_str})")
        for r in t["results"]:
            lines.append(f"  Result: {r['text'][:60]}")
    return "\n".join(lines)


def build_session_actions(turns, target_idx):
    ctx_turns = turns[:target_idx]
    lines = []
    for i, t in enumerate(ctx_turns):
        tool_lines = []
        for tool in t["tools"]:
            args_str = json.dumps(tool["arguments"])[:40]
            tool_lines.append(f"  {tool['name']}: {args_str}")
        grouped = []
        for tl in tool_lines:
            if grouped and grouped[-1] == tl:
                continue
            grouped.append(tl)
        lines.append(f"T{i + 1}: {t['user'][:80]}")
        lines.extend(grouped)
        for r in t["results"][:2]:
            if r["text"]:
                lines.append(f"  -> {r['text'][:60]}")
    return "\n".join(lines)


def build_reconstructed_context(turns, target_idx, raw_window=3):
    ctx_turns = turns[:target_idx]
    n = len(ctx_turns)
    raw_start = max(0, n - raw_window)
    raw_turns = ctx_turns[raw_start:]
    early_turns = ctx_turns[:raw_start]
    parts = []
    if early_turns:
        session_actions = build_session_actions(early_turns, len(early_turns))
        parts.append("## Session History (compressed)")
        parts.append(session_actions)
    if raw_turns:
        parts.append("## Recent Turns (full)")
        for i, t in enumerate(raw_turns):
            parts.append(f"T{raw_start + i + 1}: {t['user']}")
            if t["assistant"]:
                parts.append(f"  Assistant: {t['assistant'][:200]}")
            for tool in t["tools"]:
                args_str = json.dumps(tool["arguments"])[:60]
                parts.append(f"  {tool['name']}: {args_str}")
    return "\n".join(parts)


# ── LLM caller ────────────────────────────────────────


def call_llm(system, context, user_prompt, max_tokens=300):
    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": f"{context}\n\nCurrent task: {user_prompt}"},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.1,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(
        BASE_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read())
        usage = data.get("usage", {}).get("total_tokens", 0)
        content = data["choices"][0]["message"].get("content", "")
        return content, usage
    except Exception as e:
        return f"[ERROR: {e}]", 0


# ── Metrics ────────────────────────────────────────────


def count_tokens(text):
    return len(text) // 4


def measure_quality(response, correct_answer):
    """Score 0-1 based on response quality"""
    if not response or response.startswith("[ERROR"):
        return 0.0
    error_phrases = [
        "i don't know",
        "i'm not sure",
        "i cannot",
        "i don't have",
        "no context",
        "insufficient",
        "not provided",
    ]
    for phrase in error_phrases:
        if phrase in response.lower():
            return 0.2
    if correct_answer and correct_answer.lower() in response.lower():
        return 1.0
    if len(response) > 50:
        return 0.8
    if len(response) > 20:
        return 0.5
    return 0.3


# ── Test: Context Format Comparison ────────────────────


def test_turn_formats(session_file, num_turns=10):
    print(f"\n{'=' * 70}")
    print("  TEST: Context Format Comparison")
    print(f"  Session: {os.path.basename(session_file)}")
    print(f"{'=' * 70}")

    turns = extract_turns(session_file)
    print(f"  Extracted {len(turns)} turns")

    results = []
    system_prompt = "You are a helpful coding assistant. Based on the context provided, continue the task."

    for i in range(1, min(num_turns, len(turns))):
        if i >= len(turns):
            break
        user_prompt = (
            turns[i]["user"] if turns[i]["user"] else turns[i]["assistant"][:100]
        )
        if not user_prompt:
            continue
        correct = turns[i]["assistant"][:200]

        raw_ctx = build_raw_context(turns, i, window=5)
        sa_ctx = build_session_actions(turns, i)
        rec_ctx = build_reconstructed_context(turns, i, raw_window=3)

        raw_tokens = count_tokens(raw_ctx)
        sa_tokens = count_tokens(sa_ctx)
        rec_tokens = count_tokens(rec_ctx)

        print(f'\n  Turn {i + 1}: "{user_prompt[:50]}..."')
        print(
            f"    Raw: {raw_tokens:5d} tok | SA: {sa_tokens:5d} tok | Rec: {rec_tokens:5d} tok"
        )

        if raw_tokens < 500:
            r_raw, u_raw = call_llm(system_prompt, raw_ctx, user_prompt)
            r_sa, u_sa = call_llm(system_prompt, sa_ctx, user_prompt)
            r_rec, u_rec = call_llm(system_prompt, rec_ctx, user_prompt)

            q_raw = measure_quality(r_raw, correct)
            q_sa = measure_quality(r_sa, correct)
            q_rec = measure_quality(r_rec, correct)

            print(f"    Quality: Raw={q_raw:.2f} SA={q_sa:.2f} Rec={q_rec:.2f}")
            results.append(
                {
                    "turn": i + 1,
                    "raw_tokens": raw_tokens,
                    "sa_tokens": sa_tokens,
                    "rec_tokens": rec_tokens,
                    "raw_quality": q_raw,
                    "sa_quality": q_sa,
                    "rec_quality": q_rec,
                }
            )

    if results:
        avg_raw_q = sum(r["raw_quality"] for r in results) / len(results)
        avg_sa_q = sum(r["sa_quality"] for r in results) / len(results)
        avg_rec_q = sum(r["rec_quality"] for r in results) / len(results)
        avg_raw_t = sum(r["raw_tokens"] for r in results) / len(results)
        avg_sa_t = sum(r["sa_tokens"] for r in results) / len(results)
        avg_rec_t = sum(r["rec_tokens"] for r in results) / len(results)

        print(f"\n{'=' * 70}")
        print("  SUMMARY")
        print(f"{'=' * 70}")
        print(
            f"  {'Format':20s} {'Avg Tokens':15s} {'Avg Quality':15s} {'Efficiency':15s}"
        )
        print(f"  {'-' * 65}")
        print(
            f"  {'Raw (full)':20s} {avg_raw_t:15.0f} {avg_raw_q:15.2f} {avg_raw_q / avg_raw_t * 1000:15.2f}"
        )
        print(
            f"  {'Session Actions':20s} {avg_sa_t:15.0f} {avg_sa_q:15.2f} {avg_sa_q / avg_sa_t * 1000:15.2f}"
        )
        print(
            f"  {'Reconstructed':20s} {avg_rec_t:15.0f} {avg_rec_q:15.2f} {avg_rec_q / avg_rec_t * 1000:15.2f}"
        )
        print("\n  Efficiency = quality per 1000 tokens (higher = better)")
        print(f"  Compression ratio (SA/Raw): {avg_sa_t / avg_raw_t:.2f}x")
        print(f"  Compression ratio (Rec/Raw): {avg_rec_t / avg_raw_t:.2f}x")

    return results


# ── Test: Turn Storage Overhead ─────────────────────────


def test_turn_storage_overhead(session_file):
    print(f"\n{'=' * 70}")
    print("  TEST: Turn Storage Overhead Analysis")
    print(f"{'=' * 70}")

    turns = extract_turns(session_file)
    print(f"  Turns: {len(turns)}")

    raw_sizes = []
    sa_sizes = []

    for i in range(1, len(turns)):
        raw = build_raw_context(turns, i, window=len(turns))
        sa = build_session_actions(turns, i)
        raw_sizes.append(count_tokens(raw))
        sa_sizes.append(count_tokens(sa))

    if raw_sizes:
        print("\n  Growth per turn:")
        print(
            f"  {'Turns':>8s} {'Raw (tok)':>12s} {'SA (tok)':>12s} {'Compression':>12s}"
        )
        print(f"  {'-' * 44}")
        step = max(1, len(raw_sizes) // 5)
        for i in range(0, len(raw_sizes), step):
            n = i + 1
            comp = sa_sizes[i] / raw_sizes[i] if raw_sizes[i] > 0 else 0
            print(f"  {n:8d} {raw_sizes[i]:12d} {sa_sizes[i]:12d} {comp:11.2f}x")

        if len(raw_sizes) > 1:
            raw_growth = (raw_sizes[-1] - raw_sizes[0]) / (len(raw_sizes) - 1)
            sa_growth = (sa_sizes[-1] - sa_sizes[0]) / (len(sa_sizes) - 1)
            print("\n  Growth per additional turn:")
            print(f"    Raw: {raw_growth:.0f} tokens/turn")
            print(f"    Session Actions: {sa_growth:.0f} tokens/turn")
            print(f"    Savings: {raw_growth - sa_growth:.0f} tokens/turn")
            print("\n  Projected at 200 turns:")
            print(f"    Raw: {raw_growth * 200:.0f} tokens")
            print(f"    Session Actions: {sa_growth * 200:.0f} tokens")
            print(
                f"    In 262K budget: SA fits {262000 / (sa_growth * 200) * 100:.0f}% of window"
            )


# ── Test: Context Retention ─────────────────────────────


def test_context_retention(session_file, num_turns=8):
    """Test if the model can still answer questions about early turns after sliding"""
    print(f"\n{'=' * 70}")
    print("  TEST: Context Retention After Sliding")
    print(f"{'=' * 70}")

    turns = extract_turns(session_file)
    print(f"  Turns: {len(turns)}")

    # Pick turns to test retention on
    test_turns = [
        0,
        min(2, len(turns) - 1),
        min(4, len(turns) - 1),
        min(6, len(turns) - 1),
    ]
    test_turns = [t for t in test_turns if t < len(turns) and t < num_turns]

    for target in test_turns:
        if target < 2:
            continue
        user_msg = turns[target]["user"]
        if not user_msg:
            continue

        # Build contexts at two points:
        # 1. When the turn is recent (within full context)
        # 2. After many more turns (it's been pushed out)
        recent_ctx = build_raw_context(turns, target + 1, window=5)
        far_ctx = build_reconstructed_context(
            turns, min(target + 6, len(turns)), raw_window=2
        )

        # Ask about the EARLY turn while showing LATER context
        q = f'What was the task about in the earlier turn where the user said: "{user_msg[:80]}..."?'
        system = "You are a helpful assistant. Answer based on the context provided."

        r_recent, u_recent = call_llm(system, recent_ctx, q, max_tokens=200)
        r_far, u_far = call_llm(system, far_ctx, q, max_tokens=200)

        correct = turns[target]["assistant"][:100]
        q_recent = measure_quality(r_recent, correct)
        q_far = measure_quality(r_far, correct)

        print(f'\n  Target turn {target + 1}: "{user_msg[:50]}..."')
        print(
            f"    Recent context: {count_tokens(recent_ctx):4d} tok | Quality: {q_recent:.2f}"
        )
        print(
            f"    Far context:    {count_tokens(far_ctx):4d} tok | Quality: {q_far:.2f}"
        )
        print(f"    Retention diff: {q_far - q_recent:+.2f}")


# ── Main ───────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Test context rebuild quality")
    parser.add_argument("--session", default="", help="Session file")
    parser.add_argument("--turns", type=int, default=10, help="Number of turns to test")
    parser.add_argument(
        "--no-llm", action="store_true", help="Skip LLM calls, just measure sizes"
    )
    args = parser.parse_args()

    # Find session file
    session_file = args.session
    if not session_file:
        sessions = sorted([f for f in os.listdir(SESSION_DIR) if f.endswith(".jsonl")])
        if not sessions:
            print("No session files found")
            return
        session_file = os.path.join(SESSION_DIR, sessions[-1])
        print(f"Using most recent session: {sessions[-1]}")

    # Run tests
    test_turn_storage_overhead(session_file)
    if not args.no_llm:
        test_turn_formats(session_file, args.turns)
        test_context_retention(session_file, args.turns)


if __name__ == "__main__":
    main()
