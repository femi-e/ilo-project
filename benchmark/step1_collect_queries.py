"""
step1_collect_queries.py — Collect and clean user queries from 10+ session files
"""

import json
import os

SESSION_DIR = os.path.expanduser(os.environ.get("SESSION_DIR", "~/.pi/agent/sessions/example-session/"))


def extract_queries():
    sessions = sorted([f for f in os.listdir(SESSION_DIR) if f.endswith(".jsonl")])
    print(f"Found {len(sessions)} session files")

    all_queries = []

    for s in sessions:
        f = os.path.join(SESSION_DIR, s)
        entries = []
        with open(f) as fh:
            for line in fh:
                try:
                    entries.append(json.loads(line))
                except:
                    pass

        msgs = [e.get("message", {}) for e in entries if e.get("type") == "message"]
        session_queries = []

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

            if role == "user" and len(text) > 20 and len(text) < 2000:
                session_queries.append(text)

        # Deduplicate near-duplicates within same session
        unique = []
        for q in session_queries:
            if not any(
                len(set(q.split()) & set(u.split())) / max(len(set(q.split())), 1) > 0.8
                for u in unique
            ):
                unique.append(q)

        all_queries.extend([(s[:40], q) for q in unique])
        print(
            f"  {s[:40]}: {len(unique)} unique queries (from {len(session_queries)} raw)"
        )

    print(f"\nTotal: {len(all_queries)} queries from {len(sessions)} sessions")

    # Save
    with open("benchmark/query_dataset.jsonl", "w") as f:
        for session_id, query in all_queries:
            f.write(json.dumps({"session": session_id, "query": query}) + "\n")

    print("Saved to benchmark/query_dataset.jsonl")

    # Stats
    lengths = [len(q) for _, q in all_queries]
    print(
        f"Query length: min={min(lengths)} max={max(lengths)} avg={sum(lengths) / len(lengths):.0f} chars"
    )

    return all_queries


if __name__ == "__main__":
    extract_queries()
