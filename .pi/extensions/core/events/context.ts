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

// ── Project context (injected once per session) ─────

const PROJECT_OVERVIEW = `
This project is **ILO** — a cognitive memory runtime for coding agents.
It has two parts:

1. **mem-arch/** — Rust sidecar (graph memory, embeddings, PPR retrieval)
2. **.pi/extensions/core/** — Pi coding agent extension (TypeScript)

Available tools for navigating project:
- \`project_tree\` — show live directory structure
- \`git_snapshot\` — show branch, status, recent commits
- \`git_commit\` — stage + commit with auto-generated message

Git workflow: commit after meaningful changes. Use \`git_snapshot\`
before and after to verify state.
`;

let PROJECT_HINT_INJECTED = false;



// ═══════════════════════════════════════════════════════════
// Handler registration
// ═══════════════════════════════════════════════════════════

export function registerContextHooks(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event: any, ctx: any) => {
    const state = getState();
    const userText = state.lastUserText;

    // Inject project hint once per session (before ILO context)
    if (!PROJECT_HINT_INJECTED && ctx.addSystemPrompt) {
      ctx.addSystemPrompt(PROJECT_OVERVIEW);
      PROJECT_HINT_INJECTED = true;
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
