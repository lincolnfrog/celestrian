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
 *       viewport-pinned panel's cut handles).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeChainPin } from '../session_view/region_panel.js';
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
