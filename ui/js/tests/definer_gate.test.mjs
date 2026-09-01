/* THE DEFINER PASSES EVERY GATE (audit 2026-08-31 U4).
 *
 * A definer stack must be ONE TAKE LOOPING AS ONE PART. A one-shot
 * member (periodSource === 'context') breaks that: the engine's
 * definerStack refuses it, and — because a published definerId can
 * outlive the state that earned it by a poll — the VM re-checks its
 * own gates (oneTakeDuration > 0) before opening the trim view.
 * Pre-fix, the published id was trusted verbatim and the trim view
 * framed the commensurate LCM instead of the raw take: brackets and
 * selection in the wrong coordinate system. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveViewModel } from '../view_model.js';

const mkState = ({ oneShotMember }) => ({
    quantum: 100, islandEpoch: 0, masterPos: 0, isPlaying: false,
    definerId: 'g',
    nodes: [{
        id: 'g', type: 'stack', loopStart: 0, loopEnd: 130,
        windowActive: true,
        nodes: [
            { id: 'a', type: 'clip', duration: 250, origin: 0,
              loopStart: 0, loopEnd: 250 },
            { id: 'b', type: 'clip', duration: 250, origin: 0,
              loopStart: 0, loopEnd: 250,
              ...(oneShotMember ? { periodSource: 'context' } : {}) },
        ],
    }],
});

test('a published definer stack with a one-shot member is refused', () => {
    const vm = deriveViewModel(mkState({ oneShotMember: true }));
    // The VM cannot compute this trim view's geometry (oneTakeDuration
    // bails on the one-shot) — no trim view, not a wrong-framed one.
    assert.equal(vm.provisionalDefiner, false,
        'trim view must NOT engage past the VM gates');
    const lane = vm.lanes.find(l => l.id === 'g');
    assert.ok(!lane || !lane.isQDefiner, 'no definer lane');
});

test('the same stack without the one-shot IS the definer (control)', () => {
    const vm = deriveViewModel(mkState({ oneShotMember: false }));
    assert.equal(vm.provisionalDefiner, true, 'trim view engaged');
    const lane = vm.lanes.find(l => l.id === 'g');
    assert.ok(lane && lane.isQDefiner, 'definer lane rendered');
    assert.equal(lane.intrinsicQ, 2.5,
        'trim view frames the raw take extent (250 samples = 2.5Q)');
});
