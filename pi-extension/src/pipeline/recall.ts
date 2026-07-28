// Pipeline Step 1: Memory recall
// Calls ILO sidecar to retrieve relevant memory for the current query.
// Injects memory context as a `role: "memory"` message.

import { ilo } from "../client/ilo-client";

export async function recallMemory(
	msgs: any[],
	latestQuery: string,
): Promise<void> {
	if (!latestQuery || latestQuery === "(unknown)") return;

	try {
		const memoryContext = await ilo.recall(latestQuery);
		if (
			memoryContext.ok &&
			memoryContext.data?.context &&
			memoryContext.data.nodes > 0
		) {
			const memoryMsg = {
				role: "memory",
				content: memoryContext.data.context,
				customType: "ilo_memory",
			};
			msgs.splice(msgs.length - 1, 0, memoryMsg);
		}
	} catch {
		// Non-critical — proceed without memory recall
	}
}
