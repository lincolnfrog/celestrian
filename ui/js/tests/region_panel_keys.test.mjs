/**
 * The region panel's keyboard laws (loop-region phase 1, 2026-09-23),
 * DOM-free:
 *   (a) THE NUDGE CHAIN IS ONE PINNED GESTURE (region_panel.js
 *       makeChainPin; diagnosis release-jump F3): the first ⌥← of a
 *       chain pins the frame, later presses inside the chain window
 *       extend it, and the pin drops exactly once — after the window
 *       elapses past the LAST press and that press's commit settles
 *       (capped) — so a chain of nudges never re-seats the frame per
 *       press;
 *   (b) [ ] { } never target the region panel's chrome (teleport.js
 *       isTransientHandle; diagnosis N5 — the walk got stuck on the
 *       viewport-pinned panel's cut handles);
 *   (c) a nudge's step is a whole number of samples (nudgeStepQ), so
 *       ⌥→ then ⌥← lands on the sample it left.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeChainPin, nudgeStepQ } from '../session_view/region_panel.js';
import { isTransientHandle } from '../session_view/teleport.js';

/** A manual timer queue (setTimeout twin). */
function timers() {
    let now = 0;
    let next = 1;
    const q = new Map();
    return {
        set: (fn, ms) => { const id = next++; q.set(id, { fn, at: now + ms }); return id; },
        clear: id => { q.delete(id); },
        async advance(ms) {
            const end = now + ms;
            for (;;) {
                const due = [...q.entries()].filter(([, t]) => t.at <= end)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                q.delete(due[0]);
                now = due[1].at;
                due[1].fn();
                await new Promise(r => setImmediate(r));  // settle promises
            }
            now = end;
            await new Promise(r => setImmediate(r));
        },
    };
}

function harness() {
    const t = timers();
    const log = [];
    const press = makeChainPin({
        pin: () => log.push('pin'), unpin: () => log.push('unpin'),
        windowMs: 800, capMs: 1500, setTimer: t.set, clearTimer: t.clear,
    });
    return { t, log, press };
}

test('a chain of presses pins once and unpins once, after the last', async () => {
    const { t, log, press } = harness();
    press(Promise.resolve());
    await t.advance(300);
    press(Promise.resolve());
    await t.advance(300);
    press(Promise.resolve());
    assert.deepEqual(log, ['pin']);            // one pin for the chain
    await t.advance(799);
    assert.deepEqual(log, ['pin']);            // window not yet elapsed
    await t.advance(2);
    assert.deepEqual(log, ['pin', 'unpin']);   // released exactly once
    await t.advance(5000);
    assert.deepEqual(log, ['pin', 'unpin']);
    // The next press starts a new chain.
    press(Promise.resolve());
    assert.deepEqual(log, ['pin', 'unpin', 'pin']);
});

test('the pin waits for the last commit to settle (capped)', async () => {
    const { t, log, press } = harness();
    let settle;
    press(new Promise(r => { settle = r; }));
    await t.advance(1000);
    assert.deepEqual(log, ['pin']);            // commit still in flight
    settle();
    await t.advance(1);
    assert.deepEqual(log, ['pin', 'unpin']);
    // A commit that never answers: released at the cap.
    press(new Promise(() => {}));
    await t.advance(800 + 1499);
    assert.deepEqual(log, ['pin', 'unpin', 'pin']);
    await t.advance(2);
    assert.deepEqual(log, ['pin', 'unpin', 'pin', 'unpin']);
});

test('a press while an earlier press settles keeps the chain pinned', async () => {
    const { t, log, press } = harness();
    let settle1;
    press(new Promise(r => { settle1 = r; }));
    await t.advance(900);                      // window elapsed, commit pending
    press(Promise.resolve());                  // the chain continues
    settle1();
    await t.advance(10);
    assert.deepEqual(log, ['pin']);            // the older press must not unpin
    await t.advance(800);
    assert.deepEqual(log, ['pin', 'unpin']);
});

test('a refused commit (no promise) still releases the chain', async () => {
    const { t, log, press } = harness();
    press(undefined);
    await t.advance(801);
    assert.deepEqual(log, ['pin', 'unpin']);
});

/** A DOM-less node: its classes and the ancestor classes `closest`
 * can find. */
const fakeNode = (own, ancestors = []) => ({
    classList: { contains: c => own.includes(c) },
    closest: sel => sel.split(',').map(s => s.trim().slice(1))
        .some(c => own.includes(c) || ancestors.includes(c)) ? {} : null,
});

test('teleports skip the region panel, previews and ghosts', () => {
    // A lane's own handles are targets.
    assert.equal(isTransientHandle(fakeNode(['win-bracket', 'start'], ['lane-body'])), false);
    assert.equal(isTransientHandle(fakeNode(['cut-handle'], ['overlay-layer'])), false);
    // The panel's cut handles (the lane's band code, in the panel) and
    // anything else inside .lane-region are not.
    assert.equal(isTransientHandle(fakeNode(['cut-handle'],
        ['region-overlay', 'region-strip', 'lane-region'])), true);
    // Drag previews and snap ghosts stay excluded.
    assert.equal(isTransientHandle(fakeNode(['win-bracket'], ['drag-preview-layer'])), true);
    assert.equal(isTransientHandle(fakeNode(['snap-ghost'])), true);
    // A heard lane's splices and ↺ (2026-09-24): the take tile's are
    // targets, a GHOST repeat's — the same splice again — is not.
    assert.equal(isTransientHandle(fakeNode(['lr-splice', 'lr-wrap'], ['lr-layer'])), false);
    assert.equal(isTransientHandle(fakeNode(['lr-top'], ['lr-layer'])), false);
    assert.equal(isTransientHandle(fakeNode(['lr-splice', 'lr-cut', 'lr-ghost'],
        ['lr-layer'])), true);
    assert.equal(isTransientHandle(fakeNode(['lr-top', 'lr-ghost'], ['lr-layer'])), true);
});

/* (c) THE ⌥ NUDGE'S STEP IS WHOLE SAMPLES (region_panel.js nudgeStepQ;
 * field audit 2026-10-01): each landing commits rounded to samples, so
 * a ⅛Q step that is not a whole number of samples (Q = 44100: 5512.5)
 * rounded up both ways — ⌥→ then ⌥←, outside the chain window, came
 * back one sample late. */
test('a ⅛Q nudge forward and back lands on the sample it left', () => {
    /** One nudge as the panel commits it: the region start read back
     * in Q from the polled samples, slid, rounded to samples. */
    const nudge = (startS, stepQ, Q) => Math.round((startS / Q + stepQ) * Q);
    for (const Q of [44100, 48000, 159744, 22051, 96001]) {
        const step = nudgeStepQ(0.125, Q);
        assert.ok(Number.isInteger(Math.round(step * Q)) &&
            Math.abs(step * Q - Math.round(step * Q)) < 1e-6, `Q ${Q}: whole samples`);
        assert.ok(Math.abs(step - 0.125) <= 0.5 / Q + 1e-12,
            `Q ${Q}: within half a sample of ⅛Q`);
        assert.equal(nudgeStepQ(-0.125, Q), -step, `Q ${Q}: ← is → reversed`);
        for (const startS of [0, 7 * Q, 7 * Q + 13, 53 * Q - 1]) {
            const there = nudge(startS, step, Q);
            assert.equal(nudge(there, -step, Q), startS, `Q ${Q} from ${startS}`);
            assert.equal(nudge(there, nudgeStepQ(-0.125, Q), Q), startS,
                `Q ${Q} from ${startS}: the ← key's own step`);
        }
    }
    // The raw ⅛Q at 44.1 kHz was the bug: back one sample late.
    const Q = 44100;
    assert.equal(nudge(nudge(7 * Q, 0.125, Q), -0.125, Q), 7 * Q + 1);
    // Whole-Q steps are whole samples already.
    assert.equal(nudgeStepQ(1, Q), 1);
    assert.equal(nudgeStepQ(-4, Q), -4);
    // No Q yet: the step as asked.
    assert.equal(nudgeStepQ(0.125, 0), 0.125);
});
