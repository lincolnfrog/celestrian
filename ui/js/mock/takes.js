/**
 * mock/takes.js — the take list and the comp (docs/takes.md; engine
 * AudioEngine::selectTake / deleteTake / setComp / getTakeWaveform). A
 * committed clip holds `takes` (a waveform seed each), `activeTake` and
 * the comp. The new-take arm lives with the take lifecycle
 * (recording.js).
 */

import { state, findNode, takesOf, takeLength, isLive } from './state.js';
import { takePeaks } from './waveform.js';

/** Engine ClipNode::kMaxTakes / kMaxCompCells. */
export const MAX_TAKES = 32;
const MAX_COMP_CELLS = 256;

const clipOf = id => {
    const node = findNode(id);
    return node && node.type === 'clip' ? node : null;
};

export function selectTake(id, index) {
    const clip = clipOf(id);
    if (!clip) return;
    const takes = takesOf(clip);
    const k = Number(index);
    if (!(k >= 0 && k < takes.length) || k === (clip.activeTake || 0)) return;
    clip.takes = takes.slice();
    clip.activeTake = k;
}

/** The last take of a slot stays. An active take hands activity to its
 * lower neighbour; comp cells naming the removed take fall back to the
 * active one, and a comp naming nothing any more clears. */
export function deleteTake(id, index) {
    const clip = clipOf(id);
    if (!clip) return;
    const takes = takesOf(clip).slice();
    const k = Number(index);
    if (takes.length < 2 || !(k >= 0 && k < takes.length)) return;
    const active = clip.activeTake || 0;
    takes.splice(k, 1);
    clip.takes = takes;
    if (active === k) clip.activeTake = k > 0 ? k - 1 : 0;
    else if (active > k) clip.activeTake = active - 1;
    if (Array.isArray(clip.comp) && clip.comp.length) {
        const cells = clip.comp.map(c => (c === k ? -1 : (c > k ? c - 1 : c)));
        if (cells.some(c => c >= 0)) clip.comp = cells;
        else clearComp(clip);
    }
}

function clearComp(clip) {
    clip.comp = [];
    clip.compCellLen = 0;
    clip.compOffset = 0;
}

/** One take index per Q cell of the period (−1 = the active take); []
 * clears, always. Authored on the grid as it lies: Q cells from the
 * content's zero. */
export function setComp(id, cells) {
    const clip = clipOf(id);
    if (!clip || clip.contentKind === 'midi') return;
    const Q = state.islandQ;
    const period = takeLength(clip);
    if (!(Q > 0) || !(period > 0)) return;
    const next = Array.isArray(cells) ? cells.map(Number) : [];
    const expected = Math.ceil(period / Q);
    const count = takesOf(clip).length;
    if (next.length && (next.length !== expected || expected > MAX_COMP_CELLS)) return;
    if (next.some(c => !(c >= -1 && c < count))) return;
    if (!next.length) {
        if ((clip.comp || []).length) clearComp(clip);
    } else {
        clip.comp = next;
        clip.compCellLen = Q;
        clip.compOffset = 0;
    }
}

export function getTakeWaveform(id, index, numPeaks = 100) {
    const clip = clipOf(id);
    if (!clip || isLive(clip) || !(takeLength(clip) > 0)) return [];
    return takePeaks(clip, Number(index), numPeaks);
}
