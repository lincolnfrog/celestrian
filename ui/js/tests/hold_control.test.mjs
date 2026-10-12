/**
 * sv_util.holdControl — the held control: `_hot` from the press to the
 * release, one `onEnd` per hold however it ends (the release, a cancel,
 * a lost capture, a window blur), and nothing left listening afterwards.
 * Stub nodes: an EventTarget is all the helper needs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= new EventTarget();

const { holdControl } = await import('../session_view/sv_util.js');

/** A control: an EventTarget that takes (and counts) pointer capture. */
function control() {
    const node = new EventTarget();
    node.captured = 0;
    node.setPointerCapture = () => { node.captured++; };
    return node;
}
/** Dispatch a pointer-ish event on `target`. */
function fire(target, type, props = {}) {
    const ev = Object.assign(new Event(type), { button: 0, pointerId: 1, ...props });
    target.dispatchEvent(ev);
    return ev;
}
/** A control wired to record what its hold reports. */
function wired(opts = {}) {
    const node = control();
    const log = [];
    holdControl(node, {
        onStart: ev => { log.push('start'); return opts.decline ? false : undefined; },
        onMove: ev => log.push('move ' + ev.clientX),
        onEnd: ev => log.push(ev ? 'end' : 'lost'),
        ...opts.spec,
    });
    return { node, log };
}

test('press … release: hot in between, moves reported, one end', () => {
    const { node, log } = wired();
    assert.ok(!node._hot);
    fire(node, 'pointerdown');
    assert.equal(node._hot, true);
    assert.equal(node.captured, 1);
    fire(node, 'pointermove', { clientX: 5 });
    fire(node, 'pointermove', { clientX: 9 });
    fire(node, 'pointerup');
    assert.equal(node._hot, false);
    assert.deepEqual(log, ['start', 'move 5', 'move 9', 'end']);
    // Nothing is left listening: a stray move or release reports nothing.
    fire(node, 'pointermove', { clientX: 20 });
    fire(node, 'pointerup');
    assert.deepEqual(log, ['start', 'move 5', 'move 9', 'end']);
});

test('only the primary button holds', () => {
    const { node, log } = wired();
    fire(node, 'pointerdown', { button: 2 });
    fire(node, 'pointerdown', { button: 1 });
    assert.ok(!node._hot);
    assert.deepEqual(log, []);
});

test('a declined press holds nothing', () => {
    const { node, log } = wired({ decline: true });
    fire(node, 'pointerdown');
    assert.ok(!node._hot);
    assert.equal(node.captured, 0);
    fire(node, 'pointermove', { clientX: 5 });
    fire(node, 'pointerup');
    assert.deepEqual(log, ['start']);
});

for (const [how, end] of [
    ['a cancel', node => fire(node, 'pointercancel')],
    ['a lost capture', node => fire(node, 'lostpointercapture')],
    ['a window blur', () => fire(globalThis.window, 'blur')],
]) {
    test(`${how} ends the hold with nothing released — once`, () => {
        const { node, log } = wired();
        fire(node, 'pointerdown');
        fire(node, 'pointermove', { clientX: 5 });
        end(node);
        assert.equal(node._hot, false);
        assert.deepEqual(log, ['start', 'move 5', 'lost']);
        // The release that follows is not this hold's; nor is a second loss.
        fire(node, 'pointerup');
        fire(node, 'lostpointercapture');
        fire(globalThis.window, 'blur');
        fire(node, 'pointermove', { clientX: 7 });
        assert.deepEqual(log, ['start', 'move 5', 'lost']);
    });
}

test('the next press is a fresh hold: one set of listeners, one end', () => {
    const { node, log } = wired();
    fire(node, 'pointerdown');
    fire(node, 'pointercancel');
    fire(node, 'pointerdown');
    fire(node, 'pointermove', { clientX: 3 });
    fire(node, 'pointerup');
    assert.deepEqual(log, ['start', 'lost', 'start', 'move 3', 'end']);
});

test('a second press while held is ignored', () => {
    const { node, log } = wired();
    fire(node, 'pointerdown');
    fire(node, 'pointerdown', { pointerId: 2 });
    fire(node, 'pointerup');
    assert.deepEqual(log, ['start', 'end']);
});

test('capture: false — no capture taken; the release is heard at the window', () => {
    const { node, log } = wired({ spec: { capture: false } });
    fire(node, 'pointerdown');
    assert.equal(node._hot, true);
    assert.equal(node.captured, 0);
    // The pointer left the control: its release lands elsewhere.
    fire(globalThis.window, 'pointerup');
    assert.equal(node._hot, false);
    assert.deepEqual(log, ['start', 'end']);
});
