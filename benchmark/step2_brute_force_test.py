"""
step2_brute_force_test.py — Validate 7 categories against 100+ real queries
Tests: coverage, distribution, confusion, test-retest reliability (Cohen's Kappa)
"""

import json
import urllib.request
import sys
import random
from collections import Counter, defaultdict

BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL = "/Users/femi/models/qwen3.5-9b/Qwen_Qwen3.5-9B-Q4_K_M.gguf"

CATEGORIES = [
    "Depends",
    "Intends",
    "Implements",
    "Contains",
    "Relates",
    "References",
    "Precedes",
]

EXTRACTION_TOOL = {
    "type": "function",
    "function": {
        "name": "extract_relationships",
        "description": "Extract entity relationships from this text and classify each into one of 7 categories",
        "parameters": {
            "type": "object",
            "properties": {
                "relationships": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "subject": {"type": "string"},
                            "relationship": {
                                "type": "string",
                                "description": "The raw relationship text",
                            },
                            "object": {"type": "string"},
                            "category": {
                                "type": "string",
                                "enum": CATEGORIES,
                                "description": "Depends=A requires B. Intends=user wants to X. Implements=A creates B. Contains=A has B. Relates=A is similar to B. References=A calls B. Precedes=A happens before B.",
                            },
                            "confidence": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 1,
                            },
                        },
                        "required": [
                            "subject",
                            "relationship",
                            "object",
                            "category",
                            "confidence",
                        ],
                    },
                },
            },
            "required": ["relationships"],
        },
    },
}


def load_queries(filepath="benchmark/query_dataset.jsonl", max_queries=150):
    queries = []
    with open(filepath) as f:
        for line in f:
            try:
                d = json.loads(line)
                queries.append(d["query"])
            except:
                pass
    random.shuffle(queries)
    return queries[:max_queries]


def call_llm(text):
    body = {
        "model": MODEL,
        "messages": [
            {
                "role": "system",
                "content": f"You are a relationship extraction system. Extract entity relationships and classify each into one of: {', '.join(CATEGORIES)}.",
            },
            {"role": "user", "content": text},
        ],
        "tools": [EXTRACTION_TOOL],
        "tool_choice": "auto",
        "max_tokens": 800,
        "temperature": 0.1,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    try:
        req = urllib.request.Request(
            BASE_URL,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def extract_relationships(response):
    try:
        tcs = response["choices"][0]["message"].get("tool_calls")
        if not tcs:
            return []
        args = json.loads(tcs[0]["function"]["arguments"])
        return args.get("relationships", [])
    except (KeyError, IndexError, json.JSONDecodeError):
        return []


def main():
    print("=" * 70)
    print("  BRUTE-FORCE TEST: 7 Categories vs Real Queries")
    print("=" * 70)

    queries = load_queries()
    print(f"\nLoaded {len(queries)} queries for testing\n")

    all_relationships = []
    category_counts = Counter()
    unmapped = []
    query_results = []
    errors = 0

    for i, query in enumerate(queries):
        print(
            f"  [{i + 1}/{len(queries)}] ({len(query)} chars): {query[:60]}...", end=" "
        )
        sys.stdout.flush()

        r = call_llm(query)
        if "error" in r:
            print("ERROR")
            errors += 1
            continue

        rels = extract_relationships(r)
        all_relationships.extend(rels)

        query_cats = Counter()
        for rel in rels:
            cat = rel.get("category", "?")
            if cat in CATEGORIES:
                category_counts[cat] += 1
                query_cats[cat] += 1
            else:
                unmapped.append((rel.get("relationship", "?"), cat, query[:50]))

        query_results.append(
            {"query": query[:80], "categories": dict(query_cats), "total": len(rels)}
        )
        print(f"{len(rels)} rels, cats={dict(query_cats)}")

    # ── Test-retest reliability (Cohen's Kappa) ──
    print(f"\n{'=' * 70}")
    print("  TEST-RETEST RELIABILITY")
    print(f"{'=' * 70}")

    retest_queries = random.sample(queries, min(30, len(queries)))
    retest_agreements = []

    for query in retest_queries:
        r1 = call_llm(query)
        r2 = call_llm(query)
        rels1 = extract_relationships(r1)
        rels2 = extract_relationships(r2)

        cats1 = [
            r.get("category", "?") for r in rels1 if r.get("category") in CATEGORIES
        ]
        cats2 = [
            r.get("category", "?") for r in rels2 if r.get("category") in CATEGORIES
        ]

        if cats1 and cats2:
            # Simple agreement: do the same categories appear?
            set1 = set(cats1)
            set2 = set(cats2)
            agreement = len(set1 & set2) / max(len(set1 | set2), 1)
            retest_agreements.append(agreement)

    avg_retest = (
        sum(retest_agreements) / len(retest_agreements) if retest_agreements else 0
    )

    # ── Report ──
    print(f"\n{'=' * 70}")
    print("  STATISTICAL REPORT")
    print(f"{'=' * 70}")

    total_rels = len(all_relationships)
    print(f"\n  Dataset: {len(queries)} queries, {total_rels} relationships extracted")
    print(f"  Errors: {errors}")

    # 1. Coverage
    mapped_count = sum(category_counts.values())
    unmapped_count = len(unmapped)
    coverage = mapped_count / max(mapped_count + unmapped_count, 1) * 100
    print("\n  [1] COVERAGE RATE")
    print(
        f"      Mapped to a category: {mapped_count}/{mapped_count + unmapped_count} ({coverage:.1f}%)"
    )
    if unmapped:
        print(f"      UNMAPPED ({unmapped_count}):")
        for rel, cat, ctx in unmapped[:10]:
            print(f'        "{rel}" -> category "{cat}" (context: {ctx}...)')

    # 2. Category distribution
    print("\n  [2] CATEGORY DISTRIBUTION")
    print(f"      {'Category':<15s} {'Count':>6s} {'Percent':>8s} {'Bar':>10s}")
    print(f"      {'-' * 42}")
    for cat in CATEGORIES:
        count = category_counts.get(cat, 0)
        pct = count / max(mapped_count, 1) * 100
        bar = "█" * max(1, int(pct / 3))
        print(f"      {cat:<15s} {count:>6d} {pct:>7.1f}% {bar}")

    # Chi-square test for uniformity
    expected = mapped_count / len(CATEGORIES) if mapped_count > 0 else 1
    chi_sq = (
        sum(
            ((category_counts.get(c, 0) - expected) ** 2) / expected for c in CATEGORIES
        )
        if expected > 0
        else 0
    )
    print(f"\n      Chi-square (uniformity test): {chi_sq:.2f}")
    print("      (Higher = more skewed distribution. 7 categories, df=6)")
    print("      Critical value at p=0.05: 12.59")
    print(
        f"      {'Skewed distribution (some categories dominate)' if chi_sq > 12.59 else 'Distribution is relatively uniform'}"
    )

    # 3. Per-query analysis
    print("\n  [3] PER-QUERY CATEGORY COUNT")
    queries_with_rels = sum(1 for q in query_results if q["total"] > 0)
    avg_per_query = sum(q["total"] for q in query_results) / max(queries_with_rels, 1)
    print(f"      Queries with relationships: {queries_with_rels}/{len(query_results)}")
    print(f"      Avg relationships per query: {avg_per_query:.1f}")

    # Distribution of category count per query
    cats_per_query = [len(q["categories"]) for q in query_results if q["total"] > 0]
    if cats_per_query:
        avg_cats = sum(cats_per_query) / len(cats_per_query)
        print(f"      Avg distinct categories per query: {avg_cats:.1f}")

    # 4. Test-retest (Cohen's Kappa approximation)
    print("\n  [4] TEST-RETEST RELIABILITY")
    print(f"      Samples: {len(retest_agreements)}")
    print(f"      Category agreement: {avg_retest:.2f}")
    if avg_retest >= 0.8:
        print(f"      Interpretation: Strong agreement (κ ≈ {avg_retest:.2f})")
    elif avg_retest >= 0.6:
        print(f"      Interpretation: Moderate agreement (κ ≈ {avg_retest:.2f})")
    else:
        print(f"      Interpretation: Weak agreement (κ ≈ {avg_retest:.2f})")

    # 5. Confusion analysis: which categories co-occur?
    print("\n  [5] CATEGORY CO-OCCURRENCE (which pairs appear together most?)")
    cooccur = defaultdict(int)
    for qr in query_results:
        cats = list(qr["categories"].keys())
        for i in range(len(cats)):
            for j in range(i + 1, len(cats)):
                pair = tuple(sorted([cats[i], cats[j]]))
                cooccur[pair] += 1

    top_pairs = sorted(cooccur.items(), key=lambda x: -x[1])[:10]
    print(f"      {'Pair':<30s} {'Co-occurrences':>15s}")
    print(f"      {'-' * 45}")
    for pair, count in top_pairs:
        print(f"      {pair[0]:>12s} + {pair[1]:<12s} {count:>15d}")

    # 6. Save full results
    results = {
        "total_queries": len(queries),
        "total_relationships": total_rels,
        "errors": errors,
        "coverage_pct": round(coverage, 1),
        "category_distribution": dict(category_counts),
        "chi_square": round(chi_sq, 2),
        "test_retest_agreement": round(avg_retest, 2),
        "unmapped": unmapped[:20],
        "avg_rels_per_query": round(avg_per_query, 1),
    }

    with open("benchmark/category_validation_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("\n  Full results saved to benchmark/category_validation_results.json")

    # Verdict
    print(f"\n{'=' * 70}")
    print("  VERDICT")
    print(f"{'=' * 70}")
    if coverage >= 95 and avg_retest >= 0.7:
        print("  ✅ 7-category taxonomy is VALID for this data")
        print(f"     Coverage: {coverage:.1f}% (target >95%)")
        print(f"     Reliability: {avg_retest:.2f} (target >0.7)")
    elif coverage >= 90:
        print("  ⚠️  7-category taxonomy is ACCEPTABLE with caveats")
        print(f"     Coverage: {coverage:.1f}% (good but has gaps)")
        print(f"     Reliability: {avg_retest:.2f}")
    else:
        print("  ❌ 7-category taxonomy needs revision")
        print(f"     Coverage: {coverage:.1f}% (too many unmapped)")
        print(f"     Reliability: {avg_retest:.2f}")


if __name__ == "__main__":
    main()
