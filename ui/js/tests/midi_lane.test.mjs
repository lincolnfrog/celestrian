/**
 * MIDI lane rendering (docs/vst3.md §11) — the pure functions between
 * the bridge's getMidiNotes rows and the tile: event pairing (the
 * mock's twin of AudioEngine::getMidiNotes), the row decode, the
 * compact pitch-range fit, and the slice into ONE rep tile under the
 * audio tile's srcSegs / rotation rules. Plus the mock's readout on
 * the midi-clip scenario.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { pairMidiEvents, notesFromRows, fitPitchRange, sliceNotesToTile,
         MIN_PITCH_SPAN, rescaleNotes } from '../midi_notes.js';
import { callNative, loadScenario, getState } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { MOCK_Q } from './helpers.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('pairMidiEvents: on/off pairs, velocity-0 off, an open note runs to the end', () => {
    const notes = pairMidiEvents([
        [0, 0x90, 60, 100], [100, 0x80, 60, 0],
        [50, 0x90, 64, 90], [150, 0x90, 64, 0],     // note-on vel 0 = off
        [200, 0x91, 67, 80],                        // channel 1, never closed
        [500, 0x90, 72, 70],                        // outside [0, 400) → ignored
        [-1, 0x90, 48, 70],
    ], 400);
    assert.deepEqual(notes, [
        { pos: 0, len: 100, note: 60, vel: 100 },
        { pos: 50, len: 100, note: 64, vel: 90 },
        { pos: 200, len: 200, note: 67, vel: 80 },
    ]);
});

test('pairMidiEvents: a note-off matches the most recent open note of its pitch', () => {
    const notes = pairMidiEvents([
        [0, 0x90, 60, 100], [10, 0x90, 60, 50], [20, 0x80, 60, 0], [30, 0x80, 60, 0],
    ], 100);
    assert.deepEqual(notes, [
        { pos: 0, len: 30, note: 60, vel: 100 },
        { pos: 10, len: 10, note: 60, vel: 50 },
    ]);
    assert.deepEqual(pairMidiEvents([[0, 0x80, 60, 0]], 100), []);  // a stray off
});

test('notesFromRows decodes QTime rows to Q units', () => {
    assert.deepEqual(notesFromRows([[1, 2, 60, 100, 3, 4], [2, 1, 64, 90, 1, 0]]), [
        { posQ: 0.5, note: 60, vel: 100, lenQ: 0.75 },
        { posQ: 2, note: 64, vel: 90, lenQ: 1 },
    ]);
    assert.deepEqual(notesFromRows(null), []);
});

test('fitPitchRange: padded, at least MIN_PITCH_SPAN, clamped to MIDI pitch', () => {
    assert.deepEqual(fitPitchRange([]), { lo: 54, hi: 66 });
    const one = fitPitchRange([{ note: 60 }]);
    assert.equal(one.hi - one.lo, MIN_PITCH_SPAN);
    assert.ok(one.lo < 60 && one.hi > 60);
    const wide = fitPitchRange([{ note: 40 }, { note: 80 }]);
    assert.deepEqual(wide, { lo: 39, hi: 81 });
    const low = fitPitchRange([{ note: 0 }]);
    assert.equal(low.lo, 0);
    assert.equal(low.hi - low.lo, MIN_PITCH_SPAN);
    const high = fitPitchRange([{ note: 127 }]);
    assert.equal(high.hi, 127);
    assert.equal(high.hi - high.lo, MIN_PITCH_SPAN);
});

test('sliceNotesToTile: the whole take maps to [0, 1)', () => {
    const notes = [{ posQ: 0, lenQ: 1, note: 60, vel: 100 },
                   { posQ: 3, lenQ: 1, note: 64, vel: 90 }];
    const out = sliceNotesToTile(notes, 4, null);
    assert.equal(out.length, 2);
    near(out[0].f0, 0); near(out[0].f1, 0.25);
    near(out[1].f0, 0.75); near(out[1].f1, 1);
    assert.equal(out[0].note, 60);
    assert.equal(out[1].vel, 90);
    assert.deepEqual(sliceNotesToTile(notes, 0, null), []);
    assert.deepEqual(sliceNotesToTile([], 4, null), []);
});

test('sliceNotesToTile: a window cuts a crossing note and concatenates ranges', () => {
    const notes = [{ posQ: 0.5, lenQ: 1, note: 60, vel: 100 },   // crosses the cut at 1Q
                   { posQ: 2, lenQ: 0.5, note: 64, vel: 90 }];    // outside both ranges
    // Two ranges, each 1Q of a 4Q take: [0,1Q) and [3Q,4Q).
    const out = sliceNotesToTile(notes, 4, [[0, 0.25], [0.75, 1]]);
    assert.equal(out.length, 1);
    near(out[0].f0, 0.25); near(out[0].f1, 0.5);   // 0.5Q..1Q of a 2Q tile
});

test('sliceNotesToTile: rotation moves the heard top and splits a straddling bar', () => {
    const notes = [{ posQ: 3.5, lenQ: 1, note: 60, vel: 100 }];  // 3.5Q..4.5Q?? clipped to 4Q
    const out = sliceNotesToTile(notes, 4, null, 0.25);
    // 3.5..4 of 4 = [0.875, 1) rotated by 0.25 → [1.125, 1.25) → wraps to [0.125, 0.25)
    assert.equal(out.length, 1);
    near(out[0].f0, 0.125); near(out[0].f1, 0.25);
    const straddle = sliceNotesToTile([{ posQ: 2.5, lenQ: 1, note: 60, vel: 1 }], 4, null, 0.5);
    // [0.625, 0.875) + 0.5 → [1.125, 1.375) wraps whole → [0.125, 0.375)
    assert.equal(straddle.length, 1);
    near(straddle[0].f0, 0.125); near(straddle[0].f1, 0.375);
    const split = sliceNotesToTile([{ posQ: 1.5, lenQ: 1, note: 60, vel: 1 }], 4, null, 0.5);
    // [0.375, 0.625) + 0.5 → [0.875, 1.125) → two bars
    assert.equal(split.length, 2);
    near(split[0].f0, 0.875); near(split[0].f1, 1);
    near(split[1].f0, 0); near(split[1].f1, 0.125);
});

test('the mock readout: the midi-clip scenario answers four paired notes as QTime rows', async () => {
    loadScenario('midi-clip');
    const rows = await callNative('getMidiNotes', 'midi-1');
    const notes = notesFromRows(rows);
    assert.deepEqual(notes.map(n => n.note), [60, 64, 67, 72]);
    near(notes[0].posQ, 0); near(notes[0].lenQ, 0.25);
    near(notes[2].posQ, 0.5); near(notes[2].lenQ, 0.75);
    near(notes[3].posQ, 1.5); near(notes[3].lenQ, 0.5);   // open → runs to 2Q
    assert.deepEqual(rows[0].slice(0, 2), [0, 1]);
    assert.deepEqual(await callNative('getMidiNotes', 'seed'), [], 'audio clip → none');
    assert.equal(MOCK_Q > 0, true);
});

test('rescaleNotes: a Q change re-expresses the same samples in the new Q', () => {
    const notes = [{ posQ: 0.5, lenQ: 0.25, note: 60, vel: 100 }];
    // Q halves (the tempo-setting take trimmed to half): 0.5Q → 1Q
    const out = rescaleNotes(notes, 2000, 1000);
    near(out[0].posQ, 1); near(out[0].lenQ, 0.5);
    assert.equal(out[0].note, 60);
    near(notes[0].posQ, 0.5);   // input untouched
    assert.equal(rescaleNotes(notes, 1000, 1000), notes, 'same Q → same array');
    assert.equal(rescaleNotes(notes, 0, 1000), notes, 'unknown Q → as-is');
});

test('a windowed MIDI lane slices its notes on the RAW take (contentQ), not the heard period', async () => {
    // Keys is 2Q; window [1Q, 2Q) — the heard lane's intrinsicQ is the
    // 1Q period, but the reps' srcSegs are fractions of the 2Q take.
    loadScenario('midi-clip');
    await callNative('setLoopPoints', 'midi-1', MOCK_Q, 2 * MOCK_Q);
    const lane = deriveViewModel(getState()).lanes.find(l => l.id === 'midi-1');
    near(lane.intrinsicQ, 1);
    near(lane.contentQ, 2);
    const notes = notesFromRows(await callNative('getMidiNotes', 'midi-1'));
    const out = sliceNotesToTile(notes, lane.contentQ, lane.reps[0].srcSegs);
    // The held G (0.5Q..1.25Q) sounds for the window's first 0.25Q; the
    // open C5 (1.5Q..2Q) fills its second half. C4 and E4 are cut away.
    assert.deepEqual(out.map(n => n.note), [67, 72]);
    near(out[0].f0, 0); near(out[0].f1, 0.25);
    near(out[1].f0, 0.5); near(out[1].f1, 1);
});

test('sliceNotesToTile: `onset` marks the piece a note starts in (one velocity stem per note)', () => {
    const notes = [{ posQ: 0.5, lenQ: 1, note: 60, vel: 100 }];   // crosses the cut at 1Q
    // [0,1Q) then [3Q,4Q) of a 4Q take — the note starts inside
    const inside = sliceNotesToTile(notes, 4, [[0, 0.25], [0.75, 1]]);
    assert.equal(inside[0].onset, true);
    // A window starting at 1Q cuts its head away: no onset in the tile
    const clipped = sliceNotesToTile(notes, 4, [[0.25, 0.5]]);
    assert.equal(clipped.length, 1);
    assert.equal(clipped[0].onset, false);
    // A bar split by rotation: only the first piece carries the onset
    const split = sliceNotesToTile([{ posQ: 1.5, lenQ: 1, note: 60, vel: 1 }], 4, null, 0.5);
    assert.deepEqual(split.map(n => n.onset), [true, false]);
});
