// ============================================================================
// lib/modes.ts — Mode definitions, state machine, detection, transitions
// ============================================================================
// Every turn, the system detects which mode Ailo should be in based on:
//   1. User prompt keywords
//   2. Last tool called / last action taken
//   3. Mode exit signals (phrases that indicate a transition)
//   4. Explicit mode tool calls from the LLM
//
// Modes gate tool availability via pi.setActiveTools() and control which
// LLM/provider is used for inference.
// ============================================================================

import type { DbLayer } from './db';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type ModeId =
  | 'research'
  | 'plan'
  | 'execute'
  | 'review'
  | 'tutoring'
  | 'job-hunt';

/** Ail o's built-in tool names (registered by this extension) */
type AiloTool =
  | 'store' | 'forget' | 'search' | 'ingest'
  | 'web' | 'scrape' | 'crawl'
  | 'task' | 'config' | 'diagnostics' | 'health'
  | 'read_cached' | 'cache_invalidate' | 'cache_stats';

/** Pi's built-in tool names */
type PiTool = 'read' | 'write' | 'edit' | 'bash' | 'grep' | 'ls' | 'find';

/** How strictly this mode is enforced */
type EnforceLevel = 'strict' | 'suggest' | 'off';

export interface ModeConfig {
  id: ModeId;
  label: string;
  description: string;

  /** Tool whitelist: only these tools are available */
  allowedTools: Array<AiloTool | PiTool>;

  /** Behavior rules injected into the system prompt */
  promptRules: string[];

  /** Keywords that trigger entry into this mode */
  entrySignals: RegExp[];

  /** Phrases/patterns that signal "done with this mode, ready to transition" */
  exitSignals: RegExp[];

  /** If strict: setActiveTools() enforces the whitelist.
   *  If suggest: rules are injected but tools are not gated.
   *  If off: mode is detected but has no effect. */
  enforce: EnforceLevel;

  /** Suggested model routing for this mode (configured elsewhere) */
  suggestedModel?: 'local' | 'fast-cloud' | 'reasoning-cloud' | 'different-provider';

  /** Entity name in the DB for stored beliefs about this mode */
  dbEntityName: string;
}

// ═══════════════════════════════════════════════════════════
// Mode definitions
// ═══════════════════════════════════════════════════════════

export const MODES: Record<ModeId, ModeConfig> = {
  research: {
    id: 'research',
    label: 'Research',
    description: 'Gather information, read docs, search web. No code changes.',
    allowedTools: [
      'read', 'read_cached', 'cache_stats',
      'web', 'scrape', 'crawl', 'search',
      'store', 'ingest', 'config',
    ],
    promptRules: [
      'RESEARCH MODE: You are gathering information. Do NOT write, edit, or execute any code.',
      'Use web/scrape/crawl to find information from external sources.',
      'Use search to look up stored knowledge.',
      'Use store to save important findings.',
      'When you understand the topic well enough, signal completion with: "I now understand the topic."',
    ],
    entrySignals: [
      /\b(research|investigate|look\s+up|find\s+out|what\s+is|how\s+does|understand|learn\s+about)\b/i,
      /\b(check\s+the\s+docs|read\s+the\s+(docs|documentation)|explore)\b/i,
    ],
    exitSignals: [
      /\b(i\s+understand|the\s+approach\s+is|now\s+I\s+know|ready\s+to\s+plan)\b/i,
    ],
    enforce: 'strict',
    suggestedModel: 'local',
    dbEntityName: 'ailo:mode:research',
  },

  plan: {
    id: 'plan',
    label: 'Plan',
    description: 'Design architecture, consider trade-offs, create task list. No code execution.',
    allowedTools: [
      'read', 'read_cached', 'cache_stats',
      'search', 'store',
      'task', 'config', 'web',
    ],
    promptRules: [
      'PLAN MODE: You are designing a plan. Do NOT write, edit, or execute any code.',
      'List at least two alternatives with pros and cons before choosing.',
      'Use task tool to create actionable, ordered steps.',
      'Each task should reference specific files and expected changes.',
      'Identify risks, unknowns, and dependencies explicitly.',
      'When the plan is ready for approval, signal with: "Plan ready for review."',
    ],
    entrySignals: [
      /\b(plan|design|architecture|approach|strategy|how\s+should|trade.?off|decide)\b/i,
      /\b(let'?s\s+(think|design|plan)|what'?s\s+the\s+(best|approach))\b/i,
    ],
    exitSignals: [
      /\b(go\s+ahead|implement|build\s+it|proceed|execute|start\s+coding)\b/i,
      /\b(review\s+(this|the\s+plan)|plan\s+ready|approved)\b/i,
    ],
    enforce: 'strict',
    suggestedModel: 'reasoning-cloud',
    dbEntityName: 'ailo:mode:plan',
  },

  execute: {
    id: 'execute',
    label: 'Execute',
    description: 'Write code, edit files, run commands. Implement the plan.',
    allowedTools: [
      'read', 'read_cached', 'cache_invalidate', 'cache_stats',
      'write', 'edit', 'bash',
      'search', 'store', 'task', 'config',
      'diagnostics', 'health',
    ],
    promptRules: [
      'EXECUTE MODE: You are implementing code. Follow the agreed plan step by step.',
      'Validate each change before moving to the next (type-check, lint, test).',
      'Use cache_invalidate after any edit() or write() to keep reads fresh.',
      'Commit working changes before attempting risky modifications.',
      'If you encounter a blocker, explain it — do not work around it silently.',
      'When implementation is complete, signal with: "Implementation complete."',
    ],
    entrySignals: [
      /\b(implement|build|create|write\s+(code|the)|code\s+(it|this))\b/i,
      /\b(let'?s\s+(build|code|implement|make)|start\s+(working|coding))\b/i,
    ],
    exitSignals: [
      /\b(review|check|test\s+(what|this)|verify|done|complete)\b/i,
      /\b(ready\s+for\s+review|implementation\s+complete|finished)\b/i,
    ],
    enforce: 'strict',
    suggestedModel: 'fast-cloud',
    dbEntityName: 'ailo:mode:execute',
  },

  review: {
    id: 'review',
    label: 'Review',
    description: 'Inspect code, suggest improvements, identify issues. No modifications.',
    allowedTools: [
      'read', 'read_cached', 'cache_stats',
      'search', 'store', 'config',
      'diagnostics', 'health',
    ],
    promptRules: [
      'REVIEW MODE: You are reviewing existing work. Do NOT write, edit, or execute any code.',
      'Identify bugs, security issues, style violations, and deviations from the plan.',
      'Be specific: mention exact file paths, line numbers, and recommended fixes.',
      'Check: type safety, error handling, edge cases, test coverage, documentation.',
      'When review is complete, signal with: "Review complete."',
    ],
    entrySignals: [
      /\b(review|audit|check\s+(this|my|the)|inspect|look\s+(at|over))\b/i,
      /\b(what\s+do\s+you\s+think|feedback|critique|verify)\b/i,
    ],
    exitSignals: [
      /\b(fix\s+(it|this)|go\s+ahead|implement\s+(the\s+)?(fix|change))\b/i,
    ],
    enforce: 'strict',
    suggestedModel: 'different-provider',
    dbEntityName: 'ailo:mode:review',
  },

  tutoring: {
    id: 'tutoring',
    label: 'Tutoring',
    description: 'Help with course material using Socratic method.',
    allowedTools: [
      'read', 'read_cached', 'cache_stats',
      'search', 'store', 'web', 'scrape', 'crawl',
    ],
    promptRules: [
      'TUTORING MODE: You are a tutor. NEVER give direct answers or write code for the user.',
      'Ask what the user already knows about the topic before explaining.',
      'Reference course material by module: "Module 2.1 covers this — how does it apply here?"',
      'If the user asks "just write it for me," say: "Let us work through it together."',
      'Validate understanding before advancing to harder topics.',
      'For assignments: provide skeleton structure ONLY — section headings, guiding questions.',
    ],
    entrySignals: [
      /\b(tutor|teach|learn|explain|module|course|assignment|study|homework)\b/i,
      /\b(LSE|DA301|data\s+analytics|python|lesson)\b/i,
    ],
    exitSignals: [],  // Stays in tutoring mode for the session
    enforce: 'suggest',  // Tutoring is persuasive, not restrictive
    suggestedModel: 'reasoning-cloud',
    dbEntityName: 'ailo:mode:tutoring',
  },

  'job-hunt': {
    id: 'job-hunt',
    label: 'Job Hunt',
    description: 'CV, cover letters, job search, interview prep.',
    allowedTools: [
      'read', 'read_cached', 'cache_stats',
      'search', 'store', 'web', 'scrape', 'crawl',
      'task', 'config',
    ],
    promptRules: [
      'JOB HUNT MODE: You are helping with job applications.',
      'CV building: interactive guided Q&A, never templates. Ask one section at a time.',
      'Cover letters: co-author by asking about the user experience. Never write for them.',
      'Saved criteria: Data Analyst, Hospitality industry, min £32k.',
      'Role finding: search when asked. Use the saved criteria.',
      'Help articulate experience in their own words. Suggest structure (STAR format).',
    ],
    entrySignals: [
      /\b(job|CV|cover\s+letter|recruiter|career|apply|interview|resume)\b/i,
      /\b(hiring|salary|role|position|application|data\s+analyst)\b/i,
    ],
    exitSignals: [],  // Stays in job-hunt mode for the session
    enforce: 'suggest',
    suggestedModel: 'reasoning-cloud',
    dbEntityName: 'ailo:mode:job-hunt',
  },
};

// ═══════════════════════════════════════════════════════════
// Mode state (in-memory, per-session)
// ═══════════════════════════════════════════════════════════

const STATE_KEY = '__ailo_mode_state__';

interface ModeState {
  /** The current active mode */
  currentMode: ModeId;
  /** Previous mode (for rollback) */
  previousMode: ModeId | null;
  /** How many consecutive turns we've been in this mode */
  turnCount: number;
  /** Last tool that was called (for transition detection) */
  lastToolCalled: string | null;
  /** User-requested mode override (from tool call) */
  override: ModeId | null;
}

function getState(): ModeState {
  let state = (globalThis as any)[STATE_KEY];
  if (!state) {
    state = {
      currentMode: 'research',  // Default starting mode
      previousMode: null,
      turnCount: 0,
      lastToolCalled: null,
      override: null,
    };
    (globalThis as any)[STATE_KEY] = state;
  }
  return state;
}

export function resetModeState(): void {
  (globalThis as any)[STATE_KEY] = undefined;
}

/**
 * Get the current active mode.
 */
export function getCurrentMode(): ModeId {
  return getState().currentMode;
}

/**
 * Set the last tool that was called (used for transition detection).
 */
export function setLastToolCalled(toolName: string): void {
  getState().lastToolCalled = toolName;
}

/**
 * Set a user-requested mode override.
 */
export function setModeOverride(mode: ModeId | null): void {
  getState().override = mode;
}

/**
 * Explicitly transition to a new mode.
 */
export function transitionTo(mode: ModeId): void {
  const state = getState();
  state.previousMode = state.currentMode;
  state.currentMode = mode;
  state.turnCount = 0;
}

// ═══════════════════════════════════════════════════════════
// Mode detection
// ═══════════════════════════════════════════════════════════

export interface DetectionResult {
  mode: ModeId;
  confidence: number;
  reason: string;
}

/**
 * Detect the appropriate mode from the current conversation context.
 * Uses multiple signals in priority order:
 *   1. Explicit override (from tool call)
 *   2. Exit signals from current mode + entry signals for next
 *   3. Last tool called (e.g., after write → suggest review)
 *   4. Keyword matching on user prompt
 *   5. Semantic fallback
 */
export function detectMode(userPrompt: string): DetectionResult {
  const state = getState();

  // Priority 1: Explicit override
  if (state.override) {
    const mode = state.override;
    state.override = null;
    return { mode, confidence: 1.0, reason: 'explicit override' };
  }

  const currentMode = MODES[state.currentMode];

  // Priority 2: Check exit signals from current mode
  const hasExitSignal = currentMode.exitSignals.some(r => r.test(userPrompt));
  if (hasExitSignal) {
    // Find the best next mode
    for (const [id, config] of Object.entries(MODES)) {
      if (id === state.currentMode) continue;
      const hasEntry = config.entrySignals.some(r => r.test(userPrompt));
      if (hasEntry) {
        return { mode: id as ModeId, confidence: 0.85, reason: `exit signal + entry signal: ${id}` };
      }
    }
    // No matching entry signal — stay in current mode but note the exit signal
    return { mode: state.currentMode, confidence: 0.7, reason: 'exit signal detected, no clear next mode' };
  }

  // Priority 3: Last tool called suggests a mode transition
  if (state.lastToolCalled) {
    const toolTransitions: Record<string, ModeId> = {
      'write': 'review',
      'edit': 'review',
      'bash': 'execute',
      'web': 'research',
      'scrape': 'research',
      'crawl': 'research',
    };
    const suggested = toolTransitions[state.lastToolCalled];
    if (suggested && suggested !== state.currentMode && state.turnCount > 1) {
      return { mode: suggested, confidence: 0.65, reason: `tool-based transition: ${state.lastToolCalled} → ${suggested}` };
    }
  }

  // Priority 4: Keyword matching
  const scores: Record<string, number> = {};
  for (const [id, config] of Object.entries(MODES)) {
    if (id === state.currentMode) continue; // Prefer staying in current mode
    for (const signal of config.entrySignals) {
      if (signal.test(userPrompt)) {
        scores[id] = (scores[id] || 0) + 1;
      }
    }
  }

  if (Object.keys(scores).length > 0) {
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    if (best[1] >= 1) {
      return { mode: best[0] as ModeId, confidence: 0.75, reason: `keyword match: ${best[0]}` };
    }
  }

  // Priority 5: Stay in current mode
  return { mode: state.currentMode, confidence: 0.5, reason: 'no clear signal, staying in current mode' };
}

// ═══════════════════════════════════════════════════════════
// Tool whitelist resolution
// ═══════════════════════════════════════════════════════════

/**
 * Get the set of allowed tools for a given mode.
 * Respects enforce level — if 'off', returns all tools (no gating).
 * If 'suggest', returns all tools but includes prompt rules only.
 */
export function getAllowedTools(mode: ModeId): string[] {
  const config = MODES[mode];
  if (config.enforce === 'off') {
    return [];  // Empty = all tools (pi doesn't restrict)
  }
  return config.allowedTools;
}

/**
 * Check if a tool is allowed in the current mode.
 */
export function isToolAllowed(toolName: string, mode?: ModeId): boolean {
  const m = mode ?? getState().currentMode;
  const config = MODES[m];
  if (config.enforce !== 'strict') return true;  // Only strict mode gates tools
  return config.allowedTools.includes(toolName as any);
}

// ═══════════════════════════════════════════════════════════
// DB seeding (idempotent)
// ═══════════════════════════════════════════════════════════

import * as crypto from 'node:crypto';

/**
 * Seed mode entities into the DB as structured nodes.
 * Each mode gets an Entity node with type='behavior' and
 * attached Belief nodes for the rules.
 */
export async function seedModeEntities(db: DbLayer): Promise<void> {
  for (const config of Object.values(MODES)) {
    const name = config.dbEntityName;

    // Check if this mode entity already exists
    const existing = await db.query(
      'MATCH (e:Entity {name: $name}) RETURN e.name LIMIT 1',
      { name }
    );
    if (existing.length > 0) continue;

    // Create entity node with structured data
    const entityId = await db.addNode('Entity', {
      name,
      type: 'behavior',
      confidence: 1.0,
      mention_count: 0,
      momentum: 0,
      aliases: `${config.id}, ${config.label.toLowerCase()}`,
      created_at: new Date().toISOString(),
    });

    // Create the mode's behavior rules as belief nodes
    for (const rule of config.promptRules) {
      const beliefId = await db.addNode('Belief', {
        content: rule,
        confidence: 0.95,
        entity: name,
        provenance: 'system.bootstrap',
        last_referenced: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });

      await db.addEdge('Entity', 'id', entityId, 'Belief', 'id', beliefId, 'HAS_BELIEF');
    }
  }
}
