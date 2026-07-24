// ============================================================================
// .pi/extensions/core/index.ts — ILO cognitive memory extension
// ============================================================================
// Pi discovers this file on startup. It:
//   1. Registers the ILO interaction loop hooks
//   2. Starts the ILO Rust sidecar
//   3. Provides LLM-invokable tools for entity lookup and linking
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerContextHooks } from './events/context';
import { registerTurnHooks } from './events/turn';
import { registerInputHooks } from './events/input';
import { startIlo, stopIlo } from './lib/ilo-manager';
import { registerIloTools } from './lib/ilo-tools';
import { registerWebSearchTool } from './tools/web-search';
import { registerWebScrapeTool } from './tools/web-scrape';
import { registerWebCrawlTool } from './tools/web-crawl';
import { registerTaskTool } from './tools/task';
import { registerDiagnosticsTool } from './tools/diagnostics';

export default async function (pi: ExtensionAPI): Promise<void> {
  // ── Register interaction loop hooks ────────────────
  registerContextHooks(pi);
  registerInputHooks(pi);
  registerTurnHooks(pi);

  // ── Register ILO tools for the LLM ─────────────────
  registerIloTools(pi);
  registerWebSearchTool(pi);
  registerWebScrapeTool(pi);
  registerWebCrawlTool(pi);
  registerTaskTool(pi);
  registerDiagnosticsTool(pi);

  // ── Guard: protect ILO database files from accidental deletion ──
  pi.on('tool_call', async (event: any) => {
    if (event.toolName !== 'bash') return;
    const cmd: string = (event.input?.command || '').toLowerCase();
    // Only protect the database file. PID and socket files may need cleanup on restart.
    if (cmd.includes('ilo_data.lbug')) {
      event.input.command = 'echo "[ILO GUARD] Cannot delete ILO database file (ilo_data.lbug). This destroys all stored memory."';
      return;
    }
  });

  // ── Start ILO sidecar ──────────────────────────────
  const started = await startIlo();
  if (!started) {
    console.warn('[ilo] ILO sidecar failed to start — running without memory layer');
  }

  // ── Cleanup on shutdown ────────────────────────────
  process.on('SIGTERM', () => stopIlo());
}
