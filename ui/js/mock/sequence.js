/**
 * mock/sequence.js — THE SEQUENCER's edit surface (docs/sequencer.md),
 * mock twin of AudioEngine::setSequence / toggleSequence.
 *
 * Storage shape (identical to the engine's metadata publish, so
 * publish.js can pass it through verbatim):
 *   node.sequence          = { steps: [{name, len, cue, next?}],
 *                              gates: {uuid: [bool]}, seed }
 *   node.sequenceBypassed  = bool   (the jam toggle — survives replace,
 *                                    like the loop-window bypass flag)
 * The synthetic root ('mock-root') stores the same pair on `state`
 * (state.rootSequence / state.rootSequenceBypassed) and publishes it
 * top-level, mirroring the engine root's metadata.
 *
 * THE PROGRAM (§14): every timeline question here — total length,
 * step at a position, bounds, the audition span — reads through the
 * unrolled program of (steps, seed) (sequence_program.js, the engine
 * mirror), never the raw step list. A radio (period-less program) is
 * legal on the ROOT only (S12): nested targets refuse it.
 *
 * Semantics mirrored: mid-take gate (refuse while a take is armed or
 * recording in the subtree), 1..64 steps with positive lengths, free
 * lengths ACCEPTED (S10: steps concatenate — the UI snaps and badges),
 * successors in range with positive weights, clear on a null/empty
 * payload.
 */

import {
    state, findNode, subtreeRecording, anyNodeRecording,
} from './state.js';
import { popUndoForRefusal } from './undo.js';
import { posMod } from '../math_utils.js';
import { programOf, visitBounds } from '../sequence_program.js';

const MAX_STEPS = 64;

/** The unrolled program of a stored sequence ({visits, radio, …}). */
export function seqProgram(seq) {
    if (!seq || !Array.isArray(seq.steps) || !seq.steps.length) {
        return { visits: [], radio: false, reachable: [], firstVisit: [] };
    }
    return programOf(seq.steps, seq.seed || 0);
}

/** Step lengths in samples (rounded, non-negative). */
function stepLens(seq) {
    return seq.steps.map(s => (s.len > 0 ? Math.round(s.len) : 0));
}

/** Total PROGRAM length of a stored sequence object (0 = none/empty). */
function seqTotal(seq) {
    if (!seq || !Array.isArray(seq.steps)) return 0;
    const lens = stepLens(seq);
    return seqProgram(seq).visits.reduce((t, i) => t + lens[i], 0);
}

/** The ACTIVE sequence length of a node-or-root holder (period law). */
export function activeSeqLen(holder) {
    if (holder.sequenceBypassed) return 0;
    return seqTotal(holder.sequence);
}

function resolve(id) {
    if (id === 'mock-root' || id === '' || id == null) {
        return {
            holder: {
                get sequence() { return state.rootSequence; },
                set sequence(v) { state.rootSequence = v; },
                get sequenceBypassed() { return state.rootSequenceBypassed; },
                set sequenceBypassed(v) { state.rootSequenceBypassed = v; },
                get auditionStep() { return state.rootAuditionStep ?? -1; },
                set auditionStep(v) { state.rootAuditionStep = v; },
            },
            recording: anyNodeRecording(),
            isRoot: true,
        };
    }
    const node = findNode(id);
    if (!node || node.type !== 'stack') return null;
    return { holder: node, recording: subtreeRecording(node), isRoot: false };
}

/** Normalize a payload step's successor list; null = malformed. */
function readSuccessors(step, stepCount) {
    if (step.next == null) return [];
    if (!Array.isArray(step.next)) return null;
    const next = [];
    for (const s of step.next) {
        const to = Number(s && s.to), w = Number(s && s.w != null ? s.w : 1);
        if (!Number.isInteger(to) || to < 0 || to >= stepCount || !(w > 0)) {
            return null;
        }
        next.push({ to, w: Math.floor(w) });
    }
    return next;
}

/**
 * THE ROOT'S ANCHOR (docs/frame.md §4; engine parity
 * AudioEngine::setSequence): a song authored on the root anchors it —
 * Q18 at depth 0 — at `zero`, the absolute sample the view had seated
 * the frame's zero on (snapped to the Q grid; the island zero when
 * absent), so authoring a song moves nothing on screen. A root already
 * anchored keeps its origin (the song owns the frame); clearing the
 * song un-anchors. The undo snapshot carries both.
 */
function anchorRootForSong(installing, zero) {
    const Q = state.islandQ;
    if (installing && !state.rootAnchored && Q > 0) {
        const epoch = state.islandEpoch || 0;
        const z = Number.isFinite(zero) ? Math.round(zero) : epoch;
        state.rootAnchored = true;
        state.rootOrigin = z - posMod(z - epoch, Q);
    } else if (!installing && state.rootAnchored) {
        state.rootAnchored = false;
        state.rootOrigin = 0;
    }
}

export function setSequence(id, payload, zero) {
    const t = resolve(id);
    if (!t) {
        console.log('[MockBackend] setSequence refused — not a stack:', id);
        popUndoForRefusal();
        return;
    }
    if (t.recording) {
        console.log('[MockBackend] setSequence refused — take armed/recording');
        popUndoForRefusal();
        return;
    }
    if (!payload || !Array.isArray(payload.steps) || !payload.steps.length) {
        t.holder.sequence = null;  // clear (bypass flag survives, engine parity)
        t.holder.auditionStep = -1;
        if (t.isRoot) anchorRootForSong(false);
        console.log('[MockBackend] Sequence cleared on', id);
        return;
    }
    if (payload.steps.length > MAX_STEPS ||
        payload.steps.some(s => !(s.len > 0))) {
        console.log('[MockBackend] setSequence refused — malformed steps');
        popUndoForRefusal();
        return;
    }
    const nexts = payload.steps.map(s => readSuccessors(s, payload.steps.length));
    if (nexts.some(n => n === null)) {
        console.log('[MockBackend] setSequence refused — successor out of range');
        popUndoForRefusal();
        return;
    }
    const steps = payload.steps.map((s, i) => ({
        name: String(s.name || ''), len: Math.round(s.len),
        // CUE (docs/sequencer.md ss3, S11/S20-S22): a cued step
        // re-bases the subtree to the step top.
        cue: !!s.cue,
        // The successor graph (§14): empty = the loop successor.
        ...(nexts[i].length ? { next: nexts[i] } : {}),
        // Per-step fades (S13, §15): samples, never negative; absent
        // when 0 (the anti-pop micro-fade only).
        ...(s.fadeIn > 0 ? { fadeIn: Math.round(s.fadeIn) } : {}),
        ...(s.fadeOut > 0 ? { fadeOut: Math.round(s.fadeOut) } : {}),
    }));
    const seed = Number.isFinite(Number(payload.seed))
        ? (Number(payload.seed) >>> 0) : 0;
    // ROOT-ONLY RADIO (S12, composition.md §3): a period-less program
    // cannot give its parent a period.
    if (programOf(steps, seed).radio && !t.isRoot) {
        console.log('[MockBackend] setSequence refused — a radio has no ' +
            'period; root only (S12)');
        popUndoForRefusal();
        return;
    }
    const gates = {};
    for (const [uuid, bits] of Object.entries(payload.gates || {})) {
        gates[uuid] = steps.map((_, i) => !!(bits && bits[i]));
    }
    // A shape change clears the audition (engine parity: the index
    // follows a resize, never a delete).
    const before = t.holder.sequence ? t.holder.sequence.steps.length : 0;
    if (before !== steps.length) t.holder.auditionStep = -1;
    t.holder.sequence = { steps, gates, seed };
    if (t.isRoot) anchorRootForSong(true, zero);
    console.log('[MockBackend] Sequence set on', id, '-', steps.length,
        'steps,', seqTotal(t.holder.sequence), 'samples');
}

/**
 * THE STEP AUDITION (docs/sequencer.md §11.2), mock twin of
 * AudioEngine::auditionStep: a MONITORING gesture (not undoable, not
 * persisted) — `holder.auditionStep` (−1 = none; the root stores
 * state.rootAuditionStep). While set and the sequence is active, the
 * holder's time-map IS the step's FIRST visit's span, derived (see
 * auditionMap). An unreachable step has no span: refused.
 */
export function auditionStep(id, step) {
    const t = resolve(id);
    if (!t) {
        console.log('[MockBackend] auditionStep refused — not a stack:', id);
        return;
    }
    if (t.recording) {
        console.log('[MockBackend] auditionStep refused — take armed/recording');
        return;
    }
    const n = Number(step);
    if (n >= 0) {
        const seq = activeSeqLen(t.holder) > 0 ? t.holder.sequence : null;
        if (!seq || n >= seq.steps.length || !seqProgram(seq).reachable[n]) {
            console.log('[MockBackend] auditionStep refused — no such step ' +
                'in the active program');
            return;
        }
    }
    t.holder.auditionStep = n >= 0 ? Math.floor(n) : -1;
    console.log('[MockBackend] audition step', t.holder.auditionStep, 'on', id);
}

/** Whether step i of a stored sequence is CUED (out of range = false). */
export function stepCued(seq, i) {
    return !!(seq && seq.steps && seq.steps[i] && seq.steps[i].cue);
}

/** Step index at folded position rel (samples) of a stored sequence —
 * through the PROGRAM (the visit's step). */
export function stepIndexAt(seq, rel) {
    const k = visitIndexAt(seq, rel);
    return k < 0 ? -1 : seqProgram(seq).visits[k];
}

/** Visit index at folded position rel (samples); −1 with no program. */
export function visitIndexAt(seq, rel) {
    const total = seqTotal(seq);
    if (!(total > 0)) return -1;
    const b = seqBounds(seq);
    const r = posMod(rel, total);
    for (let k = 0; k + 1 < b.length; k++) {
        if (r < b[k + 1]) return k;
    }
    return b.length - 2;
}

/** VISIT bounds (samples) of a stored sequence: [b0, b1, ..., bN]. */
export function seqBounds(seq) {
    if (!seq || !Array.isArray(seq.steps)) return [0];
    return visitBounds(seqProgram(seq).visits, stepLens(seq));
}

/** The span [start, end) of step i's FIRST visit, or null. */
export function firstVisitSpan(seq, i) {
    const k = seqProgram(seq).firstVisit[i];
    if (!(k >= 0)) return null;
    const b = seqBounds(seq);
    return b[k + 1] > b[k] ? [b[k], b[k + 1]] : null;
}

/** The DERIVED audition map of a holder (node or the root holder), or
 * null when no audition applies (engine parity: StackNode::auditionMap). */
export function auditionMap(holder) {
    const i = holder.auditionStep;
    if (!(i >= 0)) return null;
    if (activeSeqLen(holder) <= 0) return null;
    const span = firstVisitSpan(holder.sequence, i);
    return span ? { segs: [span] } : null;
}

export function toggleSequence(id) {
    const t = resolve(id);
    if (!t) { popUndoForRefusal(); return; }
    if (t.recording) {
        console.log('[MockBackend] toggleSequence refused — take armed/recording');
        popUndoForRefusal();
        return;
    }
    t.holder.sequenceBypassed = !t.holder.sequenceBypassed;
    console.log('[MockBackend] Sequence', id,
        t.holder.sequenceBypassed ? 'bypassed (jam)' : 'active');
}

/**
 * SEQUENCES TRACK Q (engine parity AudioEngine::setIslandQuantum):
 * step lengths are musical facts. Call
 * wherever the mock re-establishes Q from an edit: Q → Q' rescales every
 * sequence's steps by Q'/Q (a 5Q step stays 5Q); Q → 0 (empty island)
 * CLEARS them. Undo is the snapshot (it holds the old sequences).
 */
export function retimeSequences(oldQ, newQ) {
    if (oldQ === newQ) return;
    const holders = [resolve('mock-root').holder];
    (function visit(nodes) {
        (nodes || []).forEach(n => {
            if (n.type === 'stack') { holders.push(n); visit(n.nodes); }
        });
    })(state.nodes);
    holders.forEach(h => {
        if (!h || !h.sequence) return;
        if (!(newQ > 0)) {
            h.sequence = null;
            h.auditionStep = -1;
            // The root's anchor rides its song (frame.md §4).
            if (h === holders[0]) anchorRootForSong(false);
            console.log('[MockBackend] sequences cleared: empty island');
            return;
        }
        if (!(oldQ > 0)) return;
        h.sequence = {
            ...h.sequence,
            steps: h.sequence.steps.map(st => ({
                ...st, len: Math.round(st.len * newQ / oldQ),
                ...(st.fadeIn > 0 ? { fadeIn: Math.round(st.fadeIn * newQ / oldQ) } : {}),
                ...(st.fadeOut > 0 ? { fadeOut: Math.round(st.fadeOut * newQ / oldQ) } : {}),
            })),
        };
    });
}
