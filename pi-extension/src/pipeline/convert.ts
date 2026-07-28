// Pipeline Step 4: Memory → system role conversion
// Converts custom `role: "memory"` messages to `role: "system"` with
// a "[Memory Context]" prefix, as required by most LLM providers.

export function convertMemoryRoles(messages: any[]): void {
	for (const msg of messages) {
		if (msg.role === "memory") {
			msg.role = "system";
			if (msg.content && !msg.content.startsWith("[Memory Context]")) {
				msg.content = `[Memory Context]\n${msg.content}`;
			}
		}
	}
}
