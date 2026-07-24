// ============================================================================
// tools/store.ts — store + forget tools
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { getDb } from '../lib/engine';
import { embed } from '../lib/embedding';
import type { ToolDefinition } from '../lib/tool-registry';

// ── Tool definitions (for central registry) ──────────────

export const storeToolDef: ToolDefinition = {
  name: 'store',
  label: 'Store',
  description: 'Store a belief about a person, project, or concept in long-term memory',
  category: 'storage',
  aliases: 'save, remember, persist, record',
  promptSnippet: 'Store a fact in long-term memory with confidence',
  promptGuidelines: [
    'Use store when the user states a preference, personal fact, or you discover a persistent truth.',
    'Set entity to the subject (e.g. "user", project name, technology, concept).',
    'Use confidence 0.9 for explicitly stated facts, 0.5 for inferred patterns.',
  ],
  register: registerStoreTool,
};

export const forgetToolDef: ToolDefinition = {
  name: 'forget',
  label: 'Forget',
  description: 'Deprecate or remove a stored belief',
  category: 'storage',
  aliases: 'delete, remove, discard',
  promptSnippet: 'Deprecate a stored belief',
  promptGuidelines: ['Use forget when a stored belief is no longer accurate.'],
  register: registerForgetTool,
};

// ── Registration functions ───────────────────────────────

export function registerStoreTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'store',
    label: 'Store',
    description: 'Store a belief or fact in persistent long-term memory.',
    promptSnippet: storeToolDef.promptSnippet,
    promptGuidelines: storeToolDef.promptGuidelines,
    parameters: Type.Object({
      content: Type.String({ description: 'The belief text' }),
      entity: Type.Optional(Type.String({ description: 'What this belief is about' })),
      confidence: Type.Optional(Type.Number({ description: '0.0 to 1.0 (default 0.5)' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const content = (params.content || '').trim();
      if (!content) return { content: [{ type: 'text', text: 'No content provided.' }], details: {} };

      onUpdate?.({ content: [{ type: 'text', text: `Storing belief...` }] });

      const conf = params.confidence ?? 0.5;
      const entityName = params.entity ? params.entity.toLowerCase().trim() : '';
      const db = getDb();

      // Create or find entity
      let entityId: string | null = null;
      if (entityName) {
        const existing = await db.query('MATCH (e:Entity {name: $name}) RETURN e.id', { name: entityName });
        if (existing.length > 0) {
          entityId = existing[0].id;
        } else {
          entityId = randomUUID();
          await db.addNode('Entity', {
            id: entityId, name: entityName, type: 'topic', confidence: 0.5,
            mention_count: 0, momentum: 0, created_at: new Date().toISOString(),
          });
        }
      }

      // Embed
      const vectors = await embed([content.substring(0, 1000)]);
      const embedding = vectors?.[0] || null;

      // Create belief
      const beliefId = randomUUID();
      const now = new Date().toISOString();
      const belief: Record<string, any> = {
        id: beliefId, content, confidence: conf,
        entity: entityName || null, provenance: conf >= 0.8 ? 'user.confirmed' : 'system.inferred',
        embedding, last_referenced: now, created_at: now,
      };
      await db.addNode('Belief', belief);

      // Link entity → belief
      if (entityId) {
        await db.addEdge('Entity', 'id', entityId, 'Belief', 'id', beliefId, 'HAS_BELIEF');
      }

      const shortId = beliefId.substring(0, 8);
      return { content: [{ type: 'text', text: `Stored belief (id: ${shortId}..., confidence: ${conf}): ${content.substring(0, 100)}` }], details: {} };
    },
  });
}

export function registerForgetTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'forget',
    label: 'Forget',
    description: 'Deprecate or remove a stored belief by ID.',
    promptSnippet: forgetToolDef.promptSnippet,
    promptGuidelines: forgetToolDef.promptGuidelines,
    parameters: Type.Object({
      id: Type.String({ description: 'UUID of the belief to deprecate' }),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const db = getDb();
      onUpdate?.({ content: [{ type: 'text', text: 'Looking up belief...' }] });
      const existing = await db.query('MATCH (b:Belief {id: $id}) RETURN b.content AS content, b.confidence AS conf', { id: params.id });
      if (existing.length === 0) return { content: [{ type: 'text', text: `Belief not found: ${params.id}` }], details: {} };

      await db.exec('MATCH (b:Belief {id: $id}) SET b.confidence = 0.0, b.last_referenced = $ts', {
        id: params.id,
        ts: new Date().toISOString(),
      });

      return { content: [{ type: 'text', text: `Deprecated belief: ${params.id} (was: "${(existing[0].content || '').substring(0, 80)}")` }], details: {} };
    },
  });
}
