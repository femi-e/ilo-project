// ============================================================================
// .pi/extensions/core/index.ts ? Extension entry point (Pi-canonical location)
// ============================================================================
// Pi auto-discovers .pi/extensions/*/index.ts. All source modules are
// co-located in this directory: lib/, tools/, events/, schema/, commands/.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DbLayer } from './lib/db';
import { applySchema } from './schema/registry';
import './schema/all';
import { start as startEmbedding, stop as stopEmbedding } from './lib/embedding';
import { setEngineState } from './lib/engine';
import { seedDefaults } from './lib/bootstrap';
import { registerContextHooks } from './events/context';
import { registerInputHooks } from './events/input';
import { registerTurnHooks } from './events/turn';
import { registerToolHooks } from './events/tool';
import { registerBashHooks } from './events/bash';
import { registerCommands } from './commands/index';
import { stopPlaywright } from './lib/web-lib';
import { markCleanShutdown } from './lib/recovery';
import { closeDiagConnection } from './lib/diagnostics';
import { EXT_VAR_DIR } from './lib/constants';
import * as path from 'node:path';

// ?? Tool Registry ????????????????????????????????????????
// Replace semantic-discovery seeding with a central registry.
// Each tool module exports a ToolDefinition; we collect them here.

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

// Register all tool definitions (order doesn't matter — registry uses Map)
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

let engine: { db: DbLayer; sessionId: string } | null = null;

// ???????????????????????????????????????????????????????????
// Extension activation
// ???????????????????????????????????????????????????????????

export default function activate(api: ExtensionAPI) {
  // Extension loaded — session_start will handle UI

  api.on('session_start', async (event: any, ctx: any) => {
    try {
      ctx.ui.setWidget('ailo-loading', ['Ailo starting...']);

      const dbPath = process.env.AILO_DB_PATH || path.join(EXT_VAR_DIR, 'ailo.lbug');
      const db = new DbLayer(dbPath);

      const opened = await db.open();
      if (!opened) {
        const msg = '[ailo] Failed to open database at ' + dbPath;
        console.error(msg);
        ctx.ui.notify(msg, 'error');
        ctx.ui.setWidget('ailo-loading', ['? Database error']);
        return;
      }

      ctx.ui.setWidget('ailo-loading', ['Ailo starting... db ready']);

      // Load extensions (VECTOR, FTS)
      await db.loadExts();

      await applySchema(db);
      await seedDefaults(db);

      ctx.ui.setWidget('ailo-loading', ['Ailo starting... loading tools']);
      startEmbedding().then(ready => {
        ctx.ui.setStatus('embedding', ready ? 'emb: on' : 'emb: off');
      }).catch(() => {
        ctx.ui.setStatus('embedding', 'emb: err');
      });

      const sessionId = new Date().toISOString()
        .replace(/[T:]/g, '-')
        .replace(/\..+/, '')
        + '-' + Math.random().toString(36).substring(2, 6);

      engine = { db, sessionId };
      setEngineState(engine);

      // Register event hooks
      registerContextHooks(api);
      registerInputHooks(api);
      registerTurnHooks(api);
      registerToolHooks(api);

      // Register bash handler
      registerBashHooks(api);

      // ?? Register all tools via the central registry ??
      registry.registerAll(api);

      // Register commands
      registerCommands(api);

      // Show tool status
      const toolNames = registry.getNames();
      ctx.ui.setStatus('tools', `${toolNames.length} tools`);
      ctx.ui.setWidget('ailo-loading', [`Ailo: ${toolNames.length} tools, warming searxng...`]);

      // ?? Seed tool entities in DB via the registry ??
      registry.seedToDb(db).catch((err: any) =>
        console.warn('[ailo] Tool entity seeding:', err.message)
      );

      // Pre-warm SearXNG in background — clears loading widget when ready
      import('./lib/web-lib').then(({ searchWeb }) => {
        searchWeb('ping', 1).then(() => {
          ctx.ui.setStatus('searxng', '? search');
        }).catch(() => {
          ctx.ui.setStatus('searxng', '? no search');
        }).finally(() => {
          ctx.ui.setWidget('ailo-loading', undefined);
        });
      });

      // Safety timeout: clear loading widget after 8s even if SearXNG fails
      setTimeout(() => ctx.ui.setWidget('ailo-loading', undefined), 8000);
    } catch (err: any) {
      const fatal = '[ailo] session_start failed: ' + err.message;
      console.error(fatal);
      ctx.ui.notify(fatal, 'error');
      ctx.ui.setWidget('ailo-loading', ['? Ailo startup failed']);
    }
  });

  api.on('session_shutdown', async (_event: any, ctx: any) => {
    try {
      // Stop Playwright if running
      await stopPlaywright();

      // Stop SearXNG Docker container (fire-and-forget)
      try {
        const { execSync } = await import('node:child_process');
        const dockerCmd = process.platform === 'win32' ? 'wsl -d Ubuntu docker stop searxng' : 'docker stop searxng';
        execSync(dockerCmd, { timeout: 5000, windowsHide: true, stdio: 'ignore' });
      } catch { /* container already stopped or Docker unavailable */ }

      await stopEmbedding();

      // Close diagnostic connection (if open)
      closeDiagConnection();

      // CHECKPOINT
      if (engine?.db) {
        try { await engine.db.exec('CHECKPOINT'); } catch {}
        markCleanShutdown();
        engine.db.close();
      }

      setEngineState(null);
      engine = null;

      // Clear UI
      ctx.ui.setWidget('ailo-loading', undefined);
      ctx.ui.setStatus('tools', '');
      ctx.ui.setStatus('embedding', '');
      ctx.ui.setStatus('searxng', '');
    } catch (err: any) {
      console.error('[ailo] session_shutdown failed:', err.message);
    }
  });
}

export function deactivate(): void {
  engine = null;
  setEngineState(null);
}
