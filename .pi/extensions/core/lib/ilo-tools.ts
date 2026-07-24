// ============================================================================
// lib/ilo-tools.ts — LLM-invokable tools for ILO
// ============================================================================
// These tools let the LLM interact with the ILO knowledge graph during
// generation: look up entities, store facts, link concepts, etc.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ilo } from './ilo-client';

export function registerIloTools(api: ExtensionAPI): void {
  // ── store: Store a belief about an entity ──────────
  api.registerTool({
    name: 'store',
    label: 'Store',
    description: 'Store a belief or fact in persistent long-term memory.',
    parameters: Type.Object({
      content: Type.String({ description: 'The belief text' }),
      entity: Type.Optional(Type.String({ description: 'What this belief is about' })),
      confidence: Type.Optional(Type.Number({ description: '0.0 to 1.0 (default 0.5)' })),
    }),
    execute: async (_id, params) => {
      const content = (params.content || '').trim();
      if (!content) return { content: [{ type: 'text', text: 'No content provided.' }], details: {} };
      const entity = params.entity || 'general';
      const conf = params.confidence ?? 0.5;

      await ilo.remember({
        query: '',
        response: content,
        entities: [{ label: entity, confidence: conf, tags: [] }],
        claims: [{ content, confidence: conf, provenance: 'user_confirmed', entities: [entity] }],
        sessionId: 'tool_store',
        turnIndex: Date.now(),
      });

      return { content: [{ type: 'text', text: `Stored belief about ${entity}.` }], details: { entity, confidence: conf } };
    },
  });

  // ── entity_lookup: Look up a known entity ──────────
  api.registerTool({
    name: 'entity_lookup',
    label: 'Entity Lookup',
    description: 'Look up a known entity in the knowledge graph.',
    parameters: Type.Object({ name: Type.String({ description: 'Entity name to look up' }) }),
    execute: async (_id, params) => {
      const res = await ilo.entityLookup(params.name);
      return { content: [{ type: 'text', text: JSON.stringify(res.data) }], details: res.data || {} };
    },
  });

  // ── connect: Link two entities ─────────────────────
  api.registerTool({
    name: 'connect',
    label: 'Connect',
    description: 'Link two entities in the knowledge graph.',
    parameters: Type.Object({
      from: Type.String({ description: 'Source entity' }),
      to: Type.String({ description: 'Target entity' }),
      link_type: Type.Optional(Type.String({ description: 'Link type: ref, dep, con, evidence' })),
    }),
    execute: async (_id, params) => {
      const res = await ilo.connect(params.from, params.to, params.link_type || 'ref');
      return { content: [{ type: 'text', text: `Linked ${params.from} → ${params.to}.` }], details: res.data || {} };
    },
  });

  // ── forget: Deprecate a stored belief ──────────────
  api.registerTool({
    name: 'forget',
    label: 'Forget',
    description: 'Deprecate or remove a stored belief.',
    parameters: Type.Object({
      content: Type.String({ description: 'The belief text to deprecate' }),
      entity: Type.Optional(Type.String({ description: 'Entity the belief is about' })),
    }),
    execute: async (_id, params) => {
      const entity = params.entity || 'general';
      await ilo.entityUpdate(entity, { forgotten: true });
      return { content: [{ type: 'text', text: `Deprecated belief about ${entity}.` }], details: { entity } };
    },
  });
}
