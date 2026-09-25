/**
 * THE RE-TIME AND THE TOP — mock parity (docs/loop_selection.md §9,
 * owner 2026-09-24; engine twins: tests/time_map_record_tests.cc
 * "setTiming" / "the top rides every map edit", scenario S41).
 *
 * A swap (every map verb) changes WHAT plays and keeps the origin; a
 * shift (setTiming) changes WHEN: it moves the clip's origin by any
 * amount — sub-Q included, never re-folded — and counts the same into
 * `retime` (0 = as played); a new take plays as performed and resets
 * it. The loop's top (↺) is a raw take position
 * stored per clip — unset only on a take never edited, whose region
 * start stands in; every map edit reconciles it from the top it showed
 * and STORES the answer (kept while the new region plays it, else the
 * new region start), a bypass leaves it, and one undo step restores
 * origin, re-time and top together. The pure algebra is golden-pinned
 * against src/time_map.h.
 *
 * (Undo restores the mock's graph from a snapshot — node objects are
 * replaced, so every read below re-finds its node.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario, pauseTransport }
    from '../mock_backend.js';
import { findNode, state } from '../mock/state.js';
import { effectiveTop, reconcileTop } from '../time_map.js';
import { MOCK_Q, loadSharedJson, nodeById, recordTake } from './helpers.mjs';

const golden = loadSharedJson('timing_golden.json');
const Q = MOCK_Q;
const pub = id => nodeById(id, getState().nodes);
const origin = id => findNode(id).origin;

test('golden: reconcileTop (engine timing::reconcileTop) — every edit of a ' +
     'chain reconciles from the effective top before it, and stores', () => {
    // windowActive defaults to a non-empty map (bypass is explicit).
    const activeOf = (o, segs) => ('windowActive' in o ? o.windowActive : segs.length > 0);
    for (const c of golden.top_reconcile_cases) {
        let map = { segs: c.segments };
        let active = activeOf(c, c.segments);
        let top = c.top;
        assert.ok(c.edits.length > 0, c.name);
        c.edits.forEach((ed, i) => {
            const map2 = { segs: ed.segments };
            const active2 = activeOf(ed, ed.segments);
            const before = effectiveTop(map, active, c.duration, top);
            top = reconcileTop(map2, active2, c.duration, before);
            assert.equal(top, ed.expected, `${c.name} (edit ${i + 1})`);
            map = map2;
            active = active2;
        });
    }
});

test('golden: effectiveTop — the published loopTop (engine timing::effectiveTop)', () => {
    for (const c of golden.effective_top_cases) {
        assert.equal(effectiveTop({ segs: c.segments }, c.windowActive,
            c.duration, c.top), c.expected, c.name);
    }
});

/** The clock held still and stopped: map edits never re-anchor, so
 * every origin move below is the verb's own. */
function holdStill() {
    pauseTransport();
    state.isPlaying = false;
}

/** 1Q, then an 8Q take. */
async function island() {
    loadScenario('empty');
    const c1 = await recordTake('', Q, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 8 * Q);
    holdStill();
    return { c1, b };
}

/** A redo branch survives only when nothing is recorded. */
async function armProbe(id) {
    await callNative('renameNode', id, 'probe');
    await callNative('undo');
    assert.equal(getState().canRedo, true, 'the probe');
}

test('setTiming moves the origin by any amount and counts the re-time; ' +
     'nothing else moves; undo/redo; "timing as played"', async () => {
    const { c1, b } = await island();
    const O = origin(b), O1 = origin(c1);
    const zero = state.islandZero, q = state.islandQ;
    assert.equal(pub(b).retime, 0, 'a fresh take is as played');
    assert.equal(pub(b).loopTop, 0, 'no map, no top: the take start');
    assert.equal('storedTop' in pub(b), false, 'the stored top stays private');

    await callNative('setTiming', b, Q);
    assert.equal(origin(b), O + Q, 'the origin moved by the shift');
    assert.equal(pub(b).retime, Q, '…counted');
    assert.equal(state.islandZero, zero, 'the zero stays');
    assert.equal(state.islandQ, q, 'Q stays');
    assert.equal(origin(c1), O1, 'the other take stays');
    assert.equal(pub(c1).retime, 0, '…as played');
    assert.equal(findNode(b).duration, 8 * Q, 'the length stays');

    const free = Math.round(0.3 * Q);
    await callNative('setTiming', b, free);  // ⌥: free, sub-Q
    assert.equal(origin(b), O + Q + free, 'exact — never re-folded onto the grid');
    assert.equal(pub(b).retime, Q + free);
    await callNative('undo');
    assert.equal(origin(b), O + Q, 'undo');
    assert.equal(pub(b).retime, Q);
    await callNative('redo');
    assert.equal(origin(b), O + Q + free, 'redo');

    await callNative('setTiming', b, -pub(b).retime);  // "timing as played"
    assert.equal(origin(b), O, 'as played: the performed origin');
    assert.equal(pub(b).retime, 0);
});

test("the panel's start marker: a top and its compensating shift in one " +
     'step — undo restores origin, re-time and top together', async () => {
    const { b } = await island();
    const O = origin(b);
    await callNative('setLoopPoints', b, Q, 3 * Q);
    assert.equal(pub(b).loopTop, Q, 'the window stored its region start');
    // [Q,3Q): the top sounds at O + Q; a top at 2Q is heard 1Q in, so
    // the ↺ keeps its moment with a −1Q shift.
    await callNative('setTiming', b, -Q, 2 * Q);
    assert.equal(pub(b).loopTop, 2 * Q, 'the top is stored');
    assert.equal(origin(b), O - Q, 'the origin compensates');
    assert.equal(pub(b).retime, -Q);
    const moment = n => n.origin + n.loopStart + (n.loopTop - n.loopStart);
    assert.equal(moment(pub(b)), O + Q, 'the ↺ kept its moment');
    const facts = () => [origin(b), pub(b).retime, pub(b).loopTop];
    await callNative('undo');
    assert.deepEqual(facts(), [O, 0, Q], 'undo: origin, re-time and top together');
    await callNative('redo');
    assert.deepEqual(facts(), [O - Q, -Q, 2 * Q], 'redo: all three');
});

test('refusals record nothing: the Q-definer, a stack, an empty clip, an ' +
     'unknown node, a top outside the kept set (whole call), the identity, ' +
     'and anything under a live take', async () => {
    loadScenario('empty');
    const c1 = await recordTake('', Q, { stopEarly: 0, settle: 0 });
    const O1 = origin(c1);
    assert.equal(getState().definerId, c1, 'the only take defines Q');
    await callNative('setTiming', c1, Q / 2);
    assert.equal(origin(c1), O1, "the Q-definer refuses (its origin is the island zero)");

    const b = await recordTake('', 4 * Q);
    holdStill();
    await callNative('setLoopPoints', b, Q, 3 * Q);
    const g = await callNative('createNode', 'stack', '');
    const e = await callNative('createNode', 'clip', '');
    const O = origin(b);
    await armProbe(b);
    await callNative('setTiming', b, Q, 0);        // before the window
    await callNative('setTiming', b, Q, 3 * Q);    // the window's end (exclusive)
    await callNative('setTiming', b, Q, 9 * Q);    // past the take
    assert.equal(origin(b), O, 'a top outside the kept set refuses the whole call');
    assert.equal(pub(b).retime, 0, '…no partial shift');
    assert.equal(pub(b).loopTop, Q, '…no top');
    await callNative('setTiming', g, Q);
    await callNative('setTiming', e, Q);
    await callNative('setTiming', 'no-such-node', Q);
    await callNative('setTiming', b, 0);           // the identity
    assert.equal(getState().canRedo, true, 'none of them recorded');
    assert.equal('retime' in pub(g), false, 'a stack publishes no re-time');
    assert.equal(pub(g).loopTop, 0, '…and its region start as its top');

    await callNative('startRecordingInNode', e);   // a take armed
    assert.equal(await callNative('setTiming', b, Q), false,
        'refused under a live take');
    assert.equal(origin(b), O, 'nothing moved');
    await callNative('stopRecordingInNode', e);
    advanceBy(4 * Q);                              // the take settles
    assert.equal(findNode(e).isRecording, false, 'no take live');
    await callNative('setTiming', b, Q);
    assert.equal(origin(b), O + Q, 'the take settled: the re-time lands');
});

test('a new take plays as performed and resets the re-time (owner, ' +
     '2026-09-24): armed at the shifted slot top, it sounds where it was ' +
     'played, so "timing as played" leaves it there; undo brings back the ' +
     'old take with its shift, redo the 0', async () => {
    // Engine twin: tests/time_map_record_tests.cc, the same sequence.
    loadScenario('empty');
    await recordTake('', Q, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 4 * Q);
    const O = origin(b);
    await callNative('setTiming', b, Q);
    assert.equal(pub(b).retime, Q, 'the take is shifted +1Q');
    // A NEW TAKE, armed mid-period: it waits for the slot's own top —
    // the SHIFTED origin — and captures exactly one period.
    advanceBy(Q / 2);
    await callNative('newTake', b);
    const at = findNode(b).pendingStartAt;
    assert.equal((at - (O + Q)) % (4 * Q), 0, 'armed at the shifted slot top');
    advanceBy(at - state.masterPos);  // capture begins at the top
    advanceBy(4 * Q);                 // one period: the auto-finish
    assert.equal(findNode(b).isRecording, false, 'the new take settled');
    assert.equal(pub(b).takes, 2, 'two takes');
    assert.equal(pub(b).activeTake, 1, 'the new one is active');
    assert.equal(origin(b), O + Q,
        'the slot keeps its origin: the new take sounds where it was played');
    assert.equal(pub(b).retime, 0, 'the re-time resets: the new take is as played');
    await callNative('setTiming', b, -pub(b).retime);  // "timing as played"
    assert.equal(origin(b), O + Q, '"timing as played" leaves it there');
    await callNative('undo');
    assert.equal(pub(b).takes, 1, 'undo: the old take alone');
    assert.equal(pub(b).activeTake, 0, '…active');
    assert.equal(pub(b).retime, Q, '…with its +1Q');
    assert.equal(origin(b), O + Q, '…at its shifted origin');
    await callNative('redo');
    assert.equal(pub(b).takes, 2, 'redo: the new take');
    assert.equal(pub(b).activeTake, 1, '…active');
    assert.equal(pub(b).retime, 0, '…re-time 0 again');
    // The older take keeps its shift as a baked fact; ⌘Z still reaches
    // it behind the new take.
    await callNative('undo');
    await callNative('undo');
    assert.equal(origin(b), O, 'two undos: the shift is gone too');
    assert.equal(pub(b).retime, 0, '…as played');
});

test('a live re-time drag is one undo step; separate gestures are two; a ' +
     're-time never joins a map edit\'s step', async () => {
    const { b } = await island();
    const O = origin(b);
    const d = Math.round(Q / 10);
    await callNative('setTiming', b, d);
    await callNative('setTiming', b, d, null, true);
    await callNative('setTiming', b, -d / 2, null, true);
    assert.equal(origin(b), O + 1.5 * d, 'the streamed commits applied');
    assert.equal(pub(b).retime, 1.5 * d);
    await callNative('undo');
    assert.equal(origin(b), O, 'one undo takes the drag back');
    assert.equal(pub(b).retime, 0);
    await callNative('setTiming', b, d);
    await callNative('setTiming', b, d);
    await callNative('undo');
    assert.equal(origin(b), O + d, 'separate gestures: one step each');
    await callNative('undo');
    assert.equal(origin(b), O);
    await callNative('setLoopPoints', b, 2 * Q, 4 * Q);
    await callNative('setTiming', b, d, null, true);
    await callNative('undo');
    assert.equal(origin(b), O, 'the re-time undid on its own');
    assert.equal(findNode(b).loopStart, 2 * Q, '…the slide stands');
});

test('the top rides every map edit — kept while the new region plays it, ' +
     'else the region start; undo restores it exactly; a bypass leaves it; ' +
     'a clear keeps it', async () => {
    const { b } = await island();
    const O = origin(b);
    // A fresh take's top is its start (raw 0): the first window drops
    // it, so the window's start is stored; a slide right drops that.
    await callNative('setLoopPoints', b, 2 * Q, 4 * Q);
    assert.equal(pub(b).loopTop, 2 * Q, 'the region start, stored');
    assert.equal(findNode(b).storedTop, 2 * Q, '…a fact now, not a stand-in');
    await callNative('setLoopPoints', b, 3 * Q, 5 * Q);
    assert.equal(pub(b).loopTop, 3 * Q, 'a slide right past it: the new start');
    await callNative('setLoopPoints', b, Q, 3 * Q);
    await callNative('setTiming', b, 0, 2 * Q);  // a top alone
    assert.equal(pub(b).loopTop, 2 * Q);
    assert.equal(origin(b), O, 'a top alone moves nothing in time');
    // setLoopPoints: a SWAP keeps the origin; the top survives while
    // the region still plays it.
    await callNative('setLoopPoints', b, 1.5 * Q, 3.5 * Q);
    assert.equal(pub(b).loopTop, 2 * Q, 'a slide that still plays it keeps it');
    await callNative('setLoopPoints', b, 3 * Q, 5 * Q);
    assert.equal(pub(b).loopTop, 3 * Q, 'a slide past it: the region start');
    await callNative('undo');
    assert.equal(pub(b).loopTop, 2 * Q, 'undo restores it exactly');
    await callNative('redo');
    assert.equal(pub(b).loopTop, 3 * Q, 'redo: the region start again');
    // setSegments: a CELL CUT under it drops it; a HEAL keeps it.
    await callNative('setLoopPoints', b, Q, 5 * Q);
    await callNative('setTiming', b, 0, 3.5 * Q);
    await callNative('setSegments', b, [Q, 3 * Q, 4 * Q, 5 * Q]);
    assert.equal(pub(b).loopTop, Q, 'the cut removed its cell');
    await callNative('undo');
    assert.equal(pub(b).loopTop, 3.5 * Q, 'undo: back');
    await callNative('setSegments', b, [Q, 3 * Q, 4 * Q, 5 * Q]);
    await callNative('setTiming', b, 0, 4.5 * Q);
    assert.equal(pub(b).loopTop, 4.5 * Q, 'a top in the second segment');
    await callNative('setSegments', b, [Q, 5 * Q]);  // heal (n = 1)
    assert.equal(pub(b).loopTop, 4.5 * Q, 'the heal still plays it');
    // A bypass leaves it; a clear keeps it (the whole take plays it).
    await callNative('toggleLoopWindow', b);
    assert.equal(pub(b).loopBypassed, true);
    assert.equal(pub(b).loopTop, 4.5 * Q, 'a bypass leaves the top alone');
    await callNative('toggleLoopWindow', b);
    await callNative('setLoopPoints', b, 0, 0);
    assert.equal(pub(b).loopTop, 4.5 * Q, 'a cleared map keeps it');
    assert.equal(origin(b), O, 'no swap moved the take in time');
});

test("a live drag reconciles every commit against its gesture's own top: " +
     'sweeping past the ↺ and back keeps it; one undo restores it', async () => {
    const { b } = await island();
    await callNative('setLoopPoints', b, Q, 5 * Q);
    await callNative('setTiming', b, 0, 2 * Q);
    await callNative('setLoopPoints', b, 1.5 * Q, 5.5 * Q);  // the drag's first commit
    await callNative('setLoopPoints', b, 2.5 * Q, 6.5 * Q, true);
    assert.equal(pub(b).loopTop, 2.5 * Q, 'mid-drag the region left the top');
    await callNative('setLoopPoints', b, 1.5 * Q, 5.5 * Q, true);
    assert.equal(pub(b).loopTop, 2 * Q, "…and back: the drag's own top returns");
    await callNative('setSegments', b, [3 * Q, 4 * Q, 5 * Q, 8 * Q], true);
    assert.equal(pub(b).loopTop, 3 * Q, 'a live cut that drops it');
    await callNative('undo');
    assert.equal(pub(b).loopTop, 2 * Q, "one undo: the gesture's top");
    assert.equal(pub(b).loopStart, Q, '…and its region');
});

test('an UNSET top (a take never edited) is its region start until the ' +
     'first map edit stores it: a left slide keeps the ↺ there, a right ' +
     'slide past it takes the new start, a reset stays put when the region ' +
     'slides back, and a live drag reconciles from where the ↺ showed', async () => {
    const { b } = await island();
    /** A window no edit has reconciled a top against — a fresh take's
     * commit-time window, a session saved before tops. */
    const fresh = (a, e) => {
        const n = findNode(b);
        Object.assign(n, { loopStart: a, loopEnd: e });
        delete n.storedTop;
        assert.equal(pub(b).loopTop, a, 'unset: the region start stands in');
    };
    fresh(2 * Q, 4 * Q);
    await callNative('setLoopPoints', b, Q, 3 * Q);           // left 1Q
    assert.equal(pub(b).loopTop, 2 * Q,
        'a left slide keeps the ↺ where it showed: the splice comes apart');
    await callNative('undo');
    assert.equal(findNode(b).storedTop ?? null, null, 'undo: unset, exactly as found');
    assert.equal(pub(b).loopTop, 2 * Q);
    await callNative('setLoopPoints', b, 3 * Q, 5 * Q);       // right 1Q
    assert.equal(pub(b).loopTop, 3 * Q, 'a right slide past it: the new start');
    // THE RESET STAYS PUT (the owner's bars 1–4 → 3–6 → 2–5): stored at
    // the reset, the ↺ holds bar 3 when the region slides back over it —
    // left unset it would ride the start to bar 2 (the rejected v5).
    fresh(0, 4 * Q);
    await callNative('setLoopPoints', b, 2 * Q, 6 * Q);
    assert.equal(pub(b).loopTop, 2 * Q, 'bars 3–6 drop bar 1: the ↺ resets to bar 3');
    await callNative('setLoopPoints', b, Q, 5 * Q);
    assert.equal(pub(b).loopTop, 2 * Q, 'back to bars 2–5: the ↺ stays on bar 3');
    // A LIVE DRAG from an unset top: every commit reconciles from the
    // top it showed when the drag began, not from the last commit's.
    fresh(2 * Q, 4 * Q);
    await callNative('setLoopPoints', b, 3 * Q, 5 * Q);       // the first commit
    assert.equal(pub(b).loopTop, 3 * Q, 'mid-drag the region left the ↺');
    await callNative('setLoopPoints', b, Q, 3 * Q, true);
    assert.equal(pub(b).loopTop, 2 * Q, "…and back past it: the drag's own top");
    await callNative('undo');
    assert.equal(findNode(b).storedTop ?? null, null, 'one undo: unset, as found');
    assert.equal(findNode(b).loopStart, 2 * Q, '…with its region');
});

test('a drag whose first commit records nothing (an identity — engaged, no ' +
     'whole Q crossed yet — or a refusal) is still its own undo step: two ' +
     'splice drags are two steps, each undo restoring its start and its ' +
     'stored top exactly; two re-time drags opening on a zero shift are two ' +
     'steps; a drag that dwells and returns to its start is one step; an ' +
     'undo ends the gesture', async () => {
    // Engine twin: tests/time_map_record_tests.cc, the same sequence.
    const { b } = await island();
    const stored = () => findNode(b).storedTop;
    const region = () => {
        const n = findNode(b);
        return (n.loopStart / Q) + '-' + (n.loopEnd / Q);
    };
    // A WHOLE-Q SPLICE DRAG over a window commits the slid window; its
    // first commit is the window it found — an identity, recording nothing.
    const slide = (a, live) =>
        callNative('setSegments', b, [a, a + 4 * Q], live);
    await callNative('setLoopPoints', b, Q, 5 * Q);
    await callNative('setTiming', b, 0, 2 * Q);  // the ↺ on 2Q
    // Drag 1: [Q,5Q) → [3Q,7Q) leaves the ↺ behind: the region start.
    await slide(Q, false);
    await slide(2 * Q, true);
    await slide(3 * Q, true);
    assert.equal(stored(), 3 * Q, 'drag 1 dropped the ↺');
    // Drag 2 back to [Q,5Q) reconciles from ITS start (3Q, which the
    // region keeps playing) — never drag 1's (2Q).
    await slide(3 * Q, false);
    await slide(2 * Q, true);
    await slide(Q, true);
    assert.equal(stored(), 3 * Q, 'drag 2 kept the ↺ it found');
    await callNative('undo');
    assert.equal(region(), '3-7', 'undo: drag 2 alone');
    assert.equal(stored(), 3 * Q, '…with its ↺');
    await callNative('undo');
    assert.equal(region(), '1-5', 'undo: drag 1');
    assert.equal(stored(), 2 * Q, '…its ↺ exactly');
    await callNative('redo');
    await callNative('redo');
    assert.deepEqual([region(), stored()], ['1-5', 3 * Q], 'redo: both drags');

    // RE-TIME DRAGS opening on a zero shift (the ↺ grabbed, not yet
    // moved): two drags, two steps.
    const O = origin(b), R = pub(b).retime;
    await callNative('setTiming', b, 0);
    await callNative('setTiming', b, Q, null, true);
    await callNative('setTiming', b, Q, null, true);
    await callNative('setTiming', b, 0);
    await callNative('setTiming', b, -Q / 2, null, true);
    await callNative('setTiming', b, -Q / 4, null, true);
    assert.equal(origin(b), O + 5 * Q / 4, 'both drags applied');
    await callNative('undo');
    assert.equal(origin(b), O + 2 * Q, 'undo: re-time drag 2 alone');
    assert.equal(pub(b).retime, R + 2 * Q, '…its re-time');
    await callNative('undo');
    assert.equal(origin(b), O, 'undo: re-time drag 1');
    assert.equal(pub(b).retime, R, '…its re-time');

    // A DRAG THAT DWELLS and RETURNS TO ITS START is one step: its
    // identities (and a refused commit) record nothing and keep it —
    // and so does a read between commits (only a logged step ends it).
    await slide(Q, false);
    await slide(Q, true);
    await slide(4 * Q, true);
    await callNative('setLoopPoints', b, 4 * Q, 6.5 * Q, true);  // refused
    await slide(4 * Q, true);
    await callNative('getWaveform', b, 64);
    await slide(Q, true);  // back at its start
    await slide(Q, true);
    await slide(0, true);
    assert.equal(region(), '0-4', 'the drag landed');
    assert.equal(stored(), 3 * Q, '…reconciled from its start');
    await callNative('undo');
    assert.equal(region(), '1-5', "one undo: the drag's start");
    assert.equal(stored(), 3 * Q, '…and its ↺');
    await callNative('undo');
    assert.equal(region(), '3-7', "the next undo is drag 2's");

    // AN UNDO ENDS THE GESTURE: a live commit after it logs its own step,
    // never joining the step the undo left on top (drag 1's).
    await slide(2 * Q, false);
    await callNative('undo');
    await slide(4 * Q, true);
    await callNative('undo');
    assert.equal(region(), '3-7', 'the stray live commit undid alone');
    assert.equal(stored(), 3 * Q, '…with its ↺');
    // A REFUSED first commit opens its gesture too.
    await callNative('setLoopPoints', b, 3 * Q, 5.5 * Q);  // off Q: refused
    await slide(2 * Q, true);
    await callNative('undo');
    assert.equal(region(), '3-7', 'after a refused first commit');
    await callNative('undo');
    assert.equal(region(), '1-5', "drag 1's start, still one step away");
});

test('stacks publish their region start as loopTop and no re-time', async () => {
    const { b } = await island();
    const g = await callNative('createNode', 'stack', '');
    await callNative('reorderNode', b, g, 0);
    assert.equal(pub(g).loopTop, 0, 'no window: 0');
    assert.equal('retime' in pub(g), false, 'no re-time');
    await callNative('setLoopPoints', g, 2 * Q, 4 * Q);
    assert.equal(pub(g).loopTop, 2 * Q, 'an active window: its start');
    await callNative('toggleLoopWindow', g);
    assert.equal(pub(g).loopTop, 0, 'bypassed: the take start');
    const Og = pub(g).origin;
    await callNative('setTiming', g, Q);
    assert.equal(pub(g).origin, Og, 'a stack is never re-timed');
});

test('the Q13 definer re-trim reconciles its top; the lock-collapse carries ' +
     'it (raw − the window start); the re-open puts it back', async () => {
    loadScenario('empty');
    const c = await recordTake('', Q, { stopEarly: 0, settle: 0 });
    const d = await recordTake('', 2 * Q);
    await callNative('setTiming', c, 0, Q / 2);  // not the definer while d exists
    assert.equal(pub(c).loopTop, Q / 2);
    await callNative('deleteNode', d);
    assert.equal(getState().definerId, c, 'c defines Q again');
    await callNative('setLoopPoints', c, Q / 4, 3 * Q / 4);  // Q13: Q := Q/2
    assert.equal(state.islandQ, Q / 2, 'the re-trim re-established Q');
    assert.equal(pub(c).loopTop, Q / 2, '…and kept the top it plays');
    const moment = origin(c) + Q / 2;
    // A take armed against the trimmed island collapses the definer.
    const e = await recordTake('', Q / 2);
    assert.equal(findNode(c).duration, Q / 2, 'collapsed to the window');
    assert.equal(pub(c).loopTop, Q / 4, 'the top, re-expressed in the collapsed take');
    assert.equal(origin(c) + pub(c).loopTop, moment, '…at the same moment');
    await callNative('deleteNode', e);  // the re-open uncollapses
    assert.equal(findNode(c).duration, Q, 'uncollapsed');
    assert.equal(pub(c).loopTop, Q / 2, 'the raw top is back');
    await callNative('setLoopPoints', c, 0, Q / 4);  // a re-trim that drops it
    assert.equal(pub(c).loopTop, 0, 'a re-trim past the top resets it');
    await callNative('undo');
    assert.equal(pub(c).loopTop, Q / 2, 'undo: the top with the trim');
});

test('a saved session carries the top and the re-time', async () => {
    const { b } = await island();
    await callNative('setLoopPoints', b, Q, 3 * Q);
    await callNative('setTiming', b, -Math.round(Q / 4), 2 * Q);
    const O = origin(b);
    await callNative('saveSession', '/tmp/s');
    loadScenario('empty');
    assert.equal(await callNative('loadSession', '/tmp/s'), true);
    assert.equal(origin(b), O, 'the re-timed origin');
    assert.equal(pub(b).retime, -Math.round(Q / 4), 'the re-time');
    assert.equal(pub(b).loopTop, 2 * Q, 'the top');
});
