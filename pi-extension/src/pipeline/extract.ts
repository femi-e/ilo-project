// Pipeline Step 3: Entity/claim extraction via 4B model
// Chunk scoring is done locally via entity-type attention (see score.ts)
// instead of the LLM — drastically cheaper and faster.

import {
	analyzeWith4BModel,
	is4BModelAvailable,
} from "../client/context-rebuild-llm";
import { ilo } from "../client/ilo-client";

// Re-export availability check
export { is4BModelAvailable };

export interface EntityInfo {
	name: string;
	type: string;
	confidence: number;
}

export interface ExtractionResult {
	entityInfos: EntityInfo[];
}

export async function extractEntities(
	latestQuery: string,
	msgCount: number,
	estimatedTokens: number,
): Promise<ExtractionResult | null> {
	if (!latestQuery || latestQuery === "(unknown)") return null;

	try {
		const result = await analyzeWith4BModel(latestQuery, {
			contextSummary: `Session has ${msgCount} chunks (~${estimatedTokens} tokens)`,
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

		const entityInfos: EntityInfo[] = result.extracted_entities.map(
			(e: any) => ({
				name: e.name,
				type: e.type || "other",
				confidence: e.confidence || 0.5,
			}),
		);

		return { entityInfos };
	} catch {
		// Non-critical — extraction is best-effort
		return null;
	}
}
