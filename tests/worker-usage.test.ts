import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
	aggregateWorkerUsage,
	recordWorkerUsage,
	WORKER_USAGE_VERSION,
} from "../src/agents/worker-usage.js";

function assistant(
	usage: AssistantMessage["usage"],
	options: { provider?: string; model?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: options.provider ?? "anthropic",
		model: options.model ?? "claude-test",
		usage,
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("worker usage accounting", () => {
	it("aggregates every assistant turn and preserves token and cost components", () => {
		const result = aggregateWorkerUsage("reflector", [
			{ role: "user", content: "work", timestamp: 0 },
			assistant({
				input: 10,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 19,
				cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
			}),
			assistant({
				input: 20,
				output: 5,
				cacheRead: 6,
				cacheWrite: 0,
				totalTokens: 31,
				cost: { input: 2, output: 5, cacheRead: 6, cacheWrite: 0, total: 13 },
			}),
		]);

		expect(result).toEqual({
			version: WORKER_USAGE_VERSION,
			worker: "reflector",
			provider: "anthropic",
			model: "claude-test",
			turns: 2,
			usage: {
				input: 30,
				output: 7,
				cacheRead: 9,
				cacheWrite: 4,
				totalTokens: 50,
				cost: { input: 3, output: 7, cacheRead: 9, cacheWrite: 4, total: 23 },
			},
		});
	});

	it("records zero cost when provider cost data is absent", () => {
		const message = assistant({
			input: 7,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		Reflect.deleteProperty(message.usage, "cost");

		expect(aggregateWorkerUsage("observer", [message])?.usage.cost).toEqual({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		});
	});

	it("omits inconsistent model labels and ignores invalid numeric values", () => {
		const first = assistant({
			input: Number.NaN,
			output: -1,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: Number.NaN,
			cost: { input: Number.NaN, output: -1, cacheRead: 0.02, cacheWrite: 0, total: Number.NaN },
		});
		const second = assistant({
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		}, { provider: "openai", model: "gpt-test" });

		expect(aggregateWorkerUsage("dropper", [first, second])).toEqual({
			version: 1,
			worker: "dropper",
			turns: 2,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 2,
				cacheWrite: 0,
				totalTokens: 4,
				cost: { input: 0, output: 0, cacheRead: 0.02, cacheWrite: 0, total: 0.02 },
			},
		});
	});

	it("does not call the recorder when no assistant usage is present", () => {
		const recorder = vi.fn();
		recordWorkerUsage(recorder, "consolidator", [{ role: "user", content: "work", timestamp: 0 }]);
		expect(recorder).not.toHaveBeenCalled();
	});
});
