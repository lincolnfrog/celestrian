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
        activeSelectedId } = await import('../session_view/selection.js');

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
