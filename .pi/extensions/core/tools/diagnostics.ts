// ============================================================================
// tools/diagnostics.ts — In-process diagnostic tools for the LLM
// ============================================================================
// Exposes system diagnostics as LLM-callable tools: run diagnostics,
// quick health check, and DB ping.
//
// Backend: lib/diagnostics.ts (separate read-only DB connection)
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { hasEngine } from '../lib/engine';
import { runDiagnostics, formatDiagReport, pingDb, quickHealth } from '../lib/diagnostics';
import type { ToolDefinition } from '../lib/tool-registry';

// ── Tool definitions (for central registry) ──────────────

export const diagToolDef: ToolDefinition = {
  name: 'diagnostics',
  label: 'Diagnostics',
  description: 'Run full system diagnostics: DB health, embedding, WAL, schema, storage counts',
  category: 'tracking',
  aliases: 'diagnose, health, status, report',
  promptSnippet: 'Run full system diagnostics and return a structured health report',
  promptGuidelines: [
    'Use diagnostics to inspect system health — DB, embedding, WAL, storage, schema.',
    'Use diagnostics when troubleshooting a problem or before starting a major operation.',
    'Use diagnostics ping for a simple database reachability check.',
  ],
  register: registerDiagTool,
};

export const quickDiagToolDef: ToolDefinition = {
  name: 'health',
  label: 'Health',
  description: 'Quick one-line system health status: DB connection, beliefs count, embedding, WAL size',
  category: 'tracking',
  aliases: 'ping, status, heartbeat',
  promptSnippet: 'Get a one-line system health status string',
  promptGuidelines: [
    'Use health for a fast, one-line status check without the full diagnostic report.',
  ],
  register: registerQuickHealthTool,
};

// ── Registration functions ───────────────────────────────

export function registerDiagTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'diagnostics',
    label: 'Diagnostics',
    description: 'Run full system diagnostics: DB node/edge counts, embedding status, WAL health, storage, schema.',
    promptSnippet: diagToolDef.promptSnippet,
    promptGuidelines: diagToolDef.promptGuidelines,
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      if (!hasEngine()) {
        return {
          content: [{ type: 'text', text: 'Database not available. Engine is not initialized.' }],
          details: {},
        };
      }

      onUpdate?.({ content: [{ type: 'text', text: 'Collecting diagnostics...' }] });

      try {
        const report = await runDiagnostics();
        const formatted = formatDiagReport(report);
        return { content: [{ type: 'text', text: formatted }], details: { report } };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Diagnostics failed: ${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },
  });
}

export function registerQuickHealthTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'health',
    label: 'Health',
    description: 'Quick one-line system health status. Faster than full diagnostics.',
    promptSnippet: quickDiagToolDef.promptSnippet,
    promptGuidelines: quickDiagToolDef.promptGuidelines,
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      if (!hasEngine()) {
        return {
          content: [{ type: 'text', text: 'Database not available.' }],
          details: {},
        };
      }

      onUpdate?.({ content: [{ type: 'text', text: 'Checking...' }] });

      try {
        const health = await quickHealth();
        return { content: [{ type: 'text', text: health }], details: {} };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Health check failed: ${err.message}` }],
          details: { error: err.message },
          isError: true,
        };
      }
    },
  });
}