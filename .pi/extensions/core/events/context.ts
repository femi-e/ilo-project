// ============================================================================
// events/context.ts — before_agent_start handler (ILO-powered)
// ============================================================================
// On each turn before the LLM call:
//   1. Inject system instructions (once per session)
//   2. Quick FTS check — do any entities exist matching the query?
//   3. If yes, inject a one-line hint about using memory_search
//   4. Full recall is deferred to the memory_search tool (LLM-driven)
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ilo } from '../lib/ilo-client';
import { ensureIlo } from '../lib/ilo-manager';
import { getState } from './turn';

// ── System instructions (injected once per session) ──

// Static sections — the parts that don't change
const PROJECT_OVERVIEW_SECTION = `# Project Overview

This is **ILO** — a memory system for coding agents. It remembers entities, their relationships, and past conversations across sessions. Memory is automatic: you don't need to save or load it.

The project has two parts:
- **mem-arch/** — Rust service that stores and retrieves memory
- **.pi/extensions/core/** — TypeScript extension that connects pi to the memory service`;

const MEMORY_FORMAT_SECTION = `# Memory System

This project has a persistent memory system (ILO). When you need to recall past information:
- Use \`memory_search\` to find entities, facts, and past conversations
- Use \`entity_lookup\` to get full details on a specific entity
- Use \`memory_store\` when asked to remember something explicitly
- Use \`entity_connect\` to link related concepts

Memory is automatically saved after each conversation turn. You don't need a tool for that. Just use \`memory_search\` when you need to recall something.`;

const WORKFLOW_SECTION = `# How to Work

1. Before making changes, check git state with \`git_snapshot\`
2. Use \`project_tree\` when you need to understand file locations
3. After meaningful progress, commit with \`git_commit\`
4. If unsure about a file or concept, use \`memory_search\` to check memory

# Hard Rules

- NEVER delete or modify the ILO database files (\`var/ilo_data.lbug\`, \`var/ilo_data.lbug.wal\`) or the Unix socket (\`var/ilo.sock\`) without explicit user confirmation. These files persist across all sessions. Deleting them destroys all stored memory.`;

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

    // Skip for very short inputs
    if (!userText || userText.length < 10) return;

    // Ensure sidecar is alive
    const healthy = await ensureIlo();
    if (!healthy) return;

    try {
      // Cheap check: FTS search (list mode = no graph expansion, fast)
      // If no entities match, skip entirely — zero cost for irrelevant queries
      const check = await ilo.search(userText, true, undefined);
      const total = check.data?.total || 0;
      if (total === 0) return;

      // Inject a one-line hint — LLM decides whether to use memory_search
      ctx.addSystemPrompt(`@memory [hint: ${total} relevant ${total === 1 ? 'entry' : 'entries'} exist. Use memory_search() to retrieve them.]`);

      // Notify on first hit
      if (ctx?.ui) {
        ctx.ui.notify(`Memory hint: ${total} relevant entries`, 'info');
      }
    } catch (err) {
      console.error('[ilo-context] hint failed:', err);
    }
  });
}
