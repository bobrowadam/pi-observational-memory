import type { Reflection } from "../../session-ledger/index.js";

export type ReflectionPoolMetrics = {
	reflectionTokens: number;
	targetTokens: number;
	maxTokens: number;
	tokensOverTarget: number;
	activeReflectionCount: number;
	overMax: boolean;
};

export function reflectionTokenSum(reflections: readonly { tokenCount: number }[]): number {
	return reflections.reduce((sum, reflection) => sum + reflection.tokenCount, 0);
}

/** Stable identity for the current active reflection set, regardless of order. */
export function reflectionPoolFingerprint(reflections: readonly Reflection[]): string {
	return reflections.map((reflection) => reflection.id).sort().join(",");
}

export function reflectionPoolMetrics(
	reflections: readonly Reflection[],
	targetTokens: number,
	maxTokens: number,
): ReflectionPoolMetrics {
	const reflectionTokens = reflectionTokenSum(reflections);
	return {
		reflectionTokens,
		targetTokens,
		maxTokens,
		tokensOverTarget: Math.max(0, reflectionTokens - targetTokens),
		activeReflectionCount: reflections.length,
		overMax: reflectionTokens > maxTokens,
	};
}
