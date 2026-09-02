/**
 * mock/import.js — audio file import (docs/import.md; engine parity
 * AudioEngine::importAudio). The mock decodes nothing: it synthesizes
 * a take of the requested placement and records what was asked
 * (state.lastImport) for the UI tests to read.
 *
 * Contract, in evaluation order (engine parity):
 *  - refused while any take is live or armed, on a MIDI track, on a
 *    full take list, or on a path the mock cannot "read" (see below);
 *  - a STACK target gains a fresh clip child named after the file;
 *  - an EMPTY clip takes a FIRST TAKE: origin = epoch + the nearest
 *    whole Q to `atQ`, length through the hysteresis law
 *    (snapCommittedDuration); a pre-Q island takes the clock as the
 *    origin and the file's length as Q (a first recorded take);
 *  - a COMMITTED clip takes a NEW TAKE of the slot (the file cut or
 *    padded to the period — the slot's facts stand), active on arrival.
 * Undoable: the dispatch snapshot (UNDOABLE in mock/undo.js);
 * refusals drop it.
 *
 * The FILE LENGTH the mock "decodes": a `#len=<samples>` suffix on the
 * path names it (tests); otherwise 2Q on an established island and 2 s
 * of audio on a pre-Q one. A path ending in `.missing` is unreadable.
 */

import { snapCommittedDuration, launchPointFor } from '../timeline_model.js';
import { state, findNode, anyNodeRecording, effectiveQuantumForState,
         settleAnchors } from './state.js';
import { popUndoForRefusal } from './undo.js';
import { createNode } from './graph_crud.js';
import { takesOf } from './recording.js';
import { getSampleRate } from './rate.js';

/** The path the dialog verb records in place of a chosen file. */
export const DIALOG_PATH = '<dialog>';
/** The take list bound (engine parity ClipNode::kMaxTakes). */
const MAX_TAKES = 32;

/** The nearest whole Q to a QTime ([num, den] or a bare number). */
export function nearestWholeQ(atQ) {
    if (Array.isArray(atQ)) {
        const den = Number(atQ[1]) || 1;
        return Math.round(Number(atQ[0]) / den);
    }
    return Math.round(Number(atQ) || 0);
}

/** The length the mock decodes for `path` (see the module comment). */
export function decodedLength(path) {
    const m = /#len=(\d+)/.exec(String(path || ''));
    if (m) return Number(m[1]);
    const Q = effectiveQuantumForState();
    return Q > 0 ? 2 * Q : 2 * getSampleRate();
}

function refuse(why) {
    console.log('[MockBackend] import refused —', why);
    popUndoForRefusal();
    return false;
}

export function importAudio(uuid, path, atQ) {
    if (anyNodeRecording()) return refuse('a take is live');
    if (/\.missing$/.test(String(path || ''))) return refuse('unreadable file ' + path);
    let node = uuid === 'mock-root' ? { id: 'mock-root', type: 'stack' } : findNode(uuid);
    if (!node) return refuse('no node ' + uuid);
    if (node.type === 'stack') {
        const id = createNode('clip', uuid === 'mock-root' ? null : uuid);
        node = findNode(id);
        node.name = String(path).split(/[\\/]/).pop()
            .replace(/#len=\d+$/, '').replace(/\.[^.]+$/, '') || node.name;
    } else if (node.contentKind === 'midi' ||
        ((node.effects && node.effects.chain) || []).some(s => s.isInstrument)) {
        return refuse(uuid + ' is a MIDI track');
    }
    const length = decodedLength(path);
    const Q = effectiveQuantumForState();

    if ((node.duration || 0) > 0) {
        // THE SECOND FORM: a new take of the slot (docs/takes.md).
        const takes = takesOf(node).slice();
        if (takes.length >= MAX_TAKES) return refuse(uuid + ' holds the maximum number of takes');
        const seed = takes.reduce((m, t) => Math.max(m, t.seed || 0), 0) + 1;
        takes.push({ seed, imported: path });
        node.takes = takes;
        node.activeTake = takes.length - 1;
        state.lastImport = { uuid, path, atQ, form: 'take', targetId: node.id };
        console.log('[MockBackend] imported', path, 'as take', node.activeTake, 'of', node.id);
        return true;
    }

    // THE FIRST FORM: a first take of an empty clip.
    const snap = snapCommittedDuration(length, Q);
    const origin = Q > 0 ? state.islandEpoch + nearestWholeQ(atQ) * Q : state.masterPos;
    node.duration = snap.duration;
    node.loopStart = 0;
    node.loopEnd = snap.loopEnd;
    node.origin = origin;
    node.launchPoint = launchPointFor(origin, snap.duration);
    node.isPlaying = true;
    node.contentKind = 'audio';
    node.contextCycle = 0;
    node.takes = [{ seed: 1, imported: path }];
    node.activeTake = 0;
    if (!(Q > 0)) {
        // A pre-Q island: the import is the first take — (Q, epoch)
        // establish together (engine parity establishIsland).
        state.islandQ = snap.duration;
        state.islandEpoch = origin;
        node.effectiveQuantum = snap.duration;
        console.log('[MockBackend] import establishes Q =', snap.duration);
    }
    settleAnchors();
    state.lastImport = { uuid, path, atQ, form: 'first', targetId: node.id };
    console.log('[MockBackend] imported', path, 'into', node.id, '— origin', origin,
        'duration', snap.duration);
    return true;
}

export function importAudioWithDialog(uuid, atQ) {
    return importAudio(uuid, DIALOG_PATH, atQ);
}

/** The last accepted import request ({uuid, path, atQ, form, targetId}),
 * or null. */
export function getLastImport() {
    return state.lastImport || null;
}

export function resetLastImport() {
    state.lastImport = null;
}
