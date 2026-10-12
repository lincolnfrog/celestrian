/**
 * The bridge protocol contract: both backends expose exactly the methods
 * ui/js/protocol.js declares, and answer each in the KIND it declares —
 *   - the C++ bridge: the table in src/bridge_dispatch.cc and the window
 *     verbs of src/main_component.cc, parsed from source;
 *   - the mock: the `handlers` table of ui/js/mock_backend.js, by name,
 *     and its dispatch by calling it.
 * A method registered on one side only leaves the page's promise hanging
 * or silently does nothing; a verb registered in the wrong kind makes
 * the status line announce what the engine refused.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BRIDGE_METHODS, BRIDGE_METHOD_NAMES, BOOL_METHODS, VOID_METHODS,
         READ_METHODS, QUIET_POLLS, answerKind } from '../protocol.js';
import { handlers, callNative, loadScenario, readState, advanceBy }
    from '../mock_backend.js';
import { repoRoot, recordTake, nodeById } from './helpers.mjs';

const protocol = new Set(BRIDGE_METHOD_NAMES);
const kindOf = Object.fromEntries(BRIDGE_METHODS.map(m => [m.name, answerKind(m)]));

/** Every registration of the C++ bridge: name → the kind it answers in.
 * The table's three entry forms are the three kinds. A window verb
 * (bindWindowVerb) is read by what it answers when its arguments are
 * missing — `false`: a verb that can be refused — and a verb bound over
 * its table entry (bindOverTable) answers as that entry does. */
function cppRegistrations() {
    const read = rel => readFileSync(path.join(repoRoot, rel), 'utf8');
    const kinds = new Map();
    const each = (src, regex, kind) => {
        let match, found = 0;
        while ((match = regex.exec(src)) !== null) {
            kinds.set(match[1], typeof kind === 'function' ? kind(match) : kind);
            found++;
        }
        return found;
    };
    const table = read('src/bridge_dispatch.cc');
    const inTable = each(table, /\b(?:voidMethod)\(\s*"(\w+)"/g, 'void') +
        each(table, /\b(?:boolMethod)\(\s*"(\w+)"/g, 'bool') +
        each(table, /\b(?:valueMethod)\(\s*"(\w+)"/g, 'value');
    assert.ok(inTable > 0, 'no entries found in src/bridge_dispatch.cc — parser broken?');

    const shell = read('src/main_component.cc');
    const windowVerbs = each(shell,
        /\bbindWindowVerb\(\s*"(\w+)",\s*\d+,\s*([^,]+),/g,
        m => (m[2].trim() === 'false' ? 'bool' : 'value'));
    assert.ok(windowVerbs > 0, 'no window verbs found in src/main_component.cc — parser broken?');
    const over = /\bbindOverTable\(\s*"(\w+)"/g;
    for (let m; (m = over.exec(shell)) !== null;) {
        assert.ok(kinds.has(m[1]), `bindOverTable("${m[1]}") names no table entry`);
    }
    return kinds;
}

test('mock backend implements exactly the protocol surface', () => {
    const mockMethods = new Set(Object.keys(handlers));
    for (const name of protocol) {
        assert.ok(mockMethods.has(name),
            `mock_backend.js is missing protocol method '${name}'`);
    }
    for (const name of mockMethods) {
        assert.ok(protocol.has(name),
            `mock_backend.js implements '${name}' which is not in protocol.js`);
    }
});

test('C++ bridge binds exactly the protocol surface, each verb in the kind protocol.js declares', () => {
    const cpp = cppRegistrations();
    for (const name of protocol) {
        assert.ok(cpp.has(name),
            `the C++ bridge (bridge_dispatch.cc + main_component.cc) is missing protocol method '${name}'`);
        assert.equal(cpp.get(name), kindOf[name],
            `'${name}': the C++ bridge registers it as ${cpp.get(name)}, ` +
            `protocol.js declares ${kindOf[name]}`);
    }
    for (const name of cpp.keys()) {
        assert.ok(protocol.has(name),
            `the C++ bridge binds '${name}' which is not in protocol.js`);
    }
});

test('a read changes nothing: every read answers a value, and the heartbeat is two of them', () => {
    for (const name of READ_METHODS) {
        assert.equal(kindOf[name], 'value', `'${name}' is marked read`);
        assert.match(name, /^(get|list|ping)/, `'${name}' reads like a query`);
    }
    for (const name of QUIET_POLLS) assert.ok(READ_METHODS.has(name), name);
});

/* ---------- the mock's answers ---------- */

const SONG = { steps: [{ name: 'A', len: 1000 }, { name: 'B', len: 1000 }], gates: {} };
const eqOf = id => nodeById(id, readState().nodes).effects.chain.find(s => s.type === 'eq').slot;
const pluginOf = id => nodeById(id, readState().nodes).effects.chain.find(s => s.type === 'vst3').slot;

/** The scene every case starts from: Q = 1000; `a` and `b` committed
 * loops one Q long, `e` an empty track, `g` an empty group. */
async function scene() {
    loadScenario('empty');
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 1000);
    const e = await callNative('createNode', 'clip', '');
    const g = await callNative('createNode', 'stack', '');
    return { a, b, e, g, root: readState().id };
}

/** A second take on `id`, run to its end. */
async function secondTake(id) {
    await callNative('newTake', id);
    advanceBy(3000);
}
const arm = s => callNative('startRecordingInNode', s.e);

/**
 * One row per verb that answers whether it applied:
 *   verb, applied, refused — each `{ args: scene => [...], before? }`,
 *   `before` setting the scene up (awaited). null: the mock has no such
 *   case (it cannot refuse a save, and never moves the OS cursor).
 */
const BOOL_CASES = [
    ['togglePlayback', { args: () => [] }, { before: arm, args: () => [] }],
    ['startRecordingInNode', { args: s => [s.e] }, { args: () => ['no-such-node'] }],
    ['stopRecordingInNode', { before: arm, args: s => [s.e] }, { args: s => [s.e] }],
    ['newTake', { args: s => [s.a] }, { args: s => [s.e] }],
    ['selectTake', { before: s => secondTake(s.a), args: s => [s.a, 0] },
                   { args: s => [s.a, 9] }],
    ['deleteTake', { before: s => secondTake(s.a), args: s => [s.a, 1] },
                   { args: s => [s.a, 0] }],
    ['setComp', { before: s => secondTake(s.a), args: s => [s.a, [0]] },
                { args: s => [s.a, [0, 1]] }],
    ['dumpStateToFile', { args: () => ['{}'] }, null],
    ['deleteNode', { args: s => [s.e] }, { args: () => ['no-such-node'] }],
    ['renameNode', { args: s => [s.e, 'vox'] }, { args: s => [s.e, 'New Clip'] }],
    ['reorderNode', { args: s => [s.e, s.root, 0] }, { args: s => [s.e, s.root, 2] }],
    ['undo', { args: () => [] }, { before: arm, args: () => [] }],
    ['redo', { before: () => callNative('undo'), args: () => [] }, { args: () => [] }],
    ['cancelGesture', { before: s => callNative('setLoopPoints', s.b, 0, 500), args: s => [s.b] },
                      { args: s => [s.b] }],
    ['saveSession', { args: () => ['/sessions/one'] }, null],
    ['loadSession', { before: () => callNative('saveSession', '/sessions/one'),
                      args: () => ['/sessions/one'] },
                    { args: () => ['/sessions/none'] }],
    ['bounce', { args: s => [s.a, '/out.wav'] }, { args: s => [s.e, '/out.wav'] }],
    ['bounceWithDialog', { args: s => [s.a] }, { args: s => [s.e] }],
    ['importAudio', { args: s => [s.e, '/in.wav', 0] }, { args: s => [s.e, '/in.missing', 0] }],
    ['importAudioWithDialog', { args: s => [s.e, 0] }, { before: arm, args: s => [s.g, 0] }],
    ['setProjectsRoot', { args: () => ['/Volumes/Other'] }, { args: () => [''] }],
    ['saveProjectNow', { args: () => [] }, null],
    ['newProjectFromTemplate', { args: () => ['My Rig'] }, { args: () => ['no-such-template'] }],
    ['openProjectPath', { before: () => callNative('saveProjectNow'),
                          args: async () => [(await callNative('listRecentProjects'))[0].path] },
                        { args: () => ['/projects/none'] }],
    ['saveAsTemplate', { args: () => ['Contract Rig'] }, { args: () => ['///'] }],
    ['saveTrackTemplate', { args: s => [s.a, 'Mic'] }, { args: () => ['no-such-node', 'Mic'] }],
    ['createFromTrackTemplate', { before: s => callNative('saveTrackTemplate', s.a, 'Mic'),
                                  args: () => ['Mic', ''] },
                                { args: () => ['no-such-template', ''] }],
    ['toggleMute', { args: s => [s.a] }, { args: () => ['no-such-node'] }],
    ['setLoopPoints', { args: s => [s.b, 0, 500] }, { args: s => [s.b, 0, 0] }],
    ['setSegments', { args: s => [s.b, [0, 250, 500, 750]] }, { args: s => [s.b, [500, 250]] }],
    ['setTiming', { args: s => [s.b, 100] }, { args: s => [s.b, 0] }],
    ['warpPointer', null, { args: () => [10, 10, 800, 600] }],
    ['toggleLoopWindow', { before: s => callNative('setLoopPoints', s.b, 0, 500), args: s => [s.b] },
                         { args: () => ['no-such-node'] }],
    ['setSequence', { args: s => [s.root, SONG] }, { args: s => [s.root, null] }],
    ['toggleSequence', { before: s => callNative('setSequence', s.root, SONG), args: s => [s.root] },
                       { args: s => [s.g] }],
    ['auditionStep', { before: s => callNative('setSequence', s.root, SONG), args: s => [s.root, 1] },
                     { args: s => [s.root, 0] }],
    ['setNodeInput', { args: s => [s.e, 1] }, { args: s => [s.e, 0] }],
    ['setNodeInputRight', { args: s => [s.e, 1] }, { args: s => [s.e, -1] }],
    ['setMonitor', { args: s => [s.e, true] }, { args: s => [s.g, true] }],
    ['setPeriodSource', { args: s => [s.b, 'context'] }, { args: s => [s.b, 'own'] }],
    ['setDefiner', { args: s => [s.b] }, { args: s => [s.e] }],
    ['setSlotEnabled', { args: s => [s.a, eqOf(s.a), true] }, { args: s => [s.a, 'no-such-slot', true] }],
    ['moveChainSlot', { args: s => [s.a, eqOf(s.a), 3] }, { args: s => [s.a, eqOf(s.a), 0] }],
    ['addPluginToChain', { args: s => [s.a, 'VST3-aurora-verb'] }, { args: s => [s.a, 'no-such-plugin'] }],
    ['removeChainSlot', { before: s => callNative('addPluginToChain', s.a, 'VST3-aurora-verb'),
                          args: s => [s.a, pluginOf(s.a)] },
                        { args: s => [s.a, eqOf(s.a)] }],
    ['openPluginEditor', { before: s => callNative('addPluginToChain', s.a, 'VST3-aurora-verb'),
                           args: s => [s.a, pluginOf(s.a)] },
                         { args: s => [s.a, eqOf(s.a)] }],
    ['startLatencyCalibration', { args: () => [] },
                                { before: () => callNative('startLatencyCalibration'), args: () => [] }],
];

test('the mock answers true for a verb that applied and false for one it refused, for every verb that answers whether it applied', async () => {
    const covered = new Set(BOOL_CASES.map(([verb]) => verb));
    for (const name of BOOL_METHODS) {
        assert.ok(covered.has(name), `no case for '${name}' — add one to BOOL_CASES`);
    }
    for (const [verb, applied, refused] of BOOL_CASES) {
        assert.ok(BOOL_METHODS.has(verb), `'${verb}' is not declared to answer a bool`);
        for (const [expected, one] of [[true, applied], [false, refused]]) {
            if (one === null) continue;
            const s = await scene();
            if (one.before) await one.before(s);
            const args = await one.args(s);
            assert.equal(await callNative(verb, ...args), expected,
                `${verb}(${JSON.stringify(args)}) ${expected ? 'applied' : 'refused'}`);
        }
    }
});

test('the mock answers true for a verb nothing can refuse, and a uuid for the verbs that make a node', async () => {
    const VOID_ARGS = {
        toggleSolo: s => [s.a],
        setNodePan: s => [s.a, 0.5],
        setNodeGain: s => [s.a, 0.5],
        setSlotParam: s => [s.a, eqOf(s.a), 'low', 3],
        setMidiArmed: s => [s.a, true],
        setEffectScope: s => [s.a, true],
        scanPlugins: () => [],
        nativeLog: () => ['a line'],
        renameProject: () => ['a name'],
    };
    for (const name of VOID_METHODS) {
        assert.ok(VOID_ARGS[name], `no arguments for '${name}' — add them to VOID_ARGS`);
        const s = await scene();
        assert.equal(await callNative(name, ...VOID_ARGS[name](s)), true, name);
        assert.equal(await callNative(name, 'no-such-node'), true,
            `${name} on nothing: it ran, and nothing can refuse it`);
    }

    const s = await scene();
    const made = await callNative('createNode', 'clip', s.g);
    assert.equal(typeof made, 'string');
    assert.equal(nodeById(made, readState().nodes).type, 'clip');
    assert.equal(await callNative('createNode', 'clip', s.e), '', 'a clip holds nothing');
    const group = await callNative('combineNodes', s.a, s.b);
    assert.equal(nodeById(group, readState().nodes).type, 'stack');
    assert.equal(await callNative('combineNodes', s.a, s.a), '', 'a node with itself');
    await arm(s);
    assert.equal(await callNative('combineNodes', s.e, s.g), '', 'under a live take');
});

test('the mock answers the project and template listings as values', async () => {
    const s = await scene();
    const info = await callNative('getProjectInfo');
    assert.deepEqual(Object.keys(info).sort(),
        ['born', 'id', 'name', 'projectsRoot', 'trackTemplatesRoot']);
    await callNative('saveProjectNow');
    await callNative('saveTrackTemplate', s.a, 'Mic');
    for (const [listing, keys] of [
        ['listTemplates', ['id', 'name', 'path']],
        ['listRecentProjects', ['id', 'name', 'path']],
        ['listTrackTemplates', ['kind', 'name', 'tracks']],
    ]) {
        const rows = await callNative(listing);
        assert.ok(Array.isArray(rows) && rows.length > 0, `${listing} answers a list`);
        assert.deepEqual(Object.keys(rows[0]).sort(), keys, listing);
        // The caller's list is its own.
        rows.length = 0;
        assert.ok((await callNative(listing)).length > 0, `${listing} hands out a copy`);
    }
});
