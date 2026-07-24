// ============================================================================
// tools/config.ts — Config tool for reading/writing system settings
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import * as crypto from 'node:crypto';
import { getDb } from '../lib/engine';
import type { ToolDefinition } from '../lib/tool-registry';

// ── Tool definition (for central registry) ───────────────

export const configToolDef: ToolDefinition = {
  name: 'config',
  label: 'Config',
  description: 'Read or write system configuration values',
  category: 'tracking',
  aliases: 'settings, configure, preference',
  promptSnippet: 'View or change system configuration',
  promptGuidelines: [
    'Use config to read or change system settings.',
    'Config keys are dot-structured like "feedback.keyword.enabled".',
    'Use config list to see all available settings.',
  ],
  register: registerConfigTool,
};

// ── Registration function ────────────────────────────────

export function registerConfigTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'config',
    label: 'Config',
    description: 'Read or write Ailo system configuration values.',
    promptSnippet: configToolDef.promptSnippet,
    promptGuidelines: configToolDef.promptGuidelines,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('get'),
        Type.Literal('set'),
        Type.Literal('list'),
      ], { description: 'Action to perform' }),
      key: Type.Optional(Type.String({ description: 'Config key (required for get/set)' })),
      value: Type.Optional(Type.String({ description: 'New value (required for set)' })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal, onUpdate?: (update: any) => void): Promise<any> {
      const db = getDb();

      onUpdate?.({ content: [{ type: 'text', text: `Config: ${params.action}...` }] });

      switch (params.action) {
        case 'get': {
          if (!params.key) return { content: [{ type: 'text', text: 'key is required for get.' }], details: {} };
          const rows = await db.query(
            'MATCH (c:Config {key: $key}) RETURN c.value AS value, c.scope AS scope ORDER BY c.version DESC LIMIT 1',
            { key: params.key }
          );
          if (rows.length === 0) return { content: [{ type: 'text', text: `Config key not found: ${params.key}` }], details: {} };
          return { content: [{ type: 'text', text: `${params.key} = ${rows[0].value} (${rows[0].scope})` }], details: {} };
        }

        case 'set': {
          if (!params.key || !params.value) return { content: [{ type: 'text', text: 'key and value are required for set.' }], details: {} };
          const existing = await db.query('MATCH (c:Config {key: $key}) RETURN c.id, c.version ORDER BY c.version DESC LIMIT 1', { key: params.key });
          if (existing.length > 0) {
            const newVersion = (existing[0].version || 1) + 1;
            await db.addNode('Config', {
              id: crypto.randomUUID(),
              key: params.key,
              value: params.value,
              version: newVersion,
              scope: 'adaptive',
              mutable: 'flexible',
              updated_at: new Date().toISOString(),
            });
          } else {
            await db.addNode('Config', {
              id: crypto.randomUUID(),
              key: params.key,
              value: params.value,
              version: 1,
              scope: 'adaptive',
              mutable: 'flexible',
              updated_at: new Date().toISOString(),
            });
          }
          return { content: [{ type: 'text', text: `Set ${params.key} = ${params.value}` }], details: {} };
        }

        case 'list': {
          const rows = await db.query('MATCH (c:Config) RETURN c.key AS key, c.value AS value, c.scope AS scope ORDER BY c.key');
          if (rows.length === 0) return { content: [{ type: 'text', text: 'No config entries.' }], details: {} };
          const lines = rows.map((r: any) => `  ${r.key} = ${r.value} (${r.scope})`);
          return { content: [{ type: 'text', text: `${rows.length} config entr(ies):\n${lines.join('\n')}` }], details: {} };
        }

        default:
          return { content: [{ type: 'text', text: 'Unknown action. Valid: get, set, list.' }], details: {} };
      }
    },
  });
}
