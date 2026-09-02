/**
 * mock/sequence.js — THE SEQUENCER's edit surface (docs/sequencer.md),
 * mock twin of AudioEngine::setSequence / toggleSequence.
 *
 * Storage shape (identical to the engine's metadata publish, so
 * publish.js can pass it through verbatim):
 *   node.sequence          = { steps: [{name, len}], gates: {uuid: [bool]} }
 *   node.sequenceBypassed  = bool   (the jam toggle — survives replace,
 *                                    like the loop-window bypass flag)
 * The synthetic root ('mock-root') stores the same pair on `state`
 * (state.rootSequence / state.rootSequenceBypassed) and publishes it
 * top-level, mirroring the engine root's metadata.
 *
 * Semantics mirrored: mid-take gate (refuse while a take is armed or
 * recording in the subtree), 1..64 steps with positive lengths, free
 * lengths ACCEPTED (S10: steps concatenate — the UI snaps and badges),
 * clear on a null/empty payload.
 */

import {
    state, findNode, subtreeRecording, anyNodeRecording,
} from './state.js';
import { popUndoForRefusal } from './undo.js';

const MAX_STEPS = 64;

/** Total length of a stored sequence object (0 = none/empty). */
function seqTotal(seq) {
    if (!seq || !Array.isArray(seq.steps)) return 0;
    return seq.steps.reduce((t, s) => t + (s.len > 0 ? Math.round(s.len) : 0), 0);
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
        };
    }
    const node = findNode(id);
    if (!node || node.type !== 'stack') return null;
    return { holder: node, recording: subtreeRecording(node) };
}

export function setSequence(id, payload) {
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
        console.log('[MockBackend] Sequence cleared on', id);
        return;
    }
    if (payload.steps.length > MAX_STEPS ||
        payload.steps.some(s => !(s.len > 0))) {
        console.log('[MockBackend] setSequence refused — malformed steps');
        popUndoForRefusal();
        return;
    }
    const steps = payload.steps.map(s => ({
        name: String(s.name || ''), len: Math.round(s.len),
        // CUE (docs/sequencer.md ss3, S11/S20-S22): a cued step
        // re-bases the subtree to the step top.
        cue: !!s.cue }));
    const gates = {};
    for (const [uuid, bits] of Object.entries(payload.gates || {})) {
        gates[uuid] = steps.map((_, i) => !!(bits && bits[i]));
    }
    // A shape change clears the audition (engine parity: the index
    // follows a resize, never a delete).
    const before = t.holder.sequence ? t.holder.sequence.steps.length : 0;
    if (before !== steps.length) t.holder.auditionStep = -1;
    t.holder.sequence = { steps, gates };
    console.log('[MockBackend] Sequence set on', id, '-', steps.length,
        'steps,', seqTotal(t.holder.sequence), 'samples');
}

/**
 * THE STEP AUDITION (docs/sequencer.md §11.2), mock twin of
 * AudioEngine::auditionStep: a MONITORING gesture (not undoable, not
 * persisted) — `holder.auditionStep` (−1 = none; the root stores
 * state.rootAuditionStep). While set and the sequence is active, the
 * holder's time-map IS the step's span, derived (see auditionMap).
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
        if (!seq || n >= seq.steps.length) {
            console.log('[MockBackend] auditionStep refused — no such step');
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

/** Step index at folded position rel (samples) of a stored sequence. */
export function stepIndexAt(seq, rel) {
    const total = seqTotal(seq);
    if (!(total > 0)) return -1;
    let r = ((rel % total) + total) % total;
    for (let i = 0; i < seq.steps.length; i++) {
        const len = seq.steps[i].len > 0 ? Math.round(seq.steps[i].len) : 0;
        if (r < len) return i;
        r -= len;
    }
    return seq.steps.length - 1;
}

/** Step bounds (samples) of a stored sequence: [b0, b1, ..., bn]. */
export function seqBounds(seq) {
    const b = [0];
    (seq && seq.steps || []).forEach(s => b.push(b[b.length - 1] + (s.len > 0 ? Math.round(s.len) : 0)));
    return b;
}

/** The DERIVED audition map of a holder (node or the root holder), or
 * null when no audition applies (engine parity: StackNode::auditionMap). */
export function auditionMap(holder) {
    const i = holder.auditionStep;
    if (!(i >= 0)) return null;
    if (activeSeqLen(holder) <= 0) return null;
    const b = seqBounds(holder.sequence);
    if (i + 1 >= b.length) return null;
    return { segs: [[b[i], b[i + 1]]] };
}

/** The root as a sequence holder (state.rootSequence & co.). */
function rootHolder() {
    return {
        get sequence() { return state.rootSequence; },
        get sequenceBypassed() { return state.rootSequenceBypassed; },
        get auditionStep() { return state.rootAuditionStep ?? -1; },
    };
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
            console.log('[MockBackend] sequences cleared: empty island');
            return;
        }
        if (!(oldQ > 0)) return;
        h.sequence = {
            ...h.sequence,
            steps: h.sequence.steps.map(st => ({
                ...st, len: Math.round(st.len * newQ / oldQ),
            })),
        };
    });
}
