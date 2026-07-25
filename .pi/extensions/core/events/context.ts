// ============================================================================
// events/context.ts — before_agent_start handler (ILO-powered)
// ============================================================================
// On each turn before the LLM call:
//   1. Inject system instructions (once per session)
//   2. Full memory recall — inject actual context as a compact block
//   3. Track injected entities to avoid repetition across turns
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

let SYSTEM_INSTRUCTIONS_INJECTED = false;

// ── Memory context state (per session) ──

interface InjectedMemory {
  nodeId: string;
  label: string;
}

let injectedMemories: InjectedMemory[] = [];

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

/// Format search results into a compact memory context block.
/// Only includes entity nodes (skips turns and claims which are verbose).
/// Returns null if nothing new to inject.
function formatMemoryContext(nodes: any[], maxNodes: number = 5): string | null {
  if (!nodes || nodes.length === 0) return null;

  // Filter to only entity nodes (skip turns, claims — too verbose for context)
  const entityNodes = nodes.filter(n => n.node_type === 'entity').slice(0, maxNodes);
  if (entityNodes.length === 0) return null;

  const lines: string[] = ['## Memory Context'];
  let newCount = 0;

  for (const node of entityNodes) {
    const alreadyInjected = injectedMemories.some(m => m.nodeId === node.id);
    const isTopResult = node.relevance >= 0.9;

    if (alreadyInjected && !isTopResult) continue;

    if (!alreadyInjected) {
      injectedMemories.push({ nodeId: node.id, label: node.label });
    }

    const confidence = (node.confidence || 0.5).toFixed(2);
    const tags = (node.tags || []).filter(Boolean).join(', ');
    lines.push(`  - ${node.label} (${confidence})${tags ? ` — ${tags}` : ''}`);
    newCount++;
  }

  if (newCount === 0) return null;
  return lines.join('\n');
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

  // Reset session state when a new session starts
  pi.on('session_start', () => {
    SYSTEM_INSTRUCTIONS_INJECTED = false;
    injectedMemories = [];
  });

  pi.on('before_agent_start', async (event: any, ctx: any) => {
    const state = getState();
    const userText = state.lastUserText;
    let additions = '';

    // Inject system instructions once per session
    if (!SYSTEM_INSTRUCTIONS_INJECTED) {
      additions += '\n\n' + systemInstructions;
      SYSTEM_INSTRUCTIONS_INJECTED = true;
      // Reset injected memory tracking for new session
      injectedMemories = [];
    }

    // Skip memory retrieval for very short inputs
    if (userText && userText.length >= 10) {
      const healthy = await ensureIlo();
      if (healthy) {
        try {
          // Full recall with graph expansion (list=false)
          const res = await ilo.search(userText, false, undefined);
          const nodes = res.data?.nodes || [];
          const total = res.data?.total || 0;

          if (nodes.length > 0) {
            const contextBlock = formatMemoryContext(nodes, 5);
            if (contextBlock) {
              additions += '\n' + contextBlock;
            }
            if (ctx?.ui && total > 0) {
              ctx.ui.notify(`Memory: ${total} relevant entries`, 'info');
            }
          }
        } catch (err) {
          console.error('[ilo-context] recall failed:', err);
        }
      }
    }

    if (additions) {
      return { systemPrompt: event.systemPrompt + additions };
    }
  });
}
