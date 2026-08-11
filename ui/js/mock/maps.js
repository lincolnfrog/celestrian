/**
 * mock/maps.js — the time-map edit surface: single-window loop points,
 * multi-segment overrides (phase 3), and the bypass toggle, with the
 * coherence guard, the Q13 sole-definer re-trims, and the two-anchor
 * continuity law. Refusal paths drop the dispatch's pre-pushed undo
 * snapshot (popUndoForRefusal) — a refused edit records nothing.
 */

import { posMod } from '../math_utils.js';
import { mapPeriod, mapOffset, mapActive, heardOffsetOf } from '../time_map.js';
import {
    state, findNode, nodeMap, intrinsicOfNode, subtreeRecording,
    anyNodeRecording, isQ13SoleDefiner,
} from './state.js';
import { popUndoForRefusal } from './undo.js';

/** PHASE-PRESERVING RE-ANCHOR (engine parity, 2026-07-25h/i): origin'
 * such that the buffer position sounding right now keeps sounding when
 * the clip's map becomes `newMap` — only while the new map still
 * COVERS it. When the edit removed the sounding region the origin
 * stays FIXED (an audible jump is expected, and the display stays
 * anchored at the click). Inactive maps = their full-span form. */
/* TWO-ANCHOR CONTINUITY (owner ruling 2026-08-09, engine parity —
 * see AudioEngine's twin note): a map edit on a playing clip keeps
 * the sounding sample sounding (origin re-anchor, unless the edit
 * REMOVED that region — then both anchors stay put and the jump is
 * expected), and the island epoch rides the SAME whole-Q delta so
 * the edited clip's frame position — the timeline the user drew —
 * is unchanged. The fold, not the clip, absorbs the difference. */
export function continuityOrigin(node, oldMap, newMap) {
    const dur = node.duration || 0;
    const eff = m => (m && mapActive(m) && mapPeriod(m) > 0)
        ? m : { segs: [[0, dur]] };
    if (!(dur > 0)) return node.origin || 0;
    const o = eff(oldMap), nm = eff(newMap);
    const period = mapPeriod(nm);
    if (!(period > 0) || !(mapPeriod(o) > 0)) return node.origin || 0;
    const t0 = state.masterPos;
    const p0 = mapOffset(o, t0 - (node.origin || 0) - mapOffset(o, 0));
    const hNew = heardOffsetOf(nm, p0);
    if (hNew < 0) return node.origin || 0;  // sounding region removed
    return t0 - mapOffset(nm, 0) - hNew;
}

/** The epoch rider: apply continuity to `node` for `newMap`, moving
 * the island epoch by the same whole-Q delta (two-anchor law). */
export function applyTwoAnchorContinuity(node, oldMap, newMap) {
    const org = node.origin || 0;
    const org2 = continuityOrigin(node, oldMap, newMap);
    if (org2 === org) return;
    node.origin = org2;
    const q = state.islandQ;
    const delta = org2 - org;
    if (q > 0 && delta % q === 0) {
        state.islandEpoch = state.islandEpoch + delta;
    }
}

/**
 * Set a node's single loop window [loopStart, loopEnd) — the phase-3
 * single-segment map form (an explicit window edit supersedes any
 * multi-segment override).
 *
 * Contract (engine parity, AudioEngine::setLoopPoints):
 *  - MID-TAKE GATE: a stack with a take recording in its subtree
 *    refuses (the take froze its map geometry at arm).
 *  - COHERENCE GUARD (owner ruling 2026-08-09): a window length that
 *    is neither a whole multiple nor an exact divisor of Q refuses —
 *    unless this very edit re-establishes Q (Q13 sole definer) or
 *    clears the window (length 0).
 *  - Q13 SOLE DEFINER: while the island's only committed content is
 *    this clip, the window re-establishes the STORED (Q, epoch),
 *    phase-preserving.
 *  - Otherwise, on a playing clip, TWO-ANCHOR CONTINUITY re-anchors
 *    origin and rides the epoch (see continuityOrigin above).
 *  - Refusals pop the dispatch's pre-pushed undo snapshot.
 */
export function setLoopPoints(id, loopStart, loopEnd) {
    const node = findNode(id);
    if (!node) return;
    // MID-TAKE MAP-EDIT GATE (engine parity, owner-ruled): a take
    // recording through this stack's map froze its geometry at arm —
    // refuse window edits until it commits. Siblings stay editable.
    if (node.type === 'stack' && subtreeRecording(node)) {
        console.log('[MockBackend] setLoopPoints refused — take recording in subtree');
        popUndoForRefusal();  // a refused edit records nothing
        return;
    }
    // COHERENCE GUARD (owner ruling 2026-08-09, engine parity): a
    // window length off the Q grid is refused — categorical, both
    // sides — unless this very edit re-establishes Q (the Q13
    // sole-definer re-trim below) or clears the window.
    {
        const cs = Math.max(0, loopStart);
        const ce = node.type === 'clip' && (node.duration || 0) > 0
            ? Math.min(loopEnd, node.duration) : loopEnd;
        const q13 = ce > cs && isQ13SoleDefiner(node);
        const q = state.islandQ;
        const len = ce - cs;
        // Coherent = whole multiple of Q, or an exact divisor of it
        // (sub-Q loops are first-class; lcm(Q, Q/k) = Q).
        const coherent = len > 0 && (len % q === 0 || q % len === 0);
        if (!q13 && q > 0 && len > 0 && !coherent) {
            console.log('[MockBackend] setLoopPoints refused — window ' +
                len + ' is neither a whole multiple nor an exact ' +
                'divisor of Q ' + q);
            popUndoForRefusal();  // a refused edit records nothing
            return;
        }
    }
    // The pre-edit MAP (window or override) — the two-anchor
    // continuity below needs it before any mutation.
    const oldMapPre = node.loopBypassed ? { segs: [] } : nodeMap(node);
    // Phase 3 (engine parity): an explicit single-window edit
    // supersedes a multi-segment override.
    delete node.segments;
    // Pre-edit window (the phase-preserve math below needs it).
    const oldLs = node.loopStart || 0;
    const oldLe = Math.min(node.loopEnd || 0, node.duration || 0);
    node.loopStart = loopStart;
    node.loopEnd = loopEnd;
    // Clamp to the recorded material (engine parity): a fractional-Q
    // drag rounded past the take's end must not window silence.
    if (node.type === 'clip' && (node.duration || 0) > 0) {
        loopStart = Math.max(0, loopStart);
        loopEnd = Math.min(loopEnd, node.duration);
        node.loopStart = loopStart;
        node.loopEnd = loopEnd;
    }
    // Q13 parity (AudioEngine::setLoopPoints): while the island's only
    // committed content is this clip (and no take is in flight), its
    // loop region re-establishes the STORED island (Q, epoch):
    // Q := window length, epoch := origin + window start. PHASE-
    // PRESERVING (engine parity): re-anchor origin so the buffer
    // position sounding right now doesn't move — fold it into the new
    // window and solve origin' = t0 − p_target.
    if (loopEnd > loopStart && isQ13SoleDefiner(node)) {
        const t0 = state.masterPos;
        const oldLen = oldLe - oldLs;
        const len = loopEnd - loopStart;
        const p0 = oldLen > 0
            ? oldLs + posMod(t0 - (node.origin || 0) - oldLs, oldLen)
            : loopStart;
        const pT = loopStart + posMod(p0 - loopStart, len);
        node.origin = t0 - pT;
        state.islandQ = len;
        state.islandEpoch = node.origin + loopStart;
        console.log('[MockBackend] Q13 re-trim → Q =', state.islandQ);
    } else if (node.type === 'clip' && (node.duration || 0) > 0 &&
               state.isPlaying && !anyNodeRecording()) {
        // TWO-ANCHOR CONTINUITY (see the note above continuityOrigin).
        applyTwoAnchorContinuity(node, oldMapPre,
            loopEnd > loopStart ? { segs: [[loopStart, loopEnd]] }
                                : { segs: [] });
    }
    console.log('[MockBackend] Set loop points:', id, '→', loopStart, '-', loopEnd);
}

/**
 * Install a multi-segment time-map override from a FLAT [s0,e0,s1,e1,…]
 * list (protocol form; phase 3).
 *
 * Contract (engine parity, AudioEngine::setSegments):
 *  - Refuses on: unknown node, armed/recording target (a stack answers
 *    for its subtree), malformed lists (unordered / overlapping /
 *    empty / past the intrinsic cycle), and incoherent periods (the
 *    Σ of cell lengths must be a whole multiple or exact divisor of Q
 *    — sole exception: the Q13 definer re-trim, which re-establishes
 *    Q). Every refusal records nothing (popUndoForRefusal, which also
 *    breaks the live-drag coalescing chain).
 *  - n ≤ 1 delegates to the single-window path (which owns Q13 and
 *    clears the override itself — a refused delegation therefore
 *    leaves the existing override untouched).
 *  - Q13 sole definer: Q := map period, epoch := origin' + mapOffset(0),
 *    phase-preserving; otherwise two-anchor continuity on a playing clip.
 */
export function setSegments(id, flat) {
    // Engine parity: a REFUSED edit records nothing — the dispatch
    // snapshotted before we could refuse, so drop that snapshot on
    // every refusal path.
    const refuse = (why) => {
        console.log('[MockBackend] setSegments refused —', why);
        // A refused edit records nothing: drop the snapshot only if the
        // dispatch pushed one for THIS call (coalesced calls didn't),
        // and break the coalescing chain (nothing mutated).
        popUndoForRefusal();
    };
    const node = findNode(id);
    if (!node) { refuse('no such node'); return; }
    // Mid-take gate (engine parity): any armed/recording target refuses
    // (a stack answers for its subtree).
    if (node.isRecording || subtreeRecording(node)) {
        refuse('take armed/recording');
        return;
    }
    const segs = [];
    for (let i = 0; i + 1 < (flat || []).length; i += 2) {
        segs.push([flat[i], flat[i + 1]]);
    }
    // Structural sanity (engine parity): ordered, disjoint, non-empty,
    // within the inner cycle.
    const intrinsic = intrinsicOfNode(node);
    let prev = 0;
    for (const [s, e] of segs) {
        if (e <= s || s < prev || (intrinsic > 0 && e > intrinsic)) {
            refuse('malformed list');
            return;
        }
        prev = e;
    }
    // n ≤ 1 delegates to the single-window path (owns Q13). Direct
    // call: the callNative dispatch already snapshotted for undo.
    // The delegate clears the override itself AFTER its own gates, so
    // a refused delegation leaves node.segments untouched.
    if (segs.length <= 1) {
        if (segs.length === 1) setLoopPoints(id, segs[0][0], segs[0][1]);
        else setLoopPoints(id, 0, 0);
        return;
    }
    // COHERENCE GUARD (owner ruling 2026-08-09): the map's PERIOD must
    // be a whole multiple of Q — categorical, both sides. One
    // incoherent period LCM'd the effective cycle to 66187Q (field
    // video 2026-08-08) and blanked the timeline. The sole exception
    // is the Q13 sole-definer re-trim below, where the period
    // *re-establishes* Q rather than fighting it.
    {
        const q13 = isQ13SoleDefiner(node);
        const q = state.islandQ;
        const p = segs.reduce((n, [s, e]) => n + (e - s), 0);
        // Coherent = whole multiple of Q, or an exact divisor of it
        // (sub-Q loops are first-class; lcm(Q, Q/k) = Q).
        const coherent = p > 0 && (p % q === 0 || q % p === 0);
        if (!q13 && q > 0 && !coherent) {
            refuse('period ' + p + ' is neither a whole multiple nor ' +
                'an exact divisor of Q ' + q +
                ' (coherence is categorical)');
            return;
        }
    }
    // Q13 multi-segment definer rider (engine parity): capture the OLD
    // map before mutating for the phase-preserving re-anchor.
    const oldMap = node.loopBypassed ? { segs: [] } : nodeMap(node);
    node.segments = segs;
    if (isQ13SoleDefiner(node)) {
        const map = { segs };
        const period = mapPeriod(map);
        const a0 = mapOffset(map, 0);
        const t0 = state.masterPos;
        let hNew = 0;
        if (mapActive(oldMap) && mapPeriod(oldMap) > 0) {
            const oldOrg = node.origin || 0;
            const p0 = mapOffset(oldMap,
                t0 - oldOrg - mapOffset(oldMap, 0));
            const invH = heardOffsetOf(map, p0);
            if (invH >= 0) hNew = invH;
            else {
                const h0 = heardOffsetOf(oldMap, p0);
                hNew = posMod(h0, period);
            }
        }
        node.origin = t0 - a0 - hNew;
        state.islandQ = period;
        state.islandEpoch = node.origin + a0;
        console.log('[MockBackend] Q13 segments re-trim → Q =', period);
    } else if (node.type === 'clip' && (node.duration || 0) > 0 &&
               state.isPlaying && !anyNodeRecording()) {
        // TWO-ANCHOR CONTINUITY (see the note above continuityOrigin).
        applyTwoAnchorContinuity(node, oldMap, { segs });
    }
    console.log('[MockBackend] setSegments:', id, '→', JSON.stringify(segs));
}

export function toggleLoopWindow(id) {
    // Fractal (I5, engine parity): clips toggle their single-segment
    // window exactly like stacks toggle their time-map.
    const node = findNode(id);
    if (node) {
        // MID-TAKE MAP-EDIT GATE (see setLoopPoints).
        if (node.type === 'stack' && subtreeRecording(node)) {
            console.log('[MockBackend] toggleLoopWindow refused — take recording in subtree');
            popUndoForRefusal();  // a refused edit records nothing
            return;
        }
        node.loopBypassed = !node.loopBypassed;
        console.log('[MockBackend] Loop window', id, '→',
            node.loopBypassed ? 'BYPASSED' : 'ACTIVE');
    }
}
