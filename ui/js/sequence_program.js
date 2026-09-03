/**
 * THE SEQUENCE PROGRAM (docs/sequencer.md §6, §14) — the JS mirror of
 * Sequence::finalize's walk in src/sequence.h, pinned bit for bit by
 * shared/timing_golden.json (`sequence_program_cases`).
 *
 * A sequence's steps advance by a SUCCESSOR FUNCTION: each step names
 * weighted successors (`step.next = [{to, w}]`; empty = the loop
 * successor (i+1) mod n). The PROGRAM is the walk from step 0 — one
 * VISIT per step played, in order — and it is what the timeline IS.
 *
 * The walk is pure: draws come from a counter hash of the seed and the
 * visit index, so (steps, seed) unrolls to the same program every time.
 *
 * PERIODIC vs RADIO: with one successor everywhere the walk visits and
 * a return to step 0, the program is the loop (a plain song is this
 * with default successors). Otherwise the sequence is a RADIO — no
 * period, root only (S12) — unrolled to the HORIZON (MAX_VISITS), after
 * which it repeats.
 *
 * Leaf module: no imports (mock, view-model and tests all share it).
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

/** The step the walk moves to from `step` at visit `visit`; returns
 * { to, branched } — branched when a draw decided it. */
export function successorOf(steps, seed, step, visit) {
    const n = steps.length;
    if (n <= 0) return { to: 0, branched: false };
    const candidates = [];  // [{to, w}] merged by target
    let weightSum = 0;
    for (const s of (steps[step].next || [])) {
        const to = Number(s.to), w = Number(s.w);
        if (!(to >= 0 && to < n) || !(w > 0) || !Number.isInteger(to)) continue;
        let c = candidates.find(x => x.to === to);
        if (!c) { c = { to, w: 0 }; candidates.push(c); }
        c.w += Math.floor(w);
        weightSum += Math.floor(w);
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
 * Unroll (steps, seed) into the program. Steps carry `next` (optional)
 * and any length field the caller wants summed via `lenOf`.
 * Returns { visits: [stepIdx…], radio, reachable: [bool per step],
 *           firstVisit: [visit per step, −1 = never] }.
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
    if (deterministic && !radio && visits.length >= MAX_VISITS) radio = true;
    return { visits, radio, reachable, firstVisit };
}

/** Visit bounds over `lens` (one length per STEP): [b0, b1, …, bN]
 * for the program's visits — bounds[k] is where visit k starts. */
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
