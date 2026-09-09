/**
 * DISPLAY CONTRACT REPLAY — "the grid you see is the grid you hear"
 * (owner ruling 2026-09-09; the field bug: a root song sounded the full
 * band over the guitar-only section while the lanes showed otherwise).
 *
 * tests/display_contract_tests.cc drives the REAL engine, measures per
 * Q cell which gated clips actually sound (by soloing and listening —
 * the audible truth, in the epoch frame the ruler draws), and dumps
 * that with the published state into shared/display_contract_capture.json.
 * This test replays the state through the actual deriveViewModel and
 * asserts every lane is DIMMED exactly where the engine is silent —
 * the seam no mock test can see (the mock has no audio).
 *
 * Regenerate the fixture with the CelestrianTests Debug binary. The
 * capture is gitignored: on a fresh clone this file SKIPS with a note.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { deriveViewModel } from '../view_model.js';
import { loadSharedJson, repoRoot } from './helpers.mjs';

const capturePath = path.join(repoRoot, 'shared', 'display_contract_capture.json');
if (!existsSync(capturePath)) {
    console.log('display contract: SKIPPED — shared/display_contract_capture.json '
        + 'not found (run the CelestrianTests Debug binary to capture it)');
    process.exit(0);
}
const fixture = loadSharedJson('display_contract_capture.json');

const posMod = (x, p) => ((x % p) + p) % p;

/** Whether the lane's sequence dims cover lane-frame position `q`. */
function dimmedAt(lane, q) {
    return (lane.seqDims || []).some(layer => {
        const r = posMod(q - (layer.phaseQ || 0), layer.periodQ);
        return layer.offSegsQ.some(([s, e]) => r >= s && r < e);
    });
}

test('display contract: every lane is dimmed exactly where the engine is silent', () => {
    const vm = deriveViewModel(fixture.state,
        { seqOpen: new Set([fixture.groupId]) });
    assert.equal(vm.cycleQ, fixture.cycleQ, 'the frame is the island cycle');
    for (const [id, truth] of Object.entries(fixture.truth)) {
        const lane = vm.lanes.find(l => l.id === id);
        assert.ok(lane, `lane ${id} is displayed`);
        truth.forEach((on, cell) => {
            assert.equal(dimmedAt(lane, cell + 0.5), !on,
                `${lane.name || id} cell ${cell}: engine ${on ? 'sounds' : 'silent'}`);
        });
    }
});

test('display contract: the group grid\'s playing column folds from the group origin', () => {
    const vm = deriveViewModel(fixture.state,
        { seqOpen: new Set([fixture.groupId]) });
    const grid = vm.lanes.find(l => l.kind === 'seq' && l.ownerId === fixture.groupId);
    assert.ok(grid, 'the group grid row');
    assert.equal(grid.phaseQ, fixture.groupPhaseQ,
        'the grid carries the group\'s origin phase (seq_grid folds the playhead from it)');
});
