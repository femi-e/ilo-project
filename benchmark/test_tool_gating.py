"""
test_tool_gating.py — Validate tool-gating pattern with Qwen3.5-9B

Tests:
1. Single-tool gating: only `context_rebuild` available → does model call it?
2. Full two-turn cycle: think → rebuild → execute
3. Reliability across N runs
4. Context overhead measurement

Usage:
    python benchmark/test_tool_gating.py [--runs N]
"""

import argparse
import json
import time
import urllib.request
import urllib.error

# ── Config ─────────────────────────────────────────────

BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL_PATH = os.environ.get("MODEL_PATH", "/path/to/model.gguf")

CONTEXT_REBUILD_TOOL = {
    "type": "function",
    "function": {
        "name": "context_rebuild",
        "description": (
            "Call this FIRST with your analysis before taking any action. "
            "Always analyze the full task, then call this tool. After it "
            "confirms, proceed with execution."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "analysis": {
                    "type": "string",
                    "description": "Your step-by-step analysis of the task",
                },
                "entities_referenced": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Key entities or concepts referenced",
                },
                "estimated_tokens": {
                    "type": "integer",
                    "description": "Estimated token count needed",
                },
            },
            "required": ["analysis"],
        },
    },
}

FULL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a bash command",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read the contents of a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                },
                "required": ["path"],
            },
        },
    },
]

SYSTEM_PROMPT_GATED = (
    "You are an AI assistant. Before you take ANY action, you MUST first call "
    "the `context_rebuild` tool with your analysis of the task. After it "
    "confirms, you can proceed with other tools. Always call context_rebuild first."
)

SYSTEM_PROMPT_OPEN = (
    "You are an AI assistant. Use the available tools to complete the task."
)

TEST_PROMPTS = [
    "List all files in the current directory.",
    "Read the file called test_tool_gating.py and summarize what it does.",
    "Find all .ts files in the project structure.",
    "How many lines of code are in the mem-arch/src directory?",
]


# ── Helpers ────────────────────────────────────────────


def call_llm(messages, tools=None, tool_choice="auto", max_tokens=500, temperature=0.1):
    """Call llama-server and return the response dict."""
    body = {
        "model": MODEL_PATH,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = tool_choice

    req = urllib.request.Request(
        BASE_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.read().decode()[:200]}"}
    except Exception as e:
        return {"error": str(e)}


def extract_tool_call(response):
    """Extract first tool call from response, or None."""
    try:
        msg = response["choices"][0]["message"]
        if "tool_calls" in msg and msg["tool_calls"]:
            return msg["tool_calls"][0]
        return None
    except (KeyError, IndexError):
        return None


def extract_content(response):
    """Extract text content from response."""
    try:
        return response["choices"][0]["message"].get("content", "")
    except (KeyError, IndexError):
        return ""


def extract_usage(response):
    """Extract token usage."""
    if not isinstance(response, dict) or "error" in response:
        return {}
    try:
        return response.get("usage") or {}
    except Exception:
        return {}


# ── Test 1: Single-Tool Gating ─────────────────────────


def test_single_tool_gating(prompt):
    """Test: only context_rebuild tool available. Does model call it?"""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT_GATED},
        {"role": "user", "content": prompt},
    ]

    start = time.time()
    response = call_llm(messages, tools=[CONTEXT_REBUILD_TOOL])
    elapsed = time.time() - start

    tc = extract_tool_call(response)
    content = extract_content(response)
    usage = extract_usage(response)
    error = response.get("error")

    args = {}
    if tc:
        try:
            args = json.loads(tc["function"].get("arguments", "{}"))
        except json.JSONDecodeError:
            pass

    return {
        "prompt": prompt,
        "tool_called": tc["function"]["name"] if tc else None,
        "call_count": 1 if tc else 0,
        "has_analysis": bool(args.get("analysis")),
        "analysis": args.get("analysis", "")[:200],
        "entities": args.get("entities_referenced", []),
        "content_fallback": bool(content.strip() and not tc),
        "tokens": usage.get("total_tokens", 0),
        "elapsed_s": round(elapsed, 2),
        "error": error,
    }


# ── Test 2: Two-Turn Cycle ─────────────────────────────


def test_two_turn_cycle(prompt):
    """
    Full two-turn test:
    Turn 1: only context_rebuild -> model calls it
    Turn 2: full tools -> model executes
    """
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT_GATED},
        {"role": "user", "content": prompt},
    ]

    result = {
        "prompt": prompt,
        "turn1": None,
        "turn2": None,
        "full_cycle": False,
        "elapsed_s": 0,
    }

    start = time.time()

    # Turn 1: context_rebuild only
    t1_resp = call_llm(messages, tools=[CONTEXT_REBUILD_TOOL])
    t1_tc = extract_tool_call(t1_resp)
    t1_usage = extract_usage(t1_resp)

    if t1_tc and t1_tc["function"]["name"] == "context_rebuild":
        t1_args = "{}"
        if t1_tc["function"].get("arguments"):
            t1_args = t1_tc["function"]["arguments"]

        result["turn1"] = {
            "tool": "context_rebuild",
            "arguments": t1_args[:300],
            "tokens": t1_usage.get("total_tokens", 0),
        }

        # Simulate what extension does: add tool result, trigger turn 2
        messages.append(
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [t1_tc],
            }
        )
        messages.append(
            {
                "role": "tool",
                "content": json.dumps(
                    {
                        "status": "ok",
                        "message": "Context stored. Proceeding with execution.",
                    }
                ),
                "tool_call_id": t1_tc["id"],
            }
        )

        # Update system prompt for turn 2
        messages[0] = {
            "role": "system",
            "content": SYSTEM_PROMPT_OPEN,
        }

        # Turn 2: full tools available
        t2_resp = call_llm(messages, tools=FULL_TOOLS, max_tokens=300)
        t2_tc = extract_tool_call(t2_resp)
        t2_content = extract_content(t2_resp)
        t2_usage = extract_usage(t2_resp)

        result["turn2"] = {
            "tool_called": t2_tc["function"]["name"] if t2_tc else None,
            "tool_args": t2_tc["function"].get("arguments", "{}")[:200]
            if t2_tc
            else None,
            "content": t2_content[:200] if t2_content else "",
            "tokens": t2_usage.get("total_tokens", 0),
            "error": t2_resp.get("error"),
        }

        result["full_cycle"] = bool(t2_tc or t2_content)
        result["turn2_had_tool"] = bool(t2_tc)
    else:
        result["turn1"] = {
            "tool": None,
            "content": extract_content(t1_resp)[:200],
            "tokens": t1_usage.get("total_tokens", 0),
            "error": t1_resp.get("error"),
        }

    result["elapsed_s"] = round(time.time() - start, 2)
    return result


# ── Test 3: Reliability Run ────────────────────────────


def test_reliability(prompt, runs=5):
    """Run the single-tool gating test N times and measure consistency."""
    results = []
    for i in range(runs):
        print(f"    Run {i + 1}/{runs}...", end=" ", flush=True)
        r = test_single_tool_gating(prompt)
        results.append(r)
        status = "OK" if r["tool_called"] else "NO TOOL"
        print(f"  {r['elapsed_s']}s | Tokens: {r['tokens']} | {status}")

    calls = sum(1 for r in results if r["tool_called"] == "context_rebuild")
    analyses = sum(1 for r in results if r["has_analysis"])
    avg_tokens = sum(r["tokens"] for r in results) / len(results) if results else 0
    avg_time = sum(r["elapsed_s"] for r in results) / len(results) if results else 0
    errors = sum(1 for r in results if r.get("error"))

    return {
        "prompt": prompt,
        "runs": runs,
        "tool_call_rate": f"{calls}/{runs} ({calls / runs * 100:.0f}%)",
        "analysis_rate": f"{analyses}/{runs} ({analyses / runs * 100:.0f}%)",
        "avg_tokens": round(avg_tokens, 1),
        "avg_elapsed_s": round(avg_time, 1),
        "errors": errors,
        "runs_detail": results,
    }


# ── Test 4: Context Overhead ───────────────────────────


def test_context_overhead():
    """Measure token overhead of the context_rebuild pattern."""
    base_prompt = "What is 2+2?"

    # Baseline: no tools, no gating
    msgs_base = [
        {"role": "system", "content": SYSTEM_PROMPT_OPEN},
        {"role": "user", "content": base_prompt},
    ]
    r_base = call_llm(msgs_base, max_tokens=50)
    base_tokens = extract_usage(r_base).get("total_tokens", 0)

    # Gated: context_rebuild tool available
    msgs_gated = [
        {"role": "system", "content": SYSTEM_PROMPT_GATED},
        {"role": "user", "content": base_prompt},
    ]
    r_gated = call_llm(msgs_gated, tools=[CONTEXT_REBUILD_TOOL], max_tokens=50)
    gated_tokens = extract_usage(r_gated).get("total_tokens", 0)

    # Full two-turn
    msgs_t1 = [
        {"role": "system", "content": SYSTEM_PROMPT_GATED},
        {"role": "user", "content": base_prompt},
    ]
    r_t1 = call_llm(msgs_t1, tools=[CONTEXT_REBUILD_TOOL], max_tokens=50)
    t1_tokens = extract_usage(r_t1).get("total_tokens", 0)

    tc = extract_tool_call(r_t1)
    if tc:
        msgs_t2 = msgs_t1 + [
            {"role": "assistant", "content": None, "tool_calls": [tc]},
            {"role": "tool", "content": "{}", "tool_call_id": tc["id"]},
        ]
        msgs_t2[0] = {"role": "system", "content": SYSTEM_PROMPT_OPEN}
        r_t2 = call_llm(msgs_t2, tools=FULL_TOOLS, max_tokens=50)
        t2_tokens = extract_usage(r_t2).get("total_tokens", 0)
    else:
        t2_tokens = 0

    return {
        "baseline_tokens": base_tokens,
        "gated_tokens": gated_tokens,
        "overhead_gated": gated_tokens - base_tokens,
        "turn1_tokens": t1_tokens,
        "turn2_tokens": t2_tokens,
        "total_two_turn_tokens": t1_tokens + t2_tokens,
        "overhead_two_turn": (t1_tokens + t2_tokens) - base_tokens,
    }


# ── Main ───────────────────────────────────────────────


def print_header(text):
    print(f"\n{'=' * 60}")
    print(f"  {text}")
    print(f"{'=' * 60}")


def main():
    parser = argparse.ArgumentParser(description="Test tool gating with Qwen3.5-9B")
    parser.add_argument(
        "--runs", type=int, default=3, help="Number of reliability runs"
    )
    parser.add_argument(
        "--quick", action="store_true", help="Skip reliability and overhead tests"
    )
    args = parser.parse_args()

    print("  Tool Gating Test Harness")
    print(f"  Model: {MODEL_PATH.split('/')[-1]}")
    print(f"  Runs per reliability test: {args.runs}")

    # ── 1. Single-Tool Gating Test ──
    print_header("TEST 1: Single-Tool Gating")
    print("  Only `context_rebuild` tool available. Does the model call it?\n")

    st_results = []
    for prompt in TEST_PROMPTS:
        print(f"  Prompt: {prompt[:70]}...")
        r = test_single_tool_gating(prompt)
        if r["tool_called"]:
            print(f"    Called: {r['tool_called']}")
            print(f"    Analysis: {r['analysis'][:100]}...")
            print(f"    Tokens: {r['tokens']} | Time: {r['elapsed_s']}s")
        else:
            print("    No tool call (content fallback)")
            if r.get("error"):
                print(f"    Error: {r['error']}")
        st_results.append(r)

    call_rate = sum(1 for r in st_results if r["tool_called"])
    call_pct = call_rate / len(st_results) * 100
    print(f"\n  Single-tool call rate: {call_rate}/{len(st_results)} ({call_pct:.0f}%)")

    # ── 2. Two-Turn Cycle Test ──
    print_header("TEST 2: Two-Turn Cycle")
    print("  Turn 1: context_rebuild -> Turn 2: full tools\n")

    tt_results = []
    for prompt in TEST_PROMPTS[:2]:
        print(f"  Cycle for: {prompt[:60]}...")
        r = test_two_turn_cycle(prompt)
        if r["turn1"] and r["turn1"]["tool"]:
            print(f"    Turn 1: context_rebuild ({r['turn1']['tokens']} tok)")
        else:
            print("    Turn 1: FAILED (no rebuild call)")
        if r["turn2"]:
            tc = r["turn2"].get("tool_called")
            if tc:
                print(f"    Turn 2: {tc} ({r['turn2']['tokens']} tok)")
            elif r["turn2"].get("content"):
                print(f"    Turn 2: text only ({r['turn2']['tokens']} tok)")
            else:
                print("    Turn 2: no output")
        print(f"    Total: {r['elapsed_s']}s")
        tt_results.append(r)

    cycle_rate = sum(1 for r in tt_results if r["full_cycle"])
    print(f"\n  Full cycle completion: {cycle_rate}/{len(tt_results)}")

    # ── 3. Reliability Test ──
    if not args.quick:
        print_header("TEST 3: Reliability")
        print(f"  Running {args.runs}x per prompt...\n")

        for prompt in TEST_PROMPTS[:2]:
            print(f"  Prompt: {prompt[:50]}...")
            r = test_reliability(prompt, args.runs)
            print(f"    Call rate: {r['tool_call_rate']}")
            print(
                f"    Avg tokens: {r['avg_tokens']} | Avg time: {r['avg_elapsed_s']}s"
            )
            if r["errors"]:
                print(f"    Errors: {r['errors']}")

    # ── 4. Context Overhead ──
    if not args.quick:
        print_header("TEST 4: Context Overhead")
        print("  Token overhead of the gating pattern\n")
        ov = test_context_overhead()
        print(f"  Baseline (no gating):  {ov['baseline_tokens']} tok")
        print(f"  Gated (1 tool):        {ov['gated_tokens']} tok")
        print(f"  Overhead (gated):      +{ov['overhead_gated']} tok")
        print(f"  Turn 1 (rebuild):      {ov['turn1_tokens']} tok")
        print(f"  Turn 2 (execute):      {ov['turn2_tokens']} tok")
        print(f"  Total two-turn:        {ov['total_two_turn_tokens']} tok")
        print(f"  Overhead (two-turn):   +{ov['overhead_two_turn']} tok")

    # ── Summary ──
    print_header("SUMMARY")
    print("  Test               Result")
    print(f"  {'─' * 50}")
    print(f"  Single-tool gating {call_rate}/{len(st_results)} calls ({call_pct:.0f}%)")
    if not args.quick:
        print(f"  Two-turn cycle     {cycle_rate}/{len(tt_results)} completed")
        if st_results:
            avg_t = sum(r["tokens"] for r in st_results) / len(st_results)
            avg_s = sum(r["elapsed_s"] for r in st_results) / len(st_results)
            print(f"  Avg tokens/call    {avg_t:.0f}")
            print(f"  Avg time/call      {avg_s:.1f}s")


if __name__ == "__main__":
    main()
