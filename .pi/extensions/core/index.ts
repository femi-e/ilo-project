// ============================================================================
// .pi/extensions/core/index.ts — ILO cognitive memory extension
// ============================================================================
// Pi discovers this file on startup. It:
//   1. Registers the ILO interaction loop hooks
//   2. Starts the ILO Rust sidecar + llama.cpp embedding server
//   3. Registers local inference servers as pi providers (auto-discovers models)
//   4. Provides LLM-invokable tools for entity lookup and linking
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerContextHooks } from './events/context';
import { registerTurnHooks } from './events/turn';
import { registerInputHooks } from './events/input';
import { startIlo, stopIlo, keepChatAlive } from './lib/ilo-manager';
import { registerIloTools } from './lib/ilo-tools';
import { registerWebSearchTool } from './tools/web-search';
import { registerWebScrapeTool } from './tools/web-scrape';
import { registerWebCrawlTool } from './tools/web-crawl';
import { registerTaskTool } from './tools/task';
import { registerDiagnosticsTool } from './tools/diagnostics';
import { LOCAL_CHAT_PORT_START, LOCAL_CHAT_PORT_END } from './lib/constants';

export default async function (pi: ExtensionAPI): Promise<void> {
  // ── Register interaction loop hooks ────────────────
  registerContextHooks(pi);
  registerInputHooks(pi);
  registerTurnHooks(pi);

  // ── Register LLM tools ────────────────────────────
  registerIloTools(pi);
  registerWebSearchTool(pi);
  registerWebScrapeTool(pi);
  registerWebCrawlTool(pi);
  registerTaskTool(pi);
  registerDiagnosticsTool(pi);

  // ── Register local inference servers as pi providers ───
  await registerMistralProvider(pi);

  // ── Guard: protect ILO database files from accidental deletion ──
  pi.on('tool_call', async (event: any) => {
    if (event.toolName !== 'bash') return;
    const cmd: string = (event.input?.command || '').toLowerCase();
    if (cmd.includes('ilo_data.lbug')) {
      event.input.command = 'echo "[ILO GUARD] Cannot delete ILO database file (ilo_data.lbug). This destroys all stored memory."';
      return;
    }
  });

  // ── Start ILO sidecar + embedding server ──────────
  const started = await startIlo();
  if (!started) {
    console.warn('[ilo] ILO sidecar failed to start — running without memory layer');
  }

  // ── Watch for local model selection (keeps chat server alive) ──
  pi.on('model_select', (event: any) => {
    if (event.model?.provider?.startsWith('local-')) {
      keepChatAlive();
    }
  });

  // ── Cleanup on shutdown ───────────────────────────
  process.on('SIGTERM', () => stopIlo());
  pi.on('session_shutdown', () => stopIlo());
}

/**
 * Register local inference servers as pi providers with auto-discovery.
 * Scans a range of ports for running servers (mistral.rs, llama.cpp, etc.)
 * and registers all available models.
 */
async function registerMistralProvider(pi: ExtensionAPI): Promise<void> {
  const models: Array<{
    id: string;
    baseUrl: string;
    name: string;
  }> = [];

  // Scan configured port range for inference servers
  for (let port = LOCAL_CHAT_PORT_START; port <= LOCAL_CHAT_PORT_END; port++) {
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    try {
      const res = await fetch(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) continue;

      const { data } = await res.json();
      if (!data || data.length === 0) continue;

      for (const m of data) {
        models.push({
          id: m.id,
          baseUrl,
          name: m.id.replace(/^.*\//, ''),
        });
        console.error(`[local] Discovered model "${m.id}" on :${port}`);
      }
    } catch {
      // Port not running a compatible server — skip
      continue;
    }
  }

  if (models.length === 0) {
    console.warn('[local] No local inference servers found');
    console.warn(`[local] Scanned ports ${LOCAL_CHAT_PORT_START}-${LOCAL_CHAT_PORT_END}`);
    return;
  }

  // Group by baseUrl — each server gets one provider entry with its models
  // For simplicity, register each server under its own provider name.
  // If multiple servers are found, use the first server's baseUrl and list all models.
  // pi will route by model ID, sending each model to the right server via the baseUrl.
  // Actually, pi's provider model doesn't support per-model baseUrls out of the box.
  // So we register one provider per port with unique names.
  const servers = new Map<string, typeof models>();
  for (const m of models) {
    if (!servers.has(m.baseUrl)) servers.set(m.baseUrl, []);
    servers.get(m.baseUrl)!.push(m);
  }

  let providerIndex = 0;
  for (const [baseUrl, serverModels] of servers) {
    const port = baseUrl.match(/:([0-9]+)\//)?.[1] || 'local';
    const providerName = serverModels.length === 1
      ? `local-${serverModels[0].name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
      : `local-serve`;

    pi.registerProvider(providerName, {
      baseUrl,
      apiKey: 'local',
      api: 'openai-completions',
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: 'max_tokens',
      },
      models: serverModels.map((m) => ({
        id: m.id,
        name: m.name,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      })),
    });

    console.error(`[local] Registered provider "${providerName}" with ${serverModels.length} model(s) on port ${port}`);
    providerIndex++;
  }
}
