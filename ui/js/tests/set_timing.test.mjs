/**
 * THE RE-TIME AND THE TOP (docs/loop_selection.md §9).
 *
 * A swap (every map verb) changes WHAT plays and keeps the origin; a
 * shift (setTiming) changes WHEN, counted into `retime` (0 = as played).
 * The loop's top (↺) is a raw take position stored per clip; every map
 * edit reconciles it from the top it showed and stores the answer.
 *
 * The algebra is golden-pinned against src/time_map.h (the two golden
 * tests). The verbs themselves — a shift, a top, their undo, their
 * refusals, a live drag, the session round trip — are held to the
 * engine by the differential suite (ui/differential/ timing/*); what
 * follows are the sequences no journey drives.
 *
 * (Undo restores the mock's graph from a snapshot — node objects are
 * replaced, so every read below re-finds its node.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario } from '../mock_backend.js';
import { findNode, state } from '../mock/state.js';
import { effectiveTop, reconcileTop } from '../time_map.js';
import { MOCK_Q as Q, loadSharedJson, recordTake } from './helpers.mjs';
import { published as pub, recordIsland, holdStill } from './mock_scene.mjs';

const golden = loadSharedJson('timing_golden.json');
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

/** 1Q, then an 8Q take, the clock held still: every origin move below
 * is the verb's own. */
async function island() {
    const [c1, b] = await recordIsland(Q, 8 * Q);
    holdStill();
    return { c1, b };
}

/** A redo branch survives only when nothing is recorded. */
async function armProbe(id) {
    await callNative('renameNode', id, 'probe');
    await callNative('undo');
    assert.equal(getState().canRedo, true, 'the probe');
}

test('an empty group has nothing to re-time: refused, nothing recorded', async () => {
    const { b } = await island();
    const g = await callNative('createNode', 'stack', '');
    await armProbe(b);
    await callNative('setTiming', g, Q);
    assert.equal(getState().canRedo, true, 'not recorded');
    assert.equal(pub(g).retime, 0);
    assert.equal(pub(g).loopTop, 0, 'its region start as its top');
});

test('a new take plays as performed and resets the re-time: armed at the ' +
     'shifted slot top, it sounds where it was played, so "timing as ' +
     'played" leaves it there; undo brings back the old take with its ' +
     'shift, redo the 0', async () => {
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

test("a re-time never joins a map edit's step", async () => {
    const { b } = await island();
    const O = origin(b);
    await callNative('setLoopPoints', b, 2 * Q, 4 * Q);
    await callNative('setTiming', b, Math.round(Q / 10), null, true);
    await callNative('undo');
    assert.equal(origin(b), O, 'the re-time undid on its own');
    assert.equal(findNode(b).loopStart, 2 * Q, '…the slide stands');
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

test('a GROUP has a top and a re-time exactly like a clip (fractal): the ' +
     'region start by default, reconciled by its region edits, and a ' +
     'shift moves the group and its members as one', async () => {
    const { b } = await island();
    const g = await callNative('createNode', 'stack', '');
    await callNative('reorderNode', b, g, 0);
    assert.equal(pub(g).loopTop, 0, 'no window: 0');
    assert.equal(pub(g).retime, 0, 'as played');
    await callNative('setLoopPoints', g, 2 * Q, 4 * Q);
    assert.equal(pub(g).loopTop, 2 * Q, 'an active window: its start');
    await callNative('toggleLoopWindow', g);
    assert.equal(pub(g).loopTop, 2 * Q,
        'bypassed: the stored top stays (bypass toggles the region, not what it keeps)');
    await callNative('toggleLoopWindow', g);
    const Og = pub(g).origin;
    const Ob = origin(b);
    await callNative('setTiming', g, Q);
    assert.equal(pub(g).origin, Og + Q, 'the group moved');
    assert.equal(origin(b), Ob + Q, '…its member rode it');
    assert.equal(pub(g).retime, Q, '…and the re-time counts it');
    // The start marker onto the next hit: a new top plus the shift that
    // keeps its moment.
    await callNative('setTiming', g, -Q, 3 * Q);
    assert.equal(pub(g).loopTop, 3 * Q, 'the stored top');
    assert.equal(pub(g).origin, Og, '…the shift keeps its moment');
    await callNative('setLoopPoints', g, 3 * Q, 5 * Q);  // still plays 3Q
    assert.equal(pub(g).loopTop, 3 * Q, 'an edit that keeps the top keeps it');
    await callNative('setLoopPoints', g, 4 * Q, 6 * Q);  // drops it
    assert.equal(pub(g).loopTop, 4 * Q, '…one that drops it: the region start');
    await callNative('undo');
    assert.equal(pub(g).loopTop, 3 * Q, 'undo restores the top with the map');
    await callNative('setTiming', g, -pub(g).retime);  // timing as played
    assert.equal(pub(g).retime, 0, 'as played again');
    assert.equal(origin(b), Ob, '…the member back where it was played');
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
