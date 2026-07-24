// ============================================================================
// events/turn.ts — turn_end handler (ILO-powered)
// ============================================================================
// On each turn end:
//   1. Extracts entities and claims from the full conversation
//   2. Signals learning (which entities were useful)
//   3. Stores the turn with entities and claims via ILO
// ============================================================================

import * as crypto from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ilo } from '../lib/ilo-client';

// ── In-memory state (survives /reload) ────────────────

const STATE_KEY = '__ailo_ilo_turn_state__';

interface TurnState {
  lastUserText: string;
  turnCount: number;
  sessionId: string;
}

export function getState(): TurnState {
  let state = (globalThis as any)[STATE_KEY];
  if (!state) {
    state = { lastUserText: '', turnCount: 0, sessionId: 'default' };
    (globalThis as any)[STATE_KEY] = state;
  }
  return state;
}

/** Store the user's input text (called from input event). */
export function setCurrentUserText(text: string): void {
  getState().lastUserText = text;
}

// ═══════════════════════════════════════════════════════════
// Handler registration
// ═══════════════════════════════════════════════════════════

export function registerTurnHooks(pi: ExtensionAPI): void {
  pi.on('session_start', async () => {
    const state = getState();
    state.turnCount = 0;
    state.sessionId = crypto.randomUUID?.() || Date.now().toString(36);
    // Warm up ILO (non-blocking)
    ilo.status().catch(() => {});
  });

  pi.on('turn_end', async ({ turn }) => {
    const state = getState();
    const userText = state.lastUserText;
    const responseText = turn?.response || turn?.text || '';

    if (!userText && !responseText) return;

    try {
      // Step 1: Extract entities and claims from the full turn
      const fullText = `${userText}\n${responseText}`;
      const extract = await ilo.extract(fullText);

      // Step 2: Determine which entities were used (learning signal)
      const usedLabels = (extract.data?.entities || [])
        .filter((e: any) => responseText.toLowerCase().includes(e.name.toLowerCase()))
        .map((e: any) => e.name);

      if (usedLabels.length > 0) {
        // Step 3: Signal learning
        await ilo.learn({
          query: userText,
          responseText,
          usedLabels,
          quality: 0.8,
        }).catch(() => {});
      }

      // Step 4: Store the turn
      await ilo.remember({
        query: userText,
        response: responseText,
        entities: extract.data?.entities || [],
        claims: extract.data?.claims || [],
        sessionId: state.sessionId,
        turnIndex: state.turnCount++,
      }).catch(() => {});
    } catch (err) {
      console.error('[ilo-turn] failed:', err);
      // Non-fatal — agent continues without memory
    }
  });

  pi.on('session_end', async () => {
    // ILO auto-shuts down via ILO_MAX_UPTIME timer
    // No cleanup needed here
  });
}
