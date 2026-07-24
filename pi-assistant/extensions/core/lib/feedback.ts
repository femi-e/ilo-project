// ============================================================================
// lib/feedback.ts — Signal detection for the feedback loop
// ============================================================================
// Detects feedback signals from user input: corrections, acceptance,
// continuation, error retries. Adjusts belief confidence in the DB.
//
// Two paths:
//   FAST (keyword)  — always runs in input event, <1ms
//   SLOW (semantic) — fire-and-forget in input event, ~2ms
// ============================================================================

import { getDb, getSessionId } from './engine';
import { embed, getStatus } from './embedding';
import { readConfig } from './context';

// ═══════════════════════════════════════════════════════════
// Signal types
// ═══════════════════════════════════════════════════════════

export type FeedbackSignal =
  | 'correction'
  | 'acceptance'
  | 'continuation'
  | 'error_retry'
  | 'neutral';

export interface SignalResult {
  signal: FeedbackSignal;
  delta: number;
  source: 'keyword' | 'semantic';
  targetEntity?: string;  // The entity being corrected/accepted (if detectable)
  confidence: number;     // How sure we are this signal is correct (0.0-1.0)
}

// ═══════════════════════════════════════════════════════════
// Keyword patterns (FAST path)
// ═══════════════════════════════════════════════════════════

/** Patterns that indicate the user is correcting the previous response. */
const CORRECTION_PATTERNS: RegExp[] = [
  /\b(that'?s wrong|that'?s not right|that is incorrect|that'?s incorrect)\b/i,
  /\b(actually,?|not what i meant|not what I said|i didn'?t say)\b/i,
  /\b(incorrect|wrong|inaccurate)\b/i,
  /\b(no[.,;:]|not quite|that'?s not|you'?re wrong|you are wrong)\b/i,
  /\b(should be|instead of|is actually|means that|is really)\b/i,
  /\b(no,? .+ is|no,? .+ are|no,? .+ was)\b/i,
  /\b(let me correct|let me rephrase|let me clarify)\b/i,
];

/**
 * Patterns that look like corrections but actually aren't.
 * These match common false positives where correction keywords
 * appear in neutral/descriptive context rather than as feedback.
 */
const FALSE_CORRECTION_PATTERNS: RegExp[] = [
  /\b(?:a|the|another|common|typical|known|an?)\s+(?:error|mistake|inaccurate|false)\b/i,
  /\b(?:prevent|avoid|reduce|minimize|fix|resolve|handle)\s+(?:error|mistake|incorrect)\b/i,
  /(?:error|mistake|wrong)\s+(?:handling|checking|detection|type|code|message|rate|state)\b/i,
  /(?:syntax|runtime|compile|network|server)\s+error\b/i,
  /\berror\s+(?:code|number|message)\b/i,
];

/** Patterns that indicate the user accepts the previous response. */
const ACCEPTANCE_PATTERNS: RegExp[] = [
  /\b(yes|correct|exactly|that works|that'?s right|you'?re right)\b/i,
  /\b(nice|awesome|perfect|excellent|understood)\b/i,
  /\b(that'?s what i thought|that makes sense|i see|got it|makes sense)\b/i,
  /\b(agree|agreed|confirmed|works for me|looks good|sounds good)\b/i,
];

/** Patterns that indicate the user is continuing the same topic (neutral-to-positive). */
const CONTINUATION_PATTERNS: RegExp[] = [
  /\b(and then|next|also|furthermore|additionally|moreover)\b/i,
  /\b(continue|go on|keep going|tell me more|what about|how about)\b/i,
  /\b(so then|and also|one more|another thing|also about)\b/i,
];

// ═══════════════════════════════════════════════════════════
// 1. Keyword-based signal detection (FAST — <1ms)
// ═══════════════════════════════════════════════════════════

/**
 * Detect feedback signal from user input using keyword patterns.
 * Runs synchronously — no DB, no embed calls.
 * Returns null if no signal is detected.
 */
export function detectKeywords(userInput: string): SignalResult | null {
  if (!userInput || userInput.trim().length === 0) return null;

  // ── Correction path ──
  // First screen out obvious false positives
  const isGenuineCorrection = !FALSE_CORRECTION_PATTERNS.some(p => p.test(userInput));

  if (isGenuineCorrection) {
    for (const pattern of CORRECTION_PATTERNS) {
      if (pattern.test(userInput)) {
        // Additional guard: if text is a question about the topic, it's not a correction
        if (/^(what|how|why|when|where|which|who|can|could|would|does)\b/i.test(userInput.trim())) {
          break;
        }
        return {
          signal: 'correction',
          delta: -0.25,
          source: 'keyword',
          confidence: 0.7,
        };
      }
    }
  }

  // ── Acceptance path ──
  // Only match acceptance if the text is short (direct acknowledgment)
  // or if it clearly signals agreement. Avoid matching acceptance
  // in long descriptive text where words like "good" or "right" appear naturally.
  const isShort = userInput.length < 80;
  for (const pattern of ACCEPTANCE_PATTERNS) {
    if (pattern.test(userInput)) {
      // Long text with an acceptance word is probably not feedback
      if (!isShort) continue;
      return {
        signal: 'acceptance',
        delta: 0.08,
        source: 'keyword',
        confidence: 0.6,
      };
    }
  }

  // ── Continuation path ──
  for (const pattern of CONTINUATION_PATTERNS) {
    if (pattern.test(userInput)) {
      return {
        signal: 'continuation',
        delta: 0.03,
        source: 'keyword',
        confidence: 0.5,
      };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
// 2. Semantic signal detection (SLOW — ~2ms, uses embedding)
// ═══════════════════════════════════════════════════════════

/**
 * Detect feedback signal by comparing user input to the last assistant response.
 * Uses embedding + cosine similarity.
 * Returns null if embedding is unavailable or similarity is inconclusive.
 */
export async function detectSemantic(
  userInput: string,
  lastResponse: string
): Promise<SignalResult | null> {
  if (!userInput || !lastResponse) return null;

  // Check if embedding is available
  const embedStatus = getStatus();
  if (embedStatus !== 'healthy') return null;

  // Check config — semantic may be disabled
  const enabled = await readConfig('feedback.semantic.enabled', 'true');
  if (enabled !== 'true') return null;

  // Get similarity threshold from config
  const thresholdStr = await readConfig('feedback.semantic.similarity_threshold', '0.5');
  const threshold = parseFloat(thresholdStr);

  try {
    const vectors = await embed([userInput.substring(0, 500), lastResponse.substring(0, 500)]);
    if (!vectors || vectors.length < 2) return null;

    const similarity = cosineSimilarity(vectors[0], vectors[1]);

    if (similarity > threshold) {
      return {
        signal: 'continuation',
        delta: clamp(similarity * 0.05, 0.02, 0.05),
        source: 'semantic',
        confidence: similarity,
      };
    }

    // Low similarity + correction keywords already checked in keyword path
    // But we can detect topic changes as neutral
    if (similarity < 0.2) {
      return {
        signal: 'neutral',
        delta: -0.02,
        source: 'semantic',
        confidence: 0.4,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 3. Error retry detection
// ═══════════════════════════════════════════════════════════

/**
 * Check if the previous turn had tool errors.
 * Useful for detecting error_retry signal.
 */
export async function detectErrorRetry(sessionId: string): Promise<SignalResult | null> {
  try {
    const db = getDb();
    const rows = await db.query(
      'MATCH (a:Action {session_id: $sid, status: \'error\'}) RETURN a.id LIMIT 1',
      { sid: sessionId }
    );

    if (rows.length > 0) {
      return {
        signal: 'error_retry',
        delta: -0.15,
        source: 'keyword',
        confidence: 0.8,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// 4. Confidence adjustment
// ═══════════════════════════════════════════════════════════

/**
 * Apply a feedback signal to adjust belief confidence in the database.
 * 
 * @param signal - The detected signal
 * @param targetEntity - Optional specific entity to adjust (if null, adjusts recently injected beliefs)
 * @param turnIndex - Optional turn index for logging (from input.ts turnCount)
 */
export async function applyFeedback(
  signal: SignalResult,
  targetEntity?: string,
  turnIndex?: number
): Promise<void> {
  try {
    const db = getDb();
    const delta = signal.delta;

    if (targetEntity) {
      // Adjust all beliefs for a specific entity
      // First get current confidence, clamp in JS, then set
      const existingBeliefs = await db.query(
        'MATCH (e:Entity {name: $entity})-[:HAS_BELIEF]->(b:Belief) ' +
        'RETURN b.id AS id, b.confidence AS conf',
        { entity: targetEntity }
      );
      for (const belief of existingBeliefs || []) {
        const newConf = Math.max(0.0, Math.min(1.0, (belief.conf || 0.5) + delta));
        await db.exec(
          'MATCH (b:Belief {id: $id}) SET b.confidence = $conf, b.last_referenced = $ts',
          { id: belief.id, conf: newConf, ts: new Date().toISOString() }
        );
      }
    }

    // Log the feedback as a Feedback node with proper session tracking
    const sessionId = getSessionId();
    await db.addNode('Feedback', {
      session_id: sessionId || '',
      turn_index: turnIndex ?? 0,
      signal: signal.signal,
      target_id: targetEntity || 'global',
      delta: delta,
      source: signal.source,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.warn('[feedback] applyFeedback error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}