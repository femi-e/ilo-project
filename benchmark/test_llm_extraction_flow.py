"""
test_llm_extraction_flow.py — Test LLM-based entity/claim extraction via context_rebuild

Validates:
1. Model correctly extracts entities + claims in the same call as scoring
2. Output quality is high enough for ILO storage
3. The flow works end-to-end with real conversation text
"""

import json
import urllib.request
import os

BASE_URL = "http://127.0.0.1:1234/v1/chat/completions"
MODEL = "/Users/femi/models/qwen3.5-9b/Qwen_Qwen3.5-9B-Q4_K_M.gguf"

# ── The full context_rebuild tool with extraction ─────

FULL_TOOL = {
    "type": "function",
    "function": {
        "name": "context_rebuild",
        "description": "Analyze the task, score context relevance, and extract entities and claims from the conversation.",
        "parameters": {
            "type": "object",
            "properties": {
                "analysis": {
                    "type": "string",
                    "description": "Your analysis of the task and what context is needed",
                },
                "plan": {
                    "type": "string",
                    "description": "Step-by-step plan",
                },
                "chunk_scores": {
                    "type": "object",
                    "description": "Relevance score per chunk ID (0.0-1.0)",
                    "additionalProperties": {"type": "number"},
                },
                "extracted_entities": {
                    "type": "array",
                    "description": "Key entities found in this conversation turn",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Entity name"},
                            "type": {
                                "type": "string",
                                "enum": [
                                    "component",
                                    "file",
                                    "tool",
                                    "service",
                                    "concept",
                                    "person",
                                    "library",
                                    "config",
                                    "other",
                                ],
                            },
                            "confidence": {
                                "type": "number",
                                "minimum": 0.0,
                                "maximum": 1.0,
                            },
                            "tags": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Tags for categorization",
                            },
                        },
                        "required": ["name", "type", "confidence"],
                    },
                },
                "extracted_claims": {
                    "type": "array",
                    "description": "Relationships between entities found in this turn",
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
            "required": [
                "analysis",
                "plan",
                "chunk_scores",
                "extracted_entities",
                "extracted_claims",
            ],
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
        user_texts = []

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
            if role == "user" and 100 < len(text) < 800:
                user_texts.append(text)

        for t in user_texts[:4]:
            samples.append({"session": s[:40], "text": t})

    return samples


def call_llm(messages, max_tokens=800):
    body = {
        "model": MODEL,
        "messages": messages,
        "tools": [FULL_TOOL],
        "tool_choice": "auto",
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
            return json.loads(resp.read())
    except Exception as e:
        return {"error": str(e)}


def main():
    print("=" * 70)
    print("  TEST: LLM Entity/Claim Extraction via context_rebuild")
    print("=" * 70)

    samples = get_samples()
    print(f"\n  Testing {len(samples)} real conversation samples\n")

    for i, sample in enumerate(samples):
        print(f"{'─' * 70}")
        print(f"  SAMPLE {i + 1}: {sample['session']}")
        print(f"{'─' * 70}")
        print(f"  Text: {sample['text'][:120]}...")
        print()

        r = call_llm(
            [
                {
                    "role": "system",
                    "content": "You are a coding assistant. Analyze this user message and extract entities and claims.",
                },
                {
                    "role": "user",
                    "content": f"Extract entities and claims from this user message in a coding agent conversation:\n\n{sample['text']}",
                },
            ]
        )

        if "error" in r:
            print(f"  ERROR: {r['error'][:80]}")
            continue

        msg = r["choices"][0]["message"]
        tcs = msg.get("tool_calls")
        if not tcs:
            print(f"  No tool call (text: {msg.get('content', '')[:80]})")
            continue

        args = json.loads(tcs[0]["function"]["arguments"])
        entities = args.get("extracted_entities", [])
        claims = args.get("extracted_claims", [])
        analysis = args.get("analysis", "")[:100]
        tokens = r.get("usage", {}).get("total_tokens", 0)

        print(f"  Analysis: {analysis}...")
        print(f"  Tokens: {tokens}")
        print()

        if entities:
            print(f"  Entities ({len(entities)}):")
            for e in entities:
                name = e.get("name", "?")
                etype = e.get("type", "?")
                conf = e.get("confidence", 0)
                tags = e.get("tags", [])
                tag_str = f" [{', '.join(tags)}]" if tags else ""
                print(f"    {name:<35s} type={etype:<12s} conf={conf:.2f}{tag_str}")

        if claims:
            print(f"\n  Claims ({len(claims)}):")
            for c in claims:
                s = c.get("subject", "?")
                rel = c.get("relationship", "?")
                o = c.get("object", "?")
                conf = c.get("confidence", 0)
                print(f"    {s} --[{rel}]--> {o}  (conf={conf:.2f})")

        # Validate: can we store this in ILO?
        print("\n  Validate for ILO storage:")
        all_valid = True
        for e in entities:
            if not e.get("name") or not e.get("type") or not e.get("confidence"):
                print(f"    INVALID entity missing fields: {e}")
                all_valid = False
        for c in claims:
            if not c.get("subject") or not c.get("relationship") or not c.get("object"):
                print(f"    INVALID claim missing fields: {c}")
                all_valid = False
        if all_valid:
            print(
                f"    All {len(entities)} entities + {len(claims)} claims valid for ILO"
            )
        print()


if __name__ == "__main__":
    main()
