/**
 * THE MOVE LAWS' SMALL PARTS (session_view/map_moves.js) and the two
 * laws that are one law for a single window (session_view/window_edit.js
 * slideWindow / relandWindow): the ⌥ slide, and the re-land on whole Q
 * when ⌥ lets go. No DOM anywhere in this file — the module graph under
 * the move laws must load without one. (The laws' own gestures are
 * pinned in map_core.test.mjs.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { cutLenText, cutChipLabel, trimMoveFn, slideMoveFn, lengthMoveFn }
    from '../session_view/map_moves.js';
import { slideWindow, relandWindow } from '../session_view/window_edit.js';
import { slideSegs } from '../map_edit.js';

const st = { segs: [[6, 10]], totalQ: 12 };

test('no DOM was needed to load the move laws', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(typeof globalThis.window, 'undefined');
});

test('a cut\'s length: whole Qs bare, a fraction to two decimals and flagged', () => {
    assert.deepEqual(cutLenText(2), { text: '2', whole: true });
    assert.deepEqual(cutLenText(2.004), { text: '2', whole: true }, 'display tolerance');
    assert.deepEqual(cutLenText(1.5), { text: '1.50', whole: false });
    assert.deepEqual(cutChipLabel(3), { text: '3Q cut', incoherent: false });
    assert.deepEqual(cutChipLabel(0.75), { text: '0.75Q cut ⚠', incoherent: true });
});

test('a move\'s badge signs its distance, with a real minus', () => {
    assert.equal(slideMoveFn(st, st.segs, 8)(7, false).active.text, 'slide −1Q · 4Q');
    assert.equal(slideMoveFn(st, st.segs, 8)(9.25, true).active.text, 'slide +1.25Q · 4Q');
    assert.equal(trimMoveFn(st, st.segs, 'end', 10)(10.5, true).active.text,
        'slide +0.5Q · 4Q');
    assert.equal(lengthMoveFn(st, st.segs, 0)(9, false).active.text, 'loop 3Q (−1)');
    assert.equal(lengthMoveFn(st, st.segs, 0)(11.2, false).active.text, 'loop 5Q (+1)');
});

test('⌥ on a lane bracket slides the window by any amount, length held, inside the take', () => {
    const win = { startQ: 2, endQ: 6 };
    assert.deepEqual(slideWindow(win, 0.3, 12), { startQ: 2.3, endQ: 6.3 });
    assert.deepEqual(slideWindow(win, -5, 12), { startQ: 0, endQ: 4 }, 'clamped at the start');
    assert.deepEqual(slideWindow(win, 9, 12), { startQ: 8, endQ: 12 }, 'clamped at the end');
    // It IS the map's slide for one window.
    for (const d of [-3.7, -0.071, 0, 1.33, 6.5]) {
        const [[s, e]] = slideSegs([[2, 6]], d, 12).segs;
        assert.deepEqual(slideWindow(win, d, 12), { startQ: s, endQ: e });
    }
});

test('⌥ released: the slid window re-lands on whole Q, its whole-Q length held', () => {
    assert.deepEqual(relandWindow({ startQ: 4.9, endQ: 8.9 }, 12), { startQ: 5, endQ: 9 });
    assert.deepEqual(relandWindow({ startQ: 2.3, endQ: 6.3 }, 12), { startQ: 2, endQ: 6 });
    assert.deepEqual(relandWindow({ startQ: 8.4, endQ: 12 }, 12), { startQ: 8, endQ: 12 },
        'never past the take: the 4Q length is kept by stepping back');
    assert.deepEqual(relandWindow({ startQ: 0.2, endQ: 0.5 }, 12), { startQ: 0, endQ: 1 },
        'never under 1Q');
    // For a window grabbed on whole Qs it lands where the panel's
    // bracket does (trimMoveFn: the slide's whole-Q part).
    const move = trimMoveFn({ segs: [[2, 6]], totalQ: 12 }, [[2, 6]], 'start', 2);
    move(4.9, true);                       // ⌥: slid +2.9
    const landed = move(4.9, false).segs;  // ⌥ let go: re-landed, then trimmed
    const reland = relandWindow(slideWindow({ startQ: 2, endQ: 6 }, 2.9, 12), 12);
    assert.equal(landed[landed.length - 1][1], reland.endQ, 'the far edge: 9 both ways');
});
