"""Scoring framework for evaluating LLM responses against ground truth."""

import re
from typing import Any


def score_precision(response: str, ground_truth: str, test_id: str) -> int:
    """Score precision: how correct is the response?

    3 = Matches ground truth exactly
    2 = Gets the idea, minor deviation
    1 = Related but wrong direction
    0 = Hallucination or contradiction
    """
    if not response:
        return 0

    r_lower = response.lower()
    g_lower = ground_truth.lower()

    # Check for exact match or near-exact
    if response.strip() == ground_truth.strip():
        return 3

    # Check if key terms from ground truth appear in response
    gt_keywords = set(re.findall(r'\b\w+\b', g_lower))
    gt_keywords = {w for w in gt_keywords if len(w) > 3 and w not in
                   {'this', 'that', 'with', 'from', 'have', 'been', 'what', 'which', 'their', 'about'}}

    response_keywords = set(re.findall(r'\b\w+\b', r_lower))
    overlap = gt_keywords & response_keywords

    overlap_ratio = len(overlap) / max(len(gt_keywords), 1)

    if overlap_ratio >= 0.7:
        return 2
    elif overlap_ratio >= 0.3:
        return 1
    else:
        return 0


def score_recall(response: str, ground_truth: str, test_id: str) -> int:
    """Score recall: did the response miss anything important?

    3 = All relevant information present
    2 = Most information present
    1 = Key information missing
    0 = Critical information missing
    """
    if not response:
        return 0

    r_lower = response.lower()
    g_lower = ground_truth.lower()

    # Identify key entities in ground truth (capitalized words, file paths)
    gt_entities = set(re.findall(r'\b[A-Z][a-zA-Z]*\b|\b\w+\.\w+\b|\b/\S+\b', ground_truth))
    response_entities = set(re.findall(r'\b[A-Z][a-zA-Z]*\b|\b\w+\.\w+\b|\b/\S+\b', response))

    if gt_entities:
        entity_recall = len(gt_entities & response_entities) / max(len(gt_entities), 1)
    else:
        entity_recall = 1.0

    # Check for negation words that indicate missing info
    missing_indicators = ["no", "not", "don't", "can't", "unsure", "unknown", "don't know"]
    has_missing = any(w in r_lower.split() for w in missing_indicators)

    if has_missing:
        return 0
    elif entity_recall >= 0.8:
        return 3
    elif entity_recall >= 0.5:
        return 2
    elif entity_recall >= 0.2:
        return 1
    else:
        return 0


def final_score(precision: int, recall: int) -> float:
    """Combine precision and recall into a single 0-3 score."""
    return (precision + recall) / 2.0


def score_result(result: dict[str, Any]) -> dict[str, Any]:
    """Score a single test result using both precision and recall."""
    response = result.get("response", "")
    ground_truth = result.get("ground_truth", "")
    test_id = result.get("test_id", "")

    if not ground_truth:
        # No ground truth available = can't score automatically
        return {**result, "precision": None, "recall": None, "final_score": None}

    prec = score_precision(response, ground_truth, test_id)
    rec = score_recall(response, ground_truth, test_id)
    final = final_score(prec, rec)

    return {
        **result,
        "precision": prec,
        "recall": rec,
        "final_score": round(final, 1),
    }


def score_all_results(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Score all test results."""
    return [score_result(r) for r in results]


def summarize_results(scored_results: list[dict[str, Any]]) -> dict[str, Any]:
    """Generate a summary of results grouped by technique."""
    from collections import defaultdict

    by_technique = defaultdict(list)
    for r in scored_results:
        by_technique[r["technique"]].append(r)

    summary = {}
    for tech, results in sorted(by_technique.items()):
        label = results[0].get("technique_label", tech)
        scores = [r.get("final_score") for r in results if r.get("final_score") is not None]
        precisions = [r.get("precision") for r in results if r.get("precision") is not None]
        recalls = [r.get("recall") for r in results if r.get("recall") is not None]

        if scores:
            avg_score = sum(scores) / len(scores)
            avg_prec = sum(precisions) / len(precisions) if precisions else 0
            avg_rec = sum(recalls) / len(recalls) if recalls else 0
        else:
            avg_score = 0
            avg_prec = 0
            avg_rec = 0

        # Per-test breakdown
        by_test = defaultdict(list)
        for r in results:
            by_test[r["test_id"]].append(r.get("final_score", 0))

        test_scores = {}
        for test_id, scores in sorted(by_test.items()):
            valid = [s for s in scores if s is not None]
            test_scores[test_id] = round(sum(valid) / len(valid), 1) if valid else 0

        summary[tech] = {
            "label": label,
            "avg_score": round(avg_score, 2),
            "avg_precision": round(avg_prec, 2),
            "avg_recall": round(avg_rec, 2),
            "test_scores": test_scores,
            "num_results": len(results),
        }

    return summary


def print_summary_table(summary: dict[str, Any]) -> None:
    """Print a formatted results table."""
    print()
    print("=" * 75)
    print("  BENCHMARK RESULTS")
    print("=" * 75)
    print()

    # Collect all test IDs
    test_ids = set()
    for s in summary.values():
        test_ids.update(s["test_scores"].keys())
    test_ids = sorted(test_ids)

    # Header
    header = f"  {'Tech':6s} {'Label':25s} {'Score':6s} {'Prec':5s} {'Rec':5s}"
    for t in test_ids:
        header += f" {t:5s}"
    print(header)
    print("  " + "-" * 70)

    # Rows sorted by score descending
    for tech in sorted(summary, key=lambda t: summary[t]["avg_score"], reverse=True):
        s = summary[tech]
        row = f"  {tech:6s} {s['label']:25s} {s['avg_score']:5.1f}  {s['avg_precision']:4.1f}  {s['avg_recall']:4.1f}"
        for t in test_ids:
            val = s["test_scores"].get(t, "-")
            row += f" {str(val):>5s}"
        print(row)

    print()
    print("  Scores: 0-3 scale (3=perfect, 0=failed)")
    print("  Precision: correctness of response")
    print("  Recall: completeness of response")
    print("=" * 75)
