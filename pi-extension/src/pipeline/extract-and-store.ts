// Pipeline Step 2&3: Extract entities + claims from conversation and store in ILO.
// Uses the 4B MTPLX model to extract with source_text provenance.
// Consolidation: skips duplicate entities by checking ILO before creating.

import { analyzeWith4BModel } from "../client/context-rebuild-llm";
import { ilo } from "../client/ilo-client";

export interface EntityInfo {
	name: string;
	type: string;
	confidence: number;
}

export interface ClaimInfo {
	subject: string;
	relationship: string;
	object: string;
	category: string;
	confidence: number;
	source_text: string;
}

export interface ExtractionResult {
	entityInfos: EntityInfo[];
	claims: ClaimInfo[];
}

// ── System prompt for entity/claim extraction with source text ──

// Extraction prompt is embedded in context-rebuild-llm.ts's SYSTEM_PROMPT

/**
 * Build text from the last assistant turn + current user query.
 * Includes thinking, tool calls, tool results, and response text.
 */
function buildExtractionText(messages: any[]): string {
	// Find the last assistant message and everything that preceded it
	const parts: string[] = [];

	// Find the last user message index (current query)
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			lastUserIdx = i;
			break;
		}
	}

	// Collect everything from the last assistant turn
	// That's messages from lastUserIdx to the end
	if (lastUserIdx >= 0) {
		for (let i = lastUserIdx; i < messages.length; i++) {
			const msg = messages[i];
			const role = msg.role || "?";

			if (role === "user") {
				const text = extractTextContent(msg);
				if (text) parts.push(`User: ${text}`);
			} else if (role === "assistant") {
				// Include thinking, tool calls, and response text
				const content = msg.content;
				if (Array.isArray(content)) {
					for (const item of content) {
						if (item.type === "text" && item.text) {
							parts.push(`Assistant: ${item.text}`);
						} else if (item.type === "thinking" && item.thinking) {
							parts.push(`[Thinking: ${item.thinking.slice(0, 200)}]`);
						} else if (item.type === "toolCall" || item.type === "tool_use") {
							const name = item.name || "tool";
							const args = item.arguments
								? JSON.stringify(item.arguments).slice(0, 200)
								: "";
							parts.push(`[Tool: ${name}(${args})]`);
						}
					}
				} else if (typeof content === "string") {
					parts.push(`Assistant: ${content}`);
				}
			} else if (role === "toolResult" || role === "tool") {
				const text = extractTextContent(msg);
				if (text) parts.push(`[Result: ${text.slice(0, 300)}]`);
			}
		}
	}

	return parts.join("\n");
}

function extractTextContent(msg: any): string {
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		for (const part of c) {
			if (part?.text) return part.text;
		}
	}
	return "";
}

/**
 * Extract entities and claims from the current conversation turn,
 * then store them in the ILO graph with consolidation (skip duplicates).
 */
export async function extractAndStore(
	currentQuery: string,
	messages: any[],
): Promise<ExtractionResult | null> {
	if (!currentQuery || currentQuery === "(unknown)") return null;

	const text = buildExtractionText(messages);
	if (!text.trim()) return null;

	console.error(
		`[extract] Running extraction on ${text.length} chars of conversation...`,
	);

	const result = await analyzeWith4BModel(text, {
		contextSummary: `Extraction from current conversation turn`,
	});

	if (!result) {
		console.error("[extract] 4B model returned no result");
		return null;
	}

	const entities: EntityInfo[] = result.extracted_entities.map((e: any) => ({
		name: e.name,
		type: e.type || "other",
		confidence: e.confidence || 0.5,
	}));

	const claims: ClaimInfo[] = result.extracted_claims.map((c: any) => ({
		subject: c.subject,
		relationship: c.relationship,
		object: c.object,
		category: c.category || "Relates",
		confidence: c.confidence || 0.5,
		source_text: c.source_text || "",
	}));

	// ── Store entities with consolidation ───────────────
	const createdEntityIds: string[] = [];

	for (const entity of entities) {
		try {
			// Check if entity already exists (consolidation: skip + reuse)
			const existing = await ilo.entityLookup(entity.name);
			if (existing?.data?.found) {
				console.error(
					`[extract] ↪ Skipping duplicate entity "${entity.name}" (already exists)`,
				);
				continue;
			}

			// Create new entity
			const created = await ilo.entityUpdate(entity.name, {
				confidence: entity.confidence,
			});
			if (created?.data?.created) {
				createdEntityIds.push(entity.name);
				console.error(
					`[extract] + Created entity "${entity.name}" (${entity.type})`,
				);
			}
		} catch (err) {
			console.error(`[extract] Failed to store entity "${entity.name}":`, err);
		}
	}

	// ── Store claims ────────────────────────────────────
	if (claims.length > 0) {
		try {
			const claimInputs = claims.map((c) => ({
				content: `${c.subject} ${c.relationship} ${c.object}`,
				confidence: c.confidence,
				provenance: c.source_text,
				entities: [c.subject, c.object],
			}));
			const claimResult = await ilo.createClaims(claimInputs);
			console.error(
				`[extract] + Created ${claimResult?.data?.count || 0} claims`,
			);
		} catch (err) {
			console.error("[extract] Failed to store claims:", err);
		}
	}

	console.error(
		`[extract] Done: ${entities.length} entities, ${claims.length} claims`,
	);

	return { entityInfos: entities, claims };
}
