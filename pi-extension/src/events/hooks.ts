// ============================================================================
// events/input.ts — input event handler
// ============================================================================
// Stores the user's input text so the turn_end handler can use it.
// ============================================================================

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setCurrentUserText } from "./turn";

export function registerInputHooks(pi: ExtensionAPI): void {
	pi.on("input", async (event: any) => {
		setCurrentUserText(event?.text || "");
	});
}
