/**
 * KNOWN DRIFT: where the mock publishes something else than the engine
 * for the same verbs and the same passage of time, as the differential
 * harness finds it today (run.mjs). The suite is green while every diff
 * is claimed here and every claim here still claims a diff — so the
 * list can only shrink: fix the mock (or the engine), the claim goes
 * stale, the run fails until the entry is deleted. It is EMPTY: the two
 * sides agree on every journey and every walk.
 *
 * A FAMILY is one cause:
 *   id, title   — what differs, in a line
 *   verb        — the verb the report files it under
 *   right       — 'engine' | 'mock' | 'unclear': which side is right
 *   engineBug   — true when the diff looks like an ENGINE bug, not drift;
 *                 `engineSuspect` is then the one line of evidence. The
 *                 mock is left as it is until the engine is ruled on.
 *   why         — one line: the spec or the code that says which side
 *   everywhere  — [{ field, verb?, scope?, engine?, mock? }]: the diff is
 *                 this family's wherever the field differs like this
 *   sites       — SITES[id]: these exact diffs — this journey, this
 *                 step, this key, these two values (engine, mock).
 *                 A site may carry `ends: true`: the two sides have
 *                 parted for good and the journey stops there.
 *
 * KNOWN_WALK: what ends a random walk (walk.mjs) — { family, verb,
 * field, engine?, mock?, when?(engineState, mockState) }: a diff of this
 * field at this verb is that family's drift, reached by a sequence no
 * journey spells out.
 *
 * KNOWN_KEYS: the raw keys one side publishes and the other never does,
 * per record kind — matched exactly in a full run.
 *
 * To list the sites of a new family: `node ui/differential/run.mjs
 * --emit` prints every unclaimed diff as a site — one journey's as
 * `{ journey, step, key, engine, mock }` rows.
 */

/** family id → its sites. */
const SITES = {};

const FAMILIES = [];

export const KNOWN_DRIFT = FAMILIES.map(f => ({ ...f, sites: SITES[f.id] || [] }));

for (const id of Object.keys(SITES)) {
    if (!FAMILIES.some(f => f.id === id)) throw new Error(`known_drift: sites for no family: ${id}`);
}

export const KNOWN_WALK = [];

export const KNOWN_KEYS = {};
