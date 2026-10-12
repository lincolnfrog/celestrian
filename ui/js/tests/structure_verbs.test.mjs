/**
 * structure_verbs.js — the bridge-call sequences behind create-and-
 * select, drag-to-group, group-the-selection, move-to-top and ungroup,
 * and what each says when the engine refuses or does not answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStructureVerbs, groupRefusal, moveRefusal, ungroupRefusal,
         appendSteps } from '../structure_verbs.js';
import { createShellIo, NO_ANSWER } from '../shell_io.js';
import { notePoll, indexNodes } from '../session_facts.js';

const clip = (id, extra = {}) => ({ id, type: 'clip', name: id, ...extra });
const group = (id, nodes, extra = {}) => ({ id, type: 'stack', name: id, nodes, ...extra });

/**
 * The verbs over a fake engine holding `nodes` under root. combineNodes
 * and createNode really restructure the tree (so the read that follows
 * sees it); every call is recorded. `engine.refuse` holds methods that
 * answer a refusal (`refuseAfter`: only once that many calls of the
 * method went through); `engine.lost` makes state reads answer null,
 * `engine.dropped` holds methods whose call is lost.
 */
function harness(nodes) {
    const engine = { nodes, refuse: new Set(), refuseAfter: 0, dropped: new Set(),
                     lost: false, calls: [], made: 0 };
    const lines = [];
    const selected = [];
    const verbs = {
        getGraphState: () => (engine.lost ? null : { id: 'root', nodes: engine.nodes }),
        createNode: () => {
            const n = clip(`new-${++engine.made}`);
            engine.nodes = [...engine.nodes, n];
            return n.id;
        },
        combineNodes: (dragged, target) => {
            const pick = id => engine.nodes.find(n => n.id === id);
            const made = group(`group-${++engine.made}`, [pick(target), pick(dragged)]);
            engine.nodes = engine.nodes.flatMap(n =>
                n.id === target ? [made] : n.id === dragged ? [] : [n]);
            return made.id;
        },
        reorderNode: () => true,
        deleteNode: () => true,
    };
    const io = createShellIo({
        callNative: async (name, ...args) => {
            const earlier = engine.calls.filter(c => c[0] === name).length;
            engine.calls.push([name, ...args]);
            if (engine.dropped.has(name)) return null;
            if (engine.refuse.has(name) && earlier >= engine.refuseAfter) {
                // The verbs that make a node answer no id; the rest, false.
                return name === 'combineNodes' || name === 'createNode' ? '' : false;
            }
            return verbs[name](...args);
        },
        setLogLine: m => lines.push(m),
    });
    const structure = createStructureVerbs({ io, selectWhenPresent: id => selected.push(id) });
    notePoll({ id: 'root', nodes }, indexNodes(nodes));
    /** The calls that change the graph (state reads left out). */
    const edits = () => engine.calls.filter(c => c[0] !== 'getGraphState');
    return { structure, engine, lines, selected, edits };
}

test('createAndSelect: selects the node the verb made, and returns the verb\'s answer', async () => {
    const { structure, selected, engine } = harness([clip('a')]);
    const answer = await structure.createAndSelect(async () => {
        engine.nodes = [...engine.nodes, clip('made')];
        return 'the answer';
    });
    assert.equal(answer, 'the answer');
    assert.deepEqual(selected, ['made']);
});

test('createAndSelect: a verb that made nothing selects nothing (null)', async () => {
    const { structure, selected } = harness([clip('a')]);
    await structure.createAndSelect(async () => false);
    assert.deepEqual(selected, [null]);
});

test('createAndSelect: a lost read on either side selects nothing at all', async () => {
    const { structure, engine, selected } = harness([clip('a')]);
    engine.lost = true;
    await structure.createAndSelect(async () => {
        engine.lost = false;  // only the "before" read was lost
        engine.nodes = [...engine.nodes, clip('made')];
    });
    assert.deepEqual(selected, [], 'an empty "before" would make every lane look new');
});

test('drop on a clip: the first id combines into a new group, the rest append after its two', async () => {
    const { structure, edits, lines } = harness([clip('t'), clip('a'), clip('b'), clip('c')]);
    await structure.onDropLane(['a', 'b', 'c'], { id: 't' });
    assert.deepEqual(edits(), [
        ['combineNodes', 'a', 't'],
        ['reorderNode', 'b', 'group-1', 2],
        ['reorderNode', 'c', 'group-1', 3],
    ]);
    assert.deepEqual(lines, ['Grouped 3 tracks with "t"']);
});

test('drop one track on a clip: grouped, with the rename hint', async () => {
    const { structure, edits, lines } = harness([clip('t'), clip('a')]);
    await structure.onDropLane(['a'], { id: 't' });
    assert.deepEqual(edits(), [['combineNodes', 'a', 't']]);
    assert.deepEqual(lines, ['Grouped with "t" — rename the group on its rail']);
});

test('drop on a group: every id appends after the children it has', async () => {
    const g = group('g', [clip('x'), clip('y'), clip('z')]);
    const { structure, engine, edits, lines } = harness([g, clip('a'), clip('b')]);
    await structure.onDropLane(['a', 'gone', 'b'], { id: 'g' });
    assert.deepEqual(edits(), [
        ['reorderNode', 'a', 'g', 3],
        ['reorderNode', 'b', 'g', 4],
    ], 'an id no longer in the graph is skipped');
    assert.equal(engine.calls.filter(c => c[0] === 'getGraphState').length, 1,
        'the child count is read once');
    assert.deepEqual(lines, ['Grouped 2 tracks with "g"']);

    const one = harness([g, clip('a')]);
    await one.structure.onDropLane(['a'], { id: 'g' });
    assert.deepEqual(one.lines, ['Moved into "g"']);
});

test('a drop of lanes that have all left the graph does nothing and says nothing', async () => {
    const onClip = harness([clip('t'), clip('a')]);
    await onClip.structure.onDropLane(['gone', 'also-gone'], { id: 't' });
    assert.deepEqual(onClip.engine.calls, []);
    assert.deepEqual(onClip.lines, []);

    const onGroup = harness([group('g', [clip('x')])]);
    await onGroup.structure.onDropLane(['gone'], { id: 'g' });
    assert.deepEqual(onGroup.engine.calls, []);
    assert.deepEqual(onGroup.lines, []);
});

test('a refused combine ends the drop and says why', async () => {
    const live = harness([clip('t'), clip('a'), clip('b', { isRecording: true })]);
    live.engine.refuse.add('combineNodes');
    await live.structure.onDropLane(['a'], { id: 't' });
    assert.deepEqual(live.edits(), [['combineNodes', 'a', 't']]);
    assert.deepEqual(live.lines, [groupRefusal(true)]);

    const idle = harness([clip('t'), clip('a')]);
    idle.engine.refuse.add('combineNodes');
    await idle.structure.onGroupSelection(['t', 'a']);
    assert.deepEqual(idle.lines, [groupRefusal(false)]);
    assert.notEqual(groupRefusal(true), groupRefusal(false));
});

test('a combine whose call was lost says the engine did not answer, not that it refused', async () => {
    const { structure, engine, lines } = harness([clip('t'), clip('a')]);
    engine.dropped.add('combineNodes');
    await structure.onDropLane(['a'], { id: 't' });
    assert.deepEqual(lines, [NO_ANSWER]);
});

test('createTrack: one call, and the track the engine answered is selected', async () => {
    const { structure, edits, selected, lines } = harness([group('g', [])]);
    assert.equal(await structure.createTrack('g'), 'new-1');
    assert.deepEqual(edits(), [['createNode', 'clip', 'g']]);
    assert.deepEqual(selected, ['new-1']);
    assert.deepEqual(lines, [], 'the new lane is its own news');
});

test('createTrack: a track the engine did not make selects nothing and says so', async () => {
    const { structure, engine, selected, lines } = harness([clip('a')]);
    engine.refuse.add('createNode');
    assert.equal(await structure.createTrack('gone'), '');
    assert.deepEqual(selected, []);
    assert.deepEqual(lines, ['No track added — the group is no longer there']);
});

test('appendSteps: one move per id from the index — except a move that would leave its node where it is', () => {
    assert.deepEqual(appendSteps(['a', 'b'], 'g', 3, ['x', 'y', 'z']), [
        ['reorderNode', 'a', 'g', 3], ['reorderNode', 'b', 'g', 4]]);
    // z is the group's last child already: appending it changes nothing.
    assert.deepEqual(appendSteps(['z'], 'g', 3, ['x', 'y', 'z']), []);
    // x moves to the end; then y is asked to follow it — a real move too.
    assert.deepEqual(appendSteps(['x', 'y'], 'g', 3, ['x', 'y', 'z']), [
        ['reorderNode', 'x', 'g', 3], ['reorderNode', 'y', 'g', 4]]);
    // z stays; y is then judged on the order z's stay leaves.
    assert.deepEqual(appendSteps(['z', 'y'], 'g', 3, ['x', 'y', 'z']), [
        ['reorderNode', 'y', 'g', 4]]);
    assert.deepEqual(appendSteps(['a'], 'g', 0), [['reorderNode', 'a', 'g', 0]],
        'with no siblings known, every move is sent');
});

test('a member dropped on its own group where it is already last asks for nothing and says nothing', async () => {
    const g = group('g', [clip('x'), clip('y')]);
    const { structure, edits, lines } = harness([g]);
    await structure.onDropLane(['y'], { id: 'g' });
    assert.deepEqual(edits(), []);
    assert.deepEqual(lines, [], 'no move was made, and none was refused');

    const moved = harness([group('g', [clip('x'), clip('y')])]);
    await moved.structure.onDropLane(['x'], { id: 'g' });
    assert.deepEqual(moved.edits(), [['reorderNode', 'x', 'g', 2]]);
    assert.deepEqual(moved.lines, ['Moved into "g"']);
});

test('a move the engine refuses says what did not move — never the success line', async () => {
    const live = harness([group('g', [clip('x')]), clip('a'), clip('b', { isRecording: true })]);
    live.engine.refuse.add('reorderNode');
    await live.structure.onDropLane(['a'], { id: 'g' });
    assert.deepEqual(live.lines, [moveRefusal(true, 0, 1)]);
    assert.equal(moveRefusal(true, 0, 1), 'Move refused — a take is live');
    assert.equal(moveRefusal(false, 0, 1), 'Move refused — nothing changed');

    const idle = harness([group('g', [clip('a'), clip('b')]), clip('c')]);
    idle.engine.refuse.add('reorderNode');
    idle.engine.refuseAfter = 1;  // the first move goes through
    await idle.structure.onMoveToTop(['a', 'b']);
    assert.deepEqual(idle.edits().length, 2, 'the sequence ends at the refusal');
    assert.deepEqual(idle.lines, [moveRefusal(false, 1, 2)]);
    assert.equal(moveRefusal(false, 1, 2),
        'Moved 1 of 2, then refused — the rest stay (⌘Z steps back)');
});

test('an ungroup refused under a live take moves nothing and never deletes the shell', async () => {
    const g = group('g', [clip('a'), clip('b', { isRecording: true })], { name: 'Drums' });
    const { structure, engine, edits, lines } = harness([g]);
    engine.refuse.add('reorderNode');
    await structure.onUngroup('g');
    assert.deepEqual(edits(), [['reorderNode', 'a', 'root', 0]],
        'the first refusal ends it: no further move, no delete');
    assert.deepEqual(lines, ['Ungroup refused — a take is live']);
    assert.equal(ungroupRefusal(false, 0, 2), 'Ungroup refused — nothing changed');
});

test('an ungroup refused part-way says how far it got, and the group stays', async () => {
    const g = group('g', [clip('a'), clip('b'), clip('c')], { name: 'Drums' });
    const { structure, engine, edits, lines } = harness([g]);
    engine.refuse.add('reorderNode');
    engine.refuseAfter = 2;
    await structure.onUngroup('g');
    assert.deepEqual(edits().map(c => c[0]), ['reorderNode', 'reorderNode', 'reorderNode']);
    assert.deepEqual(lines, [ungroupRefusal(false, 2, 3)]);
    assert.match(lines[0], /^Ungroup stopped after 2 of 3 tracks — .*; the group stays/);

    const kept = harness([group('g', [clip('a')], { name: 'Drums' })]);
    kept.engine.refuse.add('deleteNode');
    await kept.structure.onUngroup('g');
    assert.deepEqual(kept.lines, [ungroupRefusal(false, 1, 1)]);
});

test('a drop whose state read is lost stops before it moves anything further', async () => {
    const g = group('g', [clip('x')]);
    const { structure, engine, edits, lines } = harness([g, clip('a')]);
    engine.lost = true;
    await structure.onDropLane(['a'], { id: 'g' });
    assert.deepEqual(edits(), []);
    assert.deepEqual(lines, [NO_ANSWER]);
});

test('group the selection: the first-selected is the anchor; the rest append at their index', async () => {
    const { structure, edits, lines } = harness([clip('a'), clip('b'), clip('c'), clip('d')]);
    await structure.onGroupSelection(['a', 'b', 'c', 'd']);
    assert.deepEqual(edits(), [
        ['combineNodes', 'b', 'a'],
        ['reorderNode', 'c', 'group-1', 2],
        ['reorderNode', 'd', 'group-1', 3],
    ]);
    assert.deepEqual(lines, ['Grouped 4 tracks — rename the group on its rail']);
});

test('group the selection: one lane is no group', async () => {
    const { structure, engine } = harness([clip('a')]);
    await structure.onGroupSelection(['a']);
    assert.deepEqual(engine.calls, []);
});

test('move to top: appended after the top-level lanes, in order', async () => {
    const { structure, edits, lines } = harness(
        [group('g', [clip('a'), clip('b')]), clip('c')]);
    await structure.onMoveToTop(['a', 'b']);
    assert.deepEqual(edits(), [
        ['reorderNode', 'a', 'root', 2],
        ['reorderNode', 'b', 'root', 3],
    ]);
    assert.deepEqual(lines, ['Moved 2 tracks to the top level']);
});

test('move to top: a lost read moves nothing', async () => {
    const { structure, engine, edits, lines } = harness([group('g', [clip('a')])]);
    engine.lost = true;
    await structure.onMoveToTop(['a']);
    assert.deepEqual(edits(), []);
    assert.deepEqual(lines, [NO_ANSWER]);
});

test('ungroup a top-level group: its children take its slot, then the shell is deleted', async () => {
    const g = group('g', [clip('a'), clip('b')], { name: 'Drums' });
    const { structure, edits, lines } = harness([clip('before'), g, clip('after')]);
    await structure.onUngroup('g');
    assert.deepEqual(edits(), [
        ['reorderNode', 'a', 'root', 1],
        ['reorderNode', 'b', 'root', 2],
        ['deleteNode', 'g'],
    ]);
    assert.match(lines[0], /^Ungrouped "Drums"/);
});

test('ungroup a nested group: its children move into its parent, at its slot', async () => {
    const inner = group('inner', [clip('a'), clip('b')]);
    const { structure, edits } = harness([group('outer', [clip('x'), inner])]);
    await structure.onUngroup('inner');
    assert.deepEqual(edits(), [
        ['reorderNode', 'a', 'outer', 1],
        ['reorderNode', 'b', 'outer', 2],
        ['deleteNode', 'inner'],
    ]);
});
