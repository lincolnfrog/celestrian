/**
 * popover.js — the three behaviours every shell popover shares: its
 * button toggles it, a press outside closes it, and Escape closes it
 * through a PANEL-scope binding that outranks the view's Escape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { wirePopover } from '../popover.js';
import { registerKey, dispatchKey, SCOPE, bindingCount } from '../keys.js';

/** A stand-in for an element or the document: listeners by type and
 * phase, and `contains` over the nodes it was given. */
function fakeTarget(children = []) {
    const listeners = [];
    const self = {
        addEventListener: (type, fn, capture = false) => listeners.push({ type, fn, capture }),
        removeEventListener: (type, fn, capture = false) => {
            const i = listeners.findIndex(l => l.type === type && l.fn === fn && l.capture === capture);
            if (i >= 0) listeners.splice(i, 1);
        },
        contains: node => node === self || children.includes(node),
        fire: (type, event = {}) => {
            for (const l of [...listeners]) if (l.type === type) l.fn(event);
        },
        listeners,
    };
    return self;
}

const escape = () => ({ key: 'Escape', code: 'Escape', preventDefault() {} });

/** A popover over fakes: `inside` is a node the popover holds, `icon`
 * a child of its button, `elsewhere` anything else. */
function harness(t, { withButton = true } = {}) {
    const icon = {}, inside = {}, elsewhere = {};
    const button = fakeTarget([icon]);
    const root = fakeTarget();
    const state = { open: false, opens: 0, closes: 0 };
    const unwire = wirePopover({
        button: withButton ? button : null,
        isOpen: () => state.open,
        open: () => { state.open = true; state.opens++; },
        close: () => { state.open = false; state.closes++; },
        holds: target => target === inside,
        root,
    });
    t.after(unwire);
    const press = target => root.fire('pointerdown', { target });
    return { button, root, state, press, icon, inside, elsewhere, unwire };
}

test('the button toggles the popover', t => {
    const { button, state } = harness(t);
    button.fire('click');
    assert.equal(state.open, true);
    button.fire('click');
    assert.equal(state.open, false);
    assert.deepEqual([state.opens, state.closes], [1, 1]);
});

test('a press outside closes it; a press inside does not', t => {
    const { button, state, press, inside, elsewhere } = harness(t);
    button.fire('click');
    press(inside);
    assert.equal(state.open, true);
    press(elsewhere);
    assert.equal(state.open, false);
});

test('a press on the button is left to its click: one toggle, not close-then-reopen', t => {
    const { button, state, press, icon } = harness(t);
    button.fire('click');
    press(button);
    press(icon);
    assert.equal(state.open, true, 'neither the button nor a child of it is "outside"');
    button.fire('click');
    assert.equal(state.open, false);
    assert.deepEqual([state.opens, state.closes], [1, 1]);
});

test('a closed popover ignores presses', t => {
    const { state, press, elsewhere } = harness(t);
    press(elsewhere);
    assert.equal(state.closes, 0);
});

test('presses are heard in the capture phase, before any target can stop them', t => {
    const { root } = harness(t);
    assert.deepEqual(root.listeners.map(l => [l.type, l.capture]), [['pointerdown', true]]);
});

test('Escape closes an open popover and is not passed on to the view', t => {
    const { button, state } = harness(t);
    let viewEscapes = 0;
    t.after(registerKey({ key: 'Escape', scope: SCOPE.VIEW, handler: () => { viewEscapes++; } }));

    button.fire('click');
    assert.equal(dispatchKey(escape()), true);
    assert.equal(state.open, false);
    assert.equal(viewEscapes, 0, 'the selection the view\'s Escape clears is left alone');

    dispatchKey(escape());
    assert.equal(viewEscapes, 1, 'closed, Escape is the view\'s again');
    assert.equal(state.closes, 1);
});

test('Escape closes it while the user is typing in it', t => {
    const { button, state } = harness(t);
    button.fire('click');
    dispatchKey({ ...escape(), target: { tagName: 'INPUT' } });
    assert.equal(state.open, false);
});

test('with no button the caller opens it; outside presses and Escape still close it', t => {
    const { button, state, press, elsewhere } = harness(t, { withButton: false });
    assert.equal(button.listeners.length, 0);
    state.open = true;
    press(elsewhere);
    assert.equal(state.open, false);
    state.open = true;
    dispatchKey(escape());
    assert.equal(state.open, false);
});

test('unwire removes the click, the press listener and the Escape binding', t => {
    const before = bindingCount();
    const { button, root, state, unwire } = harness(t);
    assert.equal(bindingCount(), before + 1);
    unwire();
    assert.equal(bindingCount(), before);
    assert.deepEqual([button.listeners.length, root.listeners.length], [0, 0]);
    button.fire('click');
    assert.equal(state.open, false);
});
