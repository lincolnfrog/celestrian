/**
 * THE SEQUENCE PROGRAM (docs/sequencer.md §6, §14) — the JS mirror of
 * Sequence::finalize's walk in src/sequence.h, pinned bit for bit by
 * `sequence_program_cases` in shared/timing_golden.json.
 *
 * Each step names weighted successors (`step.next = [{to, w}]`; none =
 * the loop successor (i + 1) mod n). The PROGRAM is the walk from step
 * 0, one VISIT per step played: it is the song's timeline. Draws come
 * from a counter hash of (seed, visit), so (steps, seed) always unrolls
 * to the same program.
 *
 * PERIODIC vs RADIO: with one successor at every step the walk visits
 * and a return to step 0, the program is that loop. Otherwise the
 * sequence is a RADIO — no period, root only (S12) — unrolled to
 * MAX_VISITS, after which it repeats. A periodic walk plays each step
 * at most once, and a sequence holds at most 64 steps
 * (Sequence::kMaxSteps), so it closes long before that horizon.
 *
 * The second half reads a PUBLISHED sequence (a node's or the root
 * state's `sequence` metadata); it has no C++ twin and no golden.
 * Leaf module: no imports.
 */

export const MAX_VISITS = 256;

/** lowbias32 — the mixer behind every draw (uint32 in, uint32 out). */
export function mix32(x) {
    x = x >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
}

/** The draw for visit k under `seed` (uint32). */
export function draw(seed, visit) {
    const counter = (Math.imul(visit >>> 0, 0x9e3779b9) + 0x7f4a7c15) >>> 0;
    return mix32(((seed >>> 0) ^ mix32(counter)) >>> 0);
}

/** An entry's `to` or `w` as the engine reads it
 * (Sequence::readSuccessors): an int — a fraction truncates toward
 * zero, anything that is no number reads as 0 — and `absent` when the
 * entry does not carry the key at all. */
function entryInt(value, absent) {
    if (value === undefined) return absent;
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) ? n + 0 : 0;  // + 0: never −0
}

/** The step the walk moves to from `step` at visit `visit`:
 * { to, branched } — branched when a draw decided it. An entry with no
 * `w` weighs 1; one whose weight is not positive, or whose target is no
 * step, names nothing. */
export function successorOf(steps, seed, step, visit) {
    const n = steps.length;
    if (n <= 0) return { to: 0, branched: false };
    const candidates = [];  // [{to, w}] merged by target
    let weightSum = 0;
    for (const s of (steps[step].next || [])) {
        const to = entryInt(s.to, -1), w = entryInt(s.w, 1);
        if (!(to >= 0 && to < n) || !(w > 0)) continue;
        let c = candidates.find(x => x.to === to);
        if (!c) { c = { to, w: 0 }; candidates.push(c); }
        c.w += w;
        weightSum += w;
    }
    if (!candidates.length) return { to: (step + 1) % n, branched: false };
    if (candidates.length === 1) return { to: candidates[0].to, branched: false };
    let r = draw(seed, visit) % weightSum;
    for (const c of candidates) {
        if (r < c.w) return { to: c.to, branched: true };
        r -= c.w;
    }
    return { to: candidates[candidates.length - 1].to, branched: true };
}

/**
 * Unroll (steps, seed) into the program:
 * { visits: [step index…], radio, reachable: [bool per step],
 *   firstVisit: [visit per step, −1 = never] }.
 */
export function programOf(steps, seed = 0) {
    const n = Array.isArray(steps) ? steps.length : 0;
    const visits = [];
    const reachable = new Array(n).fill(false);
    const firstVisit = new Array(n).fill(-1);
    let radio = false;
    if (n <= 0) return { visits, radio, reachable, firstVisit };
    let deterministic = true;
    let step = 0;
    while (visits.length < MAX_VISITS) {
        const k = visits.length;
        visits.push(step);
        reachable[step] = true;
        if (firstVisit[step] < 0) firstVisit[step] = k;
        const { to, branched } = successorOf(steps, seed, step, k);
        if (branched) deterministic = false;
        if (deterministic && to === 0) break;          // the loop closed
        if (deterministic && firstVisit[to] >= 0) radio = true;  // an intro
        step = to;
    }
    if (!deterministic) radio = true;
    return { visits, radio, reachable, firstVisit };
}

/** Visit bounds over `lens` (one length per STEP): [b0, b1, …, bN] —
 * bounds[k] is where visit k starts. */
export function visitBounds(visits, lens) {
    const b = [0];
    for (const s of visits) {
        const len = lens[s] > 0 ? lens[s] : 0;
        b.push(b[b.length - 1] + len);
    }
    return b;
}

/** A fresh random seed (uint32) — the re-roll verb's input. */
export function randomSeed() {
    return (Math.random() * 0x100000000) >>> 0;
}

/* ---- A PUBLISHED sequence: { steps, seed, bypassed, program?, radio?,
 *      auditionStep?, gates } on a stack node or the root state ---- */

/** The published sequence of `holder` (a stack node, or the state for
 * the island root); null when it has no steps. */
export function publishedSequence(holder) {
    const s = holder && holder.sequence;
    return s && Array.isArray(s.steps) && s.steps.length ? s : null;
}

/** The visits the backend published as `program` (out-of-range entries
 * dropped), or null when it published none. */
function publishedVisits(s) {
    if (!Array.isArray(s.program) || !s.program.length) return null;
    return s.program.filter(i => Number.isInteger(i) && i >= 0 &&
                                 i < s.steps.length);
}

/**
 * The PROGRAM of a published sequence `s` (the shape programOf
 * returns): the engine and the mock publish the visits as `program`; a
 * state without one unrolls (steps, seed) here.
 */
export function sequenceProgram(s) {
    if (!s || !Array.isArray(s.steps) || !s.steps.length) {
        return { visits: [], radio: false, reachable: [], firstVisit: [] };
    }
    const visits = publishedVisits(s);
    if (!visits) return programOf(s.steps, s.seed || 0);
    return {
        visits,
        radio: !!s.radio,
        reachable: s.steps.map((_, i) => visits.includes(i)),
        firstVisit: s.steps.map((_, i) => visits.indexOf(i)),
    };
}

/** The visits alone (the step index of each), without the per-step
 * facts sequenceProgram derives. */
export function sequenceVisits(s) {
    if (!s || !Array.isArray(s.steps) || !s.steps.length) return [];
    return publishedVisits(s) || programOf(s.steps, s.seed || 0).visits;
}

/** A published sequence's length in samples: its visits CONCATENATE
 * (S10), each a whole number of samples. */
export function sequenceTotalSamples(s) {
    const lens = s.steps.map(x => (x.len > 0 ? Math.round(x.len) : 0));
    return sequenceVisits(s).reduce((t, i) => t + lens[i], 0);
}

/** The ACTIVE sequence length of a holder in samples — the period law's
 * `seqLen` (docs/sequencer.md §2). 0 with no sequence, or a bypassed
 * one. */
export function activeSequenceSamples(holder) {
    const s = publishedSequence(holder);
    return s && !s.bypassed ? sequenceTotalSamples(s) : 0;
}

/** The step a published sequence auditions (§11.2), or −1. */
export function auditionStepOf(s) {
    const i = s && Number.isInteger(s.auditionStep) ? s.auditionStep : -1;
    return i >= 0 && Array.isArray(s.steps) && i < s.steps.length ? i : -1;
}

/**
 * Whether a holder's published window is a STEP AUDITION's derived map
 * (§11.2) and not an authored one: a monitoring loop over the song, so
 * it sets what is heard and never a part's length.
 */
export function isAuditionWindow(holder) {
    const s = holder && holder.sequence;
    return !!s && !s.bypassed && auditionStepOf(s) >= 0;
}
