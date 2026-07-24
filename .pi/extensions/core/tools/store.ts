// ============================================================================
// tools/store.ts — Store + Forget tools (ILO-powered)
// ============================================================================
// Replaces the old direct-DB store/forget with ILO API calls.
// Maintains the same tool interface so the LLM doesn't notice.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ilo } from '../lib/ilo-client';
import type { ToolDefinition } from '../lib/tool-registry';

export const storeToolDef: ToolDefinition = {
  name: 'store',
  label: 'Store',
  description: 'Store a belief about a person, project, or concept in long-term memory',
  category: 'storage',
  promptSnippet: 'Store a fact in long-term memory with confidence',
  register: registerStoreTool,
};

export const forgetToolDef: ToolDefinition = {
  name: 'forget',
  label: 'Forget',
  description: 'Deprecate or remove a stored belief',
  category: 'storage',
  promptSnippet: 'Deprecate a stored belief',
  register: registerForgetTool,
};

export function registerStoreTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'store',
    label: 'Store',
    description: 'Store a belief or fact in persistent long-term memory.',
    promptSnippet: storeToolDef.promptSnippet,
    parameters: Type.Object({
      content: Type.String({ description: 'The belief text' }),
      entity: Type.Optional(Type.String({ description: 'What this belief is about' })),
      confidence: Type.Optional(Type.Number({ description: '0.0 to 1.0 (default 0.5)' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const content = (params.content || '').trim();
      if (!content) return { content: [{ type: 'text', text: 'No content provided.' }], details: {} };

      onUpdate?.({ content: [{ type: 'text', text: 'Storing belief...' }] });

      const conf = params.confidence ?? 0.5;
      const entity = params.entity || 'general';

      // Store via ILO: create entity + claim
      const result = await ilo.remember({
        query: '',
        response: content,
        entities: [{ label: entity, confidence: conf, tags: [] }],
        claims: [{ content, confidence: conf, provenance: 'user_confirmed', entities: [entity] }],
        sessionId: 'tool_store',
        turnIndex: Date.now(),
      });

      if (!result.ok) {
        return { content: [{ type: 'text', text: `Failed to store: ${result.error}` }], details: {} };
      }

      return {
        content: [{ type: 'text', text: `Stored belief about ${entity} with confidence ${conf}.` }],
        details: { entity, confidence: conf, content },
      };
    },
  });
}

export function registerForgetTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'forget',
    label: 'Forget',
    description: 'Deprecate or remove a stored belief.',
    promptSnippet: forgetToolDef.promptSnippet,
    parameters: Type.Object({
      content: Type.String({ description: 'The belief text to remove' }),
      entity: Type.Optional(Type.String({ description: 'Entity the belief is about' })),
    }),
    async execute(_toolCallId: string, params: any): Promise<any> {
      const content = (params.content || '').trim();
      if (!content) return { content: [{ type: 'text', text: 'No content provided.' }], details: {} };

      // Mark as forgotten via entity update (set confidence to 0)
      const entity = params.entity || 'general';
      await ilo.entityUpdate(entity, { forgotten: true, forgotten_content: content });

      return {
        content: [{ type: 'text', text: `Deprecated belief about ${entity}.` }],
        details: { entity, content },
      };
    },
  });
}
