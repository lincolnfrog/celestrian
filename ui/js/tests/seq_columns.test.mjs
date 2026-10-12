/**
 * The sequencer grid's columns (session_view/seq_columns.js): what a
 * column is for a periodic program and for a radio, the Q a row of them
 * stands for, and the PLAYING column — the playhead folded into the
 * program from the song's anchor. The grid you see is the grid you hear.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { columnsOf, shownQOf, playingColumn }
    from '../session_view/seq_columns.js';

/** A seq row over `lensQ` (one per step) whose program plays
 * `visitSteps` in order. */
function lane(lensQ, visitSteps = lensQ.map((_, i) => i), extra = {}) {
    let pos = 0;
    const visits = visitSteps.map(step => {
        const v = { step, startQ: pos, lenQ: lensQ[step] };
        pos += lensQ[step];
        return v;
    });
    return {
        steps: lensQ.map(lenQ => ({ lenQ })),
        visits,
        totalQ: pos,
        radio: false,
        reachable: lensQ.map((_, i) => visitSteps.includes(i)),
        phaseQ: 0,
        ...extra,
    };
}

test('periodic: the columns are the visits, in Q', () => {
    assert.deepEqual(columnsOf(lane([2, 4, 2])), {
        cols: [{ step: 0, start: 0, len: 2 }, { step: 1, start: 2, len: 4 },
               { step: 2, start: 6, len: 2 }],
        total: 8,
    });
});

test('periodic: a step played twice has two columns; an orphan has none', () => {
    // 0 → 1 → 0 → 3; step 2 is never reached.
    const { cols, total } = columnsOf(lane([2, 3, 5, 1], [0, 1, 0, 3]));
    assert.deepEqual(cols.map(c => c.step), [0, 1, 0, 3]);
    assert.deepEqual(cols.map(c => c.start), [0, 2, 5, 7]);
    assert.equal(total, 8);
});

test('a radio: one equal column per reachable step, in list order', () => {
    // The run wanders 0 1 2 1 2 0 …; step 3 is an orphan.
    const radio = lane([2, 4, 6, 8], [0, 1, 2, 1, 2, 0, 1], { radio: true });
    assert.deepEqual(columnsOf(radio), {
        cols: [{ step: 0, start: 0, len: 1 }, { step: 1, start: 1, len: 1 },
               { step: 2, start: 2, len: 1 }],
        total: 3,
    });
});

test('no program: no columns, and a total that divides', () => {
    assert.deepEqual(columnsOf(lane([])), { cols: [], total: 1 });
    assert.deepEqual(columnsOf(lane([], [], { radio: true })),
        { cols: [], total: 1 });
});

test('the Q a row shows: the song; for a radio its steps once each', () => {
    assert.equal(shownQOf(lane([2, 4, 2])), 8);
    assert.equal(shownQOf(lane([2, 3], [0, 1, 0])), 7);
    // The run is 28Q long; the three columns stand for 2 + 4 + 6.
    const radio = lane([2, 4, 6, 8], [0, 1, 2, 1, 2, 0, 1], { radio: true });
    assert.equal(radio.totalQ, 28);
    assert.equal(shownQOf(radio), 12);
});

test('the playing column: a visit owns [start, end)', () => {
    const l = lane([2, 4, 2]);
    assert.equal(playingColumn(l, 0), 0);
    assert.equal(playingColumn(l, 1.99), 0);
    assert.equal(playingColumn(l, 2), 1);
    assert.equal(playingColumn(l, 5.5), 1);
    assert.equal(playingColumn(l, 6), 2);
    assert.equal(playingColumn(l, 7.99), 2);
});

test('the playing column wraps with the song', () => {
    const l = lane([2, 4, 2]);
    assert.equal(playingColumn(l, 8), 0);
    assert.equal(playingColumn(l, 8 * 3 + 2.5), 1);
    assert.equal(playingColumn(l, -1), 2);
});

test('the playing column folds from the song\'s anchor, not the frame\'s zero', () => {
    // The song starts 3Q into the lane frame.
    const l = lane([2, 4, 2], undefined, { phaseQ: 3 });
    assert.equal(playingColumn(l, 3), 0);
    assert.equal(playingColumn(l, 5), 1);
    assert.equal(playingColumn(l, 9), 2);
    assert.equal(playingColumn(l, 0), 1);   // 5Q into the pass before
    assert.equal(playingColumn(l, 2.5), 2);
});

test('a step played twice lights the column of the visit that is playing', () => {
    const l = lane([2, 3], [0, 1, 0]);
    assert.equal(playingColumn(l, 1), 0);
    assert.equal(playingColumn(l, 6), 2);
});

test('a radio: the visit playing lights its STEP\'s column', () => {
    // Visits: 0 [0,2) 1 [2,6) 2 [6,12) 1 [12,16) 2 [16,22) 0 [22,24) 1 [24,28).
    const radio = lane([2, 4, 6, 8], [0, 1, 2, 1, 2, 0, 1], { radio: true });
    assert.equal(playingColumn(radio, 1), 0);
    assert.equal(playingColumn(radio, 3), 1);
    assert.equal(playingColumn(radio, 13), 1);   // the second pass over step 1
    assert.equal(playingColumn(radio, 17), 2);
    assert.equal(playingColumn(radio, 23), 0);
});

test('no program, or no length: nothing plays', () => {
    assert.equal(playingColumn(lane([]), 4), -1);
    assert.equal(playingColumn({ steps: [], totalQ: 0 }, 4), -1);
});
