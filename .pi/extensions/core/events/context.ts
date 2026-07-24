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

// ── Processor injection rules (kept from original) ────

const UNIVERSAL_RULES_CUSTOM_TYPE = 'ailo-core';
const RULES_VERSION = 1;

const UNIVERSAL_RULES_TEXT = [
  '### Ailo — Core Behavior Rules',
  '',
  '- I have persistent long-term memory across sessions via a LadybugDB knowledge base.',
  '- I cite sources when making claims from stored beliefs.',
  '- I respect confidence labels: >0.80 = fact, 0.60-0.80 = likely, <0.60 = possible, <0.40 = not injected.',
  '- I never run destructive commands (rm -rf, DROP TABLE, etc.) without user confirmation.',
  '- I adapt my behavior based on what the user asks me to do — coding, teaching, planning, etc.',
  '',
  '---',
].join('\n');

function hasRulesMessage(sessionManager: any): boolean {
  try {
    const entries = sessionManager.getBranch();
    return entries.some((e: any) => e.type === 'custom' && e.customType === UNIVERSAL_RULES_CUSTOM_TYPE);
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// Handler registration
// ═══════════════════════════════════════════════════════════

export function registerContextHooks(pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (ctx) => {
    const state = getState();
    const userText = state.lastUserText;

    // Tier 1: Universal rules (injected once per session if sessionManager is available)
    if (ctx.sessionManager && !hasRulesMessage(ctx.sessionManager)) {
      ctx.sessionManager.addMessage({
        type: 'custom',
        customType: UNIVERSAL_RULES_CUSTOM_TYPE,
        content: UNIVERSAL_RULES_TEXT,
      });
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
      }
    } catch (err) {
      console.error('[ilo-context] recall failed:', err);
      // Non-fatal — LLM can still respond without context
    }
  });
}
