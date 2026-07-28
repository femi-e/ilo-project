// Pipeline Step 3: Entity/claim extraction
// Calls the 4B model to extract entities and claims from the user query.
// Stores entity nodes eagerly in ILO, saves labels for turn_end.

import { analyzeWith4BModel, is4BModelAvailable } from "../client/context-rebuild-llm";
import { ilo } from "../client/ilo-client";

// Re-export availability check so score.ts controls caching
export { is4BModelAvailable };

export async function extractEntities(
	latestQuery: string,
	msgCount: number,
	estimatedTokens: number,
): Promise<void> {
	if (!latestQuery || latestQuery === "(unknown)") return;

	try {
		const result = await analyzeWith4BModel(latestQuery, {
			contextSummary: `Session has ${msgCount} chunks (~${estimatedTokens} tokens)`,
		});
		if (!result) return;

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
	} catch {
		// Non-critical — extraction is best-effort
	}
}
