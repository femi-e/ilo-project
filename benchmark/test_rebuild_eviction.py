"""
test_rebuild_eviction.py — Two-turn context rebuild with model-guided eviction

Based on research:
- SELFCOMPACT: model decides what to evict
- SWE-Pruner Pro: model already knows what's relevant
- Proprioceptive Dashboard: show model what's in its context
"""

import json
import urllib.request
import sys

BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL = "/Users/femi/models/qwen3.5-9b/Qwen_Qwen3.5-9B-Q4_K_M.gguf"

# ── Build a mixed-context test scenario ────────────────

# Relevant chunks (about JWT auth in Flask)
RELEVANT_CHUNKS = [
    (
        "memory",
        "jwt_handler",
        0.95,
        "Handles JWT token generation, validation, and refresh rotation. Used by auth middleware and login route.",
    ),
    (
        "memory",
        "login_route",
        0.88,
        "POST /api/login endpoint that authenticates users and returns JWT tokens.",
    ),
    (
        "memory",
        "auth_middleware",
        0.85,
        "Protects routes by verifying JWT tokens in Authorization headers.",
    ),
    (
        "turn",
        "Added JWT auth support",
        0.82,
        "Created jwt_handler.py with generate_token(), validate_token(), refresh_token(). Added middleware. All tests passing.",
    ),
    (
        "turn",
        "Designed user model",
        0.78,
        "User model with bcrypt password hashing, email field, timestamps. Linked to auth system.",
    ),
]

# Irrelevant chunks (about deployment, CSS, old feature)
IRRELEVANT_CHUNKS = [
    (
        "memory",
        "ci_cd_pipeline",
        0.60,
        "GitHub Actions workflow for running tests and deploying to staging on push to main.",
    ),
    (
        "memory",
        "css_theme",
        0.55,
        "Dark mode CSS theme with custom color variables and responsive breakpoints.",
    ),
    (
        "memory",
        "old_feature_x",
        0.45,
        "Deprecated feature for CSV import that was replaced by the API import endpoint.",
    ),
    (
        "turn",
        "Set up CI/CD pipeline",
        0.65,
        "Created .github/workflows/deploy.yml. Tests run in 2m30s. Deploy to staging via SSH.",
    ),
    (
        "turn",
        "Added dark mode toggle",
        0.58,
        "Added CSS variables for dark theme. Toggle button in header. Persists to localStorage.",
    ),
    (
        "turn",
        "Built CSV import feature",
        0.42,
        "CSV parsing with pandas, validation, batch insert to DB. Deprecated in favor of API.",
    ),
]

CONTEXT_REBUILD_TOOL = {
    "type": "function",
    "function": {
        "name": "context_rebuild",
        "description": (
            "Analyze the current context and task. Score each chunk's relevance "
            "to the current task on a scale of 0.0 (completely irrelevant) to 1.0 (essential). "
            "Then provide your analysis and plan."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "analysis": {
                    "type": "string",
                    "description": "Your analysis of the task and what context is needed",
                },
                "plan": {
                    "type": "string",
                    "description": "Step-by-step plan to complete the task",
                },
                "chunk_scores": {
                    "type": "object",
                    "description": "Relevance score for each chunk ID (0.0-1.0)",
                    "additionalProperties": {
                        "type": "number",
                        "minimum": 0.0,
                        "maximum": 1.0,
                    },
                },
            },
            "required": ["analysis", "plan", "chunk_scores"],
        },
    },
}

FULL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute bash",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read file",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
]

EXECUTION_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute bash",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string"}},
                "required": ["command"],
            },
        },
    },
]

QUESTIONS = [
    "I need to fix the token refresh endpoint. Can you look at the jwt_handler and make sure refresh tokens are being rotated correctly?",
    "The login endpoint is returning a 500 error on invalid credentials. Can you debug the auth middleware?",
    "We need to add a logout endpoint that invalidates the user's current token. How should this work?",
]


def build_chunk_text(chunks):
    lines = []
    for i, (ctype, name, conf, desc) in enumerate(chunks):
        cid = f"{ctype}_{name}"
        lines.append(f"[{cid}] ({ctype}, conf={conf:.2f}) {name}: {desc}")
    return "\n".join(lines), [f"{ctype}_{name}" for ctype, name, conf, desc in chunks]


def build_dashboard(chunks):
    """Build a dashboard showing the model what's in its context"""
    lines = ["## Context Dashboard", f"Total chunks: {len(chunks)}", ""]
    for i, (ctype, name, conf, desc) in enumerate(chunks):
        cid = f"{ctype}_{name}"
        lines.append(
            f"  {cid}: type={ctype}, confidence={conf:.2f}, size={len(desc)} chars"
        )
    return "\n".join(lines)


def call_llm(messages, tools=None, max_tokens=500, tool_choice="auto"):
    body = {
        "model": MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.1,
        "chat_template_kwargs": {"enable_thinking": False},
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
            data = json.loads(resp.read())
        return data
    except Exception as e:
        return {"error": str(e)}


def extract_tool_call(response):
    try:
        msg = response["choices"][0]["message"]
        tcs = msg.get("tool_calls")
        if tcs:
            return tcs[0]
        return None
    except (KeyError, IndexError):
        return None


def extract_content(response):
    try:
        return response["choices"][0]["message"].get("content", "")
    except (KeyError, IndexError):
        return ""


def test_scenario(question, relevant, irrelevant):
    """Test one scenario: context_rebuild → evict → execute"""
    chunks = relevant + irrelevant
    chunk_text, chunk_ids = build_chunk_text(chunks)
    dashboard = build_dashboard(chunks)

    # ── Turn 1: context_rebuild ──
    turn1_messages = [
        {
            "role": "system",
            "content": "You are a Flask expert. Call context_rebuild to analyze the task and score each chunk's relevance.",
        },
        {
            "role": "user",
            "content": f"## Current Context\n\n{chunk_text}\n\n{dashboard}\n\n## Task\n{question}",
        },
    ]

    r1 = call_llm(turn1_messages, [CONTEXT_REBUILD_TOOL], max_tokens=600)
    if "error" in r1:
        return {"error": r1["error"]}

    tc1 = extract_tool_call(r1)
    if not tc1:
        return {"error": "no tool call", "content": extract_content(r1)}

    args = json.loads(tc1["function"]["arguments"])
    scores = args.get("chunk_scores", {})
    analysis = args.get("analysis", "")
    plan = args.get("plan", "")
    t1_tokens = r1.get("usage", {}).get("total_tokens", 0)

    # Apply scores: keep chunks above threshold
    threshold = 0.3
    kept_chunks = []
    evicted_chunks = []
    for cid, score in scores.items():
        score_val = float(score) if isinstance(score, (int, float)) else 0.0
        # Find the chunk
        for ch in chunks:
            ctype, name, conf, desc = ch
            if f"{ctype}_{name}" == cid:
                if score_val >= threshold:
                    kept_chunks.append(ch)
                else:
                    evicted_chunks.append((cid, score_val, ch))
                break

    # Also keep chunks the model didn't score (default: keep)
    scored_ids = set(scores.keys())
    for ch in chunks:
        ctype, name, conf, desc = ch
        cid = f"{ctype}_{name}"
        if cid not in scored_ids:
            kept_chunks.append(ch)

    # Build evicted context
    kept_text, kept_ids = build_chunk_text(kept_chunks)

    # ── Turn 2: Execute with cleaned context ──
    turn2_messages = [
        {
            "role": "system",
            "content": "You are a Flask expert. Use the available tools to complete the task.",
        },
        {
            "role": "assistant",
            "content": f"[Context rebuilt based on relevance analysis]\n\nRelevant context:\n{kept_text}",
        },
        {"role": "user", "content": question},
    ]

    r2 = call_llm(turn2_messages, EXECUTION_TOOLS, max_tokens=300)
    if "error" in r2:
        return {"error": r2["error"]}

    tc2 = extract_tool_call(r2)
    t2_tokens = r2.get("usage", {}).get("total_tokens", 0)

    # Score: did the model correctly identify relevant vs irrelevant?
    relevant_ids = set()
    for ch in relevant:
        ctype, name, conf, desc = ch
        relevant_ids.add(f"{ctype}_{name}")

    correctly_kept = sum(1 for cid, _, _ in evicted_chunks if cid not in relevant_ids)
    incorrectly_evicted = sum(1 for cid, _, _ in evicted_chunks if cid in relevant_ids)
    total_relevant = len(relevant)

    relevance_accuracy = (
        (total_relevant - incorrectly_evicted) / total_relevant
        if total_relevant > 0
        else 0
    )
    eviction_precision = correctly_kept / len(evicted_chunks) if evicted_chunks else 1.0

    return {
        "analysis": analysis[:200],
        "plan": plan[:200],
        "raw_scores": scores,
        "kept_count": len(kept_chunks),
        "evicted_count": len(evicted_chunks),
        "correctly_evicted_irrelevant": correctly_kept,
        "incorrectly_evicted_relevant": incorrectly_evicted,
        "relevance_accuracy": relevance_accuracy,
        "eviction_precision": eviction_precision,
        "turn2_used_tool": bool(tc2),
        "turn2_tool_name": tc2["function"]["name"] if tc2 else None,
        "t1_tokens": t1_tokens,
        "t2_tokens": t2_tokens,
    }


def main():
    print("=" * 70)
    print("  TEST: Two-Turn Context Rebuild with Model-Guided Eviction")
    print("  Research-backed: SELFCOMPACT + SWE-Pruner Pro + Dashboard")
    print("=" * 70)

    all_results = []

    for qi, question in enumerate(QUESTIONS):
        print(f"\n{'─' * 70}")
        print(f'  Scenario {qi + 1}: "{question[:60]}..."')
        print(f"  {'─' * 70}")
        print(
            f"  Context: {len(RELEVANT_CHUNKS)} relevant + {len(IRRELEVANT_CHUNKS)} irrelevant chunks"
        )

        for run in range(3):
            result = test_scenario(question, RELEVANT_CHUNKS, IRRELEVANT_CHUNKS)
            all_results.append(result)

            if "error" in result:
                print(f"    Run {run + 1}: ERROR - {result['error'][:60]}")
                continue

            print(f"\n    Run {run + 1}:")
            print(f"      Analysis: {result['analysis'][:80]}...")
            print(
                f"      Scores: {json.dumps({k: round(float(v), 2) for k, v in result['raw_scores'].items()})}"
            )
            print(
                f"      Kept: {result['kept_count']} | Evicted: {result['evicted_count']}"
            )
            print(
                f"      Correctly evicted irrelevant: {result['correctly_evicted_irrelevant']}"
            )
            print(
                f"      Incorrectly evicted relevant: {result['incorrectly_evicted_relevant']}"
            )
            print(f"      Relevance accuracy: {result['relevance_accuracy']:.2f}")
            print(f"      Eviction precision: {result['eviction_precision']:.2f}")
            print(f"      Turn 2: {result['turn2_tool_name'] or 'text only'}")
            print(f"      Tokens: T1={result['t1_tokens']} T2={result['t2_tokens']}")
            sys.stdout.flush()

    # Summary
    print(f"\n{'=' * 70}")
    print("  SUMMARY")
    print(f"{'=' * 70}")

    valid = [r for r in all_results if "error" not in r]
    if valid:
        avg_acc = sum(r["relevance_accuracy"] for r in valid) / len(valid)
        avg_prec = sum(r["eviction_precision"] for r in valid) / len(valid)
        avg_evicted = sum(r["evicted_count"] for r in valid) / len(valid)
        total_irrelevant_evicted = sum(r["correctly_evicted_irrelevant"] for r in valid)
        total_relevant_lost = sum(r["incorrectly_evicted_relevant"] for r in valid)
        total_t1_tokens = sum(r["t1_tokens"] for r in valid)
        total_t2_tokens = sum(r["t2_tokens"] for r in valid)

        print(f"  Runs: {len(valid)}")
        print(
            f"  Avg relevance accuracy: {avg_acc:.2f} (higher = kept relevant chunks)"
        )
        print(
            f"  Avg eviction precision: {avg_prec:.2f} (higher = evicted irrelevant chunks)"
        )
        print(f"  Avg chunks evicted per run: {avg_evicted:.0f}")
        print(f"  Total irrelevant correctly evicted: {total_irrelevant_evicted}")
        print(f"  Total relevant incorrectly evicted: {total_relevant_lost}")
        print(f"  Total tokens: T1={total_t1_tokens} T2={total_t2_tokens}")
        print(f"  Token overhead per cycle: {total_t1_tokens // len(valid)}")
    else:
        print("  No valid results")


if __name__ == "__main__":
    main()
