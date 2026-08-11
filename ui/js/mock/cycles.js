/**
 * mock/cycles.js — island cycle math shared by transport (view wrap) and
 * recording (commit/re-base): the committed LCM and the AUDIBLE
 * (window-aware) effective cycle. Lives in its own module so transport
 * and recording can both import it without importing each other.
 */

import { lcm } from '../math_utils.js';
import { state, nodeMap } from './state.js';
import { mapActive, mapPeriod } from '../time_map.js';

/** LCM of committed clip durations (the engine's calculateTimelineLength). */
export function committedCycle(Q) {
    let cycle = Q > 0 ? Q : 0;
    const visit = ns => (ns || []).forEach(n => {
        // One-shots excluded (Q5): they adopt the cycle, never extend it.
        if (n.periodSource === 'context') return;
        if (n.type === 'clip' && !n.isRecording && n.duration > 0) {
            cycle = cycle > 0 ? lcm(cycle, Math.round(n.duration)) : Math.round(n.duration);
        }
        if (n.nodes) visit(n.nodes);
    });
    visit(state.nodes);
    return cycle;
}

/**
 * The AUDIBLE island cycle (the engine's calculateEffectiveCycleLength,
 * E-C): an active loop window makes a node contribute its window length
 * instead of its intrinsic period — recursion stops at the window. The
 * published masterPos wraps on THIS; commit/re-base logic stays on
 * committedCycle (windows are view-of-time state, not material).
 */
export function effectivePeriodOf(node) {
    if (node.isRecording) return 0;
    // One-shots contribute nothing to the fold (Q5 exclusion — engine
    // parity: snapEffectivePeriod skips periodFromContext children).
    if (node.periodSource === 'context') return 0;
    if (!node.loopBypassed && mapActive(nodeMap(node))) {
        return Math.round(mapPeriod(nodeMap(node)));
    }
    if (node.type !== 'stack') return node.duration > 0 ? Math.round(node.duration) : 0;
    let composite = 0;
    (node.nodes || []).forEach(c => {
        const p = effectivePeriodOf(c);
        if (p > 0) composite = composite > 0 ? lcm(composite, p) : p;
    });
    return composite;
}

export function effectiveCycle(Q) {
    let cycle = Q > 0 ? Q : 0;
    state.nodes.forEach(n => {
        const p = effectivePeriodOf(n);
        if (p > 0) cycle = cycle > 0 ? lcm(cycle, p) : p;
    });
    return cycle;
}
