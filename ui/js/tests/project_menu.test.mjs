/**
 * project_menu.js — the import and bounce verdicts, where a placement
 * lands, and the project's identity in the chrome: a birth is announced
 * once and carries the unborn session's folds; an open is neither.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectMenu, importVerdict, bounceVerdict, importOriginAt }
    from '../project_menu.js';
import { createShellIo, NO_ANSWER } from '../shell_io.js';
import { notePoll, noteView, indexNodes } from '../session_facts.js';
import { foldedStacks, toggleFolded, resetViewPrefsForTest } from '../view_prefs.js';

/* ---------- pure ---------- */

test('importVerdict: imported, refused under a live take, or cancelled-or-refused', () => {
    assert.equal(importVerdict(true, '', false), 'Imported — ⌘Z to undo');
    assert.equal(importVerdict(true, 'kick.wav at Q2', false),
        'Imported kick.wav at Q2 — ⌘Z to undo');
    assert.equal(importVerdict(false, 'at Q2', true), 'Import refused — a take is live');
    assert.match(importVerdict(false, '', false), /^Import cancelled — or refused/);
    assert.equal(importVerdict(true, '', true), 'Imported — ⌘Z to undo',
        'an answer of true is believed');
});

test('bounceVerdict: bounced, refused under a live take, or cancelled', () => {
    assert.equal(bounceVerdict(true, false), 'Bounced');
    assert.equal(bounceVerdict(false, true), 'Bounce refused — a take is live');
    assert.equal(bounceVerdict(false, false), 'Bounce cancelled');
});

test('importOriginAt: whole Qs from where the frame RESTS; 0 before a frame exists', () => {
    const frame = { zero: 900, rest: 1000, seat: 1000, quantum: 480 };
    assert.equal(importOriginAt(0, frame), 1000);
    assert.equal(importOriginAt(3, frame), 1000 + 3 * 480,
        'never the passing zero of a re-seat tween');
    assert.equal(importOriginAt(3, null), 0);
});

/* ---------- the menu's verbs over a fake bridge ---------- */

/** A menu over a recorded bridge; `answers` maps a method to its answer
 * (a value or a function of the args). The document holds the one
 * element the module patches. */
function harness(answers = {}) {
    const calls = [];
    const lines = [];
    const button = { textContent: 'Project ▾', title: '' };
    globalThis.document = {
        getElementById: id => (id === 'project-menu-btn' ? button : null),
    };
    const io = createShellIo({
        callNative: async (name, ...args) => {
            calls.push([name, ...args]);
            const a = answers[name];
            return typeof a === 'function' ? a(...args) : (a === undefined ? null : a);
        },
        setLogLine: m => lines.push(m),
    });
    const menu = createProjectMenu({
        io,
        createAndSelect: create => create(),
        soleSelectedId: () => null,
    });
    return { menu, calls, lines, button, answers };
}

/** getProjectInfo's record. */
const info = (born, extra = {}) =>
    ({ id: '20261011-01', name: '20261011-01', born, ...extra });

test('an unborn session: the quiet button, nothing announced', async () => {
    const { menu, lines, button } = harness({ getProjectInfo: info(false, { id: '', name: '' }) });
    await menu.refresh();
    assert.equal(menu.id(), '');
    assert.equal(button.textContent, 'Project ▾');
    assert.deepEqual(lines, []);
});

test('birth: announced once, the button takes the name, the unborn folds move to the project', async () => {
    resetViewPrefsForTest();
    toggleFolded('', 'group-1');
    const h = harness({ getProjectInfo: info(false, { id: '' }) });
    await h.menu.refresh();
    h.answers.getProjectInfo = info(true, { name: 'Slow Burn' });
    await h.menu.refresh();
    assert.deepEqual(h.lines, ['Project 20261011-01 created — mirroring to disk']);
    assert.equal(h.button.textContent, 'Slow Burn ▾');
    assert.equal(h.button.title, '20261011-01 — save, rename, templates');
    assert.equal(h.menu.id(), '20261011-01');
    assert.equal(foldedStacks('20261011-01').has('group-1'), true);
    assert.equal(foldedStacks('').size, 0);

    await h.menu.refresh();
    assert.equal(h.lines.length, 1, 'a project already born is not announced again');
});

test('an open is not a birth: no "created", no folds carried over', async () => {
    resetViewPrefsForTest();
    toggleFolded('', 'group-1');
    const h = harness({ getProjectInfo: info(false, { id: '' }), loadSession: true });
    await h.menu.refresh();
    h.answers.getProjectInfo = info(true);
    await h.menu.openWithDialog();
    assert.deepEqual(h.calls.map(c => c[0]), ['getProjectInfo', 'loadSession', 'getProjectInfo']);
    assert.deepEqual(h.calls[1], ['loadSession', '']);
    assert.deepEqual(h.lines, ['Project opened']);
    assert.equal(h.menu.id(), '20261011-01');
    assert.equal(foldedStacks('20261011-01').has('group-1'), false);
});

test('a cancelled open leaves the session as it was — and a later birth is still a birth', async () => {
    const h = harness({ getProjectInfo: info(false, { id: '' }), loadSession: false });
    await h.menu.refresh();
    await h.menu.openWithDialog();
    assert.deepEqual(h.lines, ['Open cancelled']);
    h.answers.getProjectInfo = info(true);
    await h.menu.refresh();
    assert.equal(h.lines.at(-1), 'Project 20261011-01 created — mirroring to disk');
});

test('save: checkpoints, then says "Saved"; saving an unborn session announces the birth instead', async () => {
    const born = harness({ getProjectInfo: info(true, { name: 'Slow Burn' }), saveProjectNow: true });
    await born.menu.refresh();
    await born.menu.save();
    assert.deepEqual(born.calls.map(c => c[0]),
        ['getProjectInfo', 'saveProjectNow', 'getProjectInfo']);
    assert.equal(born.lines.at(-1), 'Saved Slow Burn');

    const unborn = harness({ getProjectInfo: info(false, { id: '' }), saveProjectNow: true });
    await unborn.menu.refresh();
    unborn.answers.getProjectInfo = info(true);
    await unborn.menu.save();
    assert.deepEqual(unborn.lines, ['Project 20261011-01 created — mirroring to disk']);
});

test('save: a save that did not reach the disk never says "Saved"', async () => {
    const failed = harness({ getProjectInfo: info(true, { name: 'Slow Burn' }), saveProjectNow: false });
    await failed.menu.refresh();
    await failed.menu.save();
    assert.equal(failed.lines.at(-1), 'Not saved — the project folder could not be written');
    assert.ok(!failed.lines.some(line => /^Saved/.test(line)));

    // The folder was made but the write failed: the birth is real, the
    // save is not — and the line left standing says so.
    const halfBorn = harness({ getProjectInfo: info(false, { id: '' }), saveProjectNow: false });
    await halfBorn.menu.refresh();
    halfBorn.answers.getProjectInfo = info(true);
    await halfBorn.menu.save();
    assert.equal(halfBorn.lines.at(-1), 'Not saved — the project folder could not be written');

    const lost = harness({ getProjectInfo: info(true) });
    await lost.menu.refresh();
    await lost.menu.save();
    assert.equal(lost.lines.at(-1), NO_ANSWER);
});

test('a lost or unreadable project read keeps the last good identity', async () => {
    const h = harness({ getProjectInfo: info(true) });
    await h.menu.refresh();
    for (const bad of [null, 'not a record', '', () => { throw new Error('backend fell over'); }]) {
        h.answers.getProjectInfo = bad;
        await h.menu.refresh();
        assert.equal(h.menu.id(), '20261011-01');
    }
});

test('import through the chooser: into the root when no target is named, at the frame\'s rest + q', async () => {
    const h = harness({ importAudioWithDialog: true });
    notePoll({ id: 'root', nodes: [] }, indexNodes([]));
    noteView({}, { zero: 0, rest: 1000, quantum: 480 });
    assert.equal(await h.menu.importWithDialog('', 2), true);
    assert.equal(await h.menu.importWithDialog('group-1', 0), true);
    assert.deepEqual(h.calls, [
        ['importAudioWithDialog', 'root', 1960],
        ['importAudioWithDialog', 'group-1', 1000],
    ]);
    assert.deepEqual(h.lines, ['Imported at Q2 — ⌘Z to undo', 'Imported — ⌘Z to undo']);
});

test('import with no root to land in makes no call', async () => {
    const h = harness({ importAudioWithDialog: true });
    notePoll({ nodes: [] }, indexNodes([]));
    assert.equal(await h.menu.importWithDialog('', 0), false);
    assert.deepEqual(h.calls, []);
});

test('a dropped file with a path imports directly; one with only a name goes through the chooser, same Q', async () => {
    const h = harness({ importAudio: true, importAudioWithDialog: false });
    notePoll({ id: 'root', nodes: [] }, indexNodes([]));
    noteView({}, { zero: 0, rest: 0, quantum: 480 });
    await h.menu.onImportDrop('lane-1', 3, [{ name: 'kick.wav', path: '/audio/kick.wav' }]);
    await h.menu.onImportDrop('lane-1', 3, [{ name: 'kick.wav' }]);
    assert.deepEqual(h.calls.filter(c => c[0] !== 'getGraphState'), [
        ['importAudio', 'lane-1', '/audio/kick.wav', 1440],
        ['importAudioWithDialog', 'lane-1', 1440],
    ]);
    assert.equal(h.lines[0], 'Imported kick.wav at Q3 — ⌘Z to undo');
    assert.match(h.lines[1], /^Import cancelled/);
});

test('an import the engine refuses is blamed on a take only when one is live then', async () => {
    const hot = [{ id: 'a', type: 'clip', isRecording: true }];
    const h = harness({
        importAudioWithDialog: false,
        getGraphState: () => ({ id: 'root', nodes: hot }),  // a take began since the poll
    });
    notePoll({ id: 'root', nodes: [] }, indexNodes([]));
    await h.menu.importWithDialog('', 0);
    assert.equal(h.lines.at(-1), 'Import refused — a take is live');

    const idle = harness({ importAudioWithDialog: false,
                           getGraphState: () => ({ id: 'root', nodes: [] }) });
    notePoll({ id: 'root', nodes: hot }, indexNodes(hot));  // the poll's take has ended
    await idle.menu.importWithDialog('', 0);
    assert.match(idle.lines.at(-1), /^Import cancelled/);
    notePoll({ id: 'root', nodes: [] }, indexNodes([]));
});
