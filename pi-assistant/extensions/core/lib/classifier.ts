// ============================================================================
// lib/classifier.ts — Ollama-based mode classifier
// ============================================================================
// Calls qwen3.5:4b via Ollama to classify user prompts into modes.
// Returns the mode name, or null if classification fails.
// ============================================================================

import type { ModeId } from './modes';

const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL = 'qwen3.5:4b';

const SYSTEM_PROMPT = [
  "Classify the request. Definitions:",
  "research: gathering info, reading documentation, exploring topics",
  "plan: designing architecture, tradeoffs, task lists",
  "execute: writing code, editing, implementing",
  "review: inspecting code, suggesting improvements",
  "tutoring: being taught, course material, learning",
  "job-hunt: CV, cover letters, interviews, applications",
  "",
  "Rules: 'How does X work' = research, NOT tutoring.",
  "If multiple actions, pick the primary action.",
  "'ok' and 'continue' = research by default.",
  "",
  "Examples:",
  "User: Teach me about Python lists",
  "Mode: tutoring",
  "User: How do Python lists work?",
  "Mode: research",
  "User: Build a login system",
  "Mode: execute",
  "User: What approach should I take for login?",
  "Mode: plan",
  "",
  "Output only the mode name.",
].join('\n');

const VALID_MODES = new Set<ModeId>(['research', 'plan', 'execute', 'review', 'tutoring', 'job-hunt']);

export interface ClassificationResult {
  mode: ModeId | null;
  confidence: 'high' | 'low';
  latencyMs: number;
}

/**
 * Classify a user prompt into a mode via Ollama.
 * Falls back to null if Ollama is unreachable or response is invalid.
 */
export async function classify(prompt: string, timeoutMs = 10000): Promise<ClassificationResult> {
  const t0 = performance.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        options: { temperature: 0 },
        think: false,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`[classifier] Ollama returned ${response.status}`);
      return { mode: null, confidence: 'low', latencyMs: Math.round(performance.now() - t0) };
    }

    const data = await response.json() as any;
    const text = (data.message?.content || '').trim().toLowerCase();
    const latency = Math.round(performance.now() - t0);

    // Extract first valid mode from output
    const words = text.split(/[\s\n,.;!?]+/);
    for (const word of words) {
      if (VALID_MODES.has(word as ModeId)) {
        return { mode: word as ModeId, confidence: 'high', latencyMs: latency };
      }
    }

    // No valid mode found in output
    return { mode: null, confidence: 'low', latencyMs: latency };
  } catch (err: any) {
    console.warn(`[classifier] Error: ${err.message}`);
    return { mode: null, confidence: 'low', latencyMs: Math.round(performance.now() - t0) };
  }
}
