/**
 * THE FRAME-HEALTH BADGE (docs/sequencer.md §11.6) — the pure module
 * against the shared golden vectors, then the VM projection: the
 * blowup face lands on the RESPONSIBLE lane (and its grid row with the
 * offer), the drift face on the sequenced stack's row + chip, and grid
 * rows learn their parent-scope facts for the live grip readout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { assessBlowup, assessDrift, snapOffer, lcmAll, kBlowupRatio,
         cycleMinutes, fmtDuration } from '../frame_health.js';
import { deriveViewModel } from '../view_model.js';
import { advanceBy, callNative, getState } from '../mock_backend.js';
import { loadSharedJson, recordTake } from './helpers.mjs';
import { published, recordIsland } from './mock_scene.mjs';

const golden = loadSharedJson('timing_golden.json').frame_health_cases;

test('golden: blowup face (attribution + offers)', () => {
    assert.equal(kBlowupRatio, 4);
    for (const c of golden.blowup) {
        const got = assessBlowup(c.members, 1);
        if (c.expect === null) {
            assert.equal(got, null, c.name);
            continue;
        }
        assert.ok(got, c.name + ': warns');
        assert.equal(got.cycleQ, c.expect.cycleQ, c.name + ': cycle');
        assert.equal(got.responsibleId, c.expect.responsibleId, c.name + ': who');
        assert.equal(got.othersQ, c.expect.othersQ, c.name + ': others');
        assert.equal(got.offerQ, c.expect.offerQ, c.name + ': offer');
    }
});

test('golden: drift face', () => {
    for (const c of golden.drift) {
        const got = assessDrift(c.seqLenQ, c.innerQ);
        if (c.expect === null) {
            assert.equal(got, null, c.name);
            continue;
        }
        assert.ok(got, c.name);
        assert.equal(got.phaseQ, c.expect.phaseQ, c.name + ': phase');
        assert.deepEqual(got.offers, c.expect.offers, c.name + ': offers');
    }
});

test('helpers: snapOffer ties go shorter; lcmAll; minutes text', () => {
    assert.equal(snapOffer(6, 4), 4, '6 between 4 and 8: the shorter wins the tie');
    assert.equal(snapOffer(8, 4), null, 'already agrees');
    assert.equal(snapOffer(3, 0), null, 'nothing to agree with');
    assert.equal(lcmAll([4, 6], 1), 12);
    assert.equal(lcmAll([], 0), 0);
    // 132Q at Q = 44100 (1 s) = 2.2 min → "2:12"; 1500Q = 25 min.
    assert.equal(fmtDuration(cycleMinutes(132, 44100, 44100)), '2:12');
    assert.equal(fmtDuration(cycleMinutes(1500, 44100, 44100)), '25 min');
});

test('VM: the blowup lands on the responsible lane; rows learn parent facts', async () => {
    await recordIsland(1000);                                           // 1Q
    const g = await callNative('createNode', 'stack', '');
    const Q = getState().quantum;
    // A sequenced group of 7Q beside a 5Q loop → lcm 35 = 5× the
    // largest (coprime: ratio = the smaller period; > 4 warns).
    const b = await recordTake('', 5 * Q);                              // 5Q
    const k = await callNative('createNode', 'clip', g);
    await callNative('startRecordingInNode', k);
    advanceBy(2 * Q);
    await callNative('stopRecordingInNode', k);
    advanceBy(2 * Q);
    await callNative('setSequence', g, {
        steps: [{ name: 'a', len: 7 * Q }], gates: {},
    });
    let vm = deriveViewModel(getState(), { seqOpen: new Set([g]) });
    const gl = vm.lanes.find(l => l.id === g);
    assert.ok(gl.health, 'the 7Q sequenced group is responsible (it has the knob)');
    assert.equal(gl.health.cycleQ, 35);
    assert.equal(gl.health.offerQ, 5, 'snap to 5Q (the nearest agreeing length)');
    assert.equal(vm.lanes.find(l => l.id === b).health, undefined, 'the 5Q loop is not blamed');
    const row = vm.lanes.find(l => l.kind === 'seq' && l.ownerId === g);
    assert.ok(row.health && row.health.blowup, 'the grid row carries the offer');
    assert.equal(row.health.blowup.offerQ, 5);
    // The parent scope's members ride the row (the grip's live warning
    // is judged over them, seqHealthAt): itself, and the others.
    assert.equal(row.parentMembers.find(m => m.id === g).periodQ, 7);
    const others = row.parentMembers.filter(m => m.id !== g).map(m => m.periodQ);
    assert.equal(lcmAll(others, 1), 5, 'parent-scope lcm excluding self');
    assert.equal(Math.max(...others), 5);
    // The group's own DRIFT: 7Q over the kick's inner cycle (the
    // padded take length — 2Q or 3Q depending on the arm boundary).
    const kickQ = published(k).duration / Q;
    assert.ok(7 % kickQ !== 0, 'test premise: 7Q does not divide by the kick');
    assert.ok(row.health.drift, 'drifting: 7 mod kick != 0');
    assert.deepEqual(row.health.drift.offers,
        [7 - (7 % kickQ), 7 - (7 % kickQ) + kickQ]);
    assert.ok(gl.seq.drift, 'the rail chip fact');

    // Resize the group to lcm(kick, 5)·k: both faces clear.
    const goodQ = lcmAll([kickQ, 5], 1) * 2;
    await callNative('setSequence', g, {
        steps: [{ name: 'a', len: goodQ * Q }], gates: {},
    });
    vm = deriveViewModel(getState(), { seqOpen: new Set([g]) });
    assert.equal(vm.lanes.find(l => l.id === g).health, undefined, 'healthy');
    const row2 = vm.lanes.find(l => l.kind === 'seq' && l.ownerId === g);
    assert.equal(row2.health, undefined, 'no drift either');
});

test('VM: root drift shows on the transport chip fact (rootSeq.drift)', async () => {
    await recordIsland(1000, 2000);
    const Q = getState().quantum;
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'a', len: 3 * Q }], gates: {},   // 3Q over a 2Q cycle
    });
    const vm = deriveViewModel(getState(), { seqOpen: new Set([getState().id]) });
    assert.ok(vm.rootSeq.drift, 'root song drifts against its 2Q loops');
    assert.deepEqual(vm.rootSeq.drift.offers, [2, 4]);
    const row = vm.lanes.find(l => l.kind === 'seq');
    assert.ok(row.health.drift, 'the root grid row too');
    assert.equal(row.parentMembers, undefined, 'the root has no parent scope');
});
