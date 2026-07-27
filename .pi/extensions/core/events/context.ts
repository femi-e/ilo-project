import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	analyzeWith4BModel,
	scoreChunksWith4BModel,
	is4BModelAvailable,
} from "../lib/context-rebuild-llm";
import { ilo } from "../lib/ilo-client";

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

		// 4B model context scoring + memory recall + entity extraction
	pi.on("before_provider_request", async (event: any, _ctx: any) => {
		const payload = event.payload;
		const msgs = payload?.messages;
		if (!msgs || msgs.length === 0) return;

		try {
			const BUDGET = 80000;
			const latestQuery = findLatestUserQuery(msgs);

			// Recall relevant memory from ILO and inject as memory message
			if (latestQuery && latestQuery !== "(unknown)") {
				try {
					const memoryContext = await ilo.recall(latestQuery);
					if (
						memoryContext.ok &&
						memoryContext.data?.context &&
						memoryContext.data.nodes > 0
					) {
						// Inject as memory message right before the last user message
						const memoryMsg = {
							role: "memory",
							content: memoryContext.data.context,
							customType: "ilo_memory",
						};
						// Insert before the last message (which should be the user query)
						payload.messages.splice(msgs.length - 1, 0, memoryMsg);
						console.error(
							`[context] Injected ${memoryContext.data.nodes} memory nodes from ILO`,
						);
					}
				} catch {
					// Non-critical — proceed without memory recall
				}
			}

			// Re-read messages after potential memory injection
			const updatedMsgs = payload.messages;

			// Build chunk info for scoring
			const chunkInfo = updatedMsgs.map((m: any) => ({
				role: m.role || m.customType || "?",
				preview: extractPreview(m),
			}));

			// Check 4B model availability (lazy, once per session)
			if (!_4bChecked) {
				_4bAvailable = await is4BModelAvailable();
				_4bChecked = true;
				if (_4bAvailable) {
					console.error("[context] 4B context-rebuild model available");
				}
			}

			// Score chunks with 4B model
			const modelScores = _4bAvailable
				? await scoreChunksWith4BModel(chunkInfo, latestQuery)
				: null;

			if (modelScores) {
				type Scored = { idx: number; score: number };
				const scored: Scored[] = modelScores.map((s, i) => ({
					idx: i,
					score: s,
				}));

				// Always keep: last message (user query) + last assistant response
				const alwaysKeep = new Set<number>();
				alwaysKeep.add(updatedMsgs.length - 1);
				for (let i = updatedMsgs.length - 2; i >= 0; i--) {
					if (updatedMsgs[i].role === "assistant") {
						alwaysKeep.add(i);
						break;
					}
				}

				const droppable = scored
					.filter((s) => !alwaysKeep.has(s.idx) && s.score < 0.5)
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
					console.error(
						`[context] 4B scored ${updatedMsgs.length} chunks, dropped ${toDrop.size}`,
					);
				}
			}

			// Extract entities and claims from the latest user query using 4B model
			if (_4bAvailable && latestQuery && latestQuery !== "(unknown)") {
				try {
					const result = await analyzeWith4BModel(latestQuery, {
						contextSummary: `Session has ${updatedMsgs.length} chunks (~${estimateTokens(updatedMsgs)} tokens)`,
					});
					if (
						result &&
						(result.extracted_entities.length > 0 ||
							result.extracted_claims.length > 0)
					) {
						// Store entity labels for turn_end learning signal
						(globalThis as any).__lastExtractedLabels =
							result.extracted_entities.map((e: any) => e.name);

						await ilo
							.remember({
								query: latestQuery,
								response: result.analysis,
								entities: result.extracted_entities.map((e) => ({
									label: e.name,
									tags: [...(e.tags || []), e.type],
									confidence: e.confidence,
								})),
								claims: result.extracted_claims.map((c) => ({
									content: `${c.subject} ${c.relationship} ${c.object}`,
									confidence: c.confidence,
									entities: [c.subject, c.object],
									relationship: c.relationship,
									category: c.category,
								})),
								turnIndex: 0,
							})
							.catch(() => {});
					}
				} catch {
					// Non-critical — extraction is best-effort
				}
			}

			// Memory → system role conversion
			for (const msg of payload.messages) {
				if (msg.role === "memory") {
					msg.role = "system";
					if (msg.content && !msg.content.startsWith("[Memory Context]")) {
						msg.content = `[Memory Context]\n${msg.content}`;
					}
				}
			}
		} catch (e) {
			console.warn("[context] context rebuild failed:", e);
		}

		return payload;
	});
}
