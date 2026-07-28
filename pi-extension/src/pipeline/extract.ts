// Pipeline Step 3: Entity/claim extraction + chunk scoring
// Calls the 4B model ONCE and returns both extracted data and chunk scores.
// The chunk scores are used by score.ts for eviction — this replaces the
// separate scoreChunksWith4BModel call, cutting 4B latency in half.

import {
	analyzeWith4BModel,
	is4BModelAvailable,
} from "../client/context-rebuild-llm";
import { ilo } from "../client/ilo-client";

// Re-export availability check
export { is4BModelAvailable };

export interface ExtractionResult {
	chunkScores: Record<string, number> | null;
	entityLabels: string[];
}

export async function extractEntities(
	latestQuery: string,
	msgCount: number,
	estimatedTokens: number,
	chunkPreviews?: string[],
): Promise<ExtractionResult | null> {
	if (!latestQuery || latestQuery === "(unknown)") return null;

	try {
		const result = await analyzeWith4BModel(latestQuery, {
			contextSummary: `Session has ${msgCount} chunks (~${estimatedTokens} tokens)`,
			chunkPreviews,
		});
		if (!result) return null;

		// Save labels + claims for turn_end to use in a single atomic write
		(globalThis as any).__pendingEntityLabels = result.extracted_entities.map(
			(e: any) => e.name,
		);
		(globalThis as any).__pendingClaimInputs = result.extracted_claims.map(
			(c: any) => ({
				content: `${c.subject} ${c.relationship} ${c.object}`,
				confidence: c.confidence,
				entities: [c.subject, c.object],
				relationship: c.relationship,
				category: c.category,
			}),
		);

		// Store entity nodes eagerly so they're findable by recall during the turn
		const entityInputs = result.extracted_entities.map((e: any) => ({
			label: e.name,
			tags: [...(e.tags || []), e.type],
			confidence: e.confidence,
		}));
		if (entityInputs.length > 0) {
			await ilo.createEntities(entityInputs).catch(() => {});
		}

		// Also keep old key for backward compat (used by turn.ts learn)
		(globalThis as any).__lastExtractedLabels = result.extracted_entities.map(
			(e: any) => e.name,
		);

		return {
			chunkScores:
				Object.keys(result.chunk_scores).length > 0
					? result.chunk_scores
					: null,
			entityLabels: result.extracted_entities.map((e: any) => e.name),
		};
	} catch {
		// Non-critical — extraction is best-effort
		return null;
	}
}
