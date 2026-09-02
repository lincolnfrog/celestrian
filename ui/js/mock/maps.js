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
    anyNodeRecording, isQ13SoleDefiner, isQ13DefinerStack,
    frameOriginOf, isAnchored, shiftOrigins, innerUnder, originForHeard,
} from './state.js';
import { popUndoForRefusal } from './undo.js';
import { lcm } from '../math_utils.js';
import { effectivePeriodOf } from './cycles.js';
import { activeSeqLen, retimeSequences } from './sequence.js';

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
/* Q18: ONE implementation for clips and stacks (engine parity
 * continuityOrigin) — the node's inner position now (the node
 * equation, state.innerUnder) re-anchored under the new map. For a
 * stack the returned origin moves its whole subtree (the caller's
 * shiftOrigins); an unanchored stack measures from its received cycle
 * top and nothing moves. */
function continuityOrigin(node, oldMap, newMap) {
    const dur = intrinsicOfNode(node);
    const eff = m => (m && mapActive(m) && mapPeriod(m) > 0)
        ? m : { segs: [[0, dur]] };
    const org = frameOriginOf(node);
    if (!(dur > 0)) return org;
    const o = eff(oldMap), nm = eff(newMap);
    const period = mapPeriod(nm);
    if (!(period > 0) || !(mapPeriod(o) > 0)) return org;
    const t0 = state.masterPos;
    const p0 = innerUnder(o, org, t0);
    if (heardOffsetOf(nm, p0) < 0) return org;  // sounding region removed
    return originForHeard(nm, t0, p0, 0);
}

/** The island's audible period WITHOUT `skip` (engine parity:
 * periodExcluding) — "everyone else", the fold a map edit is judged
 * against. A mapped stack's period stands whole. 0 = nothing else. */
function periodExcluding(node, skip) {
    if (node === skip || node.periodSource === 'context') return 0;
    if (node.type === 'stack') {
        if (!node.loopBypassed && mapActive(nodeMap(node))) {
            return Math.round(mapPeriod(nodeMap(node)));
        }
        let composite = 0;
        (node.nodes || []).forEach(c => {
            const p = periodExcluding(c, skip);
            if (p > 0) composite = composite > 0 ? lcm(composite, p) : p;
        });
        return composite;
    }
    return effectivePeriodOf(node);
}

/** The map-edit riders (engine parity: AudioEngine::attachMapEditRiders).
 * While playing, continuity re-anchors the origin so the sounding sample
 * keeps sounding. Then the CYCLE-TOP RULE (owner question 2026-08-18):
 * if `node` DEFINES the cycle after the edit (its new period is a
 * multiple of Q and of every other loop's period) and the loop's heard
 * top (origin' + mapOffset(0)) is off the frame top by a whole number of
 * Qs, the epoch moves TO that top — the loop you just shaped fills the
 * frame from its own top (the visual successor of the commit re-base
 * and the Q13 sole-definer re-trim). Otherwise two-anchor continuity
 * (2026-08-09) rides the epoch by the origin's whole-Q delta. Nothing
 * audible moves either way. */
function applyMapEditRiders(node, oldMap, newMap) {
    // Q18 (engine parity attachMapEditRiders): a stack's frame is its
    // own origin once anchored, else its received cycle top; the riders
    // then apply to clips and stacks alike. A re-anchor on a stack
    // moves its whole subtree (applySetsOrigin → shiftOrigins); an
    // unanchored stack has no content — nothing moves.
    const anchored = isAnchored(node);
    const org = frameOriginOf(node);
    const org2 = state.isPlaying ? continuityOrigin(node, oldMap, newMap) : org;
    if (org2 !== org && anchored) shiftOrigins(node, org2 - org);
    const q = state.islandQ;
    const delta = anchored ? org2 - org : 0;
    const epoch = state.islandEpoch || 0;
    const active = newMap && mapActive(newMap) && mapPeriod(newMap) > 0;
    const a0 = active ? mapOffset(newMap, 0) : 0;
    const top = org2 + a0;
    const newPeriod = Math.round(active ? mapPeriod(newMap) : intrinsicOfNode(node));
    let others = periodExcluding({ type: 'stack', nodes: state.nodes }, node);
    if (q > 0) others = others > 0 ? lcm(others, q) : q;
    const definer = newPeriod > 0 && (others <= 0 || newPeriod % others === 0);
    const topOffFrame = definer && posMod(top - epoch, newPeriod) !== 0;
    // The epoch moves in whole Qs. (Q18: no windowed-group guard is
    // needed any more — a stack's map anchors at the stack's OWN
    // origin, so an epoch move never re-selects content anywhere; the
    // 2026-08-30 epochViewStep is gone, composition.md §8.)
    const step = q > 0 ? q : 0;
    if (step > 0 && topOffFrame && posMod(top - epoch, step) === 0) {
        state.islandEpoch = top;
        return;
    }
    if (delta !== 0 && step > 0 && delta % step === 0) {
        state.islandEpoch = epoch + delta;
    }
}
/** Legacy name (tests import it). */
export const applyTwoAnchorContinuity = applyMapEditRiders;

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
/** S16 (docs/sequencer.md §11.8, engine parity stampWindowDomain): a
 * window edit on a STACK stamps its domain — 'sequence' when authored
 * over an active sequence timeline, else 'intrinsic'. Undo restores the
 * stamp with the snapshot. */
/** A stack's INNER cycle (engine StackNode::getIntrinsicDuration): the
 * LCM of its children's INTRINSIC durations (a member's raw take, a
 * nested stack's own inner cycle), one-shots excluded. (Folding the
 * children's EFFECTIVE periods here — the pre-2026-08-30 form —
 * diverged from the engine whenever a member carried a window: the
 * mock clamped a definer trim to the member window's length.) */
function stackInnerCycle(node) {
    let composite = 0;
    (node.nodes || []).forEach(c => {
        if (c.periodSource === 'context') return;
        const p = intrinsicOfNode(c);
        if (p > 0) composite = composite > 0 ? lcm(composite, p) : p;
    });
    return composite;
}

function stampWindowDomain(node) {
    if (node.type !== 'stack') return;
    node.windowDomain = activeSeqLen(node) > 0 ? 'sequence' : 'intrinsic';
}

export function setLoopPoints(id, loopStart, loopEnd) {
    const node = findNode(id);
    // Unknown node = a refusal too (F-C): the dispatch pre-pushed a
    // snapshot; leaving it made a no-op undo step (and ate the redo).
    if (!node) { popUndoForRefusal(); return; }
    // MID-TAKE MAP-EDIT GATE (engine parity, owner-ruled): a take
    // recording through this stack's map froze its geometry at arm —
    // refuse window edits until it commits. Siblings stay editable.
    if (node.isRecording || (node.type === 'stack' && subtreeRecording(node))) {
        console.log('[MockBackend] setLoopPoints refused — take recording here');
        popUndoForRefusal();  // a refused edit records nothing
        return;
    }
    // A NON-DEFINER stack window selects over its INNER cycle: an end
    // past it is malformed — refused, as the engine refuses (parity
    // with audit 2026-08-30 §1.5; the definer branch clamps instead).
    // (An EMPTY stack accepts freely — pre-authored parts are legal;
    // the Q-establishment scrub clears what the grid cannot carry.)
    if (node.type === 'stack' && !isQ13DefinerStack(node) &&
        loopEnd > loopStart) {
        const inner = stackInnerCycle(node);
        if (inner > 0 && loopEnd > inner) {
            console.log('[MockBackend] setLoopPoints refused — window end ' +
                loopEnd + ' is past the stack inner cycle ' + inner);
            popUndoForRefusal();  // a refused edit records nothing
            return;
        }
    }
    // COHERENCE GUARD (owner ruling 2026-08-09, engine parity): a
    // window length off the Q grid is refused — categorical, both
    // sides — unless this very edit re-establishes Q (the Q13
    // sole-definer re-trim below) or clears the window.
    {
        const cs = Math.max(0, loopStart);
        // Clamp to material even when there is NONE (F-A): an empty
        // clip's window clamps to end 0 — i.e. clears — instead of
        // storing a window over nothing.
        const ce = node.type === 'clip'
            ? Math.min(loopEnd, node.duration || 0) : loopEnd;
        // IDENTITY EDITS RECORD NOTHING (audit 2026-08-31 U3, engine
        // parity): re-committing the stored window is a no-op — no
        // undo step, and the redo branch survives. An installed
        // override still applies (the edit supersedes it).
        const storedLs = node.loopStart || 0;
        const storedLe = node.loopEnd || 0;
        const sameCleared = !(ce > cs) && !(storedLe > storedLs);
        if (!(Array.isArray(node.segments) && node.segments.length >= 2) &&
            (sameCleared || (cs === storedLs && ce === storedLe))) {
            popUndoForRefusal();  // a no-op records nothing
            return;
        }
        const q13 = ce > cs && (isQ13SoleDefiner(node) || isQ13DefinerStack(node));
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
    stampWindowDomain(node);
    // Clamp to the recorded material (engine parity): a fractional-Q
    // drag rounded past the take's end must not window silence. Even
    // when there is NO material (F-A): an empty clip's window clamps
    // to end 0 — cleared, never a window over nothing.
    if (node.type === 'clip') {
        loopStart = Math.max(0, loopStart);
        loopEnd = Math.min(loopEnd, node.duration || 0);
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
        retimeSequences(state.islandQ, len);  // sequences track Q
        state.islandQ = len;
        state.islandEpoch = node.origin + loopStart;
        console.log('[MockBackend] Q13 re-trim → Q =', state.islandQ);
    } else if (!(loopEnd > loopStart) && isQ13SoleDefiner(node) &&
               (node.duration || 0) > 0) {
        // WINDOW CLEAR RE-ESTABLISHES THE BASE FACTS (audit 2026-08-31
        // E8, engine parity): the definer's window was Q — clearing it
        // restores the full take as the part: Q := D, epoch := origin.
        retimeSequences(state.islandQ, node.duration);
        state.islandQ = node.duration;
        state.islandEpoch = node.origin || 0;
        console.log('[MockBackend] Q13 window clear → Q =', state.islandQ);
    } else if (node.type === 'stack' && isQ13DefinerStack(node)) {
        // Q13 FOR GROUPS — ONE PATH with the sole clip (Q18, composition
        // .md §5; engine parity AudioEngine::setLoopPoints): the definer
        // STACK's window re-establishes the island exactly as a sole
        // clip's does — Q := window length, epoch := origin' + start —
        // PHASE-PRESERVING by the node equation: the inner position
        // sounding now (state.nodeInner, measured from the STACK's own
        // origin) folds into the new window, origin' = t0 − pT, and the
        // origin shift moves the stack's whole SUBTREE (shiftOrigins),
        // so the members follow their group with no per-member riders
        // (the 2026-08-30 origin riders are gone). The window stays on
        // the stack (it IS the part); children stay whole.
        // MEMBERS WHOLE (engine parity, the window riders on the
        // stack-definer LoopPoints edit, 2026-08-30): a member still
        // carrying its own single window (a group take committed
        // against a locked Q, then left as the island's only content)
        // would loop its slice under the stack's window while the trim
        // view draws members whole. The snapshot undo restores them.
        // (Before the inner cycle is read: the engine's inner is the
        // members' RAW extent; whole members make the mock's agree.)
        for (const c of node.nodes || []) {
            if (c.type !== 'clip' || !(c.duration > 0) || c.isRecording) continue;
            if (Array.isArray(c.segments) && c.segments.length >= 2) continue;
            if ((c.loopStart || 0) === 0 && (c.loopEnd || 0) >= c.duration) continue;
            c.loopStart = 0;
            c.loopEnd = c.duration;
        }
        const inner = stackInnerCycle(node);
        loopStart = Math.max(0, loopStart);
        if (inner > 0) loopEnd = Math.min(loopEnd, inner);
        node.loopStart = loopStart;
        node.loopEnd = loopEnd;
        const anchored = isAnchored(node);
        const O = frameOriginOf(node);
        if (loopEnd > loopStart && inner > 0) {
            const t0 = state.masterPos;
            const len = loopEnd - loopStart;
            // The inner position sounding NOW by the actual playback
            // equation (the pre-edit map — the whole inner cycle when
            // none was active), folded into the new window.
            const oldMap = (mapActive(oldMapPre) && mapPeriod(oldMapPre) > 0)
                ? oldMapPre : { segs: [[0, inner]] };
            const p0 = innerUnder(oldMap, O, t0);
            const pT = loopStart + posMod(p0 - loopStart, len);
            const origin1 = t0 - pT;
            if (anchored) shiftOrigins(node, origin1 - O);
            retimeSequences(state.islandQ, len);  // sequences track Q
            state.islandQ = len;
            state.islandEpoch = origin1 + loopStart;
            console.log('[MockBackend] Q13 group re-trim → Q =', state.islandQ);
        } else if (!(loopEnd > loopStart) && inner > 0) {
            // WINDOW CLEAR RE-ESTABLISHES THE BASE FACTS (E8, one path
            // with the clip): Q := the whole inner cycle, epoch := the
            // stack's origin (the content-frame identity).
            retimeSequences(state.islandQ, inner);
            state.islandQ = inner;
            state.islandEpoch = anchored ? O : (state.islandEpoch || 0);
            console.log('[MockBackend] Q13 group window clear → Q =',
                state.islandQ);
        }
    } else if (intrinsicOfNode(node) > 0 && !anyNodeRecording()) {
        // CYCLE-TOP RULE + TWO-ANCHOR CONTINUITY (applyMapEditRiders)
        // — clips and stacks alike since Q18.
        applyMapEditRiders(node, oldMapPre,
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
    // An EMPTY clip has no material for a map to select (audit
    // 2026-08-31 F-A, engine parity): refuse. Empty STACKS accept —
    // pre-authored parts are legal; the Q-establishment scrub clears
    // what the grid cannot carry.
    if (segs.length >= 2 && intrinsic <= 0 && node.type === 'clip') {
        refuse('nothing committed here to map (record a take first)');
        return;
    }
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
        const q13 = isQ13SoleDefiner(node) || isQ13DefinerStack(node);
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
    stampWindowDomain(node);
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
        retimeSequences(state.islandQ, period);  // sequences track Q
        state.islandQ = period;
        state.islandEpoch = node.origin + a0;
        console.log('[MockBackend] Q13 segments re-trim → Q =', period);
    } else if (node.type === 'stack' && isQ13DefinerStack(node)) {
        // Q13 FOR GROUPS, multi-segment — ONE PATH with the clip
        // definer (Q18; engine parity AudioEngine::setSegments): Q :=
        // period, epoch := origin' + mapOffset(0), with the
        // phase-preserving re-anchor generalized through the map: the
        // inner position sounding now (from the STACK's own origin)
        // re-anchors under the new map (inverse-mapped when still
        // covered; the old heard phase folds into the new period when
        // the cut removed it), and the origin shift moves the subtree
        // (shiftOrigins). Members whole (the definer invariant).
        const map = { segs };
        const period = mapPeriod(map);
        const a0 = mapOffset(map, 0);
        const t0 = state.masterPos;
        const members = (node.nodes || []).filter(c =>
            c.type === 'clip' && (c.duration || 0) > 0 && !c.isRecording);
        if (period > 0 && members.length) {
            const O = frameOriginOf(node);
            let originNew = t0 - a0;  // no old map: heard phase 0 at t0
            if (mapActive(oldMap) && mapPeriod(oldMap) > 0) {
                const p0 = innerUnder(oldMap, O, t0);
                originNew = originForHeard(map, t0, p0, heardOffsetOf(oldMap, p0));
            }
            if (isAnchored(node)) shiftOrigins(node, originNew - O);
            members.forEach(c => {
                c.loopStart = 0;
                c.loopEnd = c.duration;
                delete c.segments;
            });
            retimeSequences(state.islandQ, period);  // sequences track Q
            state.islandQ = period;
            state.islandEpoch = originNew + a0;
            console.log('[MockBackend] Q13 group segments re-trim → Q =', period);
        }
    } else if (intrinsicOfNode(node) > 0 && !anyNodeRecording()) {
        // CYCLE-TOP RULE + TWO-ANCHOR CONTINUITY (applyMapEditRiders)
        // — clips and stacks alike since Q18.
        applyMapEditRiders(node, oldMap, { segs });
    }
    console.log('[MockBackend] setSegments:', id, '→', JSON.stringify(segs));
}

export function toggleLoopWindow(id) {
    // Fractal (I5, engine parity): clips toggle their single-segment
    // window exactly like stacks toggle their time-map.
    const node = findNode(id);
    if (!node) { popUndoForRefusal(); return; }  // unknown = refusal (F-C)
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
