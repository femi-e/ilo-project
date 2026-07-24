// ============================================================================
// events/bash.ts — user_bash handler
// ============================================================================
// Logs user ! and !! commands as Action nodes for pattern mining.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { hasEngine, getDb, getSessionId } from '../lib/engine';

export function registerBashHooks(pi: ExtensionAPI): void {
  pi.on('user_bash', async (event: any) => {
    if (!hasEngine()) return;

    try {
      const db = getDb();
      await db.addNode('Action', {
        session_id: getSessionId(),
        turn_id: '',
        tool_name: 'user_bash',
        args: JSON.stringify({ command: event.command, cwd: event.cwd }),
        duration_ms: 0,
        status: 'success',
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.warn('[bash] Logging error:', err.message);
    }
  });
}