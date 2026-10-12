/**
 * mock/import.js — audio file import (docs/import.md; engine
 * AudioEngine::importAudio). The mock decodes nothing: it synthesizes a
 * take of the requested placement and records the request
 * (getLastImport) for the UI tests.
 *
 * The length the mock "decodes": a `#len=<samples>` suffix on the path
 * names it; otherwise 2Q, or two seconds before Q exists. A path ending
 * in `.missing` is unreadable.
 */

import { snapCommittedDuration } from '../timeline_model.js';
import {
    state, nodeOrRoot, takeLive, takeLength, takesOf, setStoredMap, settleAnchors,
} from './state.js';
import { newNode } from './graph_crud.js';
import { establishIsland } from './recording.js';
import { MAX_TAKES } from './takes.js';
import { effectiveCycle } from './cycles.js';
import { getSampleRate } from './rate.js';

/** The path the dialog verbs record in place of a chosen file. */
export const DIALOG_PATH = '<dialog>';

function decodedLength(path) {
    const m = /#len=(\d+)/.exec(String(path || ''));
    if (m) return Number(m[1]);
    return state.islandQ > 0 ? 2 * state.islandQ : 2 * getSampleRate();
}

const fileStem = path => String(path).split(/[\\/]/).pop()
    .replace(/#len=\d+$/, '').replace(/\.[^.]+$/, '');

export function importAudio(uuid, path, originSamples) {
    if (takeLive()) return false;
    const target = nodeOrRoot(uuid);
    if (!target) return false;
    if (target.type === 'clip') {
        const midi = target.contentKind === 'midi' ||
            ((target.effects && target.effects.chain) || []).some(s => s.isInstrument);
        if (midi) return false;
        if (takeLength(target) > 0 && takesOf(target).length >= MAX_TAKES) return false;
    }
    if (/\.missing$/.test(String(path || ''))) return false;

    // A stack gains a fresh clip named after the file — one undo step
    // with the take.
    let clip = target;
    if (target.type === 'stack') {
        clip = newNode('clip', { name: fileStem(path) || 'New Clip' });
        target.nodes.push(clip);
    }
    const length = decodedLength(path);
    const Q = state.islandQ;

    if (takeLength(clip) > 0) {
        // A new take of the slot: the slot's facts and re-time stand.
        const takes = takesOf(clip).slice();
        takes.push({ seed: takes.reduce((m, t) => Math.max(m, t.seed || 0), 0) + 1,
                     imported: path });
        clip.takes = takes;
        clip.activeTake = takes.length - 1;
        state.lastImport = { uuid, path, origin: originSamples, form: 'take', targetId: clip.id };
        return true;
    }

    // A first take: at the origin the view names, snapped to the Q grid;
    // before Q, at the clock, its length becoming Q. An unsnapped length
    // leaves the provisional [0, L) window.
    const snap = snapCommittedDuration(length, Q);
    const zero = state.islandZero || 0;
    const asked = Math.round(Number(originSamples) || 0);
    const origin = Q > 0 ? zero + Math.round((asked - zero) / Q) * Q : state.masterPos;
    clip.contextCycle = Q > 0 ? effectiveCycle() : 0;
    clip.duration = snap.duration;
    setStoredMap(clip, Q > 0 && snap.loopEnd < snap.duration ? [[0, snap.loopEnd]] : []);
    clip.origin = origin;
    clip.contentKind = 'audio';
    clip.takes = [{ seed: 1, imported: path }];
    clip.activeTake = 0;
    if (!(Q > 0)) establishIsland(snap.duration, origin);
    settleAnchors();
    state.lastImport = { uuid, path, origin: originSamples, form: 'first', targetId: clip.id };
    return true;
}

export function importAudioWithDialog(uuid, originSamples) {
    return importAudio(uuid, DIALOG_PATH, originSamples);
}

/** The last accepted import ({ uuid, path, origin, form, targetId }). */
export function getLastImport() {
    return state.lastImport || null;
}

export function resetLastImport() {
    state.lastImport = null;
}
