// ============================================================================
// lib/engine.ts — Minimal engine singleton (ILO-powered)
// ============================================================================
// Previously managed direct LadybugDB access. Now ILO handles all DB operations.
// This file provides only the session ID and a flag to check if ILO is available.
// ============================================================================

const ENGINE_KEY = '__ailo_engine__';

export interface EngineState {
  sessionId: string;
}

export function setEngineState(state: EngineState | null): void {
  (globalThis as any)[ENGINE_KEY] = state;
}

export function getEngineState(): EngineState | null {
  return (globalThis as any)[ENGINE_KEY] ?? null;
}

/** @deprecated Use ILO directly — this always returns null. */
export function getDb(): null {
  return null;
}

export function getSessionId(): string {
  const state = getEngineState();
  if (!state) throw new Error('[engine] Engine not initialised');
  return state.sessionId;
}

export function hasEngine(): boolean {
  return getEngineState() !== null;
}
