# Concepts

This page defines the V3 vocabulary used by `pi-observational-memory`.

## The big picture

Long Pi sessions eventually outgrow the model context window. Pi solves that by compacting older messages into a summary while keeping recent messages verbatim. This extension makes that summary more durable by maintaining a branch-local memory ledger while the session happens.

In V3, the ledger is the source of truth. Compaction entries contain what the agent sees, but memory state is reconstructed by folding V3 ledger entries on the current branch.

## Memory layers

### Observations

An observation is a timestamped event from the conversation.

Shape:

```ts
type Observation = {
  id: string;                 // deterministic 12-character lowercase hex id
  content: string;            // single-line plain prose
  timestamp: string;          // YYYY-MM-DD HH:MM
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];   // raw/source entries that support this observation
  tokenCount: number;         // estimated content tokens
}
```

Rendered in summaries/views:

```md
[d4e5f6a1b2c3] 2026-01-15 14:30 [high] User decided to switch from REST to GraphQL for the public API; motivation was reducing over-fetching on mobile clients.
```

Observations are written by the observer into `om.observations.recorded` ledger entries. They are factual event records, not durable conclusions.

### Reflections

A reflection is a durable conclusion distilled from observations: user preferences, project constraints, architectural decisions, recurring behavior, or long-lived facts.

Shape:

```ts
type Reflection = {
  id: string;                         // deterministic 12-character lowercase hex id
  content: string;                    // single-line plain prose
  supportingObservationIds: string[]; // evidence observations
  tokenCount: number;                 // estimated content tokens
}
```

Rendered:

```md
[a1b2c3d4e5f6] User works at Acme Corp building Acme Dashboard on Next.js 15 with Supabase auth.
```

Reflections are written by the reflector into `om.reflections.recorded` ledger entries. They should be fewer and more durable than observations; the reflector should not turn every observation into a reflection. The reflector receives each active observation with a deterministic coverage tier (`none`, `partial`, or `strong`) so it can review durable facts that are not yet preserved, but coverage is review context rather than a quota or automatic reflection rule.

A reflection's `supportingObservationIds` are downstream dropper coverage evidence. They should include all and only current observations whose durable meaning the reflection preserves with equivalent fidelity. False or inflated support ids can make later pruning look safer than it is.

`reflectionsPoolMaxTokens` is a soft trigger threshold for the active reflection pool, not a hard upper bound. When the active reflection pool is strictly above it, the consolidator may replace groups of active reflections with shorter reflections toward `reflectionsPoolTargetTokens`. A safe reduction can preserve the supporting observation ids as an ordered union. If no safe reduction is produced, the active pool can remain over max while its unchanged fingerprint enters cooldown; another attempt becomes eligible when the pool changes.

### Drops

A drop is a tombstone for observation ids that should no longer be active memory. Drops are written by the dropper into `om.observations.dropped` ledger entries.

Dropping does not delete history. Dropped observations remain recallable from ledger history, but they are not active observations in projections.

## Actors

### Observer

The observer runs asynchronously from `agent_start` or `turn_end` when raw/source tokens after the latest observation coverage marker reach `observeAfterTokens`. After a deliberate empty result, it waits for another `observeAfterTokens` of source tokens before retrying the uncovered range.

It receives an oldest-first chunk of raw/source entries, validates source ids, and appends a non-empty `om.observations.recorded` entry. Chunking targets a fixed 60,000 estimated tokens but always includes at least one entry, so a single oversized entry cannot stall coverage. If there is nothing worth recording, it writes no entry and leaves the raw range uncovered.

### Reflector

The reflector is the second stage in the observer → reflector → consolidator → dropper pipeline. On each triggered `agent_start` or `turn_end` run, it is checked after the observer stage; when its raw-token clock reaches `reflectAfterTokens`, it runs against the observer's current coverage, including successful same-run observer output.

It reads active observations and current reflections, then appends durable new reflections as `om.reflections.recorded`. Reflections must cite valid supporting observation ids. The reflector's coverage annotations describe current support state only; this first coverage-stewardship model does not repair historical coverage on existing reflections that already missed a supporting observation id.

### Consolidator

The consolidator is the third stage in the background pipeline: observer → reflector → consolidator → dropper. The same run continues to this stage after the reflector stage completes or is skipped, and it runs only when the folded active reflection pool is strictly above the soft `reflectionsPoolMaxTokens` trigger. It receives active reflections, not superseded history, and proposes safe shorter replacements toward `reflectionsPoolTargetTokens`. It may reduce fewer reflections than needed or produce no output when reduction would lose durable meaning, leaving the pool over max. After a no-output attempt, the unchanged active reflection pool is cooled down until its fingerprint changes.

### Dropper

The dropper is the final stage in the observer → reflector → consolidator → dropper pipeline. It runs only as post-reflection maintenance: after the reflector records non-empty same-turn reflections, it may run if the folded active observation ledger is over `observationsPoolTargetTokens`. The dropper can see same-turn new reflections before deciding what to prune. Consolidator output is not required for dropper eligibility.

The dropper can only drop active observation ids. It cannot rewrite or merge observations. Relevance is treated as importance/resistance rather than an absolute lock: `critical` observations are the highest-resistance candidates, but they can be dropped when the model judges that age, reflection coverage, supersession, redundancy, and semantic safety make removal from active memory safe. Its maximum drop count is computed from tokens over target converted to an approximate observation count, and the model may drop fewer or none.

### Compaction hook

The compaction hook runs during `session_before_compact`. In V3 it is deterministic and model-free:

- it does not run observer, reflector, consolidator, or dropper;
- it does not call a model;
- it does not wait for background memory workers;
- it folds/projects ledger state and renders the summary.

This is the main reason V3 compactions should feel instantaneous compared with V2.

## Ledger entries

V3 uses four custom memory ledger entry types:

```ts
om.observations.recorded: {
  observations: Observation[];
  coversUpToId: string;
}

om.reflections.recorded: {
  reflections: Reflection[];
  coversUpToId: string;
}

om.reflections.consolidated: {
  entries: {
    replacement: Reflection;
    supersededReflectionIds: string[];
  }[];
  coversUpToId: string;
}

om.observations.dropped: {
  observationIds: string[];
  coversUpToId: string;
}
```

`om.reflections.consolidated` is append-only: it records replacement reflections and the active reflection ids each replacement supersedes; it never edits or deletes the earlier records. Folded active memory excludes superseded reflections, while full ledger history retains both active and superseded records.

The compaction hook writes V3 folded details on Pi compaction entries:

```ts
type MemoryDetails = {
  type: "om.folded";
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
}
```

Old V2 memory entry/details formats are ignored.

## `coversUpToId`

`coversUpToId` is a progress watermark. It tells V3 where a worker's raw/source-token progress has reached.

It is not:

- source provenance;
- a dependency pointer;
- proof that a later memory ledger entry caused another one.

Source provenance lives on `Observation.sourceEntryIds` and `Reflection.supportingObservationIds`.

Progress counting uses raw/source tokens after the marker. Raw/source entries are `message`, `custom_message`, and `branch_summary` entries; memory ledger entries and compaction entries do not add raw-token progress. A consolidation entry's `coversUpToId` anchors its projection boundary, but `om.reflections.consolidated` does not advance raw source coverage or reflection coverage (the reflector's raw-token coverage clock); those clocks advance only from their corresponding recorded entries.

## Visible, full, and drift

V3 distinguishes visible memory, full memory, and the drift between them:

- **Visible memory** — what the latest `om.folded` compaction details made visible to the agent. This is what `/om:view` shows by default.
- **Full memory** — full V3 ledger truth folded at the branch tip. This is what `/om:view full` shows.
- **Drift** — the difference between visible and full memory. Use `/om:status` to inspect visible-vs-full drift.

Visible and full memory can differ intentionally. Background ledger work may happen after the latest compaction, and normal compactions may avoid re-folding reflection/drop effects until full-fold pressure requires it.

## Recall

`recall` is an agent-facing tool, not a search command. It takes a specific 12-character memory id and looks it up in V3 ledger history on the current branch.

Recall can return:

- an observation, marked `active` or `dropped`;
- a reflection plus supporting observations, marked `active` or `superseded`;
- direct and transitive reflection lineage: a replacement reports the reflections it supersedes, while a superseded reflection reports its replacement chain;
- a mixed result if an id collision exists;
- missing/non-source diagnostics when source evidence is unavailable.

Consolidation events store direct replacement links. Recall follows those links transitively, so if `A` is replaced by `B` and `B` by `C`, recalling `A` reports `B` and `C` as replacements, while recalling `C` reports `B` and `A` as superseded lineage.

Use recall when compacted memory matters and exact source evidence is needed before acting.

## Relevance tiers

Observation relevance is assigned by the observer:

| Tier | Meaning |
|---|---|
| `critical` | User identity, explicit corrections, hard constraints, completed outcomes, or facts that require the strongest evidence before leaving active memory. |
| `high` | Important decisions, non-trivial technical direction, unresolved blockers, key preferences. |
| `medium` | Useful task-level context and ordinary progress. |
| `low` | Routine status, tool acknowledgements, or details likely re-derivable from nearby context. |

The dropper uses relevance as part of its judgment, but it is not the only signal and it is not a permanent active-memory pin. User assertions, exact decisions, unique identifiers, dated events, errors, and rationale should be preserved unless safely represented by durable reflections or newer memory. Dropping removes observations from active memory, not from ledger history; recall can still recover dropped observations when their ids are known.

## V2 compatibility model

V3 intentionally does not migrate V2 memory. Old V2 settings are ignored, old V2 custom entries/details are ignored, and rollback to V2 after creating V3 ledger entries should be treated as memory reset or visibility loss.

When upgrading from V2, update settings and start a new clean session.

## Glossary

| Term | Meaning |
|---|---|
| Branch | One path through Pi's session tree. V3 memory is branch-local. |
| Ledger | Silent V3 custom memory entries folded from branch root to a point. |
| Observation | Timestamped source-backed event record. |
| Reflection | Durable conclusion backed by observations. |
| Drop | Tombstone that removes an observation id from active memory. |
| Visible memory | Latest folded memory visible to the agent through compaction details. |
| Full memory | Full V3 ledger truth folded at branch tip or another boundary. |
| Full fold | Compaction mode that folds observations, reflections, and drops through the boundary. |
| Progress watermark | `coversUpToId`; marker used for raw-token progress clocks. |
| Observer | Background agent that records observations. |
| Reflector | Background agent that records durable reflections. |
| Consolidator | Background agent that replaces active reflections with shorter reflections. |
| Dropper | Background agent that drops active observations by id. |
| Superseded reflection | Historical reflection replaced by a later consolidation; retained for recall but excluded from active projections. |
| Recall | Agent tool for exact evidence behind a memory id. |

## Where to go next

- [how-it-works.md](how-it-works.md) — runtime lifecycle and data flow.
- [configuration.md](configuration.md) — V3 settings and migration table.
- [../README.md](../README.md) — quick start and V2 upgrade notice.
