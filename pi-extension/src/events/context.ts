// ============================================================================
// events/context.ts — before_provider_request pipeline coordinator
// ============================================================================
// Orchestrates the 4-step memory pipeline:
//   1. Recall: fetch relevant memory from ILO
//   2. Score: 4B model scores chunks, evict low-scored
//   3. Extract: 4B model extracts entities + claims
//   4. Convert: memory→system role conversion
//
// Uses a turn-scoped guard to avoid re-running steps 1-3 on sub-requests
// (which fire during tool execution within the same user turn).
// ============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { recallMemory } from "../pipeline/recall";
import { scoreAndEvict } from "../pipeline/score";
import { extractEntities } from "../pipeline/extract";
import { convertMemoryRoles } from "../pipeline/convert";

let SYSTEM_INJECTED = false;

/// Find the latest user message text to use as the "current topic".
function findLatestUserQuery(msgs: any[]): string {
	for (let i = msgs.length - 1; i >= 0; i--) {
		if (msgs[i]?.role === "user") {
			const c = msgs[i].content;
			if (typeof c === "string") return c.slice(0, 80).replace(/\n/g, " ");
			if (Array.isArray(c)) {
				for (const part of c) {
					if (part?.text) return part.text.slice(0, 80).replace(/\n/g, " ");
				}
			}
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

export function registerContextHooks(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		SYSTEM_INJECTED = false;
		_pipelineRanForQuery = null;
	});

	pi.on("context", async (_event: any, _ctx: any) => {
		// Context event is for non-destructive inspection.
		// Actual work is in before_provider_request.
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
	// during tool execution). Steps 1-3 only run once per user turn.
	let _pipelineRanForQuery: string | null = null;

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

			const BUDGET = 80000;
			const tok = estimateTokens(payload.messages);

			// Step 1: Recall memory from ILO
			await recallMemory(msgs, latestQuery);

			// Step 2: Extract entities + claims via 4B model (no chunk scoring —
			// that's done locally via entity-type attention in score.ts)
			const extraction = await extractEntities(
				latestQuery,
				payload.messages.length,
				tok,
			);

			// Step 3: Score + evict using entity-type attention
			const evictedMsgs = await scoreAndEvict(
				payload.messages,
				latestQuery,
				BUDGET,
				extraction?.entityInfos ?? null,
			);
			payload.messages = evictedMsgs;
		}

		// Step 4: Memory → system role conversion (ALWAYS runs)
		convertMemoryRoles(payload.messages);

		return payload;
	});
}
