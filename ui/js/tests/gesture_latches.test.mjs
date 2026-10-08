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

/* THE CLAIM (owner 2026-10-01): a handle's gesture selects its track
 * when it ENDS — at the press the region panel would move the lane out
 * from under the hand. A press that was only a click claims after the
 * claim window (it may be the first click of a double-click); a new
 * press, or any explicit selection, drops a claim still waiting. */
const { selectOnly, activeSelectedId, pendingClaimId, claimSoon } =
    await import('../session_view/selection.js');
const { CLAIM_CLICK_MS, CLICK_SLOP_PX } =
    await import('../session_view/gesture.js');
const down = (x = 100, y = 50) => ({ ...ev(), clientX: x, clientY: y });

test('a drag claims its track when it ends — released or cancelled — never at the press', () => {
    selectOnly('upper');
    let n = fakeNode();
    beginGesture(down(), { node: n, claim: 'lower' });
    assert.strictEqual(activeSelectedId(), 'upper', 'the press claims nothing');
    n.fire('pointermove', { clientX: 100 + CLICK_SLOP_PX + 30, clientY: 50 });
    assert.strictEqual(activeSelectedId(), 'upper', 'nor does the drag');
    n.fire('pointerup', { pointerId: 1 });
    assert.strictEqual(activeSelectedId(), 'lower', 'the release claims');
    assert.strictEqual(pendingClaimId(), null);
    // A cancel (Escape, a lost capture) claims too: the track was touched.
    selectOnly('upper');
    n = fakeNode();
    const g = beginGesture(down(), { node: n, claim: 'lower' });
    n.fire('pointermove', { clientX: 60, clientY: 50 });
    g.end(false);
    assert.strictEqual(activeSelectedId(), 'lower', 'a cancel claims');
    // The claim comes AFTER onEnd — the gesture's own commit reads the
    // selection it began under.
    selectOnly('upper');
    n = fakeNode();
    let seen = null;
    beginGesture(down(), { node: n, claim: 'lower',
        onEnd: () => { seen = activeSelectedId(); } });
    n.fire('pointermove', { clientX: 160, clientY: 50 });
    n.fire('pointerup', { pointerId: 1 });
    assert.strictEqual(seen, 'upper');
    assert.strictEqual(activeSelectedId(), 'lower');
});

test('a click\'s claim waits out the double-click; a long press claims at once', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    selectOnly('upper');
    let n = fakeNode();
    beginGesture(down(), { node: n, claim: 'lower' });
    n.fire('pointermove', { clientX: 100 + CLICK_SLOP_PX, clientY: 50 });  // inside the slop
    n.fire('pointerup', { pointerId: 1 });
    assert.strictEqual(activeSelectedId(), 'upper', 'not yet: it may be a double-click');
    assert.strictEqual(pendingClaimId(), 'lower');
    t.mock.timers.tick(CLAIM_CLICK_MS - 1);
    assert.strictEqual(activeSelectedId(), 'upper');
    t.mock.timers.tick(1);
    assert.strictEqual(activeSelectedId(), 'lower', 'claimed after the window');
    assert.strictEqual(pendingClaimId(), null);

    // A press HELD past the window is no click, travel or not.
    selectOnly('upper');
    const realNow = performance.now.bind(performance);
    let clock = realNow();
    performance.now = () => clock;
    try {
        n = fakeNode();
        beginGesture(down(), { node: n, claim: 'lower' });
        clock += CLAIM_CLICK_MS + 1;
        n.fire('pointerup', { pointerId: 1 });
    } finally {
        performance.now = realNow;
    }
    assert.strictEqual(activeSelectedId(), 'lower', 'at once');
    assert.strictEqual(pendingClaimId(), null);
});

test('a new press, or an explicit selection, drops a claim still waiting', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // The second click of a double-click: the first click's claim must
    // not land under it.
    selectOnly('upper');
    let n = fakeNode();
    beginGesture(down(), { node: n, claim: 'lower' });
    n.fire('pointerup', { pointerId: 1 });
    assert.strictEqual(pendingClaimId(), 'lower');
    n = fakeNode();
    const g = beginGesture(down(), { node: n, claim: 'lower' });
    assert.strictEqual(pendingClaimId(), null, 'dropped at the press');
    t.mock.timers.tick(CLAIM_CLICK_MS * 2);
    assert.strictEqual(activeSelectedId(), 'upper', 'nothing lands under the hand');
    n.fire('pointerup', { pointerId: 1 });        // its own end decides
    assert.strictEqual(pendingClaimId(), 'lower');
    // The double-click's handler claims at once (selectOnly) …
    selectOnly('lower');
    assert.strictEqual(pendingClaimId(), null);
    t.mock.timers.tick(CLAIM_CLICK_MS * 2);
    assert.strictEqual(activeSelectedId(), 'lower');
    void g;
    // … and the user's own selection wins over a waiting claim.
    claimSoon('lower-2', CLAIM_CLICK_MS);
    selectOnly('upper');
    t.mock.timers.tick(CLAIM_CLICK_MS * 2);
    assert.strictEqual(activeSelectedId(), 'upper', 'the explicit selection stands');
    // A claim of the sole selection is nothing to wait for.
    claimSoon('upper', CLAIM_CLICK_MS);
    assert.strictEqual(pendingClaimId(), null);
});
