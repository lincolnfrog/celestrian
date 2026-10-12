/**
 * shell_io.js — what the shell's verb modules are handed: the call that
 * also writes the status line off the engine's answer, and the one state
 * read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createShellIo, NO_ANSWER } from '../shell_io.js';

/** An io over a backend that answers from `answers` (a value, or a
 * function of the args; a method with none is a LOST call: null),
 * recording every call and status line. */
function harness(answers = {}, getState = null) {
    const calls = [];
    const lines = [];
    const io = createShellIo({
        callNative: async (name, ...args) => {
            calls.push([name, ...args]);
            const a = answers[name];
            return typeof a === 'function' ? a(...args) : (a === undefined ? null : a);
        },
        getState,
        setLogLine: m => lines.push(m),
    });
    return { io, calls, lines };
}

test('call: passes the args through, returns the answer, says okMsg', async () => {
    const { io, calls, lines } = harness({ renameNode: true });
    assert.equal(await io.call('renameNode', ['a', 'Kick'], 'Renamed'), true);
    assert.deepEqual(calls, [['renameNode', 'a', 'Kick']]);
    assert.deepEqual(lines, ['Renamed']);
});

test('call: a refusal says failMsg — never okMsg — when the verb can be refused', async () => {
    const { io, lines } = harness({ deleteNode: false, duplicateProject: '', setNodePan: true });
    assert.equal(await io.call('deleteNode', ['a'], 'Deleted', 'Not deleted'), false);
    await io.call('duplicateProject', [], 'Forked', 'Nothing to duplicate');
    await io.call('setNodePan', ['a', 0], 'Panned');  // no failMsg: nothing can refuse it
    assert.deepEqual(lines, ['Not deleted', 'Nothing to duplicate', 'Panned']);
});

test('call: a lost call says the engine did not answer, whatever the verb would have said', async () => {
    const { io, lines } = harness();
    assert.equal(await io.call('deleteNode', ['a'], 'Deleted', 'Not deleted'), null);
    await io.call('renameProject', ['x'], 'Project renamed');
    await io.call('toggleLoopWindow', ['a'], undefined, 'Not toggled');
    await io.call('setNodePan', ['a', 0]);  // a verb with no line stays silent
    assert.deepEqual(lines, [NO_ANSWER, NO_ANSWER, NO_ANSWER]);
});

test('call: a message may be a function of the answer; no text writes nothing', async () => {
    const { io, lines } = harness({
        duplicateProject: '20261011-02', quiet: true, toggleLoopWindow: false });
    await io.call('duplicateProject', [], id => `Forked to ${id}`, 'Nothing to duplicate');
    await io.call('quiet');
    await io.call('toggleLoopWindow', ['a'], undefined, () => '');  // a refusal with nothing true to say
    await io.call('toggleLoopWindow', ['a'], undefined, answer => `answered ${answer}`);
    assert.deepEqual(lines, ['Forked to 20261011-02', 'answered false']);
});

test('callEach: every step in order, then one status line', async () => {
    const { io, calls, lines } = harness({ reorderNode: true, deleteNode: true });
    const ran = await io.callEach([
        ['reorderNode', 'a', 'root', 0],
        ['reorderNode', 'b', 'root', 1],
        ['deleteNode', 'g'],
    ], 'Ungrouped');
    assert.equal(ran, true);
    assert.deepEqual(calls, [
        ['reorderNode', 'a', 'root', 0], ['reorderNode', 'b', 'root', 1], ['deleteNode', 'g']]);
    assert.deepEqual(lines, ['Ungrouped']);
});

test('callEach: with a failMsg, the first refusal says it and ends the sequence', async () => {
    const { io, calls, lines } = harness({
        reorderNode: id => id !== 'b', deleteNode: true });
    const ran = await io.callEach([
        ['reorderNode', 'a', 'root', 0],
        ['reorderNode', 'b', 'root', 1],
        ['deleteNode', 'g'],
    ], 'Ungrouped', (answer, applied) => `refused after ${applied} (${answer})`);
    assert.equal(ran, false);
    assert.deepEqual(calls.map(c => c[0] + ':' + c[1]), ['reorderNode:a', 'reorderNode:b'],
        'the shell is not deleted over children that did not move');
    assert.deepEqual(lines, ['refused after 1 (false)']);
});

test('callEach: a lost step ends the sequence with the no-answer line', async () => {
    const { io, calls, lines } = harness({ reorderNode: true });
    const ran = await io.callEach([
        ['reorderNode', 'a', 'root', 0], ['deleteNode', 'g'], ['reorderNode', 'b', 'root', 1],
    ], 'Ungrouped', 'Ungroup refused');
    assert.equal(ran, false);
    assert.equal(calls.length, 2);
    assert.deepEqual(lines, [NO_ANSWER]);
});

test('callEach: with no failMsg the answers are not judged; no steps still says okMsg', async () => {
    const { io, calls, lines } = harness({ reorderNode: false });
    assert.equal(await io.callEach([['reorderNode', 'a', 'root', 0]], 'Moved'), true);
    assert.equal(await io.callEach([], 'Grouped'), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(lines, ['Moved', 'Grouped']);
});

test('readState: the bridge read on a real backend; null when it is lost', async () => {
    const state = { id: 'root', nodes: [] };
    const real = harness({ getGraphState: state });
    assert.equal(await real.io.readState(), state);
    assert.deepEqual(real.calls, [['getGraphState']]);
    assert.equal(await harness().io.readState(), null);
});

test('readState: the mock\'s synchronous getter when there is one, with no bridge call', async () => {
    const state = { id: 'root', nodes: [] };
    const mock = harness({}, () => state);
    assert.equal(await mock.io.readState(), state);
    assert.deepEqual(mock.calls, []);
});
