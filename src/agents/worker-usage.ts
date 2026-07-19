import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";

export const OM_WORKER_USAGE = "om.worker.usage";
export const WORKER_USAGE_VERSION = 1;

export type WorkerKind = "observer" | "reflector" | "consolidator" | "dropper";

export type WorkerUsageEntryData = {
	version: typeof WORKER_USAGE_VERSION;
	worker: WorkerKind;
	provider?: string;
	model?: string;
	turns: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};
};

export type WorkerUsageRecorder = (data: WorkerUsageEntryData) => void;

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function nonNegativeFinite(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usageValue(value: number | undefined): number {
	return nonNegativeFinite(value) ?? 0;
}

function reportedTotalOrComponents(
	reported: number | undefined,
	components: number,
): number {
	const normalized = nonNegativeFinite(reported);
	return normalized !== undefined && (normalized > 0 || components === 0)
		? normalized
		: components;
}

function sharedLabel(
	messages: readonly AssistantMessage[],
	select: (message: AssistantMessage) => string | undefined,
): string | undefined {
	const values = messages.map(select);
	if (values.some((value) => !value)) return undefined;
	const distinct = new Set(values);
	return distinct.size === 1 ? values[0] : undefined;
}

export function aggregateWorkerUsage(
	worker: WorkerKind,
	messages: readonly AgentMessage[],
): WorkerUsageEntryData | undefined {
	const assistants = messages.filter(isAssistantMessage);
	if (assistants.length === 0) return undefined;

	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	let costInput = 0;
	let costOutput = 0;
	let costCacheRead = 0;
	let costCacheWrite = 0;
	let costTotal = 0;

	for (const message of assistants) {
		const messageInput = usageValue(message.usage?.input);
		const messageOutput = usageValue(message.usage?.output);
		const messageCacheRead = usageValue(message.usage?.cacheRead);
		const messageCacheWrite = usageValue(message.usage?.cacheWrite);
		input += messageInput;
		output += messageOutput;
		cacheRead += messageCacheRead;
		cacheWrite += messageCacheWrite;
		const messageTokenComponents = messageInput + messageOutput + messageCacheRead + messageCacheWrite;
		totalTokens += reportedTotalOrComponents(message.usage?.totalTokens, messageTokenComponents);

		const messageCostInput = usageValue(message.usage?.cost?.input);
		const messageCostOutput = usageValue(message.usage?.cost?.output);
		const messageCostCacheRead = usageValue(message.usage?.cost?.cacheRead);
		const messageCostCacheWrite = usageValue(message.usage?.cost?.cacheWrite);
		costInput += messageCostInput;
		costOutput += messageCostOutput;
		costCacheRead += messageCostCacheRead;
		costCacheWrite += messageCostCacheWrite;
		const messageCostComponents = messageCostInput + messageCostOutput + messageCostCacheRead + messageCostCacheWrite;
		costTotal += reportedTotalOrComponents(message.usage?.cost?.total, messageCostComponents);
	}

	const provider = sharedLabel(assistants, (message) => message.provider);
	const model = sharedLabel(assistants, (message) => message.model);
	return {
		version: WORKER_USAGE_VERSION,
		worker,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		turns: assistants.length,
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens,
			cost: {
				input: costInput,
				output: costOutput,
				cacheRead: costCacheRead,
				cacheWrite: costCacheWrite,
				total: costTotal,
			},
		},
	};
}

export function recordWorkerUsage(
	recorder: WorkerUsageRecorder | undefined,
	worker: WorkerKind,
	messages: readonly AgentMessage[],
): void {
	if (!recorder) return;
	const data = aggregateWorkerUsage(worker, messages);
	if (data) recorder(data);
}
