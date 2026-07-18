import { describe, expect, it, vi } from "vitest";

import {
	OM_IMPLEMENTATION_MARKER,
	appendImplementationMarker,
	buildImplementationMarker,
	registerImplementationMarker,
	type ImplementationMarker,
} from "../src/implementation-marker.js";
import type { Entry } from "../src/session-ledger/types.js";

const marker: ImplementationMarker = {
	markerVersion: 1,
	package: "pi-observational-memory",
	packageVersion: "3.0.3",
	ledgerGeneration: "v3",
	ledgerSchemaVersion: 3,
	gitCommit: "a".repeat(40),
};

describe("implementation marker", () => {
	it("records package and V3 ledger identity, omitting an unavailable commit", () => {
		expect(buildImplementationMarker()).toMatchObject({
		markerVersion: 1,
		package: "pi-observational-memory",
		packageVersion: "3.0.3",
		ledgerGeneration: "v3",
		ledgerSchemaVersion: 3,
	});
		expect(buildImplementationMarker(() => "a".repeat(40))).toHaveProperty("gitCommit", "a".repeat(40));
		expect(buildImplementationMarker(() => undefined)).not.toHaveProperty("gitCommit");
	});

	it("appends each distinct implementation marker only once", () => {
		const appendEntry = vi.fn();
		expect(appendImplementationMarker([], appendEntry, marker)).toBe(true);
		expect(appendEntry).toHaveBeenCalledWith(OM_IMPLEMENTATION_MARKER, marker);

		const entries: Entry[] = [{
			type: "custom",
			id: "marker-1",
			customType: OM_IMPLEMENTATION_MARKER,
			data: marker,
		}];
		expect(appendImplementationMarker(entries, appendEntry, marker)).toBe(false);

		const newerMarker: ImplementationMarker = { ...marker, gitCommit: "b".repeat(40) };
		expect(appendImplementationMarker(entries, appendEntry, newerMarker)).toBe(true);
		expect(appendEntry).toHaveBeenLastCalledWith(OM_IMPLEMENTATION_MARKER, newerMarker);
		expect(appendEntry).toHaveBeenCalledTimes(2);
	});

	it("checks the complete session ledger on session start", () => {
		let sessionStart: ((event: unknown, ctx: unknown) => unknown) | undefined;
		const appendEntry = vi.fn();
		const pi = {
			on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				if (event === "session_start") sessionStart = handler;
			}),
			appendEntry,
		};

		registerImplementationMarker(pi as never);
		expect(sessionStart).toBeDefined();
		sessionStart?.({}, { sessionManager: { getEntries: () => [] } });
		expect(appendEntry).toHaveBeenCalledWith(OM_IMPLEMENTATION_MARKER, expect.objectContaining({
			package: "pi-observational-memory",
			ledgerGeneration: "v3",
		}));
	});
});
