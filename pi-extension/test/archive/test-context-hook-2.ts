// Test 2: verify hook works with large context (200+ messages)
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event: any, _ctx: any) => {
		const payload = event.payload;
		const msgs = payload?.messages;
		if (!msgs || msgs.length === 0) return;

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

		// Log roles breakdown
		const roles: Record<string, number> = {};
		for (const m of msgs) roles[m.role] = (roles[m.role] || 0) + 1;

		console.error(`\n[HOOK] ${total} msgs, ~${Math.round(totalChars / 4)} tok`);
		console.error(`[HOOK] Roles: ${JSON.stringify(roles)}`);
		console.error(
			`[HOOK] First: ${msgs[0]?.role}  Last: ${msgs[total - 1]?.role}`,
		);

		// Keep system + last 5 messages (heavy truncation for test)
		const systemMsg = msgs.find((m: any) => m.role === "system");
		const keep = msgs.slice(-5);

		const filtered = systemMsg ? [systemMsg, ...keep] : keep;

		// Inject verification into last user message
		const lastUserIdx = filtered.length - 1;
		if (filtered[lastUserIdx]?.role === "user") {
			const existing = filtered[lastUserIdx].content;
			if (typeof existing === "string") {
				filtered[lastUserIdx].content =
					`[HOOK TEST: ${total}→${filtered.length} msgs, ${roles.system || 0} system, ${roles.user || 0} user, ${roles.assistant || 0} assistant, ${roles.toolResult || 0} toolResult]\n\n${existing}`;
			}
		}

		payload.messages = filtered;
		console.error(`[HOOK] Returned ${filtered.length} msgs\n`);
		return payload;
	});
}
