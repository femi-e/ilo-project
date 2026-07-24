// ============================================================================
// events/tool.ts — tool_call + tool_result handlers
// ============================================================================
// Two responsibilities:
//   1. Idempotency (tool_call): Check dedup_key to prevent duplicate execution
//   2. Output offloading (tool_result): Store large results, inject compact ref
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { hasEngine, getDb, getSessionId } from '../lib/engine';
import { readConfig } from '../lib/context';
import { EXT_VAR_DIR } from '../lib/constants';
import { invalidateCache, clearAllCache } from '../lib/file-cache';

// ═══════════════════════════════════════════════════════════
// Handler registration
// ═══════════════════════════════════════════════════════════

export function registerToolHooks(pi: ExtensionAPI): void {
  // Shared map to pass dedup_key between tool_call and tool_result
  // (they receive separate event objects, so event._dedupKey doesn't work)
  const dedupMap = new Map<string, string>();

  // ── tool_call: Idempotency check ──────────────────────
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (!hasEngine()) return;

    // Generate dedup_key from tool name + toolCallId
    // toolCallId is unique per tool call in the session
    const dedupKey = `${event.toolName}:${event.toolCallId}`;

    // Store for tool_result to use (separate event object)
    dedupMap.set(event.toolCallId, dedupKey);

    // Check if this exact call already completed successfully
    try {
      const db = getDb();
      const existing = await db.query(
        "MATCH (a:Action {dedup_key: $key, status: 'success'}) RETURN a.id LIMIT 1",
        { key: dedupKey }
      );

      if (existing.length > 0) {
        console.log(`[tool] Blocked duplicate: ${event.toolName} (${event.toolCallId})`);
        dedupMap.delete(event.toolCallId);
        return { block: true, reason: 'Duplicate tool call — previous result is still available' };
      }
    } catch (err: any) {
      dedupMap.delete(event.toolCallId);
      console.warn('[tool] Idempotency check failed:', err.message);
    }
  });

  // ── tool_result: Log + output offloading ──────────────
  pi.on('tool_result', async (event: any, ctx: any) => {
    if (!hasEngine()) return;

    try {
      const db = getDb();
      const sessionId = getSessionId();
      // Read dedup_key from shared map (tool_call stored it earlier)
      const dedupKey = dedupMap.get(event.toolCallId) || `${event.toolName}:${event.toolCallId}:unknown`;
      dedupMap.delete(event.toolCallId);
      const now = new Date().toISOString();

      // Read offload threshold from Config
      const thresholdStr = await readConfig('tool.offload.threshold_chars', '500');
      const threshold = parseInt(thresholdStr, 10);

      // Serialize result
      const resultJson = JSON.stringify(event.content || []);
      const isLarge = resultJson.length > threshold;

      // Store Action node
      await db.addNode('Action', {
        session_id: sessionId,
        turn_id: '',  // Will be linked later
        tool_name: event.toolName,
        args: JSON.stringify(event.input || {}),
        result: isLarge
          ? `[Full result: ${resultJson.length} chars stored, use database lookup to retrieve]`
          : resultJson.substring(0, 5000),  // Cap at 5000 chars inline
        duration_ms: 0,
        status: event.isError ? 'error' : 'success',
        dedup_key: dedupKey,
        timestamp: now,
      });

      // Auto-invalidate file cache after file-modifying tools
      if (event.toolName === 'edit' || event.toolName === 'write') {
        const targetPath = event.input?.path || '';
        if (targetPath) {
          invalidateCache(targetPath);
        } else {
          clearAllCache(); // Bulk write — clear everything
        }
      }

      // Offload large results to a separate file
      if (isLarge) {
        await storeOffloadedResult(dedupKey, resultJson);
      }
    } catch (err: any) {
      console.warn('[tool] tool_result error:', err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// Output offloading
// ═══════════════════════════════════════════════════════════

const OFFLOAD_DIR = EXT_VAR_DIR;

/**
 * Store a large tool result to disk for later retrieval.
 * The context sees a compact reference instead of the full text.
 */
async function storeOffloadedResult(dedupKey: string, content: string): Promise<void> {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    
    if (!fs.existsSync(OFFLOAD_DIR)) {
      fs.mkdirSync(OFFLOAD_DIR, { recursive: true });
    }
    
    const safeName = dedupKey.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(OFFLOAD_DIR, `${safeName}.json`);
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err: any) {
    console.warn('[tool] Offload write failed:', err.message);
  }
}