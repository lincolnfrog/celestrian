/**
 * lane_verbs.js — a lane's own controls and undo / redo: the one bridge
 * call each makes, the line it says when the engine applied it, the line
 * it says when the engine refused it (with the reason where the last
 * poll shows one), and the calls it does NOT make: an edit that would
 * change nothing is never sent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLaneVerbs, sameSong } from '../lane_verbs.js';
import { createShellIo, NO_ANSWER } from '../shell_io.js';
import { notePoll, noteView, indexNodes } from '../session_facts.js';

const SONG = { steps: [{ name: 'A', len: 1000 }, { name: 'B', len: 2000, cue: true }],
               gates: { a: [true, false] }, seed: 7 };

const track = (extra = {}) => ({
    id: 'a', type: 'clip', name: 'Bass', periodSource: 'own', takes: 2, activeTake: 1,
    comp: [], inputChannel: 0, inputChannelR: -1, ...extra });

/**
 * The verbs over a bridge that answers `answer` to every verb (true:
 * applied; false: refused; null: lost), on a polled graph of `nodes`.
 * `calls` are the verbs sent; a state read answers `engine.state` — the
 * graph NOW, the polled one unless a test moves it on.
 */
function harness({ nodes = [track()], answer = true, state = {} } = {}) {
    const calls = [];
    const lines = [];
    const dropped = { stale: 0 };
    const polled = { id: 'root', nodes, canUndo: true, canRedo: true, ...state };
    const engine = { state: polled };
    notePoll(polled, indexNodes(nodes));
    noteView({}, null);
    const io = createShellIo({
        callNative: async (name, ...args) => {
            if (name === 'getGraphState') return engine.state;
            calls.push([name, ...args]);
            return typeof answer === 'function' ? answer(name, ...args) : answer;
        },
        setLogLine: m => lines.push(m),
    });
    const lane = createLaneVerbs({ io, dropStaleEdits: () => { dropped.stale++; } });
    return { lane, calls, lines, dropped, polled, engine };
}

const live = { id: 'hot', type: 'clip', name: 'Vox', isRecording: true };

/** One verb, three answers: applied, refused with no take live, refused
 * under a live take. `[run, call, okLine, refusedLine, refusedLiveLine]`. */
const CASES = [
    [l => l.onDelete('a'), ['deleteNode', 'a'],
        'Deleted — ⌘Z to undo', 'Delete refused — nothing changed',
        'Delete refused — a take is live'],
    [l => l.onSetPeriodSource('a', 'context'), ['setPeriodSource', 'a', 'context'],
        'One-shot: sounds once per cycle (⌘Z to undo)',
        'Still a loop — it holds all that is recorded, and something must set the cycle',
        'Still a loop — a take is live'],
    [l => l.onSelectTake('a', 0), ['selectTake', 'a', 0],
        'Take 1 sounds (⌘Z to undo)', 'Take 1 not selected — nothing changed',
        'Take 1 not selected — a take is live'],
    [l => l.onDeleteTake('a', 1), ['deleteTake', 'a', 1],
        'Take 2 removed (⌘Z to undo)', 'Take 2 not removed — nothing changed',
        'Take 2 not removed — a take is live'],
    [l => l.onSetComp('a', [0]), ['setComp', 'a', [0]],
        'Comp updated (⌘Z to undo)', 'Comp not changed — the engine refused it',
        'Comp not changed — a take is live'],
    [l => l.onSetSequence('g', SONG), ['setSequence', 'g', SONG],
        'sequence updated (⌘Z to undo)', 'Song not changed — the engine refused it',
        'Song not changed — a take is live'],
    [l => l.onAuditionStep('root', 1), ['auditionStep', 'root', 1],
        'looping step 2 — R records into it · Esc stops',
        'Step 2 is not looping — the song never reaches it (or is bypassed)',
        'Step 2 is not looping — a take is live'],
];

test('each lane verb is one call, and its line is the engine\'s answer: done, refused, or refused because a take is live', async () => {
    for (const [run, call, done, refused, refusedLive] of CASES) {
        const applied = harness();
        await run(applied.lane);
        assert.deepEqual(applied.calls, [call]);
        assert.deepEqual(applied.lines, [done]);

        const no = harness({ answer: false });
        await run(no.lane);
        assert.deepEqual(no.calls, [call], 'asked once, not again');
        assert.deepEqual(no.lines, [refused]);

        const underTake = harness({ nodes: [track(), live], answer: false });
        await run(underTake.lane);
        assert.deepEqual(underTake.lines, [refusedLive]);

        const lost = harness({ answer: null });
        await run(lost.lane);
        assert.deepEqual(lost.lines, [NO_ANSWER], 'a lost call is not a refusal');
    }
});

test('a refusal\'s reason is read from the graph as it is then, not from the last poll', async () => {
    // The poll showed no take; one went live before the verb reached the engine.
    const began = harness({ answer: false });
    began.engine.state = { ...began.polled, nodes: [track(), live] };
    await began.lane.onDelete('a');
    assert.deepEqual(began.lines, ['Delete refused — a take is live']);

    // The poll showed a take; it had ended, and the engine refused for another reason.
    const ended = harness({ nodes: [track(), live], answer: false });
    ended.engine.state = { ...ended.polled, nodes: [track()] };
    await ended.lane.onDelete('a');
    assert.deepEqual(ended.lines, ['Delete refused — nothing changed']);

    // Undo's flags too: the log emptied since the poll.
    const emptied = harness({ answer: false });
    emptied.engine.state = { ...emptied.polled, canUndo: false };
    await emptied.lane.step('undo');
    assert.deepEqual(emptied.lines, ['Nothing to undo']);

    // A lost read falls back on the poll.
    const lost = harness({ nodes: [track(), live], answer: false });
    lost.engine.state = null;
    await lost.lane.onDelete('a');
    assert.deepEqual(lost.lines, ['Delete refused — a take is live']);
});

test('wiring stays live under a take: a refused rename, input or rack verb never blames the take', async () => {
    const cases = [
        [l => l.onRename('a', 'Kick'), 'Renamed to "Kick"', 'Not renamed — nothing changed'],
        [l => l.onSetInput('a', 2), 'Input set to channel 3', 'Input not changed — only a track has one'],
        [l => l.onSetInputRight('a', 3), 'Stereo pair: right = channel 4',
            'Input not changed — only a track has one'],
        [l => l.onMonitor('a', true), 'Monitoring input through the track',
            'Monitoring not changed — only a track has an input'],
        [l => l.onSetSlotEnabled('a', 's1', true, 'eq'), 'eq on',
            'eq not switched — it is no longer in the rack'],
        [l => l.onAddPlugin('a', 'uid', 'Aurora'), 'Aurora added (⌘Z to undo)',
            'Aurora not added — it could not be loaded (rescan in Plugins)'],
        [l => l.onRemoveChainSlot('a', 's9', 'Aurora'), 'Aurora removed (⌘Z to undo)',
            'Aurora not removed — nothing changed'],
    ];
    for (const [run, done, refused] of cases) {
        const applied = harness({ nodes: [track(), live] });
        await run(applied.lane);
        assert.deepEqual(applied.lines, [done]);
        const no = harness({ nodes: [track(), live], answer: false });
        await run(no.lane);
        assert.deepEqual(no.lines, [refused]);
    }
});

test('an edit that would change nothing is not sent, and nothing is said', async () => {
    const { lane, calls, lines } = harness({
        nodes: [track({ comp: [0, 1] }),
                { id: 'g', type: 'stack', name: 'Drums', sequence: { ...SONG, bypassed: false, program: [0, 1] } }],
    });
    await lane.onRename('a', 'Bass');
    await lane.onSetPeriodSource('a', 'own');
    await lane.onSelectTake('a', 1);
    await lane.onSetComp('a', [0, 1]);
    await lane.onSetInput('a', 0);
    await lane.onSetInputRight('a', -1);
    await lane.onSetSequence('g', { ...SONG, gates: { a: [1, 0] } });  // the song it has
    await lane.onSetSequence('a', null);                                // no song to clear
    assert.deepEqual(calls, []);
    assert.deepEqual(lines, []);
});

test('sameSong: steps, successors, gates and seed — whatever else the published song carries', () => {
    const published = { ...SONG, bypassed: true, program: [0, 1], radio: false, auditionStep: -1 };
    assert.equal(sameSong(SONG, published), true);
    assert.equal(sameSong({ ...SONG, gates: { a: [1, 0] } }, published), true, '0/1 or booleans');
    assert.equal(sameSong({ ...SONG, seed: 8 }, published), false);
    assert.equal(sameSong({ ...SONG, gates: {} }, published), false);
    assert.equal(sameSong({ ...SONG, steps: [SONG.steps[0]] }, published), false);
    const branching = { ...SONG, steps: [{ ...SONG.steps[0], next: [{ to: 1 }] }, SONG.steps[1]] };
    assert.equal(sameSong(branching, published), false);
    assert.equal(sameSong(branching, { ...branching, steps: [
        { ...SONG.steps[0], next: [{ to: 1, w: 1 }] }, SONG.steps[1]] }), true, 'a weight of 1 is the default');
    assert.equal(sameSong(null, undefined), true, 'no song either side');
    assert.equal(sameSong({ steps: [], gates: {} }, null), true, 'an empty payload is a clear');
    assert.equal(sameSong(null, published), false);
});

test('a song on the root carries the frame\'s resting zero; a branching song refused below the top says why', async () => {
    const root = harness({
        state: { sequence: { steps: [{ name: 'Intro', len: 500 }], gates: {} } } });
    noteView({}, { zero: 0, rest: 4800, quantum: 1000 });
    await root.lane.onSetSequence('root', SONG);
    assert.deepEqual(root.calls, [['setSequence', 'root', SONG, 4800]]);
    await root.lane.onSetSequence('root', null);
    assert.deepEqual(root.calls[1], ['setSequence', 'root', null], 'a clear names no zero');
    noteView({}, null);

    const branching = { ...SONG, steps: [{ ...SONG.steps[0], next: [{ to: 0 }] }, SONG.steps[1]] };
    const nested = harness({ answer: false });
    await nested.lane.onSetSequence('g', branching);
    assert.deepEqual(nested.lines,
        ['Song not changed — a song that branches lives on the top level only']);
});

test('the song\'s bypass: toggled, refused, or not there to toggle', async () => {
    const withSong = [{ id: 'g', type: 'stack', name: 'Drums', sequence: { ...SONG } }];
    const applied = harness({ nodes: withSong });
    await applied.lane.onToggleSequenceBypass('g');
    assert.deepEqual(applied.calls, [['toggleSequence', 'g']]);
    assert.deepEqual(applied.lines, ['sequence toggled (⌘Z to undo)']);

    const refused = harness({ nodes: [...withSong, live], answer: false });
    await refused.lane.onToggleSequenceBypass('g');
    assert.deepEqual(refused.lines, ['Song bypass not toggled — a take is live']);

    const songless = harness({ nodes: [{ id: 'g', type: 'stack', name: 'Drums' }] });
    await songless.lane.onToggleSequenceBypass('g');
    assert.deepEqual(songless.calls, [], 'the engine would refuse it');
    assert.deepEqual(songless.lines, ['No song to bypass — add a step first']);

    // The root's song is the state's own.
    const onRoot = harness({ state: { sequence: { ...SONG } } });
    await onRoot.lane.onToggleSequenceBypass('root');
    assert.deepEqual(onRoot.calls, [['toggleSequence', 'root']]);
});

test('the step loop: Escape releases the loop the engine confirmed — and only that one', async () => {
    const { lane, calls, lines } = harness();
    await lane.onEscapeAudition();
    assert.deepEqual(calls, [], 'nothing loops: Escape asks for nothing');

    await lane.onAuditionStep('g', 0);
    await lane.onEscapeAudition();
    assert.deepEqual(calls, [['auditionStep', 'g', 0], ['auditionStep', 'g', -1]]);
    assert.equal(lines.at(-1), 'loop released — the song resumes whole');
    await lane.onEscapeAudition();
    assert.equal(calls.length, 2, 'released: nothing left to release');

    // A loop the engine refused is not a loop Escape owes a release.
    const refused = harness({ answer: false });
    await refused.lane.onAuditionStep('g', 0);
    await refused.lane.onEscapeAudition();
    assert.deepEqual(refused.calls, [['auditionStep', 'g', 0]]);

    // A release refused under a take leaves the loop — and Escape's target.
    let answers = [true, false, true];
    const held = harness({ nodes: [track(), live], answer: () => answers.shift() });
    await held.lane.onAuditionStep('g', 2);
    await held.lane.onEscapeAudition();
    assert.equal(held.lines.at(-1), 'The step keeps looping — a take is live');
    await held.lane.onEscapeAudition();
    assert.deepEqual(held.calls.map(c => c[2]), [2, -1, -1]);
});

test('take list: the last take of a slot says why it stays', async () => {
    const { lane, lines } = harness({ nodes: [track({ takes: 1, activeTake: 0 })], answer: false });
    await lane.onDeleteTake('a', 0);
    assert.deepEqual(lines,
        ["Take 1 not removed — a slot's last take stays (delete the track to remove it)"]);
});

test('undo / redo: the stale previews go with the keystroke; the line says what happened', async () => {
    const done = harness();
    await done.lane.step('undo');
    await done.lane.step('redo');
    assert.deepEqual(done.calls, [['undo'], ['redo']]);
    assert.deepEqual(done.lines, ['Undo', 'Redo']);
    assert.equal(done.dropped.stale, 2);

    const empty = harness({ answer: false, state: { canUndo: false, canRedo: false } });
    await empty.lane.step('undo');
    await empty.lane.step('redo');
    assert.deepEqual(empty.lines, ['Nothing to undo', 'Nothing to redo']);

    const underTake = harness({ nodes: [live], answer: false });
    await underTake.lane.step('undo');
    assert.deepEqual(underTake.lines, ['Undo waits — a take is live']);

    const stale = harness({ answer: false });
    await stale.lane.step('redo');
    assert.deepEqual(stale.lines, ['Redo did not apply — nothing changed']);
});

test('a window\'s bypass chip and a plugin\'s editor: silent when done, a line when not', async () => {
    const done = harness();
    await done.lane.onToggleWindow('a');
    await done.lane.onOpenPluginEditor('a', 's9');
    assert.deepEqual(done.lines, []);

    const idle = harness({ answer: false });
    await idle.lane.onToggleWindow('a');
    assert.deepEqual(idle.lines, [], 'no reason the shell can vouch for');
    await idle.lane.onOpenPluginEditor('a', 's9');
    assert.deepEqual(idle.lines, ['No editor to open — the plugin is missing']);

    const underTake = harness({ nodes: [track(), live], answer: false });
    await underTake.lane.onToggleWindow('a');
    assert.deepEqual(underTake.lines, ['Loop window not toggled — a take is live']);
});
