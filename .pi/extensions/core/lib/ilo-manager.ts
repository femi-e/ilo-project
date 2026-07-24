// ============================================================================
// lib/ilo-manager.ts — ILO process lifecycle management
// ============================================================================
// Spawns the ILO Rust sidecar, monitors health, restarts on failure.
// Designed to run as part of the pi extension's session_start.
// ============================================================================

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ilo } from './ilo-client';
import { EXT_VAR_DIR } from './constants';

const STATE_KEY = '__ailo_ilo_manager__';

interface IloManagerState {
  process: ChildProcess | null;
  startedAt: number;
  restartCount: number;
}

function getState(): IloManagerState {
  let state = (globalThis as any)[STATE_KEY];
  if (!state) {
    state = { process: null, startedAt: 0, restartCount: 0 };
    (globalThis as any)[STATE_KEY] = state;
  }
  return state;
}

// ── Config ────────────────────────────────────────────

const ILO_BINARY = process.env.ILO_BINARY || path.join(EXT_VAR_DIR, '..', 'mem-arch', 'target', 'debug', 'mem-arch');
const ILO_SOCKET = process.env.ILO_SOCKET || path.join(EXT_VAR_DIR, 'ilo.sock');
const ILO_DB_PATH = process.env.ILO_DB_PATH || path.join(EXT_VAR_DIR, 'ilo_data.lbug');
const ILO_MAX_UPTIME = process.env.ILO_MAX_UPTIME || '45';
const MAX_RESTARTS = 3;
const HEALTH_CHECK_INTERVAL = 5000; // ms

// ── API ───────────────────────────────────────────────

/** Start the ILO sidecar if not already running. */
export async function startIlo(): Promise<boolean> {
  const state = getState();
  if (state.process) {
    // Check if it's still alive
    try {
      const res = await ilo.status();
      if (res.ok) return true;
    } catch {}
    // Dead process — clean up
    stopIlo();
  }

  // Ensure var/ directory exists
  const varDir = path.dirname(ILO_DB_PATH);
  fs.mkdirSync(varDir, { recursive: true });

  // Spawn ILO
  const proc = spawn(ILO_BINARY, [], {
    env: {
      ...process.env,
      ILO_SOCKET,
      ILO_DB_PATH,
      ILO_MAX_UPTIME,
      RUST_LOG: process.env.RUST_LOG || 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.process = proc;
  state.startedAt = Date.now();

  proc.stdout?.on('data', (d) => process.stdout.write(`[ilo] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[ilo] ${d}`));

  proc.on('exit', (code) => {
    console.error(`[ilo] process exited with code ${code}`);
    state.process = null;
    // Auto-restart if under limit
    if (state.restartCount < MAX_RESTARTS) {
      state.restartCount++;
      console.error(`[ilo] restarting (${state.restartCount}/${MAX_RESTARTS})...`);
      setTimeout(() => startIlo(), 1000);
    }
  });

  // Wait for health check
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await ilo.status();
      if (res.ok) {
        console.error(`[ilo] started successfully (PID ${proc.pid})`);
        return true;
      }
    } catch {}
  }

  console.error('[ilo] failed to start within 10 seconds');
  return false;
}

/** Stop the ILO sidecar gracefully. */
export function stopIlo(): void {
  const state = getState();
  if (state.process) {
    state.process.kill('SIGTERM');
    // Force kill after 5 seconds
    setTimeout(() => {
      if (state.process) state.process.kill('SIGKILL');
    }, 5000);
    state.process = null;
  }
}

/** Check if ILO is responding. */
export async function isIloHealthy(): Promise<boolean> {
  try {
    const res = await ilo.status();
    return res.ok && res.data?.status === 'ok';
  } catch {
    return false;
  }
}

/** Restart ILO. */
export async function restartIlo(): Promise<boolean> {
  stopIlo();
  await new Promise((r) => setTimeout(r, 1000));
  return startIlo();
}
