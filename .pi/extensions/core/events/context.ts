import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ilo } from '../lib/ilo-client';
import { ensureIlo } from '../lib/ilo-manager';
import { getState } from './turn';

const SYSTEM_PROMPT = `# Identity

You are a collaborative personal assistant with persistent memory. Your role is to help the user think clearly, track what matters, and build knowledge over time. You don't make decisions for them — you help them understand what they want, explore options, and reach their own conclusions. You're proactive about surfacing relevant information, but collaborative about every next step.

# Personality
- Curious, not presumptuous. Ask questions before assuming. Explore before committing.
- Proactive, not pushy. Offer information and surface connections, but let the user steer.
- Collaborative, not directive. Work with the user, not for them.
- Patient. If something is unclear, dig deeper rather than guessing.
- Honest about uncertainty. If you don't know, say so. If you're not sure what they mean, ask.

# Memory System
You have persistent memory stored as entities (people, projects, topics, tasks, tools) and claims (relationships between entities). Memory survives across sessions.

Memory tools:
- \`memory_search\` — Find entities, claims, and past conversations.
- \`memory_store\` — Explicitly save an important fact or insight.
- \`entity_lookup\` — Get full details on a specific entity.
- \`entity_connect\` — Link two related concepts.

# Two-Phase Execution
Every request follows this pattern:

**Phase 1: Understand.** Before taking action, call \`context_rebuild\` with your analysis. Include what the task requires, which entities are relevant, and what past context might help. Score each piece of context for relevance. Extract any entities or relationships you identify.

**Phase 2: Collaborate.** After context is rebuilt, work through the task together with the user.

# Context Window
The context window is managed automatically. Old or irrelevant context is evicted to keep you focused. Memory entries compete with conversation turns for space. If you need information from earlier, use \`memory_search\`. Entities and claims survive eviction.

# Working Style
- When the user introduces something new, store it.
- When the user expresses a preference or makes a decision, note it.
- Keep track of ongoing threads and tasks — surface them when relevant.
- If something is ambiguous, ask. Don't guess.
- If the user seems unsure, help them explore. Don't rush to a solution.
- Use web search when you need current information the user hasn't provided.`;

let SYSTEM_INJECTED = false;
const PHASE_KEY = '__ilo_phase__';

type Phase = 'gated' | 'execution';

function getPhase(): Phase {
  return ((globalThis as any)[PHASE_KEY] as Phase) || 'gated';
}

function setPhase(p: Phase): void {
  (globalThis as any)[PHASE_KEY] = p;
}

/// Build a dashboard showing the model what's in its context window.
function buildDashboard(messages: any[], tokenEstimate: number): string {
  const budget = 80000;
  const pct = Math.min(100, Math.round((tokenEstimate / budget) * 100));
  const lines = [`## Context Dashboard`, `Window: ~${tokenEstimate} / ${budget} tokens (${pct}%)`, '', 'Chunks:'];

  for (const msg of messages) {
    const id = msg.id?.slice(-8) || '?';
    const role = msg.role || '?';
    const ctype = msg.customType || role;
    lines.push(`  [${id}]  ${ctype}`);
  }

  return lines.join('\n');
}

/// Estimate tokens from a messages array.
function estimateTokens(messages: any[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === 'string') total += content.length;
    else if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.text) total += item.text.length;
      }
    }
  }
  return Math.round(total / 4);
}

export function registerContextHooks(pi: ExtensionAPI): void {
  pi.on('session_start', () => {
    SYSTEM_INJECTED = false;
    setPhase('gated');
  });

  pi.on('context', async (event: any, ctx: any) => {
    const state = getState();
    const phase = getPhase();
    const messages = event.messages;
    if (!messages || messages.length === 0) return;

    // Inject system prompt once
    if (!SYSTEM_INJECTED) {
      SYSTEM_INJECTED = true;
    }

    // Phase 1: Gated — only context_rebuild available
    if (phase === 'gated') {
      try {
        pi.setActiveTools(['context_rebuild']);
      } catch (e) {
        console.warn('[context] gating failed:', e);
      }
    }

    // Phase 2: Execution — full tools available
    if (phase === 'execution') {
      // Full tools are already active, no need to change
      // The phase resets to 'gated' after each turn_end
    }

    // Build and inject dashboard for all phases
    try {
      const tokenEstimate = estimateTokens(messages);
      const dashboard = buildDashboard(messages, tokenEstimate);
      // Prepend dashboard to the last user message
      const lastUserIdx = messages.length - 1;
      if (messages[lastUserIdx]?.role === 'user') {
        const existing = messages[lastUserIdx].content;
        if (typeof existing === 'string') {
          messages[lastUserIdx].content = `${dashboard}\n\n${existing}`;
        } else if (Array.isArray(existing) && existing[0]?.text) {
          existing[0].text = `${dashboard}\n\n${existing[0].text}`;
        }
      }
    } catch (e) {
      console.warn('[context] dashboard build failed:', e);
    }

    return { messages };
  });

  pi.on('before_agent_start', async (event: any, _ctx: any) => {
    if (!SYSTEM_INJECTED) {
      SYSTEM_INJECTED = true;
      return {
        systemPrompt: event.systemPrompt
          ? `${event.systemPrompt}\n\n${SYSTEM_PROMPT}`
          : SYSTEM_PROMPT,
      };
    }
  });

  // Convert custom 'memory' role to 'system' at the provider boundary
  pi.on('before_provider_request', (event: any, _ctx: any) => {
    const payload = event.payload;
    if (!payload?.messages) return;
    for (const msg of payload.messages) {
      if (msg.role === 'memory') {
        msg.role = 'system';
        if (msg.content && !msg.content.startsWith('[Memory Context]')) {
          msg.content = `[Memory Context]
${msg.content}`;
        }
      }
    }
    return payload;
  });
}

export { setPhase, getPhase };
