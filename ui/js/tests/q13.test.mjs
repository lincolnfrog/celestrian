/**
 * Q13 provisional-Q mutability — UI-side parity (mock + view model).
 * The engine is pinned in tests/qtime_lock_tests.cc; this checks the
 * mock re-derives Q from the sole clip's window and the view model
 * surfaces the sole Q-definer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario, setMasterPos }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { commensuratePeriod } from '../timeline_model.js';
import { PERF as perf } from './helpers.mjs';

test('mock: sole committed clip window re-establishes Q', async () => {
    loadScenario('single-clip');            // one committed clip (clip-1)
    const before = getState().nodes[0].effectiveQuantum;
    assert.ok(before > 0, 'Q established by the sole clip');

    // Trim to half its length → the STORED island Q := window length
    // (published top-level as `quantum`, mirroring the root stack).
    await callNative('setLoopPoints', 'clip-1', 0, before / 2);
    assert.equal(getState().quantum, before / 2,
        'Q re-established to the window length');
});

test('view model: exposes the sole Q-definer while provisional', () => {
    loadScenario('single-clip');
    const vm1 = deriveViewModel(getState());
    assert.equal(vm1.soleQDefinerId, 'clip-1', 'sole committed clip is the definer');
    const lane = vm1.lanes.find(l => l.id === 'clip-1');
    assert.equal(lane.isQDefiner, true, 'its lane is flagged');
});

test('mock: deleting the sole clip reverts Q (derived → fallback)', async () => {
    loadScenario('single-clip');
    await callNative('deleteNode', 'clip-1');
    const vm = deriveViewModel(getState());
    assert.equal(vm.soleQDefinerId, null, 'no definer once empty');
    assert.equal(vm.qEstablished, false, 'Q reverts to unestablished');
});

// Provisional display: the definer frames its FULL buffer with the loop
// as a selection overlay — so trimming never hides the rest of the clip.
const definerClip = () => ({
    id: 'c1', type: 'clip', name: 'A', duration: 200, effectiveQuantum: 100,
    loopStart: 20, loopEnd: 120, isRecording: false,
});

test('provisional definer frames the full buffer, loop as selection', () => {
    const vm = deriveViewModel({ nodes: [definerClip()], islandEpoch: 0, masterPos: 0, perf });
    assert.equal(vm.provisionalDefiner, true, 'provisional');
    // Frame = full buffer: cycleQ = duration/quantum = 200/100.
    assert.equal(vm.cycleQ, 2, 'frame spans the whole recorded buffer');
    const lane = vm.lanes.find(l => l.id === 'c1');
    assert.equal(lane.isQDefiner, true);
    assert.equal(lane.reps.length, 1, 'one full tile (no echoes)');
    assert.equal(lane.reps[0].startQ, 0);
    assert.equal(lane.reps[0].endQ, 2, 'tile spans the full buffer');
    assert.equal(lane.window.startQ, 0.2, 'selection start (loopStart/quantum)');
    assert.equal(lane.window.endQ, 1.2, 'selection end (loopEnd/quantum)');
});

test('provisional trim view: the ONE playhead maps into the selection', () => {
    // The transport publishes ISLAND time wrapped on the trimmed loop
    // ([0, Q)); the trim view frames BUFFER time. The one playhead (I8)
    // maps island phase into the selection: selStart + islandPos —
    // it sweeps the selected loop region and never the dead air (the
    // "two cursors" field bug, 2026-07-19).
    const vm = deriveViewModel({ nodes: [definerClip()], islandEpoch: 20,
                                 masterPos: 30, perf });
    // Q = 100 (loop [20, 120)); island pos = 30 → 0.3Q; the selection
    // starts 0.2Q into the buffer frame.
    assert.equal(vm.loopStartQ, 0.2, 'loop region origin in frame Q');
    assert.ok(Math.abs(vm.playheadQ - 0.5) < 1e-9, 'cursor = selStart + islandPos');
    assert.equal(vm.armAtQ, 1.2, 'next island boundary = the selection end');
    const lane = vm.lanes.find(l => l.id === 'c1');
    assert.equal(lane.windowPhase, 0, 'no second (amber) cursor on the definer');
});

test('a 2nd committed clip LOCKS: definer collapses to normal rendering', () => {
    const c2 = { id: 'c2', type: 'clip', name: 'B', duration: 100,
                 effectiveQuantum: 100, loopStart: 0, loopEnd: 0, isRecording: false };
    const vm = deriveViewModel({ nodes: [definerClip(), c2], islandEpoch: 0, masterPos: 0, perf });
    assert.equal(vm.provisionalDefiner, false, 'locked with 2 committed clips');
    assert.equal(vm.soleQDefinerId, null, 'no sole definer');
});

test('mock: arming take 2 LOCK-COLLAPSES the trimmed definer', async () => {
    // Owner ruling 2026-07-19: the trim is a pre-lock affordance — once
    // you build on it, the trimmed region BECOMES the take (as if
    // performed exactly) and the looper is normal again. Undo restores.
    loadScenario('single-clip');
    const dur0 = getState().nodes[0].duration;
    const ls = dur0 / 4, q = dur0 / 2;
    await callNative('setLoopPoints', 'clip-1', ls, ls + q);   // sub-Q trim
    await callNative('createNode', 'clip', '');
    const id2 = getState().nodes.find(n => n.id !== 'clip-1').id;
    await callNative('startRecordingInNode', id2);

    const c1 = getState().nodes.find(n => n.id === 'clip-1');
    assert.equal(c1.duration, q, 'the window IS the take now');
    assert.equal(c1.loopStart, 0, 'window consumed');
    assert.equal(c1.loopEnd, q, '…full span');
    assert.equal(getState().quantum, q, 'Q unchanged by the collapse');

    await callNative('stopRecordingInNode', id2);
    await callNative('undo');   // snapshot restores the pre-collapse state
    const c1b = getState().nodes.find(n => n.id === 'clip-1');
    assert.equal(c1b.duration, dur0, 'undo restores the full buffer');
    assert.equal(c1b.loopStart, ls, '…and the trim');
});

test('mock: deleting take 2 re-opens AND uncollapses the definer', async () => {
    // Re-open restores the trimmed-away material (audio-neutral): the
    // old trim survives as the window, so it can be trimmed LONGER.
    loadScenario('single-clip');
    const dur0 = getState().nodes[0].duration;
    const ls = dur0 / 4, q = dur0 / 2;
    await callNative('setLoopPoints', 'clip-1', ls, ls + q);
    await callNative('createNode', 'clip', '');
    const id2 = getState().nodes.find(n => n.id !== 'clip-1').id;
    await callNative('startRecordingInNode', id2);   // lock-collapse
    assert.equal(getState().nodes.find(n => n.id === 'clip-1').duration, q);
    advanceBy(q);                                    // let the take run 1Q
    await callNative('stopRecordingInNode', id2);
    advanceBy(q);                                    // …and reach its commit
    await callNative('deleteNode', id2);             // re-open ⟹ uncollapse
    const c1 = getState().nodes.find(n => n.id === 'clip-1');
    assert.equal(c1.duration, dur0, 'full material restored');
    assert.equal(c1.loopStart, ls, 'the trim survives as the window');
    assert.equal(c1.loopEnd, ls + q, '…');
    assert.equal(getState().quantum, q, 'Q untouched by the re-open');
});

test('mock: trim is phase-preserving (sounding buffer position unchanged)', async () => {
    // Engine parity (AudioEngine::setLoopPoints re-anchor): nudging the
    // loop region must not move the position sounding right now — the
    // published masterPos maps back via loopStart + view.
    loadScenario('single-clip');
    const dur0 = getState().nodes[0].duration;
    // Real commits always leave a full-span window; the fixture doesn't —
    // establish it at t = 0 so the pre-trim state matches production.
    await callNative('setLoopPoints', 'clip-1', 0, dur0);
    setMasterPos(dur0 * 0.65);
    const mod = (a, m) => ((a % m) + m) % m;
    const s0 = getState();
    const p0 = (s0.nodes[0].loopStart || 0) + s0.masterPos;

    const ls = dur0 / 4, q = dur0 / 2;              // window [0.25d, 0.75d)
    await callNative('setLoopPoints', 'clip-1', ls, ls + q);
    const s1 = getState();
    const p1 = s1.nodes[0].loopStart + s1.masterPos;
    assert.ok(Math.abs(p1 - (ls + mod(p0 - ls, q))) < 1e-9,
        'position continuous (folded into the new window)');

    // A nudge that keeps the position inside the window: no move at all.
    // (p1 = 0.65·dur0; the shifted window [0.3125, 0.8125)·dur0 holds it.)
    await callNative('setLoopPoints', 'clip-1', ls + dur0 / 16, ls + dur0 / 16 + q);
    const s2 = getState();
    const p2 = s2.nodes[0].loopStart + s2.masterPos;
    assert.ok(Math.abs(p2 - p1) < 1e-9, 'nudge: the sounding position holds');
});

test('an ARMED 2nd take suspends the provisional trim view', () => {
    // The engine collapses at ARM and refuses re-trim while a take is
    // in flight — the VM's trim view must end at the same moment.
    const armed = { id: 'c2', type: 'clip', name: 'B', duration: 0,
                    isPendingStart: true, isRecording: false };
    const vm = deriveViewModel({ nodes: [definerClip(), armed],
                                 islandEpoch: 0, masterPos: 0, perf });
    assert.equal(vm.provisionalDefiner, false, 'suspended while armed');
});

test('locked trimmed definer: the frame stays whole-Q (no LCM explosion)', () => {
    // After a sub-Q trim the definer's BUFFER length is a multiple of
    // the OLD Q — incommensurate with the new grid. LCM-ing the raw
    // duration exploded the frame (~142336Q) the moment take 2 armed,
    // and every waveform vanished behind the maxTiles guards (field
    // 2026-07-19b). The clip's whole-Q contribution is its WINDOW.
    const definer = { id: 'c1', type: 'clip', name: 'A', duration: 190,
                      loopStart: 20, loopEnd: 60, windowActive: true,
                      isRecording: false };
    const take2 = { id: 'c2', type: 'clip', name: 'B', duration: 160,
                    loopStart: 0, loopEnd: 160, isRecording: false };
    const vm = deriveViewModel({ nodes: [definer, take2], quantum: 40,
                                 islandEpoch: 20, masterPos: 0, perf });
    assert.equal(vm.cycleQ, 4, 'frame = lcm(window 1Q, take2 4Q), not lcm(190, 160)');
    assert.ok(vm.lanes.find(l => l.id === 'c1').reps.length > 0,
        'definer lane still tiles (maxTiles guard not tripped)');
    assert.ok(vm.lanes.find(l => l.id === 'c2').reps.length > 0,
        'take-2 lane still tiles');

    // The contribution rule itself.
    assert.equal(commensuratePeriod(definer, 40), 40, 'incommensurate → window');
    assert.equal(commensuratePeriod(take2, 40), 160, 'whole-Q duration unchanged');
    assert.equal(commensuratePeriod({ duration: 190, loopBypassed: true,
        loopStart: 20, loopEnd: 60 }, 40), 200, 'bypassed fallback: ceil to Q');
});

test('a clip RECORDING (armed 2nd take) suspends the provisional view', () => {
    const rec = { id: 'c2', type: 'clip', name: 'B', duration: 0,
                  effectiveQuantum: 0, isRecording: true };
    const vm = deriveViewModel({ nodes: [definerClip(), rec], islandEpoch: 0, masterPos: 0, perf });
    // c1 is still the sole COMMITTED clip, but recording suspends the
    // full-buffer view (we're transitioning to locked).
    assert.equal(vm.soleQDefinerId, 'c1', 'c1 still the sole committed clip');
    assert.equal(vm.provisionalDefiner, false, 'suspended while recording');
});
