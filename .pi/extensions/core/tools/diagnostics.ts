// ============================================================================
// tools/diagnostics.ts — System diagnostics tool
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ilo } from '../lib/ilo-client';

export function registerDiagnosticsTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'diagnostics',
    label: 'Diagnostics',
    description: 'Run full system diagnostics and return a structured health report covering the ILO sidecar database, search index, and configured tools.',
    parameters: Type.Object({}),
    execute: async () => {
      const lines: string[] = [];
      lines.push('═══ ILO Diagnostics ═══');
      lines.push('');

      // ILO sidecar status
      const status = await ilo.status();
      if (status.ok && status.data) {
        lines.push(`Sidecar:     ${status.data.status}`);
        lines.push(`Version:     ${status.data.version}`);
        lines.push(`DB:          ${status.data.db_connected ? 'connected' : 'disconnected'}`);
        lines.push(`Uptime:      ${status.data.uptime_secs}s`);
      } else {
        lines.push(`Sidecar:     error — ${status.error || 'unreachable'}`);
      }

      // Search index health via debug endpoint
      const debug = await ilo.debug();
      if (debug.ok && debug.data) {
        const tags = debug.data.tag_index_keys || [];
        lines.push(`Tags:        ${tags.length} unique (${tags.slice(0, 8).join(', ')}${tags.length > 8 ? ', ...' : ''})`);
      }

      lines.push('');
      lines.push('═══ System ═══');
      lines.push(`Platform:    ${process.platform}`);
      lines.push(`Node:        ${process.version}`);
      lines.push(`PID:         ${process.pid}`);
      lines.push(`Memory:      ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`);

      // Podman/SearXNG check
      try {
        const searxng = await fetch('http://localhost:18089/search?q=ping&format=json', {
          signal: AbortSignal.timeout(2000),
        });
        lines.push(`SearXNG:     ${searxng.ok ? 'responding' : 'error'}`);
      } catch {
        lines.push('SearXNG:     unavailable');
      }

      lines.push('');
      lines.push('══════════════════════════');

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {},
      };
    },
  });
}
