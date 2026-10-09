import { describe, expect, it, vi } from "vitest";

import { registerCompactionHook } from "../src/hooks/compaction-hook.js";
import type { MemoryDetails } from "../src/session-ledger/types.js";
import {
	compactionEntry,
	memoryDetails,
	observation,
	observationsDroppedEntry,
	observationsRecordedEntry,
	oldV2CompactionDetails,
	oldV2ObservationEntry,
	reflection,
	rawMessage,
	reflectionsRecordedEntry,
	textCustomMessage,
	type TestEntry,
} from "./fixtures/session.js";

function setup(args: { entries: TestEntry[]; observationsPoolMaxTokens?: number; compactHookInFlight?: boolean }) {
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const pi = {
		on: vi.fn((eventName: string, cb: typeof handler) => {
			expect(eventName).toBe("session_before_compact");
			handler = cb;
		}),
		appendEntry: vi.fn(),
	};
	const runtime = {
		config: {
			observationsPoolMaxTokens: args.observationsPoolMaxTokens ?? 20_000,
		},
		compactHookInFlight: args.compactHookInFlight ?? false,
		observerPromise: new Promise(() => {}),
		resolveModel: vi.fn(() => {
			throw new Error("resolveModel must not be called");
		}),
		ensureConfig: vi.fn(),
	};
	registerCompactionHook(pi as any, runtime as any);
	if (!handler) throw new Error("compaction handler was not registered");
	const ctx = {
		cwd: "/tmp/project",
		hasUI: true,
		ui: { notify: vi.fn() },
		sessionManager: { getBranch: vi.fn(() => args.entries) },
	};
	const run = (firstKeptEntryId = args.entries.at(-1)?.id ?? "missing") => handler!({
		preparation: { firstKeptEntryId, tokensBefore: 123 },
		branchEntries: args.entries,
		signal: undefined,
	}, ctx);
	return { pi, runtime, ctx, run };
}

describe("V3 compaction hook", () => {
	it("cancels compaction when no source history is acknowledged", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime, pi } = setup({ entries });

		const result = await run("raw-1");

		expect(result).toEqual({ cancel: true });
		expect(runtime.resolveModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(runtime.compactHookInFlight).toBe(false);
	});

	it("first normal compaction writes covered observations without orphan reflections", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { sourceEntryIds: ["raw-1"], tokenCount: 10 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const entries = [
			textCustomMessage("raw-0", "earlier routine source"),
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-1") as any;

		expect(result.compaction.details.fullFold).toBe(false);
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa"]);
		expect(result.compaction.details.reflections).toEqual([]);
		expect(result.compaction.summary).toContain("## Observations");
		expect(result.compaction.summary).not.toContain("## Reflections");
	});

	it("writes a normal V3 projection without applying new reflections or drops", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 5 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 5 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-2") as any;

		expect(result.compaction.details).toMatchObject({ type: "om.folded", version: 1, fullFold: false });
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
		expect(result.compaction.details.reflections.map((ref: any) => ref.id)).toEqual(["eeeeeeeeeeee"]);
		expect(result.compaction.summary).toContain("## Reflections\n[eeeeeeeeeeee]");
		expect(result.compaction.summary).toContain("## Observations");
	});

	it("writes a full V3 projection when observation pool pressure reaches the threshold", async () => {
		const obs1 = observation("aaaaaaaaaaaa", { tokenCount: 80 });
		const obs2 = observation("bbbbbbbbbbbb", { tokenCount: 30 });
		const ref1 = reflection("eeeeeeeeeeee", ["aaaaaaaaaaaa"]);
		const ref2 = reflection("ffffffffffff", ["bbbbbbbbbbbb"]);
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			observationsRecordedEntry("om-aaaaaaaaaaaa", { observations: [obs1], coversUpToId: "raw-1" }),
			reflectionsRecordedEntry("om-eeeeeeeeeeee", { reflections: [ref1], coversUpToId: "raw-1" }),
			compactionEntry("cmp-full", { firstKeptEntryId: "raw-1", details: memoryDetails({ fullFold: true, observations: [obs1], reflections: [ref1] }) }),
			textCustomMessage("raw-2", "bbbb"),
			observationsRecordedEntry("om-bbbbbbbbbbbb", { observations: [obs2], coversUpToId: "raw-2" }),
			reflectionsRecordedEntry("om-ffffffffffff", { reflections: [ref2], coversUpToId: "raw-2" }),
			observationsDroppedEntry("om-drop-2", { observationIds: ["aaaaaaaaaaaa"], coversUpToId: "raw-2" }),
		];
		const { run } = setup({ entries, observationsPoolMaxTokens: 100 });

		const result = await run("raw-2") as any;

		expect(result.compaction.details.fullFold).toBe(true);
		expect(result.compaction.details.observations.map((obs: any) => obs.id)).toEqual(["bbbbbbbbbbbb"]);
		expect(result.compaction.details.reflections.map((ref: any) => ref.id)).toEqual(["eeeeeeeeeeee", "ffffffffffff"]);
	});

	it("does not let old V2 memory bypass observer coverage safety", async () => {
		const entries = [
			textCustomMessage("raw-1", "aaaa"),
			oldV2ObservationEntry("v2-obs"),
			compactionEntry("cmp-v2", { firstKeptEntryId: "raw-1", details: oldV2CompactionDetails() }),
		];
		const { run } = setup({ entries });

		const result = await run("cmp-v2");

		expect(result).toEqual({ cancel: true });
	});

	it("does not wait for worker promises or call model resolution", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, runtime } = setup({ entries });

		const result = await Promise.race([
			run("raw-1"),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 50)),
		]);

		expect(result).toEqual({ cancel: true });
		expect(runtime.resolveModel).not.toHaveBeenCalled();
	});

	it("retains the uncovered user question even when Pi's cut is later", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["old"] });
		const entries = [
			textCustomMessage("old", "acknowledged history"),
			observationsRecordedEntry("om-old", { observations: [obs], coversUpToId: "old" }),
			rawMessage("question", "Compare the AAI reminder methods."),
			textCustomMessage("research", "lookup progress"),
			textCustomMessage("skill", "large research guidance"),
		];
		const { run } = setup({ entries });
		await expect(run("skill")).resolves.toMatchObject({ compaction: { firstKeptEntryId: "question", tokensBefore: 123 } });
	});

	it("preserves Pi's earlier recent boundary and includes acknowledged overlapping memory", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["old", "recent"] });
		const entries = [
			textCustomMessage("old", "old source"),
			textCustomMessage("recent", "recent source"),
			textCustomMessage("covered", "last acknowledged source"),
			observationsRecordedEntry("om-covered", { observations: [obs], coversUpToId: "covered" }),
			rawMessage("question", "new request"),
		];
		const { run } = setup({ entries });
		await expect(run("recent")).resolves.toMatchObject({ compaction: {
			firstKeptEntryId: "recent",
			details: { observations: [obs] },
		} });
	});

	it("compacts an acknowledged empty prefix without falling back to native summarization", async () => {
		const entries = [
			textCustomMessage("old", "routine history"),
			observationsRecordedEntry("om-empty", { observations: [], coversUpToId: "old" }),
			rawMessage("question", "unprocessed request"),
		];
		const { run } = setup({ entries });
		await expect(run("question")).resolves.toMatchObject({ compaction: {
			firstKeptEntryId: "question",
			summary: "",
			details: { observations: [], reflections: [] },
		} });
	});

	it("retains the caller and both results of a partially covered tool batch without losing its memory", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["old", "call", "result-a"] });
		const entries = [
			textCustomMessage("old", "older source"),
			rawMessage("call", "", { message: { role: "assistant", content: [
				{ type: "toolCall", id: "tool-a", name: "lookup", arguments: {} },
				{ type: "toolCall", id: "tool-b", name: "lookup", arguments: {} },
			] } }),
			rawMessage("result-a", "", { message: { role: "toolResult", toolCallId: "tool-a", content: [] } }),
			observationsRecordedEntry("om-covered", { observations: [obs], coversUpToId: "result-a" }),
			rawMessage("result-b", "", { message: { role: "toolResult", toolCallId: "tool-b", content: [] } }),
			rawMessage("question", "next request"),
		];
		const { run } = setup({ entries });
		await expect(run("question")).resolves.toMatchObject({ compaction: {
			firstKeptEntryId: "call",
			details: { observations: [obs] },
		} });
	});

	it("can move the raw cut across a prior compaction to restore an intact tool exchange", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["old"] });
		const entries = [
			textCustomMessage("old", "older source"),
			observationsRecordedEntry("om-old", { observations: [obs], coversUpToId: "old" }),
			rawMessage("call", "", { message: { role: "assistant", content: [{ type: "toolCall", id: "tool-a", name: "lookup", arguments: {} }] } }),
			compactionEntry("previous", { firstKeptEntryId: "old", details: memoryDetails({ observations: [obs] }) }),
			rawMessage("result", "", { message: { role: "toolResult", toolCallId: "tool-a", content: [] } }),
		];
		const { run } = setup({ entries });
		await expect(run("result")).resolves.toMatchObject({ compaction: { firstKeptEntryId: "call" } });
	});

	it("preserves a full-fold checkpoint's maintenance state after retaining an overlapping tool batch", async () => {
		const obsA = observation("aaaaaaaaaaaa", { sourceEntryIds: ["old"], tokenCount: 80 });
		const obsB = observation("bbbbbbbbbbbb", { sourceEntryIds: ["call", "result-a"], tokenCount: 30 });
		const refA = reflection("eeeeeeeeeeee", [obsA.id]);
		const refB = reflection("ffffffffffff", [obsB.id]);
		const entries = [
			textCustomMessage("old", "older source"),
			observationsRecordedEntry("om-a", { observations: [obsA], coversUpToId: "old" }),
			reflectionsRecordedEntry("ref-a", { reflections: [refA], coversUpToId: "old" }),
			observationsDroppedEntry("drop-a", { observationIds: [obsA.id], coversUpToId: "old" }),
			rawMessage("call", "", { message: { role: "assistant", content: [
				{ type: "toolCall", id: "tool-a", name: "lookup", arguments: {} },
				{ type: "toolCall", id: "tool-b", name: "lookup", arguments: {} },
			] } }),
			rawMessage("result-a", "", { message: { role: "toolResult", toolCallId: "tool-a", content: [] } }),
			observationsRecordedEntry("om-b", { observations: [obsB], coversUpToId: "result-a" }),
			reflectionsRecordedEntry("ref-b", { reflections: [refB], coversUpToId: "result-a" }),
			rawMessage("result-b", "", { message: { role: "toolResult", toolCallId: "tool-b", content: [] } }),
		];
		entries.push(rawMessage("pending", "continue the request"));
		const first = await setup({ entries, observationsPoolMaxTokens: 100 }).run("pending") as {
			compaction: { firstKeptEntryId: string; details: MemoryDetails };
		};
		expect(first.compaction).toMatchObject({ firstKeptEntryId: "call", details: {
			fullFold: true, observations: [obsB], reflections: [refA, refB],
		} });

		const nextEntries = [
			...entries,
			compactionEntry("checkpoint", first.compaction),
			observationsRecordedEntry("om-empty", { observations: [], coversUpToId: "result-b" }),
			rawMessage("question", "next request"),
		];
		await expect(setup({ entries: nextEntries, observationsPoolMaxTokens: 100 }).run("question")).resolves.toMatchObject({
			compaction: { details: { fullFold: false, observations: [obsB], reflections: [refA, refB] } },
		});
	});

	it("cancels consecutive attempts when the retained prefix cannot make further progress", async () => {
		const obs = observation("aaaaaaaaaaaa", { sourceEntryIds: ["old"] });
		const entries = [
			textCustomMessage("old", "already removed source"),
			observationsRecordedEntry("om-old", { observations: [obs], coversUpToId: "old" }),
			rawMessage("question", "unprocessed request"),
			compactionEntry("previous", { firstKeptEntryId: "question", details: memoryDetails({ observations: [obs] }) }),
			textCustomMessage("research", "more unprocessed source"),
		];
		const { run, runtime, pi } = setup({ entries });
		await expect(run("research")).resolves.toEqual({ cancel: true });
		await expect(run("research")).resolves.toEqual({ cancel: true });
		expect(runtime.compactHookInFlight).toBe(false);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("cancels rather than pass Pi an unknown cut", async () => {
		const entries = [
			textCustomMessage("old", "older source"),
			observationsRecordedEntry("om-empty", { observations: [], coversUpToId: "old" }),
			rawMessage("question", "new request"),
		];
		const { run } = setup({ entries });
		await expect(run("unknown")).resolves.toEqual({ cancel: true });
	});

	it("cancels duplicate in-flight compaction and notifies the UI", async () => {
		const entries = [textCustomMessage("raw-1", "aaaa")];
		const { run, ctx } = setup({ entries, compactHookInFlight: true });

		await expect(run("raw-1")).resolves.toEqual({ cancel: true });
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Observational memory: another compaction is already in progress; cancelling duplicate",
			"warning",
		);
	});
});
