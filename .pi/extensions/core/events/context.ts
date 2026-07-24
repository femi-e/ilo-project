// ============================================================================
// events/context.ts — before_agent_start handler (ILO-powered)
// ============================================================================
// On each turn before the LLM call:
//   1. Extract entities from the user's prompt
//   2. Embed the query for vector search
//   3. Recall context from ILO (FTS + vector + PPR + graph traversal)
//   4. Inject context into the system prompt
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ilo } from '../lib/ilo-client';
import { getState } from './turn';

// ── System instructions (injected once per session) ──

const SYSTEM_INSTRUCTIONS = `
## Project Context

You are working in the **ILO** project — a cognitive memory runtime for coding agents.
The project has two layers:

### Rust sidecar (mem-arch/)
Graph memory database with semantic retrieval. Runs as a sidecar process.
- 10 HTTP endpoints over Unix socket
- PPR graph traversal for associative recall
- BGE-base embeddings via Candle (768-dim, local CPU)
- Hebbian learning loop with wall-clock decay

### Pi extension (.pi/extensions/core/)
TypeScript extension that integrates ILO into pi's turn lifecycle.
- Hooks into before_agent_start and turn_end
- Orchestrates: extract → embed → recall → LLM → learn → store

### Available Tools
- \`project_tree\` — Show live directory structure (always up-to-date)
- \`git_snapshot\` — Show current git branch, status, recent commits
- \`git_commit\` — Stage all changes and commit (auto-generates message)
- \`store\` — Store a belief in long-term memory
- \`entity_lookup\` — Look up a known entity in the knowledge graph
- \`connect\` — Link two entities in the knowledge graph

### Workflow
1. Before changing code, use \`git_snapshot\` to see current state
2. After meaningful changes, use \`git_commit\` to save work
3. Use \`project_tree\` when you need to understand file locations
4. Memory from previous sessions is automatically available
`;

let SYSTEM_HINT_INJECTED = false;



// ═══════════════════════════════════════════════════════════
// Handler registration
// ═══════════════════════════════════════════════════════════

export function registerContextHooks(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event: any, ctx: any) => {
    const state = getState();
    const userText = state.lastUserText;

    // Inject system instructions once per session
    if (!SYSTEM_HINT_INJECTED && ctx.addSystemPrompt) {
      ctx.addSystemPrompt(SYSTEM_INSTRUCTIONS);
      SYSTEM_HINT_INJECTED = true;
    }

    // Skip retrieval for very short inputs
    if (!userText || userText.length < 10) return;

    try {
      // Step 1: Extract entities from the prompt
      const extract = await ilo.extract(userText);

      // Step 2: Embed the query for vector search
      let queryEmb: number[] | undefined;
      try {
        const emb = await ilo.embed(userText, true);
        if (emb.ok && emb.data?.embedding?.length) {
          queryEmb = emb.data.embedding;
        }
      } catch {
        // Embedding failure is non-fatal — falls back to FTS + label match
      }

      // Step 3: Recall context (FTS + vector + PPR)
      const recall = await ilo.recall(userText, queryEmb);

      // Step 4: Inject context into system prompt
      if (recall.ok && recall.data?.context) {
        ctx.addSystemPrompt(recall.data.context);
        // Notify about memory context injection (first turn only)
        if (recall.data.nodes > 0 && ctx?.ui) {
          ctx.ui.notify(`Retrieved ${recall.data.nodes} memory nodes`, 'info');
        }
      }
    } catch (err) {
      console.error('[ilo-context] recall failed:', err);
      // Non-fatal — LLM can still respond without context
    }
  });
}
