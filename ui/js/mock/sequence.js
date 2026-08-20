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

export const MAX_STEPS = 64;

/** Total length of a stored sequence object (0 = none/empty). */
export function seqTotal(seq) {
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
        name: String(s.name || ''), len: Math.round(s.len) }));
    const gates = {};
    for (const [uuid, bits] of Object.entries(payload.gates || {})) {
        gates[uuid] = steps.map((_, i) => !!(bits && bits[i]));
    }
    t.holder.sequence = { steps, gates };
    console.log('[MockBackend] Sequence set on', id, '-', steps.length,
        'steps,', seqTotal(t.holder.sequence), 'samples');
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
