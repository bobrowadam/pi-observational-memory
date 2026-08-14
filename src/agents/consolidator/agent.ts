import { agentLoop, type AgentContext, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Static } from "typebox";
import { debugLog } from "../../debug-log.js";
import { hashId } from "../../ids.js";
import { AGENT_LOOP_MAX_TOKENS, boundedMaxTokens } from "../../model-budget.js";
import { truncateRecordContent } from "../../serialize.js";
import { type Reflection, type ReflectionConsolidation } from "../../session-ledger/index.js";
import { estimateStringTokens } from "../../tokens.js";
import { logAgentStreamError } from "../stream-errors.js";
import { reflectionTokenSum } from "./pool.js";
import { CONSOLIDATOR_SYSTEM } from "./prompts.js";

interface RunConsolidatorArgs {
	model: Model<any>;
	apiKey?: string;
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
	entries: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1 }),
			supersededReflectionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		}),
		{ minItems: 1 },
	),
});

type ConsolidateReflectionsArgs = Static<typeof ConsolidateReflectionsSchema>;

function normalizeContent(content: string): string | undefined {
	const normalized = content.trim();
	if (!normalized || /\r|\n/.test(normalized)) return undefined;
	return truncateRecordContent(normalized);
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

/**
 * Require a real reduction for every consolidation. A one-for-one rewrite has
 * a stricter bar because a small paraphrase is not worth changing provenance.
 */
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

/** The model stream failed before producing a usable consolidation result. */
export class ConsolidatorStreamError extends Error {
	readonly stopReason: string;
	constructor(stopReason: string, errorMessage?: string) {
		super(`consolidator stream ended with stopReason "${stopReason}"${errorMessage ? `: ${errorMessage}` : ""}`);
		this.name = "ConsolidatorStreamError";
		this.stopReason = stopReason;
	}
}

export async function runConsolidator(args: RunConsolidatorArgs): Promise<ReflectionConsolidation[] | undefined> {
	const { model, apiKey, headers, reflections, signal, targetTokens } = args;
	if (reflections.length === 0) return undefined;

	const activeById = new Map(reflections.map((reflection) => [reflection.id, reflection]));
	const historicalIds = new Set(args.historicalReflectionIds ?? []);
	for (const reflection of reflections) historicalIds.add(reflection.id);

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
				const supersededIds = proposal.supersededReflectionIds;
				const uniqueIds = Array.from(new Set(supersededIds));
				if (uniqueIds.length !== supersededIds.length) {
					rejected++;
					continue;
				}

				const superseded = uniqueIds.map((id) => activeById.get(id));
				if (
					!content ||
					superseded.some((reflection) => reflection === undefined) ||
					uniqueIds.some((id) => usedSupersededIds.has(id))
				) {
					rejected++;
					continue;
				}

				const sourceReflections = reflections.filter((reflection) => uniqueIds.includes(reflection.id));
				const id = hashId(content);
				const tokenCount = estimateStringTokens(content);
				if (
					historicalIds.has(id) ||
					replacementIds.has(id) ||
					uniqueIds.includes(id) ||
					!isStrictReflectionReduction(tokenCount, sourceReflections)
				) {
					rejected++;
					continue;
				}

				const replacement: Reflection = {
					id,
					content,
					supportingObservationIds: orderedSupportingObservationIds(sourceReflections),
					tokenCount,
				};
				accepted.push({
					replacement,
					supersededReflectionIds: sourceReflections.map((reflection) => reflection.id),
				});
				for (const supersededId of uniqueIds) usedSupersededIds.add(supersededId);
				replacementIds.add(id);
				projectedTokens -= reflectionTokenSum(sourceReflections) - tokenCount;
				added++;
			}
			rejectedCount += rejected;
			return {
				content: [{
					type: "text",
					text: `Accepted ${added} consolidation${added === 1 ? "" : "s"}; ${rejected} rejected. Projected active pool: ~${projectedTokens.toLocaleString()} tokens.`,
				}],
				details: { added, rejected, projectedTokens, targetTokens },
			};
		},
	};

	const userText = `ACTIVE REFLECTIONS:\n${reflections.map(reflectionToConsolidatorLine).join("\n")}\n\nActive reflection pool: ~${reflectionTokenSum(reflections).toLocaleString()} tokens; target: ~${targetTokens.toLocaleString()} tokens. Propose only safe reductions toward the target.`;
	const prompts: Message[] = [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }];
	const context: AgentContext = {
		systemPrompt: CONSOLIDATOR_SYSTEM,
		messages: [],
		tools: [consolidateReflections as AgentTool<any>],
	};
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
	const stream = loop(prompts, context, config, signal, streamSimple);
	let streamError: { stopReason: string; errorMessage?: string } | undefined;
	for await (const event of stream) {
		logAgentStreamError("consolidator", event);
		const message = (event as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
		if (message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted")) {
			streamError = { stopReason: message.stopReason, errorMessage: message.errorMessage };
		}
	}
	await stream.result();
	if (accepted.length === 0 && streamError) {
		throw new ConsolidatorStreamError(streamError.stopReason, streamError.errorMessage);
	}
	debugLog("consolidator.result", {
		reason: accepted.length > 0 ? "accepted_nonempty" : toolCallCount === 0 ? "no_tool_call" : "all_filtered",
		toolCallCount,
		acceptedCount: accepted.length,
		rejectedCount,
		projectedTokens,
	});
	return accepted.length > 0 ? accepted : undefined;
}
