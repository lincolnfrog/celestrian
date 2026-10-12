/**
 * session_facts.js — the graph predicates the verb modules share, and
 * the two ways the facts are written: the poll's hand-over and a graph
 * read between polls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as facts from '../session_facts.js';
import { indexNodes, firstNewNodeId, isHotClip, anyTakeLive, clipsUnder,
         hasCommitted, parentOf, topLevelNodes, notePoll, noteGraphRead,
         noteView, noteFrame } from '../session_facts.js';

const clip = (id, extra = {}) => ({ id, type: 'clip', duration: 0, ...extra });
const stack = (id, nodes) => ({ id, type: 'stack', nodes });

/** A state whose poll the facts adopt. */
function poll(nodes, id = 'root') {
    const state = { id, nodes };
    notePoll(state, indexNodes(nodes));
    return state;
}

test('indexNodes: every node of the tree, by id', () => {
    const inner = clip('b');
    const tree = [clip('a'), stack('g', [inner, stack('h', [clip('c')])])];
    const index = indexNodes(tree);
    assert.deepEqual([...index.keys()], ['a', 'g', 'b', 'h', 'c']);
    assert.equal(index.get('b'), inner, 'the published objects themselves');
});

test('firstNewNodeId: the first id the earlier graph did not hold', () => {
    const before = indexNodes([clip('a'), stack('g', [clip('b')])]);
    assert.equal(firstNewNodeId([clip('a'), stack('g', [clip('b')])], before), null,
        'nothing new');
    assert.equal(firstNewNodeId([clip('a'), stack('g', [clip('b')]), clip('n')], before), 'n');
    assert.equal(firstNewNodeId([clip('a'), stack('g', [clip('b'), clip('n')])], before), 'n',
        'a new node inside a group');
    // combineNodes wraps two tracks in a new group: the group, not a member.
    assert.equal(firstNewNodeId([stack('new', [clip('a'), clip('b')])],
        indexNodes([clip('a'), clip('b')])), 'new');
    assert.equal(firstNewNodeId(undefined, before), null);
});

test('isHotClip / anyTakeLive: armed or capturing, anywhere in the graph', () => {
    assert.equal(isHotClip(clip('a')), false);
    assert.equal(isHotClip(clip('a', { isPendingStart: true })), true);
    assert.equal(isHotClip(clip('a', { isRecording: true })), true);

    poll([clip('a', { duration: 100 }), stack('g', [clip('b')])]);
    assert.equal(anyTakeLive(), false);
    poll([clip('a', { duration: 100 }),
          stack('g', [clip('b', { isPendingStart: true })])]);
    assert.equal(anyTakeLive(), true, 'an armed clip inside a group');
    poll([]);
    assert.equal(anyTakeLive(), false);
});

test('clipsUnder: a clip is its own subtree; a group gives every clip beneath', () => {
    const a = clip('a'), b = clip('b'), c = clip('c');
    assert.deepEqual(clipsUnder(a), [a]);
    assert.deepEqual(clipsUnder(stack('g', [a, stack('h', [b, c])])), [a, b, c]);
    assert.deepEqual(clipsUnder(stack('empty', [])), []);
});

test('hasCommitted: a clip with material that is not recording, or a group holding one', () => {
    assert.equal(hasCommitted(clip('a')), false, 'empty');
    assert.equal(hasCommitted(clip('a', { duration: 10 })), true);
    assert.equal(hasCommitted(clip('a', { duration: 10, isRecording: true })), false,
        'a first take still growing');
    assert.equal(hasCommitted(stack('g', [clip('a'), stack('h', [clip('b', { duration: 5 })])])), true);
    assert.equal(hasCommitted(stack('g', [clip('a')])), false);
});

test('parentOf / topLevelNodes read the indexed graph', () => {
    const b = clip('b');
    const g = stack('g', [b]);
    const a = clip('a');
    poll([a, g]);
    assert.equal(parentOf(b), g);
    assert.equal(parentOf(g), null);
    assert.deepEqual(topLevelNodes(), [a, g]);
});

test('notePoll adopts the state, its index and its root; a state with no id clears the root', () => {
    const state = poll([clip('a')], 'island-1');
    assert.equal(facts.lastState, state);
    assert.equal(facts.lastRootId, 'island-1');
    assert.equal(facts.lastNodesById.get('a'), state.nodes[0]);
    notePoll({ nodes: [] }, new Map());
    assert.equal(facts.lastRootId, '');
});

test('noteGraphRead: a read between polls re-indexes; the polled state and a known root stand', () => {
    const polled = poll([], 'island-1');
    noteGraphRead({ nodes: [clip('fresh')] });  // no id on this read
    assert.equal(facts.lastNodesById.has('fresh'), true);
    assert.equal(facts.lastRootId, 'island-1', 'the root survives a read without one');
    assert.equal(facts.lastState, polled, 'the polled state is not replaced');
    noteGraphRead({ id: 'island-2', nodes: [] });
    assert.equal(facts.lastRootId, 'island-2');
});

test('noteView records the view model and its frame; noteFrame replaces the frame alone', () => {
    const vm = { quantum: 100 };
    noteView(vm, { zero: 5, rest: 5, quantum: 100 });
    assert.equal(facts.lastVm, vm);
    assert.equal(facts.lastFrame.zero, 5);
    noteFrame({ zero: 2, rest: 2, quantum: 100 });
    assert.equal(facts.lastFrame.zero, 2);
    assert.equal(facts.lastVm, vm);
    noteView(vm, null);
    assert.equal(facts.lastFrame, null, 'no frame before Q is established');
});
