// ============================================================================
// lib/ilo-manager.ts — ILO + llama.cpp process lifecycle management
// ============================================================================
// Spawns the ILO Rust sidecar and the llama.cpp embedding server,
// monitors health, restarts on failure.
// ============================================================================

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { ilo } from './ilo-client';
import { EXT_VAR_DIR, LOCAL_EMBED_PORT } from './constants';

const STATE_KEY = '__ailo_ilo_manager__';

interface IloManagerState {
  iloProcess: ChildProcess | null;
  embedProcess: ChildProcess | null;
  startedAt: number;
  restartCount: number;
}

function getState(): IloManagerState {
  let state = (globalThis as any)[STATE_KEY];
  if (!state) {
    state = { iloProcess: null, embedProcess: null, startedAt: 0, restartCount: 0 };
    (globalThis as any)[STATE_KEY] = state;
  }
  return state;
}

// ── Config ────────────────────────────────────────────

const ILO_BINARY = process.env.ILO_BINARY || path.join(EXT_VAR_DIR, '..', 'mem-arch', 'target', 'release', 'ilo');
const ILO_PORT = process.env.ILO_PORT || '18090';
const ILO_DB_PATH = process.env.ILO_DB_PATH || path.join(EXT_VAR_DIR, 'ilo_data.lbug');
const ILO_MAX_UPTIME = process.env.ILO_MAX_UPTIME || '45';
const MAX_RESTARTS = 3;

const LLAMA_SERVER_BINARY = process.env.LLAMA_SERVER_BINARY || 'llama-server';
const EMBED_MODEL_PATH = process.env.EMBED_MODEL_PATH || path.join(EXTENSION_DIR, '..', 'models', 'embeddings', 'bge-base-en-v1.5-q8_0.gguf');

// ── API ───────────────────────────────────────────────

/** Start the ILO sidecar and the embedding server if not already running. */
export async function startIlo(): Promise<boolean> {
  const state = getState();
  let allOk = true;

  // ── Start embedding server ──
  const embedOk = await startEmbedServer();
  if (!embedOk) {
    console.warn('[ilo] Embedding server failed to start — vector search will be disabled');
    allOk = false;
  }

  // ── Start ILO sidecar ──
  // Verify binary exists
  if (!fs.existsSync(ILO_BINARY)) {
    console.error(`[ilo] binary not found at ${ILO_BINARY}`);
    console.error('[ilo] run: cd mem-arch && cargo build --release');
    return false;
  }

  if (state.iloProcess) {
    try {
      const res = await ilo.status();
      if (res.ok) return allOk;
    } catch {}
    stopIlo();
  }

  // Kill any stale ILO processes using PID file
  const pidFile = path.join(EXT_VAR_DIR, 'ilo.pid');
  try {
    const oldPid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
    try { process.kill(oldPid, 'SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  } catch {}

  // Remove stale socket (if using UDS still)
  const socketPath = path.join(EXT_VAR_DIR, 'ilo.sock');
  try { fs.unlinkSync(socketPath); } catch {}

  // Ensure var/ directory exists
  const varDir = path.dirname(ILO_DB_PATH);
  fs.mkdirSync(varDir, { recursive: true });

  // Spawn ILO
  const proc = spawn(ILO_BINARY, [], {
    env: {
      ...process.env,
      ILO_PORT,
      ILO_DB_PATH,
      ILO_MAX_UPTIME: '0',      // No max uptime — managed by pi instead
      RUST_LOG: process.env.RUST_LOG || 'info',
    },
    cwd: path.dirname(ILO_BINARY),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.iloProcess = proc;
  state.startedAt = Date.now();
  console.error('[ilo] starting sidecar...');

  proc.stdout?.on('data', (d) => process.stdout.write(`[ilo] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[ilo] ${d}`));

  // Write PID file
  try { fs.writeFileSync(pidFile, String(proc.pid)); } catch {}

  proc.on('exit', (code) => {
    console.error(`[ilo] process exited with code ${code}`);
    state.iloProcess = null;
    try { fs.unlinkSync(pidFile); } catch {}
    if (state.restartCount < MAX_RESTARTS) {
      state.restartCount++;
      console.error(`[ilo] restarting (${state.restartCount}/${MAX_RESTARTS})...`);
      setTimeout(() => startIlo(), 1000);
    }
  });

  // Wait for health check — poll fast (100ms interval, 3s max)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await ilo.status();
      if (res.ok) {
        console.error(`[ilo] started successfully (PID ${proc.pid})`);
        return allOk;
      }
    } catch {}
  }

  console.error('[ilo] failed to start within 3 seconds');
  return false;
}

/** Start the llama.cpp embedding server on port 1235. */
async function startEmbedServer(): Promise<boolean> {
  // Check if it's already running
  try {
    const res = await fetch(`http://127.0.0.1:${LOCAL_EMBED_PORT}/`);
    if (res.ok) {
      console.error(`[embed] Server already running on :${LOCAL_EMBED_PORT}`);
      return true;
    }
  } catch {}

  if (!fs.existsSync(EMBED_MODEL_PATH)) {
    console.error(`[embed] Embedding model not found at ${EMBED_MODEL_PATH}`);
    console.error('[embed] Download: curl -sL -o ~/models/embeddings/bge-base-en-v1.5-q8_0.gguf https://huggingface.co/CompendiumLabs/bge-base-en-v1.5-gguf/resolve/main/bge-base-en-v1.5-q8_0.gguf');
    return false;
  }

  const state = getState();

  const proc = spawn(LLAMA_SERVER_BINARY, [
    '--port', String(LOCAL_EMBED_PORT),
    '--host', '127.0.0.1',
    '--embeddings',
    '--pooling', 'mean',
    '--model', EMBED_MODEL_PATH,
    '--ctx-size', '512',
    '--n-gpu-layers', '99',
  ], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.embedProcess = proc;
  console.error(`[embed] starting llama-server (${EMBED_MODEL_PATH}) on :${LOCAL_EMBED_PORT}...`);

  proc.stdout?.on('data', (d) => process.stdout.write(`[embed] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[embed] ${d}`));

  proc.on('exit', (code) => {
    console.error(`[embed] process exited with code ${code}`);
    state.embedProcess = null;
  });

  // Wait for health check
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${LOCAL_EMBED_PORT}/`);
      if (res.ok) {
        console.error(`[embed] started successfully`);
        return true;
      }
    } catch {}
  }

  console.error(`[embed] failed to start within 10 seconds`);
  return false;
}

/** Stop the ILO sidecar and embedding server gracefully. */
export function stopIlo(): void {
  const state = getState();

  // Stop embedding server
  if (state.embedProcess) {
    state.embedProcess.kill('SIGTERM');
    setTimeout(() => {
      if (state.embedProcess) state.embedProcess.kill('SIGKILL');
    }, 5000);
    state.embedProcess = null;
  }

  // Stop ILO
  if (state.iloProcess) {
    state.iloProcess.kill('SIGTERM');
    setTimeout(() => {
      if (state.iloProcess) state.iloProcess.kill('SIGKILL');
    }, 5000);
    state.iloProcess = null;
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

/** Check if the embedding server is responding. */
export async function isEmbedHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${LOCAL_EMBED_PORT}/`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the ILO sidecar is running and responsive.
 * Call before any ILO API operation from event hooks.
 */
export async function ensureIlo(): Promise<boolean> {
  const state = getState();

  if (state.iloProcess) {
    const healthy = await isIloHealthy();
    if (healthy) return true;
    console.error('[ilo] process died, restarting...');
    state.iloProcess = null;
  } else {
    const healthy = await isIloHealthy();
    if (healthy) return true;
  }

  return startIlo();
}

/** Restart ILO. */
export async function restartIlo(): Promise<boolean> {
  stopIlo();
  await new Promise((r) => setTimeout(r, 1000));
  return startIlo();
}
