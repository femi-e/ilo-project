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
import { isIloHealthy } from '../lib/ilo-manager';

// ── In-memory state (survives /reload) ────────────────

const STATE_KEY = '__ailo_ilo_turn_state__';

interface TurnState {
  lastUserText: string;
  turnCount: number;
  sessionId: string;
  healthy: boolean;
}

export function getState(): TurnState {
  let state = (globalThis as any)[STATE_KEY];
  if (!state) {
    state = { lastUserText: '', turnCount: 0, sessionId: 'default', healthy: false };
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
  pi.on('session_start', async (_event: any, ctx: any) => {
    const state = getState();
    state.turnCount = 0;
    state.sessionId = crypto.randomUUID?.() || Date.now().toString(36);

    // Show ILO startup status
    const healthy = await isIloHealthy();
    state.healthy = healthy;
    if (healthy && ctx?.ui) {
      ctx.ui.setStatus('ilo', ctx.ui.theme.fg('success', '● ILO'));
      ctx.ui.notify('ILO memory layer connected', 'info');
    } else if (ctx?.ui) {
      ctx.ui.setStatus('ilo', ctx.ui.theme.fg('error', '✖ ILO offline'));
      ctx.ui.notify('ILO memory layer unavailable', 'error');
    }
  });

  pi.on('turn_end', async (event: any, ctx: any) => {
    const state = getState();
    const turn = event?.turn || event;
    const userText = state.lastUserText;
    const responseText = turn?.response || turn?.text || '';

    if (!userText && !responseText) return;

    try {
      // Step 1: Extract entities and claims from the full turn
      const fullText = `${userText}\n${responseText}`;
      const extract = await ilo.extract(fullText);
      const entityCount = extract.data?.entities?.length || 0;
      const claimCount = extract.data?.claims?.length || 0;

      // Step 2: Determine which entities were used (learning signal)
      const usedLabels = (extract.data?.entities || [])
        .filter((e: any) => responseText.toLowerCase().includes(e.name.toLowerCase()))
        .map((e: any) => e.name);

      if (usedLabels.length > 0) {
        await ilo.learn({
          query: userText,
          responseText,
          usedLabels,
          quality: 0.8,
        }).catch(() => {});
      }

      // Step 3: Store the turn
      await ilo.remember({
        query: userText,
        response: responseText,
        entities: extract.data?.entities || [],
        claims: extract.data?.claims || [],
        sessionId: state.sessionId,
        turnIndex: state.turnCount++,
      }).catch(() => {});

      // Notify on memory activity (first few turns)
      if (state.turnCount <= 3 && (entityCount > 0 || claimCount > 0) && ctx?.ui) {
        ctx.ui.notify(`Memory: ${entityCount} entities, ${claimCount} claims`, 'info');
      }
    } catch (err) {
      console.error('[ilo-turn] failed:', err);
    }
  });

  pi.on('session_end', async (_event: any, ctx: any) => {
    if (ctx?.ui) ctx.ui.setStatus('ilo', undefined);
  });
}
