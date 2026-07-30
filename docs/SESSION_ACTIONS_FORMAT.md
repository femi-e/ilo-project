# Session Actions Format

## Design Summary

A compressed representation of coding agent session history that preserves actionable information at ~300 chars per turn (19x smaller than raw conversation). Designed through systematic ablation testing to maximize compression while minimizing information loss.

## Core Principle

The format preserves **three universal streams** from any session:

| Stream | Source | What's Captured |
| -------- | -------- | ----------------- |
| **User input** | `role: "user"` → `type: "text"` blocks | What the user asked |
| **Agent actions** | `role: "assistant"` → `type: "toolCall"` blocks | What tools ran and on what |
| **Tool results** | `role: "toolResult"` → `type: "text"` blocks | First line of output (optional) |

No hardcoded tool keys. Every tool call has `name` + `arguments` (dict). The target is extracted as: `" | ".join(str(v) for v in args.values())`. This works for any tool, existing or future.

## The Format

```
## Session Actions

  T1: {user's first message (full text)}
    {tool}: {target[:40 chars]}
    {tool} ×N: {target[:40 chars]}
    → {first line of tool result[:80 chars]}  (optional)

  T2: {user's second message}
    {tool}: {target[:40 chars]}
    ...
```

### Per-Turn Structure

Each turn starts with `T{N}:` followed by the user's message. Tool calls follow as indented lines. Consecutive identical tool calls are merged: `bash: grep -r "context"...` becomes `bash ×3: grep -r "context"...` when the same command repeats.

### Parameters (validated by ablation)

| Parameter | Value | Rationale |
| ----------- | ------- | ----------- |
| Target truncation | 40 chars | Preserves action semantics, drops noise |
| Tool grouping | Merge consecutive | Reduces repetition without losing info |
| Tool results | First line only | Adds context without bloat |
| User messages | Full text | Goals carry essential intent |
| Assistant text | Dropped | Adds no measurable value |
| Thinking blocks | Dropped | Actively harmful (−1.0 score impact) |

## Empirical Validation

### Ablation Study (15 test sequences, 5 dimensions)

| Dimension | RAW (23Kc) | BASELINE (1.2Kc) | RANDOM (0.08Kc) |
| ----------- | :----------: | :-----------------: | :----------------: |
| Retention | 0.73 | **1.31** | 0.00 |
| Continuation | 0.60 | **0.60** | 0.00 |
| Size | 23,398c | **1,217c (19x)** | 87c |

The baseline format **outperforms** the raw conversation on retention because the raw format has too much noise (tool results, thinking, assistant text) that distracts the model.

### Key Findings (all tests)

| Finding | Confidence | Evidence |
| --------- | :----------: | ---------- |
| Intent format = optimal | ✅ High | Beats raw on retention, matches on continuation |
| Thinking blocks harmful | ✅ High | Always scores below baseline (−1.0) |
| Assistant text useless | ✅ High | Never improves score |
| 40-char truncation safe | ✅ High | Never hurts, sometimes helps |
| First-line results helpful | ⚠️ Medium | Helps in some contexts, not others |
| Tool grouping beneficial | ✅ High | Merge consecutive = better than keep all |

### Metric Definition

The **Five-Dimension Preservation Score** measures format quality:

1. **Tool Recall**: Does the model remember which tools were used? (0-3)
2. **Target Accuracy**: Does the model remember what was acted on? (0-3)
3. **Goal Continuity**: Does the model understand the user's intent? (0-3)
4. **Decision Recall**: Does the model remember key decisions? (0-3)
5. **Temporal Order**: Does the model recall the sequence? (0-3)

**Composite = (sum of 5) / 15 × 10** (0-10 scale)

Test procedure: Feed 4 turns of compressed context, probe each dimension with a targeted question, score response against ground truth from the session file.

## File Format

The format is plain text. It can be:

- **Generated at `before_agent_start`** from the session file (no storage needed)
- **Stored in ILO Turn nodes** for cross-session persistence (optional)
- **Pre-cached** to avoid re-parsing

## Usage

This format is injected into the system prompt as a `## Session Actions` section, alongside the existing `## Memory Context` section. The `context` event handler slides the message array when the token budget is exceeded, and the `turn_end` handler extracts structured data.

```typescript
// Generation (pseudocode):
function generateSessionActions(turns: Turn[]): string {
    return turns.map((turn, i) => {
        const goal = turn.userMessage;
        const tools = groupConsecutive(turn.toolCalls, 40);
        const results = turn.toolResults.slice(0, 3)
            .map(r => firstLine(r).slice(0, 80));
        
        return `T${i+1}: ${goal}\n` +
            tools.map(t => `  ${t.name}${t.count > 1 ? ` ×${t.count}` : ''}: ${t.target}`).join('\n') +
            results.map(r => `  → ${r}`).join('\n');
    }).join('\n');
}
```

## Research Base

| Paper | Finding | Applied As |
| ------- | --------- | ------------ |
| **CoACT** (ACL 2026) | Observation compression must preserve actions | Keep tool calls, drop results |
| **AGORA** (ACL 2026) | Token-level compression destroys action grammar | Keep full tool structure, truncate targets at 40 chars |
| **Commitments Framework** | Context is goals + decisions + constraints | Preserve user goals and tool actions |
| **Context Decay Benchmark** | FIFO alone = 18% recall | Use structured format with ILO backup |
| **agent-message-window** | Never split tool_call/tool_result pairs | Drop at turn boundaries only |
| **Factory.ai** | Structured summarization > alternatives | Our format is structured, not free-text |
