#!/usr/bin/env python3
"""
Sliding Context Benchmark — Full Pipeline

Phases:
  1. Extract session → structured turns
  2. Apply 7 compression techniques
  3. Run test prompts against MTPLX
  4. Score and summarize results

Usage:
  python3 benchmark/run.py [--cut-turn 10] [--session path]
"""

import sys
import os
import json
import argparse

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))

from src import config
from src.session_extractor import find_most_recent_session, extract_turns, split_at_turn
from src.compression_engines import compress
from src.test_runner import run_test
from src.scorer import score_all_results, summarize_results, print_summary_table


# ── Test Prompts ──────────────────────────────────────────

TEST_PROMPTS = [
    {
        "id": "P1",
        "prompt": "Continue the task. Read the most recently edited file and tell me what the next logical addition would be. Be specific about the file and the change.",
        "metric": "file_state_retention",
        "ground_truth": "",
    },
    {
        "id": "P2",
        "prompt": "What technical decisions were made during this session? List them with the reasoning.",
        "metric": "decision_recall",
        "ground_truth": "",
    },
    {
        "id": "P3",
        "prompt": "Continue from where we left off. What should we do next? Be specific about what task is pending.",
        "metric": "task_continuity",
        "ground_truth": "",
    },
    {
        "id": "P4",
        "prompt": "What project is being built? Who is the user and what are the key constraints or requirements mentioned?",
        "metric": "constraint_awareness",
        "ground_truth": "",
    },
    {
        "id": "P5",
        "prompt": "What approaches were tried and rejected? What didn't work and why?",
        "metric": "failure_memory",
        "ground_truth": "",
    },
    {
        "id": "P6",
        "prompt": "Describe the state of the codebase right now. What files exist, what do they contain, and what's in progress?",
        "metric": "code_state_retention",
        "ground_truth": "",
    },
]


# ── Session scanner for ground truth ──────────────────────

def scan_session_for_ground_truth(turns: list[dict]) -> None:
    """Scan the post-cut turns to extract ground truth for each test.

    Mutates TEST_PROMPTS in-place with ground_truth values extracted
    from the actual session continuation.
    """
    if not turns:
        return

    # Extract all user messages
    user_msgs = [t.get("user_message", "") for t in turns if t.get("user_message")]

    def _extract_text(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                c.get("text", "") if isinstance(c, dict) else str(c)
                for c in content
            )
        return str(content) if content else ""

    all_text = "\n".join(
        t.get("user_message", "") + "\n" +
        " ".join(_extract_text(m.get("content", "")) for m in t.get("assistant_messages", []))
        for t in turns
    )

    files_mentioned = set()
    for t in turns:
        for tc in t.get("tool_calls", []):
            inp = tc.get("input", tc.get("arguments", {}))
            if isinstance(inp, dict):
                path = inp.get("path", "")
                if path:
                    files_mentioned.add(path)

    decisions_found = []
    for t in turns:
        for msg in t.get("assistant_messages", []):
            reasoning = msg.get("reasoning", "") or ""
            if "chose" in reasoning or "decided" in reasoning or "using" in reasoning:
                decisions_found.append(reasoning[:200])

    full_state = "\n".join(
        f"Turn {t.get('turn_index', i)}: {t.get('user_message', '')[:100]}"
        for i, t in enumerate(turns)
    )

    for test in TEST_PROMPTS:
        if test["id"] == "P1":
            files_str = "\n".join(sorted(files_mentioned)[:5]) if files_mentioned else "(no files)"
            test["ground_truth"] = f"Files modified: {files_str}"
        elif test["id"] == "P2":
            test["ground_truth"] = "; ".join(decisions_found[:3]) if decisions_found else "(no decisions)"
        elif test["id"] == "P3":
            test["ground_truth"] = f"Next user messages: {'; '.join(user_msgs[:2])}"
        elif test["id"] == "P4":
            test["ground_truth"] = f"Session context: {full_state[:500]}"
        elif test["id"] == "P5":
            test["ground_truth"] = "(approaches not explicitly tracked — manual review needed)"
        elif test["id"] == "P6":
            test["ground_truth"] = f"Files: {', '.join(sorted(files_mentioned)[:10]) or '(none)'}"


# ── Main Pipeline ─────────────────────────────────────────

def run_benchmark(session_path: str, cut_turn: int, techniques: list[str],
                  runs: int = 2) -> None:
    """Run the full benchmark pipeline."""
    print("=" * 75)
    print("  SLIDING CONTEXT BENCHMARK")
    print("=" * 75)
    print(f"\nSession: {os.path.basename(session_path)}")
    print(f"Cut turn: {cut_turn}")
    print(f"Techniques: {', '.join(techniques)}")
    print(f"Runs per test: {runs}")

    # Phase 1: Extract session
    print("\n── Phase 1: Extracting session ──")
    turns = extract_turns(session_path)
    print(f"  Found {len(turns)} turns")

    pre_history, task_prompts, ground_truth_turns = split_at_turn(turns, cut_turn)
    print(f"  Pre-cut history: {len(pre_history)} turns")
    print(f"  Post-cut task: {len(task_prompts)} turn(s)")
    print(f"  Ground truth: {len(ground_truth_turns)} turn(s)")

    if not pre_history:
        print("  ❌ No pre-cut history. Choose a larger cut turn.")
        return

    # Scan ground truth
    scan_session_for_ground_truth(ground_truth_turns)

    # Get the task prompt
    task_text = task_prompts[0].get("user_message", "Continue the work.") if task_prompts else "Continue the work."

    # Phase 2-4: For each technique
    all_results = []

    for tech_id in techniques:
        label, compressed = compress(pre_history, tech_id)
        ctx_size = len(compressed)
        print(f"\n── Technique {tech_id}: {label} ({ctx_size:,} chars) ──")

        for run in range(1, runs + 1):
            if runs > 1:
                print(f"  Run {run}/{runs}...")
            results = run_test(tech_id, label, compressed, TEST_PROMPTS, run)
            all_results.extend(results)

            # Print quick results
            for r in results:
                resp_preview = r.get("response", "")[:50].replace("\n", " ")
                print(f"    [{r['test_id']}] {resp_preview}...")

    # Phase 5: Score and summarize
    print("\n── Phase 5: Scoring results ──")
    scored = score_all_results(all_results)
    summary = summarize_results(scored)
    print_summary_table(summary)

    # Save results
    output = {
        "session": os.path.basename(session_path),
        "cut_turn": cut_turn,
        "techniques": techniques,
        "runs": runs,
        "all_results": scored,
        "summary": {k: {sk: sv for sk, sv in v.items() if sk != "label"} for k, v in summary.items()},
    }

    output_path = os.path.join(os.path.dirname(__file__), "results.json")
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"\n✅ Results saved to {output_path}")


# ── CLI ───────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Sliding Context Benchmark")
    parser.add_argument("--session", help="Path to session JSONL file")
    parser.add_argument("--cut-turn", type=int, default=config.CUT_TURN,
                        help=f"Cut point (default: {config.CUT_TURN})")
    parser.add_argument("--techniques", default=",".join(config.TECHNIQUES),
                        help="Techniques to test (default: all)")
    parser.add_argument("--runs", type=int, default=config.RUNS_PER_TEST,
                        help=f"Runs per test (default: {config.RUNS_PER_TEST})")
    args = parser.parse_args()

    if args.session:
        session_path = args.session
    else:
        session_path = find_most_recent_session(config.SESSION_DIR)

    techniques = [t.strip().upper() for t in args.techniques.split(",")]

    run_benchmark(session_path, args.cut_turn, techniques, args.runs)


if __name__ == "__main__":
    main()
