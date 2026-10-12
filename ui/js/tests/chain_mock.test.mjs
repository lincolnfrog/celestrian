/**
 * Effect chain (docs/vst3.md phase 2) — the slot-uuid protocol the fx
 * panel drives. The built-in rack as published (order, switches,
 * parameters, a move and its undo) is held to the engine by the
 * differential suite (ui/differential/ fx/*), which leaves slot uuids
 * out and has no plugin to add. Here, those two:
 *
 *  - slot uuids are STABLE across polls and a move (a fresh chain per
 *    publish would orphan slot-keyed edits in flight), and a reserved
 *    key is no parameter (the mock's slot is one flat record);
 *  - a plugin slot: added from the registry, removable, undoable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { nodeById } from './helpers.mjs';

async function firstClip() {
    const nodes = getState().nodes;
    const stack = nodes.find(n => n.nodes);
    return stack ? stack.nodes[0] : nodes[0];
}

test('published chain: canonical order; a slot keeps its uuid through polls and a move; ' +
     'a reserved key is no parameter', async () => {
    await loadScenario('stack-with-clips');
    const clip = await firstClip();
    const chain = clip.effects.chain;
    assert.deepEqual(chain.map(s => s.type),
        ['eq', 'compressor', 'echo', 'reverb']);
    const uuids = chain.map(s => s.slot);
    assert.equal(new Set(uuids).size, 4, 'uuids distinct');
    const now = () => nodeById(clip.id, getState().nodes).effects.chain;
    assert.deepEqual(now().map(s => s.slot), uuids, 'a second publish keeps the same identities');

    const echo = chain.find(s => s.type === 'echo');
    await callNative('moveChainSlot', clip.id, echo.slot, 0);
    assert.equal(now()[0].slot, echo.slot, 'identity survives the move');

    await callNative('setSlotParam', clip.id, echo.slot, 'type', 'reverb');
    assert.equal(now()[0].type, 'echo', 'reserved key rejected');
});

test('vst3 slots: add from registry, remove (vst3-only), undoable', async () => {
    await loadScenario('stack-with-clips');
    const clip = await firstClip();
    const known = await callNative('getKnownPlugins');
    const plugin = known[0];

    await callNative('addPluginToChain', clip.id, plugin.uid, -1);
    let chain = nodeById(clip.id, getState().nodes).effects.chain;
    assert.equal(chain.length, 5);
    const entry = chain[4];
    assert.equal(entry.type, 'vst3');
    assert.equal(entry.name, plugin.name);
    assert.equal(entry.enabled, true, 'arrives audible');
    assert.equal(entry.missing, false);

    // Unknown uid: safe no-op.
    await callNative('addPluginToChain', clip.id, 'no-such-plugin', -1);
    assert.equal(nodeById(clip.id, getState().nodes).effects.chain.length, 5);

    // Built-ins refuse removal; the vst3 slot removes; undo restores.
    const eq = chain.find(s => s.type === 'eq');
    await callNative('removeChainSlot', clip.id, eq.slot);
    assert.equal(nodeById(clip.id, getState().nodes).effects.chain.length, 5,
        'built-ins are not removable');
    await callNative('removeChainSlot', clip.id, entry.slot);
    assert.equal(nodeById(clip.id, getState().nodes).effects.chain.length, 4);
    await callNative('undo');
    chain = nodeById(clip.id, getState().nodes).effects.chain;
    assert.equal(chain.length, 5, 'undo restores the plugin');
    assert.equal(chain[4].slot, entry.slot, 'same slot identity');
});
