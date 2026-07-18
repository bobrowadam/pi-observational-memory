import {
	isObservationsDroppedData,
	isObservationsRecordedData,
	isApplicableReflectionsConsolidatedData,
	isReflectionsConsolidatedData,
	isReflectionsRecordedData,
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_CONSOLIDATED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type Observation,
	type Reflection,
} from "./types.js";

export type FoldLedgerOptions = {
	/** Fold entries from branch root through this entry id, inclusive. Omit to fold through branch tip. */
	upToEntryId?: string;
};

export type FoldedLedger = {
	/** All first-valid observation records encountered through the fold boundary, including dropped observations. */
	observations: Observation[];
	/** Observation records not tombstoned by a folded drop entry. */
	activeObservations: Observation[];
	/** Tombstoned observation ids, including ids that may not have a corresponding folded observation. */
	droppedObservationIds: Set<string>;
	/** All first-valid reflection records encountered through the fold boundary, including superseded reflections. */
	reflections: Reflection[];
	/** Reflection records not superseded by a folded consolidation entry. */
	activeReflections: Reflection[];
	/** Superseded reflection ids, including ids that may not have a corresponding folded reflection. */
	supersededReflectionIds: Set<string>;
	/** All first-valid observation records by id, including dropped observations. */
	observationsById: Map<string, Observation>;
	/** All first-valid reflection records by id. */
	reflectionsById: Map<string, Reflection>;
};

function foldEndIndex(entries: Entry[], upToEntryId: string | undefined): number {
	if (!upToEntryId) return entries.length - 1;
	const idx = entries.findIndex((entry) => entry.id === upToEntryId);
	return idx === -1 ? entries.length - 1 : idx;
}

function isCustomEntry(entry: Entry, customType: string): boolean {
	return entry.type === "custom" && entry.customType === customType;
}

/**
 * Fold valid V3 memory ledger entries from the branch root through the target entry.
 *
 * Unknown custom entries, old V2 entries, invalid V3-shaped data, and compaction details are ignored.
 * Observations and reflections use first-valid-record-wins semantics. Drops are tombstones and are
 * retained even when the dropped id is unknown at the time of folding.
 */
export function foldLedger(entries: Entry[], options: FoldLedgerOptions = {}): FoldedLedger {
	const observationsById = new Map<string, Observation>();
	const reflectionsById = new Map<string, Reflection>();
	const droppedObservationIds = new Set<string>();
	const supersededReflectionIds = new Set<string>();
	const endIdx = foldEndIndex(entries, options.upToEntryId);

	for (let i = 0; i <= endIdx; i++) {
		const entry = entries[i];
		if (!entry) continue;

		if (isCustomEntry(entry, OM_OBSERVATIONS_RECORDED)) {
			if (!isObservationsRecordedData(entry.data)) continue;
			for (const observation of entry.data.observations) {
				if (!observationsById.has(observation.id)) {
					observationsById.set(observation.id, observation);
				}
			}
			continue;
		}

		if (isCustomEntry(entry, OM_REFLECTIONS_RECORDED)) {
			if (!isReflectionsRecordedData(entry.data)) continue;
			for (const reflection of entry.data.reflections) {
				if (!reflectionsById.has(reflection.id)) {
					reflectionsById.set(reflection.id, reflection);
				}
			}
			continue;
		}

		if (isCustomEntry(entry, OM_REFLECTIONS_CONSOLIDATED)) {
			if (
				!isReflectionsConsolidatedData(entry.data) ||
				!isApplicableReflectionsConsolidatedData(entry.data, reflectionsById, supersededReflectionIds)
			) continue;
			for (const consolidation of entry.data.entries) {
				reflectionsById.set(consolidation.replacement.id, consolidation.replacement);
				for (const reflectionId of consolidation.supersededReflectionIds) {
					supersededReflectionIds.add(reflectionId);
				}
			}
			continue;
		}

		if (isCustomEntry(entry, OM_OBSERVATIONS_DROPPED)) {
			if (!isObservationsDroppedData(entry.data)) continue;
			for (const observationId of entry.data.observationIds) {
				droppedObservationIds.add(observationId);
			}
		}
	}

	const observations = Array.from(observationsById.values());
	const activeObservations = observations.filter((observation) => !droppedObservationIds.has(observation.id));
	const reflections = Array.from(reflectionsById.values());
	const activeReflections = reflections.filter((reflection) => !supersededReflectionIds.has(reflection.id));

	return {
		observations,
		activeObservations,
		droppedObservationIds,
		reflections,
		activeReflections,
		supersededReflectionIds,
		observationsById,
		reflectionsById,
	};
}
