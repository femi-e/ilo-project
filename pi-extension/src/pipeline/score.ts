// Pipeline Step 2: Context scoring + eviction
// Takes pre-computed scores (from the 4B model's analyzeWith4BModel call)
// and applies a composite formula before evicting low-scored chunks.
//
//   composite = 0.5 × model_score + 0.3 × recency + 0.2 × entity_overlap

export async function scoreAndEvict(
	messages: any[],
	latestQuery: string,
	budget: number,
	chunkScores: Record<string, number> | null,
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

	// Determine per-chunk model scores (or recency-only fallback)
	const rawScores: number[] = chunkScores
		? chunkInfo.map(
				(_, i) =>
					chunkScores[String(i)] ?? chunkScores[i] ?? i / chunkInfo.length,
			)
		: chunkInfo.map((_, i) => i / chunkInfo.length);

	// Composite scoring: 0.5 × model + 0.3 × recency + 0.2 × overlap
	const scored = rawScores.map((s: number, i: number) => {
		const recency = chunkInfo.length > 1 ? i / (chunkInfo.length - 1) : 1.0;
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

	// Always keep: last message (user query) + last assistant response
	const alwaysKeep = new Set<number>();
	alwaysKeep.add(messages.length - 1);
	for (let i = messages.length - 2; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			alwaysKeep.add(i);
			break;
		}
	}

	// Always drop low-scored chunks (score < 0.4), then keep dropping the
	// lowest remaining until we're under the token budget.
	const droppable = scored
		.filter((s) => !alwaysKeep.has(s.idx))
		.sort((a, b) => a.score - b.score);

	const toDrop = new Set<number>();
	for (const s of droppable) {
		toDrop.add(s.idx);
		const remaining = messages.filter((_: any, i: number) => !toDrop.has(i));
		if (estimateTokens(remaining) <= budget) break;
	}

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
