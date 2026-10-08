/**
 * BRACKETS ON A TAKE TILE THAT WRAPS THE FRAME (session_view/
 * window_edit.js bracketQ / contentQNear; loop_selection.md §14).
 *
 * A raw-framed lane — a bypassed window, a plain loop — draws its take
 * from the take tile's start (anchorQ). When the frame's end clips that
 * tile, the rest of the take is drawn from the frame's start, and the
 * window's brackets belong there with it. Placed at `anchorQ + q`
 * unwrapped, the END bracket of a bypassed window (and its chip) and a
 * plain loop's latent end sat past the lane's right edge: out of sight,
 * out of reach. The pointer's reading has to wrap the same way, or a
 * bracket on the wrapped part reads a whole frame early.
 *
 * What this pins:
 *   (a) where each bracket sits: wrapped into the frame; a region that
 *       starts exactly at the frame's end starts at the left edge, one
 *       that ends there ends at the right edge;
 *   (b) the content Q under the pointer: the representative nearest the
 *       edge being dragged — continuous on either side of the wrap.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bracketQ, contentQNear } from '../session_view/window_edit.js';

test('(a) a bracket past the frame\'s end wraps to the frame\'s start', () => {
    // A 16Q take whose tile starts 9Q into a 16Q frame; window [6, 10).
    assert.equal(bracketQ(9 + 6, 16, 'start'), 15, 'the start: on the tile');
    assert.equal(bracketQ(9 + 10, 16, 'end'), 3, 'the end: on the wrapped part');
    // The plain loop's latent pair: the whole take [0, 16) — both on
    // the take's seam, 9Q in.
    assert.equal(bracketQ(9 + 0, 16, 'start'), 9);
    assert.equal(bracketQ(9 + 16, 16, 'end'), 9);
    // A window wholly on the wrapped part: [8, 10) → 1Q … 3Q.
    assert.equal(bracketQ(9 + 8, 16, 'start'), 1);
    assert.equal(bracketQ(9 + 10, 16, 'end'), 3);
    // Nothing wraps on a tile the frame holds whole.
    assert.equal(bracketQ(2 + 1, 16, 'start'), 3);
    assert.equal(bracketQ(2 + 5, 16, 'end'), 7);
});

test('(a) exactly on the frame\'s end: a start is the left edge, an end the right', () => {
    assert.equal(bracketQ(16, 16, 'start'), 0, 'a region begins where the frame does');
    assert.equal(bracketQ(16, 16, 'end'), 16, 'a region ends where the frame does');
    assert.equal(bracketQ(0, 16, 'start'), 0);
    // fp noise at the edge reads as the edge.
    assert.ok(Math.abs(bracketQ(16 - 1e-12, 16, 'start')) < 1e-9, 'a hair under: the left edge');
    assert.ok(Math.abs(bracketQ(16 + 1e-12, 16, 'end') - 16) < 1e-9, 'a hair over: the right edge');
    // A frame shorter than the place (a pinned frame, a long take): as
    // many wraps as it takes. No frame: left alone.
    assert.equal(bracketQ(37, 16, 'end'), 5);
    assert.equal(bracketQ(37, 0, 'end'), 37);
});

test('(b) the pointer reads the content on the dragged edge\'s side of the wrap', () => {
    // The end bracket (content 10) drawn 3Q into the lane: the frame
    // position alone says 3 − 9 = −6; nearest 10 it is 10.
    assert.equal(contentQNear(3 - 9, 10, 16), 10);
    // Dragged left to 1Q of the lane: content 8; right to 5Q: 12.
    assert.equal(contentQNear(1 - 9, 10, 16), 8);
    assert.equal(contentQNear(5 - 9, 10, 16), 12);
    // The start bracket (content 6) on the tile itself: unchanged.
    assert.equal(contentQNear(15 - 9, 6, 16), 6);
    assert.equal(contentQNear(13.5 - 9, 6, 16), 4.5);
    // An unwrapped lane (anchor 2, a 4Q take in a 16Q frame) reads as
    // it always did, wherever the pointer goes near its edge.
    for (const frameQ of [0, 2, 5.5, 6, 9.9]) {
        assert.equal(contentQNear(frameQ - 2, 4, 16), frameQ - 2, `frame ${frameQ}`);
    }
});

test('(b) it follows a moving edge: each reading is nearest the last', () => {
    // The end bracket of a plain 16Q loop, content 16, drawn at the
    // seam 9Q in (frame 9 ↔ content 0 or 16). Dragged left across the
    // lane it shortens the take continuously — the readings never jump
    // a frame.
    let last = 16;
    const got = [];
    for (const frameQ of [9, 8, 6, 3, 0.5]) {
        last = contentQNear(frameQ - 9, last, 16);
        got.push(last);
    }
    assert.deepEqual(got, [16, 15, 13, 10, 7.5]);
    // …and the start bracket (content 0) dragged right from the seam.
    last = 0;
    const fwd = [];
    for (const frameQ of [9, 10, 12, 15.5]) {
        last = contentQNear(frameQ - 9, last, 16);
        fwd.push(last);
    }
    assert.deepEqual(fwd, [0, 1, 3, 6.5]);
    // No frame, or no reference: the raw reading.
    assert.equal(contentQNear(-6, 10, 0), -6);
    assert.equal(contentQNear(-6, NaN, 16), -6);
});
