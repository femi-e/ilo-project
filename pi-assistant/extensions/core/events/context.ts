// ============================================================================
// events/context.ts — before_agent_start handler
// ============================================================================
// Hybrid context injection:
//   - Tier 1: Universal rules (message — once, persistent)
//   - Tier 2+3: Mode rules + entity knowledge (systemPrompt — every turn)
//
// Guard check prevents duplicate message injection across turns and /reload.
// Budget-aware: respects ctx.getContextUsage() to avoid pushing over limits.
// ============================================================================

import type { ExtensionAPI, SessionManager } from '@earendil-works/pi-coding-agent';
import { buildContext, composeContextString, readConfig } from '../lib/context';
import { hasEngine } from '../lib/engine';
import { getDb } from '../lib/engine';
import { classify } from '../lib/classifier';
import { MODES, getCurrentMode, transitionTo, getAllowedTools } from '../lib/modes';
import type { ModeId } from '../lib/modes';

const UNIVERSAL_RULES_CUSTOM_TYPE = 'ailo-core';
const RULES_VERSION = 1; // Bump to force re-injection

// ── Universal rules text (Tier 1) ──────────────────────

const UNIVERSAL_RULES_TEXT = [
  '### Ailo — Core Behavior Rules',
  '',
  '- I have persistent long-term memory across sessions via a LadybugDB knowledge base.',
  '- I cite sources when making claims from stored beliefs.',
  '- I respect confidence labels: >0.80 = fact, 0.60-0.80 = likely, <0.60 = possible, <0.40 = not injected.',
  '- I never run destructive commands (rm -rf, DROP TABLE, etc.) without user confirmation.',
  '- I adapt my behavior based on what the user asks me to do — coding, teaching, planning, etc.',
  '',
  '---',
].join('\n');

// ── Guard check ─────────────────────────────────────────

/**
 * Check if the universal rules message already exists in the session.
 * Scans the session branch for our customType.
 */
function hasRulesMessage(sessionManager: SessionManager): boolean {
  try {
    const entries = sessionManager.getBranch();
    return entries.some(
      (e: any) => e.type === 'custom' && e.customType === UNIVERSAL_RULES_CUSTOM_TYPE
    );
  } catch {
    return false;
  }
}

// ── Config defaults (cached per-session) ────────────────

let configCache: Record<string, string> | null = null;

async function refreshConfigCache(): Promise<Record<string, string>> {
  try {
    const db = getDb();
    const rows = await db.query('MATCH (c:Config) RETURN c.key AS key, c.value AS value');
    configCache = {};
    for (const row of rows) {
      configCache[row.key] = row.value;
    }
  } catch {
    configCache = {};
  }
  return configCache!;
}

function getCachedConfig(key: string, defaultValue: string): string {
  return configCache?.[key] ?? defaultValue;
}

// ── Handler registration ───────────────────────────────

export function registerContextHooks(pi: ExtensionAPI): void {
  // Refresh config cache at session start
  pi.on('session_start', async () => {
    configCache = null; // Reset so it's fetched fresh on first before_agent_start
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (!hasEngine()) return; // DB not available — skip

    // Refresh config cache if needed
    if (!configCache) {
      await refreshConfigCache();
    }

    // ── PART A: Universal rules (Tier 1 — message, once, persistent) ──
    // Only inject on the first turn. Guard check prevents duplicates on /reload.
    if (!hasRulesMessage(ctx.sessionManager as any)) {
      const ctxStr = await buildDynamicContext(event, ctx);
      return {
        message: {
          customType: UNIVERSAL_RULES_CUSTOM_TYPE,
          content: UNIVERSAL_RULES_TEXT,
          display: true,
        },
        ...(ctxStr ? { systemPrompt: ctxStr } : {}),
      };
    }

    // ── PART B: Dynamic context (Tier 2+3 — systemPrompt, every turn) ──
    let systemPrompt = await buildDynamicContext(event, ctx);

    // ── PART C: Classify mode, gate tools, inject mode rules ──
    const classification = await classify(event.prompt || '');
    const mode = classification.mode || 'research'; // fallback to research
    transitionTo(mode);

    // Gate tools: block write/edit/bash in research and plan modes
    const gatedModes: ModeId[] = ['research', 'plan'];
    const allTools = pi.getActiveTools();
    const modeTools = getAllowedTools(mode);
    
    if (gatedModes.includes(mode) && modeTools.length > 0) {
      const filtered = allTools.filter((t: string) => !['write', 'edit', 'bash'].includes(t));
      pi.setActiveTools(filtered);
    }

    // Build mode rules text
    const modeConfig = MODES[mode];
    if (modeConfig) {
      const modeRules = [
        `## Current Mode: ${modeConfig.label}`,
        `${modeConfig.description}`,
        `Available tools: ${modeTools.join(', ')}`,
        ...modeConfig.promptRules,
        '',
        'Use the mode tool with action:"transition" to switch modes if needed.',
      ].join('\n');
      systemPrompt = systemPrompt 
        ? systemPrompt + '\n\n' + modeRules
        : modeRules;
    }

    if (systemPrompt) {
      return { systemPrompt };
    }
  });
}

// ── Dynamic context builder ────────────────────────────

async function buildDynamicContext(
  event: any,
  ctx: any
): Promise<string | undefined> {
  // Check context usage
  let ctxUsage: number | undefined;
  try {
    const usage = ctx.getContextUsage?.();
    if (usage && typeof usage === 'object' && 'tokens' in usage) {
      const maxTokens = parseInt(
        getCachedConfig('context.injection.max_chars', '2000'),
        10
      );
      ctxUsage = usage.tokens / (maxTokens * 4); // Rough estimate: 4 chars per token
    }
  } catch {
    // ctx.getContextUsage might not be available
  }

  // Build context blocks
  const blocks = await buildContext(event.prompt || '', {
    ctxUsage,
    systemPromptOptions: event.systemPromptOptions,
  });

  if (blocks.length === 0) return undefined;

  const contextString = composeContextString(blocks);

  // Append to the existing system prompt (don't replace)
  return event.systemPrompt + contextString;
}