import type { AssistantMessage } from "@earendil-works/pi-ai";

export function workerAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 19,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}
