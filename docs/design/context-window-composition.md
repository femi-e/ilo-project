# What Makes Up the Context Window

## Current Architecture (Pi + ILO Extension)

The LLM sees ONE concatenated context window per turn.
Here's every section that goes into it:

```
┌────────────────────────────────────────────────────────────────┐
│  SYSTEM PROMPT (built once per session, ~2-3K tokens)         │
├────────────────────────────────────────────────────────────────┤
│  │  Pi's Default System Prompt                                 │
│  │    (built-in coding assistant instructions)                 │
│  ├──────────────────────────────────────────────────────────────┤
│  │  ILO Project Overview                                       │
│  │    "This is ILO — a memory system for coding agents..."     │
│  ├──────────────────────────────────────────────────────────────┤
│  │  ILO Memory System Instructions                             │
│  │    "Use memory_search to find entities..."                  │
│  ├──────────────────────────────────────────────────────────────┤
│  │  Tools Section (dynamic, from pi.getAllTools())             │
│  │    "- **read** - Read file contents..."                     │
│  │    "- **bash** - Execute bash commands..."                  │
│  │    "- **memory_search** - Search persistent memory..."      │
│  ├──────────────────────────────────────────────────────────────┤
│  │  Workflow + Hard Rules                                      │
│  │    "1. Check git state with git_snapshot..."                │
│  │    "NEVER delete ILO database files..."                     │
├────────────────────────────────────────────────────────────────┤
│  MEMORY CONTEXT (injected per turn, ~1K tokens)                │
│                                                                 │
│  ## Memory Context                                              │
│    - jwt_handler (0.95) — auth, tokens                         │
│    - login_route (0.88) — routes, api                          │
│    - src/auth.py (0.82) — file                                 │
│                                                                 │
│  (Top 5 entities from ILO search, filtered by relevance)       │
├────────────────────────────────────────────────────────────────┤
│  CONVERSATION HISTORY (the growing problem, unbounded)          │
│                                                                 │
│  user: "Add JWT auth to the Flask app"                         │
│  assistant: [thinking] Let me look at the existing code...     │
│  assistant: I'll start by checking the routes file.            │
│  tool: read (routes.py) → (full file content...)               │
│  tool: read (models.py) → (full file content...)               │
│  assistant: Created src/auth.py with JWT helpers.              │
│  tool: write (auth.py) → (full file content...)                │
│  tool: bash (pytest) → (test output...)                        │
│  ... (KEEPS GROWING UNTIL COMPACTION TRIGGERS) ...             │
│                                                                 │
│  user: "Now add refresh token support"                         │
├────────────────────────────────────────────────────────────────┤
│  CURRENT USER PROMPT                                           │
│                                                                 │
│  "Now add refresh token support"                               │
├────────────────────────────────────────────────────────────────┤
│  RESPONSE (LLM generates into this space)                      │
└────────────────────────────────────────────────────────────────┘
```

## Token Budget Summary

| Section | Size | Behavior |
| --------- | :----: | ---------- |
| Pi's system prompt | ~500-1K | Fixed (built-in) |
| ILO Project Overview | ~200 | Fixed (injected once) |
| Memory System Instructions | ~200 | Fixed (injected once) |
| Tools Section | ~500-1K | Fixed (regenerated on reload) |
| Workflow + Hard Rules | ~300 | Fixed (injected once) |
| Memory Context | ~1K | Dynamic (ILO search per turn) |
| **Conversation History** | **GROWS** | **Unbounded ← PROBLEM** |
| Current User Prompt | ~100-500 | Per turn |
| **Total fixed overhead** | **~3K** | Always present |
| **Total available for turns** | **~259K** | Shared with response |

## The Problem

The conversation history is the ONLY section that grows without bound. Everything else is fixed at ~3K tokens. The remaining ~259K of the 262K budget is shared between conversation history and the model's response.

When it hits the limit, pi's compaction kicks in — it summarizes old turns. This is lossy.

## Your Proposal

Replace the unbounded conversation history with a **scored turn queue**:

| Current | Proposed |
| --------- | ---------- |
| All past turns (until compaction) | Scored turns (highest N) |
| FIFO drop when full | Smart eviction by score |
| Lossy compaction when overflow | Lossless full turns, just fewer |
| Old turns gone forever | Old turns can resurrect via ILO |

The fixed sections (system prompt, memory context) stay unchanged.
Only the conversation history section changes — from a FIFO list to a scored priority queue.

## What Stays the Same

- System prompt sections (Pi default + ILO extensions)
- Memory context (ILO entities per turn)
- Current user prompt
- Tool definitions

## What Changes

- **How conversation history is selected**: FIFO → scored priority queue
- **Eviction policy**: oldest → lowest score
- **Resurrection**: gone forever → retrievable from ILO
- **Cross-session**: none → ILO bridges sessions
