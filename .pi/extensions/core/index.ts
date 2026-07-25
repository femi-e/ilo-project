// ============================================================================
// .pi/extensions/core/index.ts — ILO cognitive memory extension
// ============================================================================
// Pi discovers this file on startup. It:
//   1. Registers the ILO interaction loop hooks
//   2. Starts the ILO Rust sidecar + mistral.rs embedding server
//   3. Registers mistral.rs as a local LLM provider (auto-discovers models)
//   4. Provides LLM-invokable tools for entity lookup and linking
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
import { MISTRAL_CHAT_PORT } from './lib/constants';

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

  // ── Register mistral.rs as a local LLM provider ───
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

  // ── Cleanup on shutdown ───────────────────────────
  process.on('SIGTERM', () => stopIlo());
}

/**
 * Register mistral.rs as a pi provider with auto-discovery of loaded models.
 * Scans the configured chat port and registers all available models.
 */
async function registerMistralProvider(pi: ExtensionAPI): Promise<void> {
  const baseUrl = `http://127.0.0.1:${MISTRAL_CHAT_PORT}/v1`;

  try {
    const res = await fetch(`${baseUrl}/models`);
    if (!res.ok) {
      console.warn(`[mistral] Server at :${MISTRAL_CHAT_PORT} not responding — skipping provider registration`);
      return;
    }

    const { data } = await res.json();

    if (!data || data.length === 0) {
      console.warn('[mistral] No models available on server');
      return;
    }

    pi.registerProvider('mistral', {
      baseUrl,
      apiKey: 'local',
      api: 'openai-completions',
      compat: {
        supportsDeveloperRole: false,       // mistral.rs rejects 'developer' role
        supportsReasoningEffort: false,     // Qwen/other models auto-output reasoning_content
        maxTokensField: 'max_tokens',       // use standard OpenAI field
      },
      models: data.map((m: any) => ({
        id: m.id,
        name: m.id.replace(/^.*\//, ''),   // "Qwen/Qwen3.5-9B" → "Qwen3.5-9B"
        reasoning: false,                    // thinking is auto, not pi-controlled
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
      })),
    });

    console.error(`[mistral] Registered provider with ${data.length} model(s)`);
  } catch (err) {
    console.warn(`[mistral] Could not connect to inference server at ${baseUrl}: ${err}`);
    console.warn('[mistral] Start with: mistralrs serve --model-id <MODEL> --port 1234');
  }
}
