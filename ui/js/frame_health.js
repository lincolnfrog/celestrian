/**
 * THE FRAME-HEALTH BADGE (docs/sequencer.md §9 S10, spec §11.6) — pure
 * functions, no DOM. ONE guardrail, two faces, wired to both sources of
 * frame trouble (coprime takes AND coprime sequence lengths):
 *
 *   BLOWUP — a scope's cycle = lcm(Q, members' effective periods) has
 *     exploded past `kBlowupRatio` × its largest member (11Q beside 12Q
 *     = 132Q). The RESPONSIBLE member is the one whose removal shrinks
 *     the cycle most; the OFFER is the nearest length for it that makes
 *     the cycle collapse (a divisor or multiple of the others' lcm) —
 *     only when it HAS a length knob (a sequenced stack's last step, a
 *     window's length). A take has no knob: badge, no offer.
 *
 *   DRIFT — a sequenced stack whose song length is not a multiple of its
 *     inner cycle (28Q over 12Q): successive passes frame different bars
 *     (§2, the drifting pass). Legitimate and deliberate, never silent;
 *     the offer is the two nearest multiples.
 *
 * Everything is in Q (the VM's unit); samples enter only for the
 * minutes figure. Golden vectors: shared/timing_golden.json
 * "frame_health_cases" (pinned by ui/js/tests/frame_health.test.mjs).
 */

import { lcm } from './math_utils.js';

export const kBlowupRatio = 4;

const EPS = 1e-9;

/** lcm over a list of positive integers-in-Q (0 = empty). */
export function lcmAll(values, seed = 0) {
    let acc = seed > 0 ? Math.round(seed) : 0;
    for (const v of values) {
        if (!(v > 0)) continue;
        const r = Math.round(v);
        acc = acc > 0 ? lcm(acc, r) : r;
    }
    return acc;
}

/**
 * The BLOWUP face for one scope.
 *
 * @param {Array<{id, periodQ, knob}>} members  effective periods in Q
 *        (one-shots / recording lanes already excluded by the caller);
 *        `knob` ∈ 'sequence' | 'window' | null — what can be resized.
 * @param {number} qQ  the island Q in Q-units (1 when Q exists) — kept
 *        as a parameter so a scope can be assessed in any unit.
 * @returns null when healthy, else
 *   { cycleQ, largestQ, ratio, responsibleId, responsiblePeriodQ,
 *     othersQ, offerQ|null }
 */
export function assessBlowup(members, qQ = 1) {
    const live = members.filter(m => m.periodQ > 0);
    if (live.length < 2) return null;
    const cycleQ = lcmAll(live.map(m => m.periodQ), qQ);
    const largestQ = Math.max(...live.map(m => m.periodQ));
    if (!(cycleQ > kBlowupRatio * largestQ + EPS)) return null;
    // Attribution: prefer a member WITH a length knob whose removal
    // would make the scope healthy (the thing you can actually fix);
    // among those, the largest shrink. Only when no knob fixes it, the
    // member whose removal shrinks the cycle most (a coprime take).
    const scored = live.map(m => {
        const rest = live.filter(x => x !== m);
        const othersQ = lcmAll(rest.map(x => x.periodQ), qQ);
        const restLargest = Math.max(...rest.map(x => x.periodQ));
        const fixes = !(othersQ > kBlowupRatio * restLargest + EPS);
        return { m, othersQ, shrink: cycleQ - othersQ, fixes };
    });
    const pick = list => list.reduce((b, s) =>
        (!b || s.shrink > b.shrink + EPS) ? s : b, null);
    const best = pick(scored.filter(s => s.m.knob && s.fixes)) || pick(scored);
    const { m, othersQ } = best;
    return {
        cycleQ,
        largestQ,
        ratio: cycleQ / largestQ,
        responsibleId: m.id,
        responsiblePeriodQ: m.periodQ,
        othersQ,
        offerQ: m.knob ? snapOffer(m.periodQ, othersQ) : null,
    };
}

/**
 * The nearest length to `p` that makes lcm(others, length) ≤ ratio-safe:
 * a whole multiple of `others` (k ≥ 1) or a whole divisor of it. Ties go
 * to the shorter. Returns null when `others` is 0 (nothing to agree
 * with) or when p already agrees.
 */
export function snapOffer(p, others) {
    if (!(others > 0) || !(p > 0)) return null;
    const o = Math.round(others);
    const candidates = new Set();
    const k = Math.max(1, Math.round(p / o));
    candidates.add(k * o);
    if (k > 1) candidates.add((k - 1) * o);
    candidates.add((k + 1) * o);
    for (let d = 1; d * d <= o; d++) {
        if (o % d === 0) { candidates.add(d); candidates.add(o / d); }
    }
    let bestQ = null;
    for (const c of candidates) {
        if (Math.abs(c - p) < EPS) return null;  // already agrees
        if (bestQ === null || Math.abs(c - p) < Math.abs(bestQ - p) - EPS ||
            (Math.abs(Math.abs(c - p) - Math.abs(bestQ - p)) < EPS && c < bestQ)) {
            bestQ = c;
        }
    }
    return bestQ;
}

/**
 * The DRIFT face for a sequenced stack.
 * @param {number} seqLenQ  the song length
 * @param {number} innerQ   lcm(Q, children's effective periods)
 * @returns null when the passes repeat identically, else
 *   { seqLenQ, innerQ, phaseQ (seqLen mod inner), offers: [downQ|null, upQ] }
 */
export function assessDrift(seqLenQ, innerQ) {
    if (!(seqLenQ > 0) || !(innerQ > 0)) return null;
    const s = Math.round(seqLenQ), i = Math.round(innerQ);
    const phaseQ = s % i;
    if (phaseQ === 0) return null;
    const downQ = s - phaseQ;
    return {
        seqLenQ: s,
        innerQ: i,
        phaseQ,
        offers: [downQ > 0 ? downQ : null, downQ + i],
    };
}

/** Minutes of one cycle, for the badge text ("25 min"). */
export function cycleMinutes(cycleQ, quantumSamples, sampleRate) {
    if (!(cycleQ > 0) || !(quantumSamples > 0) || !(sampleRate > 0)) return 0;
    return (cycleQ * quantumSamples) / sampleRate / 60;
}

/** "25 min" / "1:52" — long cycles in minutes, short ones m:ss. */
export function fmtDuration(minutes) {
    if (!(minutes > 0)) return '0:00';
    if (minutes >= 10) return Math.round(minutes) + ' min';
    const total = Math.round(minutes * 60);
    const m = Math.floor(total / 60), s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
}
