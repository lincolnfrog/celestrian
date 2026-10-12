/* THE GESTURE LATCHES ARE COUNTED, THE RUNNER IS A SINGLETON: an overlay
 * hold and a frame pin release with their last holder; one gesture is
 * live at a time, and a rival pointer gets an inert controller. */
import test from 'node:test';
import assert from 'node:assert';

import { fakeNode, pointerDown as ev } from './dom_stub.mjs';

// A window that keeps its listeners (the Escape test fires one).
const winListeners = new Map();
globalThis.window = {
    addEventListener(t, f) { winListeners.set(t, f); },
    removeEventListener(t) { winListeners.delete(t); },
};
globalThis.document = {
    activeElement: null,
    getElementById() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { style: {}, classList: { add() {}, remove() {}, toggle() {} } }; },
};

const { beginGesture, isOverlayFrozen, isDragging, isGestureLive,
        holdOverlay, releaseOverlay } =
    await import('../session_view/gesture.js');
const { pinFrame, unpinFrame, mapDragPinQ, noteFrame } =
    await import('../session_view/drag_pin.js');

test('HOLD is refcounted: commit A settling keeps commit B protected', () => {
    const body = {};
    holdOverlay(body);       // commit A (bridge pending)
    holdOverlay(body);       // commit B (bridge pending)
    releaseOverlay(body);    // A settles
    assert.strictEqual(isOverlayFrozen(body), true,
        'overlay must stay held while commit B is in flight');
    releaseOverlay(body);    // B settles
    assert.strictEqual(isOverlayFrozen(body), false, 'all holds released');
});

test('ONE live gesture: a second pointer gets an inert controller', () => {
    const body = {};
    const nA = fakeNode(), nB = fakeNode();
    const gA = beginGesture(ev(), { node: nA });
    assert.ok(gA.live() && isGestureLive());
    gA.freeze(body);
    const gB = beginGesture(ev(), { node: nB });  // rival pointer
    assert.strictEqual(gB.live(), false, 'second gesture is inert');
    gB.freeze(body);  // no-ops
    gB.end(true);
    assert.ok(gA.live(), 'the real gesture survives the rival');
    assert.strictEqual(isDragging(body), true, 'freeze intact');
    gA.end(false);
    assert.strictEqual(isDragging(body), false, 'freeze released with A');
    assert.strictEqual(isGestureLive(), false);
    // The singleton frees up: a NEW gesture is accepted after the end.
    const gC = beginGesture(ev(), { node: fakeNode() });
    assert.ok(gC.live(), 'runner accepts a fresh gesture');
    gC.end(false);
});

test('only the primary button starts a gesture', () => {
    for (const button of [1, 2]) {
        let prevented = false;
        const n = fakeNode();
        const ends = [];
        const g = beginGesture({ ...ev(), button, preventDefault() { prevented = true; } },
            { node: n, onEnd: c => ends.push(c) });
        assert.strictEqual(g.live(), false, 'button ' + button + ' is inert');
        assert.strictEqual(isGestureLive(), false);
        assert.strictEqual(prevented, false, 'the press keeps its default (a context menu)');
        n.fire('pointerup', { pointerId: 1 });
        assert.deepStrictEqual(ends, [], 'nothing to end');
    }
    const g = beginGesture({ ...ev(), button: 0 }, { node: fakeNode() });
    assert.ok(g.live(), 'the primary button does');
    g.end(false);
});

test('frame pin is refcounted (drag_pin)', () => {
    noteFrame(8, 8);
    pinFrame();
    pinFrame();
    unpinFrame();
    assert.strictEqual(mapDragPinQ(), 8, 'still pinned under one holder');
    unpinFrame();
    assert.strictEqual(mapDragPinQ(), null, 'released with the last holder');
});

test('Escape cancels the live gesture (commit=false)', () => {
    const ends = [];
    const g = beginGesture(ev(), { node: fakeNode(),
        onEnd: committed => ends.push(committed) });
    assert.ok(g.live());
    const onKey = winListeners.get('keydown');
    assert.ok(onKey, 'capture-phase keydown registered while live');
    onKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.deepStrictEqual(ends, [false], 'ended exactly once, uncommitted');
    assert.strictEqual(isGestureLive(), false);
});

test('beginGesture blurs a focused text input', () => {
    let blurred = false;
    globalThis.document.activeElement =
        { tagName: 'INPUT', blur() { blurred = true; } };
    const g = beginGesture(ev(), { node: fakeNode() });
    assert.ok(blurred, 'the rename box lost focus at drag start');
    g.end(false);
    globalThis.document.activeElement = null;
});

