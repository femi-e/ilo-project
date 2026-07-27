"""
test_relationship_mapping.py — Test if the 7-category taxonomy correctly maps real LLM relationships

Takes real conversation samples, extracts relationships with the 7-type taxonomy,
and validates that every relationship fits a category.
"""

import json
import urllib.request
import os
from collections import Counter

BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL = "/Users/femi/models/qwen3.5-9b/Qwen_Qwen3.5-9B-Q4_K_M.gguf"

# ── The 7 categories ──────────────────────────────────

CATEGORIES = [
    "Depends",
    "Intends",
    "Implements",
    "Contains",
    "Relates",
    "References",
    "Precedes",
]

CATEGORY_DESCRIPTIONS = {
    "Depends": "A requires B, A depends on B, A uses B, A needs B",
    "Intends": "User wants to X, User aims to X, User intends to X",
    "Implements": "A implements B, A creates B, A builds B, A writes B",
    "Contains": "A contains B, A has B, A is part of B, A belongs to B",
    "Relates": "A is similar to B, A is related to B, A differs from B",
    "References": "A calls B, A invokes B, A references B, A mentions B",
    "Precedes": "A precedes B, A follows B, A happens before B",
}

# ── Tool with category field ──────────────────────────

EXTRACTION_TOOL = {
    "type": "function",
    "function": {
        "name": "extract_claims",
        "description": "Extract entity relationships with category mapping",
        "parameters": {
            "type": "object",
            "properties": {
                "claims": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "subject": {"type": "string"},
                            "relationship_raw": {
                                "type": "string",
                                "description": "The actual relationship text as written",
                            },
                            "object": {"type": "string"},
                            "category": {
                                "type": "string",
                                "enum": CATEGORIES,
                                "description": f"The abstract category this relationship belongs to. Options: {', '.join(CATEGORIES)}. Description: {json.dumps(CATEGORY_DESCRIPTIONS)}",
                            },
                            "confidence": {"type": "number"},
                        },
                        "required": [
                            "subject",
                            "relationship_raw",
                            "object",
                            "category",
                            "confidence",
                        ],
                    },
                },
            },
            "required": ["claims"],
        },
    },
}

# ── Get real conversation samples ─────────────────────


def get_samples():
    session_dir = os.path.expanduser(
        "~/.pi/agent/sessions/--Users-femi-Documents-ilo--/"
    )
    sessions = sorted([f for f in os.listdir(session_dir) if f.endswith(".jsonl")])
    samples = []

    for s in sessions[-3:]:
        f = os.path.join(session_dir, s)
        entries = []
        with open(f) as fh:
            for line in fh:
                try:
                    entries.append(json.loads(line))
                except:
                    pass

        msgs = [e.get("message", {}) for e in entries if e.get("type") == "message"]
        texts = []
        for msg in msgs:
            role = msg.get("role", "")
            content = msg.get("content", [])
            if not isinstance(content, list):
                continue
            text = "".join(
                item.get("text", "")
                for item in content
                if isinstance(item, dict) and item.get("type") == "text"
            ).strip()
            if role in ("user", "assistant") and 200 < len(text) < 1000:
                texts.append(f"{role.upper()}: {text}")

        # Take 3 exchanges per session
        for t in texts[:3]:
            samples.append({"session": s[:40], "text": t})

    return samples


def call_llm(messages):
    body = {
        "model": MODEL,
        "messages": messages,
        "tools": [EXTRACTION_TOOL],
        "tool_choice": "auto",
        "max_tokens": 1000,
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
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def main():
    print("=" * 70)
    print("  TEST: 7-Category Relationship Mapping")
    print("  Validating that LLM relationships fit the taxonomy")
    print("=" * 70)

    samples = get_samples()
    print(f"\n  Testing {len(samples)} conversation samples\n")

    all_claims = []
    category_counts = Counter()
    unmapped = []  # relationships that don't fit any category

    for i, sample in enumerate(samples):
        print(f"  Sample {i + 1}/{len(samples)}: {sample['session']}")
        print(f"  Text: {sample['text'][:80]}...")

        r = call_llm(
            [
                {
                    "role": "system",
                    "content": f"Extract entity relationships from this conversation. Classify each into one of: {', '.join(CATEGORIES)}. {json.dumps(CATEGORY_DESCRIPTIONS)}",
                },
                {"role": "user", "content": sample["text"]},
            ]
        )

        if "error" in r:
            print(f"    ERROR: {r['error'][:60]}")
            continue

        msg = r["choices"][0]["message"]
        tcs = msg.get("tool_calls")
        if not tcs:
            print("    No tool call")
            continue

        try:
            args = json.loads(tcs[0]["function"]["arguments"])
        except json.JSONDecodeError:
            print("    JSON parse error")
            continue

        claims = args.get("claims", [])
        all_claims.extend(claims)

        for c in claims:
            cat = c.get("category", "?")
            rel = c.get("relationship_raw", "?")
            s = c.get("subject", "?")
            o = c.get("object", "?")
            conf = c.get("confidence", 0)

            category_counts[cat] += 1

            if cat not in CATEGORIES:
                unmapped.append(rel)
                print(f'    ❌ UNMAPPED: "{rel}" (category: {cat})')
            else:
                print(f"    ✅ [{cat:12s}] {s} --[{rel}]--> {o} (conf={conf:.2f})")

        print()

    # ── Summary ──
    print(f"\n{'=' * 70}")
    print("  SUMMARY")
    print(f"{'=' * 70}")
    print(f"  Total claims extracted: {len(all_claims)}")
    print()

    if all_claims:
        print("  Category distribution:")
        max_cat_len = max(len(c) for c in CATEGORIES)
        for cat in CATEGORIES:
            count = category_counts.get(cat, 0)
            pct = count / len(all_claims) * 100
            bar = "█" * max(1, int(pct / 5))
            print(f"    {cat:<{max_cat_len}s}: {count:3d} ({pct:5.1f}%) {bar}")

        print()
        if unmapped:
            print(f"  ❌ UNMAPPED RELATIONSHIPS ({len(unmapped)}):")
            for r in unmapped:
                print(f'    - "{r}"')
        else:
            print(f"  ✅ ALL {len(all_claims)} relationships mapped to a category")

        print()

        # Show which categories were never used
        unused = [c for c in CATEGORIES if category_counts.get(c, 0) == 0]
        if unused:
            print(f"  ⚠️  Unused categories: {unused}")
        else:
            print("  ✅ All 7 categories were used")


if __name__ == "__main__":
    main()
