/**
 * Who defines Q, and the TRIM VIEW of a provisional definer (Q13; the
 * hand-off, Q22).
 */

import { publishedMap, nodeWindowActive } from '../time_map.js';
import { activeSequenceSamples } from '../sequence_program.js';
import { EPS } from './tiling.js';
import { committedClip, subtreeHasCommitted, findNodeInTree, oneTake,
         intrinsicPeriod } from './published.js';

/**
 * THE DEFINER AND ITS TRIM VIEW (Q13). The definer is the node whose
 * loop IS Q: the sole committed clip, or the definer stack (one take of
 * several mics). The backend publishes it as `definerId` and the view
 * reads that — a second definition could disagree by a sample and flip
 * the lane between the trim view and the heard view; a state without
 * the field derives it (definerStackOf).
 *
 * While the definer is PROVISIONAL — nothing armed or recording, its
 * window not bypassed — it is drawn in the TRIM VIEW: its whole take as
 * one tile with the loop as a SELECTION over it, so dragging the handles
 * moves the selection over a still waveform while Q and the zero follow.
 * The view ends when a second take ARMS (the engine lock-collapses the
 * definer then, and refuses a re-trim under a live take), and never
 * opens on a bypassed window: that plays the whole take, so the
 * selection would not be the audible loop.
 *
 * THE SELECTION is the definer's stored map (time_map.publishedMap); for
 * a definer stack without one, the window its members share
 * (memberCommonWindow); else the whole take.
 *
 * @param {Array<Object>} committedClips  with `anyTakeActive`, from
 *     collectTreeFacts
 * @param {string} [publishedDefinerId]   state.definerId ('' = none)
 * @returns {Object}
 *   soleQDefinerId      the definer's id, provisional or not; or null
 *   provisionalDefiner  the trim view is on; `definerNode` is its node
 *   defSelRuns          the selection's runs, samples of the definer's
 *                       take; defSelStartQ / defSelEndQ their outer
 *                       bounds
 *   definerIds          a Set: the definer and, for a stack, its clips —
 *                       their origins are the island zero, so none is
 *                       re-timed
 *   trimCompany         the trim view shares the screen with other
 *                       committed takes (Q22)
 */
export function resolveProvisionalDefiner(committedClips, anyTakeActive, quantum,
                                          nodes, publishedDefinerId) {
    let definer = null;
    if (typeof publishedDefinerId === 'string') {
        definer = publishedDefinerId
            ? findNodeInTree(nodes, publishedDefinerId) : null;
        // A published stack that does not read as one take here (a
        // member became a one-shot, durations moved mid-poll) opens no
        // trim view: its geometry (intrinsicPeriod) could not be
        // computed.
        if (definer && definer.type === 'stack' && !oneTake(definer)) {
            definer = null;
        }
    } else {
        definer = committedClips.length === 1 ? committedClips[0]
            : committedClips.length >= 2 ? definerStackOf(nodes) : null;
    }
    const provisionalDefiner = !!definer && !anyTakeActive &&
        !definer.loopBypassed;
    const definerNode = provisionalDefiner ? definer : null;
    let defSelRuns = [];
    if (definerNode) {
        defSelRuns = publishedMap(definerNode).segs;
        if (!defSelRuns.length) {
            const memberSel = definerNode.type === 'stack'
                ? memberCommonWindow(definerNode) : null;
            defSelRuns = [memberSel ||
                [0, intrinsicPeriod(definerNode, quantum)]];
        }
    }
    const definerIds = new Set();
    if (definer) {
        definerIds.add(definer.id);
        if (definer.type === 'stack') {
            (definer.nodes || []).forEach(c => {
                if (c.type === 'clip') definerIds.add(c.id);
            });
        }
    }
    return {
        soleQDefinerId: definer ? definer.id : null,
        provisionalDefiner,
        definerNode,
        defSelRuns,
        defSelStartQ: definerNode ? defSelRuns[0][0] / quantum : 0,
        defSelEndQ: definerNode
            ? defSelRuns[defSelRuns.length - 1][1] / quantum : 0,
        definerIds,
        trimCompany: provisionalDefiner &&
            hasCompany(definerNode, committedClips),
    };
}

/**
 * THE TRIM VIEW'S PLACE for a heard position of the definer's loop:
 * `heardQ` (Q from the loop's top) walked through the selection's runs
 * (sample pairs), in the buffer frame the trim view draws. A position
 * on a seam is the start of the run after it; one at or past the loop's
 * end runs on from the last run, so the loop's end is that run's end.
 * For one run this is its start + heardQ.
 */
export function definerPlaceQ(runs, quantum, heardQ) {
    let h = heardQ;
    for (let i = 0; i < runs.length; i++) {
        const lenQ = (runs[i][1] - runs[i][0]) / quantum;
        if (i === runs.length - 1 || h < lenQ - EPS) {
            return runs[i][0] / quantum + h;
        }
        h -= lenQ;
    }
    return heardQ;
}

/** One take of two or more clips from one origin: the group shape that
 * can define Q (the engine's definerStack). */
function isOneTakeGroup(stack) {
    const take = oneTake(stack);
    return !!take && take.members >= 2 && take.sameOrigin;
}

/** The island's definer stack, for a state that publishes no
 * `definerId`: the one stack holding EVERY committed clip as a direct
 * child, when those are a one-take group. Walks down from the top-level
 * list through sole content-bearing stacks; null otherwise. */
function definerStackOf(nodes, owner = null) {
    const list = nodes || [];
    const nested = list.filter(n => n.type === 'stack' && subtreeHasCommitted(n));
    if (nested.length) {
        return nested.length === 1 && !list.some(committedClip)
            ? definerStackOf(nested[0].nodes, nested[0]) : null;
    }
    return owner && isOneTakeGroup(owner) ? owner : null;
}

/** The one ACTIVE sub-window every committed direct clip of `stack`
 * shares ([start, end] samples); null when they are whole, differ, or
 * any is bypassed or multi-segment. A group take committed against a
 * surviving Q can carry its loop region on each clip instead of on the
 * group: that common window is the selection the ear hears. */
function memberCommonWindow(stack) {
    let win = null;
    for (const c of stack.nodes || []) {
        if (!committedClip(c)) continue;
        const { segs } = publishedMap(c);
        if (!nodeWindowActive(c) || c.loopBypassed || segs.length !== 1) return null;
        const [ls, le] = segs[0];
        if (ls === 0 && le >= c.duration) return null;  // whole
        if (!win) win = [ls, le];
        else if (win[0] !== ls || win[1] !== le) return null;
    }
    return win;
}

/**
 * May Q be handed to `node` (setDefiner, Q22)? The engine's target rules
 * (engine_internal::definer) read off the published shape: Q exists and
 * nothing is live (`ctx.definerIdle`); no group above remaps time
 * (`underWarp`: an active map, a song, a one-shot's fold); the node is
 * not the definer already, not a one-shot, not live; and it is a
 * committed clip, or a songless group whose committed direct clips are
 * one take of two or more from one origin.
 */
export function canDefineNode(node, ctx, underWarp) {
    if (!ctx.definerIdle || underWarp) return false;
    if (node.id === ctx.soleQDefinerId) return false;
    if (node.periodSource === 'context' || node.isRecording || node.isPendingStart) {
        return false;
    }
    if (node.type === 'clip') return (node.duration || 0) > 0;
    if (node.type !== 'stack' || activeSequenceSamples(node) > 0) return false;
    return isOneTakeGroup(node);
}

/** Whether a committed clip lies outside the definer's subtree: the
 * trim view then shares the screen (Q was handed to the definer, Q22). */
function hasCompany(definer, committedClips) {
    if (!definer) return false;
    const inside = new Set();
    (function visit(n) {
        inside.add(n.id);
        (n.nodes || []).forEach(visit);
    })(definer);
    return committedClips.some(c => !inside.has(c.id));
}
