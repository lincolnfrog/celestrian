/**
 * edit_verdict.js — whether a geometry commit landed: the three pure
 * judgements and their one-sample tolerance, and the debounced verdict
 * each commit queues (one per stream of live commits; none after an
 * undo, a cancelled drag, a lost read or a node that left).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { windowLanded, segmentsLanded, timingLanded, createEditVerdict,
         VERDICT_DEBOUNCE_MS, LANDED_TOLERANCE_SAMPLES as TOL }
    from '../edit_verdict.js';
import { createShellIo } from '../shell_io.js';
import { notePoll, indexNodes } from '../session_facts.js';

const clip = (extra = {}) => ({
    id: 'a', type: 'clip', name: 'Bass', duration: 1000,
    loopStart: 0, loopEnd: 0, retime: 0, ...extra,
});

/* ---------- the pure judgements ---------- */

test('windowLanded: the published window is the one asked for', () => {
    const n = clip({ loopStart: 100, loopEnd: 600 });
    assert.equal(windowLanded(n, 100, 600), true);
    assert.equal(windowLanded(n, 100, 700), false);
    assert.equal(windowLanded(n, 200, 600), false);
});

test('windowLanded: either edge may sit one sample from what was asked, no further', () => {
    assert.equal(TOL, 1);
    const n = clip({ loopStart: 100, loopEnd: 600 });
    for (const d of [-TOL, TOL]) {
        assert.equal(windowLanded(n, 100 + d, 600), true, `start off by ${d}`);
        assert.equal(windowLanded(n, 100, 600 + d), true, `end off by ${d}`);
    }
    for (const d of [-TOL - 1, TOL + 1]) {
        assert.equal(windowLanded(n, 100 + d, 600), false, `start off by ${d}`);
        assert.equal(windowLanded(n, 100, 600 + d), false, `end off by ${d}`);
    }
    // The view asks in fractional samples; the engine stores whole ones.
    assert.equal(windowLanded(n, 100.6, 599.4), true);
});

test('windowLanded: the engine\'s clamps count as landing', () => {
    assert.equal(windowLanded(clip({ loopStart: 0, loopEnd: 600 }), -50, 600), true,
        'a start before the take floors at 0');
    assert.equal(windowLanded(clip({ loopStart: 100, loopEnd: 1000 }), 100, 1400), true,
        'a clip\'s end stops at its material');
    const group = { id: 'g', type: 'stack', loopStart: 100, loopEnd: 1400 };
    assert.equal(windowLanded(group, 100, 1400), true, 'a node with no duration is not clamped');
    assert.equal(windowLanded(clip({ loopStart: 100, loopEnd: 1000 }), 100, 900), false);
});

test('windowLanded: an empty request is a clear, landed when no window is left', () => {
    assert.equal(windowLanded(clip(), 0, 0), true);
    assert.equal(windowLanded(clip(), 300, 300), true);
    assert.equal(windowLanded(clip({ loopStart: 100, loopEnd: 600 }), 0, 0), false);
});

test('segmentsLanded: a multi-segment map must be published as asked', () => {
    const asked = [0, 200, 400, 600];
    assert.equal(segmentsLanded(clip({ segments: [0, 200, 400, 600] }), asked), true);
    assert.equal(segmentsLanded(clip({ segments: [0, 200 + TOL, 400 - TOL, 600] }), asked), true);
    assert.equal(segmentsLanded(clip({ segments: [0, 200, 400 + TOL + 1, 600] }), asked), false);
    assert.equal(segmentsLanded(clip({ segments: [0, 200, 400, 600, 700, 800] }), asked), false,
        'a different segment count');
    assert.equal(segmentsLanded(clip(), asked), false, 'no map published');
});

test('segmentsLanded: one segment is judged as a window; none is a clear', () => {
    assert.equal(segmentsLanded(clip({ loopStart: 100, loopEnd: 600 }), [100, 600]), true);
    assert.equal(segmentsLanded(clip({ loopStart: 100, loopEnd: 500 }), [100, 600]), false);
    assert.equal(segmentsLanded(clip({ loopStart: 100, loopEnd: 600 }), []), true,
        'a single window may stand after a clear of the cuts');
    assert.equal(segmentsLanded(clip({ segments: [0, 200, 400, 600] }), []), false,
        'the multi-segment map is still there');
});

test('timingLanded: the cumulative shift, and the top only when one was sent', () => {
    assert.equal(timingLanded(clip({ retime: 250 }), { retime: 250, top: null }), true);
    assert.equal(timingLanded(clip({ retime: 250 + TOL }), { retime: 250, top: null }), true);
    assert.equal(timingLanded(clip({ retime: 250 + TOL + 1 }), { retime: 250, top: null }), false);
    assert.equal(timingLanded(clip({ retime: 250, loopTop: 400 }), { retime: 250, top: 400 }), true);
    assert.equal(timingLanded(clip({ retime: 250, loopTop: 100 }), { retime: 250, top: 400 }), false);
    assert.equal(timingLanded(clip({ retime: 250 }), { retime: 250, top: 400 }), false,
        'no top published');
});

/* ---------- the queued verdict ---------- */

/**
 * A verdict over a fake engine holding one clip. `engine.apply` decides
 * what a commit does to the graph (the default applies it; a refusal
 * leaves it). Timers are mocked: `settle()` passes the debounce and
 * lets the verdict's read finish.
 */
function harness(t, node = clip()) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const engine = {
        state: { id: 'root', definerId: '', nodes: [node] },
        refuse: false,
        lost: false,
        calls: [],
    };
    const lines = [];
    const view = { gestureLive: false, previewsCleared: 0 };
    const find = id => engine.state.nodes.find(n => n.id === id);
    const verbs = {
        setLoopPoints: (id, s, e) => Object.assign(find(id), { loopStart: s, loopEnd: e }),
        setSegments: (id, flat) => { find(id).segments = flat.slice(); },
        setTiming: (id, shift, top) => {
            const n = find(id);
            n.retime += Math.round(shift);
            if (top !== null) n.loopTop = top;
        },
        setDefiner: id => { engine.state.definerId = id; },
        cancelGesture: () => {},
    };
    const io = createShellIo({
        callNative: async (name, ...args) => {
            engine.calls.push([name, ...args]);
            if (engine.refuse) return false;
            if (verbs[name]) verbs[name](...args);
            return true;
        },
        getState: () => (engine.lost ? null : engine.state),
        setLogLine: m => lines.push(m),
    });
    const verdict = createEditVerdict({
        io,
        isGestureLive: () => view.gestureLive,
        clearPendingEdits: () => { view.previewsCleared++; },
    });
    notePoll(engine.state, indexNodes(engine.state.nodes));
    const settle = async (ms = VERDICT_DEBOUNCE_MS) => {
        t.mock.timers.tick(ms);
        await new Promise(resolve => setImmediate(resolve));
    };
    return { verdict, engine, lines, view, settle };
}

test('a landed window says so, with its undo hint', async t => {
    const { verdict, engine, lines, settle } = harness(t);
    await verdict.onSetWindow('a', 100, 600);
    assert.deepEqual(engine.calls, [['setLoopPoints', 'a', 100, 600, false]]);
    assert.deepEqual(lines, [], 'nothing is said before the debounce');
    await settle();
    assert.deepEqual(lines, ['Loop window set — ⌘Z to undo']);
});

test('a refused window says the engine refused', async t => {
    const { verdict, engine, lines, settle } = harness(t);
    engine.refuse = true;
    await verdict.onSetWindow('a', 100, 600);
    await settle();
    assert.deepEqual(lines, ['Loop window refused by the engine — geometry unchanged']);
});

test('a stream of live commits gets one verdict, on the state it ends on', async t => {
    const { verdict, engine, lines, settle } = harness(t);
    await verdict.onSetWindow('a', 100, 500);
    await settle(VERDICT_DEBOUNCE_MS - 1);
    await verdict.onSetWindow('a', 100, 550, true);
    await settle(VERDICT_DEBOUNCE_MS - 1);
    engine.refuse = true;  // the last commit of the drag is refused
    await verdict.onSetWindow('a', 100, 600, true);
    assert.deepEqual(lines, []);
    await settle();
    assert.deepEqual(lines, ['Loop window refused by the engine — geometry unchanged']);
    assert.equal(engine.calls[2][4], true, 'live rides through to the bridge');
});

test('no verdict when the read is lost or the node is gone', async t => {
    const { verdict, engine, lines, settle } = harness(t);
    await verdict.onSetWindow('a', 100, 600);
    engine.lost = true;
    await settle();
    engine.lost = false;
    await verdict.onSetWindow('a', 100, 600);
    engine.state.nodes = [];
    await settle();
    assert.deepEqual(lines, []);
});

test('a map commit is judged by segmentsLanded', async t => {
    const { verdict, engine, lines, settle } = harness(t);
    await verdict.onSetSegments('a', [0, 200, 400, 600]);
    await settle();
    engine.refuse = true;
    await verdict.onSetSegments('a', [0, 100, 400, 600]);
    await settle();
    assert.deepEqual(lines, ['Map updated — ⌘Z to undo',
                             'Map refused by the engine — unchanged']);
});

test('re-time: the verdict is the polled re-time plus every shift sent since', async t => {
    const { verdict, engine, lines, settle } = harness(t, clip({ retime: 100 }));
    await verdict.onSetTiming('a', 10);
    await verdict.onSetTiming('a', 5.4, null, true);
    assert.equal(engine.state.nodes[0].retime, 115);
    await settle();
    assert.deepEqual(lines, ['Timing shifted — ⌘Z to undo']);

    // The verdict closes the account: the next gesture is measured
    // from what the poll shows then (here, after an undo).
    engine.state.nodes[0].retime = 0;
    await verdict.onSetTiming('a', 7);
    await settle();
    assert.deepEqual(lines.slice(1), ['Timing shifted — ⌘Z to undo']);
});

test('re-time: one refused shift in the stream is a refusal', async t => {
    const { verdict, engine, lines, settle } = harness(t, clip({ retime: 100 }));
    await verdict.onSetTiming('a', 10);
    engine.refuse = true;
    await verdict.onSetTiming('a', 5, null, true);
    await settle();
    assert.deepEqual(lines, ['Re-time refused by the engine — timing unchanged']);
});

test('re-time: a top sent earlier in the stream is still owed at the verdict', async t => {
    const { verdict, engine, lines, settle } = harness(t);
    await verdict.onSetTiming('a', 40, 300);
    await verdict.onSetTiming('a', 2, null, true);
    engine.state.nodes[0].loopTop = 0;  // the engine dropped the top
    await settle();
    assert.deepEqual(lines, ['Re-time refused by the engine — timing unchanged']);
});

test('undo / redo: the queued verdict and the gesture previews go with the keystroke', async t => {
    const { verdict, lines, view, settle } = harness(t);
    await verdict.onSetWindow('a', 100, 600);
    await verdict.onSetTiming('a', 10);
    verdict.dropStale();
    await settle();
    assert.deepEqual(lines, [], 'no verdict about a graph the undo replaced');
    assert.equal(view.previewsCleared, 1);
});

test('undo / redo under a live drag keeps the drag\'s preview', async t => {
    const { verdict, view } = harness(t);
    view.gestureLive = true;
    verdict.dropStale();
    assert.equal(view.previewsCleared, 0);
});

test('a cancelled drag drops its verdict — the one queued while the cancel was out too', async t => {
    const { verdict, engine, lines, settle } = harness(t);
    await verdict.onSetWindow('a', 100, 600, true);
    const live = verdict.onSetWindow('a', 100, 650, true);  // still in flight
    await verdict.onCancelGesture('a');
    await live;
    assert.deepEqual(engine.calls.map(c => c[0]),
        ['setLoopPoints', 'setLoopPoints', 'cancelGesture']);
    await settle();
    assert.deepEqual(lines, ['Cancelled — nothing changed']);
});

test('a cancel the engine refuses says what the drag did stands, and why under a live take', async t => {
    const { verdict, engine, lines } = harness(t);
    engine.refuse = true;
    await verdict.onCancelGesture('a');
    assert.deepEqual(lines, ['Not cancelled — what the drag did stands (⌘Z undoes it)']);

    engine.state.nodes[0].isRecording = true;
    await verdict.onCancelGesture('a');
    assert.equal(lines[1],
        'Not cancelled — a take is live; what the drag did stands (⌘Z after the take)');
    engine.state.nodes[0].isRecording = false;
});

test('handing Q over: the engine\'s answer is the verdict, named for the track', async t => {
    const { verdict, engine, lines } = harness(t);
    assert.equal(await verdict.onSetDefiner('a'), true);
    assert.match(lines[0], /^"Bass" sets Q now/);
    engine.refuse = true;
    assert.equal(await verdict.onSetDefiner('a'), false);
    assert.equal(lines[1], 'Q not handed over — the engine refused');
    engine.state.nodes[0].isRecording = true;
    await verdict.onSetDefiner('a');
    assert.equal(lines[2], 'Q not handed over — a take is live');
    engine.state.nodes[0].isRecording = false;
});

test('the commit trace: silent without a sink; with one, commits and moved windows', async t => {
    const { verdict: quiet, engine } = harness(t);
    quiet.noteGraph(indexNodes(engine.state.nodes));  // must not throw without a sink

    const traced = [];
    const io = createShellIo({
        callNative: async () => true, getState: () => engine.state, setLogLine: () => {} });
    const verdict = createEditVerdict({
        io, isGestureLive: () => false, clearPendingEdits: () => {},
        trace: m => traced.push(m) });
    const node = clip({ loopStart: 0, loopEnd: 500 });
    verdict.noteGraph(indexNodes([node]));
    assert.deepEqual(traced, [], 'the first sighting is the baseline');
    verdict.noteGraph(indexNodes([node]));
    assert.deepEqual(traced, [], 'a window that stands is not logged');
    node.loopEnd = 600;
    verdict.noteGraph(indexNodes([node]));
    assert.deepEqual(traced, ['[trace] observed id=a 0..600 len=600']);
    await verdict.onSetWindow('a', 0, 700, true);
    assert.match(traced[1], /^\[trace\] setWindow {3}id=a 0\.\.700 len=700 live=1 from=/);
});
