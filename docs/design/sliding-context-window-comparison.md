# Context Window Comparison

## Default Pi Context Window

```
┌──────────────────────────────────────────────────────────────────┐
│ SYSTEM PROMPT (always present)                                  │
│                                                                  │
│  # Project Overview                                              │
│  This is ILO — a memory system for coding agents...             │
│                                                                  │
│  # Memory System                                                 │
│  This project has a persistent memory system (ILO)...           │
│                                                                  │
│  # How to Work                                                   │
│  1. Before making changes, check git state...                    │
│  2. Use project_tree when you need to understand...              │
│                                                                  │
│  ## Memory Context                                               │
│    - jwt_handler (0.95) — auth                                   │
│    - login_route (0.88) — routes                                 │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ CONVERSATION HISTORY (grows until compaction)                    │
│                                                                  │
│  user: Can you add JWT auth to the Flask app?                   │
│  assistant: [thinking] Let me look at the existing code...       │
│  assistant: I'll start by checking the routes file.              │
│  tool: read (routes.py) → (content...)                           │
│  tool: read (models.py) → (content...)                           │
│  tool: read (config.py) → (content...)  ← Lots of tokens        │
│  assistant: [thinking] I'll create auth.py with JWT support...   │
│  assistant: Created src/auth.py with JWT helpers.                │
│  tool: write (auth.py) → (content...)  ← File content in context │
│  tool: bash (pip install flask-jwt-extended) → (output...)       │
│  assistant: Installed the JWT extension.                         │
│  assistant: [thinking] Now I need to add the login endpoint...   │
│  tool: read (routes.py) → (content...)                           │
│  tool: edit (routes.py) → (diff...)                              │
│  assistant: Added /login endpoint to routes.py.                  │
│  tool: bash (pytest) → (output...)                               │
│  assistant: All 6 tests passed.                                  │
│  user: Now add refresh token support.                            │
│  assistant: [thinking] I need to update auth.py...               │
│  tool: read (auth.py) → (content...                              │
│  ...                                                             │
│                                                                  │
│  (At ~200K tokens: compaction triggers — summarises old turns)   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

Problems:
  - File contents in tool results eat ~70% of context
  - Old tool results are retained even when irrelevant
  - Compaction is lossy (free-text summary)
  - No structured knowledge about what was achieved
```

## Proposed Context Window (Sliding + Structured)

```
┌──────────────────────────────────────────────────────────────────┐
│ SYSTEM PROMPT (always present — ~3K tokens)                      │
│                                                                  │
│  # Project Overview                                              │
│  # Memory System                                                 │
│  # How to Work                                                   │
│                                                                  │
│  ## Memory Context  (~1K tokens — entities from ILO)             │
│    - jwt_handler (0.95) — auth, jwt                              │
│    - login_route (0.88) — routes, api                            │
│    - auth_module (0.85) — dependencies                           │
│                                                                  │
│  ## Session Actions  (~10K tokens — last ~200 turns)             │
│  Recent actions, oldest dropped when budget exceeded.            │
│                                                                  │
│    55:                                                            │
│      wrote: src/auth.py (+85 lines · JWT validation)             │
│      entity: jwt_handler (0.92)                                  │
│      claimed: app depends_on jwt_handler                         │
│      ran: pip install flask-jwt-extended (-)                     │
│                                                                  │
│    54:                                                            │
│      edited: src/routes.py (+12 lines · POST /login)             │
│      read: src/config.py (skimming · 30 lines)                   │
│      entity: login_route (0.88)                                  │
│      ran: pytest (6/6 passed · 1.2s)                             │
│                                                                  │
│    53:                                                            │
│      read: src/models.py (existing · UserModel)                  │
│      searched: "Flask JWT refresh tokens"                        │
│      (3 results · used flask-jwt-extended docs)                  │
│                                                                  │
│    ... (turns 1-52 dropped, content preserved above)              │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ CONVERSATION HISTORY (last 3 turns only — raw, ~12K tokens)     │
│                                                                  │
│  user: Now add refresh token support.                            │
│  assistant: [thinking] I need to add refresh to auth.py...       │
│  tool: read (auth.py) → (truncated output)                       │
│  tool: edit (auth.py) → (diff only, no full file)                │
│  assistant: Added refresh token endpoint.                        │
│  tool: bash (pytest) → (truncated output)                        │
│  assistant: All 8 tests passed (2 new).                          │
│                                                                  │
│  user: And update the frontend to use it.                        │
│  assistant: Let me check the frontend code...                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Side-by-Side Comparison

| Aspect | Default (Pi) | Proposed |
| -------- | :------------: | :--------: |
| **System prompt** | `# Project`, `# Memory`, `# How To` | Same + `## Session Actions` |
| **Memory context** | ILO entities | ILO entities (unchanged) |
| **Session actions** | ❌ Not present | ✅ Structured turn archive |
| **Old tool results** | Full content (lossy compaction) | Dropped entirely (replaced by structured) |
| **Raw turns kept** | All (until compaction) | Last 3 only |
| **Raw turn content** | Full files, full output | Truncated output, diff-only |
| **Token budget** | ~200K for raw turns | ~10K session actions + ~12K 3 raw turns |
| **Compaction** | Lossy summary | Lossless drop (oldest session actions) |
| **Cross-session** | ❌ Lost on restart | ✅ Stored in ILO Turn nodes |
| **Continuity** | Depends on compaction quality | Depends on structured state quality |

## Token Budget Breakdown (262K total)

```
Default:
┌────────────┬──────────────┐
│ System     │        2K    │
│ Memory     │        1K    │
│ Raw turns  │      259K    │ ← all tokens in raw conversation
│            │              │   tool results eat most of this
│ Total      │      ~262K   │
└────────────┴──────────────┘

Proposed:
┌────────────┬──────────────┐
│ System     │        2K    │
│ Memory     │        1K    │
│ Sessions   │       10K    │ ← compressed, ~200 turns
│ Recent raw │       12K    │ ← last 3 turns only, truncated output
│ Response   │       20K    │ ← reserved for model's response
│ Free       │      217K    │ ← unused, prevents OOM
│ Total      │      ~262K   │
└────────────┴──────────────┘
```
