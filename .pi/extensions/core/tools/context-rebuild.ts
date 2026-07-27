import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	analyzeWith4BModel,
	is4BModelAvailable,
} from "../lib/context-rebuild-llm";
import { ilo } from "../lib/ilo-client";

export function registerContextRebuildTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "context_rebuild",
		label: "Context Rebuild",
		description:
			"Analyze the current task and context. Score each chunk relevance, extract entities and claims. Call this before taking any action.",
		promptSnippet: "Analyze task and rebuild context",
		promptGuidelines: [
			"Use context_rebuild at the start of every task before using any other tool.",
			"You provide the query and optional context. The 4B model handles analysis, entity/claim extraction, and scoring automatically.",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "The user's current query or task description",
			}),
			context_summary: Type.Optional(
				Type.String({
					description:
						"Optional high-level summary of the current context for the 4B model",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { query, context_summary } = params;

			// Check 4B model availability
			const modelAvailable = await is4BModelAvailable();
			if (!modelAvailable) {
				console.warn(
					"[context-rebuild] 4B model unavailable — falling back to basic storage",
				);
				try {
					await ilo
						.remember({
							query,
							response:
								"[context_rebuild fallback — 4B model unavailable. Query stored for future recall.]",
							entities: [
								{
									label: query.slice(0, 60),
									tags: ["task", "unanalyzed"],
									confidence: 0.3,
								},
							],
							claims: [],
							turnIndex: 0,
						})
						.catch(() => {});
				} catch {
					// Silently continue if storage fails
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `⚠️ 4B model unavailable. Context stored without analysis. Start a 4B model server on port ${process.env.ILO_4B_PORT || "1236"} for full context rebuild.`,
						},
					],
					details: { fallback: true, query_stored: true },
				};
			}

			// Build chunk previews from session context (best-effort)
			let chunkPreviews: string[] | undefined;
			try {
				const leaf = ctx.sessionManager?.getLeafEntry();
				const leafMsg =
					leaf?.type === "message"
						? (leaf.message as unknown as Record<string, unknown>)
						: undefined;
				if (leafMsg?.content) {
					const role = String(leafMsg.role || "?");
					const content = leafMsg.content;
					let preview = "(no preview)";
					if (typeof content === "string")
						preview = content.slice(0, 80).replace(/\n/g, " ");
					else if (Array.isArray(content)) {
						for (const part of content) {
							if (part?.text) {
								preview = part.text.slice(0, 80).replace(/\n/g, " ");
								break;
							}
						}
					}
					chunkPreviews = [`${role}: ${preview}`];
				}
			} catch {
				// Non-critical — proceed without chunk previews
			}

			// Call the 4B model
			const result = await analyzeWith4BModel(query, {
				contextSummary: context_summary,
				chunkPreviews,
				signal,
			});

			if (!result) {
				console.warn(
					"[context-rebuild] 4B model returned no result — storing query only",
				);
				try {
					await ilo
						.remember({
							query,
							response: "[context_rebuild — 4B model call failed]",
							entities: [
								{
									label: query.slice(0, 60),
									tags: ["task", "extraction-failed"],
									confidence: 0.3,
								},
							],
							claims: [],
							turnIndex: 0,
						})
						.catch(() => {});
				} catch {
					// Silently continue
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `⚠️ Could not analyze context. Stored query without extraction.`,
						},
					],
					details: { error: "4B model returned no result" },
				};
			}

			// Store in ILO
			try {
				await ilo.remember({
					query,
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
				});
			} catch (err) {
				console.warn("[context-rebuild] ILO store error:", err);
			}

			// Store chunk_scores globally for the dashboard
			(globalThis as any).__lastChunkScores = result.chunk_scores || {};

			// Format readable summary for the agent
			const entityLines = result.extracted_entities
				.map(
					(e) =>
						`  ${e.name} (${e.type}) conf=${e.confidence.toFixed(2)}` +
						(e.tags?.length ? ` [${e.tags.join(", ")}]` : ""),
				)
				.join("\n");

			const claimLines = result.extracted_claims
				.map(
					(c) =>
						`  ${c.subject} --[${c.category}]--> ${c.object} (conf=${c.confidence.toFixed(2)})`,
				)
				.join("\n");

			const scoredChunks = Object.entries(result.chunk_scores || {})
				.sort(([, a], [, b]) => b - a)
				.map(([key, score]) => `  ${key}: ${score.toFixed(2)}`)
				.join("\n");

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Context analyzed by 4B model.`,
							``,
							`📋 Analysis:`,
							`  ${result.analysis.slice(0, 500)}${result.analysis.length > 500 ? "..." : ""}`,
							``,
							`📝 Plan:`,
							`  ${result.plan.slice(0, 400)}${result.plan.length > 400 ? "..." : ""}`,
							``,
							`🔍 Extracted Entities (${result.extracted_entities.length}):`,
							entityLines || "  (none)",
							``,
							`🔗 Extracted Claims (${result.extracted_claims.length}):`,
							claimLines || "  (none)",
							``,
							scoredChunks ? `📊 Chunk Scores:\n${scoredChunks}` : "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					entities_stored: result.extracted_entities.length,
					claims_stored: result.extracted_claims.length,
					chunks_scored: Object.keys(result.chunk_scores || {}).length,
				},
			};
		},
	});
}
