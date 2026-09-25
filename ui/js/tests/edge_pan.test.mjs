/**
 * EDGE PAN (session_view/edge_pan.js, loop-region phase 1,
 * 2026-09-23) — the one autoscroll rule the lane's same-scale reveal
 * and the region panel's drags share. What this pins:
 *   (a) a grab FAR from the edges behaves as the old rule did: pan
 *       inside the 36 px zone, speed ramping to the edge;
 *   (b) THE DIRECTION RULE (diagnosis release-jump F5): a grip grabbed
 *       INSIDE an edge zone never pans while the hand moves inward (a
 *       fine edit at the frame's edge) — only once it moves outward of
 *       the grab point by more than the slop;
 *   (c) the rAF loop: pans at the zone speed, stops at the take's end
 *       (canPan), stops when the hand leaves the zone, and stop() is
 *       final.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { edgePanStep, makeEdgePanner, canPanView, panViewQ0, PAN_EDGE_PX,
         PAN_MAX_PX_PER_S, PAN_GRAB_SLOP_PX } from '../session_view/edge_pan.js';

const L = 300;
const R = 1200;
const step = (x, grabX) => edgePanStep({ x, grabX, left: L, right: R });

test('a grab mid-surface: the zone pans, speed ramps toward the edge', () => {
    const g = 700;
    assert.deepEqual(step(700, g), { dir: 0, f: 0 });
    assert.equal(step(L + PAN_EDGE_PX + 1, g).dir, 0);
    // Just inside the left zone: the slowest pan.
    const s1 = step(L + PAN_EDGE_PX - 1, g);
    assert.equal(s1.dir, -1);
    assert.equal(s1.f, 0.15);
    // At the edge: full speed; beyond it, still full speed.
    assert.equal(step(L, g).f, 1);
    assert.equal(step(L - 50, g).f, 1);
    // Mirror on the right.
    const r = step(R - 9, g);
    assert.equal(r.dir, 1);
    assert.ok(Math.abs(r.f - (PAN_EDGE_PX - 9) / PAN_EDGE_PX) < 1e-12);
});

test('F5: a grip grabbed in the zone never pans on INWARD travel', () => {
    // The loop top at the frame's left edge: the handle grabbed there
    // (a splice's ⇧-drag since 2026-09-24; the start grip before) sits
    // 4 px inside the lane. Moving the hand right (a fine trim) must
    // not run the loop left.
    const g = L + 4;
    for (const x of [L + 4, L + 6, L + 10, L + 20, L + 35]) {
        assert.equal(step(x, g).dir, 0, `x=${x}`);
    }
    // Within the slop outward: still no pan.
    assert.equal(step(g - PAN_GRAB_SLOP_PX + 1, g).dir, 0);
    // Outward past the slop: pans left, ramping from the slowest speed.
    const out = step(g - PAN_GRAB_SLOP_PX - 2, g);
    assert.equal(out.dir, -1);
    assert.equal(out.f, 0.15);
    const far = step(g - PAN_GRAB_SLOP_PX - PAN_EDGE_PX, g);
    assert.equal(far.f, 1);
    // The end grip at the right edge: the mirror.
    const ge = R - 4;
    assert.equal(step(R - 12, ge).dir, 0);
    assert.equal(step(ge + PAN_GRAB_SLOP_PX + 3, ge).dir, 1);
    // A grip grabbed in the RIGHT zone still pans LEFT normally once
    // the hand crosses the surface to the left zone.
    assert.equal(step(L + 10, ge).dir, -1);
});

/** A manual rAF clock. */
function clock() {
    let t = 0;
    let next = 1;
    const cbs = new Map();
    return {
        raf: cb => { const id = next++; cbs.set(id, cb); return id; },
        caf: id => { cbs.delete(id); },
        now: () => t,
        frame(dt = 16) {
            t += dt;
            const run = [...cbs.entries()];
            cbs.clear();
            for (const [, cb] of run) cb(t);
        },
        pending: () => cbs.size,
    };
}

test('the pan loop: zone speed per frame, the take end, leaving the zone', () => {
    const c = clock();
    let q0 = 10;
    const pxPerQ = 100;
    const pans = [];
    const pan = makeEdgePanner({
        rect: () => ({ left: L, right: R }),
        grabX: 700,
        canPan: dir => dir < 0 ? q0 > 0 : q0 < 20,
        pxPerQ: () => pxPerQ,
        onPan: dq => { pans.push(dq); q0 = Math.max(0, q0 + dq); },
        raf: c.raf, caf: c.caf, now: c.now,
    });
    pan.update(L);                        // at the edge: full speed
    assert.equal(pan.active(), true);
    c.frame(16);
    assert.equal(pans.length, 1);
    const expect = -(PAN_MAX_PX_PER_S * 16 / 1000) / pxPerQ;
    assert.ok(Math.abs(pans[0] - expect) < 1e-12);
    // A long stall is capped (no leap after a dropped frame).
    c.frame(500);
    assert.ok(Math.abs(pans[1] - -(PAN_MAX_PX_PER_S * 64 / 1000) / pxPerQ) < 1e-12);
    // Leaving the zone stops the loop.
    pan.update(700);
    assert.equal(pan.active(), false);
    assert.equal(c.pending(), 0);
    // At the take's start the loop stops on its own.
    q0 = 0.01;
    pan.update(L);
    for (let i = 0; i < 10; i++) c.frame(16);
    assert.equal(q0, 0);
    assert.equal(c.pending(), 0);
    assert.equal(pan.active(), false);
    // stop() is final.
    q0 = 10;
    pan.update(R);
    pan.stop();
    const n = pans.length;
    c.frame(16);
    assert.equal(pans.length, n);
});

test('the pan loop honours the direction rule (F5)', () => {
    const c = clock();
    const pans = [];
    const pan = makeEdgePanner({
        rect: () => ({ left: L, right: R }),
        grabX: L + 4,
        canPan: () => true,
        pxPerQ: () => 100,
        onPan: dq => pans.push(dq),
        raf: c.raf, caf: c.caf, now: c.now,
    });
    for (const x of [L + 8, L + 14, L + 20]) { pan.update(x); c.frame(16); }
    assert.equal(pans.length, 0);
    pan.update(L - 10);
    c.frame(16);
    assert.equal(pans.length, 1);
    assert.ok(pans[0] < 0);
});

test('a view anchored OUT of range glides — it never snaps into range (review 2026-09-23)', () => {
    // The reveal anchors its view so the grabbed bound sits under the
    // hand. A loop at the END of a 16Q take, frame 12Q: the view starts
    // at q0 = 12.95, past totalQ − spanQ = 4. A leftward pan frame must
    // move it by dq — not jump it to 4 (the 8.96Q leap the review saw).
    assert.equal(canPanView(-1, 12.95, 12, 16), true);
    assert.equal(canPanView(+1, 12.95, 12, 16), false);   // already past the end
    assert.ok(Math.abs(panViewQ0(12.95, -0.1, 12, 16) - 12.85) < 1e-12);
    // A take SHORTER than the frame (4Q take windowed [2,4), 6Q frame):
    // the view starts at q0 = 1.98, running past the take's end. A
    // leftward frame glides to 1.93 — the old clamp jumped it to 0 and
    // the trim landed as the whole take.
    assert.equal(canPanView(+1, 1.98, 6, 4), false);
    assert.ok(Math.abs(panViewQ0(1.98, -0.05, 6, 4) - 1.93) < 1e-12);
    // A view wider than the take that already shows all of it cannot
    // pan either way.
    assert.equal(canPanView(-1, -1.98, 6, 4), false);
    assert.equal(canPanView(+1, -1.98, 6, 4), false);
    // In range, it still stops exactly at the take's edges.
    assert.equal(panViewQ0(0.02, -0.5, 3, 12), 0);
    assert.equal(panViewQ0(8.9, 0.5, 3, 12), 9);
    // And a step never moves a view the wrong way.
    assert.equal(panViewQ0(-1, -0.2, 6, 4), -1);
    assert.equal(panViewQ0(13, 0.2, 12, 16), 13);
});
