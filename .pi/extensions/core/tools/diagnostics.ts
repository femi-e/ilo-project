// ============================================================================
// tools/diagnostics.ts — System diagnostics tool
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ilo } from '../lib/ilo-client';

export function registerDiagnosticsTool(api: ExtensionAPI): void {
  api.registerTool({
    name: 'system_diagnostics',
    label: 'System Diagnostics',
    description: 'Run full system diagnostics and return a structured health report covering the ILO memory sidecar (status, version, DB connection, uptime), the search index (tag count), and system info (platform, Node version, memory usage, SearXNG status).',
    promptSnippet: 'Run system diagnostics — check ILO memory sidecar and SearXNG health',
    promptGuidelines: [
      'Use system_diagnostics when you need to check whether the ILO memory system or web search (SearXNG) is working correctly.',
      'The report includes: sidecar status/version, database connection, tag index size, and SearXNG availability.',
      'Run this first if memory_search or web_search tools are failing.',
    ],
    parameters: Type.Object({}),
    execute: async () => {
      const lines: string[] = [];
      lines.push('=== ILO Diagnostics ===');
      lines.push('');

      // ILO sidecar status
      const status = await ilo.status();
      if (status.ok && status.data) {
        lines.push('Sidecar:     ' + status.data.status);
        lines.push('Version:     ' + status.data.version);
        lines.push('DB:          connected');
        lines.push('Uptime:      ' + status.data.uptime_secs + 's');
      } else {
        lines.push('Sidecar:     error — ' + (status.error || 'unreachable'));
      }

      // Search index health via debug endpoint
      const debug = await ilo.debug();
      if (debug.ok && debug.data) {
        const tags = debug.data.tag_index_keys || [];
        lines.push('Tags:        ' + tags.length + ' unique (' + tags.slice(0, 8).join(', ') + (tags.length > 8 ? ', ...' : '') + ')');
      }

      lines.push('');
      lines.push('=== System ===');
      lines.push('Platform:    ' + process.platform);
      lines.push('Node:        ' + process.version);
      lines.push('PID:         ' + process.pid);
      lines.push('Memory:      ' + (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) + 'MB');

      // Podman/SearXNG check
      try {
        const searxng = await fetch('http://localhost:18089/search?q=ping&format=json', {
          signal: AbortSignal.timeout(2000),
        });
        lines.push('SearXNG:     ' + (searxng.ok ? 'responding' : 'error'));
      } catch {
        lines.push('SearXNG:     unavailable');
      }

      lines.push('');
      lines.push('========================');

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {},
      };
    },
  });
}
