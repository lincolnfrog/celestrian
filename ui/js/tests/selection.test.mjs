/**
 * selection.js — the default selection and the new-track hand-off: a
 * created track is selected by the first patch that lists it
 * (selectWhenPresent), never pruned by a patch that predates it, and
 * dropped by an explicit select. A stub document stands in for the
 * rails (the painters only query it).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document ??= { querySelectorAll: () => [], getElementById: () => null };

const { selection, selectOnly, ensureDefaultSelection, selectWhenPresent,
        activeSelectedId, toggleSelect, clearSelection } =
    await import('../session_view/selection.js');

/** A rail's row, as toggleSelect reads it. */
const rowOf = id => ({ _lane: { id } });

test('an additive click on the sole selected rail keeps it selected', () => {
    selectOnly('c');
    toggleSelect(rowOf('c'), true);
    assert.deepEqual([...selection], ['c']);
    // The next patch finds its track still selected: no jump to lane 1.
    assert.equal(ensureDefaultSelection(['a', 'b', 'c']), false);
    assert.equal(activeSelectedId(), 'c');
});

test('additive clicks add a rail and take it out again, down to one', () => {
    selectOnly('a');
    toggleSelect(rowOf('b'), true);
    toggleSelect(rowOf('c'), true);
    assert.deepEqual([...selection], ['a', 'b', 'c']);
    toggleSelect(rowOf('b'), true);
    assert.deepEqual([...selection], ['a', 'c']);
    toggleSelect(rowOf('c'), true);
    toggleSelect(rowOf('a'), true);   // the last member stays
    assert.deepEqual([...selection], ['a']);
});

test('a plain click selects that rail alone; an explicit clear sticks', () => {
    selectOnly('a');
    toggleSelect(rowOf('b'), true);
    toggleSelect(rowOf('c'), false);
    assert.deepEqual([...selection], ['c']);
    clearSelection();
    assert.equal(ensureDefaultSelection(['a', 'b', 'c']), false);
    assert.equal(activeSelectedId(), null);
    // An additive click on nothing selected selects.
    toggleSelect(rowOf('b'), true);
    assert.deepEqual([...selection], ['b']);
});

test('a new track is selected once its lane appears — not pruned before', () => {
    selectOnly('a');
    selectWhenPresent('new');
    // A poll that predates the create: the old tree, selection untouched.
    ensureDefaultSelection(['a', 'b']);
    assert.equal(activeSelectedId(), 'a');
    // The first patch that lists it takes it.
    assert.equal(ensureDefaultSelection(['a', 'b', 'new']), true);
    assert.deepEqual([...selection], ['new']);
    // Taken once: a later select sticks.
    selectOnly('b');
    ensureDefaultSelection(['a', 'b', 'new']);
    assert.equal(activeSelectedId(), 'b');
});

test('an explicit select before the lane appears drops the pending one', () => {
    selectOnly('a');
    selectWhenPresent('new');
    selectOnly('b');
    ensureDefaultSelection(['a', 'b', 'new']);
    assert.equal(activeSelectedId(), 'b');
});

test('selectWhenPresent(null) (nothing was created) changes nothing', () => {
    selectOnly('a');
    selectWhenPresent(null);
    ensureDefaultSelection(['a', 'b']);
    assert.equal(activeSelectedId(), 'a');
});
