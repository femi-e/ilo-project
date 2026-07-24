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

// Static sections — the parts that don't change
const PROJECT_OVERVIEW_SECTION = `# Project Overview

This is **ILO** — a memory system for coding agents. It remembers entities, their relationships, and past conversations across sessions. Memory is automatic: you don't need to save or load it.

The project has two parts:
- **mem-arch/** — Rust service that stores and retrieves memory
- **.pi/extensions/core/** — TypeScript extension that connects pi to the memory service`;

const MEMORY_FORMAT_SECTION = `# How Memory Works

When you receive a block like this, it's your memory from past sessions:

  @session [query: your question]

  # Focus:
    EntityName [confidence: 0.95]    \u2190 things that match your question

  # Related:
    OtherEntity [rel: 0.45]         \u2190 things connected to those matches

- **# Focus** entities are directly relevant to what you asked
- **# Related** entities are connected to Focus via past conversations
- Higher scores (0.0-1.0) mean stronger relevance
- If memory is empty, the block won't appear

When you mention new information, it's automatically saved as memory for future sessions. You don't need to call a tool for this.`;

const WORKFLOW_SECTION = `# How to Work

1. Before making changes, check git state with \`git_snapshot\`
2. Use \`project_tree\` when you need to understand file locations
3. After meaningful progress, commit with \`git_commit\`
4. If unsure about a file or concept, use \`entity_lookup\` to check memory`;

let SYSTEM_HINT_INJECTED = false;

/// Dynamically build the tools section from pi's tool registry.
function buildToolsSection(pi: any): string {
  try {
    const allTools = pi.getAllTools?.() || [];
    if (!allTools.length) return '';

    const lines = ['# Your Tools', ''];
    for (const tool of allTools) {
      const name = tool.name || '';
      const desc = tool.description || tool.promptSnippet || '';
      if (name && desc) {
        lines.push('- **' + name + '** - ' + desc);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}



// ═══════════════════════════════════════════════════════════
// Handler registration
// ═══════════════════════════════════════════════════════════

export function registerContextHooks(pi: ExtensionAPI): void {
  // Build system instructions once using live tool registry
  const systemInstructions = [
    PROJECT_OVERVIEW_SECTION,
    MEMORY_FORMAT_SECTION,
    buildToolsSection(pi),
    WORKFLOW_SECTION,
  ].filter(Boolean).join('\n\n');

  pi.on('before_agent_start', async (event: any, ctx: any) => {
    const state = getState();
    const userText = state.lastUserText;

    // Inject system instructions once per session
    if (!SYSTEM_HINT_INJECTED && ctx.addSystemPrompt) {
      ctx.addSystemPrompt(systemInstructions);
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
