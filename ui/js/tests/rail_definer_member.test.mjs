/**
 * THE RAIL OF A MIC IN THE TEMPO-DEFINING GROUP (the trim view, Q13 for
 * groups; session_view/rail.js patchRail). Such a mic is a committed
 * loop with its own takes, but its ● is not its own: the group is one
 * take, and a new one is the group's ● — every track, one performance.
 * So the rail offers no verb on the mic's ●, says whose it is, and its
 * take chip does not promise a ● it does not have.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
    addEventListener() {}, removeEventListener() {},
};
globalThis.document = globalThis.document || {
    activeElement: null, getElementById() { return null; },
    querySelectorAll() { return []; },
};

const { patchRail } = await import('../session_view/rail.js');
const { takeVerbOwner } = await import('../session_view/take_menu.js');
const { deriveViewModel } = await import('../view_model.js');
const { clipAt: clip, groupAt, island, laneOf } = await import('./helpers.mjs');

/** A rail control that keeps what the patch writes on it. */
function fakeControl() {
    const classes = new Set();
    return {
        style: {}, dataset: {}, title: '', textContent: '', disabled: false,
        classList: {
            toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
            add(...cs) { cs.forEach(c => classes.add(c)); },
            remove(...cs) { cs.forEach(c => classes.delete(c)); },
            contains: c => classes.has(c),
        },
    };
}

/** A lane row holding one control per selector the rail patches (the
 * two dials aside: they draw themselves). */
function fakeRow() {
    const controls = new Map();
    const row = fakeControl();
    row.querySelector = sel => {
        if (sel === '.pan-dial' || sel === '.gain-dial') return null;
        if (!controls.has(sel)) controls.set(sel, fakeControl());
        return controls.get(sel);
    };
    return row;
}

/** The rail of lane `id` after one patch of `vm`. */
function railOf(vm, id) {
    const row = fakeRow();
    patchRail(row, laneOf(vm, id), vm);
    return { arm: row.querySelector('.arm-btn'), take: row.querySelector('.take-btn') };
}

/** A group-recorded kit (one take, two mics) that defines Q: the trim
 * view. m1 has three takes, m2 one. */
const trimView = () => deriveViewModel(island([groupAt('K', 0, [
    clip('m1', 0, 4, { takes: 3, activeTake: 1 }),
    clip('m2', 0, 4)])], { definerId: 'K' }));

test('a mic of the tempo-defining group: its ● offers nothing and says whose it is', () => {
    const vm = trimView();
    assert.equal(laneOf(vm, 'm1').definerMember, true, 'premise: the trim view');
    for (const id of ['m1', 'm2']) {
        const { arm } = railOf(vm, id);
        assert.equal(arm.disabled, true, `${id}: no verb here`);
        assert.equal(arm.classList.contains('retake'), false,
            `${id}: it does not wear the new-take mark`);
        assert.equal(arm.classList.contains('on'), false);
        assert.equal(arm.title,
            'This track is part of the group that sets the tempo — take it ' +
            'again with the group’s ● (all its tracks, one performance)');
    }
});

test('the group that sets the tempo keeps the verb: a new take of its tracks', () => {
    const { arm } = railOf(trimView(), 'K');
    assert.equal(arm.disabled, false);
    assert.equal(arm.classList.contains('retake'), true);
    assert.match(arm.title, /^New take of 2 tracks — one performance from the group top/);
});

test('its take chip shows its takes, and points at the group’s ● for another', () => {
    const vm = trimView();
    const many = railOf(vm, 'm1').take;
    assert.equal(many.style.display, '', 'shown');
    assert.equal(many.textContent, 'T2/3');
    assert.equal(many.title, 'Take 2 of 3 sounds — click for the list');
    const one = railOf(vm, 'm2').take;
    assert.equal(one.textContent, 'T1');
    assert.equal(one.title,
        'One take — the group’s ● records another; click for the list');
    // The take list's own note reads the same owner.
    assert.equal(takeVerbOwner(laneOf(vm, 'm2')), 'the group’s ●');
    assert.equal(takeVerbOwner({ kind: 'clip' }), '●');
});

test('an ordinary committed track keeps its own ●: a new take of the slot', () => {
    // The same kit beside another track, Q locked: no trim view.
    const vm = deriveViewModel(island([groupAt('K', 0, [
        clip('m1', 0, 4, { takes: 3, activeTake: 1 }), clip('m2', 0, 4)]),
        clip('bass', 0, 4)]));
    assert.equal(laneOf(vm, 'm2').definerMember, undefined, 'premise: no trim view');
    const { arm, take } = railOf(vm, 'm2');
    assert.equal(arm.disabled, false);
    assert.equal(arm.classList.contains('retake'), true);
    assert.match(arm.title, /^New take — one period from the slot top/);
    assert.equal(take.title, 'One take — ● records another; click for the list');
    // A committed one-shot is the other clip with no verb, for its own
    // reason.
    const shot = deriveViewModel(island([clip('a', 0, 4),
        clip('hit', 0, 1, { periodSource: 'context' })]));
    const hit = railOf(shot, 'hit').arm;
    assert.equal(hit.disabled, true);
    assert.equal(hit.title, 'One-shot: loop it (↺) to record a new take');
});
