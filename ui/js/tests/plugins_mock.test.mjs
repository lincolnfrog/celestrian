/**
 * Plugin registry mock (docs/vst3.md phase 1) — mock twin of
 * tests/plugin_host_tests.cc. Pins the protocol shapes and the
 * deterministic scan lifecycle the panel drives:
 *
 *  - getKnownPlugins publishes name-sorted entries in the engine's
 *    shape ({name, uid, file, maker, category, version, isInstrument});
 *  - scanPlugins starts a scan; while it runs each getPluginScanStatus
 *    poll advances it one step (scanning:true, progress rising);
 *  - the completed scan discovers one new plugin exactly once
 *    (re-scans are idempotent), and status.count tracks the registry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative } from '../mock_backend.js';
import { resetPlugins } from '../mock/plugins.js';

/** Poll status until the scan reports done (bounded). */
async function pollUntilDone(maxPolls = 10) {
    let status;
    for (let i = 0; i < maxPolls; i++) {
        status = await callNative('getPluginScanStatus');
        if (!status.scanning) return status;
    }
    assert.fail('scan never completed within ' + maxPolls + ' polls');
}

test('known list: name-sorted, engine shape', async () => {
    resetPlugins();
    const plugins = await callNative('getKnownPlugins');
    assert.equal(plugins.length, 2);
    const names = plugins.map(p => p.name);
    assert.deepEqual(names, [...names].sort((a, b) =>
        a.toLowerCase() < b.toLowerCase() ? -1 : 1), 'name-sorted');
    for (const p of plugins) {
        for (const key of ['name', 'uid', 'file', 'maker', 'category',
                           'version', 'isInstrument']) {
            assert.ok(key in p, `entry carries ${key}`);
        }
    }
});

test('scan lifecycle: progress rises, completion discovers once', async () => {
    resetPlugins();
    const before = (await callNative('getKnownPlugins')).length;

    await callNative('scanPlugins');
    const first = await callNative('getPluginScanStatus');
    assert.equal(first.scanning, true, 'first poll: still scanning');
    assert.ok(first.progress > 0 && first.progress < 1,
        'progress strictly inside (0,1) mid-scan');
    assert.ok(first.current.length > 0, 'current file named mid-scan');

    const done = await pollUntilDone();
    assert.equal(done.scanning, false);
    assert.equal(done.progress, 1);
    assert.equal(done.count, before + 1, 'scan discovered one plugin');

    const after = await callNative('getKnownPlugins');
    assert.equal(after.length, before + 1);
    assert.ok(after.some(p => p.isInstrument), 'the discovery is a synth');

    // Idempotent: a second scan re-finds, never duplicates.
    await callNative('scanPlugins');
    const again = await pollUntilDone();
    assert.equal(again.count, before + 1, 're-scan does not duplicate');
});
