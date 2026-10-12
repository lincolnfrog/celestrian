/**
 * THE SEQUENCER GRID'S TWO VIEW-MODEL FACTS (vm/sequence_rows.js):
 *
 *   seqRowFacts(sequence, children, quantum)  the row a sequence derives
 *     — what the grid applies at once to its own lane when an edit is
 *     sent, and what buildSeqRow builds the committed row from;
 *   seqHealthAt(row, songQ)  the frame-health faces at a provisional
 *     song length — the grip's live ⚠ / ↯ — judged by the functions, and
 *     over the members, the committed badge is.
 *
 * So the picture an edit shows before the backend answers IS the picture
 * the answer draws. The facts are pinned through the mock (it publishes
 * a sequence as the engine does: steps, program, radio flag) for a radio
 * and for free step lengths; the warning over published states whose
 * song is resized in place.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel, seqRowFacts, seqHealthAt } from '../view_model.js';
import { callNative, getState } from '../mock_backend.js';
import { recordIsland } from './mock_scene.mjs';

/** The committed grid row of `ownerId`. */
function committedRow(ownerId) {
    const vm = deriveViewModel(getState(), { seqOpen: new Set([ownerId]) });
    return vm.lanes.find(l => l.kind === 'seq' && l.ownerId === ownerId);
}

/** A row's facts in seqRowFacts' shape. */
const factsOf = row => ({
    steps: row.steps, seed: row.seed, visits: row.visits, totalQ: row.totalQ,
    radio: row.radio, reachable: row.reachable,
    gates: row.children.map(c => c.gates),
});

/** The two faces a committed row wears. */
const facesOf = row => ({ blowup: !!(row.health && row.health.blowup),
                          drift: !!(row.health && row.health.drift) });

test('a radio: the facts an edit applies at once are the committed row\'s', async () => {
    const [a] = await recordIsland(1000, 2000);
    const Q = getState().quantum;
    const rootId = getState().id;
    // A branches to B or C by chance; C fades in; one row is gated.
    const payload = {
        steps: [
            { name: 'A', len: 2 * Q, cue: false,
              next: [{ to: 1, w: 1 }, { to: 2, w: 3 }] },
            { name: 'B', len: Q, cue: true, next: [{ to: 0, w: 1 }] },
            { name: 'C', len: 3 * Q, cue: false, next: [{ to: 0, w: 1 }],
              fadeIn: Q / 2 },
            { name: 'D', len: Q, cue: false },
        ],
        gates: { [a]: [true, false, true, true] },
        seed: 7,
    };
    const applied = seqRowFacts(payload, getState().nodes, Q);
    await callNative('setSequence', rootId, payload);
    const row = committedRow(rootId);
    assert.equal(row.radio, true, 'premise: it branches');
    assert.deepEqual(row.reachable, [true, true, true, false], 'premise: D is an orphan');
    assert.deepEqual(factsOf(row), applied);
    // A re-roll is the same song under another seed.
    const rerolled = { ...payload, seed: 0xdeadbeef };
    const next = seqRowFacts(rerolled, getState().nodes, Q);
    await callNative('setSequence', rootId, rerolled);
    assert.deepEqual(factsOf(committedRow(rootId)), next);
    assert.notDeepEqual(next.visits, applied.visits, 'premise: another run');
});

test('free step lengths: the facts applied at once are the committed row\'s', async () => {
    const [, b] = await recordIsland(1000, 2000);
    const Q = getState().quantum;
    const rootId = getState().id;
    // Lengths that are no whole number of Q, explicit successors, a cue
    // and a fade.
    const payload = {
        steps: [
            { name: '', len: 1333, cue: false, next: [{ to: 1, w: 1 }] },
            { name: 'x', len: 2667, cue: false, next: [{ to: 2, w: 1 }],
              fadeOut: 250 },
            { name: 'y', len: 1001, cue: true },
        ],
        gates: { [b]: [false, true, true] },
        seed: 0,
    };
    const applied = seqRowFacts(payload, getState().nodes, Q);
    await callNative('setSequence', rootId, payload);
    const row = committedRow(rootId);
    assert.equal(row.radio, false);
    assert.deepEqual(factsOf(row), applied);
    assert.deepEqual(applied.visits.map(v => v.startQ), [0, 1.333, 4]);
    assert.equal(applied.totalQ, 5.001);
    assert.deepEqual(applied.gates,
        [[true, true, true], [false, true, true]], 'no gate row = on everywhere');
});

test('no sequence: the empty row', () => {
    assert.deepEqual(seqRowFacts(null, [{ id: 'a' }], 1000),
        { steps: [], seed: 0, visits: [], totalQ: 0, radio: false, reachable: [],
          gates: [[]] });
});

/* ---- the live warning: published states, a song resized in place ---- */

const Q = 1000;
const loop = (id, durQ) => ({
    id, type: 'clip', name: id, origin: 0, duration: durQ * Q,
    loopStart: 0, loopEnd: 0, windowActive: false, loopBypassed: false,
    isRecording: false, isPendingStart: false, periodSource: 'own',
});
/** The grid row of a group `g` — one 2Q loop under a one-step song
 * `songQ` long — beside a 1Q loop and the `besideQ` loops. `extra`
 * overrides the group's published fields. */
function songRow(songQ, besideQ, extra = {}) {
    const g = {
        id: 'g', type: 'stack', name: 'g', origin: 0, anchored: true,
        loopStart: 0, loopEnd: 0, windowActive: false, loopBypassed: false,
        isRecording: false, periodSource: 'own', nodes: [loop('k', 2)],
        sequence: { steps: [{ name: 'a', len: songQ * Q }], gates: {}, seed: 0,
                    bypassed: false, auditionStep: -1 },
        ...extra,
    };
    const vm = deriveViewModel({
        id: 'root', quantum: Q, islandZero: 0, islandPos: 0, masterPos: 0,
        definerId: '',
        nodes: [loop('one', 1), ...besideQ.map((q, i) => loop('beside-' + i, q)), g],
    }, { seqOpen: new Set(['g']) });
    return vm.lanes.find(l => l.kind === 'seq' && l.ownerId === 'g');
}

test('a free-length step: the live warning is the badge the edit commits', () => {
    // A 4Q song over a 2Q loop, beside a 5Q loop: healthy (20Q = 4 × 5).
    const before = songRow(4, [5]);
    assert.deepEqual(facesOf(before), { blowup: false, drift: false }, 'premise');
    assert.deepEqual(seqHealthAt(before, before.totalQ), facesOf(before));
    // The step dragged to each length (⌥: whole Q, off the 2Q cycle too).
    const seen = new Set();
    for (const songQ of [5, 6, 7, 8, 9, 10, 3, 2.5]) {
        const live = seqHealthAt(before, songQ);
        const row = songRow(songQ, [5]);
        assert.equal(row.totalQ, songQ, 'premise: the edit landed');
        assert.deepEqual(live, facesOf(row), `${songQ}Q`);
        assert.deepEqual(seqHealthAt(row, row.totalQ), facesOf(row),
            `${songQ}Q, judged again at rest`);
        seen.add(JSON.stringify(live));
    }
    assert.equal(seen.size, 4, 'every combination of the two faces was met');
});

test('the live warning blames this song only when the badge would', () => {
    // Beside a 7Q and a 5Q loop the parent's frame is blown up already
    // (35Q), and no length of this song is to blame for it: a take is.
    // The grip stays quiet, as the committed row does.
    const before = songRow(4, [7, 5]);
    assert.equal(facesOf(before).blowup, false, 'premise: the song is not blamed');
    for (const songQ of [5, 10, 14]) {
        assert.deepEqual(seqHealthAt(before, songQ), facesOf(songRow(songQ, [7, 5])),
            `${songQ}Q`);
    }
});

test('a song that does not set its group\'s period changes no frame by its length', () => {
    assert.deepEqual(facesOf(songRow(7, [5])), { blowup: true, drift: true }, 'premise');
    // Bypassed: the group plays its loops, and no pass of the song.
    const off = { sequence: { steps: [{ name: 'a', len: 7 * Q }], gates: {}, seed: 0,
                              bypassed: true, auditionStep: -1 } };
    const bypassed = songRow(7, [5], off);
    assert.equal(bypassed.bypassed, true, 'premise');
    assert.deepEqual(facesOf(bypassed), { blowup: false, drift: false });
    for (const songQ of [7, 9, 11]) {
        assert.deepEqual(seqHealthAt(bypassed, songQ), { blowup: false, drift: false },
            `bypassed, ${songQ}Q`);
    }
    // A 7Q window over the song is the group's period (map ▸ sequence):
    // the blow-up is the window's, whatever the song's length; the song's
    // own passes still drift or not by its length.
    const windowed = { loopStart: 0, loopEnd: 7 * Q, windowActive: true };
    const before = songRow(8, [5], windowed);
    assert.deepEqual(facesOf(before), { blowup: true, drift: false }, 'premise');
    for (const songQ of [9, 10, 12]) {
        assert.deepEqual(seqHealthAt(before, songQ), facesOf(songRow(songQ, [5], windowed)),
            `windowed, ${songQ}Q`);
    }
});
