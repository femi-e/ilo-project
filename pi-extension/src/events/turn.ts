// ============================================================================
// events/turn.ts — turn_end handler (ILO-powered)
// ============================================================================
// On each turn end:
//   1. Extracts entities and claims from the full conversation
//   2. Signals learning (which entities were useful)
//   3. Stores the turn with entities and claims via ILO
// ============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ilo } from "../client/ilo-client";
import { ensureIlo } from "../lifecycle/manager";

// ── In-memory state (survives /reload) ────────────────

const STATE_KEY = "__ailo_ilo_turn_state__";

interface TurnState {
	lastUserText: string;
	turnCount: number;
	healthy: boolean;
}

export function getState(): TurnState {
	let state = (globalThis as any)[STATE_KEY];
	if (!state) {
		state = { lastUserText: "", turnCount: 0, healthy: false };
		(globalThis as any)[STATE_KEY] = state;
	}
	return state;
}

/** Store the user's input text (called from input event). */
export function setCurrentUserText(text: string): void {
	getState().lastUserText = text;
}

// ═══════════════════════════════════════════════════════════
// Handler registration
// ═══════════════════════════════════════════════════════════

export function registerTurnHooks(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event: any, ctx: any) => {
		const state = getState();
		state.turnCount = 0;

		// Show ILO startup status — ensureIlo handles restart if needed
		const healthy = await ensureIlo();
		state.healthy = healthy;
		if (healthy && ctx?.ui) {
			ctx.ui.setStatus("ilo", ctx.ui.theme.fg("success", "● ILO"));
			ctx.ui.notify("ILO memory layer connected", "info");
		} else if (ctx?.ui) {
			ctx.ui.setStatus("ilo", ctx.ui.theme.fg("error", "✖ ILO offline"));
			ctx.ui.notify("ILO memory layer unavailable", "error");
		}
	});

	pi.on("turn_end", async (event: any, ctx: any) => {
		const state = getState();
		const userText = state.lastUserText;
		const msg = event?.message;
		const rawContent = msg?.content;
		const responseText =
			typeof rawContent === "string"
				? rawContent
				: Array.isArray(rawContent)
					? rawContent
							.filter((b: any) => b.type === "text")
							.map((b: any) => b.text)
							.join("\n")
					: "";

		if (!userText && !responseText) {
			return;
		}

		// Ensure sidecar is alive before storing this turn
		const healthy = await ensureIlo();
		if (!healthy) {
			console.error("[ilo-turn] sidecar unavailable, skipping memory storage");
			return;
		}

		try {
			// The agent stores entities/claims proactively via memory_extract tool.
			// Here we just store the turn record itself.
			await ilo
				.remember({
					query: userText,
					response: responseText,
					entities: [],
					claims: [],
					allEntities: [],
					turnIndex: state.turnCount++,
				})
				.catch(() => {});

			// Notify on first turn
			if (state.turnCount <= 2 && ctx?.ui) {
				ctx.ui.notify("Turn stored in memory", "info");
			}
		} catch (err) {
			console.error("[ilo-turn] failed:", err);
		}
	});

	(pi as any).on("session_end", async (_event: any, ctx: any) => {
		if (ctx?.ui) ctx.ui.setStatus("ilo", undefined);
	});
}
