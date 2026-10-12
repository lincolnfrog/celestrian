/**
 * A lane body's two display layers that belong to OTHER features than
 * the lane's own map: the SEQUENCE DIMS (docs/sequencer.md §9 — the
 * lanes are the sequencer's display) and the TRIM DIMS (Q22, the trim
 * view with company). Each is a keyed rebuild on its own layer, made
 * and removed on demand — the marker overlay never sees them.
 */

import { el } from './sv_util.js';
import { posMod } from '../math_utils.js';
import { addDim, dimComplementInto } from './dims.js';

/** The body's `cls` layer when `want` — made on demand, removed
 * otherwise — or null. */
function layerOf(body, cls, want) {
    let layer = body.querySelector(':scope > .' + cls);
    if (!want) {
        if (layer) layer.remove();
        return null;
    }
    if (!layer) {
        layer = el('div', cls);
        body.appendChild(layer);
    }
    return layer;
}

/** Has the layer's content changed? (Sets its key and empties it.) */
function rekey(layer, key) {
    if (layer._key === key) return false;
    layer._key = key;
    layer.textContent = '';
    return true;
}

/**
 * TRIM DIMS: a lane drawn under a handed-Q definer's buffer frame
 * (`lane.trimSel`, the selection in Q) dims everything outside the
 * selection — only the selection sounds with the definer this pass.
 */
export function patchTrimDims(body, lane, cycleQ) {
    const sel = lane.trimSel;
    const layer = layerOf(body, 'trim-dims', !!sel && sel.endQ > sel.startQ);
    if (!layer || !rekey(layer, JSON.stringify([sel.startQ, sel.endQ, cycleQ]))) return;
    dimComplementInto(layer, cycleQ, [[sel.startQ, sel.endQ]], 0, cycleQ,
        'win-dim trim-dim');
}

/**
 * SEQUENCE DIMS: the display projection of an enclosing sequence's
 * gates — gated-off spans dim the lane, tiled across the frame every
 * sequence pass. Every enclosing sequence that gates the lane is one
 * LAYER (sequencer.md §12.2); the lane reads as silent where ANY of
 * them silences it. Not on a raw inspector (its own time axis).
 */
export function patchSeqDims(body, lane, cycleQ) {
    const layers = Array.isArray(lane.seqDims) ? lane.seqDims
        : (lane.seqDims ? [lane.seqDims] : []);
    const layer = layerOf(body, 'seq-dims',
        layers.some(d => d.periodQ > 0) && !lane.windowEditing);
    if (!layer || !rekey(layer, JSON.stringify([layers, cycleQ]))) return;
    layers.forEach((dims, li) => {
        const P = dims.periodQ;
        if (!(P > 0)) return;
        const span = (base, s, e, cls) => {
            const d = addDim(layer, cycleQ, base + s, base + e, cls);
            if (d) d.dataset.layer = String(li);
            return d;
        };
        // The layer's song is anchored at `phaseQ` in the lane frame
        // (its owner's origin; the root's song: the seated zero, so 0 —
        // frame.md §4): tile from the first pass that touches the frame.
        for (let base = posMod(dims.phaseQ || 0, P) - P; base < cycleQ; base += P) {
            for (const [s, e] of dims.offSegsQ) span(base, s, e, 'seq-dim');
            // PER-STEP FADES (sequencer.md §15): the ramp at a run's
            // edge reads as a gradient into / out of the dim.
            for (const [s, e, kind] of dims.fadeSegsQ || []) {
                const f = span(base, s, e, 'seq-fade ' + kind);
                if (f) {
                    f.title = kind === 'in' ? 'Fades in over this span'
                                            : 'Fades out over this span';
                }
            }
            // CUED spans (sequencer.md §3): the subtree replays the SONG
            // TOP here — marked, not dimmed (it still sounds; it just
            // re-bases). The pip echoes the grid header's.
            for (const [s, e] of dims.cueSegsQ || []) {
                const c = span(base, s, e, 'seq-cue-span mono');
                if (c) {
                    c.title = 'Cued step: replays this track from the song top';
                    c.appendChild(el('span', 'seq-cue-pip',
                        { textContent: '⇤' }));
                }
            }
        }
    });
}
