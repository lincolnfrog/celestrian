/**
 * The region panel's keyboard laws (loop-region phase 1, 2026-09-23),
 * DOM-free:
 *   (a) THE NUDGE CHAIN IS ONE PINNED GESTURE (region_panel.js
 *       makeChainPin; diagnosis release-jump F3): the first ← of a
 *       chain pins the frame, later presses inside the chain window
 *       extend it, and the pin drops exactly once — after the window
 *       elapses past the LAST press and that press's commit settles
 *       (capped) — so a chain of nudges never re-seats the frame per
 *       press;
 *   (b) [ ] { } never target a drag preview, a snap ghost or a ghost
 *       repeat's handle (teleport.js isTransientHandle; the panel's own
 *       handles are out of the walk's reach — region_panel_view.spec.js);
 *   (c) the edit bar's hint: why a selected track shows no panel;
 *   (d) the nudge chain's base: the last target sent, until an undo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// The selection's painters only query the document.
globalThis.document ??= { querySelectorAll: () => [], getElementById: () => null };

const { makeChainPin, nudgeRegion, noteNudgePublished } =
    await import('../session_view/region_nudge.js');
const { noPanelReason } = await import('../session_view/region_dock.js');
const { isTransientHandle } = await import('../session_view/teleport.js');
const { selectOnly } = await import('../session_view/selection.js');
const { ctx } = await import('../session_view/context.js');

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

/* THE NUDGE CHAIN'S BASE (region_panel.js nudgeRegion): presses faster
 * than the poll slide from the last target sent — until the engine has
 * published that target; from then on a different published region is
 * someone else's edit (an undo), and the next press slides from what is
 * shown. A fake strip stands in for the selected track's panel; a
 * "poll" replaces its band state, as a patch does. */
function nudgeHarness() {
    const Q = 1000;
    const sent = [];
    ctx.cb = { onSetSegments: (id, flat) => { sent.push(flat.map(s => s / Q)); } };
    const strip = {};
    const publish = segs => {
        strip._bandState = { laneId: 'n', segs, totalQ: 12, editable: true, quantum: Q };
        noteNudgePublished(strip);
    };
    selectOnly('n');
    ctx.laneEls.set('n', { _region: { strip, nav: { style: { display: '' } } } });
    return { sent, publish, done: () => ctx.laneEls.delete('n') };
}

test('presses faster than the poll chain off the last target sent', () => {
    const h = nudgeHarness();
    try {
        h.publish([[4, 8]]);
        nudgeRegion(1);
        nudgeRegion(1);              // no poll in between
        h.publish([[5, 9]]);         // the poll is one press behind
        nudgeRegion(1);
        assert.deepEqual(h.sent, [[5, 9], [6, 10], [7, 11]]);
    } finally { h.done(); }
});

test('a press after an undo slides from the region as shown, not the undone target', () => {
    const h = nudgeHarness();
    try {
        h.publish([[4, 8]]);
        nudgeRegion(1);
        h.publish([[5, 9]]);         // the engine answered: the region moved
        h.publish([[4, 8]]);         // ⌘Z: it is back
        nudgeRegion(1);              // still inside the chain window
        assert.deepEqual(h.sent, [[5, 9], [5, 9]], 'one Q from where it is shown');
    } finally { h.done(); }
});

/** A DOM-less node: its classes and the ancestor classes `closest`
 * can find. */
const fakeNode = (own, ancestors = []) => ({
    classList: { contains: c => own.includes(c) },
    closest: sel => sel.split(',').map(s => s.trim().slice(1))
        .some(c => own.includes(c) || ancestors.includes(c)) ? {} : null,
});

test('teleports skip previews and ghosts', () => {
    // A lane's own handles are targets.
    assert.equal(isTransientHandle(fakeNode(['win-bracket', 'start'], ['lane-body'])), false);
    assert.equal(isTransientHandle(fakeNode(['cut-handle'], ['overlay-layer'])), false);
    // Drag previews and snap ghosts are not.
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

/* (c) THE EDIT BAR'S HINT (region_dock.js noPanelReason): the panel
 * lives in a bar at the foot of the session view, so a selected track
 * with no panel says why instead of leaving the bar blank; a track with
 * a take of 2Q or more shows its panel (null). */
test('the edit bar says why a selected track has no panel', () => {
    const lane = extra => ({ kind: 'clip', bandTotalQ: 8, ...extra });
    assert.equal(noPanelReason(lane()), null);
    assert.equal(noPanelReason(lane({ bandTotalQ: 2 })), null);
    assert.match(noPanelReason(lane({ bandTotalQ: 1 })), /^A 1Q take/);
    assert.match(noPanelReason(lane({ bandTotalQ: 1.5 })), /^A 1\.5Q take/);
    assert.match(noPanelReason(lane({ bandTotalQ: 0 })), /Nothing recorded/);
    assert.match(noPanelReason(lane({ isQDefiner: true })), /sets Q/);
    assert.match(noPanelReason(lane({ underMap: true })), /group/);
    assert.match(noPanelReason(lane({ definerMember: true })), /group/);
    // A take in progress outranks the rest: no region exists yet.
    assert.match(noPanelReason(lane({ recording: true, isQDefiner: true })), /Recording/);
    // The raw inspector has its own surface: no hint, no panel.
    assert.equal(noPanelReason(lane({ windowEditing: true })), null);
});
