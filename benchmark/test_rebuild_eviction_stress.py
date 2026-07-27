"""
test_rebuild_eviction_stress.py — Try to break the agent with realistic edge cases

Scenarios test specific failure modes:
1. Hidden dependency chain
2. Old config decision still matters
3. CI/CD config contains deployment secret
4. Ambiguous entity names
5. Recent but off-topic turns
"""

import json
import urllib.request

BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL = "/Users/femi/models/qwen3.5-9b/Qwen_Qwen3.5-9B-Q4_K_M.gguf"

CONTEXT_REBUILD_TOOL = {
    "type": "function",
    "function": {
        "name": "context_rebuild",
        "description": "Analyze the task and score each chunk's relevance from 0.0 to 1.0",
        "parameters": {
            "type": "object",
            "properties": {
                "analysis": {"type": "string", "description": "Your analysis"},
                "plan": {"type": "string", "description": "Your plan"},
                "chunk_scores": {
                    "type": "object",
                    "description": "Relevance score per chunk ID (0.0-1.0)",
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


def build_chunk_text(chunks):
    lines = []
    for ctype, name, conf, desc in chunks:
        cid = f"{ctype}_{name}"
        lines.append(f"[{cid}] ({ctype}, conf={conf:.2f}) {name}: {desc}")
    return "\n".join(lines)


SCENARIOS = [
    {
        "name": "Hidden dependency chain",
        "fail_mode": "Model drops C (Redis/deploy) because it seems irrelevant, but A→B→C",
        "chunks": [
            (
                "memory",
                "api_gateway",
                0.90,
                "API gateway handles rate limiting, auth, request routing.",
            ),
            (
                "memory",
                "rate_limiter_config",
                0.85,
                "Rate limiter uses Redis for distributed counters.",
            ),
            (
                "memory",
                "redis_cluster",
                0.80,
                "Redis cluster 3 nodes for rate limiting and session cache.",
            ),
            (
                "memory",
                "backend_service",
                0.75,
                "Main REST API. Depends on gateway for auth.",
            ),
            (
                "turn",
                "Deployed Redis cluster",
                0.70,
                "Set up Redis 3 nodes with persistence. Used by rate limiter.",
            ),
            (
                "turn",
                "Set up API gateway",
                0.65,
                "Configured Kong gateway with rate limiting pointing to Redis.",
            ),
            (
                "memory",
                "docker_compose",
                0.40,
                "Docker Compose for local dev. Has Redis port mappings rate limiter needs.",
            ),
            (
                "memory",
                "k8s_deployment",
                0.35,
                "K8s manifests for production. Separate Redis service config.",
            ),
            (
                "turn",
                "Wrote Docker Compose",
                0.30,
                "docker-compose.yml with gateway, redis, backend-service.",
            ),
        ],
        "question": "Rate limiter returning 429 too aggressively. Need to check rate limit config and Redis keys used.",
        "trap": "docker_compose and k8s chunks contain Redis config rate limiter needs",
        "critical": [
            "memory_docker_compose",
            "memory_k8s_deployment",
            "turn_Wrote Docker Compose",
        ],
        "irrelevant": [],
    },
    {
        "name": "Old config decision still matters",
        "fail_mode": "Model drops old Flask decision because old, but constrains async Redis handling",
        "chunks": [
            (
                "memory",
                "jwt_secret_config",
                0.95,
                "JWT HS256 with JWT_SECRET env var. Rotated every 90 days.",
            ),
            (
                "memory",
                "auth_service",
                0.90,
                "Auth service handles login, token refresh. Configurable TTL.",
            ),
            (
                "turn",
                "Set JWT TTL to 15 min",
                0.85,
                "Changed access token TTL from 30 to 15 min for security.",
            ),
            (
                "turn",
                "Added token blacklist",
                0.80,
                "Redis-backed blacklist on logout. Checked on every request.",
            ),
            (
                "turn",
                "Initial auth setup",
                0.75,
                "Created auth with flask-jwt-extended. Config in config.py.",
            ),
            (
                "turn",
                "Chose Flask over FastAPI",
                0.50,
                "Flask because team knows it. Must support async for Redis using flask[async]+gevent.",
            ),
            (
                "turn",
                "Set up project structure",
                0.40,
                "Flask app structure with blueprints. Config in config.py.",
            ),
            (
                "turn",
                "Updated README formatting",
                0.30,
                "Fixed markdown formatting in README. Added CI badges.",
            ),
            (
                "turn",
                "Added license file",
                0.25,
                "Added MIT license. Updated copyright year.",
            ),
        ],
        "question": "Getting 'token expired' errors though TTL should be valid. Check JWT config and blacklist implementation.",
        "trap": "Flask decision constrains async Redis handling for the blacklist",
        "critical": ["turn_Chose Flask over FastAPI", "turn_Set up project structure"],
        "irrelevant": ["turn_Updated README formatting", "turn_Added license file"],
    },
    {
        "name": "CI/CD config has staging secret",
        "fail_mode": "Drops CI/CD chunks because 'not relevant to auth', but they contain JWT_SECRET",
        "chunks": [
            (
                "memory",
                "jwt_handler",
                0.95,
                "JWT generation and validation. HS256 and RS256.",
            ),
            (
                "memory",
                "login_route",
                0.90,
                "POST /api/login. Returns access + refresh tokens.",
            ),
            (
                "turn",
                "Fixed login error handling",
                0.85,
                "Better error messages for invalid credentials.",
            ),
            (
                "turn",
                "Added token refresh",
                0.80,
                "POST /api/refresh with token rotation.",
            ),
            (
                "memory",
                "github_actions",
                0.45,
                "GitHub Actions deploy to staging with JWT_SECRET as GitHub secret.",
            ),
            (
                "turn",
                "Set up CI/CD pipeline",
                0.40,
                "Deploy workflow. Staging config has JWT_SECRET, DB_URL, REDIS_URL from secrets.",
            ),
            (
                "turn",
                "Added staging env",
                0.35,
                "Staging config overrides JWT_SECRET. Production uses different secret.",
            ),
            (
                "turn",
                "Updated footer copyright",
                0.20,
                "Changed copyright year in footer template.",
            ),
            (
                "turn",
                "Fixed typo in README",
                0.15,
                "Fixed 'recieve' to 'receive' in README.",
            ),
        ],
        "question": "Staging deployment failing. JWT tokens signed by staging can't be verified. Check JWT secret across environments.",
        "trap": "CI/CD chunks contain the STAGING JWT_SECRET config critical for debugging",
        "critical": [
            "memory_github_actions",
            "turn_Set up CI/CD pipeline",
            "turn_Added staging env",
        ],
        "irrelevant": ["turn_Updated footer copyright", "turn_Fixed typo in README"],
    },
    {
        "name": "Ambiguous 'token' entity names",
        "fail_mode": "Model confuses auth token with API token for third-party",
        "chunks": [
            (
                "memory",
                "auth_token",
                0.90,
                "JWT access token for API auth. TTL 15 min. Has user_id and role claims.",
            ),
            (
                "memory",
                "api_token",
                0.85,
                "API key for third-party integration. Static, in API_KEY env var.",
            ),
            (
                "turn",
                "Implemented JWT auth",
                0.80,
                "JWT token generation, validation, refresh in Authorization header.",
            ),
            (
                "turn",
                "Integrated payment API",
                0.75,
                "Stripe payment with API key from env var. Webhook verification.",
            ),
            (
                "memory",
                "token_blacklist",
                0.70,
                "Redis blacklist for revoked JWT tokens. Key: blacklist:{jti}.",
            ),
            (
                "memory",
                "stripe_webhook",
                0.65,
                "Stripe webhook signing secret for payload verification.",
            ),
            (
                "turn",
                "Added token blacklist",
                0.60,
                "On logout, add JWT jti to Redis blacklist. Checked on protected routes.",
            ),
            (
                "turn",
                "Set up webhook handler",
                0.55,
                "Stripe webhook endpoint. Verifies signature with webhook secret.",
            ),
        ],
        "question": "Tokens rejected as invalid. Check the token blacklist implementation for revoked token storage.",
        "trap": "Model needs auth_token + token_blacklist, not api_token or stripe",
        "critical": [
            "memory_auth_token",
            "memory_token_blacklist",
            "turn_Added token blacklist",
        ],
        "irrelevant": [],
    },
    {
        "name": "Recent but off-topic turns",
        "fail_mode": "Model keeps recent CSS/landing page turns because recent, though irrelevant",
        "chunks": [
            (
                "memory",
                "database_schema",
                0.90,
                "PostgreSQL: users, posts, comments. UUID PKs.",
            ),
            (
                "memory",
                "user_model",
                0.85,
                "SQLAlchemy User: email, password_hash, timestamps.",
            ),
            (
                "turn",
                "Created users migration",
                0.80,
                "Alembic migration for users. Indexes on email.",
            ),
            (
                "turn",
                "Added post model",
                0.75,
                "Post with title, body, author_id. Full-text search.",
            ),
            (
                "turn",
                "Added comment model",
                0.70,
                "Comment with body, author_id, post_id. Paginated API.",
            ),
            (
                "turn",
                "Updated company logo",
                0.30,
                "Replaced logo SVG. Navbar height. Primary color change.",
            ),
            (
                "turn",
                "Changed hero text",
                0.25,
                "Landing page hero copy. CTA button. Mobile fixes.",
            ),
            (
                "turn",
                "Fixed CSS grid",
                0.20,
                "3-column to 1-column on mobile. Media query at 768px.",
            ),
            (
                "turn",
                "Added analytics",
                0.15,
                "Google Analytics. Page views and button clicks.",
            ),
        ],
        "question": "Need a 'like' feature for posts. Each user can like a post once. What models and migrations needed?",
        "trap": "CSS/landing page turns are recent but completely irrelevant",
        "critical": [],
        "irrelevant": [
            "turn_Updated company logo",
            "turn_Changed hero text",
            "turn_Fixed CSS grid",
            "turn_Added analytics",
        ],
    },
]


def call_llm(messages, tools=None, max_tokens=600):
    body = {
        "model": MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.1,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    req = urllib.request.Request(
        BASE_URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def extract_tool_call(response):
    try:
        tcs = response["choices"][0]["message"].get("tool_calls")
        return tcs[0] if tcs else None
    except (KeyError, IndexError):
        return None


def main():
    print("=" * 70)
    print("  STRESS TEST: Try to Break the Scoring System")
    print("=" * 70)

    all_results = []

    for si, scenario in enumerate(SCENARIOS):
        print(f"\n{'─' * 70}")
        print(f"  SCENARIO {si + 1}: {scenario['name']}")
        print(f"  Fail mode: {scenario['fail_mode']}")
        print(f"  Trap: {scenario['trap']}")
        print(f"{'─' * 70}")

        chunk_text = build_chunk_text(scenario["chunks"])
        critical_ids = set(scenario["critical"])
        irrelevant_ids = set(scenario["irrelevant"])

        for run_num in range(3):
            msgs = [
                {
                    "role": "system",
                    "content": "You are a senior engineer. Call context_rebuild to score each chunk's relevance to the task.",
                },
                {
                    "role": "user",
                    "content": f"## Context\n\n{chunk_text}\n\n## Task\n{scenario['question']}",
                },
            ]

            r = call_llm(msgs, [CONTEXT_REBUILD_TOOL])
            if "error" in r:
                print(f"    Run {run_num + 1}: ERROR")
                continue

            tc = extract_tool_call(r)
            if not tc:
                print(f"    Run {run_num + 1}: No tool call")
                continue

            try:
                args = json.loads(tc["function"]["arguments"])
            except json.JSONDecodeError:
                print(f"    Run {run_num + 1}: JSON parse error in tool arguments")
                continue
            scores = args.get("chunk_scores", {})
            analysis = args.get("analysis", "")[:120]

            kept = {cid: float(s) for cid, s in scores.items() if float(s) >= 0.3}
            evicted = {cid: float(s) for cid, s in scores.items() if float(s) < 0.3}

            # Debug: show what IDs exist
            all_scored = set(scores.keys())

            # Check critical chunks — match by checking if critical ID is CONTAINED in scored IDs
            # (because model might use slightly different naming)
            critical_kept = []
            critical_lost = []
            for cid in critical_ids:
                # Check exact match or substring match
                found_in_kept = any(
                    cid.replace("_", " ") in k or k in cid or cid == k for k in kept
                )
                found_in_evicted = any(
                    cid.replace("_", " ") in k or k in cid or cid == k for k in evicted
                )
                if found_in_evicted:
                    critical_lost.append(cid)
                elif found_in_kept or not any(
                    cid.replace("_", " ") in k or k in cid or cid == k
                    for k in all_scored
                ):
                    critical_kept.append(cid)

            irrelevant_evicted = []
            irrelevant_kept = []
            for cid in irrelevant_ids:
                found_in_evicted = any(
                    cid.replace("_", " ") in k or k in cid or cid == k for k in evicted
                )
                found_in_kept = any(
                    cid.replace("_", " ") in k or k in cid or cid == k for k in kept
                )
                if found_in_evicted:
                    irrelevant_evicted.append(cid)
                elif found_in_kept:
                    irrelevant_kept.append(cid)
            irrelevant_evicted = [c for c in irrelevant_ids if c in evicted]
            irrelevant_kept = [c for c in irrelevant_ids if c in kept]

            trap_hit = len(critical_lost) > 0
            trash_missed = len(irrelevant_kept) > 0
            broke = trap_hit or trash_missed

            status = "BROKEN" if broke else "OK"
            print(f"    Run {run_num + 1}: {status}")
            print(f"      Analysis: {analysis}...")
            print(f"      Critical kept: {critical_kept}")
            if critical_lost:
                print(f"      ❌ CRITICAL LOST: {critical_lost}")
            if irrelevant_kept:
                print(f"      ⚠️ IRRELEVANT KEPT: {irrelevant_kept}")
            if irrelevant_evicted:
                print(f"      ✅ Trash evicted: {irrelevant_evicted}")

            all_results.append(
                {
                    "scenario": scenario["name"],
                    "run": run_num + 1,
                    "broke": broke,
                    "critical_kept": len(critical_kept),
                    "critical_lost": len(critical_lost),
                    "irrelevant_evicted": len(irrelevant_evicted),
                    "irrelevant_kept": len(irrelevant_kept),
                    "total_kept": len(kept),
                    "total_evicted": len(evicted),
                }
            )

    # Summary
    print(f"\n{'=' * 70}")
    print("  SUMMARY")
    print(f"{'=' * 70}")
    broke_count = sum(1 for r in all_results if r["broke"])
    total = len(all_results)
    print(f"  Runs: {total}")
    print(f"  BROKEN: {broke_count}/{total} ({broke_count / total * 100:.0f}%)")
    print(
        f"  OK: {total - broke_count}/{total} ({(total - broke_count) / total * 100:.0f}%)"
    )

    critical_lost_total = sum(r["critical_lost"] for r in all_results)
    critical_total = sum(
        len(set(SCENARIOS[si // 3]["critical"])) for si in range(total)
    )
    irrelevant_kept_total = sum(r["irrelevant_kept"] for r in all_results)
    irrelevant_total = sum(
        len(set(SCENARIOS[si // 3]["irrelevant"])) for si in range(total)
    )

    print(f"\n  Critical chunks lost: {critical_lost_total}/{critical_total}")
    print(f"  Irrelevant chunks kept: {irrelevant_kept_total}/{irrelevant_total}")
    print(
        f"  Avg kept per run: {sum(r['total_kept'] for r in all_results) / total:.0f}"
    )
    print(
        f"  Avg evicted per run: {sum(r['total_evicted'] for r in all_results) / total:.0f}"
    )


if __name__ == "__main__":
    main()
