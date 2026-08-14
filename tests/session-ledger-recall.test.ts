import { describe, expect, it } from "vitest";
import { recallMemorySources, type Entry, type Observation, type Reflection } from "../src/session-ledger/recall.js";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_CONSOLIDATED,
	OM_REFLECTIONS_RECORDED,
} from "../src/session-ledger/types.js";

const OBS_1 = "aaaaaaaaaaaa";
const OBS_2 = "bbbbbbbbbbbb";
const REF_1 = "cccccccccccc";
const SAME_ID = "dddddddddddd";
const MISSING_OBS = "eeeeeeeeeeee";

function sourceEntry(id: string, content = `source ${id}`): Entry {
	return {
		type: "custom_message",
		id,
		timestamp: "2026-05-19T00:00:00.000Z",
		content,
	};
}

function nonSourceEntry(id: string): Entry {
	return {
		type: "custom",
		id,
		customType: "not-source",
		data: {},
	};
}

function observation(overrides: Partial<Observation> & Pick<Observation, "id" | "sourceEntryIds">): Observation {
	return {
		content: `Observation ${overrides.id}`,
		timestamp: "2026-05-19 00:00",
		relevance: "high",
		tokenCount: 4,
		...overrides,
	};
}

function reflection(overrides: Partial<Reflection> & Pick<Reflection, "id" | "supportingObservationIds">): Reflection {
	return {
		content: `Reflection ${overrides.id}`,
		tokenCount: 5,
		...overrides,
	};
}

function observationsEntry(id: string, observations: Observation[], coversUpToId = "src-1"): Entry {
	return {
		type: "custom",
		id,
		customType: OM_OBSERVATIONS_RECORDED,
		data: { observations, coversUpToId },
	};
}

function reflectionsEntry(id: string, reflections: Reflection[], coversUpToId = "src-1"): Entry {
	return {
		type: "custom",
		id,
		customType: OM_REFLECTIONS_RECORDED,
		data: { reflections, coversUpToId },
	};
}

function consolidationsEntry(
	id: string,
	entries: Array<{ replacement: Reflection; supersededReflectionIds: string[] }>,
	coversUpToId = "src-1",
): Entry {
	return {
		type: "custom",
		id,
		customType: OM_REFLECTIONS_CONSOLIDATED,
		data: { entries, coversUpToId },
	};
}

function dropsEntry(id: string, observationIds: string[], coversUpToId = "src-1"): Entry {
	return {
		type: "custom",
		id,
		customType: OM_OBSERVATIONS_DROPPED,
		data: { observationIds, coversUpToId },
	};
}

describe("session-ledger recall", () => {
	it("recalls an active observation with source entries", () => {
		const entries = [
			sourceEntry("src-1", "important source"),
			observationsEntry("obs-entry-1", [observation({ id: OBS_1, sourceEntryIds: ["src-1"] })]),
		];

		const result = recallMemorySources(entries, OBS_1);

		expect(result.status).toBe("found");
		if (result.status !== "found") return;
		expect(result.kind).toBe("observation");
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0].observation.id).toBe(OBS_1);
		expect(result.observations[0].status).toBe("active");
		expect(result.observations[0].sourceEntries.map((entry) => entry.id)).toEqual(["src-1"]);
		expect(result.partial).toBe(false);
	});

	it("recalls a dropped observation and preserves source evidence", () => {
		const entries = [
			sourceEntry("src-1"),
			observationsEntry("obs-entry-1", [observation({ id: OBS_1, sourceEntryIds: ["src-1"] })]),
			dropsEntry("drop-entry-1", [OBS_1]),
		];

		const result = recallMemorySources(entries, OBS_1);

		expect(result.status).toBe("found");
		if (result.status !== "found") return;
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0].status).toBe("dropped");
		expect(result.observations[0].sourceEntries.map((entry) => entry.id)).toEqual(["src-1"]);
	});

	it("recalls a reflection with supporting observations", () => {
		const entries = [
			sourceEntry("src-1"),
			sourceEntry("src-2"),
			observationsEntry("obs-entry-1", [
				observation({ id: OBS_1, sourceEntryIds: ["src-1"] }),
				observation({ id: OBS_2, sourceEntryIds: ["src-2"] }),
			]),
			reflectionsEntry("ref-entry-1", [reflection({ id: REF_1, supportingObservationIds: [OBS_1, OBS_2] })]),
		];

		const result = recallMemorySources(entries, REF_1);

		expect(result.status).toBe("found");
		if (result.status !== "found") return;
		expect(result.kind).toBe("reflection");
		expect(result.reflections.map((match) => match.reflection.id)).toEqual([REF_1]);
		expect(result.observations.map((match) => match.observation.id)).toEqual([OBS_1, OBS_2]);
		expect(result.sourceEntries.map((entry) => entry.id)).toEqual(["src-1", "src-2"]);
		expect(result.partial).toBe(false);
	});

	it("recalls historical superseded reflections and replacement lineage", () => {
		const original = reflection({ id: REF_1, supportingObservationIds: [OBS_1] });
		const replacement = reflection({ id: "ffffffffffff", supportingObservationIds: [OBS_1] });
		const entries = [
			sourceEntry("src-1"),
			observationsEntry("obs-entry-1", [observation({ id: OBS_1, sourceEntryIds: ["src-1"] })]),
			reflectionsEntry("ref-entry-1", [original]),
			consolidationsEntry("consolidated-entry-1", [{ replacement, supersededReflectionIds: [original.id] }]),
		];

		const originalResult = recallMemorySources(entries, original.id);
		const replacementResult = recallMemorySources(entries, replacement.id);

		expect(originalResult.status).toBe("found");
		expect(replacementResult.status).toBe("found");
		if (originalResult.status !== "found" || replacementResult.status !== "found") return;
		expect(originalResult.reflections[0]).toMatchObject({
			status: "superseded",
			directlySupersededByReflectionIds: [replacement.id],
			supersededByReflectionIds: [replacement.id],
		});
		expect(replacementResult.reflections[0]).toMatchObject({
			status: "active",
			directlySupersedesReflectionIds: [original.id],
			supersedesReflectionIds: [original.id],
		});
		expect(replacementResult.observations.map((match) => match.observation.id)).toEqual([OBS_1]);
	});

	it("ignores invalid consolidation lineage and reports valid lineage transitively", () => {
		const original = reflection({ id: REF_1, supportingObservationIds: [OBS_1] });
		const atomicReplacement = reflection({ id: "111111111111", supportingObservationIds: [OBS_1] });
		const unknownReplacement = reflection({ id: "222222222222", supportingObservationIds: [OBS_1] });
		const middle = reflection({ id: "ffffffffffff", supportingObservationIds: [OBS_1] });
		const head = reflection({ id: "999999999999", supportingObservationIds: [OBS_1] });
		const staleReplacement = reflection({ id: "888888888888", supportingObservationIds: [OBS_1] });
		const entries = [
			sourceEntry("src-1"),
			observationsEntry("obs-entry-1", [observation({ id: OBS_1, sourceEntryIds: ["src-1"] })]),
			reflectionsEntry("ref-entry-1", [original]),
			consolidationsEntry("atomic-noop", [
				{ replacement: atomicReplacement, supersededReflectionIds: [original.id] },
				{ replacement: unknownReplacement, supersededReflectionIds: ["aaaaaaaa0000"] },
			]),
			consolidationsEntry("valid-middle", [{ replacement: middle, supersededReflectionIds: [original.id] }]),
			consolidationsEntry("valid-head", [{ replacement: head, supersededReflectionIds: [middle.id] }]),
			consolidationsEntry("stale-noop", [{ replacement: staleReplacement, supersededReflectionIds: [original.id] }]),
			consolidationsEntry("reused-noop", [{ replacement: original, supersededReflectionIds: [head.id] }]),
		];

		const originalResult = recallMemorySources(entries, original.id);
		const headResult = recallMemorySources(entries, head.id);

		expect(recallMemorySources(entries, atomicReplacement.id).status).toBe("not_found");
		expect(recallMemorySources(entries, unknownReplacement.id).status).toBe("not_found");
		expect(recallMemorySources(entries, staleReplacement.id).status).toBe("not_found");
		expect(originalResult.status).toBe("found");
		expect(headResult.status).toBe("found");
		if (originalResult.status !== "found" || headResult.status !== "found") return;
		expect(originalResult.reflections[0]).toMatchObject({
			status: "superseded",
			supersededByReflectionIds: [middle.id, head.id],
		});
		expect(headResult.reflections[0]).toMatchObject({
			status: "active",
			directlySupersedesReflectionIds: [middle.id],
			supersedesReflectionIds: [middle.id, original.id],
		});
	});

	it("marks supporting observations as dropped when recalling a reflection", () => {
		const entries = [
			sourceEntry("src-1"),
			observationsEntry("obs-entry-1", [observation({ id: OBS_1, sourceEntryIds: ["src-1"] })]),
			reflectionsEntry("ref-entry-1", [reflection({ id: REF_1, supportingObservationIds: [OBS_1] })]),
			dropsEntry("drop-entry-1", [OBS_1]),
		];

		const result = recallMemorySources(entries, REF_1);

		expect(result.status).toBe("found");
		if (result.status !== "found") return;
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0].status).toBe("dropped");
	});

	it("reports missing and non-source source ids as partial recall", () => {
		const entries = [
			nonSourceEntry("custom-1"),
			observationsEntry("obs-entry-1", [
				observation({ id: OBS_1, sourceEntryIds: ["missing-src", "custom-1"] }),
			]),
		];

		const result = recallMemorySources(entries, OBS_1);

		expect(result.status).toBe("found");
		if (result.status !== "found") return;
		expect(result.partial).toBe(true);
		expect(result.missingSourceEntryIds).toEqual(["missing-src"]);
		expect(result.nonSourceEntryIds).toEqual(["custom-1"]);
		expect(result.observations[0].sourceEntries).toEqual([]);
	});

	it("reports missing supporting observations as partial reflection recall", () => {
		const entries = [
			reflectionsEntry("ref-entry-1", [reflection({ id: REF_1, supportingObservationIds: [MISSING_OBS] })]),
		];

		const result = recallMemorySources(entries, REF_1);

		expect(result.status).toBe("found");
		if (result.status !== "found") return;
		expect(result.partial).toBe(true);
		expect(result.missingSupportingObservationIds).toEqual([MISSING_OBS]);
		expect(result.observations).toEqual([]);
	});

	it("returns not_found for unknown ids", () => {
		const entries = [
			sourceEntry("src-1"),
			observationsEntry("obs-entry-1", [observation({ id: OBS_1, sourceEntryIds: ["src-1"] })]),
		];

		const result = recallMemorySources(entries, "ffffffffffff");

		expect(result).toMatchObject({
			status: "not_found",
			memoryId: "ffffffffffff",
			collision: false,
			partial: false,
		});
	});

	it("ignores old V2 memory entries and details", () => {
		const entries: Entry[] = [
			{
				type: "custom",
				id: "old-obs-entry",
				customType: "om.observation",
				data: {
					records: [observation({ id: OBS_1, sourceEntryIds: ["src-1"] })],
					coversFromId: "src-1",
					coversUpToId: "src-1",
					tokenCount: 10,
				},
			},
			{
				type: "compaction",
				id: "old-compaction",
				firstKeptEntryId: "src-1",
				details: {
					type: "observational-memory",
					version: 4,
					observations: [observation({ id: OBS_2, sourceEntryIds: ["src-1"] })],
					reflections: [reflection({ id: REF_1, supportingObservationIds: [OBS_2] })],
				},
			},
		];

		expect(recallMemorySources(entries, OBS_1).status).toBe("not_found");
		expect(recallMemorySources(entries, OBS_2).status).toBe("not_found");
		expect(recallMemorySources(entries, REF_1).status).toBe("not_found");
	});

	it("reports collisions when an id matches multiple V3 records", () => {
		const entries = [
			sourceEntry("src-1"),
			observationsEntry("obs-entry-1", [observation({ id: SAME_ID, sourceEntryIds: ["src-1"] })]),
			reflectionsEntry("ref-entry-1", [reflection({ id: SAME_ID, supportingObservationIds: [SAME_ID] })]),
		];

		const result = recallMemorySources(entries, SAME_ID);

		expect(result.status).toBe("found");
		if (result.status !== "found") return;
		expect(result.kind).toBe("mixed");
		expect(result.collision).toBe(true);
		expect(result.observations).toHaveLength(1);
		expect(result.reflections).toHaveLength(1);
	});
});
