import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

import type { Message } from "@earendil-works/pi-ai";

import type { Runtime } from "../runtime.js";
import {
	OM_OBSERVATIONS_RECORDED,
	buildCompactionProjection,
	entryIndexById,
	findLastCompactionIndex,
	isSourceEntry,
	latestCoverageIndex,
	renderSummary,
	type Entry,
} from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 20_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

// Walk backward so every retained result brings its originating call into the
// raw tail, including earlier results in a partially covered multi-tool batch.
function retainToolExchanges(entries: Entry[], boundary: number): number | undefined {
	const pendingCalls = new Set<string>();
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type !== "message") continue;
		const message = entries[i].message as Message | undefined;
		if (message?.role === "toolResult" && i >= boundary) {
			pendingCalls.add(message.toolCallId);
		} else if (message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "toolCall" && pendingCalls.delete(block.id)) {
					boundary = Math.min(boundary, i);
				}
			}
		}
	}
	return pendingCalls.size === 0 ? boundary : undefined;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		if (runtime.compactHookInFlight) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Observational memory: another compaction is already in progress; cancelling duplicate",
					"warning",
				);
			}
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const { preparation, branchEntries } = event;
			const entries = branchEntries as Entry[];
			const idToIndex = entryIndexById(entries);
			const preparedBoundary = idToIndex.get(preparation.firstKeptEntryId);
			if (preparedBoundary === undefined) return { cancel: true };

			const coveredIndex = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
			const firstUnprocessed = entries.findIndex((entry, i) => i > coveredIndex && isSourceEntry(entry));
			const boundary = retainToolExchanges(
				entries,
				firstUnprocessed === -1 ? preparedBoundary : Math.min(preparedBoundary, firstUnprocessed),
			);
			if (boundary === undefined) return { cancel: true };

			// Previously compacted raw entries are not removable progress now.
			const lastCompaction = findLastCompactionIndex(entries);
			const currentStart = lastCompaction === -1
				? 0
				: idToIndex.get(entries[lastCompaction].firstKeptEntryId ?? "");
			if (currentStart === undefined || !entries.slice(currentStart, boundary).some(isSourceEntry)) {
				return { cancel: true };
			}

			// Include all acknowledged memory, even when its source is also kept
			// raw for recency or tool integrity. Moving the raw cut backward must
			// not exclude a coverage batch needed by the summary.
			const projection = buildCompactionProjection(
				entries,
				entries[coveredIndex]?.id,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
			);
			const summary = renderSummary(projection.reflections, projection.observations);
			const firstKeptEntryId = entries[boundary].id;
			const { tokensBefore } = preparation;

			return {
				compaction: {
					summary,
					firstKeptEntryId,
					tokensBefore,
					details: { ...projection.details, coversUpToId: entries[coveredIndex].id },
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
