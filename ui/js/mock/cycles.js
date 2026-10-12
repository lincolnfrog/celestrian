/**
 * mock/cycles.js — the period law (period_law.js) over the raw mock
 * node: its providers, and the periods and cycles the mock reads through
 * them. The root is a stack like any other.
 */

import { state, activeMapOf } from './state.js';
import { mapPeriod } from '../time_map.js';
import { activeSeqLen } from './seq_query.js';
import { islandCycle, ownPeriod } from '../period_law.js';
import { getSampleRate } from './rate.js';

/** The law's providers. `quantum` is the Q the drift clause judges
 * against — by default the island's, read live. */
export function law(quantum = () => state.islandQ) {
    return {
        mapPeriod: n => {
            const m = activeMapOf(n);
            return m ? Math.round(mapPeriod(m)) : 0;
        },
        seqLen: activeSeqLen,
        children: n => n.nodes || [],
        slotPeriod: n => (n._retake ? n.duration : 0),
        quantum,
    };
}

/** What `node` plays (engine period_law::ownPeriodOf with the island Q). */
export function ownPeriodOfNode(node) {
    return ownPeriod(node, law());
}

/** The own period with no drift clause — what setDefiner makes Q. */
export function rawPeriodOfNode(node) {
    return ownPeriod(node, law(0));
}

/** The island's audible cycle, lcm(Q, the root's own period); 0 while
 * nothing sets one — what a take is performed against, what a bounce of
 * the root renders. */
export function audibleCycle() {
    return islandCycle(state.root, law(), state.islandQ, 0);
}

/** The cycle the cursor folds on (engine calculateEffectiveCycleLength):
 * the audible cycle, one second standing in for Q before it exists. */
export function effectiveCycle() {
    return islandCycle(state.root, law(), state.islandQ, getSampleRate());
}
