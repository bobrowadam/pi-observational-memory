import { describe, expect, it } from "vitest";

import {
	isStrictReflectionReduction,
	reflectionToConsolidatorLine,
	runConsolidator,
} from "../src/agents/consolidator/agent.js";
import { hashId } from "../src/ids.js";
import { estimateStringTokens } from "../src/tokens.js";
import { reflection } from "./fixtures/session.js";

function fakeAgentLoop(
	handler: (prompts: any[], context: any, config: any) => Promise<void> | void,
	events: any[] = [],
): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
		result: async () => {
			await handler(prompts, context, config);
			return {};
		},
	})) as any;
}

describe("reflection consolidator", () => {
	const refA = reflection("aaaaaaaaaaaa", ["obs-a", "obs-b"], {
		content: "User prefers concise source-backed answers.",
		tokenCount: 10,
	});
	const refB = reflection("bbbbbbbbbbbb", ["obs-b", "obs-c"], {
		content: "User wants exact sources for important claims.",
		tokenCount: 10,
	});
	const baseArgs = {
		model: {} as any,
		apiKey: "test",
		reflections: [refA, refB],
		targetTokens: 2,
	};

	it("receives active reflections and records a code-derived replacement with ordered support union", async () => {
		const content = "User prefers concise answers with exact sources for important claims.";
		let userText = "";
		const loop = fakeAgentLoop(async (prompts, context) => {
			userText = prompts[0].content[0].text;
			await context.tools[0].execute("tool-1", {
				entries: [{ content, supersededReflectionIds: [refB.id, refA.id] }],
			});
		});

		const result = await runConsolidator({ ...baseArgs, agentLoop: loop });

		expect(userText).toContain("ACTIVE REFLECTIONS:");
		expect(userText).toContain(reflectionToConsolidatorLine(refA));
		expect(result).toEqual([{
			replacement: {
				id: hashId(content),
				content,
				supportingObservationIds: ["obs-a", "obs-b", "obs-c"],
				tokenCount: estimateStringTokens(content),
			},
			supersededReflectionIds: [refA.id, refB.id],
		}]);
	});

	it("rejects unknown and duplicate ids, overlap, historical collisions, multiline content, and non-reductions", async () => {
		const collisionContent = "Historical reflection content.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				entries: [
					{ content: "Unknown", supersededReflectionIds: ["cccccccccccc"] },
					{ content: "Duplicate ids", supersededReflectionIds: [refA.id, refA.id] },
					{ content: "Two\nlines", supersededReflectionIds: [refA.id, refB.id] },
					{ content: collisionContent, supersededReflectionIds: [refA.id, refB.id] },
					{ content: "This replacement is intentionally much too verbose to reduce the source reflection token total at all.", supersededReflectionIds: [refA.id] },
				],
			});
		});

		await expect(runConsolidator({
			...baseArgs,
			historicalReflectionIds: [hashId(collisionContent)],
			agentLoop: loop,
		})).resolves.toBeUndefined();
	});

	it("rejects overlapping groups across tool calls and stops at the target", async () => {
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				entries: [{ content: "Concise preference.", supersededReflectionIds: [refA.id] }],
			});
			await context.tools[0].execute("tool-2", {
				entries: [{ content: "Source preference.", supersededReflectionIds: [refA.id, refB.id] }],
			});
		});

		const result = await runConsolidator({ ...baseArgs, targetTokens: 0, agentLoop: loop });

		expect(result).toHaveLength(1);
		expect(result?.[0].supersededReflectionIds).toEqual([refA.id]);
	});

	it("propagates stream errors and aborted results instead of treating them as deliberate no-output", async () => {
		for (const stopReason of ["error", "aborted"]) {
			const loop = fakeAgentLoop(() => {}, [{
				type: "message_end",
				message: { role: "assistant", stopReason, errorMessage: "prompt is too long" },
			}]);
			const error = await runConsolidator({ ...baseArgs, agentLoop: loop }).catch((value) => value);
			expect(error).toBeInstanceOf(Error);
			expect(error.stopReason).toBe(stopReason);
			expect(error.message).toContain(`consolidator stream ended with stopReason "${stopReason}"`);
		}
	});

	it("passes optional api key, headers, and bounded max tokens to the Pi worker loop", async () => {
		let receivedConfig: any;
		const loop = fakeAgentLoop((_prompts, _context, config) => {
			receivedConfig = config;
		});
		const model = { maxTokens: 12_345 } as any;

		await runConsolidator({
			...baseArgs,
			model,
			apiKey: undefined,
			headers: { Authorization: "Bearer oauth-token" },
			agentLoop: loop,
		});

		expect(receivedConfig.apiKey).toBeUndefined();
		expect(receivedConfig.headers).toEqual({ Authorization: "Bearer oauth-token" });
		expect(receivedConfig.maxTokens).toBe(12_345);
	});

	it("requires meaningful savings for one-for-one rewrites", () => {
		const source = reflection("cccccccccccc", ["obs-a"], { tokenCount: 10 });
		expect(isStrictReflectionReduction(9, [source])).toBe(false);
		expect(isStrictReflectionReduction(8, [source])).toBe(true);
		expect(isStrictReflectionReduction(19, [refA, refB])).toBe(true);
		expect(isStrictReflectionReduction(20, [refA, refB])).toBe(false);
	});
});
