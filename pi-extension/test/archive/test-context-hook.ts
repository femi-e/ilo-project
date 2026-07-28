// Test: can before_provider_request actually intercept and change context?
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event: any, _ctx: any) => {
		const payload = event.payload;
		const msgs = payload?.messages;
		if (!msgs || msgs.length === 0) return;

		// Log what we received
		const total = msgs.length;
		const totalChars = msgs.reduce((s: number, m: any) => {
			const c = m.content;
			if (typeof c === "string") return s + c.length;
			if (Array.isArray(c))
				return (
					s + c.reduce((a: number, p: any) => a + (p?.text?.length || 0), 0)
				);
			return s;
		}, 0);

		console.error(
			`\n[BEFORE HOOK] Received ${total} messages, ~${Math.round(totalChars / 4)} tokens`,
		);

		// Log first 3 and last 2 message roles + previews
		for (let i = 0; i < Math.min(3, total); i++) {
			const preview = (msgs[i].content || "")
				.toString()
				.slice(0, 60)
				.replace(/\n/g, " ");
			console.error(`  [${i}] ${msgs[i].role}: "${preview}..."`);
		}
		if (total > 5) console.error(`  ... ${total - 5} more messages ...`);
		for (let i = Math.max(3, total - 2); i < total; i++) {
			const preview = (msgs[i].content || "")
				.toString()
				.slice(0, 60)
				.replace(/\n/g, " ");
			console.error(`  [${i}] ${msgs[i].role}: "${preview}..."`);
		}

		// TEST: Keep only the last 3 messages + system prompt
		const systemMsg = msgs.find((m: any) => m.role === "system");
		const last3 = msgs.slice(-3);

		const filtered = systemMsg ? [systemMsg, ...last3] : last3;

		// Verify our filtering worked by logging what we're keeping
		console.error(`\n  Keeping ${filtered.length} messages:`);
		for (const m of filtered) {
			const preview = (m.content || "")
				.toString()
				.slice(0, 60)
				.replace(/\n/g, " ");
			console.error(`    ${m.role}: "${preview}..."`);
		}

		// Inject a verification message so we can see the change took effect
		const lastUserIdx = filtered.length - 1;
		if (filtered[lastUserIdx]?.role === "user") {
			const existing = filtered[lastUserIdx].content;
			if (typeof existing === "string") {
				filtered[lastUserIdx].content =
					`[HOOK TEST] Context was ${total} msgs (~${Math.round(totalChars / 4)} tok), filtered to ${filtered.length}.\n\n${existing}`;
			}
		}

		payload.messages = filtered;
		console.error(`  Returned ${payload.messages.length} messages\n`);
		return payload;
	});
}
