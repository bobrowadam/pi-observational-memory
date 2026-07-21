import {
	agentLoop,
	type AgentContext,
	type AgentLoopConfig,
	type AgentMessage,
} from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";

export type WorkerAgentLoop = typeof agentLoop;

export function startWorkerAgentLoop(
	loop: WorkerAgentLoop,
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): ReturnType<WorkerAgentLoop> {
	return loop(prompts, context, config, signal, streamSimple);
}
