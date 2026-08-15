/**
 * Effect chain mock (docs/vst3.md phase 2) — mock twin of the C++
 * engine_bridge "moveChainSlot" coverage. Pins the slot-uuid protocol
 * the fx panel drives:
 *
 *  - every published node carries effects.chain: four built-in entries
 *    {slot, type, enabled, ...params} in canonical order, with slot
 *    uuids STABLE across polls (a fresh chain per publish would orphan
 *    slot-keyed edits in flight);
 *  - setSlotEnabled / setSlotParam address entries by slot uuid;
 *    unknown uuids and reserved keys are safe no-ops;
 *  - moveChainSlot reorders (state riding along) and is UNDOABLE —
 *    unlike the enable/param knobs, order is an arrangement fact.
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

test('published chain: canonical order, stable slot uuids', async () => {
    await loadScenario('stack-with-clips');
    const clip = await firstClip();
    const chain = clip.effects.chain;
    assert.deepEqual(chain.map(s => s.type),
        ['eq', 'compressor', 'echo', 'reverb']);
    const uuids = chain.map(s => s.slot);
    assert.equal(new Set(uuids).size, 4, 'uuids distinct');
    // Stability: a second publish keeps the same identities.
    const again = nodeById(clip.id, getState().nodes).effects.chain;
    assert.deepEqual(again.map(s => s.slot), uuids);
});

test('slot-uuid setters: enable, param, and safe no-ops', async () => {
    await loadScenario('stack-with-clips');
    const clip = await firstClip();
    const echo = clip.effects.chain.find(s => s.type === 'echo');

    await callNative('setSlotEnabled', clip.id, echo.slot, true);
    await callNative('setSlotParam', clip.id, echo.slot, 'mix', 0.8);
    let now = nodeById(clip.id, getState().nodes).effects.chain
        .find(s => s.slot === echo.slot);
    assert.equal(now.enabled, true);
    assert.equal(now.mix, 0.8);

    // Unknown slot / reserved keys: nothing changes, nothing throws.
    await callNative('setSlotEnabled', clip.id, 'no-such-slot', false);
    await callNative('setSlotParam', clip.id, echo.slot, 'type', 'reverb');
    now = nodeById(clip.id, getState().nodes).effects.chain
        .find(s => s.slot === echo.slot);
    assert.equal(now.enabled, true, 'unknown-slot call left state alone');
    assert.equal(now.type, 'echo', 'reserved key rejected');
});

test('moveChainSlot: reorders with state riding, undoable', async () => {
    await loadScenario('stack-with-clips');
    const clip = await firstClip();
    const echo = clip.effects.chain.find(s => s.type === 'echo');
    await callNative('setSlotParam', clip.id, echo.slot, 'time', 0.5);

    await callNative('moveChainSlot', clip.id, echo.slot, 0);
    let chain = nodeById(clip.id, getState().nodes).effects.chain;
    assert.deepEqual(chain.map(s => s.type),
        ['echo', 'eq', 'compressor', 'reverb'], 'echo moved to head');
    assert.equal(chain[0].slot, echo.slot, 'identity survives the move');
    assert.equal(chain[0].time, 0.5, 'state rides the move');

    await callNative('undo');
    chain = nodeById(clip.id, getState().nodes).effects.chain;
    assert.deepEqual(chain.map(s => s.type),
        ['eq', 'compressor', 'echo', 'reverb'], 'undo restores order');

    await callNative('redo');
    chain = nodeById(clip.id, getState().nodes).effects.chain;
    assert.equal(chain[0].type, 'echo', 'redo re-applies the move');
});
