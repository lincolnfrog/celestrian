/**
 * mock/takes.js — the take list and the comp (docs/takes.md; engine
 * parity AudioEngine::selectTake / deleteTake / setComp /
 * getTakeWaveform). A committed clip holds `takes` (one waveform seed
 * per take), `activeTake`, and `comp` (one take index per Q cell, −1 =
 * the active take; [] = none). All three verbs are UNDOABLE (the
 * dispatch snapshot) and refused mid-take; refusals drop the snapshot.
 * The new-take arm lives with the recording lifecycle (recording.js).
 */

import { findNode, anyNodeRecording, effectiveQuantumForState } from './state.js';
import { popUndoForRefusal } from './undo.js';
import { takesOf } from './recording.js';

export function selectTake(id, index) {
    const node = findNode(id);
    if (!node || node.type !== 'clip' || anyNodeRecording()) {
        popUndoForRefusal();
        return;
    }
    const takes = takesOf(node);
    const k = Number(index);
    if (!(k >= 0 && k < takes.length) || k === (node.activeTake || 0)) {
        popUndoForRefusal();
        return;
    }
    node.takes = takes.slice();
    node.activeTake = k;
    console.log('[MockBackend] selectTake', id, '→', k);
}

export function deleteTake(id, index) {
    const node = findNode(id);
    if (!node || node.type !== 'clip' || anyNodeRecording()) {
        popUndoForRefusal();
        return;
    }
    const takes = takesOf(node).slice();
    const k = Number(index);
    if (takes.length < 2 || !(k >= 0 && k < takes.length)) {
        popUndoForRefusal();  // the last take never deletes
        return;
    }
    const active = node.activeTake || 0;
    takes.splice(k, 1);
    node.takes = takes;
    // An active take hands activity to its lower neighbour (engine
    // parity ClipNode::removeTake); higher indices renumber.
    if (active === k) node.activeTake = k > 0 ? k - 1 : 0;
    else if (active > k) node.activeTake = active - 1;
    // Cells naming the removed take fall back to the active one; a comp
    // naming nothing anymore clears (engine parity dropTakeFromComp).
    if (Array.isArray(node.comp) && node.comp.length) {
        const cells = node.comp.map(c => (c === k ? -1 : (c > k ? c - 1 : c)));
        node.comp = cells.some(c => c >= 0) ? cells : [];
    }
    console.log('[MockBackend] deleteTake', id, k, '→ active', node.activeTake);
}

export function setComp(id, cells) {
    const node = findNode(id);
    if (!node || node.type !== 'clip' || anyNodeRecording() ||
        node.contentKind === 'midi') {
        popUndoForRefusal();
        return;
    }
    const Q = effectiveQuantumForState();
    const period = node.duration || 0;
    if (!(Q > 0) || !(period > 0)) { popUndoForRefusal(); return; }
    const expected = Math.ceil(period / Q);
    const next = Array.isArray(cells) ? cells.map(Number) : [];
    const count = takesOf(node).length;
    if ((next.length && next.length !== expected) ||
        next.some(c => !(c >= -1 && c < count))) {
        console.log('[MockBackend] setComp refused — bad cells for', id);
        popUndoForRefusal();
        return;
    }
    const cur = node.comp || [];
    if (cur.length === next.length && cur.every((c, i) => c === next[i])) {
        popUndoForRefusal();  // identity: nothing recorded
        return;
    }
    node.comp = next;
    console.log('[MockBackend] setComp', id, next);
}

/** Deterministic peaks for take `index` (the seed shifts the phase, so
 * takes draw differently and stably). */
export function takePeaks(node, index, numPeaks = 100) {
    const takes = takesOf(node);
    if (!(index >= 0 && index < takes.length)) return [];
    const seed = takes[index].seed || 0;
    const peaks = [];
    for (let i = 0; i < numPeaks; i++) {
        peaks.push(0.5 + 0.4 * Math.sin((i / numPeaks) * Math.PI * 4 + seed));
    }
    return peaks;
}

export function getTakeWaveform(id, index, numPeaks = 100) {
    const node = findNode(id);
    if (!node || node.type === 'stack') return [];
    if (node.isRecording || node.isPendingStart) return [];
    if (!node.duration || node.duration <= 0) return [];
    return takePeaks(node, Number(index), numPeaks);
}

/** Publication (engine parity ClipNode::getMetadata): count, active,
 * comp on every clip. */
export function publishTakes(node, out) {
    out.takes = takesOf(node).length;
    out.activeTake = node.activeTake || 0;
    out.comp = Array.isArray(node.comp) ? [...node.comp] : [];
}
