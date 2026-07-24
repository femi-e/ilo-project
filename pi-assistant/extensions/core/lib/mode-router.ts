// ============================================================================
// lib/mode-router.ts — Per-mode model routing
// ============================================================================
// Decides which LLM provider/model to use based on the current mode.
// Supports: local (Ollama), fast-cloud (Haiku/GPT-4o-mini),
// reasoning-cloud (Sonnet/o3), different-provider (cross-check).
//
// Architecture:
//   ModeRouter.router(mode, health) → { provider, model, fallbacks }
//
// Health checks: local GPU utilization, cloud API rate limits.
// ============================================================================

import type { ModeId } from './modes';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type ModelTier = 'local' | 'fast-cloud' | 'reasoning-cloud' | 'different-provider';

export interface RouteResult {
  /** Provider name as understood by the system */
  provider: string;
  /** Model name/ID */
  model: string;
  /** Fallback chain if primary is unavailable */
  fallbacks: Array<{ provider: string; model: string }>;
  /** Human-readable description of the routing decision */
  reason: string;
}

export interface SystemHealth {
  localAvailable: boolean;
  localGpuUtilization: number;   // 0-100
  cloudAvailable: boolean;
  cloudRateLimitRemaining: number;
}

// ═══════════════════════════════════════════════════════════
// Model routing tables
// ═══════════════════════════════════════════════════════════

interface ModelRoute {
  tier: ModelTier;
  providers: Array<{
    name: string;
    model: string;
  }>;
  fallbacks: Array<{
    name: string;
    model: string;
    condition: 'always' | 'gpu-saturated' | 'cloud-rate-limited';
  }>;
}

/**
 * Route definitions per mode.
 * These map each mode's suggestedModel tier to concrete model names.
 * Configured for the user's setup (Windows + WSL + Docker + potential Ollama).
 */
const MODE_ROUTES: Record<ModeId, ModelRoute> = {
  research: {
    tier: 'local',
    providers: [
      { name: 'ollama', model: 'llama3.2:7b' },
    ],
    fallbacks: [
      { name: 'ollama', model: 'qwen2.5:7b', condition: 'gpu-saturated' },
      { name: 'anthropic', model: 'claude-3-haiku', condition: 'gpu-saturated' },
    ],
  },
  plan: {
    tier: 'reasoning-cloud',
    providers: [
      { name: 'anthropic', model: 'claude-sonnet-4-20250514' },
    ],
    fallbacks: [
      { name: 'openai', model: 'o3', condition: 'cloud-rate-limited' },
      { name: 'ollama', model: 'qwen2.5:32b', condition: 'always' },
    ],
  },
  execute: {
    tier: 'fast-cloud',
    providers: [
      { name: 'anthropic', model: 'claude-3-haiku' },
    ],
    fallbacks: [
      { name: 'openai', model: 'gpt-4o-mini', condition: 'cloud-rate-limited' },
      { name: 'ollama', model: 'codellama:13b', condition: 'gpu-saturated' },
    ],
  },
  review: {
    tier: 'different-provider',  // Different from execute to get fresh perspective
    providers: [
      { name: 'openai', model: 'gpt-4o-mini' },
    ],
    fallbacks: [
      { name: 'ollama', model: 'qwen2.5:13b', condition: 'cloud-rate-limited' },
    ],
  },
  tutoring: {
    tier: 'reasoning-cloud',
    providers: [
      { name: 'anthropic', model: 'claude-sonnet-4-20250514' },
    ],
    fallbacks: [
      { name: 'ollama', model: 'llama3.2:13b', condition: 'cloud-rate-limited' },
    ],
  },
  'job-hunt': {
    tier: 'reasoning-cloud',
    providers: [
      { name: 'anthropic', model: 'claude-sonnet-4-20250514' },
    ],
    fallbacks: [
      { name: 'openai', model: 'gpt-4o-mini', condition: 'cloud-rate-limited' },
    ],
  },
};

// ═══════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════

/**
 * Determine the best model for the given mode and system health.
 *
 * Routing logic:
 *   1. Try primary provider
 *   2. If unavailable, try fallbacks by condition
 *   3. If nothing works, return the primary anyway (best-effort)
 */
export function routeForMode(mode: ModeId, health: SystemHealth): RouteResult {
  const route = MODE_ROUTES[mode];
  if (!route) {
    return {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      fallbacks: [],
      reason: `no route for ${mode}, using default`,
    };
  }

  const primary = route.providers[0];

  // Primary available?
  if (isPrimaryAvailable(mode, health)) {
    return {
      provider: primary.name,
      model: primary.model,
      fallbacks: route.fallbacks.map(f => ({ provider: f.name, model: f.model })),
      reason: `${mode} → ${primary.name}/${primary.model} (primary)`,
    };
  }

  // Try fallbacks
  for (const fallback of route.fallbacks) {
    if (fallback.condition === 'always') {
      return {
        provider: fallback.name,
        model: fallback.model,
        fallbacks: route.fallbacks.filter(f => f !== fallback).map(f => ({ provider: f.name, model: f.model })),
        reason: `${mode} → ${fallback.name}/${fallback.model} (fallback: ${fallback.condition})`,
      };
    }
    if (fallback.condition === 'gpu-saturated' && health.localGpuUtilization > 85) {
      return {
        provider: fallback.name,
        model: fallback.model,
        fallbacks: [],
        reason: `${mode} → ${fallback.name}/${fallback.model} (GPU ${health.localGpuUtilization}%)`,
      };
    }
    if (fallback.condition === 'cloud-rate-limited' && !health.cloudAvailable) {
      return {
        provider: fallback.name,
        model: fallback.model,
        fallbacks: [],
        reason: `${mode} → ${fallback.name}/${fallback.model} (cloud degraded)`,
      };
    }
  }

  // Fallback to primary as last resort
  return {
    provider: primary.name,
    model: primary.model,
    fallbacks: route.fallbacks.map(f => ({ provider: f.name, model: f.model })),
    reason: `${mode} → ${primary.name}/${primary.model} (best-effort, health check failed)`,
  };
}

/**
 * Quick check: is the primary provider/model available for this mode?
 */
function isPrimaryAvailable(mode: ModeId, health: SystemHealth): boolean {
  const route = MODE_ROUTES[mode];
  if (!route) return true;

  const primary = route.providers[0];

  switch (primary.name) {
    case 'ollama':
      return health.localAvailable && health.localGpuUtilization < 90;
    case 'anthropic':
    case 'openai':
      return health.cloudAvailable && health.cloudRateLimitRemaining > 5;
    default:
      return health.cloudAvailable;
  }
}

/**
 * Get health info (sync stub — async checks happen at injection time).
 * In production, this pings Ollama and checks cloud API status.
 */
export function getDefaultHealth(): SystemHealth {
  return {
    localAvailable: false,     // Requires Ollama to be running
    localGpuUtilization: 0,
    cloudAvailable: true,
    cloudRateLimitRemaining: 100,
  };
}
