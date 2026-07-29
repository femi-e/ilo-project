// ============================================================================
// lib/ilo-manager.ts — ILO + llama.cpp process lifecycle management
// ============================================================================
// Spawns the ILO Rust sidecar, llama.cpp embedding server, and optionally
// a llama.cpp chat server. The chat server auto-stops after 5 minutes
// if the user hasn't selected a local model in pi.
// ============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { ilo } from "../client/ilo-client";
import {
	EXT_VAR_DIR,
	LOCAL_EMBED_PORT,
} from "./constants";

const STATE_KEY = "__ailo_ilo_manager__";

interface IloManagerState {
	iloProcess: ChildProcess | null;
	embedProcess: ChildProcess | null;
	chatProcess: ChildProcess | null;
	_4bProcess: ChildProcess | null;
	startedAt: number;
	restartCount: number;
	/** True while stopIlo() is executing — prevents the exit handler from restarting. */
	intentionalShutdown: boolean;
	chatIdleTimer: ReturnType<typeof setTimeout> | null;
	/** Provider names registered with pi for each server type. Unregistered on stop. */
	registeredProviders: { embed: string[]; chat: string[] };
	/** Callback set by index.ts to unregister providers via pi.unregisterProvider(). */
	unregisterProvider: ((name: string) => void) | null;
}

function getState(): IloManagerState {
	let state = (globalThis as any)[STATE_KEY];
	if (!state) {
		state = {
			iloProcess: null,
			embedProcess: null,
			chatProcess: null,
			_4bProcess: null,
			startedAt: 0,
			restartCount: 0,
			intentionalShutdown: false,
			chatIdleTimer: null,
			registeredProviders: { embed: [], chat: [] },
			unregisterProvider: null,
		};
		(globalThis as any)[STATE_KEY] = state;
	}
	return state;
}

// ── Config ────────────────────────────────────────────

const ILO_BINARY =
	process.env.ILO_BINARY ||
	path.join(EXT_VAR_DIR, "..", "mem-arch", "target", "release", "ilo");
const ILO_PORT = process.env.ILO_PORT || "18090";
const ILO_DB_PATH =
	process.env.ILO_DB_PATH || path.join(EXT_VAR_DIR, "ilo_data.lbug");
const MAX_RESTARTS = 3;

/** How long to wait (ms) for the old ILO process to exit before force-killing and starting fresh. */
const OLD_PROCESS_WAIT_MS = parseInt(
	process.env.ILO_SHUTDOWN_WAIT_MS || "5000",
	10,
);

/** How long to poll (ms) for the old PID to disappear during restart. */
const PID_POLL_INTERVAL_MS = 200;

const LLAMA_SERVER_BINARY = process.env.LLAMA_SERVER_BINARY || "llama-server";
const EMBED_MODEL_PATH =
	process.env.EMBED_MODEL_PATH ||
	path.join(os.homedir(), "models", "embeddings", "bge-base-en-v1.5-q8_0.gguf");

// ── Provider registration tracking ───────────────────

/**
 * Register providers that pi knows about, keyed by server type.
 * Embed providers are on port 1235; chat providers on ports 1234, 1236-1240.
 * These are unregistered automatically when the corresponding server stops.
 */
export function setRegisteredProviders(providers: {
	embed: string[];
	chat: string[];
}): void {
	getState().registeredProviders = providers;
}

/** Set the callback to unregister a provider from pi. Called from index.ts. */
export function setUnregisterProviderCallback(
	cb: (name: string) => void,
): void {
	getState().unregisterProvider = cb;
}

function unregisterProviders(types: ("embed" | "chat")[]): void {
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

// ── Helpers ───────────────────────────────────────────

/**
 * Wait for a process by PID to exit. Polls until the PID is gone or timeout.
 * Returns true if the process exited, false if it timed out.
 */
async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			// Sending signal 0 checks if the process exists without killing it
			process.kill(pid, 0);
		} catch {
			// Process doesn't exist anymore
			return true;
		}
		await new Promise((r) => setTimeout(r, PID_POLL_INTERVAL_MS));
	}
	return false;
}

/**
 * Kill a process gracefully (SIGTERM), then wait for it to exit.
 * If it doesn't exit within the timeout, send SIGKILL.
 */
async function killProcessGracefully(
	proc: ChildProcess,
	timeoutMs: number,
): Promise<void> {
	proc.kill("SIGTERM");
	const pid = proc.pid;
	if (pid === undefined) return;

	const exited = await waitForPidExit(pid, timeoutMs);
	if (!exited) {
		console.error(`[ilo] PID ${pid} did not exit within ${timeoutMs}ms, sending SIGKILL`);
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone
		}
	}
}

/** Kill a child process by PID (from PID file). */
async function killOldPid(pid: number, timeoutMs: number): Promise<void> {
	try {
		// Check if the process exists
		process.kill(pid, 0);
	} catch {
		return; // Already gone
	}

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}

	const exited = await waitForPidExit(pid, timeoutMs);
	if (!exited) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone
		}
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
		console.warn(
			"[ilo] Embedding server failed to start — vector search will be disabled",
		);
		allOk = false;
	}

	// ── Chat server is disabled — the 35B model is not auto-managed
	// The user starts/stops the 35B MTPLX or llama-server manually.
	// ──

	// ── 4B context-rebuild model server is disabled — replaced by memory_extract tool
	// The agent handles extraction directly via tool calls to the 35B model.
	// ──

	// ── Start ILO sidecar ──
	if (!fs.existsSync(ILO_BINARY)) {
		console.error(`[ilo] binary not found at ${ILO_BINARY}`);
		console.error("[ilo] run: cd mem-arch && cargo build --release");
		return false;
	}

	// Stop any existing tracked process and wait for it fully
	if (state.iloProcess) {
		try {
			const res = await ilo.status();
			if (res.ok) return allOk;
		} catch {}
		await stopIlo();
	}

	// Wait for any old PID from a previous (untracked) instance to exit
	const pidFile = path.join(EXT_VAR_DIR, "ilo.pid");
	try {
		const oldPid = parseInt(fs.readFileSync(pidFile, "utf-8"), 10);
		if (oldPid > 0) {
			await killOldPid(oldPid, OLD_PROCESS_WAIT_MS);
		}
	} catch {
		// No PID file, nothing to wait for
	}

	// Also wait for the flock file to be released (old process may have exited
	// but the OS may not have released the lock yet)
	const lockFile = path.join(EXT_VAR_DIR, "ilo.lock");
	await waitForFlockReleased(lockFile, OLD_PROCESS_WAIT_MS);

	const socketPath = path.join(EXT_VAR_DIR, "ilo.sock");
	try {
		fs.unlinkSync(socketPath);
	} catch {}

	const varDir = path.dirname(ILO_DB_PATH);
	fs.mkdirSync(varDir, { recursive: true });

	const proc = spawn(ILO_BINARY, [], {
		env: {
			...process.env,
			ILO_PORT,
			ILO_DB_PATH,
			RUST_LOG: process.env.RUST_LOG || "info",
		},
		cwd: path.dirname(ILO_BINARY),
		stdio: ["ignore", "pipe", "pipe"],
	});

	state.iloProcess = proc;
	state.startedAt = Date.now();
	state.intentionalShutdown = false;
	console.error("[ilo] starting sidecar...");

	proc.stdout?.on("data", (d) => process.stdout.write(`[ilo] ${d}`));
	proc.stderr?.on("data", (d) => process.stderr.write(`[ilo] ${d}`));

	try {
		fs.writeFileSync(pidFile, String(proc.pid));
	} catch {}

	proc.on("exit", (code) => {
		console.error(`[ilo] process exited with code ${code}`);
		state.iloProcess = null;
		try {
			fs.unlinkSync(pidFile);
		} catch {}

		// Only auto-restart on unexpected crash, not intentional shutdown
		if (!state.intentionalShutdown && state.restartCount < MAX_RESTARTS) {
			state.restartCount++;
			console.error(
				`[ilo] restarting (${state.restartCount}/${MAX_RESTARTS})...`,
			);
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

	console.error("[ilo] failed to start within 3 seconds");
	return false;
}

/**
 * Wait for a flock file to no longer be held by any process.
 * On macOS/Linux, a flock is released when the holding process exits.
 * We check by trying to open the file for writing — if it succeeds without
 * contention, the old lock has been released.
 */
async function waitForFlockReleased(
	lockPath: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		// If the lock file doesn't exist, there's no contention
		if (!fs.existsSync(lockPath)) return;

		// Try to open with exclusive access — if we succeed, the old lock is gone
		try {
			const fd = fs.openSync(lockPath, "wx");
			fs.closeSync(fd);
			return;
		} catch {
			// Lock still held, wait and retry
			await new Promise((r) => setTimeout(r, PID_POLL_INTERVAL_MS));
		}
	}
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
		console.error(
			"[embed] Download: curl -sL -o ~/models/embeddings/bge-base-en-v1.5-q8_0.gguf https://huggingface.co/CompendiumLabs/bge-base-en-v1.5-gguf/resolve/main/bge-base-en-v1.5-q8_0.gguf",
		);
		return false;
	}

	const state = getState();

	const proc = spawn(
		LLAMA_SERVER_BINARY,
		[
			"--port",
			String(LOCAL_EMBED_PORT),
			"--host",
			"127.0.0.1",
			"--embeddings",
			"--pooling",
			"mean",
			"--model",
			EMBED_MODEL_PATH,
			"--ctx-size",
			"512",
			"--n-gpu-layers",
			"99",
		],
		{
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	state.embedProcess = proc;
	console.error(
		`[embed] starting llama-server (${EMBED_MODEL_PATH}) on :${LOCAL_EMBED_PORT}...`,
	);

	// Write verbose embed server logs to file instead of spamming the terminal
	const embedLogPath = path.join(EXT_VAR_DIR, "embed.log");
	const embedLogStream = fs.createWriteStream(embedLogPath, { flags: "a" });
	proc.stdout?.on("data", (d) => embedLogStream.write(`[embed:stdout] ${d}`));
	proc.stderr?.on("data", (d) => embedLogStream.write(`[embed:stderr] ${d}`));
	embedLogStream.write(
		`--- Embed server started on :${LOCAL_EMBED_PORT} at ${new Date().toISOString()} ---\n`,
	);
	console.error(`[embed] Logging to ${embedLogPath}`);

	proc.on("exit", (code) => {
		console.error(`[embed] process exited with code ${code}`);
		state.embedProcess = null;
		// If the server crashed unexpectedly, unregister its providers
		unregisterProviders(["embed"]);
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

/** Stop the embedding server and unregister its providers from pi. */
function stopEmbedServer(): void {
	const state = getState();
	unregisterProviders(["embed"]);
	if (state.embedProcess) {
		state.embedProcess.kill("SIGTERM");
		setTimeout(() => {
			if (state.embedProcess) state.embedProcess.kill("SIGKILL");
		}, 5000);
		state.embedProcess = null;
	}
}

/** Stop all managed processes and unregister all providers from pi. */
export async function stopIlo(): Promise<void> {
	const state = getState();

	// Set intentional shutdown flag so the exit handler doesn't auto-restart
	state.intentionalShutdown = true;

	if (state.embedProcess) {
		stopEmbedServer();
	}

	if (state.iloProcess) {
		const proc = state.iloProcess;
		// Don't null out state.iloProcess yet — the exit handler needs it
		// to avoid calling startIlo().
		await killProcessGracefully(proc, OLD_PROCESS_WAIT_MS);
		state.iloProcess = null;
	}
}

/** Check if ILO is responding. */
export async function isIloHealthy(): Promise<boolean> {
	try {
		const res = await ilo.status();
		return res.ok && res.data?.status === "ok";
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
		console.error("[ilo] process died, restarting...");
		state.iloProcess = null;
	} else {
		const healthy = await isIloHealthy();
		if (healthy) return true;
	}

	return startIlo();
}

/** Restart ILO. */
export async function restartIlo(): Promise<boolean> {
	await stopIlo();
	// A brief delay after graceful shutdown to let the OS release the flock
	await new Promise((r) => setTimeout(r, 500));
	return startIlo();
}