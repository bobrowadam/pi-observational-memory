import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Entry } from "./session-ledger/types.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { name: string; version: string };

export const OM_IMPLEMENTATION_MARKER = "om.implementation";
export const OM_LEDGER_GENERATION = "v3";
export const OM_LEDGER_SCHEMA_VERSION = 3;

export type ImplementationMarker = {
	markerVersion: 1;
	package: string;
	packageVersion: string;
	ledgerGeneration: typeof OM_LEDGER_GENERATION;
	ledgerSchemaVersion: typeof OM_LEDGER_SCHEMA_VERSION;
	gitCommit?: string;
};

function readGitCommit(): string | undefined {
	const result = spawnSync("git", ["-C", PACKAGE_ROOT, "rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return undefined;

	const commit = result.stdout.trim().toLowerCase();
	return /^[a-f0-9]{40}$/.test(commit) ? commit : undefined;
}

export function buildImplementationMarker(
	resolveGitCommit: () => string | undefined = readGitCommit,
): ImplementationMarker {
	const gitCommit = resolveGitCommit();
	return {
		markerVersion: 1,
		package: packageMetadata.name,
		packageVersion: packageMetadata.version,
		ledgerGeneration: OM_LEDGER_GENERATION,
		ledgerSchemaVersion: OM_LEDGER_SCHEMA_VERSION,
		...(gitCommit === undefined ? {} : { gitCommit }),
	};
}

function isSameImplementation(value: unknown, marker: ImplementationMarker): boolean {
	if (!value || typeof value !== "object") return false;
	return (
		"markerVersion" in value && value.markerVersion === marker.markerVersion &&
		"package" in value && value.package === marker.package &&
		"packageVersion" in value && value.packageVersion === marker.packageVersion &&
		"ledgerGeneration" in value && value.ledgerGeneration === marker.ledgerGeneration &&
		"ledgerSchemaVersion" in value && value.ledgerSchemaVersion === marker.ledgerSchemaVersion &&
		("gitCommit" in value ? value.gitCommit : undefined) === marker.gitCommit
	);
}

function hasImplementationMarker(entries: readonly Entry[], marker: ImplementationMarker): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === OM_IMPLEMENTATION_MARKER &&
			isSameImplementation(entry.data, marker),
	);
}

export function appendImplementationMarker(
	entries: readonly Entry[],
	appendEntry: (customType: string, data: ImplementationMarker) => unknown,
	marker: ImplementationMarker,
): boolean {
	if (hasImplementationMarker(entries, marker)) return false;
	appendEntry(OM_IMPLEMENTATION_MARKER, marker);
	return true;
}

export function registerImplementationMarker(pi: ExtensionAPI): void {
	const marker = buildImplementationMarker();
	pi.on("session_start", (_event, ctx) => {
		appendImplementationMarker(
			ctx.sessionManager.getEntries() as Entry[],
			(customType, data) => pi.appendEntry(customType, data),
			marker,
		);
	});
}
