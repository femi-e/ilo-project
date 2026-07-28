// ============================================================================
// lib/context-rebuild-llm.ts — Fast 4B model call for memory extraction
// ============================================================================
// Calls a local 4B model (OpenAI-compatible API, port 1236) to extract
// entities, claims, and chunk relevance scores from the current context.
// Optimized for low latency: minimal prompt, no analysis/plan output.
// ============================================================================

import { LOCAL_CHAT_PORT_START } from "../lifecycle/constants";

// ── Default 4B model port (LOCAL_CHAT_PORT_START + 2 = 1236) ──
const _4B_PORT = parseInt(
	process.env.ILO_4B_PORT || String(LOCAL_CHAT_PORT_START + 2),
	10,
);
const _4B_BASE = `http://127.0.0.1:${_4B_PORT}/v1/chat/completions`;
const _4B_TIMEOUT = parseInt(process.env.ILO_4B_TIMEOUT || "15000", 10);

// ── 4B model ID: auto-detected from /v1/models, with env override fallback ──
let _4bModelId: string | null = null;
function getModelId(): string {
	return _4bModelId || process.env.ILO_4B_MODEL || "default";
}

// ── Output types ─────────────────────────────────────────────

export interface ContextRebuildResult {
	chunk_scores: Record<string, number>;
	extracted_entities: Array<{
		name: string;
		type:
			| "component"
			| "file"
			| "tool"
			| "service"
			| "concept"
			| "person"
			| "library"
			| "config"
			| "task"
			| "other";
		confidence: number;
		tags?: string[];
	}>;
	extracted_claims: Array<{
		subject: string;
		relationship: string;
		object: string;
		category:
			| "Depends"
			| "Intends"
			| "Implements"
			| "Contains"
			| "Relates"
			| "References"
			| "Precedes";
		confidence: number;
	}>;
}

// ── Compact system prompt for the 4B model ──────────────────
// Keep this SHORT — every token is paid in TTFT latency.

const SYSTEM_PROMPT = `Extract structured info from a user query and context. Output ONLY valid JSON — no reasoning, no preamble, no markdown.

Schema:
{
  "chunk_scores": {},
  "extracted_entities": [{"name":"...","type":"...","confidence":0.0-1.0,"tags":["..."]}],
  "extracted_claims": [{"subject":"a","relationship":"...","object":"b","category":"...","confidence":0.0-1.0}]
}

Entity types: component|file|tool|service|concept|person|library|config|task|other
Claim categories: Depends|Intends|Implements|Contains|Relates|References|Precedes

Confidence: 0.9+ direct mention, 0.5-0.8 strong implication, <0.5 weak signal. Be precise — only extract what's clearly present.`;

// ── Build user prompt with query + optional context ─────────

function buildUserPrompt(
	query: string,
	contextSummary?: string,
	chunkPreviews?: string[],
): string {
	const parts: string[] = [];

	parts.push("## User Query");
	parts.push(query);

	if (contextSummary) {
		parts.push("");
		parts.push("## Context Summary");
		parts.push(contextSummary);
	}

	if (chunkPreviews && chunkPreviews.length > 0) {
		parts.push("");
		parts.push("## Context Chunks");
		for (let i = 0; i < chunkPreviews.length; i++) {
			parts.push(`[${i}] ${chunkPreviews[i]}`);
		}
		parts.push("");
		parts.push(
			'Score each chunk index ("0", "1", ...) 0.0-1.0 by relevance to the query.',
		);
	}

	// Short reminder to use JSON — system prompt has the full schema.
	parts.push("");
	parts.push("Respond with the JSON schema from the system prompt.");

	return parts.join("\n");
}

// ── Call the 4B model ──────────────────────────────────────

async function call4BModel(
	userPrompt: string,
	signal?: AbortSignal,
): Promise<ContextRebuildResult | null> {
	const systemMsg = { role: "system" as const, content: SYSTEM_PROMPT };
	const userMsg = { role: "user" as const, content: userPrompt };

	const body = {
		model: getModelId(),
		messages: [systemMsg, userMsg],
		temperature: 0.1,
		max_tokens: 1024,
		// Disable thinking for reliable structured output on Qwen models
		chat_template_kwargs: { enable_thinking: false },
	};

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), _4B_TIMEOUT);

	try {
		const res = await fetch(_4B_BASE, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: signal
				? combineAbortSignals(signal, controller.signal)
				: controller.signal,
		});

		clearTimeout(timer);

		if (!res.ok) {
			console.error(
				`[context-rebuild-llm] 4B model returned ${res.status}: ${await res.text().catch(() => "")}`,
			);
			return null;
		}

		const data = await res.json();
		const choice = data?.choices?.[0]?.message;
		if (!choice) {
			console.error("[context-rebuild-llm] No choice in response");
			return null;
		}

		// Try tool call first (if the model supports function calling)
		const toolCalls = choice.tool_calls;
		if (toolCalls && toolCalls.length > 0) {
			const args = toolCalls[0]?.function?.arguments;
			if (args) {
				try {
					const parsed = typeof args === "string" ? JSON.parse(args) : args;
					return validateAndFill(parsed);
				} catch (e) {
					console.error(
						"[context-rebuild-llm] Failed to parse tool call args:",
						e,
					);
				}
			}
		}

		// Fallback: parse JSON from text content
		const content: string = choice.content || "";
		const jsonMatch = content.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]);
				return validateAndFill(parsed);
			} catch (e) {
				console.error(
					"[context-rebuild-llm] Failed to parse JSON from content:",
					e,
				);
				// Log the raw content for debugging
				console.error(
					"[context-rebuild-llm] Raw content:",
					content.slice(0, 500),
				);
			}
		}

		console.error(
			"[context-rebuild-llm] No structured output found in response",
		);
		return null;
	} catch (err: any) {
		clearTimeout(timer);
		if (err.name === "AbortError") {
			console.error("[context-rebuild-llm] Request timed out");
		} else {
			console.error("[context-rebuild-llm] Request failed:", err.message);
		}
		return null;
	}
}

// ── Validate and fill defaults ─────────────────────────────

function validateAndFill(raw: any): ContextRebuildResult {
	const result: ContextRebuildResult = {
		chunk_scores: raw.chunk_scores || {},
		extracted_entities: [],
		extracted_claims: [],
	};

	// Validate entities
	if (Array.isArray(raw.extracted_entities)) {
		const validTypes = [
			"component",
			"file",
			"tool",
			"service",
			"concept",
			"person",
			"library",
			"config",
			"task",
			"other",
		];
		for (const e of raw.extracted_entities) {
			if (e && e.name) {
				result.extracted_entities.push({
					name: String(e.name),
					type: validTypes.includes(e.type) ? e.type : "other",
					confidence: clamp(Number(e.confidence) || 0.5, 0, 1),
					tags: Array.isArray(e.tags) ? e.tags.map(String) : undefined,
				});
			}
		}
	}

	// Validate claims
	if (Array.isArray(raw.extracted_claims)) {
		const validCategories = [
			"Depends",
			"Intends",
			"Implements",
			"Contains",
			"Relates",
			"References",
			"Precedes",
		];
		for (const c of raw.extracted_claims) {
			if (c && c.subject && c.object) {
				result.extracted_claims.push({
					subject: String(c.subject),
					relationship: String(c.relationship || "relates_to"),
					object: String(c.object),
					category: validCategories.includes(c.category)
						? c.category
						: "Relates",
					confidence: clamp(Number(c.confidence) || 0.5, 0, 1),
				});
			}
		}
	}

	return result;
}

// ── Utility: clamp a number between min and max ────────────

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

// ── Utility: combine two AbortSignals ──────────────────────

function combineAbortSignals(s1: AbortSignal, s2: AbortSignal): AbortSignal {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	s1.addEventListener("abort", onAbort);
	s2.addEventListener("abort", onAbort);
	if (s1.aborted || s2.aborted) controller.abort();
	return controller.signal;
}

// ── Main entry point ──────────────────────────────────────

/**
 * Score context chunks for relevance using the 4B model.
 * Returns an array of scores (0.0 = drop, 1.0 = essential), or null if the model is unreachable.
 */
export async function scoreChunksWith4BModel(
	chunks: Array<{ role: string; preview: string }>,
	latestQuery: string,
	signal?: AbortSignal,
): Promise<number[] | null> {
	const chunkSummary = chunks
		.map((c, i) => `[${i}] ${c.role}: ${c.preview}`)
		.join("\n");

	const n = chunks.length;
	const userPrompt = `You manage context for a coding assistant. Score each message chunk for relevance to the current conversation. Return ONLY a JSON array of exactly ${n} scores (one per chunk) 0.0-1.0 matching the chunk indices below.

Latest user query:
${latestQuery}

Chunks:
${chunkSummary}`;

	try {
		const res = await fetch(_4B_BASE, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: signal
				? combineAbortSignals(signal, AbortSignal.timeout(_4B_TIMEOUT))
				: AbortSignal.timeout(_4B_TIMEOUT),
			body: JSON.stringify({
				model: getModelId(),
				messages: [{ role: "user", content: userPrompt }],
				temperature: 0.1,
				max_tokens: 2048,
				chat_template_kwargs: { enable_thinking: false },
			}),
		});
		if (!res.ok) return null;
		const data = await res.json();
		const text = data?.choices?.[0]?.message?.content || "";
		const json = text.match(/\[[\s\S]*\]/);
		if (!json) return null;
		const scores: number[] = JSON.parse(json[0]);
		if (!Array.isArray(scores) || scores.length !== chunks.length) return null;
		return scores.map((s) => Math.max(0, Math.min(1, Number(s))));
	} catch {
		return null;
	}
}

/**
 * Analyze a user query and context using the 4B model.
 * The model performs:
 *   - Task analysis
 *   - Entity extraction
 *   - Claim extraction with relationship categorization
 *   - Chunk relevance scoring
 *   - Plan generation
 *
 * @param query - The user's current query
 * @param options.contextSummary - Optional high-level context summary
 * @param options.chunkPreviews - Optional previews of context chunks for scoring
 * @param options.signal - Optional AbortSignal
 * @returns Structured analysis result, or null if the model is unreachable
 */
export async function analyzeWith4BModel(
	query: string,
	options?: {
		contextSummary?: string;
		chunkPreviews?: string[];
		signal?: AbortSignal;
	},
): Promise<ContextRebuildResult | null> {
	if (!query || query.trim().length === 0) {
		console.error("[context-rebuild-llm] Empty query");
		return null;
	}

	const userPrompt = buildUserPrompt(
		query,
		options?.contextSummary,
		options?.chunkPreviews,
	);

	return call4BModel(userPrompt, options?.signal);
}

/**
 * Check if the 4B model is reachable.
 */
export async function is4BModelAvailable(): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${_4B_PORT}/v1/models`, {
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) return false;
		// Capture the actual model ID from the server to avoid "default" fragility
		const data = (await res.json()) as { data?: Array<{ id: string }> };
		if (data?.data?.[0]?.id) {
			_4bModelId = data.data[0].id;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the configured 4B model URL for debugging.
 */
export function get4BModelUrl(): string {
	return _4B_BASE;
}
