/**
 * The sequencer grid's COLUMNS (docs/sequencer.md §14) — pure, no DOM.
 *
 * While a program is PERIODIC its columns are its visits, in Q: a step
 * the walk plays twice has two columns, and every boundary sits on the
 * time axis. A RADIO's run is the horizon long, so its grid shows the
 * GRAPH instead: one equal-width column per reachable step, in list
 * order. Either way a column index is not a step index — a column
 * names its step.
 *
 * `lane` is the view model's seq row (seq_grid.js lists what it reads).
 */

import { posMod } from '../math_utils.js';

/** The columns: [{step, start, len}] over a `total` (both in Q for a
 * periodic program, in columns for a radio). */
export function columnsOf(lane) {
    if (!lane.radio) {
        return { cols: (lane.visits || []).map(v => ({
                     step: v.step, start: v.startQ, len: v.lenQ })),
                 total: lane.totalQ > 0 ? lane.totalQ : 1 };
    }
    const cols = [];
    lane.steps.forEach((s, i) => {
        if (lane.reachable && !lane.reachable[i]) return;
        cols.push({ step: i, start: cols.length, len: 1 });
    });
    return { cols, total: Math.max(1, cols.length) };
}

/** The Q the columns stand for, side by side: the song — for a radio,
 * its reachable steps once each. A drag across the whole row moves a
 * length by this much. */
export function shownQOf(lane) {
    const { cols, total } = columnsOf(lane);
    return lane.radio
        ? cols.reduce((q, c) => q + lane.steps[c.step].lenQ, 0) : total;
}

/**
 * The column PLAYING at `playheadQ` (lane-frame Q), or −1 with no
 * program. The song is anchored at `lane.phaseQ`, so the playhead folded
 * from there names the visit the engine is gating; a radio's visit maps
 * to its step's column.
 */
export function playingColumn(lane, playheadQ) {
    const visits = lane.visits || [];
    if (!visits.length || !(lane.totalQ > 0)) return -1;
    const rel = posMod(playheadQ - (lane.phaseQ || 0), lane.totalQ);
    const visit = visits.findIndex(v => rel < v.startQ + v.lenQ);
    if (visit < 0 || !lane.radio) return visit;
    const step = visits[visit].step;
    return columnsOf(lane).cols.findIndex(c => c.step === step);
}
