// ============================================================================
// events/input.ts — input event handler for feedback detection
// ============================================================================
// Runs on every user input. Two-phase detection:
//   1. FAST: keyword detection (<1ms, synchronous)
//   2. SLOW: semantic + error retry (~2ms, fire-and-forget)
//
// Never blocks user input. Returns { action: 'continue' }.
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SignalResult } from '../lib/feedback';
import { detectKeywords, detectSemantic, detectErrorRetry, applyFeedback } from '../lib/feedback';
import { hasEngine, getDb, getSessionId } from '../lib/engine';
import { readConfig } from '../lib/context';
import { setCurrentUserText } from './turn';

// ── Turn counter for tracking first turn ─────────────────

let turnCount = 0;

// ── Entity name cache (avoids loading 200 entities every input) ──

interface EntityCache {
  names: string[];
  timestamp: number;
}

let _entityCache: EntityCache | null = null;
const ENTITY_CACHE_TTL = 30_000; // 30 seconds

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Handler registration ───────────────────────────────

export function registerInputHooks(pi: ExtensionAPI): void {
  pi.on('session_start', async () => {
    turnCount = 0; // Reset on new session
  });

  pi.on('input', async (event, ctx) => {
    if (!hasEngine()) return { action: 'continue' };
    
    turnCount++;
    
    // Forward user text to turn.ts for turn_end logging
    setCurrentUserText(event.text || '');
    
    // Skip feedback on turn 1 (no previous response to compare)
    if (turnCount <= 1) return { action: 'continue' };
    
    // Check if keyword feedback is enabled
    const keywordEnabled = await readConfig('feedback.keyword.enabled', 'true');
    
    // ── Phase 1: Fast keyword detection ──
    let keywordSignal: SignalResult | null = null;
    let keywordEntity: string | undefined;
    
    if (keywordEnabled === 'true') {
      keywordSignal = detectKeywords(event.text || '');
      
      if (keywordSignal) {
        // Extract target entity from user input for scoped feedback
        keywordEntity = await detectTargetEntity(event.text || '');
        await applyFeedback(keywordSignal, keywordEntity, turnCount);
        
        // Don't need semantic if keyword already found a strong signal
        if (keywordSignal.confidence > 0.6) {
          return { action: 'continue' };
        }
      }
    }
    
    // ── Phase 2: Slow detection (fire-and-forget) ──
    // Semantic comparison + error retry check
    // Runs async, doesn't block the input event
    // Reuse the keyword-phase cached entity if available
    scheduleDeepAnalysis(event.text || '', ctx, keywordEntity);
    
    return { action: 'continue' };
  });
}

// ── Deep analysis (fire-and-forget) ─────────────────────

function scheduleDeepAnalysis(userInput: string, ctx: any, knownEntity?: string): void {
  // Use a microtask to avoid blocking the input event
  queueMicrotask(async () => {
    try {
      // Get last assistant response from session manager
      let lastResponse = '';
      try {
        const entries = ctx.sessionManager?.getBranch?.() || [];
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (e.type === 'message' && e.message?.role === 'assistant') {
            const content = e.message.content;
            if (Array.isArray(content)) {
              const textParts = content
                .filter((c: any) => c.type === 'text' && c.text)
                .map((c: any) => c.text);
              lastResponse = textParts.join('\n');
            }
            break;
          }
        }
      } catch {
        // Session manager may not be available
      }
      
      // Semantic comparison — reuse knownEntity from keyword path if available
      let prevEntity = knownEntity;
      const semanticSignal = await detectSemantic(userInput, lastResponse);
      if (semanticSignal) {
        if (!prevEntity) prevEntity = await detectTargetEntity(lastResponse);
        await applyFeedback(semanticSignal, prevEntity, turnCount);
      }
      
      // Error retry detection
      const sessionId = getSessionId();
      const errorSignal = await detectErrorRetry(sessionId);
      if (errorSignal) {
        await applyFeedback(errorSignal, prevEntity, turnCount);
      }
    } catch (err: any) {
      console.warn('[input] deep analysis error:', err.message);
    }
  });
}

// ═══════════════════════════════════════════════════════════
// Entity detection for scoped feedback
// ═══════════════════════════════════════════════════════════

/**
 * Detect which entity the user is referring to in their text.
 * Queries the DB for Entity names that appear as whole words in the input.
 * Uses a 30-second TTL cache to avoid loading 200 entities on every input.
 * Matches on word boundaries to avoid false positives (e.g. "node" won't
 * match inside "knowledge").
 * Returns the first matching entity name, or undefined if none found.
 * Best-effort — failures return undefined so feedback still gets logged.
 */
async function detectTargetEntity(text: string): Promise<string | undefined> {
  if (!text || !hasEngine()) return undefined;
  try {
    const now = Date.now();

    // Refresh cache if stale
    if (!_entityCache || now - _entityCache.timestamp > ENTITY_CACHE_TTL) {
      const db = getDb();
      const rows = await db.query(
        "MATCH (e:Entity) WHERE e.name IS NOT NULL AND e.name <> '' RETURN DISTINCT e.name AS name LIMIT 200"
      );
      if (!rows || rows.length === 0) {
        _entityCache = { names: [], timestamp: now };
        return undefined;
      }
      _entityCache = {
        names: rows.map((r: any) => (r.name || '').trim()).filter(Boolean),
        timestamp: now,
      };
    }

    const textLower = text.toLowerCase();
    for (const name of _entityCache.names) {
      const nameLower = name.toLowerCase();
      if (!nameLower || nameLower.length < 2) continue;
      // Match on word boundaries — prevents "set" matching "setting" or "node" matching "knowledge"
      const escaped = escapeRegex(nameLower);
      if (new RegExp(`\\b${escaped}\\b`, 'i').test(textLower)) {
        return name; // Return original casing
      }
    }
    return undefined;
  } catch {
    _entityCache = null; // Invalidate cache on error
    return undefined;
  }
}