"""
test_extraction_comparison.py — Compare Rust heuristic extraction vs LLM extraction side-by-side

Takes real conversation text, runs both extractors, compares:
- Entity count, quality, confidence
- Claim count, quality, confidence
- Entity types detected
- False positives / missed entities
"""

import json
import urllib.request
import time
import os

BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
ILO_URL = "http://127.0.0.1:18090"
MODEL = "/Users/femi/models/qwen3.5-9b/Qwen_Qwen3.5-9B-Q4_K_M.gguf"

# ── Get real conversation text from session file ──────


def get_realtime_conversations():
    """Extract shorter samples from real conversations"""
    session_dir = os.path.expanduser(
        "~/.pi/agent/sessions/--Users-femi-Documents-ilo--/"
    )
    sessions = sorted([f for f in os.listdir(session_dir) if f.endswith(".jsonl")])

    samples = []

    for s in sessions[-5:]:
        f = os.path.join(session_dir, s)
        entries = []
        with open(f) as fh:
            for line in fh:
                try:
                    entries.append(json.loads(line))
                except:
                    pass

        msgs = [e.get("message", {}) for e in entries if e.get("type") == "message"]

        # Extract individual user-assistant exchanges (not the whole session)
        # Find pairs of user message + assistant response
        current_user = None
        current_assistant = None

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

            if not text:
                continue

            if role == "user":
                current_user = text
                current_assistant = None
            elif role == "assistant" and current_user and not current_assistant:
                current_assistant = text
                # We have a pair!
                pair = (
                    f"User: {current_user[:500]}\nAssistant: {current_assistant[:500]}"
                )
                if len(pair) > 100 and len(pair) < 1500:
                    samples.append(
                        {
                            "session": s[:40],
                            "text": pair,
                            "length": len(pair),
                        }
                    )
                current_user = None

        # If fewer than 3 pairs found, take some assistant-only blocks
        if len([x for x in samples if x["session"][:20] in s]) < 3:
            # Get assistant blocks with tool results
            blocks = []
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
                if len(text) > 200 and len(text) < 1500:
                    blocks.append(f"{role.upper()}: {text}")
            # Take first 2 long blocks
            for b in blocks[:2]:
                samples.append(
                    {
                        "session": s[:40],
                        "text": b,
                        "length": len(b),
                    }
                )

    return samples[:10]  # Maximum 10 samples


# ── Call Rust extractor ──────────────────────────────


def rust_extract(text):
    """Call ILO's /extract endpoint (Rust heuristic extractor)"""
    body = json.dumps({"text": text}).encode()
    req = urllib.request.Request(
        f"{ILO_URL}/extract",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        return {
            "entities": [
                (e["name"], e["confidence"], e.get("tags", []))
                for e in data.get("entities", [])
            ],
            "claims": [
                (c["subject"], c["link_type"], c["object"], c["confidence"])
                for c in data.get("claims", [])
            ],
        }
    except Exception as e:
        return {"error": str(e)}


# ── Call LLM extractor ───────────────────────────────

LLM_EXTRACT_TOOL = {
    "type": "function",
    "function": {
        "name": "extract_entities",
        "description": "Extract entities and claims from conversation text",
        "parameters": {
            "type": "object",
            "properties": {
                "entities": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Entity name"},
                            "type": {
                                "type": "string",
                                "enum": [
                                    "component",
                                    "file",
                                    "concept",
                                    "person",
                                    "tool",
                                    "service",
                                    "other",
                                ],
                            },
                            "confidence": {
                                "type": "number",
                                "minimum": 0.0,
                                "maximum": 1.0,
                            },
                            "description": {"type": "string"},
                        },
                        "required": ["name", "type", "confidence"],
                    },
                },
                "claims": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "subject": {"type": "string"},
                            "relationship": {"type": "string"},
                            "object": {"type": "string"},
                            "confidence": {"type": "number"},
                        },
                        "required": ["subject", "relationship", "object", "confidence"],
                    },
                },
            },
            "required": ["entities", "claims"],
        },
    },
}


def llm_extract(text):
    """Send text to LLM for entity/claim extraction"""
    body = {
        "model": MODEL,
        "messages": [
            {
                "role": "system",
                "content": "Extract entities (components, files, concepts, people, tools) and their relationships from this conversation. Be thorough.",
            },
            {"role": "user", "content": text},
        ],
        "tools": [LLM_EXTRACT_TOOL],
        "tool_choice": "auto",
        "max_tokens": 800,
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
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())

        msg = data["choices"][0]["message"]
        tcs = msg.get("tool_calls")
        if tcs:
            args = json.loads(tcs[0]["function"]["arguments"])
            entities = [
                (e["name"], e.get("confidence", 0.5), [e.get("type", "other")])
                for e in args.get("entities", [])
            ]
            claims = [
                (
                    c["subject"],
                    c.get("relationship", "related_to"),
                    c["object"],
                    c.get("confidence", 0.5),
                )
                for c in args.get("claims", [])
            ]
            return {
                "entities": entities,
                "claims": claims,
                "tokens": data.get("usage", {}).get("total_tokens", 0),
            }
        else:
            # Model responded with text instead
            return {"entities": [], "claims": [], "note": msg.get("content", "")[:100]}
    except Exception as e:
        return {"error": str(e)}


# ── Analysis ─────────────────────────────────────────


def analyze(text, rust_result, llm_result):
    """Compare the two extraction results"""
    report = []

    # Entity comparison
    rust_entities = set(e[0].lower() for e in rust_result.get("entities", []))
    llm_entities = set(e[0].lower() for e in llm_result.get("entities", []))

    both = rust_entities & llm_entities
    rust_only = rust_entities - llm_entities
    llm_only = llm_entities - rust_entities

    report.append(f"  Entities: {len(rust_entities)} Rust vs {len(llm_entities)} LLM")
    report.append(f"  Common: {len(both)}")
    if rust_only:
        report.append(f"  Rust only ({len(rust_only)}): {list(rust_only)[:5]}")
    if llm_only:
        report.append(f"  LLM only ({len(llm_only)}): {list(llm_only)[:5]}")

    # Quality assessment
    high_conf_rust = sum(
        1 for _, conf, _ in rust_result.get("entities", []) if conf >= 0.5
    )
    high_conf_llm = sum(
        1 for _, conf, _ in llm_result.get("entities", []) if conf >= 0.5
    )

    report.append(
        f"  High-confidence entities (>=0.5): {high_conf_rust} Rust vs {high_conf_llm} LLM"
    )

    # Claim comparison
    rust_claims = set(
        (c[0].lower(), c[2].lower()) for c in rust_result.get("claims", [])
    )
    llm_claims = set((c[0].lower(), c[2].lower()) for c in llm_result.get("claims", []))

    both_c = rust_claims & llm_claims
    claims_rust_only = rust_claims - llm_claims
    claims_llm_only = llm_claims - rust_claims

    report.append(f"  Claims: {len(rust_claims)} Rust vs {len(llm_claims)} LLM")
    report.append(f"  Common: {len(both_c)}")
    if claims_rust_only:
        report.append(
            f"  Rust claims only ({len(claims_rust_only)}): {list(claims_rust_only)[:3]}"
        )
    if claims_llm_only:
        report.append(
            f"  LLM claims only ({len(claims_llm_only)}): {list(claims_llm_only)[:3]}"
        )

    # Quality of detected entities — check for "real" vs "noise"
    rust_noise = sum(
        1 for e, conf, _ in rust_result.get("entities", []) if conf < 0.2 and len(e) < 4
    )
    llm_noise = sum(
        1 for e, conf, _ in llm_result.get("entities", []) if conf < 0.2 and len(e) < 4
    )

    report.append(
        f"  Low-confidence noise entities: {rust_noise} Rust vs {llm_noise} LLM"
    )

    # Types detected (LLM only, Rust doesn't do types)
    if "entities" in llm_result:
        types = {}
        for _, _, tags in llm_result["entities"]:
            for t in tags:
                types[t] = types.get(t, 0) + 1
        report.append(f"  LLM entity types: {types}")

    # Relationship types (Rust has 5, LLM is open)
    rust_rel_types = set(c[1] for c in rust_result.get("claims", []))
    llm_rel_types = set(c[1] for c in llm_result.get("claims", []))
    report.append(f"  Relationship types: {rust_rel_types} Rust vs {llm_rel_types} LLM")

    return "\n".join(report)


# ── Manual inspection: show actual entities ───────────


def format_entities(entities, label):
    if not entities:
        return f"  {label}: (none)"
    lines = [f"  {label}:"]
    for name, conf, tags in entities[:10]:
        tag_str = f" ({', '.join(tags)})" if tags else ""
        lines.append(f"    {name:<30s} conf={conf:.2f}{tag_str}")
    return "\n".join(lines)


def main():
    print("=" * 70)
    print("  EXTRACTION COMPARISON: Rust heuristic vs LLM")
    print("=" * 70)

    conversations = get_realtime_conversations()
    print(f"\nFound {len(conversations)} conversations to test\n")

    all_results = []

    for i, conv in enumerate(conversations):
        print(f"{'─' * 70}")
        print(f"  CONVERSATION {i + 1}: {conv['session'][:60]}")
        print(f"  Length: {conv['length']} chars")
        print(f"{'─' * 70}")
        print(f"  Preview: {conv['text'][:200]}...")
        print()

        # Rust extraction
        start = time.time()
        rust_r = rust_extract(conv["text"])
        rust_time = time.time() - start

        # LLM extraction
        start = time.time()
        llm_r = llm_extract(conv["text"])
        llm_time = time.time() - start

        # Handle errors
        if "error" in rust_r:
            print(f"  Rust error: {rust_r['error'][:60]}")
            continue
        if "error" in llm_r:
            print(f"  LLM error: {llm_r['error'][:60]}")
            continue

        # Show extracted entities
        print(format_entities(rust_r.get("entities", []), "Rust entities"))
        print(format_entities(llm_r.get("entities", []), "LLM entities"))

        # Show claims
        if rust_r.get("claims"):
            print(f"  Rust claims ({len(rust_r['claims'])}):")
            for s, rel, o, c in rust_r["claims"][:5]:
                print(f"    {s} --[{rel}]--> {o} (conf={c:.2f})")
        if llm_r.get("claims"):
            print(f"  LLM claims ({len(llm_r['claims'])}):")
            for s, rel, o, c in llm_r["claims"][:5]:
                print(f"    {s} --[{rel}]--> {o} (conf={c:.2f})")

        print(f"\n  Timing: Rust={rust_time:.2f}s LLM={llm_time:.2f}s", end="")
        if "tokens" in llm_r:
            print(f" LLM tokens={llm_r['tokens']}", end="")
        print()

        # Analysis
        print("\n  Analysis:")
        analysis = analyze(conv["text"], rust_r, llm_r)
        print(analysis)

        all_results.append(
            {
                "session": conv["session"],
                "rust_entities": len(rust_r.get("entities", [])),
                "llm_entities": len(llm_r.get("entities", [])),
                "rust_claims": len(rust_r.get("claims", [])),
                "llm_claims": len(llm_r.get("claims", [])),
                "rust_time": rust_time,
                "llm_time": llm_time,
            }
        )
        print()

    # Overall summary
    print(f"\n{'=' * 70}")
    print("  OVERALL SUMMARY")
    print(f"{'=' * 70}")

    if all_results:
        total_rust_e = sum(r["rust_entities"] for r in all_results)
        total_llm_e = sum(r["llm_entities"] for r in all_results)
        total_rust_c = sum(r["rust_claims"] for r in all_results)
        total_llm_c = sum(r["llm_claims"] for r in all_results)
        avg_rust_t = sum(r["rust_time"] for r in all_results) / len(all_results)
        avg_llm_t = sum(r["llm_time"] for r in all_results) / len(all_results)

        print(f"  Total entities: {total_rust_e} Rust vs {total_llm_e} LLM")
        print(f"  Total claims:   {total_rust_c} Rust vs {total_llm_c} LLM")
        print(f"  Avg time:       {avg_rust_t:.3f}s Rust vs {avg_llm_t:.2f}s LLM")
        print(f"  LLM is {avg_llm_t / avg_rust_t:.0f}x slower")
        print(
            "  (But LLM gives entity types, relationship semantics, higher confidence)"
        )


if __name__ == "__main__":
    main()
