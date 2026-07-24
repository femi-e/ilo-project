// ============================================================================
// tools/mode.ts — mode tool for LLM to check/transition modes
// ============================================================================
// The agent can use this tool to:
//   - Check what mode it's currently in
//   - Explicitly transition to another mode
//   - List available modes and their allowed tools
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { MODES, getCurrentMode, transitionTo, setModeOverride } from '../lib/modes';
import type { ModeId } from '../lib/modes';
import type { ToolDefinition } from '../lib/tool-registry';

// ── Tool definition ──────────────────────────────────────

export const modeToolDef: ToolDefinition = {
  name: 'mode',
  label: 'Mode',
  description: 'Check the current operational mode or transition to a new mode. Modes gate tool availability and behavior rules.',
  category: 'tracking',
  aliases: 'mode, transition, switch, status',
  promptSnippet: 'Check or change the current operational mode',
  promptGuidelines: [
    'Use mode to check your current mode when you need to understand why certain tools are unavailable.',
    'Use mode with action:transition to explicitly switch to research, plan, execute, review, tutoring, or job-hunt.',
    'Mode transitions are automatic based on conversation context, but explicit transitions override detection.',
  ],
  register: registerModeTool,
};

function registerModeTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'mode',
    label: 'Mode',
    description: 'Check or change the current operational mode.',
    promptSnippet: modeToolDef.promptSnippet,
    promptGuidelines: modeToolDef.promptGuidelines,
    parameters: Type.Object({
      action: Type.String({
        description: 'Action: "check" to view current mode, "transition" to switch to a new mode, "list" to see all modes.',
      }),
      target: Type.Optional(Type.String({
        description: 'Target mode for transition: research, plan, execute, review, tutoring, job-hunt.',
      })),
    }),
    async execute(_toolCallId: string, params: any, _signal?: AbortSignal): Promise<any> {
      const action = (params.action || '').trim().toLowerCase();

      switch (action) {
        case 'check': {
          const current = getCurrentMode();
          const config = MODES[current];
          return {
            content: [{ type: 'text', text: [
              `**Current mode:** ${config.label} (${current})`,
              '',
              `**Description:** ${config.description}`,
              '',
              '**Allowed tools:**',
              ...config.allowedTools.map(t => `  - ${t}`),
              '',
              '**Enforcement:** ' + config.enforce,
            ].join('\n') }],
            details: { mode: current, enforce: config.enforce, allowedTools: config.allowedTools },
          };
        }

        case 'transition': {
          const target = (params.target || '').trim().toLowerCase() as ModeId;
          if (!MODES[target]) {
            const valid = Object.keys(MODES).join(', ');
            return {
              content: [{ type: 'text', text: `Invalid mode: "${params.target}". Valid modes: ${valid}` }],
              details: { error: 'invalid mode' },
            };
          }
          setModeOverride(target);
          return {
            content: [{ type: 'text', text: `Transitioning to ${MODES[target].label} mode (${target}). Tool availability will change on next turn.` }],
            details: { previousMode: getCurrentMode(), newMode: target },
          };
        }

        case 'list': {
          const lines = Object.entries(MODES).map(([id, config]) =>
            `- **${config.label}** (\`${id}\`): ${config.description} — ${config.allowedTools.length} tools`
          );
          return {
            content: [{ type: 'text', text: [
              '## Available Modes',
              '',
              ...lines,
              '',
              'Use `mode` with action:"transition" and target:"<mode>" to switch.',
            ].join('\n') }],
            details: { modes: Object.keys(MODES) },
          };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown action: "${action}". Valid: check, transition, list.` }],
            details: { error: 'unknown action' },
          };
      }
    },
  });
}
