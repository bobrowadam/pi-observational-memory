import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { Runtime } from "../runtime.js";
import {
	buildCompactionProjection,
	isMemoryDetails,
	observerSafeCompactionBoundary,
	renderSummary,
	type Entry,
} from "../session-ledger/index.js";

const DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS = 10_000;

function observationsPoolMaxTokens(runtime: Runtime): number {
	const value = (runtime.config as { observationsPoolMaxTokens?: unknown }).observationsPoolMaxTokens;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_OBSERVATIONS_POOL_MAX_TOKENS;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
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
			const { firstKeptEntryId: requestedFirstKeptEntryId, tokensBefore } = preparation;
			const boundary = observerSafeCompactionBoundary(
				branchEntries as Entry[],
				requestedFirstKeptEntryId,
			);
			const projection = buildCompactionProjection(
				branchEntries as Entry[],
				boundary.firstKeptEntryId,
				{ observationsPoolMaxTokens: observationsPoolMaxTokens(runtime) },
			);
			const summary = renderSummary(projection.reflections, projection.observations);

			return {
				compaction: {
					summary,
					firstKeptEntryId: boundary.firstKeptEntryId,
					tokensBefore,
					details: {
						...projection.details,
						requestedFirstKeptEntryId: boundary.requestedFirstKeptEntryId,
						observerCoverageUpToId: boundary.observerCoverageUpToId,
						retainedBeyondRequestedCut: boundary.retainedBeyondRequestedCut,
					},
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});

	pi.on("session_compact", (event: any, ctx: any) => {
		if (!event.fromExtension || !isMemoryDetails(event.compactionEntry?.details)) return;
		const details = event.compactionEntry.details;
		const actual = event.compactionEntry.firstKeptEntryId;
		const requested = details.requestedFirstKeptEntryId;
		if (!actual || !requested || !ctx.hasUI) return;
		const coverage = details.observerCoverageUpToId ?? "none";
		const retained = details.retainedBeyondRequestedCut === true;
		ctx.ui.notify(
			`Observational memory: compaction kept from ${actual} (configured cut: ${requested}; observer coverage: ${coverage})${retained ? "; retained unobserved history" : ""}`,
			retained ? "warning" : "info",
		);
	});
}
