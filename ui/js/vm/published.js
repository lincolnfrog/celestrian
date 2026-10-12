/**
 * Reading ONE published node (the getGraphState shape: samples, origins
 * absolute, a stack's children on `nodes`), and the whole-tree facts a
 * derive collects. Imports nothing above the leaf modules:
 * timeline_model.js re-exports from this file.
 */

import { lcm } from '../math_utils.js';
import { toSamples } from '../qtime.js';
import { periodContribution, nodeDrifts, islandCycle, scopeCycleOf }
    from '../period_law.js';
import { nodeWindowActive, publishedMap, publishedMapPeriod, mapPeriod,
         heardOffsetOf } from '../time_map.js';
import { activeSequenceSamples, isAuditionWindow }
    from '../sequence_program.js';

/* ---- the period law over the published shape ---- */

/**
 * THE PERIOD LAW's providers (period_law.js) over published nodes.
 * `publishedLaw` reads what is HEARD: a step audition's derived map is
 * its holder's map, as the engine folds it. `frameLaw` reads what the
 * FRAME shows: an audition is a monitoring loop, not a part's length, so
 * its holder keeps contributing its song. Both read a slot being
 * re-taken as the slot (retakePeriod).
 */
export function publishedLaw(quantum) {
    return { mapPeriod: publishedMapPeriod, seqLen: activeSequenceSamples,
             children: n => n.nodes || [], quantum,
             slotPeriod: n => retakePeriod(n, quantum) };
}

export function frameLaw(quantum) {
    return { ...publishedLaw(quantum),
             mapPeriod: n => (isAuditionWindow(n) ? 0 : publishedMapPeriod(n)) };
}

/** nodeDrifts under publishedLaw. A test seam: the view model asks the
 * law directly. */
export function publishedNodeDrifts(node, quantum) {
    return !!node && nodeDrifts(node, publishedLaw(quantum));
}

/** What `node` hands its parent's fold as heard, in samples. A true
 * length, never rounded to the grid: the frame-health faces reason
 * about ratios. */
function effectivePeriod(node, quantum) {
    return periodContribution(node, publishedLaw(quantum));
}

/** A stack's INNER cycle in samples, as its lane reads it: the island Q
 * folded with what each child hands the stack (frameLaw). */
export function calculateStackLCM(stackNodes, quantum) {
    return islandCycle({ type: 'stack', nodes: stackNodes || [] },
                       frameLaw(quantum), quantum, 0);
}

/** The cycle a stack's children HEAR, in Q: period_law.scopeCycleOf
 * over the published node (publishedLaw — a step audition's derived map
 * is the pass they hear). `receivedQ` is the cycle the stack's own scope
 * hears. */
export function scopeCycleQOf(stack, quantum, receivedQ) {
    return scopeCycleOf(stack, publishedLaw(quantum),
                        Math.round((receivedQ || 0) * quantum)) / quantum;
}

/** The island Q of a state in samples (1 = not established): the stored
 * fact the backend publishes; a fixture without it falls back to
 * computeEffectiveQuantum. */
export function resolveQuantum(state, nodes) {
    return state.quantum > 1 ? state.quantum : computeEffectiveQuantum(nodes);
}

/** The smallest positive `effectiveQuantum` any node reports, or 1. */
export function computeEffectiveQuantum(nodes) {
    let effectiveQ = Infinity;
    const visit = list => (list || []).forEach(n => {
        if (n.effectiveQuantum > 0 && n.effectiveQuantum < effectiveQ) {
            effectiveQ = n.effectiveQuantum;
        }
        if (n.type === 'stack' && n.nodes) visit(n.nodes);
    });
    visit(nodes);
    return effectiveQ === Infinity ? 1 : effectiveQ;
}

/**
 * A scope's MEMBERS as its fold reads them: each child's contribution in
 * Q, with the knob that sets it — its song, its window, or neither. A
 * child that hands the fold nothing (a one-shot, a live take, a drifting
 * loop) is left out.
 *
 * @returns {Array<{id: string, periodQ: number, knob: ?string}>}
 */
export function scopeMembers(children, quantum) {
    return (children || []).map(c => ({
        id: c.id,
        periodQ: effectivePeriod(c, quantum) / quantum,
        knob: c.type === 'stack' && activeSequenceSamples(c) > 0 ? 'sequence'
            : (nodeWindowActive(c) ? 'window' : null),
    })).filter(m => m.periodQ > 0);
}

/* ---- the tree ---- */

/** A clip holding a committed take (not one being captured). */
export function committedClip(n) {
    return n.type === 'clip' && !n.isRecording && n.duration > 0;
}

/** Whether any committed take lies below `n`. */
export function subtreeHasCommitted(n) {
    return (n.nodes || []).some(c =>
        committedClip(c) || (c.type === 'stack' && subtreeHasCommitted(c)));
}

/** Whether a live take lies anywhere below `n`. */
export function subtreeRec(n) {
    return (n.nodes || []).some(c => c.isRecording || subtreeRec(c));
}

/** A node by id anywhere in the published tree, or null. */
export function findNodeInTree(nodes, id) {
    for (const n of nodes || []) {
        if (n.id === id) return n;
        if (n.type === 'stack') {
            const hit = findNodeInTree(n.nodes, id);
            if (hit) return hit;
        }
    }
    return null;
}

/**
 * The whole-tree facts of one derive, in one pass.
 *
 * @returns {{committedClips: Array<Object>, anyRecording: boolean,
 *     anyTakeActive: boolean, maxRecordingDuration: number}}
 *     `anyTakeActive`: a take records OR waits to start;
 *     `maxRecordingDuration`: the longest live take, samples
 */
export function collectTreeFacts(nodes) {
    const committedClips = [];
    let anyRecording = false;
    let anyPending = false;
    let maxRecordingDuration = 0;
    const visit = ns => (ns || []).forEach(n => {
        if (committedClip(n)) committedClips.push(n);
        if (n.isRecording) {
            anyRecording = true;
            if (n.duration > maxRecordingDuration) maxRecordingDuration = n.duration;
        }
        if (n.isPendingStart) anyPending = true;
        if (n.nodes) visit(n.nodes);
    });
    visit(nodes);
    return {
        committedClips,
        anyRecording,
        anyTakeActive: anyRecording || anyPending,
        maxRecordingDuration,
    };
}

/**
 * A NEW TAKE'S SLOT (docs/takes.md §2). A new take keeps its slot's
 * origin, period, region and top and commits back into them; while it
 * captures, the published `duration` is the LIVE captured length (0,
 * then growing) and the slot's committed length rides `periodQ` ({num,
 * den} of Q) — which a first take publishes as 0.
 */

/** The slot's committed period in samples, read off `n` as published;
 * 0 when `n` publishes none. */
function slotPeriodOf(n, quantum) {
    const pq = n.periodQ;
    return pq && pq.den > 0 ? toSamples(pq, quantum) : 0;
}

/** The period of the slot `n`'s live take is a NEW take of, in samples;
 * 0 for a first take and for a node that is not recording. */
export function retakePeriod(n, quantum) {
    return n.type === 'clip' && n.isRecording ? slotPeriodOf(n, quantum) : 0;
}

/** The node at its slot's length. */
export function retakeSlot(n, quantum) {
    const d = slotPeriodOf(n, quantum);
    return d > 0 ? { ...n, duration: d } : n;
}

/** Is `n` a clip whose live take is a NEW TAKE of a committed slot? The
 * published state says so (retakePeriod); `told` (opts.retakes: a Set of
 * ids, or null) names the ones a state that publishes no `periodQ`
 * cannot. */
export function isRetaking(n, told, quantum) {
    return n.type === 'clip' && !!n.isRecording &&
        (retakePeriod(n, quantum) > 0 || !!(told && told.has(n.id)));
}

/**
 * THE TREE AS THE FRAME READS IT: every clip taking a NEW TAKE of a
 * committed slot (isRetaking) stands as that slot, committed at its own
 * length (retakeSlot). The period law reads such a slot as a part on its
 * own; this is for the readers of `duration` and `isRecording` — a slot
 * read as a fresh take would drive the growing frame, regrowing it under
 * every lane, would take the seat from the loop that places the frame,
 * and would leave its group no period, map or top of its own. The lanes
 * and the gates read the tree as published, where a new take is a live
 * take. Returns `nodes` itself when nothing in it is re-taking.
 */
export function settledForFrame(nodes, retakes, quantum) {
    let changed = false;
    const out = (nodes || []).map(n => {
        if (n.type === 'stack' && Array.isArray(n.nodes)) {
            const kids = settledForFrame(n.nodes, retakes, quantum);
            if (kids === n.nodes) return n;
            changed = true;
            return { ...n, nodes: kids };
        }
        if (!isRetaking(n, retakes, quantum)) return n;
        const slot = retakeSlot(n, quantum);
        if (!(slot.duration > 0)) return n;
        changed = true;
        return { ...slot, isRecording: false, isPendingStart: false };
    });
    return changed ? out : nodes;
}

/* ---- one node: its extent, its map, its period, its top ---- */

/**
 * A stack whose committed direct clips are ONE TAKE (a group-recorded
 * kit, the Q13 definer stack): they share one duration, none is a
 * one-shot, and no nested stack holds content.
 *
 * @returns {?{duration: number, members: number, sameOrigin: boolean}}
 *     the shared duration (samples), the clip count, and whether the
 *     clips share one origin; null when the stack is no such take
 */
export function oneTake(stack) {
    let duration = 0, origin = 0, members = 0, sameOrigin = true;
    for (const c of stack.nodes || []) {
        if (c.type === 'stack') {
            if (subtreeHasCommitted(c)) return null;
            continue;
        }
        if (!committedClip(c)) continue;
        if (c.periodSource === 'context') return null;
        if (members === 0) {
            duration = c.duration;
            origin = c.origin || 0;
        } else if (c.duration !== duration) {
            return null;
        } else if ((c.origin || 0) !== origin) {
            sameOrigin = false;
        }
        members++;
    }
    return members > 0 ? { duration, members, sameOrigin } : null;
}

/** The duration of a one-take stack in samples; 0 when it is none. */
export function oneTakeDuration(stack) {
    const take = oneTake(stack);
    return take ? take.duration : 0;
}

/**
 * A node's INTRINSIC period in samples — the extent a lane frames its
 * raw material over: a clip's take; a stack's inner cycle, the fold of
 * what its children PLAY (the composite a group lane tiles repeats at
 * it). A ONE-TAKE stack's is that take's duration exactly: a definer's
 * take is no multiple of the Q its own selection sets, so folded through
 * the law its members would drift and hand the stack nothing.
 * Not StackNode::getIntrinsicDuration — that is rawInnerCycle: a lane
 * with no map on it tiles what the group plays, never its raw extent.
 */
export function intrinsicPeriod(node, quantum) {
    if (node.type !== 'stack') return node.duration || 0;
    return oneTakeDuration(node) || calculateStackLCM(node.nodes, quantum);
}

/**
 * A node's RAW inner cycle in samples — the twin of
 * StackNode::getIntrinsicDuration: a clip's take; a stack's LCM of its
 * looping children's raw cycles, whatever they play (a child's window,
 * song or drift changes nothing here) and unseeded by Q; 0 with nothing
 * looping. It bounds what the engine lets the stack's own map select.
 */
export function rawInnerCycle(node) {
    if (node.type !== 'stack') {
        return node.isRecording ? 0 : Math.round(node.duration || 0);
    }
    let composite = 0;
    for (const child of node.nodes || []) {
        if (child.periodSource === 'context') continue;
        const d = rawInnerCycle(child);
        if (d > 0) composite = composite > 0 ? lcm(composite, d) : d;
    }
    return composite;
}

export function intrinsicPeriodQ(node, quantum) {
    return intrinsicPeriod(node, quantum) / quantum;
}

/**
 * THE DOMAIN a node's map selects over, in samples: a clip's take; a
 * stack's inner cycle — the one it plays or, where that is longer, the
 * raw one the engine bounds its map by (a child's own window shortens
 * what the group plays, not what the group's map may select).
 */
export function mapDomain(node, quantum) {
    const inner = intrinsicPeriod(node, quantum);
    return node.type === 'stack' ? Math.max(inner, rawInnerCycle(node)) : inner;
}

/**
 * A node's MAP as a lane reads it, in Q — or null when there is none
 * worth showing: no map, or one window spanning its whole domain
 * (mapDomain: it restricts nothing, and brackets on it would read as a
 * misalignment at the lane's edge).
 *
 * @returns {?Object} { segs, periodQ, multi, startQ, endQ, bypassed,
 *     active, suspended } — `segs` the stored map
 *     (time_map.publishedMap); `periodQ` ONE division of its sample
 *     length (summed per-edge fractions read 0.9999…Q for a 1Q map);
 *     `startQ` / `endQ` its outer bounds; `active` it plays
 *     (nodeWindowActive); `suspended` authored over a song that is now
 *     off (S16, sequencer.md §11.8)
 */
export function mapOf(node, quantum) {
    const map = publishedMap(node);
    if (!map.segs.length) return null;
    const multi = map.segs.length > 1;
    if (!multi && map.segs[0][0] <= 0 &&
        map.segs[0][1] >= mapDomain(node, quantum)) {
        return null;
    }
    const segs = map.segs.map(([s, e]) => [s / quantum, e / quantum]);
    return {
        segs,
        periodQ: mapPeriod(map) / quantum,
        multi,
        startQ: segs[0][0],
        endQ: segs[segs.length - 1][1],
        bypassed: !!node.loopBypassed,
        active: !!nodeWindowActive(node),
        suspended: !!node.windowSuspended,
    };
}

/** Is `n`'s map AUTHORED — active, not suspended by a song (S16), not a
 * step audition's derived window? `m` is mapOf(n). The heard view, the
 * seat and the top all read this one verdict. */
export function mapAuthored(n, m) {
    return !!(m && m.active && !m.suspended && !isAuditionWindow(n));
}

/**
 * A lane's DISPLAY period in Q — THE HEARD VIEW's law (I5; clips and
 * groups alike): a window sets the part's length, so a lane tiles at,
 * and its chip reads, the node's effective period — an active map's
 * length; else a stack's active song (sequencer.md §2); else the
 * intrinsic period. The frame is the audible cycle, so the one cursor is
 * honest on every lane. A step audition's derived window is no part
 * length; a live take has no settled period (0).
 */
export function displayPeriodQ(node, quantum) {
    if (node.isRecording) return 0;
    if (!isAuditionWindow(node)) {
        const p = publishedMapPeriod(node);
        if (p > 0 && (node.type === 'stack' || p < (node.duration || 0))) {
            return p / quantum;
        }
    }
    if (node.type === 'stack') {
        const seqLen = activeSequenceSamples(node);
        if (seqLen > 0) return seqLen / quantum;
    }
    return intrinsicPeriodQ(node, quantum);
}

/**
 * THE TOP (↺; loop_selection.md §9.3): the raw sample `T` of the take a
 * loop reads as starting on. It sounds at its MOMENT
 *
 *   origin + a0 + heardOffset(kept, T)        a0 = kept.segs[0][0]
 *
 * where `kept` is what the node plays: its authored map, else its whole
 * take (a group's: its inner cycle). `T` is the published effective top
 * (`loopTop`); a state without one, or a top the kept set does not play
 * (a preview the reconcile has not seen), reads as the region start a0.
 *
 * @param {boolean} authored  mapAuthored(n, mapOf(n, quantum))
 * @returns {{kept: {segs: Array<[number, number]>}, a0: number,
 *     top: number, heard: number, periodS: number}}  samples: `top` is T
 *     as read, `heard` its heard offset, `periodS` the kept set's length
 */
export function topOf(n, authored, quantum) {
    const kept = authored ? publishedMap(n)
                          : { segs: [[0, intrinsicPeriod(n, quantum)]] };
    const a0 = kept.segs.length ? kept.segs[0][0] : 0;
    const periodS = mapPeriod(kept);
    const T = n.loopTop;
    const heard = Number.isFinite(T) ? heardOffsetOf(kept, T) : -1;
    return heard >= 0 ? { kept, a0, top: T, heard, periodS }
                      : { kept, a0, top: a0, heard: 0, periodS };
}
