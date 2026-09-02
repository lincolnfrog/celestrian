/**
 * mock/midi.js — the MIDI note readout (docs/vst3.md §11; engine
 * parity AudioEngine::getMidiNotes). A MIDI clip fixture carries its
 * raw content events on `midi` as [pos, status, data1, data2] (pos in
 * samples, content frame); the readout pairs them (midi_notes.js —
 * the same pure function the UI tests pin) and answers QTime rows on
 * the island rate. Empty for an audio clip, an empty clip, or while a
 * take is live on it.
 */

import { pairMidiEvents } from '../midi_notes.js';
import { findNode, effectiveQuantumForState } from './state.js';
import { gcd } from '../math_utils.js';

/** samples → a reduced [num, den] on the island exchange rate. */
function qtimeRow(samples, Q) {
    const s = Math.round(samples);
    if (s === 0) return [0, 1];
    const g = gcd(Math.abs(s), Q) || 1;
    return [s / g, Q / g];
}

export function getMidiNotes(id) {
    const node = findNode(id);
    if (!node || node.type !== 'clip' || node.contentKind !== 'midi') return [];
    if (node.isRecording || node.isPendingStart) return [];
    const duration = node.duration || 0;
    const Q = effectiveQuantumForState();
    if (!(duration > 0) || !(Q > 0)) return [];
    return pairMidiEvents(node.midi || [], duration).map(n => [
        ...qtimeRow(n.pos, Q), n.note, n.vel, ...qtimeRow(n.len, Q),
    ]);
}
