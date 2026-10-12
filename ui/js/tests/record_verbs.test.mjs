/**
 * record_verbs.js — a lane's ● as a decision table (stop / record /
 * new take / nothing), the bridge call and status line each row makes,
 * R's choice of lane, and Space's queued pause.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { armDecision, armRefusal, createRecordVerbs } from '../record_verbs.js';
import { createShellIo, NO_ANSWER } from '../shell_io.js';
import { notePoll, indexNodes } from '../session_facts.js';
import { notePlayStartTransport } from '../play_start.js';
import * as facts from '../session_facts.js';

const empty = (id, extra = {}) => ({ id, type: 'clip', duration: 0, ...extra });
const full = (id, extra = {}) => ({ id, type: 'clip', duration: 48000, ...extra });
const hot = (id, extra = {}) => full(id, { isRecording: true, ...extra });
const oneShot = id => full(id, { periodSource: 'context' });
const group = (id, nodes) => ({ id, type: 'stack', nodes });

/** The verbs over a recorded bridge, on a polled graph. `answers` maps
 * a method to its answer (default true). */
function harness(nodes, { retakes = [], answers = {}, isPlaying = false } = {}) {
    const calls = [];
    const lines = [];
    const state = { id: 'root', nodes, isPlaying };
    notePoll(state, indexNodes(nodes));
    const io = createShellIo({
        callNative: async (name, ...args) => {
            calls.push([name, ...args]);
            const a = answers[name];
            if (a === undefined && name === 'getGraphState') return state;
            return typeof a === 'function' ? a(...args) : (a === undefined ? true : a);
        },
        setLogLine: m => lines.push(m),
    });
    const verbs = createRecordVerbs({
        io, isRetake: id => retakes.includes(id), projectId: () => 'proj' });
    /** A later poll: the graph as it is now. */
    const repoll = next => {
        state.nodes = next;
        notePoll(state, indexNodes(next));
    };
    return { verbs, calls, lines, state, repoll };
}

/* ---------- the decision table ---------- */

const ids = d => d.clips.map(c => c.id);

test('armDecision: anything hot beneath → stop, whatever else is there', () => {
    const d = armDecision(group('g', [empty('a'), hot('b'), full('c')]));
    assert.equal(d.verb, 'stop');
    assert.deepEqual(ids(d), ['b']);
    assert.equal(armDecision(empty('a', { isPendingStart: true })).verb, 'stop',
        'armed and waiting counts');
});

test('armDecision: an empty clip → record; a group records its empty tracks at any depth', () => {
    assert.deepEqual(armDecision(empty('a')), { verb: 'record', clips: [empty('a')] });
    const d = armDecision(group('g', [empty('a'), full('b'), group('h', [empty('c')])]));
    assert.equal(d.verb, 'record');
    assert.deepEqual(ids(d), ['a', 'c'], 'the full one just plays');
});

test('armDecision: nothing empty → a new take of the committed slot', () => {
    const d = armDecision(full('a'));
    assert.equal(d.verb, 'newTake');
    assert.deepEqual(ids(d), ['a']);
});

test('armDecision: a group\'s new take is of its committed DIRECT clips', () => {
    const d = armDecision(group('g', [full('a'), oneShot('b'), group('h', [full('c')])]));
    assert.equal(d.verb, 'newTake');
    assert.deepEqual(ids(d), ['a'], 'not the one-shot, not the nested group\'s clip');
});

test('armDecision: nothing to record — a committed one-shot, an empty group, a group of one-shots', () => {
    assert.equal(armDecision(oneShot('a')).verb, 'none');
    assert.equal(armDecision(group('g', [])).verb, 'none');
    assert.equal(armDecision(group('g', [oneShot('a'), group('h', [full('c')])])).verb, 'none');
});

/* ---------- ● ---------- */

test('●: each row is one bridge call on the lane\'s own id', async () => {
    const cases = [
        [[empty('a')], 'a', 'startRecordingInNode', 'Recording'],
        [[empty('a', { contentKind: 'midi' })], 'a', 'startRecordingInNode',
            'Recording MIDI — play your keyboard'],
        [[group('g', [empty('a'), empty('b'), full('c')])], 'g', 'startRecordingInNode',
            'Recording 2 empty tracks (full ones just play)'],
        [[full('a')], 'a', 'newTake',
            'New take — one period from the slot top (● again cancels)'],
        [[group('g', [full('a'), full('b')])], 'g', 'newTake',
            'New take of 2 tracks from the group top (● again cancels)'],
        [[group('g', [empty('a'), hot('b')])], 'g', 'stopRecordingInNode', 'Stopped recording'],
    ];
    for (const [nodes, id, method, said] of cases) {
        const { verbs, calls, lines } = harness(nodes);
        await verbs.onArm({ id });
        assert.deepEqual(calls, [[method, id]], said);
        assert.deepEqual(lines, [said]);
    }
});

test('●: stopping a new take says the previous take sounds again', async () => {
    const { verbs, calls, lines } = harness([hot('a')], { retakes: ['a'] });
    await verbs.onArm({ id: 'a' });
    assert.deepEqual(calls, [['stopRecordingInNode', 'a']]);
    assert.deepEqual(lines, ['New take cancelled — the previous take sounds again']);
});

test('●: nothing to record makes no bridge call; an unknown lane does nothing', async () => {
    const { verbs, calls, lines } = harness([oneShot('a')]);
    await verbs.onArm({ id: 'a' });
    await verbs.onArm({ id: 'gone' });
    assert.deepEqual(calls, []);
    assert.deepEqual(lines, ['Nothing to record — loop a one-shot (↺) to take it again']);
});

/* ---------- R ---------- */

test('R: with a take live anywhere, it stops everything on the root — whatever is selected', async () => {
    const { verbs, calls, lines } = harness([empty('a'), group('g', [hot('b')])]);
    await verbs.onRecordKey('a');
    assert.deepEqual(calls, [['stopRecordingInNode', 'root']]);
    assert.deepEqual(lines, ['Stopped recording']);
});

test('a stop with no root to call claims nothing', async () => {
    const { verbs, calls, lines } = harness([hot('a')]);
    notePoll({ nodes: [hot('a')] }, indexNodes([hot('a')]));  // a state with no id
    await verbs.onRecordKey('a');
    await verbs.onSpace();
    assert.deepEqual(calls, []);
    assert.deepEqual(lines, [], 'nothing was stopped, so nothing says so');
});

test('R: records the selected lane; a stale selection falls through', async () => {
    const { verbs, calls } = harness([empty('a'), empty('b')]);
    await verbs.onRecordKey('b');
    assert.deepEqual(calls, [['startRecordingInNode', 'b']]);

    const two = harness([empty('a'), empty('b')]);
    await two.verbs.onRecordKey('deleted');
    assert.deepEqual(two.calls, []);
    assert.deepEqual(two.lines, ['Select a track to record (R)']);
});

test('R: no selection and exactly one top-level lane → that lane', async () => {
    const { verbs, calls } = harness([group('g', [empty('a'), empty('b')])]);
    await verbs.onRecordKey(null);
    assert.deepEqual(calls, [['startRecordingInNode', 'g']],
        'the group is the one top-level lane, though it holds two tracks');
});

test('R: on an empty project it creates the default track and arms the track the engine answered', async () => {
    const made = empty('fresh');
    const { verbs, calls, lines } = harness([], { answers: {
        createNode: 'fresh',
        getGraphState: () => ({ id: 'root', nodes: [made] }) } });
    await verbs.onRecordKey(null);
    assert.deepEqual(calls, [
        ['createNode', 'clip', ''],
        ['getGraphState'],
        ['startRecordingInNode', 'fresh'],
    ]);
    assert.deepEqual(lines, ['Recording']);
    assert.equal(facts.lastNodesById.get('fresh'), made, 'the new graph is indexed at once');
});

test('R: on an empty project, a track the engine did not make — or a lost read after it — arms nothing and says so', async () => {
    const refused = harness([], { answers: { createNode: '' } });
    await refused.verbs.onRecordKey(null);
    assert.deepEqual(refused.calls.map(c => c[0]), ['createNode']);
    assert.deepEqual(refused.lines, ['No track to record on — the engine made none']);

    const lost = harness([], { answers: { createNode: 'fresh', getGraphState: null } });
    await lost.verbs.onRecordKey(null);
    assert.deepEqual(lost.calls.map(c => c[0]), ['createNode', 'getGraphState']);
    assert.deepEqual(lost.lines, [NO_ANSWER]);
});

/* ---------- what the engine refused ---------- */

test('●: an arm the engine refuses never says "Recording" — it says why, as far as the poll shows', async () => {
    // Another lane's take went live: one take at a time.
    const second = harness([empty('a'), hot('b')], { answers: { startRecordingInNode: false } });
    await second.verbs.onArm({ id: 'a' });
    assert.deepEqual(second.calls, [['startRecordingInNode', 'a'], ['getGraphState']],
        'asked once; the reason is read from the graph as it is then');
    assert.deepEqual(second.lines,
        ['Not recording — a take is already live (one take at a time)']);

    // The poll that offered the arm showed no take: one began since.
    const raced = harness([empty('a'), empty('b')], { answers: { startRecordingInNode: false } });
    raced.state.nodes = [empty('a'), hot('b')];
    await raced.verbs.onArm({ id: 'a' });
    assert.deepEqual(raced.lines,
        ['Not recording — a take is already live (one take at a time)']);

    // A loop window above the track could not place the take.
    const windowed = harness(
        [group('g', [empty('a')])].map(g => ({ ...g, name: 'Drums', windowActive: true })),
        { answers: { startRecordingInNode: false } });
    await windowed.verbs.onArm({ id: 'a' });
    assert.match(windowed.lines[0], /^Not recording — a loop window above it .*"Drums"/);

    const bare = harness([empty('a')], { answers: { startRecordingInNode: false } });
    await bare.verbs.onArm({ id: 'a' });
    assert.deepEqual(bare.lines, ['Not recording — the engine refused the arm']);
});

test('●: a new take the engine refuses says what stands in its way', async () => {
    const enclosed = harness(
        [{ ...group('g', [full('a')]), name: 'Verse', windowActive: true }],
        { answers: { newTake: false } });
    await enclosed.verbs.onArm({ id: 'a' });
    assert.deepEqual(enclosed.lines,
        ['No new take — the loop window on "Verse" encloses the slot — bypass it first']);

    const fullSlot = harness([full('a', { takes: 32 })], { answers: { newTake: false } });
    await fullSlot.verbs.onArm({ id: 'a' });
    assert.deepEqual(fullSlot.lines, ['No new take — the slot holds the most takes it can']);

    harness([full('a')]);  // a slot the poll shows nothing wrong with
    assert.equal(armRefusal('newTake', [full('a')]), 'the engine refused the arm');
});

test('●: a stop that found nothing to stop says the take had ended', async () => {
    const { verbs, lines } = harness([hot('a')], { answers: { stopRecordingInNode: false } });
    await verbs.onArm({ id: 'a' });
    assert.deepEqual(lines, ['Nothing was recording there — the take had already ended']);
});

/* ---------- Space ---------- */

test('Space with no take live is the transport toggle', async () => {
    const { verbs, calls } = harness([full('a')]);
    await verbs.onSpace();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [['togglePlayback']]);
});

test('Space under a live take stops it and queues the pause; a second Space changes nothing', async () => {
    const { verbs, calls, lines, state, repoll } = harness([hot('a')], { isPlaying: true });
    await verbs.onSpace();
    assert.deepEqual(calls, [['stopRecordingInNode', 'root']]);
    assert.deepEqual(lines, ['Stopping recording at the boundary, then pausing']);

    await verbs.onSpace();  // the take is still finishing
    verbs.settlePendingPause(state);
    assert.equal(calls.length, 1, 'no second stop, no pause under a live take');

    repoll([full('a')]);    // the take landed
    verbs.settlePendingPause(state);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.map(c => c[0]), ['stopRecordingInNode', 'togglePlayback']);
    assert.equal(lines.at(-1), 'Recording stopped — paused');

    verbs.settlePendingPause(state);  // the pause is spent
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
});

test('Space: a pause the engine refuses — a take went live since the poll — says so, and Space still asks to pause', async () => {
    const { verbs, calls, lines } = harness([full('a')], {
        answers: { togglePlayback: false } });
    notePlayStartTransport(true, false);  // the last poll: playing, no frame
    await verbs.onSpace();
    assert.deepEqual(calls, [['togglePlayback']]);
    assert.deepEqual(lines, ['Still playing — a take is live (Space again stops it)']);

    // Nothing here believed the pause: the next press asks for it again
    // rather than for a play.
    await verbs.onSpace();
    assert.deepEqual(calls, [['togglePlayback'], ['togglePlayback']]);
    notePlayStartTransport(false, false);
});

test('the queued pause the engine still refuses says so and lands at a later poll', async () => {
    let refusals = 1;
    const { verbs, calls, lines, state, repoll } = harness([hot('a')], {
        isPlaying: true,
        answers: { togglePlayback: () => refusals-- <= 0 } });
    notePlayStartTransport(true, false);
    await verbs.onSpace();
    repoll([full('a')]);    // the poll shows the take landed; the engine counts it a moment longer
    verbs.settlePendingPause(state);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lines.at(-1), 'The take is still landing — pausing as soon as it has');

    verbs.settlePendingPause(state);  // the next poll
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.map(c => c[0]),
        ['stopRecordingInNode', 'togglePlayback', 'togglePlayback']);
    assert.equal(lines.at(-1), 'Recording stopped — paused');
    notePlayStartTransport(false, false);
});

test('Space under a live take that had already ended still pauses at the next poll', async () => {
    const { verbs, calls, lines, state, repoll } = harness([hot('a')], {
        isPlaying: true, answers: { stopRecordingInNode: false } });
    notePlayStartTransport(true, false);
    await verbs.onSpace();
    assert.deepEqual(lines, ['Nothing was recording — the take had already ended']);
    repoll([full('a')]);
    verbs.settlePendingPause(state);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.map(c => c[0]), ['stopRecordingInNode', 'togglePlayback']);
    assert.equal(lines.at(-1), 'Recording stopped — paused');
    notePlayStartTransport(false, false);
});

test('the queued pause is dropped when the transport is already stopped', async () => {
    const { verbs, calls, lines, state, repoll } = harness([hot('a')], { isPlaying: true });
    await verbs.onSpace();
    repoll([full('a')]);
    state.isPlaying = false;
    verbs.settlePendingPause(state);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1, 'nothing to pause');
    assert.equal(lines.length, 1);
    state.isPlaying = true;
    verbs.settlePendingPause(state);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1, 'and it does not pause a later play');
});
