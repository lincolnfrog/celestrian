/**
 * view_prefs.js: the UI-local fold set (I6b — the engine holds no view
 * state). Scoping by project id, localStorage persistence, the
 * session-only fallback, and the birth migration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { foldedStacks, toggleFolded, migrateFolds, resetViewPrefsForTest }
    from '../view_prefs.js';

/** A localStorage stand-in: node has none. */
function fakeStorage() {
    const map = new Map();
    return {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        map,
    };
}

test('toggle flips a stack in and out of the folded set', () => {
    resetViewPrefsForTest();
    delete globalThis.localStorage;
    assert.equal(toggleFolded('', 'stack-1'), true);
    assert.ok(foldedStacks('').has('stack-1'));
    assert.equal(toggleFolded('', 'stack-1'), false);
    assert.ok(!foldedStacks('').has('stack-1'));
});

test('folds are scoped by project id', () => {
    resetViewPrefsForTest();
    delete globalThis.localStorage;
    toggleFolded('20260901-01', 'g');
    assert.ok(foldedStacks('20260901-01').has('g'));
    assert.ok(!foldedStacks('20260901-02').has('g'));
    assert.ok(!foldedStacks('').has('g'));
});

test('a project id persists its folds in localStorage; pre-birth does not', () => {
    resetViewPrefsForTest();
    const storage = fakeStorage();
    globalThis.localStorage = storage;
    toggleFolded('20260901-01', 'g');
    toggleFolded('', 'session-only');
    assert.deepEqual(JSON.parse(storage.getItem('celestrian.viewPrefs.20260901-01.folded')), ['g']);
    assert.equal(storage.getItem('celestrian.viewPrefs..folded'), null);

    // A fresh in-memory state reads the persisted set back.
    resetViewPrefsForTest();
    assert.ok(foldedStacks('20260901-01').has('g'));
    assert.ok(!foldedStacks('').has('session-only'));
    delete globalThis.localStorage;
});

test('corrupt or refusing storage degrades to session-only', () => {
    resetViewPrefsForTest();
    globalThis.localStorage = {
        getItem: () => '{not json',
        setItem: () => { throw new Error('quota'); },
    };
    assert.equal(foldedStacks('p').size, 0);
    assert.equal(toggleFolded('p', 'g'), true);
    assert.ok(foldedStacks('p').has('g'));
    delete globalThis.localStorage;
});

test('birth migrates the session-only folds onto the project', () => {
    resetViewPrefsForTest();
    const storage = fakeStorage();
    globalThis.localStorage = storage;
    toggleFolded('', 'a');
    toggleFolded('', 'b');
    migrateFolds('', '20260901-03');
    assert.equal(foldedStacks('').size, 0);
    assert.deepEqual([...foldedStacks('20260901-03')].sort(), ['a', 'b']);
    assert.deepEqual(JSON.parse(storage.getItem('celestrian.viewPrefs.20260901-03.folded')).sort(),
                     ['a', 'b']);
    delete globalThis.localStorage;
});
