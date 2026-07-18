import { describe, expect, it } from "vitest";

import { reflectionPoolMetrics, reflectionTokenSum } from "../src/agents/consolidator/pool.js";
import { reflection } from "./fixtures/session.js";

describe("reflection pool", () => {
	it("triggers strictly above max and reports target pressure", () => {
		const atMax = [reflection("aaaaaaaaaaaa", [], { tokenCount: 3_000 })];
		const overMax = [reflection("bbbbbbbbbbbb", [], { tokenCount: 3_001 })];

		expect(reflectionTokenSum(atMax)).toBe(3_000);
		expect(reflectionPoolMetrics(atMax, 2_000, 3_000)).toMatchObject({
			reflectionTokens: 3_000,
			tokensOverTarget: 1_000,
			overMax: false,
		});
		expect(reflectionPoolMetrics(overMax, 2_000, 3_000)).toMatchObject({
			reflectionTokens: 3_001,
			tokensOverTarget: 1_001,
			overMax: true,
		});
	});
});
