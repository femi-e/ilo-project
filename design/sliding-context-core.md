# Sliding Context + Persistent Memory — Core Design

## Overview

A dual-layer system for long-running coding agent sessions:

1. **FIFO Context Window** — Slides the message array to stay within token budget. Replaces pi's compaction.
2. **ILO Persistent Memory** — Structured turn backup stored in memory graph. Queryable when needed.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ PI AGENT LOOP                                                     │
│                                                                    │
│  User prompt                                                      │
│       │                                                            │
│       ▼                                                            │
│  ┌─────────────────────────────────┐                              │
│  │ context EVENT (slide window)     │                              │
│  │ - Count tokens                   │                              │
│  │ - If over budget: drop oldest    │                              │
│  │ - Respect tool_call/tool_result  │                              │
│  │   pairing                        │                              │
│  │ - Return { messages: trimmed }   │                              │
│  └──────────┬──────────────────────┘                              │
│             │ trimmed messages                                     │
│             ▼                                                      │
│  ┌─────────────────────────────────┐                              │
│  │ LLM CALL (MTPLX)                │                              │
│  │ - System prompt + Memory Context│                              │
│  │ - Recent N turns only           │                              │
│  └──────────┬──────────────────────┘                              │
│             │ response                                             │
│             ▼                                                      │
│  ┌─────────────────────────────────┐                              │
│  │ Turn completes                  │                              │
│  └──────────┬──────────────────────┘                              │
│             ▼                                                      │
│  ┌─────────────────────────────────┐                              │
│  │ turn_end EVENT (store backup)   │                              │
│  │ - Extract tools, files, results │                              │
│  │ - Store structured props on ILO │                              │
│  │   Turn node                     │                              │
│  │ - Entities → Entity graph      │                              │
│  └─────────────────────────────────┘                              │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Context Hook — FIFO Slide

```
File: .pi/extensions/core/events/context.ts (extend existing)

Register: pi.on("context", async (event, ctx) => { ... })

Logic:
  const budget = 200000;  // 200K of 262K total (leaves room for response)
  const messages = event.messages;
  
  // Always keep system message
  // Walk backwards, count tokens
  // Mark cut point when over budget
  // Ensure cut doesn't split tool_call/tool_result pairs
  
  return { messages: trimmed };
```

**Key constraint from agent-message-window:**
Tool calls are embedded in assistant messages as `type: "toolCall"` in the content array. Their results are `toolResult` messages. When sliding, ensure we never drop a `toolCall` while keeping its `toolResult`.

### 2. Turn End Hook — Structured State Storage

```
File: .pi/extensions/core/events/turn.ts (extend existing)

Register: pi.on("turn_end", async (event, ctx) => { ... })

Extract:
  - Tool names and targets (files, commands, queries)
  - Bash results (success/failure, timing)
  - Files changed (read, write, edit, delete)
  - Entities created/referenced (from ILO extract)
  - Claims made
  - Status (completed, failed, pending)

Store in ILO:
  - Turn node properties:
    turn_id, timestamp, turn_index,
    goal (user message summary),
    files: ["src/auth.py", "src/routes.py"],
    tools: ["wrote", "ran pytest", "searched"],
    results: ["+85 lines", "6/6 passed"],
    entities: ["jwt_handler (0.92)"],
    claims: ["app depends_on jwt_handler"],
    status: "completed"
```

### 3. Interaction with Existing Memory Context

The existing `## Memory Context` injection remains unchanged. It still injects high-confidence entities every turn. The only change is replacing pi's compaction with our FIFO slide.

## Key Decisions

| Decision | Choice | Rationale |
| ---------- | -------- | ----------- |
| **Slide trigger** | Token count (not turn count) | Matches context window budget exactly |
| **Budget** | 200K of 262K total | Leaves ~62K for response + overhead |
| **Pairing safety** | Drop entire turn boundaries | Never split tool_call from tool_result |
| **Structured state format** | ILO Turn node properties | Reuses existing infrastructure |
| **Compaction** | Replaced entirely | FIFO slide is simpler, no lossy summary |
| **Memory Context** | Unchanged | Still injects entities every turn |
| **memory_search** | Unchanged | Still works for deep recall |

## Research Validation

| Paper/Package | Key Finding | Applied As |
| --------------- | ------------- | ------------ |
| **pi-acm** | Sliding window in production pi | Context hook approach validated |
| **Context Decay Benchmark** | FIFO alone = 18% recall | ILO backup is essential |
| **agent-message-window** | Tool pairing must be respected | Drop at turn boundaries |
| **Total Recall** | Context window = cache over durable store | Our core architecture |
| **Sliding Window + Memory Store** | Window + queryable store = best practice | Our exact pattern |
| **InfiAgent** | File system as authoritative record | ILO as authoritative record |
| **PRO-LONG** | Separate persistent state from context | Our dual-layer design |
