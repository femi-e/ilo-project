// ============================================================================
// lib/engine.ts — Singleton accessor for the database and session state
// ============================================================================
// Provides a global getter that survives Pi /reload.
// Phase 2b modules (context.ts, turn.ts, etc.) import this to access the DB.
// ============================================================================

import type { DbLayer } from './db';

const ENGINE_KEY = '__ailo_engine__';

export interface EngineState {
  db: DbLayer;
  sessionId: string;
}

export function setEngineState(state: EngineState | null): void {
  (globalThis as any)[ENGINE_KEY] = state;
}

export function getEngineState(): EngineState | null {
  return (globalThis as any)[ENGINE_KEY] ?? null;
}

export function getDb(): DbLayer {
  const state = getEngineState();
  if (!state?.db) throw new Error('[engine] Database not available');
  return state.db;
}

export function getSessionId(): string {
  const state = getEngineState();
  if (!state) throw new Error('[engine] Engine not initialised');
  return state.sessionId;
}

export function hasEngine(): boolean {
  return getEngineState() !== null;
}