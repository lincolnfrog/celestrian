/**
 * DISPLAY CONTRACT REPLAY — "the grid you see is the grid you hear": a
 * song must never sound a part over a section whose lanes show it
 * gated off.
 *
 * tests/display_contract_tests.cc drives the REAL engine, measures per
 * Q cell which gated clips actually sound (by soloing and listening —
 * the audible truth, in the island frame the ruler draws), and dumps
 * that with the published state into shared/display_contract_capture.json.
 * This test replays the state through the actual deriveViewModel and
 * asserts every lane is DIMMED exactly where the engine is silent —
 * the seam no mock test can see (the mock has no audio).
 *
 * Regenerate the fixture with the CelestrianTests Debug binary. The
 * capture is gitignored: on a fresh clone both tests are SKIPPED, with
 * the reason.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel } from '../view_model.js';
import { posMod } from '../math_utils.js';
import { loadCapture } from './helpers.mjs';

const { fixture, skip } = loadCapture('display_contract_capture.json');

/** Whether the lane's sequence dims cover lane-frame position `q`. */
function dimmedAt(lane, q) {
    return (lane.seqDims || []).some(layer => {
        const r = posMod(q - (layer.phaseQ || 0), layer.periodQ);
        return layer.offSegsQ.some(([s, e]) => r >= s && r < e);
    });
}

test('display contract: every lane is dimmed exactly where the engine is silent', { skip }, () => {
    const vm = deriveViewModel(fixture.state,
        { seqOpen: new Set([fixture.groupId]) });
    assert.equal(vm.cycleQ, fixture.cycleQ, 'the frame is the island cycle');
    const cells = Object.values(fixture.truth).flat();
    assert.ok(cells.includes(true) && cells.includes(false),
        'the capture holds cells that sound and cells that are silent');
    for (const [id, truth] of Object.entries(fixture.truth)) {
        const lane = vm.lanes.find(l => l.id === id);
        assert.ok(lane, `lane ${id} is displayed`);
        truth.forEach((on, cell) => {
            assert.equal(dimmedAt(lane, cell + 0.5), !on,
                `${lane.name || id} cell ${cell}: engine ${on ? 'sounds' : 'silent'}`);
        });
    }
});

test('display contract: the group grid\'s playing column folds from the group origin', { skip }, () => {
    const vm = deriveViewModel(fixture.state,
        { seqOpen: new Set([fixture.groupId]) });
    const grid = vm.lanes.find(l => l.kind === 'seq' && l.ownerId === fixture.groupId);
    assert.ok(grid, 'the group grid row');
    assert.ok(fixture.groupPhaseQ > 0, 'the capture seats the group off the zero');
    assert.equal(grid.phaseQ, fixture.groupPhaseQ,
        'the grid carries the group\'s origin phase (seq_grid folds the playhead from it)');
});
