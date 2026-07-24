// ============================================================================
// .pi/extensions/core/index.ts — Extension entry point (ILO-powered)
// ============================================================================
// Pi discovers .pi/extensions/*/index.ts on startup.
// Registers all hooks and tools for the ILO cognitive memory runtime.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerContextHooks } from './events/context';
import { registerInputHooks } from './events/input';
import { registerTurnHooks } from './events/turn';
import { registerToolHooks } from './events/tool';
import { registerBashHooks } from './events/bash';
import { registerCommands } from './commands/index';
import { startIlo, stopIlo } from './lib/ilo-manager';
import { markCleanShutdown } from './lib/recovery';
import { closeDiagConnection } from './lib/diagnostics';

// ── Tool Registry ─────────────────────────────────────

import { ToolRegistry } from './lib/tool-registry';
import { storeToolDef, forgetToolDef } from './tools/store';
import { search2ToolDef } from './tools/search2';
import { ingestToolDef } from './tools/ingest';
import { webToolDef, scrapeToolDef, crawlToolDef } from './tools/web';
import { taskToolDef } from './tools/task';
import { configToolDef } from './tools/config';
import { diagToolDef, quickDiagToolDef } from './tools/diagnostics';
import { readCachedToolDef, cacheInvalidateToolDef, cacheStatsToolDef } from './tools/file-cache';
import { modeToolDef } from './tools/mode';

const registry = new ToolRegistry();
registry.add(storeToolDef);
registry.add(forgetToolDef);
registry.add(search2ToolDef);
registry.add(ingestToolDef);
registry.add(webToolDef);
registry.add(scrapeToolDef);
registry.add(crawlToolDef);
registry.add(taskToolDef);
registry.add(configToolDef);
registry.add(diagToolDef);
registry.add(quickDiagToolDef);
registry.add(readCachedToolDef);
registry.add(cacheInvalidateToolDef);
registry.add(cacheStatsToolDef);
registry.add(modeToolDef);

// ═══════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════

export default async function (pi: ExtensionAPI): Promise<void> {
  // ── Register lifecycle hooks ────────────────────────
  registerContextHooks(pi);   // before_agent_start: extract → embed → recall → inject
  registerInputHooks(pi);     // input: store user text for context
  registerTurnHooks(pi);      // turn_end: learn → remember
  registerToolHooks(pi);      // tool: error handling, health checks
  registerBashHooks(pi);      // bash: command logging
  registerCommands(pi);       // custom slash commands

  // ── Register tools ─────────────────────────────────
  registry.registerAll(pi);

  // ── Start ILO sidecar ──────────────────────────────
  try {
    const started = await startIlo();
    if (!started) {
      console.warn('[ailo] ILO sidecar failed to start — running without memory');
    }
  } catch (err) {
    console.warn('[ailo] ILO startup error:', err);
  }

  // ── Cleanup on shutdown ────────────────────────────
  process.on('SIGTERM', () => {
    stopIlo();
    markCleanShutdown();
    closeDiagConnection();
  });
}
