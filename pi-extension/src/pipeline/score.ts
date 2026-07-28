// Pipeline Step 2: Context scoring + eviction
// Uses entity-type attention instead of LLM chunk scoring.
// Each entity type gets an attention weight; chunks containing
// high-weight types get higher retention scores.
//
//   composite = 0.5 × entity_attention + 0.3 × recency + 0.2 × entity_overlap

import type { EntityInfo } from "./extract";

// ── Entity-type attention weights ────────────────────────────
// Higher = chunk mentioning this type is more important to keep.
// These can be tuned or learned over time.
const ENTITY_TYPE_WEIGHTS: Record<string, number> = {
	component: 1.0,
	tool: 0.9,
	task: 0.9,
	file: 0.8,
	service: 0.8,
	library: 0.8,
	person: 0.7,
	concept: 0.6,
	config: 0.5,
	other: 0.3,
};
const DEFAULT_TYPE_WEIGHT = 0.5;

/**
 * Score each chunk by entity-type attention: which entity types
 * appear in the chunk preview, weighted by their importance.
 * Returns 0.0-1.0 per chunk, or null if no entity info available.
 */
function scoreByEntityAttention(
	chunkPreviews: string[],
	entityInfos: EntityInfo[],
): number[] | null {
	if (!entityInfos || entityInfos.length === 0) return null;

	// For each entity, check which chunks mention its name (fuzzy match)
	// Then score each chunk by the max weight of any matching entity type.
	const scores = chunkPreviews.map((preview) => {
		const lower = preview.toLowerCase();
		let maxWeight = 0;
		for (const entity of entityInfos) {
			if (lower.includes(entity.name.toLowerCase())) {
				const w = ENTITY_TYPE_WEIGHTS[entity.type] ?? DEFAULT_TYPE_WEIGHT;
				if (w > maxWeight) maxWeight = w;
			}
		}
		return maxWeight;
	});

	// Normalize to 0.0-1.0
	const max = Math.max(...scores, 1);
	return scores.map((s) => s / max);
}

export async function scoreAndEvict(
	messages: any[],
	latestQuery: string,
	budget: number,
	entityInfos: EntityInfo[] | null,
): Promise<any[]> {
	// Build chunk info for scoring
	const chunkInfo = messages.map((m: any) => ({
		role: m.role || m.customType || "?",
		preview: extractPreview(m),
	}));

	// Extract query words for entity overlap
	const queryWords = latestQuery
		.toLowerCase()
		.split(/\s+/)
		.filter((w: string) => w.length > 2);

	// Entity-type attention scores (or uniform fallback)
	const attentionScores = entityInfos
		? scoreByEntityAttention(
				chunkInfo.map((c) => c.preview),
				entityInfos,
			)
		: null;

	// Composite scoring: 0.5 × attention + 0.3 × recency + 0.2 × overlap
	const scored = chunkInfo.map((info, i) => {
		const recency = chunkInfo.length > 1 ? i / (chunkInfo.length - 1) : 1.0;
		const entityOverlap =
			queryWords.length > 0
				? queryWords.filter((w: string) =>
						info.preview.toLowerCase().includes(w),
					).length / queryWords.length
				: 0;
		const attention =
			attentionScores !== null
				? (attentionScores[i] ?? 0.5)
				: i / chunkInfo.length;
		return {
			idx: i,
			score: 0.5 * attention + 0.3 * recency + 0.2 * entityOverlap,
		};
	});

	// Always keep: last message (user query) + last assistant response
	const alwaysKeep = new Set<number>();
	alwaysKeep.add(messages.length - 1);
	for (let i = messages.length - 2; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			alwaysKeep.add(i);
			break;
		}
	}

	const initialTokens = estimateTokens(messages);

	// Always drop the lowest-scored chunks until under budget.
	const droppable = scored
		.filter((s) => !alwaysKeep.has(s.idx))
		.sort((a, b) => a.score - b.score);

	const toDrop = new Set<number>();
	for (const s of droppable) {
		toDrop.add(s.idx);
		const remaining = messages.filter((_: any, i: number) => !toDrop.has(i));
		if (estimateTokens(remaining) <= budget) break;
	}

	const finalTokens = estimateTokens(
		messages.filter((_: any, i: number) => !toDrop.has(i)),
	);

	console.error(
		`[context] Tokens: ${initialTokens} → ${finalTokens}/${budget}, ` +
			`chunks: ${messages.length} → ${messages.length - toDrop.size} ` +
			`(dropped ${toDrop.size})`,
	);

	if (toDrop.size === 0) return messages;
	return messages.filter((_: any, i: number) => !toDrop.has(i));
}

// ── Helpers ───────────────────────────────────────────

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
