// ============================================================================
// lib/ilo-manager.ts — ILO + llama.cpp process lifecycle management
// ============================================================================
// Spawns the ILO Rust sidecar, llama.cpp embedding server, and optionally
// a llama.cpp chat server. The chat server auto-stops after 5 minutes
// if the user hasn't selected a local model in pi.
// ============================================================================

import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ilo } from './ilo-client';
import { EXTENSION_DIR, EXT_VAR_DIR, LOCAL_EMBED_PORT, LOCAL_CHAT_PORT_START } from './constants';

const STATE_KEY = '__ailo_ilo_manager__';

interface IloManagerState {
  iloProcess: ChildProcess | null;
  embedProcess: ChildProcess | null;
  chatProcess: ChildProcess | null;
  startedAt: number;
  restartCount: number;
  chatIdleTimer: ReturnType<typeof setTimeout> | null;
  /** Provider names registered with pi for each server type. Unregistered on stop. */
  registeredProviders: { embed: string[]; chat: string[] };
  /** Callback set by index.ts to unregister providers via pi.unregisterProvider(). */
  unregisterProvider: ((name: string) => void) | null;
}

function getState(): IloManagerState {
  let state = (globalThis as any)[STATE_KEY];
  if (!state) {
    state = { iloProcess: null, embedProcess: null, chatProcess: null, startedAt: 0, restartCount: 0, chatIdleTimer: null, registeredProviders: { embed: [], chat: [] }, unregisterProvider: null };
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
const EMBED_MODEL_PATH = process.env.EMBED_MODEL_PATH || path.join(os.homedir(), 'models', 'embeddings', 'bge-base-en-v1.5-q8_0.gguf');

/** GGUF model to use for the chat server. Set env LLAMA_CHAT_MODEL to override. */
const CHAT_MODEL_PATH = process.env.LLAMA_CHAT_MODEL || '';

/** How long to wait (ms) before stopping the chat server if the local model isn't selected. */
const CHAT_IDLE_TIMEOUT = parseInt(process.env.LOCAL_CHAT_IDLE_TIMEOUT || '300000', 10); // 5 min default

// ── Provider registration tracking ───────────────────

/**
 * Register providers that pi knows about, keyed by server type.
 * Embed providers are on port 1235; chat providers on ports 1234, 1236-1240.
 * These are unregistered automatically when the corresponding server stops.
 */
export function setRegisteredProviders(providers: { embed: string[]; chat: string[] }): void {
  getState().registeredProviders = providers;
}

/** Set the callback to unregister a provider from pi. Called from index.ts. */
export function setUnregisterProviderCallback(cb: (name: string) => void): void {
  getState().unregisterProvider = cb;
}

function unregisterProviders(types: ('embed' | 'chat')[]): void {
  const state = getState();
  if (!state.unregisterProvider) return;
  for (const t of types) {
    for (const name of state.registeredProviders[t]) {
      try {
        state.unregisterProvider(name);
        console.error(`[ilo] Unregistered provider "${name}" (${t})`);
      } catch (err) {
        console.error(`[ilo] Failed to unregister provider "${name}":`, err);
      }
    }
    state.registeredProviders[t] = [];
  }
}

// ── API ───────────────────────────────────────────────

/** Start the ILO sidecar, embedding server, and chat server. */
export async function startIlo(): Promise<boolean> {
  const state = getState();
  let allOk = true;

  // ── Start embedding server ──
  const embedOk = await startEmbedServer();
  if (!embedOk) {
    console.warn('[ilo] Embedding server failed to start — vector search will be disabled');
    allOk = false;
  }

  // ── Start chat server (best-effort, requires CHAT_MODEL_PATH) ──
  if (CHAT_MODEL_PATH) {
    const chatOk = await startChatServer();
    if (!chatOk) {
      console.warn('[ilo] Chat server failed to start — local inference unavailable');
    }
  } else {
    console.warn('[ilo] No chat model configured — set LLAMA_CHAT_MODEL to auto-start a local LLM');
    console.warn('[ilo] Example: LLAMA_CHAT_MODEL=~/models/qwen3.5-9b.gguf pi');
  }

  // ── Start ILO sidecar ──
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

  const pidFile = path.join(EXT_VAR_DIR, 'ilo.pid');
  try {
    const oldPid = parseInt(fs.readFileSync(pidFile, 'utf-8'), 10);
    try { process.kill(oldPid, 'SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  } catch {}

  const socketPath = path.join(EXT_VAR_DIR, 'ilo.sock');
  try { fs.unlinkSync(socketPath); } catch {}

  const varDir = path.dirname(ILO_DB_PATH);
  fs.mkdirSync(varDir, { recursive: true });

  const proc = spawn(ILO_BINARY, [], {
    env: {
      ...process.env,
      ILO_PORT,
      ILO_DB_PATH,
      ILO_MAX_UPTIME: '0',
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
    // If the server crashed unexpectedly, unregister its providers
    unregisterProviders(['embed']);
  });

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

/** Start the llama.cpp chat server on the first available port (1234). */
async function startChatServer(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${LOCAL_CHAT_PORT_START}/`);
    if (res.ok) {
      console.error(`[chat] Server already running on :${LOCAL_CHAT_PORT_START}`);
      scheduleChatShutdown();
      return true;
    }
  } catch {}

  if (!fs.existsSync(CHAT_MODEL_PATH)) {
    console.error(`[chat] Chat model not found at ${CHAT_MODEL_PATH}`);
    return false;
  }

  const state = getState();

  const proc = spawn(LLAMA_SERVER_BINARY, [
    '--port', String(LOCAL_CHAT_PORT_START),
    '--host', '127.0.0.1',
    '--model', CHAT_MODEL_PATH,
    '--ctx-size', '32768',
    '--n-gpu-layers', '99',
  ], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  state.chatProcess = proc;
  console.error(`[chat] starting llama-server (${CHAT_MODEL_PATH}) on :${LOCAL_CHAT_PORT_START}...`);

  proc.stdout?.on('data', (d) => process.stdout.write(`[chat] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[chat] ${d}`));

  proc.on('exit', (code) => {
    console.error(`[chat] process exited with code ${code}`);
    state.chatProcess = null;
    // If the server crashed unexpectedly, unregister its providers
    unregisterProviders(['chat']);
  });

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${LOCAL_CHAT_PORT_START}/`);
      if (res.ok) {
        console.error(`[chat] started successfully`);
        scheduleChatShutdown();
        return true;
      }
    } catch {}
  }

  console.error(`[chat] failed to start within 5 seconds`);
  return false;
}

/** Schedule chat server shutdown after idle timeout. Call keepChatAlive() to cancel. */
function scheduleChatShutdown() {
  const state = getState();
  if (state.chatIdleTimer) clearTimeout(state.chatIdleTimer);
  state.chatIdleTimer = setTimeout(() => {
    console.error(`[chat] No local model selected within ${CHAT_IDLE_TIMEOUT / 1000}s — stopping chat server`);
    stopChatServer();
  }, CHAT_IDLE_TIMEOUT);
}

/** Call this when the user selects a local model — keeps the chat server alive. */
export function keepChatAlive(): void {
  const state = getState();
  if (state.chatIdleTimer) {
    clearTimeout(state.chatIdleTimer);
    state.chatIdleTimer = null;
    console.error('[chat] Local model selected — keeping chat server alive');
  }
}

/** Stop the chat server and unregister its providers from pi. */
function stopChatServer(): void {
  const state = getState();
  if (state.chatIdleTimer) {
    clearTimeout(state.chatIdleTimer);
    state.chatIdleTimer = null;
  }
  unregisterProviders(['chat']);
  if (state.chatProcess) {
    state.chatProcess.kill('SIGTERM');
    setTimeout(() => {
      if (state.chatProcess) state.chatProcess.kill('SIGKILL');
    }, 5000);
    state.chatProcess = null;
  }
}

/** Stop the embedding server and unregister its providers from pi. */
function stopEmbedServer(): void {
  const state = getState();
  unregisterProviders(['embed']);
  if (state.embedProcess) {
    state.embedProcess.kill('SIGTERM');
    setTimeout(() => {
      if (state.embedProcess) state.embedProcess.kill('SIGKILL');
    }, 5000);
    state.embedProcess = null;
  }
}

/** Stop all managed processes and unregister all providers from pi. */
export function stopIlo(): void {
  const state = getState();

  stopChatServer();
  stopEmbedServer();

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

/** Ensure the ILO sidecar is running. */
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
