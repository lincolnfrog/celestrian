/**
 * The mock's OWN mechanisms — what stands in for the engine's audio
 * thread and its edit log, and so cannot be read off the engine:
 *   - the clock: a poll is the audio callback; a test steps the clock;
 *   - the undo log: whole-graph snapshots made to behave as inverse
 *     edits (an unchanged graph records nothing; a restore keeps the
 *     knobs; a take's step is built when it settles; a seek re-frames).
 * What the mock PUBLISHES for a verb sequence is held to the engine by
 * the differential suite (ui/differential/), not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    advanceBy, callNative, getState, readState, loadScenario, stepClock,
} from '../mock_backend.js';
import { nodeById, recordTake } from './helpers.mjs';

const node = id => nodeById(id, readState().nodes);
const clock = () => { const s = readState(); return s.islandPos + s.islandZero; };

test('an arm starts the transport; a stepped clock leaves time to the test', async () => {
    loadScenario('empty');
    const a = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', a);
    assert.equal(readState().isPlaying, true, 'the arm started the transport');
    const at = clock();
    getState();
    getState();
    assert.equal(clock(), at, 'stepped: a poll moves no time');
    advanceBy(700);
    assert.equal(clock(), at + 700);
    await callNative('stopRecordingInNode', a);

    // Handed back to the polls, an arm from stopped runs the clock.
    loadScenario('empty');
    stepClock(false);
    try {
        const b = await callNative('createNode', 'clip', '');
        await callNative('startRecordingInNode', b);
        const before = clock();
        getState();
        assert.ok(clock() > before, 'a poll ticks the clock');
    } finally {
        stepClock(true);
    }
});

test('a poll is the audio callback: a capturing new take\'s cancel lands there', async () => {
    loadScenario('empty');
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    await callNative('newTake', a);           // on its slot top: capturing
    advanceBy(300);
    assert.equal(node(a).isRecording, true);
    await callNative('stopRecordingInNode', a);
    assert.equal(node(a).isRecording, true, 'a read lets no time pass: still up');
    assert.equal(await callNative('undo'), false, 'and the live-take gate still holds');
    getState();                               // the callback runs
    assert.equal(node(a).isRecording, false, 'cancelled');
    assert.equal(node(a).takes, 1, 'the slot as it stood');
});

test('a poll is the audio callback: a first take\'s stop lands there, at the length it had', async () => {
    loadScenario('empty');
    const a = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', a);
    advanceBy(700);
    assert.equal(await callNative('stopRecordingInNode', a), true);
    assert.deepEqual([node(a).isRecording, node(a).isAwaitingStop], [true, true],
        'asked, not ended: the take is the audio callback\'s to end');
    assert.equal(readState().quantum, 0, 'no Q yet');
    assert.equal(await callNative('undo'), false, 'the live-take gate still holds');
    const at = clock();
    getState();                               // the callback runs, over no samples
    assert.equal(clock(), at, 'stepped: landing it moved no time');
    assert.deepEqual([node(a).isRecording, node(a).isAwaitingStop, node(a).duration],
        [false, false, 700]);
    assert.equal(readState().quantum, 700, 'the take is Q');
    assert.equal(readState().canUndo, true, 'and it settled into the log');

    // On a running clock the callback that lands it captures none of
    // its own samples: the take is as long as it was when asked.
    loadScenario('empty');
    const b = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', b);
    advanceBy(700);
    await callNative('stopRecordingInNode', b);
    advanceBy(512);
    assert.equal(node(b).duration, 700);
    assert.equal(clock() - node(b).origin, 700 + 512, 'the clock ran on');
});

test('a first-take group stops as one: every member ends at the same callback, at one length', async () => {
    loadScenario('empty');
    const g = await callNative('createNode', 'stack', '');
    const mics = [];
    for (let i = 0; i < 3; i++) mics.push(await callNative('createNode', 'clip', g));
    await callNative('startRecordingInNode', g);
    advanceBy(900);
    await callNative('stopRecordingInNode', g);
    assert.ok(mics.every(m => node(m).isRecording), 'asked: every member still up');
    advanceBy(0);
    assert.deepEqual(mics.map(m => node(m).duration), [900, 900, 900]);
    assert.deepEqual(mics.map(m => [node(m).loopStart, node(m).loopEnd]),
        [[0, 0], [0, 0], [0, 0]], 'whole: no member was padded to another\'s Q');
    assert.equal(readState().quantum, 900);
    await callNative('undo');
    assert.deepEqual(mics.map(m => node(m).duration), [0, 0, 0], 'one undo step');
});

test('an unchanged graph records nothing, whatever the verb', async () => {
    loadScenario('stack-with-clips');
    await callNative('renameNode', 'clip-1', 'bass');
    await callNative('undo');
    const log = () => { const s = readState(); return [s.canUndo, s.canRedo]; };
    assert.deepEqual(log(), [false, true]);
    const eq = node('clip-1').effects.chain.find(s => s.type === 'eq').slot;
    const nothings = [
        ['renameNode', 'clip-1', 'Clip A'],            // the name it has
        ['renameNode', 'no-such-node', 'x'],
        ['setNodeInput', 'clip-1', 0],                 // the input it has
        ['setNodeInput', 'stack-1', 1],                // a stack records nothing
        ['reorderNode', 'clip-1', 'stack-1', 0],       // the slot it is in
        ['reorderNode', 'clip-1', '', 0],              // no destination
        ['moveChainSlot', 'clip-1', eq, 0],
        ['removeChainSlot', 'clip-1', eq],             // a built-in stays
        ['addPluginToChain', 'clip-1', 'no-such-plugin'],
        ['setSequence', 'stack-1', null],              // no song to clear
        ['setLoopPoints', 'clip-1', 0, 0],
        ['setPeriodSource', 'clip-1', 'own'],
        ['setComp', 'clip-1', []],
        ['createNode', 'clip', 'no-such-parent'],
    ];
    for (const [verb, ...args] of nothings) {
        await callNative(verb, ...args);
        assert.deepEqual(log(), [false, true], `${verb}(${args.join(', ')})`);
    }
});

test('undo keeps the knobs: mixer, monitoring and slot settings are not logged', async () => {
    loadScenario('stack-with-clips');
    const eq = node('clip-1').effects.chain.find(s => s.type === 'eq').slot;
    await callNative('renameNode', 'clip-1', 'bass');
    await callNative('setNodePan', 'clip-1', -1);
    await callNative('setNodeGain', 'clip-1', 0.5);
    await callNative('toggleSolo', 'clip-1');
    await callNative('setMonitor', 'clip-1', true);
    await callNative('setSlotEnabled', 'clip-1', eq, true);
    await callNative('setSlotParam', 'clip-1', eq, 'low', 300);   // clamps to its range
    await callNative('setNodeGain', readState().id, 0.25);        // the master fader
    assert.equal(await callNative('undo'), true);
    const c = node('clip-1');
    assert.equal(c.name, 'Clip A', 'the rename is undone');
    assert.deepEqual([c.pan, c.gain, c.isSoloed, c.monitor], [-1, 0.5, true, true]);
    const slot = c.effects.chain.find(s => s.slot === eq);
    assert.deepEqual([slot.enabled, slot.low], [true, 12]);
    assert.equal(readState().gain, 0.25);
});

test('a take\'s undo removes the take and leaves the edits made under it', async () => {
    loadScenario('empty');
    const a = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', a);
    advanceBy(400);
    await callNative('renameNode', a, 'mid-take');
    await callNative('toggleMute', a);
    const b = await callNative('createNode', 'clip', '');
    advanceBy(600);
    await callNative('stopRecordingInNode', a);
    advanceBy(0);                             // the callback that ends it
    assert.equal(node(a).duration, 1000);

    await callNative('undo');                 // the take, and only the take
    assert.equal(node(a).duration, 0);
    assert.equal(readState().quantum, 0, 'Q goes with the first take');
    assert.deepEqual([node(a).name, node(a).isMuted, !!node(b)], ['mid-take', true, true]);
    await callNative('undo');                 // the track made under it
    assert.equal(node(b), null);
    await callNative('redo');
    await callNative('redo');
    assert.equal(node(a).duration, 1000, 'redo brings the take back');
    assert.equal(readState().quantum, 1000);
});

test('a seek re-frames the history: undo does not undo the seek', async () => {
    loadScenario('empty');
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    await callNative('toggleMute', a);
    await callNative('togglePlayback');       // the recipe left it playing: stop
    const applied = await callNative('seekTransport', 250);
    assert.equal(applied.advance, 250);
    const placed = () => node(a).origin - readState().islandZero;
    const pos = readState().islandPos;
    await callNative('undo');
    assert.equal(node(a).isMuted, false, 'the mute is undone');
    assert.equal(readState().islandPos, pos, 'the seek stands');
    assert.equal(placed(), 0, 'and the take still sits on the zero');
});
