/**
 * THE RELEASE OUTLIVES THE POINTER (session_view/gesture.js,
 * map_core.js runRawDrag; docs/frame.md §1).
 *
 * A map drag's final commit is still in flight when the pointer lets
 * go. Two things must wait for it to SETTLE, not for pointerup:
 *   1. the FRAME PIN — a poll answered between the release and the
 *      engine's answer carries the last LIVE geometry; seated unpinned,
 *      the frame would jump there and jump back a poll later;
 *   2. the PREVIEW — torn down at pointerup, the held overlay shows the
 *      PRE-drag chrome for a round trip (the doubled "↺ loop top", the
 *      panel box snapping back). It stays, redrawn at the landing just
 *      sent, and comes down only in the patch that rebuilds from the
 *      committed state (flushTeardowns), in the same frame.
 * What this pins, with a minimal DOM and the real gesture runner:
 * the pin's lifetime on commit, cancel, a bridge that never answers
 * and a throwing onEnd; the held preview (committed landing, .drag-held,
 * teardown only at the flush after settle); a cancel's held restore;
 * a newer gesture taking an older one's held preview; and, through the
 * real deriveViewModel, that no poll inside the window seats the frame
 * from pre-final geometry.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

/* ---------- a minimal DOM: enough for the runner and the preview ---------- */
class FakeEl {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.parent = null;
        this.style = {};
        this.cls = new Set();
        this.listeners = new Map();
        this.isConnected = true;
        const s = this.cls;
        this.classList = {
            add: (...c) => c.forEach(x => s.add(x)),
            remove: (...c) => c.forEach(x => s.delete(x)),
            contains: c => s.has(c),
            toggle: (c, f) => { const on = f ?? !s.has(c); if (on) s.add(c); else s.delete(c); return on; },
        };
    }
    get className() { return [...this.cls].join(' '); }
    set className(v) { this.cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => this.cls.add(c)); }
    set textContent(_) { this.children.forEach(c => { c.parent = null; }); this.children = []; }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter(c => c !== this);
        this.parent = null;
    }
    querySelector(sel) {
        const m = /^:scope > \.([\w-]+)$/.exec(sel);
        if (!m) throw new Error('FakeEl.querySelector: ' + sel);
        return this.children.find(c => c.cls.has(m[1])) || null;
    }
    addEventListener(t, f) { this.listeners.set(t, f); }
    removeEventListener(t) { this.listeners.delete(t); }
    setPointerCapture() {}
    hasPointerCapture() { return false; }
    releasePointerCapture() {}
    fire(t, ev = {}) { const f = this.listeners.get(t); if (f) f(ev); }
}
const winListeners = new Map();
globalThis.window = {
    addEventListener(t, f) { winListeners.set(t, f); },
    removeEventListener(t) { winListeners.delete(t); },
};
globalThis.document = {
    activeElement: null,
    getElementById() { return null; },
    querySelectorAll() { return []; },
    createElement: tag => new FakeEl(tag),
};

const { ctx } = await import('../session_view/context.js');
const { beginGesture, isOverlayFrozen, flushTeardowns, isGestureLive,
        COMMIT_HOLD_MAX_MS } = await import('../session_view/gesture.js');
const { noteFrame, mapDragPinQ, mapDragPinZero, mapDragPinFoldQ } =
    await import('../session_view/drag_pin.js');
const { runRawDrag, slideMoveFn } = await import('../session_view/map_core.js');
const { deriveViewModel } = await import('../view_model.js');

/** A promise the test settles by hand — the bridge's answer. */
function deferred() {
    let resolve;
    const p = new Promise(r => { resolve = r; });
    return { p, resolve };
}
const flushMicrotasks = () => new Promise(r => setImmediate(r));

/** The bridge: every setSegments call is recorded and answered when
 * the test says so. */
function fakeBridge() {
    const calls = [];
    ctx.cb = {
        onSetSegments: (id, flat, live) => {
            const d = deferred();
            calls.push({ flat, live, answer: d.resolve });
            return d.p;
        },
    };
    return calls;
}

const Q = 1000;
const st = () => ({ laneId: 'c', segs: [[6, 10]], totalQ: 12, anchorQ: 0,
                    editable: true, locked: false, heard: false, periodQ: 4,
                    quantum: Q, cycleQ: 12 });
const pxPerQ = 10;

/** One panel-style slide gesture: grab at 8Q, move to `toQ`. */
function slideGesture({ toQ = 9.3, engage = false } = {}) {
    const o = new FakeEl();
    const host = new FakeEl();
    const target = new FakeEl();
    const s = st();
    const log = [];
    const ev = { clientX: 8 * pxPerQ, altKey: false, target, pointerId: 1,
                 preventDefault() {}, stopPropagation() {} };
    runRawDrag(ev, o, s, {
        rawQAt: x => x / pxPerQ,
        view: () => ({ q0: 0, spanQ: 12 }),
        onMove: slideMoveFn(s, s.segs, 8),
        freeze: [host],
        engage,
        onRelease: (committed, engaged) => log.push(['release', committed, engaged]),
        onTeardown: () => log.push(['teardown']),
    });
    const move = q => target.fire('pointermove', { clientX: q * pxPerQ, altKey: false });
    if (toQ !== null) move(toQ);
    return { o, host, target, log, move,
             up: () => target.fire('pointerup', { pointerId: 1 }) };
}
const previewBrackets = o => {
    const layer = o.querySelector(':scope > .drag-preview-layer');
    return layer ? layer.children.filter(c => c.cls.has('win-bracket'))
        .map(c => c.className + '@' + c.style.left) : null;
};
const pctOf = q => (q / 12) * 100 + '%';

test('a release keeps the frame pinned until its final commit settles', async () => {
    const calls = fakeBridge();
    noteFrame(5, 5, 55 * Q);
    const g = slideGesture();
    assert.equal(mapDragPinZero(), 55 * Q, 'engaged: the zero is pinned');
    assert.equal(calls.length, 1, 'one live commit while dragging');
    g.up();
    assert.equal(calls.length, 2, 'the final commit went out at release');
    assert.deepEqual(calls[1].flat, [7 * Q, 11 * Q], 'the final commit is the last preview');
    assert.equal(isGestureLive(), false, 'the gesture itself is over');
    assert.equal(mapDragPinZero(), 55 * Q, 'released, not settled: still pinned');
    assert.equal(mapDragPinQ(), 5);
    calls[0].answer(true);  // the LIVE commit's answer changes nothing
    await flushMicrotasks();
    assert.equal(mapDragPinZero(), 55 * Q, 'a live answer does not unpin');
    calls[1].answer(true);
    await flushMicrotasks();
    assert.equal(mapDragPinZero(), null, 'settled: the frame re-seats once');
    assert.equal(mapDragPinFoldQ(), null);
    flushTeardowns();
});

test('the held preview shows the landing sent, and comes down only at the flush after settle', async () => {
    const calls = fakeBridge();
    noteFrame(5, 5, 55 * Q);
    const g = slideGesture();
    g.up();
    // HELD: the preview stays, redrawn at the committed landing — no
    // pointer follow, no badge — over hidden, press-proof stale chrome.
    assert.ok(g.o.cls.has('drag-live'), 'stale chrome still hidden');
    assert.ok(g.o.cls.has('drag-held'), 'and takes no presses');
    assert.deepEqual(previewBrackets(g.o),
        ['win-bracket start@' + pctOf(7), 'win-bracket end@' + pctOf(11)],
        'the brackets sit at the landing sent (the kept box, not the pre-drag one)');
    const layer = g.o.querySelector(':scope > .drag-preview-layer');
    assert.equal(layer.children.filter(c => c.cls.has('cut-chip')).length, 0,
        'no badge once the pointer is gone');
    assert.deepEqual(g.log, [['release', true, true]], 'released, not torn down');
    assert.ok(isOverlayFrozen(g.host), 'the host is held');
    // A patch while the commit is in flight: nothing comes down.
    flushTeardowns();
    assert.ok(g.o.querySelector(':scope > .drag-preview-layer'), 'held through a patch in flight');
    calls[1].answer(true);
    await flushMicrotasks();
    assert.equal(isOverlayFrozen(g.host), false, 'settled: the host may rebuild');
    assert.ok(g.o.querySelector(':scope > .drag-preview-layer'),
        'still up until the patch that rebuilds the host');
    flushTeardowns();  // the patch: the host rebuilt above, now this
    assert.equal(g.o.querySelector(':scope > .drag-preview-layer'), null, 'torn down');
    assert.ok(!g.o.cls.has('drag-live') && !g.o.cls.has('drag-held'));
    assert.deepEqual(g.log, [['release', true, true], ['teardown']]);
    flushTeardowns();
    assert.equal(g.log.length, 2, 'exactly once');
});

test('a cancel holds the restore — the pin and the preview wait for it too', async () => {
    const calls = fakeBridge();
    noteFrame(5, 5, 55 * Q);
    const g = slideGesture();
    const onKey = winListeners.get('keydown');
    onKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(calls[calls.length - 1].flat, [6 * Q, 10 * Q],
        'the cancel restores the map the gesture began on');
    assert.deepEqual(previewBrackets(g.o),
        ['win-bracket start@' + pctOf(6), 'win-bracket end@' + pctOf(10)],
        'the held preview shows the restore, not the cancelled drag');
    assert.equal(mapDragPinZero(), 55 * Q, 'pinned while the restore is in flight');
    calls[calls.length - 1].answer(true);
    await flushMicrotasks();
    assert.equal(mapDragPinZero(), null, 'unpinned when the restore settles');
    flushTeardowns();
    assert.deepEqual(g.log, [['release', false, true], ['teardown']]);
});

test('a bridge that never answers releases the pin and the hold at the cap', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        fakeBridge();
        noteFrame(5, 5, 55 * Q);
        const g = slideGesture();
        g.up();
        mock.timers.tick(COMMIT_HOLD_MAX_MS - 1);
        assert.equal(mapDragPinZero(), 55 * Q, 'still waiting');
        mock.timers.tick(1);
        assert.equal(mapDragPinZero(), null, 'the cap let go');
        assert.equal(isOverlayFrozen(g.host), false, 'and the hold with it');
        flushTeardowns();
        assert.deepEqual(g.log, [['release', true, true], ['teardown']]);
    } finally {
        mock.timers.reset();
    }
});

test('nothing sent (a click that never engaged) — no pin, no hold, torn down at once', () => {
    const calls = fakeBridge();
    noteFrame(5, 5, 55 * Q);
    const g = slideGesture({ toQ: null, engage: true });
    g.up();
    assert.equal(calls.length, 0, 'no commit');
    assert.equal(mapDragPinZero(), null, 'never pinned');
    assert.equal(isOverlayFrozen(g.host), false);
    assert.deepEqual(g.log, [['release', false, false], ['teardown']]);
});

test('a throwing onEnd never leaves the frame pinned', () => {
    noteFrame(5, 5, 55 * Q);
    const node = new FakeEl();
    const g = beginGesture({ target: node, pointerId: 1,
                             preventDefault() {}, stopPropagation() {} },
        { onEnd: () => { throw new Error('boom'); } });
    g.pin();
    assert.equal(mapDragPinZero(), 55 * Q);
    assert.throws(() => node.fire('pointerup', { pointerId: 1 }), /boom/);
    assert.equal(mapDragPinZero(), null, 'released despite the throw');
});

test('a newer gesture on the same overlay takes the older one\'s held preview', async () => {
    const calls = fakeBridge();
    noteFrame(5, 5, 55 * Q);
    const first = slideGesture();
    first.up();
    // A second gesture engages on the SAME overlay while the first is
    // still held: the first's teardown runs first — no stale preview,
    // no second reveal layer.
    const o = first.o;
    const target = new FakeEl();
    const s = st();
    const log2 = [];
    runRawDrag({ clientX: 80, altKey: false, target, pointerId: 2,
                 preventDefault() {}, stopPropagation() {} }, o, s, {
        rawQAt: x => x / pxPerQ, view: () => ({ q0: 0, spanQ: 12 }),
        onMove: slideMoveFn(s, s.segs, 8), freeze: [first.host], engage: false,
        onTeardown: () => log2.push('teardown'),
    });
    assert.deepEqual(first.log, [['release', true, true], ['teardown']],
        'the older preview came down at the newer engage');
    assert.ok(o.cls.has('drag-live') && !o.cls.has('drag-held'),
        'the newer gesture owns the overlay now');
    target.fire('pointerup', { pointerId: 2 });
    calls.forEach(c => c.answer(true));
    await flushMicrotasks();
    flushTeardowns();
    assert.deepEqual(log2, ['teardown']);
    assert.equal(mapDragPinZero(), null, 'every pin released');
});

/* ---------- the pin, read by the real view model ---------- */

const SQ = 48000;
const clip = (id, originQ, durationQ, extra = {}) => ({
    id, name: id, type: 'clip', origin: Math.round(originQ * SQ),
    duration: Math.round(durationQ * SQ), effectiveQuantum: SQ,
    loopStart: 0, loopEnd: 0, loopBypassed: false, windowActive: false,
    isMuted: false, isRecording: false, isPendingStart: false, ...extra,
});
/** The field topology (seat_nearest.test.mjs) with B's window slid. */
const island = slideQ => ({
    id: 'root', type: 'stack', quantum: SQ, islandZero: 0, definerId: '',
    isPlaying: true, masterPos: 0, islandPos: Math.round(55.3 * SQ),
    perf: { sampleRate: SQ },
    nodes: [
        clip('A', 0, 1),
        clip('B', 11, 56, { loopStart: Math.round((44 + slideQ) * SQ),
                            loopEnd: Math.round((49 + slideQ) * SQ),
                            windowActive: true }),
        clip('C', 58, 5),
    ],
});
const pollOpts = () => ({ pinFrameQ: mapDragPinQ(), pinFoldQ: mapDragPinFoldQ(),
                          pinZero: mapDragPinZero() });

test('no poll between release and settle seats the frame from the last LIVE geometry', async () => {
    // The last live commit reached −0.55Q (past the half: seated alone
    // it re-seats the frame); the final commit lands at −0.45Q (it does
    // not). Unpinned at pointerup, the poll in flight would jump the
    // frame 1Q and the next poll jump it back.
    const rest = deriveViewModel(island(0));
    assert.equal(rest.frameZero, 55 * SQ);
    assert.equal(deriveViewModel(island(-0.55)).frameZero, 54 * SQ,
        'the live geometry, seated alone, re-seats');
    assert.equal(deriveViewModel(island(-0.45)).frameZero, 55 * SQ,
        'the final geometry does not');
    const calls = fakeBridge();
    noteFrame(rest.cycleQ, rest.loopCycleQ, rest.frameZero);
    const g = slideGesture();
    g.up();
    // The poll answered before the engine applied the final commit.
    const inFlight = deriveViewModel(island(-0.55), pollOpts());
    assert.equal(inFlight.frameZero, 55 * SQ, 'pinned: no jump');
    assert.equal(inFlight.cycleQ, rest.cycleQ);
    calls[calls.length - 1].answer(true);
    await flushMicrotasks();
    const settled = deriveViewModel(island(-0.45), pollOpts());
    assert.equal(mapDragPinZero(), null, 'unpinned');
    assert.equal(settled.frameZero, 55 * SQ, 'the committed picture: still no jump');
    flushTeardowns();
});
