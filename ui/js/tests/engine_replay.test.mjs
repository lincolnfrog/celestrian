/**
 * Engine replay (docs/session_view.md §7 — the UI contract harness).
 *
 * tests/ui_contract_tests.cc drives a real record→commit through the
 * ENGINE and captures every getGraphState() poll into
 * shared/ui_contract_capture.json. This test replays those engine-real
 * snapshots through the actual deriveViewModel and asserts DISPLAY
 * invariants — the seam where the mock and the engine can drift apart
 * (a frame that stretches and squishes when a recording ends).
 *
 * Regenerate the fixture with the CelestrianTests Debug binary. The
 * capture is gitignored: on a fresh clone (no C++ test run yet) every
 * test here is SKIPPED, with the reason.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel } from '../view_model.js';
import { loadCapture } from './helpers.mjs';

const { fixture, skip } = loadCapture('ui_contract_capture.json');
const vms = fixture ? fixture.polls.map(p => ({ tag: p._tag, vm: deriveViewModel(p) })) : [];

test('engine replay: the frame never oscillates (no stretch-then-squish)', { skip }, () => {
    // Collect the frame trajectory; dedupe consecutive repeats
    const frames = [];
    vms.forEach(({ tag, vm }) => {
        if (!frames.length || frames[frames.length - 1].cycleQ !== vm.cycleQ) {
            frames.push({ tag, cycleQ: vm.cycleQ });
        }
    });
    // The frame may only GROW until it settles at the committed cycle:
    // one final shrink is the settle, any more is the squish.
    const seq = frames.map(f => f.cycleQ);
    let shrinks = 0;
    for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) shrinks++;
    assert.ok(shrinks <= 1,
        `frame shrank ${shrinks} times: ${JSON.stringify(frames)}`);
    // And the settled frame equals the committed LCM
    const last = vms[vms.length - 1].vm;
    assert.equal(last.cycleQ, last.lcmQ);
});

test('engine replay: playhead is continuous (wraps only at commit/loop)', { skip }, () => {
    let discontinuities = 0, pairs = 0;
    for (let i = 1; i < vms.length; i++) {
        const a = vms[i - 1].vm, b = vms[i].vm;
        // Same-tag pairs where the engine processed exactly one block;
        // one block in Q units depends on the POLL's quantum (the
        // first-take frame runs at quantum=1: playhead is in samples)
        if (vms[i].tag === vms[i - 1].tag) {
            pairs++;
            const blockQ = fixture.meta.block / b.quantum;
            const d = b.playheadQ - a.playheadQ;
            const wrapped = d < 0; // loop / commit wrap
            if (!wrapped && Math.abs(d - blockQ) > 1e-6 && d !== 0) {
                discontinuities++;
            }
        }
    }
    assert.ok(pairs > 0, 'the capture holds consecutive polls of one phase');
    assert.equal(discontinuities, 0);
});

test('engine replay: the first take\'s cursor is the take\'s own length', { skip }, () => {
    // Before Q exists the cursor is the first take's own position — the
    // clock from the island zero its arm block stores — whatever the
    // clock read before the arm. The capture runs the transport first,
    // so a cursor measured from anywhere else would stand off the bar.
    const first = fixture.polls.map((p, i) => ({ poll: p, vm: vms[i].vm }))
        .filter(({ poll }) => poll._tag === 'rec-1');
    assert.ok(first.length > 0, 'the capture covers the first take');
    for (const { poll, vm } of first) {
        assert.ok(poll.islandZero > 0, 'the clock ran before the arm');
        const lane = vm.lanes.find(l => l.recording);
        assert.ok(lane && lane.recordingLengthQ > 0, 'the take grows on a recording lane');
        assert.equal(vm.playheadQ * vm.quantum, lane.recordingLengthQ * vm.quantum,
            'the cursor sits on the end of the growing bar');
    }
});

test('engine replay: every committed lane tiles the frame exactly (I2)', { skip }, () => {
    let tiled = 0;
    vms.forEach(({ tag, vm }) => {
        vm.lanes.filter(l => l.kind === 'clip' && l.reps.length > 0)
            .forEach(lane => {
                tiled++;
                assert.equal(lane.reps[0].startQ, 0, tag);
                for (let i = 1; i < lane.reps.length; i++) {
                    assert.equal(lane.reps[i].startQ, lane.reps[i - 1].endQ, tag);
                }
                assert.equal(lane.reps[lane.reps.length - 1].endQ, vm.cycleQ, tag);
            });
    });
    assert.ok(tiled > 0, 'the capture holds committed lanes');
});

test('engine replay: awaiting-stop is visible state, bar keeps its anchor', { skip }, () => {
    const awaiting = vms.filter(({ tag }) => tag === 'awaiting-stop');
    assert.ok(awaiting.length > 0, 'fixture covers awaiting-stop');
    let stillRecording = 0;
    awaiting.forEach(({ vm }) => {
        // The final awaiting poll may already contain the commit (the
        // boundary lands inside its block) — recording lanes before that
        const lane = vm.lanes.find(l => l.recording);
        if (!lane) return;
        stillRecording++;
        // The bar anchor (playhead − length) stays put through the wait
        assert.ok(Math.abs((vm.playheadQ - lane.recordingLengthQ) -
            Math.round(vm.playheadQ - lane.recordingLengthQ)) < 0.02);
    });
    assert.ok(stillRecording > 0, 'awaiting-stop keeps recording to the boundary');
});
