import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { truncateRecordContent } from "../../serialize.js";
import { type Reflection, type ReflectionConsolidation } from "../../session-ledger/index.js";
import { estimateStringTokens } from "../../tokens.js";
import { reflectionTokenSum } from "./pool.js";
import { CONSOLIDATOR_SYSTEM } from "./prompts.js";

interface RunConsolidatorArgs {
	model: Model<any>;
	apiKey: string;
	headers?: Record<string, string>;
	reflections: Reflection[];
	historicalReflectionIds?: Iterable<string>;
	targetTokens: number;
	signal?: AbortSignal;
	agentLoop?: typeof agentLoop;
	maxTurns?: number;
	thinkingLevel?: ModelThinkingLevel;
}

const ConsolidateReflectionsSchema = Type.Object({
	entries: Type.Array(Type.Object({
		content: Type.String({ minLength: 1 }),
		supersededReflectionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	}), { minItems: 1 }),
});

type ConsolidateReflectionsArgs = Static<typeof ConsolidateReflectionsSchema>;

function normalizeContent(content: string): string | undefined {
	const normalized = truncateRecordContent(content.trim());
	if (!normalized || /\r|\n/.test(normalized)) return undefined;
	return normalized;
}

function orderedSupportingObservationIds(reflections: readonly Reflection[]): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];
	for (const reflection of reflections) {
		for (const id of reflection.supportingObservationIds) {
			if (seen.has(id)) continue;
			seen.add(id);
			ordered.push(id);
		}
	}
	return ordered;
}

export function isStrictReflectionReduction(
	replacementTokens: number,
	superseded: readonly Reflection[],
): boolean {
	const supersededTokens = reflectionTokenSum(superseded);
	if (replacementTokens >= supersededTokens) return false;
	if (superseded.length !== 1) return true;
	const savedTokens = supersededTokens - replacementTokens;
	return savedTokens >= 2 && replacementTokens <= Math.floor(supersededTokens * 0.8);
}

export function reflectionToConsolidatorLine(reflection: Reflection): string {
	return `[${reflection.id}] [~${reflection.tokenCount} tokens] ${reflection.content}`;
}

export async function runConsolidator(args: RunConsolidatorArgs): Promise<ReflectionConsolidation[] | undefined> {
	const { model, apiKey, headers, reflections, signal, targetTokens } = args;
	if (reflections.length === 0) return undefined;

	const activeById = new Map(reflections.map((reflection) => [reflection.id, reflection]));
	const historicalIds = new Set(args.historicalReflectionIds ?? activeById.keys());
	const usedSupersededIds = new Set<string>();
	const replacementIds = new Set<string>();
	const accepted: ReflectionConsolidation[] = [];
	let projectedTokens = reflectionTokenSum(reflections);
	let toolCallCount = 0;
	let rejectedCount = 0;

	const consolidateReflections: AgentTool<typeof ConsolidateReflectionsSchema> = {
		name: "consolidate_reflections",
		label: "Consolidate reflections",
		description: "Propose shorter replacement content for groups of active reflection ids.",
		parameters: ConsolidateReflectionsSchema,
		execute: async (_id, params: ConsolidateReflectionsArgs) => {
			toolCallCount++;
			let added = 0;
			let rejected = 0;
			for (const proposal of params.entries) {
				if (projectedTokens <= targetTokens) {
					rejected++;
					continue;
				}
				const content = normalizeContent(proposal.content);
				const uniqueIds = Array.from(new Set(proposal.supersededReflectionIds));
				const selected = uniqueIds.map((id) => activeById.get(id));
				if (
					!content ||
					uniqueIds.length !== proposal.supersededReflectionIds.length ||
					selected.some((reflection) => reflection === undefined) ||
					uniqueIds.some((id) => usedSupersededIds.has(id))
				) {
					rejected++;
					continue;
				}
				const superseded = reflections.filter((reflection) => uniqueIds.includes(reflection.id));
				const id = hashId(content);
				const tokenCount = estimateStringTokens(content);
				if (
					historicalIds.has(id) ||
					replacementIds.has(id) ||
					uniqueIds.includes(id) ||
					!isStrictReflectionReduction(tokenCount, superseded)
				) {
					rejected++;
					continue;
				}
				const replacement: Reflection = {
					id,
					content,
					supportingObservationIds: orderedSupportingObservationIds(superseded),
					tokenCount,
				};
				accepted.push({ replacement, supersededReflectionIds: superseded.map((reflection) => reflection.id) });
				for (const supersededId of uniqueIds) usedSupersededIds.add(supersededId);
				replacementIds.add(id);
				projectedTokens -= reflectionTokenSum(superseded) - tokenCount;
				added++;
			}
			rejectedCount += rejected;
			return {
				content: [{ type: "text", text: `Accepted ${added} consolidation${added === 1 ? "" : "s"}; ${rejected} rejected. Projected active pool: ~${projectedTokens.toLocaleString()} tokens.` }],
				details: { added, rejected, projectedTokens, targetTokens },
			};
		},
	};

	const userText = `ACTIVE REFLECTIONS:\n${reflections.map(reflectionToConsolidatorLine).join("\n")}\n\nActive reflection pool: ~${reflectionTokenSum(reflections).toLocaleString()} tokens; target: ~${targetTokens.toLocaleString()} tokens. Propose only safe reductions toward the target.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = { systemPrompt: CONSOLIDATOR_SYSTEM, messages: [], tools: [consolidateReflections as AgentTool<any>] };
	const reasoning = (model as { reasoning?: unknown }).reasoning;
	const thinkingLevel = args.thinkingLevel ?? "low";
	const effectiveMaxTurns = args.maxTurns && args.maxTurns > 0 ? args.maxTurns : undefined;
	let turnCount = 0;
	const config: AgentLoopConfig = {
		model,
		apiKey,
		headers,
		maxTokens: boundedMaxTokens(model, AGENT_LOOP_MAX_TOKENS),
		convertToLlm: (msgs) => msgs as Message[],
		toolExecution: "sequential",
		...(reasoning && thinkingLevel !== "off" ? { reasoning: thinkingLevel } : {}),
		...(effectiveMaxTurns !== undefined ? { shouldStopAfterTurn: () => ++turnCount >= effectiveMaxTurns } : {}),
	};

	debugLog("consolidator.agent_start", {
		activeReflectionCount: reflections.length,
		reflectionTokens: reflectionTokenSum(reflections),
		targetTokens,
	});
	const loop = args.agentLoop ?? agentLoop;
	const stream = loop(prompts, context, config, signal);
	for await (const _event of stream) {
		// Tool execution collects validated consolidations.
	}
	await stream.result();
	debugLog("consolidator.result", {
		reason: accepted.length > 0 ? "accepted_nonempty" : toolCallCount === 0 ? "no_tool_call" : "all_filtered",
		toolCallCount,
		acceptedCount: accepted.length,
		rejectedCount,
		projectedTokens,
	});
	return accepted.length > 0 ? accepted : undefined;
}
