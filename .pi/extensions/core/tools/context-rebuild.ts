import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export function registerContextRebuildTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'context_rebuild',
    label: 'Context Rebuild',
    description:
      'Analyze the current task and context. Score each chunk relevance, extract entities and claims. Call this before taking any action.',
    promptSnippet: 'Analyze task and rebuild context',
    promptGuidelines: [
      'Use context_rebuild at the start of every task before using any other tool.',
      'Include your reasoning, relevance scores, and any entities or relationships you identify.',
    ],
    parameters: Type.Object({
      analysis: Type.String({ description: 'Your step-by-step analysis of the task' }),
      plan: Type.String({ description: 'Your execution plan' }),
      chunk_scores: Type.Object({
        additionalProperties: Type.Number(),
        description: 'Relevance score per context chunk ID (0.0-1.0)',
      }),
      extracted_entities: Type.Array(
        Type.Object({
          name: Type.String({ description: 'Entity name' }),
          type: Type.String({
            enum: ['component', 'file', 'tool', 'service', 'concept', 'person', 'library', 'config', 'task', 'other'],
            description: 'Entity type',
          }),
          confidence: Type.Number({ minimum: 0, maximum: 1 }),
          tags: Type.Optional(Type.Array(Type.String())),
        }),
        { description: 'Key entities found in this conversation turn' }
      ),
      extracted_claims: Type.Array(
        Type.Object({
          subject: Type.String({ description: 'Source entity' }),
          relationship: Type.String({ description: 'Raw relationship text (e.g. "depends on", "wants to fix")' }),
          object: Type.String({ description: 'Target entity' }),
          category: Type.String({
            enum: ['Depends', 'Intends', 'Implements', 'Contains', 'Relates', 'References', 'Precedes'],
            description: 'One of the 7 validated relationship categories',
          }),
          confidence: Type.Number({ minimum: 0, maximum: 1 }),
        }),
        { description: 'Relationships between entities found in this turn' }
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const { analysis, chunk_scores, extracted_entities, extracted_claims } = params;

      // Store in ILO via the remember endpoint
      try {
        const iloUrl = `http://127.0.0.1:18090/remember`;
        const body = {
          query: ctx.sessionManager?.getLeafEntry()?.message?.content?.[0]?.text || '',
          response: analysis,
          entities: (extracted_entities || []).map((e: any) => ({
            label: e.name,
            tags: [...(e.tags || []), e.type || 'concept'],
            confidence: e.confidence,
          })),
          claims: (extracted_claims || []).map((c: any) => ({
            content: `${c.subject} ${c.relationship} ${c.object}`,
            confidence: c.confidence,
            entities: [c.subject, c.object],
            relationship: c.relationship,
            category: c.category,
          })),
          turn_index: 0,
        };
        const resp = await fetch(iloUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          console.warn('[context-rebuild] ILO store failed:', await resp.text().catch(() => 'unknown'));
        }
      } catch (err) {
        console.warn('[context-rebuild] ILO error:', err);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Context analyzed and stored. Proceeding with execution.`,
          },
        ],
        details: {
          entities_stored: (extracted_entities || []).length,
          claims_stored: (extracted_claims || []).length,
        },
      };
    },
  });
}
