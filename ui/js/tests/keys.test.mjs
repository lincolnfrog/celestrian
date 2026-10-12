/**
 * keys.js — the single keyboard dispatcher: registration and
 * unregister, the typing guard, modifier normalization / exactness,
 * key matching, scope priority (a modal's Escape beats the view's) and
 * the pass-through (`return false`) contract. Drives dispatchKey
 * directly — no DOM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { registerKey, dispatchKey, installKeyDispatcher, normalizeModifiers,
         bindingCount, SCOPE, ANY_MODIFIERS } from '../keys.js';

/** A keydown-shaped event. `target` defaults to a non-typing element. */
const ev = (key, extra = {}) => ({
    key, code: extra.code || '',
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    target: { tagName: 'DIV', isContentEditable: false },
    preventDefault() { this.prevented = true; },
    ...extra,
});
const typing = tag => ({ tagName: tag, isContentEditable: false });

/** Registers `spec` for the test's duration; returns the hit counter. */
function bind(t, spec) {
    const hits = [];
    const off = registerKey({ handler: e => { hits.push(e); }, ...spec });
    t.after(off);
    return hits;
}

test('registration, dispatch, unregister', () => {
    const before = bindingCount();
    const hits = [];
    const off = registerKey({ key: 'x', handler: e => hits.push(e) });
    assert.equal(bindingCount(), before + 1);
    assert.equal(dispatchKey(ev('x')), true, 'consumed');
    assert.equal(hits.length, 1);
    assert.equal(dispatchKey(ev('y')), false, 'unbound key is not consumed');
    off();
    off();  // idempotent
    assert.equal(bindingCount(), before);
    assert.equal(dispatchKey(ev('x')), false, 'unregistered');
});

test('registration validates its spec', () => {
    assert.throws(() => registerKey({ handler() {} }), /key or code/);
    assert.throws(() => registerKey({ key: 'x' }), /handler/);
    assert.throws(() => registerKey({ key: 'x', modifiers: ['cmd'], handler() {} }),
        /unknown modifier 'cmd'/);
    assert.throws(() => registerKey({ key: 'x', ignore: ['hyper'], handler() {} }),
        /unknown ignore modifier/);
});

test('typing guard: form controls and contentEditable are skipped unless whileTyping', t => {
    const hotkey = bind(t, { key: 'r', ignore: ['shift'] });
    const escape = bind(t, { key: 'Escape', whileTyping: true });
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
        assert.equal(dispatchKey(ev('r', { target: typing(tag) })), false, tag);
    }
    assert.equal(dispatchKey(ev('r', {
        target: { tagName: 'DIV', isContentEditable: true } })), false, 'contentEditable');
    assert.equal(hotkey.length, 0);
    assert.equal(dispatchKey(ev('Escape', { target: typing('INPUT') })), true);
    assert.equal(escape.length, 1, 'whileTyping bindings still fire');
    assert.equal(dispatchKey(ev('r')), true);
    assert.equal(hotkey.length, 1);
});

test('normalizeModifiers: primary is Meta on macOS and Ctrl elsewhere', () => {
    const cmd = ev('z', { metaKey: true });
    const ctrl = ev('z', { ctrlKey: true, shiftKey: true });
    assert.deepEqual(normalizeModifiers(cmd, true),
        { primary: true, secondary: false, ctrl: false, meta: true, alt: false, shift: false });
    assert.deepEqual(normalizeModifiers(cmd, false),
        { primary: false, secondary: true, ctrl: false, meta: true, alt: false, shift: false });
    assert.deepEqual(normalizeModifiers(ctrl, false),
        { primary: true, secondary: false, ctrl: true, meta: false, alt: false, shift: true });
    assert.equal(normalizeModifiers(ctrl, true).primary, false);
    assert.equal(normalizeModifiers(ctrl, true).secondary, true);
});

test('primary accepts Cmd or Ctrl; letters match case-insensitively; shift is exact', t => {
    const undo = bind(t, { key: 'z', modifiers: ['primary'] });
    const redo = bind(t, { key: 'z', modifiers: ['primary', 'shift'] });
    assert.equal(dispatchKey(ev('z', { metaKey: true })), true);
    assert.equal(dispatchKey(ev('z', { ctrlKey: true })), true);
    assert.equal(undo.length, 2, 'Cmd+Z and Ctrl+Z both undo');
    assert.equal(dispatchKey(ev('Z', { metaKey: true, shiftKey: true })), true);
    assert.equal(dispatchKey(ev('z', { ctrlKey: true, shiftKey: true })), true);
    assert.equal(redo.length, 2, 'Shift routes to redo, not undo');
    assert.equal(undo.length, 2);
    assert.equal(dispatchKey(ev('z')), false, 'bare z is neither');
    assert.equal(dispatchKey(ev('z', { metaKey: true, altKey: true })), false,
        'an unlisted, un-ignored modifier is a mismatch');
});

test('ctrl is literal (Ctrl+Y redo) and Cmd does not satisfy it', t => {
    const redo = bind(t, { key: 'y', modifiers: ['ctrl'] });
    assert.equal(dispatchKey(ev('y', { ctrlKey: true })), true);
    assert.equal(dispatchKey(ev('y', { metaKey: true })), false);
    assert.equal(redo.length, 1);
});

test('ignore: Shift-carrying keys and ANY_MODIFIERS', t => {
    const zoom = bind(t, { key: ['+', '='], ignore: ['shift'] });
    assert.equal(dispatchKey(ev('+', { shiftKey: true })), true, 'Shift+= → +');
    assert.equal(dispatchKey(ev('=')), true, 'unshifted =');
    assert.equal(dispatchKey(ev('=', { ctrlKey: true })), false, 'Ctrl+= is not zoom');
    assert.equal(zoom.length, 2);
    const space = bind(t, { code: 'Space', ignore: ANY_MODIFIERS });
    assert.equal(dispatchKey(ev(' ', { code: 'Space', shiftKey: true, metaKey: true, altKey: true })), true);
    assert.equal(space.length, 1, 'code match under any modifier state');
});

test('scope priority: an open panel\'s Escape beats the view\'s Escape', t => {
    let panelOpen = false;
    const view = bind(t, { key: 'Escape', scope: SCOPE.VIEW, whileTyping: true, ignore: ANY_MODIFIERS });
    const panel = bind(t, { key: 'Escape', scope: SCOPE.PANEL, whileTyping: true,
                            ignore: ANY_MODIFIERS, when: () => panelOpen });
    const app = bind(t, { key: 'Escape', scope: SCOPE.APP });
    assert.equal(dispatchKey(ev('Escape')), true);
    assert.deepEqual([view.length, panel.length, app.length], [1, 0, 0],
        'panel closed: its `when` gate fails, the view consumes');
    panelOpen = true;
    assert.equal(dispatchKey(ev('Escape')), true);
    assert.deepEqual([view.length, panel.length, app.length], [1, 1, 0],
        'panel open: it consumes; the view never sees the key');
});

test('a handler returning false passes the key on; same-scope order is registration order', t => {
    const order = [];
    const off1 = registerKey({ key: 'k', handler: () => { order.push('first'); return false; } });
    const off2 = registerKey({ key: 'k', handler: () => { order.push('second'); } });
    const off3 = registerKey({ key: 'k', handler: () => { order.push('third'); } });
    t.after(() => { off1(); off2(); off3(); });
    assert.equal(dispatchKey(ev('k')), true);
    assert.deepEqual(order, ['first', 'second']);
});

test('auto-repeat: a held key is one press unless the binding opts in', t => {
    const toggle = bind(t, { code: 'Space', ignore: ANY_MODIFIERS });
    const zoom = bind(t, { key: '+', ignore: ['shift'], repeat: true });
    const press = dispatchKey(ev(' ', { code: 'Space' }));
    const held = ev(' ', { code: 'Space', repeat: true });
    assert.equal(press, true);
    assert.equal(dispatchKey(held), true, 'the repeat is consumed');
    assert.equal(dispatchKey(ev(' ', { code: 'Space', repeat: true })), true);
    assert.equal(toggle.length, 1, 'the handler ran for the press only');
    assert.equal(held.prevented, true, 'the browser default does not run either');

    assert.equal(dispatchKey(ev('+')), true);
    const zoomHeld = ev('+', { repeat: true });
    assert.equal(dispatchKey(zoomHeld), true);
    assert.equal(zoom.length, 2, 'an opted-in binding fires on every repeat');
    assert.notEqual(zoomHeld.prevented, true, 'and its handler owns preventDefault');
});

test('auto-repeat: a repeat never falls through to a lower scope, and typing still repeats', t => {
    let panelOpen = true;
    const panel = bind(t, { key: 'Escape', scope: SCOPE.PANEL, whileTyping: true,
                            ignore: ANY_MODIFIERS, when: () => panelOpen });
    const view = bind(t, { key: 'Escape', scope: SCOPE.VIEW, whileTyping: true,
                           ignore: ANY_MODIFIERS });
    assert.equal(dispatchKey(ev('Escape')), true);
    panelOpen = false;  // the press closed the panel; the key is still down
    assert.equal(dispatchKey(ev('Escape', { repeat: true })), true);
    assert.deepEqual([panel.length, view.length], [1, 0],
        'the held Escape does not go on to clear the view');

    const hotkey = bind(t, { key: 'r' });
    assert.equal(dispatchKey(ev('r', { target: typing('INPUT') })), false);
    const typed = ev('r', { repeat: true, target: typing('INPUT') });
    assert.equal(dispatchKey(typed), false, 'a held key in a text field is typing');
    assert.notEqual(typed.prevented, true);
    assert.equal(hotkey.length, 0);
});

test('auto-repeat: a press no binding took keeps its browser default while held', t => {
    let calls = 0;
    const off = registerKey({ key: 'ArrowRight', handler: () => { calls++; return false; } });
    t.after(off);
    assert.equal(dispatchKey(ev('ArrowRight')), false, 'the handler declined the press');
    const held = ev('ArrowRight', { repeat: true });
    assert.equal(dispatchKey(held), false, 'so its repeats are the browser\'s (a scroll)');
    assert.notEqual(held.prevented, true);
    assert.equal(calls, 1, 'and the handler is not asked again');

    // A repeat with no press on record (focus arrived with the key down).
    const hits = bind(t, { key: 'q' });
    const stray = ev('q', { repeat: true });
    assert.equal(dispatchKey(stray), false);
    assert.notEqual(stray.prevented, true);
    assert.equal(hits.length, 0);
});

test('installKeyDispatcher attaches one keydown listener and uninstalls', t => {
    const listeners = new Map();
    const target = {
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
    };
    const uninstall = installKeyDispatcher(target);
    assert.equal(listeners.get('keydown'), dispatchKey);
    assert.equal(typeof installKeyDispatcher(target), 'function', 'idempotent while installed');
    assert.equal(listeners.size, 1);
    const hits = bind(t, { key: 'q' });
    listeners.get('keydown')(ev('q'));
    assert.equal(hits.length, 1);
    uninstall();
    assert.equal(listeners.size, 0);
});
