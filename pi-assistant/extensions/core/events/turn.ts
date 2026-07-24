// ============================================================================
// events/turn.ts — turn_end handler for logging + entity extraction
// ============================================================================
// On each turn_end:
//   1. Logs Turn node (tokens_in, tokens_out, session_id, model)
//   2. Extracts entities from user + assistant text
//   3. Increments mention_count for matched entities
//   4. Triggers consolidation counter
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import * as crypto from 'node:crypto';
import { hasEngine, getDb, getSessionId } from '../lib/engine';
import { extractEntities, advanceEntityCacheTurn } from '../lib/context';
import { consolidate } from '../lib/consolidation';

// ── In-memory state ─────────────────────────────────────

const STATE_KEY = '__ailo_turn_state__';

interface TurnState {
  /** The last user input text (set by input event, read by turn_end) */
  lastUserText: string;
  /** Consolidation counter (incremented each turn, triggers at 10) */
  turnCount: number;
}

function getState(): TurnState {
  let state = (globalThis as any)[STATE_KEY];
  if (!state) {
    state = { lastUserText: '', turnCount: 0 };
    (globalThis as any)[STATE_KEY] = state;
  }
  return state;
}

// ═══════════════════════════════════════════════════════════
// User text forwarder (called by input handler)
// ═══════════════════════════════════════════════════════════

/**
 * Store the user's input text for turn_end to use.
 * Called from events/input.ts at the start of each turn.
 */
export function setCurrentUserText(text: string): void {
  getState().lastUserText = text;
}

// ═══════════════════════════════════════════════════════════
// Handler registration
// ═══════════════════════════════════════════════════════════

export function registerTurnHooks(pi: ExtensionAPI): void {
  pi.on('session_start', async () => {
    // Reset state, restore consolidation counter from Config node
    try {
      const db = getDb();
      const rows = await db.query(
        "MATCH (c:Config {key: 'consolidation.turn_counter'}) RETURN c.value AS value"
      );
      const count = rows.length > 0 ? parseInt(rows[0].value, 10) : 0;
      getState().turnCount = isNaN(count) ? 0 : count;
    } catch {
      getState().turnCount = 0;
    }
  });

  pi.on('turn_end', async (event, ctx) => {
    if (!hasEngine()) return;

    const state = getState();
    state.turnCount++;

    try {
      const sessionId = getSessionId();
      const db = getDb();
      const now = new Date().toISOString();

      // ── 1. Log Turn node ──
      const turnText = extractTurnText(event.message);
      
      await db.addNode('Turn', {
        session_id: sessionId,
        turn_index: event.turnIndex ?? state.turnCount,
        user_text: state.lastUserText || '',
        response_text: turnText,
        model: (event.message as any)?.model || '',
        tokens_in: (event.message as any)?.usage?.input_tokens || 0,
        tokens_out: (event.message as any)?.usage?.output_tokens || 0,
        timestamp: now,
      });

      // ── 2. Extract entities from user + assistant text ──
      const allText = (state.lastUserText || '') + ' ' + (turnText || '');
      const entities = await extractEntities(allText);

      // Advance entity cache turn counter (once per turn)
      advanceEntityCacheTurn();

      // ── 2b. Gap detection (tutor mode) ──
      const userText = state.lastUserText || '';
      const strugglePatterns = /don'?t\s+(get|understand|follow|know)|(stuck|confused|unclear|not\s+sure|cannot|can't\s+(figure|grasp))/i;
      if (userText && strugglePatterns.test(userText)) {
        const topic = entities.length > 0 ? entities[0] : 'unknown';
        try {
          await db.addNode('Belief', {
            id: crypto.randomUUID(),
            content: `User identified gap: ${topic} — "${userText.substring(0, 120)}"`,
            confidence: 0.7,
            entity: 'learner:gap',
            provenance: 'user.identified',
            last_referenced: now,
            created_at: now,
          });
        } catch {}
      }

      // ── 3. Increment mention_count ──
      for (const entityName of entities) {
        try {
          await db.exec(
            'MATCH (e:Entity {name: $name}) SET e.mention_count = COALESCE(e.mention_count, 0) + 1',
            { name: entityName }
          );
        } catch {
          // Entity may not exist — that's fine
        }
      }

      // ── 4. Update consolidation counter in Config node ──
      if (state.turnCount % 10 === 0) {
        await db.exec(
          "MATCH (c:Config {key: 'consolidation.turn_counter'}) SET c.value = $count",
          { count: String(state.turnCount) }
        );
        
        await consolidate();
      }

      // Reset user text for next turn
      state.lastUserText = '';
    } catch (err: any) {
      console.warn('[turn] turn_end error:', err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

/** Extract text content from an assistant message. */
function extractTurnText(message: any): string {
  if (!message?.content) return '';
  
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text || '')
      .join('\n');
  }
  return '';
}