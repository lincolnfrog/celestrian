/**
 * THE AUDIBLE LOOP ON THE FRAME (session_view/loop_runs.js) and its two
 * sweepers: the playhead animator and the ruler seek.
 *
 * The loop is one span of the frame, except in the trim view of a
 * definer whose selection has cuts (vm.loopRunsQ): the transport walks
 * the runs and never the cuts between them. Pinned here: the two pure
 * mappings (frame Q ↔ Q into the loop), the animator drawing a heard
 * position in the SECOND run where it sounds, and a ruler press there
 * seeking to it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { near } from './helpers.mjs';

const frames = [];
globalThis.requestAnimationFrame = cb => frames.push(cb);
globalThis.cancelAnimationFrame = () => {};
globalThis.document = { querySelectorAll: () => [] };
// The animator's clock, owned by the test: each reading is 10 µs after
// the last. Two polls in a row are then an instant apart on any machine
// — a jump between them reads as the teleport it is, never as a pace
// (playhead_clock.estimateVelocity judges by the time between polls).
let clockMs = 0;
Object.defineProperty(globalThis, 'performance', {
    configurable: true, value: { now: () => (clockMs += 0.01) } });

const { ctx } = await import('../session_view/context.js');
const { loopRuns, heardAt, placeAt } = await import('../session_view/loop_runs.js');
const { animatorPoll, stopAnimator } = await import('../session_view/animator.js');
const { seekTargetFromFrac } = await import('../session_view/ruler_seek.js');
const { deriveViewModel } = await import('../view_model.js');

/* Kept [2000, 4000) + [5000, 6000) of an 8000 take: the loop is 3000
 * long and that is Q — the frame is the buffer, 8/3 Q. */
const Q = 3000;
const RUNS = [[2000 / Q, 4000 / Q], [5000 / Q, 6000 / Q]];
const definer = {
    id: 'd', type: 'clip', name: 'D', duration: 8000, origin: 0,
    loopStart: 0, loopEnd: 0, segments: [2000, 4000, 5000, 6000],
    windowActive: true, loopBypassed: false, loopTop: 2000, isRecording: false };
const trimView = phase => deriveViewModel({
    id: 'root', quantum: Q, islandZero: 2000, islandPos: phase,
    masterPos: phase, definerId: 'd', nodes: [definer],
    perf: { sampleRate: 48000 } });

test('one span: the loop is [loopStartQ, + loopCycleQ), the frame when unset', () => {
    assert.deepEqual(loopRuns({ loopStartQ: 2, loopCycleQ: 1, cycleQ: 4 }), [[2, 3]]);
    assert.deepEqual(loopRuns({ cycleQ: 4 }), [[0, 4]]);
    assert.deepEqual(loopRuns({ loopStartQ: 0.5, loopCycleQ: 1, cycleQ: 4,
                                loopRunsQ: RUNS }), RUNS, 'a cut selection: its runs');
});

test('frame Q → Q into the loop: a cut reads as the run after it, the ends clamp', () => {
    near(heardAt(RUNS, 2500 / Q), 500 / Q, 'inside the first run');
    near(heardAt(RUNS, 5500 / Q), 2500 / Q, 'inside the second: past the cut');
    near(heardAt(RUNS, 4500 / Q), 2000 / Q, 'in the cut: the seam');
    near(heardAt(RUNS, 0), 0, 'before the loop: its top');
    near(heardAt(RUNS, 7000 / Q), 1, 'after it: its end');
});

test('Q into the loop → frame Q: a seam is the next run\'s start, the end runs on', () => {
    near(placeAt(RUNS, 500 / Q), 2500 / Q, 'first run');
    near(placeAt(RUNS, 2500 / Q), 5500 / Q, 'second run');
    near(placeAt(RUNS, 2000 / Q), 5000 / Q, 'on the seam');
    near(placeAt(RUNS, 1), 6000 / Q, 'the loop\'s end is the last run\'s');
    for (const q of [2100, 3999, 5000, 5750]) {
        near(placeAt(RUNS, heardAt(RUNS, q / Q)), q / Q, 'a round trip at ' + q);
    }
});

/** One poll fed to the animator, then one animation frame drawn. */
function drawnAfterPoll(vm, t) {
    animatorPoll(vm, { sampleRate: 48000 });
    frames.pop()(t);
    return ctx.els.playhead._left;
}

test('the animator draws a position in the second run where the view model put it', () => {
    const W = 800;
    ctx.els = { ruler: { clientWidth: W, offsetWidth: W }, playhead: { style: {} } };
    stopAnimator();
    const vm = trimView(2500);  // 500 into the second run
    assert.deepEqual(vm.loopRunsQ, RUNS, 'the view model publishes the runs');
    near(vm.playheadQ, 5500 / Q, 'the view model\'s cursor');
    near(drawnAfterPoll(vm, performance.now()), 5500 / 8000 * W,
        'the animated playhead sits on it — not folded back into the first run');
    stopAnimator();
});

test('the animator follows the transport across the cut', () => {
    const W = 800;
    ctx.els = { ruler: { clientWidth: W, offsetWidth: W }, playhead: { style: {} } };
    stopAnimator();
    // 100 samples before the seam, then 100 after it.
    const t0 = performance.now();
    near(drawnAfterPoll(trimView(1900), t0), 3900 / 8000 * W, 'before the seam');
    near(drawnAfterPoll(trimView(2100), t0), 5100 / 8000 * W,
        'after it: in the second run, the cut skipped');
    stopAnimator();
});

test('a ruler press in the second run seeks to it; one in the cut, to the seam', () => {
    const vm = trimView(0);
    const at = sample => seekTargetFromFrac(sample / 8000, vm);
    near(at(5500).samples, 2500, '500 into the second run');
    near(at(5500).displayQ, 5500 / Q, 'shown under the pointer');
    near(at(4500).samples, 2000, 'in the cut: the seam');
    near(at(4500).displayQ, 5000 / Q, 'shown at the second run\'s start');
    near(at(1000).samples, 0, 'before the selection: its top');
    near(at(7000).samples, 3000, 'after it: its end');
    near(at(7000).displayQ, 2000 / Q, 'the loop\'s end shows as its top');
});
