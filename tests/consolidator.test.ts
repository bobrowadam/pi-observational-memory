import { describe, expect, it, vi } from "vitest";

import {
	isStrictReflectionReduction,
	reflectionToConsolidatorLine,
	runConsolidator,
} from "../src/agents/consolidator/agent.js";
import { hashId } from "../src/ids.js";
import { estimateStringTokens } from "../src/tokens.js";
import { reflection } from "./fixtures/session.js";
import { workerAssistantMessage } from "./fixtures/worker-usage.js";

function fakeAgentLoop(
	handler: (prompts: any[], context: any, config: any) => Promise<void> | void,
	result: any[] = [],
): any {
	return ((prompts: any[], context: any, config: any) => ({
		async *[Symbol.asyncIterator]() {},
		result: async () => {
			await handler(prompts, context, config);
			return result;
		},
	})) as any;
}

describe("reflection consolidator", () => {
	const refA = reflection("aaaaaaaaaaaa", ["obs-a", "obs-b"], { content: "User prefers concise source-backed answers.", tokenCount: 10 });
	const refB = reflection("bbbbbbbbbbbb", ["obs-b", "obs-c"], { content: "User wants exact sources for important claims.", tokenCount: 10 });
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

	it("rejects unknown ids, overlap, collisions, multiline content, and non-reductions", async () => {
		const collisionContent = "Historical reflection content.";
		const loop = fakeAgentLoop(async (_prompts, context) => {
			await context.tools[0].execute("tool-1", {
				entries: [
					{ content: "Unknown", supersededReflectionIds: ["cccccccccccc"] },
					{ content: "Two\nlines", supersededReflectionIds: [refA.id, refB.id] },
					{ content: collisionContent, supersededReflectionIds: [refA.id, refB.id] },
					{ content: "This replacement is intentionally much too verbose to reduce the source reflection token total at all.", supersededReflectionIds: [refA.id] },
				],
			});
		});

		await expect(runConsolidator({
			...baseArgs,
			historicalReflectionIds: [refA.id, refB.id, hashId(collisionContent)],
			agentLoop: loop,
		})).resolves.toBeUndefined();
	});

	it("rejects overlapping groups across tool calls", async () => {
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

	it("records usage from the completed consolidator result", async () => {
		const onUsage = vi.fn();
		const loop = fakeAgentLoop(() => {}, [workerAssistantMessage()]);

		await runConsolidator({ ...baseArgs, agentLoop: loop, onUsage });

		expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ worker: "consolidator", turns: 1 }));
	});

	it("requires meaningful savings for one-for-one rewrites", () => {
		const source = reflection("cccccccccccc", ["obs-a"], { tokenCount: 10 });
		expect(isStrictReflectionReduction(9, [source])).toBe(false);
		expect(isStrictReflectionReduction(8, [source])).toBe(true);
		expect(isStrictReflectionReduction(19, [refA, refB])).toBe(true);
		expect(isStrictReflectionReduction(20, [refA, refB])).toBe(false);
	});
});
