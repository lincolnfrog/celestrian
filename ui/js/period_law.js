/**
 * THE PERIOD LAW (composition.md §3, I12) — the JS twin of
 * src/period_law.h, pinned to the `period_law_cases` tree fixtures in
 * shared/timing_golden.json (ui/js/tests/period_law.test.mjs).
 *
 *   own(node)          = active map ▸ active sequence ▸ (clip: its
 *                        committed take | stack: LCM of the children's
 *                        contributions)
 *   contribution(node) = (one-shot || skipped || first take || drifts)
 *                        ? 0 : own(node)
 *   islandCycle        = lcm(Q || fallback, own(root))
 *   scopeCycle(stack)  = authored ? own : own > 0 ? lcm(Q, own) : received
 *
 * A FIRST TAKE is a clip recording with no committed take: its live
 * count is no period until it commits (the engine's clip length is 0
 * until then). A committed slot whose NEW TAKE records is still a part
 * (takes.md §2: a slot's takes share one origin and period) — it plays,
 * contributes and drifts as the slot.
 *
 * `providers` adapt a node shape to the law, all in samples:
 *   mapPeriod(node)  the ACTIVE map's period, or 0
 *   seqLen(node)     the ACTIVE sequence's length, or 0
 *   children(node)   the child list
 *   slotPeriod(node) the committed period of the slot a recording clip's
 *                    take is a new take of, or 0; without the provider
 *                    every recording clip is a first take
 *   quantum          the island Q the drift clause judges against — a
 *                    number, or a function returning one (the mock's Q
 *                    moves under it); absent or 0 = no drift clause
 * The view model's providers are vm/published.js publishedLaw /
 * frameLaw; the mock's are in mock/cycles.js.
 */

import { lcm } from './math_utils.js';

/** The committed period of the slot `node` is re-taking, or 0. */
function retakenSlot(node, providers) {
    if (!node.isRecording || !providers.slotPeriod) return 0;
    const slot = Math.round(providers.slotPeriod(node) || 0);
    return slot > 0 ? slot : 0;
}

/** Is `node` a FIRST take — recording, with no committed take? */
function isFirstTake(node, providers) {
    return !!node.isRecording && !(retakenSlot(node, providers) > 0);
}

/** A clip's COMMITTED take: its duration; while it records, the slot it
 * re-takes — nothing for a first take, whose `duration` is a live
 * count. */
function committedTake(node, providers) {
    return node.isRecording ? retakenSlot(node, providers)
                            : Math.round(node.duration || 0);
}

/** What `node` plays. `skip` is the node a fold is judged against
 * ("everyone else"): it contributes nothing. */
export function ownPeriod(node, providers, skip = null) {
    const m = Math.round(providers.mapPeriod(node) || 0);
    if (m > 0) return m;
    const s = Math.round(providers.seqLen(node) || 0);
    if (s > 0) return s;
    if (node.type !== 'stack') return committedTake(node, providers);
    let composite = 0;
    for (const child of providers.children(node) || []) {
        const k = periodContribution(child, providers, skip);
        if (k > 0) composite = composite > 0 ? lcm(composite, k) : k;
    }
    return composite;
}

/** What `node` hands its parent's fold. */
export function periodContribution(node, providers, skip = null) {
    if (node === skip || node.periodSource === 'context') return 0;
    if (isFirstTake(node, providers)) return 0;
    const own = ownPeriod(node, providers, skip);
    return ownDrifts(node, providers, own) ? 0 : own;
}

/**
 * THE DRIFT CLAUSE (Q22, design_language.md §5): a period that is
 * neither a whole multiple nor an exact divisor of the island Q shares
 * no finite cycle with the grid. Such a node DRIFTS — it plays as
 * recorded, each pass lining up differently — and contributes nothing
 * to any fold, so it never widens a cycle. False with no Q.
 */
export function periodDrifts(period, quantum) {
    const p = Math.round(period || 0);
    const q = Math.round(quantum || 0);
    return q > 0 && p > 0 && p % q !== 0 && q % p !== 0;
}

function providerQuantum(providers) {
    const q = typeof providers.quantum === 'function'
        ? providers.quantum() : providers.quantum;
    return q > 0 ? q : 0;
}

/** Whether `node`, whose own period is `own`, drifts. A node holding an
 * active SONG is exempt, map or not (S10: free step lengths are a
 * deliberate drifting pass, and a step audition's derived map is a step
 * of that song). */
function ownDrifts(node, providers, own) {
    const q = providerQuantum(providers);
    if (!(q > 0)) return false;
    if (Math.round(providers.seqLen(node) || 0) > 0) return false;
    return periodDrifts(own, q);
}

/** Does `node` drift under the providers' island Q? A one-shot or a
 * first take never does: they contribute nothing for their own reasons. */
export function nodeDrifts(node, providers) {
    if (node.periodSource === 'context') return false;
    if (isFirstTake(node, providers)) return false;
    return ownDrifts(node, providers, ownPeriod(node, providers));
}

/** The cycle the transport wraps on: lcm(Q, own(root)), `fallback`
 * standing in for Q before it exists. */
export function islandCycle(root, providers, quantum, fallback) {
    const q = quantum > 0 ? Math.round(quantum) : Math.round(fallback || 0);
    const own = ownPeriod(root, providers);
    return own > 0 ? lcm(q, own) : q;
}

/**
 * THE SCOPE CYCLE a stack hands its children — a one-shot child's fold,
 * and the grid a child take wraps on — from the stack's `own` period:
 *
 *   authored (a map or a song sets `own`)  → own
 *   else own > 0                           → lcm(Q, own)
 *   else (nothing in it loops)             → the cycle the stack received
 *
 * A map pass or a song is what the children listen to as it stands; a
 * plain stack's children listen to the fold of its looping content on
 * the island grid; a scope with nothing looping hands its own scope's
 * cycle on, so a one-shot in an all-one-shot group still sounds once per
 * the enclosing cycle.
 */
export function scopeCycle(own, authored, quantum, received) {
    const o = Math.round(own || 0);
    if (!(o > 0)) return received;
    const q = Math.round(quantum || 0);
    return authored || !(q > 0) ? o : lcm(q, o);
}

/** The scope cycle of the stack `node`, judged against the providers'
 * island Q. */
export function scopeCycleOf(node, providers, received) {
    const authored = Math.round(providers.mapPeriod(node) || 0) > 0 ||
        Math.round(providers.seqLen(node) || 0) > 0;
    return scopeCycle(ownPeriod(node, providers), authored,
                      providerQuantum(providers), received);
}
