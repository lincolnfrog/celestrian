/**
 * mock/cycles.js — island cycle math shared by transport (view wrap) and
 * recording (commit/re-base): the committed LCM and the AUDIBLE
 * (window-aware, sequence-aware) effective cycle. Lives in its own
 * module so transport and recording can both import it without
 * importing each other.
 */

import { lcm } from '../math_utils.js';
import { state, activeMapOf, rootActiveMap } from './state.js';
import { mapPeriod } from '../time_map.js';
import { activeSeqLen } from './sequence.js';
import {
    periodContribution, islandCycle, nodeDrifts, ownPeriod,
} from '../timeline_model.js';

/** THE PERIOD LAW's providers over the MOCK state shape: the active
 * map is audition-aware (activeMapOf; the root's via rootActiveMap),
 * the sequence is the holder's, children are `nodes`, and the island Q
 * is read live (the drift clause, Q22 — a setDefiner or a definer trim
 * moves it). The root is a synthetic stack holder ('mock-root' is not
 * in `nodes`). */
const rootHolder = () => ({
    type: 'stack', isRoot: true, nodes: state.nodes,
    sequence: state.rootSequence, sequenceBypassed: state.rootSequenceBypassed,
});
const providers = {
    mapPeriod: n => {
        const m = n.isRoot ? rootActiveMap() : activeMapOf(n);
        return m ? Math.round(mapPeriod(m)) : 0;
    },
    seqLen: n => activeSeqLen(n),
    children: n => n.nodes || [],
    quantum: () => state.islandQ,
};

/** Does `node` DRIFT (Q22): its own period fits no whole number of Qs
 * and no exact division of one — it plays as recorded and folds into
 * nothing. Engine parity: period_law's drift clause. */
export function driftsNow(node) {
    return nodeDrifts(node, providers);
}

/** What `node` PLAYS (the period law's own period: map ▸ song ▸
 * content) — a drifting node's too; a bounce's span (engine parity
 * bounce.cc: the law with the island Q). */
export function ownPeriodOfNode(node) {
    return ownPeriod(node, providers);
}

/** The own period with NO drift clause — what setDefiner makes Q
 * (engine parity: ownPeriodOf(node, nullptr, 0)): a group's members
 * count whether or not they fit the Q about to be replaced. */
export function rawPeriodOfNode(node) {
    return ownPeriod(node, { ...providers, quantum: 0 });
}

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
    // THE PERIOD LAW (timeline_model.periodContribution): what the node
    // hands its parent's fold — 0 for a one-shot (Q5) or a live take.
    return periodContribution(node, providers);
}

export function effectiveCycle(Q) {
    // THE PERIOD LAW at the island root (timeline_model.islandCycle):
    // the root's own map (a step audition, §11.2) or song wins the
    // whole frame; else lcm(Q, the top-level contributions). Engine
    // parity: snapEffectiveCycle. Before Q exists the mock's cycle is
    // the content alone (no one-second fallback here — the view has
    // no rate).
    return islandCycle(rootHolder(), providers, Q, 0);
}
