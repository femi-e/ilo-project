#!/usr/bin/env python3
"""Dual test: Retention (does model remember?) + Continuation (can it act?)."""
import json
import os
import glob
import time
import urllib.request

SERVER = "http://127.0.0.1:1234/v1/chat/completions"

session_dir = os.path.expanduser("~/.pi/agent/sessions/--Users-femi-Documents-ilo--/")
files = sorted(glob.glob(os.path.join(session_dir, "*.jsonl")), key=os.path.getmtime)
session_path = files[-1]
with open(session_path) as f:
    entries = [json.loads(l) for l in f if l.strip()]

turns = []; current = None
for e in entries:
    if e.get("type") != "message": continue
    msg = e.get("message", {}); role = msg.get("role")
    blocks = msg.get("content", [])
    if not isinstance(blocks, list): blocks = [{"type": "text", "text": str(blocks)}]
    if role == "user":
        if current: turns.append(current)
        text = " ".join(b.get("text","") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        current = {"user": text, "tools": [], "results": []}
    elif role == "assistant" and current is not None:
        for b in blocks:
            if b.get("type") == "toolCall":
                args = b.get("arguments", {})
                values = " | ".join(str(v) for v in args.values() if v) if isinstance(args, dict) else str(args)
                current["tools"].append({"name": b.get("name","?"), "target": values})
    elif role == "toolResult" and current is not None:
        text = " ".join(b.get("text","") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
        current["results"].append(text)
if current: turns.append(current)

# Build sequences with BOTH context tools and next-turn tools
seqs = []
for i in range(len(turns) - 6):
    ctx_turns = turns[i:i+4]
    next_turn = turns[i+4]
    next_tools = next_turn["tools"]
    if next_tools and len(next_tools) < 15:
        # Collect ALL tool targets from context turns (for retention test)
        ctx_targets = []
        ctx_names = set()
        for ct in ctx_turns:
            for tl in ct["tools"]:
                ctx_names.add(tl["name"])
                if tl.get("target"):
                    ctx_targets.append(tl["target"][:60])
        seqs.append({
            "ctx": ctx_turns,
            "ctx_names": ctx_names,
            "ctx_targets": ctx_targets[:15],
            "next_tools": next_tools,
        })

import random; random.Random(42).shuffle(seqs); seqs = seqs[:6]
print(f"{len(seqs)} sequences")

# ── FORMATS ──

def fmt_baseline(turns_list):
    parts = []
    for i, t in enumerate(turns_list):
        parts.append(f"T{i+1}: {t['user'][:100]}")
        grps = []; cur = None
        for tl in t["tools"]:
            key = (tl["name"], tl["target"][:55])
            if cur and cur["key"] == key: cur["count"] += 1
            else:
                if cur: grps.append(cur)
                cur = {"key": key, "name": tl["name"], "target": tl["target"][:55], "count": 1}
        if cur: grps.append(cur)
        for g in grps:
            c = f" ×{g['count']}" if g['count'] > 1 else ""
            parts.append(f"  {g['name']}{c}: {g['target']}")
    return "\n".join(parts)

def fmt_optimal(turns_list):
    parts = []
    for i, t in enumerate(turns_list):
        parts.append(f"T{i+1}: {t['user']}")
        grps = []; cur = None
        for tl in t["tools"]:
            key = (tl["name"], tl["target"][:40])
            if cur and cur["key"] == key: cur["count"] += 1
            else:
                if cur: grps.append(cur)
                cur = {"key": key, "name": tl["name"], "target": tl["target"][:40], "count": 1}
        if cur: grps.append(cur)
        for g in grps:
            c = f" ×{g['count']}" if g['count'] > 1 else ""
            parts.append(f"  {g['name']}{c}: {g['target']}")
        if t["results"]:
            for r in t["results"][:3]:
                fl = r.split("\n")[0][:80] if r else ""
                if fl: parts.append(f"  → {fl}")
    return "\n".join(parts)

# ── PROBES ──

RETENTION_Q = "What specific files, commands, URLs, or targets were acted on in the session you just read? List them exactly as they appeared."

CONTINUATION_Q = "What should we do next? What tool should we use and on what target?"

def score_retention(response, ctx_targets, ctx_names):
    rl = response.lower()
    matched = sum(1 for tg in ctx_targets if tg[:25].lower() in rl)
    rate = matched / max(len(ctx_targets), 1)
    return min(rate * 3, 3)

def score_continuation(response, next_tools):
    rl = response.lower()
    next_names = set(t["name"] for t in next_tools)
    next_targets = [t.get("target","")[:40].lower() for t in next_tools if t.get("target")]
    
    name_score = sum(1 for n in next_names if n in rl) / max(len(next_names), 1) * 3
    target_score = sum(1 for tg in next_targets if tg and tg in rl) / max(len(next_targets), 1) * 3 if next_targets else 0
    
    return min((name_score + target_score) / 2, 3)

def call_llm(context, question):
    payload = {"model": "mtplx", "messages": [
        {"role": "system", "content": f"Session:\n{context}"},
        {"role": "user", "content": question}
    ], "max_tokens": 300, "temperature": 0.3}
    data = json.dumps(payload).encode()
    req = urllib.request.Request(SERVER, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        result = json.loads(resp.read())
    return result["choices"][0]["message"].get("content", "").strip()[:500]

def test(name, builder):
    ret_scores = []; con_scores = []; sizes = []
    for sq in seqs:
        ctx = builder(sq["ctx"])
        sizes.append(len(ctx))
        
        r1 = call_llm(ctx, RETENTION_Q)
        ret_scores.append(score_retention(r1, sq["ctx_targets"], sq["ctx_names"]))
        time.sleep(0.2)
        
        r2 = call_llm(ctx, CONTINUATION_Q)
        con_scores.append(score_continuation(r2, sq["next_tools"]))
        time.sleep(0.2)
    
    avg_ret = round(sum(ret_scores)/len(ret_scores), 2)
    avg_con = round(sum(con_scores)/len(con_scores), 2)
    avg_sz = round(sum(sizes)/len(sizes))
    composite = round((avg_ret + avg_con) / 6 * 10, 1)
    
    print(f"\n  {name:30s} ({avg_sz:,}c)")
    print(f"    retention:     {avg_ret}/3  (remembers targets from context)")
    print(f"    continuation:  {avg_con}/3  (predicts next actions)")
    print(f"    composite:     {composite}/10")
    return avg_ret, avg_con, avg_sz

print(f"\n{'='*60}")
print("  DUAL TEST: Retention + Continuation")
print(f"{'='*60}")

ret_b, con_b, sz_b = test("BASELINE (intent)", fmt_baseline)
ret_o, con_o, sz_o = test("OPTIMAL", fmt_optimal)

print(f"\n{'='*60}")
print(f"  {'':25s} {'Baseline':>10s} {'Optimal':>10s} {'Delta':>8s}")
print(f"  {'-'*55}")
print(f"  {'Retention':25s} {ret_b:>10.2f} {ret_o:>10.2f} {ret_o-ret_b:>+8.2f}")
print(f"  {'Continuation':25s} {con_b:>10.2f} {con_o:>10.2f} {con_o-con_b:>+8.2f}")
print(f"  {'Size':25s} {sz_b:>10,}c {sz_o:>10,}c {sz_o-sz_b:>+8}")
print(f"{'='*60}")

print("\n  Retention: model recalls exact targets from compressed context")
print("  Continuation: model predicts correct next tools/targets")
print("  Target: both > 1.5 = format preserves actionable information")
PYEOF