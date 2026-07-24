# Mode System Skeleton

## Files Created

| File | Purpose |
|---|---|
| `lib/modes.ts` | Mode definitions, state machine, detection, transitions |
| `lib/mode-router.ts` | Per-mode model routing (local vs cloud) |
| `tools/mode.ts` | Tool for LLM to check/transition modes |

## Files to Modify (Implementation Phase)

| File | Changes Needed |
|---|---|
| `lib/bootstrap.ts` | Replace old `MODE_SEEDS` with call to `seedModeEntities()` |
| `events/context.ts` | Add mode detection → tool gating → model routing in `before_agent_start` |
| `events/tool.ts` | Track last tool called for transition detection |
| `index.ts` | Wire mode system, register mode tool |

---

## Data Flow

```
User prompt arrives
        ↓
before_agent_start handler (events/context.ts)
        ↓
1. detectMode(userPrompt)           ← lib/modes.ts
   - Check override, exit signals, tool history, keywords
   - Returns { mode, confidence }
        ↓
2. transitionTo(result.mode)         ← lib/modes.ts
   - Updates in-memory state
        ↓
3. api.setActiveTools(allowedTools)  ← constrains LLM to mode's tool whitelist
        ↓
4. mode rules injected into system prompt
        ↓
LLM sees: "EXECUTE MODE: You are implementing code..."
         + only write, edit, bash, read, etc. are available
```

## Transition Flow

```
research → plan → execute → review → execute → review → done
   ↑         ↓
   └──tutoring──┘
        or
      job-hunt
```

## Mode Properties (lib/modes.ts)

```
ModeConfig {
  id              - unique identifier
  allowedTools    - tool whitelist (setActiveTools enforces this)
  promptRules     - injected as behavior rules
  entrySignals    - keyword patterns that trigger entry
  exitSignals     - keyword patterns that trigger exit
  enforce         - 'strict' | 'suggest' | 'off'
  suggestedModel  - 'local' | 'fast-cloud' | 'reasoning-cloud' | 'different-provider'
  dbEntityName    - for belief storage
}
```

## Model Routing (lib/mode-router.ts)

```
research  → ollama/llama3.2:7b           (fallback: qwen2.5:7b → haiku)
plan      → anthropic/claude-sonnet-4     (fallback: o3 → qwen2.5:32b)
execute   → anthropic/claude-3-haiku      (fallback: gpt-4o-mini → codellama:13b)
review    → openai/gpt-4o-mini            (fallback: qwen2.5:13b)
tutoring  → anthropic/claude-sonnet-4     (fallback: llama3.2:13b)
job-hunt  → anthropic/claude-sonnet-4     (fallback: gpt-4o-mini)
```

## Context Handler Integration (events/context.ts)

```typescript
// In before_agent_start handler:
// (after existing entity detection + mode deduction)

// 1. Detect mode from conversation
const detection = detectMode(event.prompt);
transitionTo(detection.mode);

// 2. Gate tools
const allowed = getAllowedTools(detection.mode);
if (allowed.length > 0) {
  api.setActiveTools([...builtinTools, ...allowed]);
}

// 3. Route model
const health = getDefaultHealth();
const route = routeForMode(detection.mode, health);
// route.provider + route.model → configured via pi's model selection

// 4. Inject mode rules into system prompt
const modeConfig = MODES[detection.mode];
event.systemPrompt += `\n\n${modeConfig.promptRules.join('\n')}`;
```

## Tool Tracking (events/tool.ts)

```typescript
// In tool_result handler:
pi.on('tool_result', async (event) => {
  setLastToolCalled(event.toolName);
  // Rest of existing handler...
});
```

## Mode Transition Tool (tools/mode.ts)

```
LLM calls: mode with action:"check"
  → "Current mode: Execute"

LLM calls: mode with action:"transition", target:"review"
  → "Transitioning to Review mode"

LLM calls: mode with action:"list"
  → Lists all 6 modes with descriptions
```

## What This Enables

1. **No skipping steps** — LLM can't write code in Research/Plan mode (tools aren't available)
2. **Cost savings** — Research uses local Ollama, Execute uses cheap Haiku, only Plan needs expensive Sonnet
3. **Error diversity** — Review uses a different provider than Execute, catching different bugs
4. **Natural flow** — Transitions happen from conversation context, not explicit commands
5. **Observability** — Mode tool lets the LLM check and explain its current state
