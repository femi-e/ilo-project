import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// ilo, ensureIlo, getState imported but reserved for future recall injection

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

# Context Rebuild
When starting a new task, call \`context_rebuild\` to analyze the request, extract entities and claims, and store them in persistent memory. This helps build a knowledge graph across sessions.

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

/// URL of the small local model used for context scoring.
const LOCAL_MODEL_URL = `http://127.0.0.1:${process.env.LOCAL_CHAT_PORT_START || 1234}/v1/chat/completions`;

/// Ask the small model to score each message chunk for relevance.
/// Returns an array of scores (0.0 = drop, 1.0 = essential), or null if the model is unreachable.
async function scoreContextWithModel(msgs: any[]): Promise<number[] | null> {
	const latestQuery = findLatestUserQuery(msgs);

	// Build a compact chunk report — just enough for the model to judge relevance
	const chunkSummary = msgs
		.map((m: any, i: number) => {
			const role = m.role || m.customType || "?";
			const preview = extractPreview(m);
			return `[${i}] ${role}: ${preview}`;
		})
		.join("\n");

	const modelPrompt = `You manage context for a coding assistant. Score each message chunk for relevance to the current conversation. Return ONLY a JSON array of scores 0.0-1.0 matching the chunk indices below.

Latest user query:
${latestQuery}

Chunks:
${chunkSummary}`;

	try {
		const res = await fetch(LOCAL_MODEL_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: AbortSignal.timeout(5000),
			body: JSON.stringify({
				model: "default",
				messages: [{ role: "user", content: modelPrompt }],
				temperature: 0.1,
				max_tokens: 512,
			}),
		});
		if (!res.ok) return null;
		const data = await res.json();
		const text = data?.choices?.[0]?.message?.content || "";
		const json = text.match(/\[[\s\S]*\]/);
		if (!json) return null;
		const scores: number[] = JSON.parse(json[0]);
		if (!Array.isArray(scores) || scores.length !== msgs.length) return null;
		return scores.map((s) => Math.max(0, Math.min(1, Number(s))));
	} catch {
		return null;
	}
}

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

/// Compact dashboard showing scored/relevant chunks.
function buildDashboard(messages: any[], tokenEstimate: number): string {
	const budget = 80000;
	const pct = Math.min(100, Math.round((tokenEstimate / budget) * 100));
	const scores = ((globalThis as any).__lastChunkScores ?? {}) as Record<
		string,
		number
	>;

	// Count chunks by type
	const counts: Record<string, { total: number; scored: number }> = {};
	for (let i = 0; i < messages.length; i++) {
		const key = "chunk_" + i;
		const ctype = messages[i]?.customType || messages[i]?.role || "?";
		if (!counts[ctype]) counts[ctype] = { total: 0, scored: 0 };
		counts[ctype].total++;
		if (scores[key] !== undefined) counts[ctype].scored++;
	}

	// Build compact summary
	const lines: string[] = [
		`## Context (${nChunks(messages.length)} · ~${tokenEstimate} / ${budget} tok = ${pct}%)`,
	];
	for (const [ctype, c] of Object.entries(counts)) {
		const bar = scoreBar(c.scored);
		lines.push(`  ${ctype}: ${c.total} ${bar}`);
	}

	// Only list scored chunks (top 5 lowest-scored + recent)
	const scored = messages
		.map((_m: any, i: number) => ({
			idx: i,
			key: "chunk_" + i,
			score: scores["chunk_" + i] ?? 0,
		}))
		.sort((a, b) => a.score - b.score)
		.slice(0, 5)
		.sort((a, b) => a.idx - b.idx);
	if (scored.length > 0) {
		lines.push("");
		lines.push("Edge chunks:");
		for (const s of scored) {
			const ctype = messages[s.idx]?.customType || messages[s.idx]?.role || "?";
			lines.push(`  ch${s.idx} ${ctype} = ${s.score.toFixed(2)}`);
		}
	}

	return lines.join("\n");
}

/// Simple bar visualization (10 chars)
function scoreBar(n: number): string {
	const filled = Math.min(10, Math.round((n / Math.max(n, 1)) * 10));
	return "[" + "#".repeat(filled) + "-".repeat(10 - filled) + "]";
}

/// Human-readable chunk count
function nChunks(n: number): string {
	if (n < 10) return String(n);
	if (n < 1000) return String(n);
	return (n / 1000).toFixed(1) + "k";
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
	});

	pi.on("context", async (_event: any, _ctx: any) => {
		// Context event is for non-destructive message inspection.
		// Actual message filtering and dashboard injection happens in
		// before_provider_request, where event.payload.messages is the
		// ACTUAL array sent to the provider and the return IS applied.
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

	// Small-model context scoring + dashboard + memory role conversion
	pi.on("before_provider_request", async (event: any, _ctx: any) => {
		const payload = event.payload;
		const msgs = payload?.messages;
		if (!msgs || msgs.length === 0) return;

		try {
			const BUDGET = 80000;
			// Always ask the small model to score relevance
			const modelScores = await scoreContextWithModel(msgs);

			if (modelScores) {
				// Small model scored everything — keep only what fits budget + essentials
				type Scored = { idx: number; score: number };
				const scored: Scored[] = modelScores.map((s, i) => ({
					idx: i,
					score: s,
				}));

				// Always keep: last user query + last assistant response + chunks with score >= 0.5
				const alwaysKeep = new Set<number>();
				alwaysKeep.add(msgs.length - 1); // last message (should be user query)
				if (msgs.length >= 2) alwaysKeep.add(msgs.length - 2); // previous assistant

				const droppable = scored
					.filter((s) => !alwaysKeep.has(s.idx) && s.score < 0.5)
					.sort((a, b) => a.score - b.score);

				// Drop lowest-scored until we fit within budget
				const toDrop = new Set<number>();
				for (const s of droppable) {
					if (alwaysKeep.has(s.idx)) continue;
					toDrop.add(s.idx);
					// Re-check budget after each drop
					const remaining = msgs.filter((_: any, i: number) => !toDrop.has(i));
					if (estimateTokens(remaining) <= BUDGET) break;
				}

				if (toDrop.size > 0) {
					payload.messages = msgs.filter((_: any, i: number) => !toDrop.has(i));
					console.error(
						`[context] Model scored ${msgs.length} chunks, dropped ${toDrop.size}`,
					);
				}

				// Store scores for dashboard display
				const scoreMap: Record<string, number> = {};
				for (const s of scored) {
					scoreMap["chunk_" + s.idx] = s.score;
				}
				(globalThis as any).__lastChunkScores = scoreMap;
			}
			// If model unreachable, proceed without scoring — just dashboard + role conversion

			// Dashboard injection
			const finalMsgs = payload.messages;
			const dashboard = buildDashboard(finalMsgs, estimateTokens(finalMsgs));
			const lastUserIdx = finalMsgs.length - 1;
			if (finalMsgs[lastUserIdx]?.role === "user") {
				const existing = finalMsgs[lastUserIdx].content;
				if (typeof existing === "string") {
					finalMsgs[lastUserIdx].content = `${dashboard}\n\n${existing}`;
				} else if (Array.isArray(existing) && existing[0]?.text) {
					existing[0].text = `${dashboard}\n\n${existing[0].text}`;
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
