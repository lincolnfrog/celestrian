/**
 * mock/midi.js — the MIDI note readout (docs/vst3.md §8.5; engine
 * AudioEngine::getMidiNotes). A MIDI fixture carries raw events on
 * `midi`; the readout pairs them (midi_notes.js) and answers rows
 * [posNum, posDen, note, vel, lenNum, lenDen] in Q. Empty for an audio
 * clip, an empty clip, or a clip under a take.
 */

import { pairMidiEvents } from '../midi_notes.js';
import { fromSamples } from '../qtime.js';
import { state, findNode, takeLength, isLive } from './state.js';

export function getMidiNotes(id) {
    const node = findNode(id);
    if (!node || node.type !== 'clip' || node.contentKind !== 'midi' || isLive(node)) return [];
    const duration = takeLength(node);
    const Q = state.islandQ;
    if (!(duration > 0) || !(Q > 0)) return [];
    const row = samples => {
        const t = fromSamples(Math.round(samples), Q);
        return [t.num, t.den];
    };
    return pairMidiEvents(node.midi || [], duration)
        .map(n => [...row(n.pos), n.note, n.vel, ...row(n.len)]);
}
