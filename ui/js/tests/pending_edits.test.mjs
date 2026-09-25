/**
 * PENDING EDITS: A GESTURE'S PREVIEW, AHEAD OF THE ENGINE
 * (session_view/pending_edits.js; view_model applyPendingEdits).
 *
 * A gesture sets its preview each move and the app re-derives from the
 * last polled state with it applied to clones of the edited nodes. The
 * clones take the shape the engine PUBLISHES once the edit lands, so a
 * preview and the landed state derive to the same picture.
 *
 * What this pins:
 *   (a) the publication shape: two or more pairs → `segments` (the
 *       single-window fields 0), one pair → loopStart/loopEnd (no
 *       `segments`), none → no map; windowActive follows; `originShift`
 *       moves origin and retime; `top` sets loopTop; only the path to
 *       an edited node is cloned, and the polled state is untouched;
 *   (b) previewed = landed: deriveViewModel with the preview equals
 *       deriveViewModel of the state the engine publishes after it —
 *       segments, a single window, a re-time, a top, inside a group;
 *   (c) the store: a shift resolves against its BASE to what is still
 *       outstanding (a live setTiming landing mid-drag never counts
 *       twice; a seek moves the base with the island zero); replace
 *       semantics; an answered preview drops once no gesture is live,
 *       an unanswered one COMMIT_HOLD_MAX_MS after its last touch, and
 *       nothing expires while a gesture is live; pendingEditOf reads a
 *       preview back (a new gesture builds on one still in flight).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel, applyPendingEdits } from '../view_model.js';
import { setPendingEdit, clearPendingEdit, clearAllPendingEdits,
         hasPendingEdits, pendingEditsFor, pendingEditOf }
    from '../session_view/pending_edits.js';
import { COMMIT_HOLD_MAX_MS } from '../session_view/gesture.js';
import { SCENE_Q as Q, PERF } from './helpers.mjs';

const clip = (id, originQ, durationQ, extra = {}) => ({
    id, name: id, type: 'clip', origin: Math.round(originQ * Q),
    duration: Math.round(durationQ * Q), effectiveQuantum: Q,
    loopStart: 0, loopEnd: 0, loopBypassed: false, windowActive: false,
    isMuted: false, isRecording: false, isPendingStart: false,
    periodSource: 'own', ...extra,
});
const island = (nodes, clockQ = 12.3) => ({
    id: 'root', type: 'stack', quantum: Q, islandZero: 0, definerId: '',
    isPlaying: true, masterPos: 0, islandPos: Math.round(clockQ * Q),
    perf: PERF, nodes,
});
const S = qs => qs.map(q => Math.round(q * Q));
const byId = (nodes, id) => {
    for (const n of nodes) {
        if (n.id === id) return n;
        const hit = n.nodes && byId(n.nodes, id);
        if (hit) return hit;
    }
    return null;
};
/* The lane fields a preview must reproduce exactly. */
const picture = vm => ({
    frameZero: vm.frameZero, seatedZero: vm.seatedZero, cycleQ: vm.cycleQ,
    lanes: vm.lanes.map(l => ({
        id: l.id, periodQ: l.periodQ, takeStartQ: l.takeStartQ,
        reps: l.reps, bandSegs: l.bandSegs || null, windowChipQ: l.windowChipQ,
        topQ: l.topQ, topHeardQ: l.topHeardQ, retimeQ: l.retimeQ,
    })),
});

/* ---------- (a) the publication shape ---------- */

test('(a) segments publish as the engine does: n ≥ 2, n = 1, none', () => {
    const base = island([clip('A', 0, 4), clip('B', 2, 12, {
        loopStart: 6 * Q, loopEnd: 10 * Q, windowActive: true })]);
    const multi = applyPendingEdits(base, new Map([['B',
        { segments: S([6, 7, 8, 10]) }]]));
    let b = byId(multi.nodes, 'B');
    assert.deepEqual(b.segments, S([6, 7, 8, 10]));
    assert.equal(b.loopStart, 0);
    assert.equal(b.loopEnd, 0);
    assert.equal(b.windowActive, true);
    const single = applyPendingEdits(base, { B: { segments: S([5, 9]) } });
    b = byId(single.nodes, 'B');
    assert.equal('segments' in b, false, 'one pair: no segments key');
    assert.equal(b.loopStart, 5 * Q);
    assert.equal(b.loopEnd, 9 * Q);
    assert.equal(b.windowActive, true);
    const cleared = applyPendingEdits(multi, { B: { segments: [] } });
    b = byId(cleared.nodes, 'B');
    assert.equal('segments' in b, false);
    assert.equal(b.loopEnd, 0);
    assert.equal(b.windowActive, false, 'no map: inactive');
    const bypassed = island([clip('B', 2, 12, { loopBypassed: true })]);
    assert.equal(byId(applyPendingEdits(bypassed, { B: { segments: S([6, 10]) } })
        .nodes, 'B').windowActive, false, 'a bypassed map stays inactive');
});

test('(a) originShift moves origin and retime; top sets loopTop', () => {
    const base = island([clip('B', 2, 12, { retime: 3 })]);
    const e = byId(applyPendingEdits(base, { B: { originShift: 500, top: 7 * Q } })
        .nodes, 'B');
    assert.equal(e.origin, 2 * Q + 500);
    assert.equal(e.retime, 503);
    assert.equal(e.loopTop, 7 * Q);
    const fresh = byId(applyPendingEdits(island([clip('B', 2, 12)]),
        { B: { originShift: -40 } }).nodes, 'B');
    assert.equal(fresh.retime, -40, 'an engine that publishes no retime: from 0');
});

test('(a) only the path to an edited node is cloned; the poll is untouched', () => {
    const member = clip('m', 2, 8);
    const other = clip('o', 0, 4);
    const group = { id: 'G', type: 'stack', anchored: true, origin: 2 * Q,
                    effectiveQuantum: Q, nodes: [member] };
    const base = island([other, group]);
    const frozen = JSON.stringify(base);
    const out = applyPendingEdits(base, { m: { originShift: Q } });
    assert.notEqual(out, base);
    assert.notEqual(out.nodes[1], group, 'the group on the path: cloned');
    assert.notEqual(out.nodes[1].nodes[0], member, 'the member: cloned');
    assert.equal(out.nodes[0], other, 'off the path: the same object');
    assert.equal(JSON.stringify(base), frozen, 'the polled state is untouched');
    assert.equal(applyPendingEdits(base, new Map()), base, 'nothing to apply: as is');
    assert.equal(applyPendingEdits(base, { nope: { top: 1 } }), base,
        'an unknown lane: as is');
});

/* ---------- (b) previewed = landed ---------- */

test('(b) a segments preview derives exactly as the landed map', () => {
    const polled = island([clip('A', 0, 4), clip('B', 2, 12, {
        loopStart: 6 * Q, loopEnd: 10 * Q, windowActive: true })]);
    const landed = island([clip('A', 0, 4), clip('B', 2, 12, {
        segments: S([6, 7, 8, 11]), windowActive: true })]);
    const pending = new Map([['B', { segments: S([6, 7, 8, 11]) }]]);
    assert.deepEqual(picture(deriveViewModel(polled, { pendingEdits: pending })),
                     picture(deriveViewModel(landed)));
    // …and back to one window.
    const landedOne = island([clip('A', 0, 4), clip('B', 2, 12, {
        loopStart: 7 * Q, loopEnd: 11 * Q, windowActive: true })]);
    assert.deepEqual(
        picture(deriveViewModel(landed, { pendingEdits: { B: { segments: S([7, 11]) } } })),
        picture(deriveViewModel(landedOne)));
});

test('(b) a re-time and a top preview derive exactly as they land', () => {
    const polled = island([clip('A', 0, 4), clip('B', 2, 12, {
        loopStart: 6 * Q, loopEnd: 10 * Q, windowActive: true })]);
    // The panel's start marker: the top onto raw 7Q with the
    // compensating shift (−1Q) so the ↺ keeps its moment.
    const landed = island([clip('A', 0, 4), clip('B', 1, 12, {
        loopStart: 6 * Q, loopEnd: 10 * Q, windowActive: true,
        loopTop: 7 * Q, retime: -Q })]);
    const pending = { B: { originShift: -Q, top: 7 * Q } };
    const pv = deriveViewModel(polled, { pendingEdits: pending });
    assert.deepEqual(picture(pv), picture(deriveViewModel(landed)));
    const b = pv.lanes.find(l => l.id === 'B');
    assert.equal(b.topQ, 7);
    assert.equal(b.retimeQ, -1);
    const before = deriveViewModel(polled).lanes.find(l => l.id === 'B');
    assert.equal(b.topHeardQ, before.topHeardQ, 'the ↺ kept its moment');
    assert.notEqual(b.takeStartQ, before.takeStartQ, 'the audio moved under it');
});

test('(b) a preview inside a group derives as it lands', () => {
    const mk = (originQ, retime = 0) => island([
        clip('A', 0, 4),
        { id: 'G', name: 'G', type: 'stack', anchored: true, origin: 0,
          effectiveQuantum: Q, nodes: [clip('m', originQ, 4, { retime })] },
    ]);
    assert.deepEqual(
        picture(deriveViewModel(mk(1), { pendingEdits: { m: { originShift: 2 * Q } } })),
        picture(deriveViewModel(mk(3, 2 * Q))));
});

/* ---------- (c) the store ---------- */

const polledNodes = s => id => byId(s.nodes, id);

test('(c) a shift resolves to what is still outstanding against its base', () => {
    clearAllPendingEdits();
    let s = island([clip('B', 2, 12)]);
    setPendingEdit('B', { originShift: 3 * Q }, 0);
    let o = pendingEditsFor(polledNodes(s), 0, 1, true).get('B');
    assert.equal(o.originShift, 3 * Q, 'nothing landed yet: all of it');
    // A live setTiming lands 2Q of it mid-drag.
    s = island([clip('B', 4, 12, { retime: 2 * Q })]);
    o = pendingEditsFor(polledNodes(s), 0, 2, true).get('B');
    assert.equal(o.originShift, Q, 'only the outstanding 1Q');
    const vm = deriveViewModel(s, { pendingEdits: new Map([['B', o]]) });
    assert.equal(vm.lanes[0].retimeQ, 3, 'retime: the whole shift, counted once');
    // The drag moves on: still measured from where it FOUND the take.
    setPendingEdit('B', { originShift: 4 * Q }, 3);
    o = pendingEditsFor(polledNodes(s), 0, 4, true).get('B');
    assert.equal(o.originShift, 2 * Q);
    clearAllPendingEdits();
});

test('(c) a seek moves the base with the island zero', () => {
    clearAllPendingEdits();
    setPendingEdit('B', { originShift: Q }, 0);
    pendingEditsFor(polledNodes(island([clip('B', 2, 12)])), 0, 1, true);
    // A seek: the island zero and every origin move back by 5Q.
    const sought = island([clip('B', -3, 12)]);
    sought.islandZero = -5 * Q;
    const o = pendingEditsFor(polledNodes(sought), -5 * Q, 2, true).get('B');
    assert.equal(o.originShift, Q, 'still exactly the shift');
    clearAllPendingEdits();
});

test('(c) each call replaces the preview; clear drops it and its base', () => {
    clearAllPendingEdits();
    const s = island([clip('B', 2, 12)]);
    setPendingEdit('B', { segments: S([1, 5]) }, 0);
    setPendingEdit('B', { top: 3 * Q }, 1);
    const o = pendingEditsFor(polledNodes(s), 0, 2, true).get('B');
    assert.deepEqual(Object.keys(o), ['top'], 'replaced, not merged');
    assert.equal(hasPendingEdits(), true);
    clearPendingEdit('B');
    assert.equal(hasPendingEdits(), false);
    assert.equal(pendingEditsFor(polledNodes(s), 0, 3, true), null);
});

test('(c) answered previews drop once no gesture is live — never while one is', () => {
    clearAllPendingEdits();
    const polled = island([clip('B', 2, 12)]);
    setPendingEdit('B', { originShift: Q, segments: S([6, 10]), top: 7 * Q }, 0);
    pendingEditsFor(polledNodes(polled), 0, 1, true);  // base: 2Q
    const landed = island([clip('B', 3, 12, { loopStart: 6 * Q, loopEnd: 10 * Q,
        windowActive: true, loopTop: 7 * Q, retime: Q })]);
    assert.ok(pendingEditsFor(polledNodes(landed), 0, 2, true),
        'live: kept (it is harmless — it resolves to nothing more)');
    assert.equal(pendingEditsFor(polledNodes(landed), 0, 3, true).get('B').originShift, 0);
    assert.equal(pendingEditsFor(polledNodes(landed), 0, 4, false), null,
        'the gesture over and the engine answered: dropped');
    assert.equal(hasPendingEdits(), false);
});

test('(c) every part must match: a top the engine does not publish never does', () => {
    clearAllPendingEdits();
    setPendingEdit('B', { segments: S([6, 10]), top: 7 * Q }, 0);
    const oldEngine = island([clip('B', 2, 12, { loopStart: 6 * Q, loopEnd: 10 * Q,
        windowActive: true })]);
    assert.ok(pendingEditsFor(polledNodes(oldEngine), 0, 10, false),
        'no loopTop published: not answered');
    assert.equal(pendingEditsFor(polledNodes(oldEngine), 0,
        10 + COMMIT_HOLD_MAX_MS + 1, false), null, 'but it expires');
    clearAllPendingEdits();
});

test('(c) an unanswered preview expires COMMIT_HOLD_MAX_MS after its last touch', () => {
    clearAllPendingEdits();
    const s = island([clip('B', 2, 12)]);
    setPendingEdit('B', { segments: S([6, 10]) }, 0);
    // A gesture live for 5 s touches it on every render…
    assert.ok(pendingEditsFor(polledNodes(s), 0, 5000, true), 'live: never expires');
    // …so the cap runs from the gesture's last render, not the last set.
    assert.ok(pendingEditsFor(polledNodes(s), 0, 5000 + COMMIT_HOLD_MAX_MS - 1, false),
        'released, within the cap: still shown (the commit is in flight)');
    assert.equal(pendingEditsFor(polledNodes(s), 0, 5000 + COMMIT_HOLD_MAX_MS + 1, false),
        null, 'past the cap: the refused preview lets go');
});

test('(c) pendingEditOf: the preview as set, until it expires', () => {
    // A gesture that begins while an earlier one's commit is in flight
    // builds on this (splice_handles previewer) instead of clearing it.
    clearAllPendingEdits();
    assert.equal(pendingEditOf('B', 0), null);
    setPendingEdit('B', { segments: S([6, 10]), originShift: Q, top: 7 * Q }, 0);
    const e = pendingEditOf('B', 1);
    assert.deepEqual(e, { segments: S([6, 10]), originShift: Q, top: 7 * Q });
    e.segments.push(0);
    assert.deepEqual(pendingEditOf('B', 2).segments, S([6, 10]), 'a copy');
    assert.deepEqual(Object.keys(pendingEditOf('B', 2)), ['segments', 'originShift', 'top']);
    setPendingEdit('B', { top: 3 * Q }, 10);
    assert.deepEqual(pendingEditOf('B', 11), { top: 3 * Q }, 'absent keys stay absent');
    assert.equal(pendingEditOf('B', 10 + COMMIT_HOLD_MAX_MS + 1), null, 'expired');
    clearAllPendingEdits();
});

test('(c) a vanished lane drops its preview', () => {
    clearAllPendingEdits();
    setPendingEdit('gone', { top: 1 }, 0);
    assert.equal(pendingEditsFor(() => null, 0, 1, true), null);
    assert.equal(hasPendingEdits(), false);
});
