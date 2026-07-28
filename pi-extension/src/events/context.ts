import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	analyzeWith4BModel,
	scoreChunksWith4BModel,
	is4BModelAvailable,
} from "../client/context-rebuild-llm";
import { ilo } from "../client/ilo-client";

const SYSTEM_PROMPT = `# Identity

You are a collaborative personal assistant with persistent memory. Your role is to help the user think clearly, track what matters, and build knowledge over time. You don't make decisions for them — you help them understand what they want, explore options, and reach their own conclusions. You're proactive about surfacing relevant information, but collaborative about every next step.

# Personality
- Curious, not presumptuous. Ask questions before assuming. Explore before committing.
- Proactive, not pushy. Offer information and surface connections, but let the user steer.
- Collaborative, not directive. Work with the user, not for them.
- Patient. If something is unclear, dig deeper rather than guessing.
- Honest about uncertainty. If you don't know, say so. If you're not sure what they mean, ask.

# Memory System
You have persistent memory stored as entities (people, projects, topics, tasks, tools) and claims (relationships between entities). Memory survives across sessions.

Memory tools:
- \`memory_search\` — Find entities, claims, and past conversations.
- \`memory_store\` — Explicitly save an important fact or insight.
- \`entity_lookup\` — Get full details on a specific entity.
- \`entity_connect\` — Link two related concepts.

# Context Window
The context window is managed automatically. Old or irrelevant context is evicted to keep you focused. Memory entries compete with conversation turns for space. If you need information from earlier, use \`memory_search\`. Entities and claims survive eviction.

# Working Style
- When the user introduces something new, store it.
- When the user expresses a preference or makes a decision, note it.
- Keep track of ongoing threads and tasks — surface them when relevant.
- If something is ambiguous, ask. Don't guess.
- If the user seems unsure, help them explore. Don't rush to a solution.
- Use web search when you need current information the user hasn't provided.`;

let SYSTEM_INJECTED = false;

/// 4B model availability cache (checked once per session)
let _4bAvailable = false;
let _4bChecked = false;

/// Extract a preview (first ~80 chars) of a message's content.
function extractPreview(msg: any): string {
	const c = msg.content;
	if (typeof c === "string") return c.slice(0, 80).replace(/\n/g, " ");
	if (Array.isArray(c)) {
		for (const part of c) {
			if (part?.text) return part.text.slice(0, 80).replace(/\n/g, " ");
		}
	}
	return "(no preview)";
}

/// Find the latest user message text to use as the "current topic".
function findLatestUserQuery(msgs: any[]): string {
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i]?.role === "user") {
			return extractPreview(msgs[i]);
		}
	}
	return "(unknown)";
}

/// Estimate tokens from a messages array.
function estimateTokens(messages: any[]): number {
	let total = 0;
	for (const msg of messages) {
		const content = msg.content;
		if (typeof content === "string") total += content.length;
		else if (Array.isArray(content)) {
			for (const item of content) {
				if (item?.text) total += item.text.length;
			}
		}
	}
	return Math.round(total / 4);
}

export function registerContextHooks(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		SYSTEM_INJECTED = false;
		_4bAvailable = false;
		_4bChecked = false;
		_pipelineRanForQuery = null;
	});

	pi.on("context", async (_event: any, _ctx: any) => {
		// Context event is for non-destructive inspection.
		// Actual work (recall, scoring, extraction) is in before_provider_request.
	});

	pi.on("before_agent_start", async (event: any, _ctx: any) => {
		if (!SYSTEM_INJECTED) {
			SYSTEM_INJECTED = true;
			return {
				systemPrompt: event.systemPrompt
					? `${event.systemPrompt}\n\n${SYSTEM_PROMPT}`
					: SYSTEM_PROMPT,
			};
		}
	});

	// ── Turn-scoped guard ─────────────────────────────────────
	// before_provider_request fires for EVERY LLM call (including sub-requests
	// during tool execution). The expensive pipeline (recall, score, extract)
	// should only run once per user turn — everything after the first call
	// only needs the memory→system role conversion.
	//
	// We track the last user query to detect new turns vs sub-requests.
	let _pipelineRanForQuery: string | null = null;

	// 4B model context scoring + memory recall + entity extraction
	pi.on("before_provider_request", async (event: any, _ctx: any) => {
		const payload = event.payload;
		const msgs = payload?.messages;
		if (!msgs || msgs.length === 0) return;

		const latestQuery = findLatestUserQuery(msgs);
		const isNewTurn =
			latestQuery &&
			latestQuery !== "(unknown)" &&
			latestQuery !== _pipelineRanForQuery;

		if (isNewTurn) {
			_pipelineRanForQuery = latestQuery;

			try {
				const BUDGET = 80000;

				// ── Step 1: Recall ──
				if (latestQuery !== "(unknown)") {
					try {
						const memoryContext = await ilo.recall(latestQuery);
						if (
							memoryContext.ok &&
							memoryContext.data?.context &&
							memoryContext.data.nodes > 0
						) {
							const memoryMsg = {
								role: "memory",
								content: memoryContext.data.context,
								customType: "ilo_memory",
							};
							payload.messages.splice(msgs.length - 1, 0, memoryMsg);
						}
					} catch {
						// Non-critical — proceed without memory recall
					}
				}

				const updatedMsgs = payload.messages;

				// ── Step 2: Score + evict ──
				const chunkInfo = updatedMsgs.map((m: any) => ({
					role: m.role || m.customType || "?",
					preview: extractPreview(m),
				}));

				// Extract query words for entity overlap scoring
				const queryWords = latestQuery
					.toLowerCase()
					.split(/\s+/)
					.filter((w: string) => w.length > 2);

				if (!_4bChecked) {
					_4bAvailable = await is4BModelAvailable();
					_4bChecked = true;
				}

				// Get model scores (or use recency-only fallback when 4B is off)
				const rawScores = _4bAvailable
					? await scoreChunksWith4BModel(chunkInfo, latestQuery)
					: chunkInfo.map((_: any, i: number) => i / chunkInfo.length);

				if (rawScores) {
					// Composite: 0.5 × model + 0.3 × recency + 0.2 × entity_overlap
					const scored = rawScores.map((s: number, i: number) => {
						const recency =
							chunkInfo.length > 1 ? i / (chunkInfo.length - 1) : 1.0;
						const entityOverlap =
							queryWords.length > 0
								? queryWords.filter((w: string) =>
										chunkInfo[i].preview.toLowerCase().includes(w),
									).length / queryWords.length
								: 0;
						return {
							idx: i,
							score: 0.5 * s + 0.3 * recency + 0.2 * entityOverlap,
						};
					});

					const alwaysKeep = new Set<number>();
					alwaysKeep.add(updatedMsgs.length - 1);
					for (let i = updatedMsgs.length - 2; i >= 0; i--) {
						if (updatedMsgs[i].role === "assistant") {
							alwaysKeep.add(i);
							break;
						}
					}

					const droppable = scored
						.filter((s) => !alwaysKeep.has(s.idx) && s.score < 0.4)
						.sort((a, b) => a.score - b.score);

					const toDrop = new Set<number>();
					for (const s of droppable) {
						if (alwaysKeep.has(s.idx)) continue;
						toDrop.add(s.idx);
						const remaining = updatedMsgs.filter(
							(_: any, i: number) => !toDrop.has(i),
						);
						if (estimateTokens(remaining) <= BUDGET) break;
					}

					if (toDrop.size > 0) {
						payload.messages = updatedMsgs.filter(
							(_: any, i: number) => !toDrop.has(i),
						);
					}
				}

				// ── Step 3: Extract entities + claims ──
				if (_4bAvailable && latestQuery !== "(unknown)") {
					try {
						const result = await analyzeWith4BModel(latestQuery, {
							contextSummary: `Session has ${updatedMsgs.length} chunks (~${estimateTokens(updatedMsgs)} tokens)`,
						});
						if (result) {
							(globalThis as any).__pendingEntityLabels =
								result.extracted_entities.map((e: any) => e.name);
							(globalThis as any).__pendingClaimInputs =
								result.extracted_claims.map((c: any) => ({
									content: `${c.subject} ${c.relationship} ${c.object}`,
									confidence: c.confidence,
									entities: [c.subject, c.object],
									relationship: c.relationship,
									category: c.category,
								}));

							const entityInputs = result.extracted_entities.map((e: any) => ({
								label: e.name,
								tags: [...(e.tags || []), e.type],
								confidence: e.confidence,
							}));
							if (entityInputs.length > 0) {
								await ilo.createEntities(entityInputs).catch(() => {});
							}

							(globalThis as any).__lastExtractedLabels =
								result.extracted_entities.map((e: any) => e.name);
						}
					} catch {
						// Non-critical — extraction is best-effort
					}
				}
			} catch (e) {
				console.warn("[context] context rebuild failed:", e);
			}
		}

		// Memory → system role conversion (ALWAYS runs, even on sub-requests)
		for (const msg of payload.messages) {
			if (msg.role === "memory") {
				msg.role = "system";
				if (msg.content && !msg.content.startsWith("[Memory Context]")) {
					msg.content = `[Memory Context]\n${msg.content}`;
				}
			}
		}

		return payload;
	});
}
