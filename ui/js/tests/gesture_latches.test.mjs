/* THE GESTURE LATCHES ARE COUNTED, THE RUNNER IS A SINGLETON
 * (audit 2026-08-31 U1/U6/U7/U8 — regression form of the fresh-audit
 * probes that reproduced the WeakSet/global-boolean latch bugs). */
import test from 'node:test';
import assert from 'node:assert';

// Minimal DOM stubs so gesture.js/sv_util.js run under node.
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

function fakeNode() {
    const listeners = new Map();
    return {
        addEventListener(t, f) { listeners.set(t, f); },
        removeEventListener(t) { listeners.delete(t); },
        setPointerCapture() {}, hasPointerCapture() { return false; },
        fire(t, ev) { const f = listeners.get(t); if (f) f(ev || {}); },
    };
}
const ev = () => ({ preventDefault() {}, stopPropagation() {}, pointerId: 1 });

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

test('beginGesture blurs a focused text input (U8)', () => {
    let blurred = false;
    globalThis.document.activeElement =
        { tagName: 'INPUT', blur() { blurred = true; } };
    const g = beginGesture(ev(), { node: fakeNode() });
    assert.ok(blurred, 'the rename box lost focus at drag start');
    g.end(false);
    globalThis.document.activeElement = null;
});
