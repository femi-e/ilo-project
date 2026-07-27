// ============================================================================
// .pi/extensions/core/index.ts — ILO cognitive memory extension
// ============================================================================
// Pi discovers this file on startup. It:
//   1. Registers the ILO interaction loop hooks
//   2. Starts the ILO Rust sidecar + llama.cpp embedding server
//   3. Registers local inference servers as pi providers (auto-discovers models)
//   4. Provides LLM-invokable tools for entity lookup and linking
// ============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextHooks } from "./events/context";
import { registerTurnHooks } from "./events/turn";
import { registerInputHooks } from "./events/input";
import {
	startIlo,
	stopIlo,
	keepChatAlive,
	setRegisteredProviders,
	setUnregisterProviderCallback,
} from "./lib/ilo-manager";
import { registerIloTools } from "./lib/ilo-tools";
// Web tools disabled — pi-web-access provides better versions
// import { registerWebSearchTool } from './tools/web-search';
// import { registerWebScrapeTool } from './tools/web-scrape';
// import { registerWebCrawlTool } from './tools/web-crawl';
import { registerTaskTool } from "./tools/task";

import { registerDiagnosticsTool } from "./tools/diagnostics";
import {
	LOCAL_CHAT_PORT_START,
	LOCAL_CHAT_PORT_END,
	LOCAL_EMBED_PORT,
} from "./lib/constants";

export default async function (pi: ExtensionAPI): Promise<void> {
	// ── Register interaction loop hooks ────────────────
	registerContextHooks(pi);
	registerInputHooks(pi);
	registerTurnHooks(pi);

	// ── Register LLM tools ────────────────────────────
	registerIloTools(pi);
	// Web tools disabled — pi-web-access provides better versions
	// registerWebSearchTool(pi);
	// registerWebScrapeTool(pi);
	// registerWebCrawlTool(pi);
	registerTaskTool(pi);
	registerDiagnosticsTool(pi);

	// ── Register local inference servers as pi providers ───
	const providerInfo = await registerMistralProvider(pi);
	// Track which providers are for embed vs chat so they can be unregistered on server stop
	if (providerInfo) {
		setRegisteredProviders(providerInfo);
		setUnregisterProviderCallback((name: string) => {
			try {
				pi.unregisterProvider(name);
			} catch {
				/* already gone */
			}
		});
	}

	// ── Guard: protect ILO database files from accidental deletion ──
	pi.on("tool_call", async (event: any) => {
		if (event.toolName !== "bash") return;
		const cmd: string = (event.input?.command || "").toLowerCase();
		if (cmd.includes("ilo_data.lbug")) {
			event.input.command =
				'echo "[ILO GUARD] Cannot delete ILO database file (ilo_data.lbug). This destroys all stored memory."';
			return;
		}
	});

	// ── Start ILO sidecar + embedding server ──────────
	const started = await startIlo();
	if (!started) {
		console.warn(
			"[ilo] ILO sidecar failed to start — running without memory layer",
		);
	}

	// ── Watch for local model selection (keeps chat server alive) ──
	pi.on("model_select", (event: any) => {
		if (event.model?.provider?.startsWith("local-")) {
			keepChatAlive();
		}
	});

	// ── Cleanup on shutdown ───────────────────────────
	process.on("SIGTERM", () => stopIlo());
	pi.on("session_shutdown", () => stopIlo());
}

/**
 * Register local inference servers as pi providers with auto-discovery.
 * Scans a range of ports for running servers (mistral.rs, llama.cpp, etc.)
 * and registers all available models.
 * Returns the provider names split by server type (embed vs chat) for later unregistration.
 */
async function registerMistralProvider(
	pi: ExtensionAPI,
): Promise<{ embed: string[]; chat: string[] } | null> {
	const models: Array<{
		id: string;
		baseUrl: string;
		name: string;
	}> = [];

	// Scan configured port range for inference servers (parallel, fast timeouts)
	const scanTasks = [];
	for (let port = LOCAL_CHAT_PORT_START; port <= LOCAL_CHAT_PORT_END; port++) {
		scanTasks.push(
			(async () => {
				const baseUrl = `http://127.0.0.1:${port}/v1`;
				try {
					const res = await fetch(`${baseUrl}/models`, {
						signal: AbortSignal.timeout(800),
					});
					if (!res.ok) return;

					const { data } = await res.json();
					if (!data || data.length === 0) return;

					for (const m of data) {
						models.push({
							id: m.id,
							baseUrl,
							name: m.id.replace(/^.*\//, ""),
						});
						console.error(`[local] Discovered model "${m.id}" on :${port}`);
					}
				} catch {
					// Port not responding — skip, this is expected during scanning
				}
			})(),
		);
	}
	await Promise.all(scanTasks);

	if (models.length === 0) {
		console.warn("[local] No local inference servers found");
		console.warn(
			`[local] Scanned ports ${LOCAL_CHAT_PORT_START}-${LOCAL_CHAT_PORT_END}`,
		);
		return null;
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

	// Track provider names per server type for later unregistration
	const registered: { embed: string[]; chat: string[] } = {
		embed: [],
		chat: [],
	};
	const embedPort = String(LOCAL_EMBED_PORT);

	for (const [baseUrl, serverModels] of servers) {
		const port = baseUrl.match(/:([0-9]+)\//)?.[1] || "local";
		const providerName =
			serverModels.length === 1
				? `local-${serverModels[0].name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`
				: `local-serve`;

		pi.registerProvider(providerName, {
			baseUrl,
			apiKey: "local",
			api: "openai-completions",
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			},
			models: serverModels.map((m) => ({
				id: m.id,
				name: m.name,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 262144,
				maxTokens: 32768,
				// Qwen models need thinking disabled for reliable tool calling
				chatTemplateKwargs: { enable_thinking: false },
			})),
		});

		// Classify by port: embed server lives on LOCAL_EMBED_PORT (1235), chat on all others
		const serverType = port === embedPort ? "embed" : "chat";
		registered[serverType].push(providerName);

		console.error(
			`[local] Registered ${serverType} provider "${providerName}" with ${serverModels.length} model(s) on port ${port}`,
		);
	}

	return registered;
}
