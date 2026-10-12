/**
 * THE AUDIBLE LOOP ON THE FRAME: where a heard position (Q into the
 * loop) is drawn, and back.
 *
 * The loop is one span, [vm.loopStartQ, + vm.loopCycleQ) — except in the
 * trim view of a definer whose selection has cuts. There it is the
 * selection's runs (vm.loopRunsQ, frame Q) and the cuts between them are
 * never audible time. The playhead animator, the ruler seek and the
 * definer lane's dims read the loop through here (the view model's own
 * cursor: definerPlaceQ, the same walk).
 */

/* A heard position within this of a run's end is the next run's start. */
const SEAM_EPS_Q = 1e-9;

/** The loop's runs in frame Q: the published ones, or its one span. */
export function loopRuns(vm) {
    if (vm.loopRunsQ && vm.loopRunsQ.length) return vm.loopRunsQ;
    const start = vm.loopStartQ || 0;
    const len = vm.loopCycleQ > 0 ? vm.loopCycleQ : vm.cycleQ;
    return [[start, start + len]];
}

/** The loop's length in Q: the sum of its runs. */
export const runsLength = runs => runs.reduce((n, [s, e]) => n + (e - s), 0);

/** Frame Q → Q into the loop. A place the loop never plays reads as the
 * start of the run after it; past the last run, as the loop's end. */
export function heardAt(runs, q) {
    let heard = 0;
    for (const [s, e] of runs) {
        if (q < s) return heard;
        if (q < e) return heard + (q - s);
        heard += e - s;
    }
    return heard;
}

/** Q into the loop → frame Q. A seam is the start of the run after it;
 * at or past the loop's end the last run runs on. */
export function placeAt(runs, heardQ) {
    let h = heardQ;
    for (let i = 0; i < runs.length; i++) {
        const len = runs[i][1] - runs[i][0];
        if (i === runs.length - 1 || h < len - SEAM_EPS_Q) return runs[i][0] + h;
        h -= len;
    }
    return heardQ;
}
