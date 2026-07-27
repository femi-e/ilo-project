# Session Actions Format — Design Spec

## Design Decisions

| # | Decision | Value | Rationale |
| :-: | ---------- | ------- | ----------- |
| 1 | Verb set | `wrote` `edited` `read` `deleted` `ran` `searched` `fetched` `committed` | Common, trained-on vocabulary. One verb per domain. |
| 2 | File paths | Relative to project root | Enough for agent to know where to start looking |
| 3 | Bash results | Detailed with success/failure + timing | Helps agent diagnose and improve future actions |
| 4 | Search results | Source used + outcome | Captures what was actually learned |
| 5 | Multi-action turns | Block per turn (indented lines) | Easier to parse than flat lines |
| 6 | Skipped | `ls` `cd` `pwd` `echo`, duplicate reads, no-op calls | Common commands + redundancy = noise |
| 7 | Null results | Marked with `(-)` | Documents that action happened with no meaningful output |
| 8 | Timestamps | Included in bash results | Helps diagnose slow processes |
| 9 | Entity origin turn | ❌ Omitted | Would cloud the context |
| 10 | Skipped entities | ❌ Omitted | Would cloud the context |
| 11 | Custom tool calls | Same verb format | Consistency across all tool types |
| 12 | Entity confidence | Included: `entity: Name (0.95)` | Numbers help agent prioritize |

## The Format

```
## Session Actions ({token_estimate} tokens · {n} turns)

  {turn}:
    {verb}: {target} ({result})
    entity: {label} ({confidence})
    claimed: {subject} {link} {object}
    {verb}: {target} ({result})
    ...

  {turn}:
    ...
```

## Verb Reference

| Domain | Verb | Example |
| -------- | :----: | --------- |
| **File write** | `wrote` | `wrote: src/auth.rs (+120 lines · 2 functions)` |
| **File edit** | `edited` | `edited: src/models.py (-2 lines · removed unused field)` |
| **File read** | `read` | `read: src/database.py (200 lines · existing schema)` |
| **File delete** | `deleted` | `deleted: src/old.py` |
| **Bash** | `ran` | `ran: cargo test (4/4 passed · 2.3s)` |
| **Web search** | `searched` | `searched: "Flask JWT" (5 results · used flask-jwt-extended)` |
| **URL fetch** | `fetched` | `fetched: docs/api.json (12KB)` |
| **Git commit** | `committed` | `committed: "feat: add auth" (3 files)` |
| **Memory search** | `recalled` | `recalled: "auth config" (2 results)` |
| **Tool (custom)** | `ran:{tool_name}` | `ran: deploy_to_ec2 (instance: i-1234)` |

## Result Notation

| Situation | Notation | Example |
| ----------- | :--------: | --------- |
| Success | Result description | `(4/4 passed · 2.3s)` |
| Failure | Error description | `(failed: compilation error)` |
| No result | Dash | `(-)` |
| File write | Line count | `(+120 lines · 2 functions)` |
| File read | Size/summary | `(200 lines · existing schema)` |
| Entity | Confidence score | `(0.95)` |

## Tail Filtering (Token Budget)

When the action block exceeds the token budget, oldest turns are dropped:

```
Before (200 turns, 15K tokens):
  {turns: 1-200}

After drop (180 turns, 10K tokens):
  {turns: 21-200}
  ↑ 20 oldest turns removed
```

The system prompt + memory context + action block must stay under the configured budget (default: 160K of 262K total).
