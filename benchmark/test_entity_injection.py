"""
test_entity_injection.py — Test how entity/claim injection location affects model behavior

Tests 5 questions × 2 methods × 10 runs = 100 LLM calls

Questions probe:
1. Does the model use injected entity info?
2. Does injection location matter?
3. Does the model prefer system vs user-prompt injection?
"""

import json
import urllib.request
import sys

BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL = os.environ.get("MODEL_PATH", "/path/to/model.gguf")

# ── Test entities and claims ───────────────────────────

ENTITIES = """
- jwt_handler (0.95) — handles JWT token generation and validation
- login_route (0.88) — POST /api/login endpoint
- auth_middleware (0.85) — protects routes via token verification
- user_model (0.82) — SQLAlchemy User model with hashed passwords
- token_refresh (0.78) — refresh token rotation logic
"""

CLAIMS = """
- login_route depends_on jwt_handler
- auth_middleware depends_on jwt_handler
- user_model depends_on bcrypt hashing
- token_refresh depends_on jwt_handler
"""

SYSTEM_CONTEXT = f"""
## Memory Context

### Known Entities:
{ENTITIES}

### Known Relationships:
{CLAIMS}
"""

USER_CONTEXT = f"""
[Context from previous work:]
The app uses JWT authentication. Here are the known components:

Entities:{ENTITIES}
Claims:{CLAIMS}

Now, continuing the task:
"""

# ── 5 Test Questions ───────────────────────────────────

QUESTIONS = [
    # Q1: Direct entity reference — does the model use the entity info?
    {
        "id": "entity_reference",
        "question": "I need to add a new endpoint that returns the current user's profile. What files do I need to modify?",
        "expects_entity_use": True,
        "expects": ["jwt_handler", "auth_middleware", "login_route", "user_model"],
    },
    # Q2: Claim/relationship — does the model understand dependencies?
    {
        "id": "dependency_chain",
        "question": "If I change how tokens are generated, which other components will be affected?",
        "expects_entity_use": True,
        "expects": ["jwt_handler", "auth_middleware", "login_route", "token_refresh"],
    },
    # Q3: Contradictory info — does the model prefer injected info over its own knowledge?
    {
        "id": "override_test",
        "question": "What authentication library is being used in this project?",
        "expects_entity_use": True,
        "expects": ["jwt_handler"],
    },
    # Q4: Procedural — does the model follow instructions about the entities?
    {
        "id": "procedural",
        "question": "Walk me through the flow of a user logging in and getting a token.",
        "expects_entity_use": True,
        "expects": ["login_route", "jwt_handler", "user_model", "token_refresh"],
    },
    # Q5: Negative test — does the model avoid hallucinating entities that aren't there?
    {
        "id": "negative_test",
        "question": "What database is being used? Is it PostgreSQL or MySQL?",
        "expects_entity_use": False,  # Entity info doesn't specify DB
        "expects": [],  # Should not confidently claim either
    },
]


def call_llm(messages, max_tokens=300):
    body = {
        "model": MODEL,
        "messages": messages,
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


def score_response(response, expected_terms):
    """Score 0-1 based on how many expected terms appear in response"""
    if not response or response.startswith("[ERROR"):
        return 0.0, []
    found = [t for t in expected_terms if t.lower() in response.lower()]
    if not expected_terms:
        return 1.0, []
    return len(found) / len(expected_terms), found


def run_test():
    results = {"system_prompt": [], "user_prompt": []}

    for method, label in [("system_prompt", "SYSTEM PROMPT INJECTION"), ("user_prompt", "USER PROMPT INJECTION")]:
        print(f"\n{'='*70}")
        print(f"  METHOD: {label}")
        print(f"{'='*70}")

        for q in QUESTIONS:
            print(f"\n  Q{q['id']}: \"{q['question'][:60]}...\"")

            for run in range(10):
                if method == "system_prompt":
                    messages = [
                        {"role": "system", "content": f"You are a coding assistant with knowledge of the current project.\n\n{SYSTEM_CONTEXT}"},
                        {"role": "user", "content": q["question"]},
                    ]
                else:
                    messages = [
                        {"role": "system", "content": "You are a coding assistant."},
                        {"role": "user", "content": f"{USER_CONTEXT}\n\n{q['question']}"},
                    ]

                response, tokens = call_llm(messages)
                score, found = score_response(response, q["expects"])
                hallucinated = False
                if not q["expects_entity_use"]:
                    # Check if model hallucinated a DB answer
                    hallucinated = any(t in response.lower() for t in ["postgresql", "postgres", "mysql"])

                results[method].append({
                    "question_id": q["id"],
                    "run": run + 1,
                    "score": score,
                    "found_terms": found,
                    "hallucinated": hallucinated,
                    "tokens": tokens,
                    "response_preview": response[:100],
                })

                status = f"score={score:.2f}"
                if found:
                    status += f" found={found}"
                if hallucinated:
                    status += " HALLUCINATED"
                print(f"    Run {run+1:2d}: {status} ({tokens} tok)")
                sys.stdout.flush()

        print()

    # Summary
    print(f"\n{'='*70}")
    print("  SUMMARY")
    print(f"{'='*70}")

    for method, label in [("system_prompt", "SYSTEM PROMPT"), ("user_prompt", "USER PROMPT")]:
        scores = [r["score"] for r in results[method]]
        avg_score = sum(scores) / len(scores)
        hallucinations = sum(1 for r in results[method] if r.get("hallucinated"))
        avg_tokens = sum(r["tokens"] for r in results[method]) / len(results[method])

        print(f"\n  {label}:")
        print(f"    Avg score: {avg_score:.3f}")
        print(f"    Hallucinations: {hallucinations}/{len(results[method])}")
        print(f"    Avg tokens: {avg_tokens:.0f}")

        # Per question
        for q in QUESTIONS:
            q_scores = [r["score"] for r in results[method] if r["question_id"] == q["id"]]
            q_avg = sum(q_scores) / len(q_scores) if q_scores else 0
            print(f"    Q{q['id']}: avg={q_avg:.3f} ({len(q_scores)} runs)")


if __name__ == "__main__":
    run_test()
