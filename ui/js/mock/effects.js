/**
 * mock/effects.js — the effect CHAIN (docs/vst3.md phase 2): default
 * chain construction, lazy per-node installation, and the slot-uuid
 * keyed setters (engine parity: AudioEngine::setSlotEnabled /
 * setSlotParam / moveChainSlot on dsp::FxChain).
 *
 * Shape contract: node.effects = { chain: [entry...], scope? } where an
 * entry is {slot, type, enabled, ...params} — the same array
 * FxChain::getMetadata publishes and session_io persists. Slot uuids
 * are stable per node (engine parity: reorders preserve identity).
 */

import { popUndoForRefusal } from './undo.js';
import { findNode, state } from './state.js';
import { getKnownPlugins } from './plugins.js';

let slotCounter = 0;

// Built-in defaults (engine parity: the dsp:: classes' initial values).
const BUILT_IN_DEFAULTS = [
    ['eq', { low: 0, mid: 0, high: 0 }],
    ['compressor', { threshold: -18, ratio: 4, attack: 10, release: 100, makeup: 0 }],
    ['echo', { time: 0.35, feedback: 0.35, mix: 0.35 }],
    ['reverb', { size: 0.5, damp: 0.5, mix: 0.3 }],
];

/** A fresh default chain: the four built-ins in canonical order, all
 * disabled — FxChain::makeDefault's twin. */
function defaultEffects() {
    return {
        chain: BUILT_IN_DEFAULTS.map(([type, params]) => ({
            slot: 'slot-' + type + '-' + (++slotCounter),
            type,
            enabled: false,
            ...params,
        })),
    };
}

export function ensureEffects(node) {
    if (!node.effects) node.effects = defaultEffects();
    return node.effects;
}

function findSlotEntry(node, slotUuid) {
    return node && ensureEffects(node).chain.find(s => s.slot === slotUuid);
}

export function setSlotEnabled(id, slotUuid, enabled) {
    const entry = findSlotEntry(findNode(id), slotUuid);
    if (entry) {
        entry.enabled = !!enabled;
        console.log('[MockBackend] Slot', entry.type, slotUuid, 'on', id,
            '→', enabled ? 'ENABLED' : 'DISABLED');
    }
}

export function setSlotParam(id, slotUuid, key, value) {
    const entry = findSlotEntry(findNode(id), slotUuid);
    if (entry && key !== 'slot' && key !== 'type' && key !== 'enabled' &&
        Object.prototype.hasOwnProperty.call(entry, key)) {
        entry[key] = value;
        console.log('[MockBackend] Slot param', entry.type + '.' + key,
            'on', id, '→', value);
    }
}

/** Chain STRUCTURE (undoable, unlike the knobs — see mock/undo.js). */
export function moveChainSlot(id, slotUuid, newIndex) {
    const node = findNode(id);
    if (!node) { popUndoForRefusal(); return; }  // unknown = refusal (F-C)
    const chain = ensureEffects(node).chain;
    const from = chain.findIndex(s => s.slot === slotUuid);
    const to = Math.max(0, Math.min(chain.length - 1, newIndex | 0));
    if (from < 0 || from === to) return;
    const [moved] = chain.splice(from, 1);
    chain.splice(to, 0, moved);
    console.log('[MockBackend] Slot', slotUuid, 'on', id, 'moved →', to);
}

/** VST3 slot add (docs/vst3.md phase 3). The REAL backend is async
 * (instantiation completes later); the mock lands the slot
 * immediately — the UI contract is only "the chip appears when the
 * chain publishes it". Arrives ENABLED, like the engine's. */
export function addPluginToChain(id, pluginUid, index) {
    const node = findNode(id);
    if (!node) { popUndoForRefusal(); return; }  // unknown = refusal (F-C)
    const known = getKnownPlugins().find(p => p.uid === pluginUid);
    if (!known) {
        console.log('[MockBackend] addPluginToChain: unknown uid', pluginUid);
        return;
    }
    const chain = ensureEffects(node).chain;
    const entry = {
        slot: 'slot-vst3-' + (++slotCounter),
        type: 'vst3',
        enabled: true,
        name: known.name,
        uid: known.uid,
        file: known.file,
        missing: false,
        isInstrument: !!known.isInstrument,
        latency: 0,
    };
    const at = (typeof index === 'number' && index >= 0)
        ? Math.min(chain.length, index) : chain.length;
    chain.splice(at, 0, entry);
    console.log('[MockBackend] Plugin', known.name, 'added to', id, 'at', at);
}

/** VST3-only removal (engine parity: built-ins are the fixed cards). */
export function removeChainSlot(id, slotUuid) {
    const node = findNode(id);
    if (!node) { popUndoForRefusal(); return; }  // unknown = refusal (F-C)
    const chain = ensureEffects(node).chain;
    const at = chain.findIndex(s => s.slot === slotUuid && s.type === 'vst3');
    if (at < 0) return;
    chain.splice(at, 1);
    console.log('[MockBackend] Slot', slotUuid, 'removed from', id);
}

export function openPluginEditor(id, slotUuid) {
    // Native windows do not exist in the mock; log the gesture so e2e
    // can assert the bridge call happened if it ever needs to.
    console.log('[MockBackend] openPluginEditor', id, slotUuid);
    return true;
}

/** Single-armed play-through target (engine parity: setMidiArmed
 * clears every other node's flag first). Not undoable. */
export function setMidiArmed(id, on) {
    const clearAll = nodes => nodes.forEach(n => {
        n.midiArmed = false;
        if (n.nodes) clearAll(n.nodes);
    });
    clearAll(state.nodes);
    if (on) {
        const node = findNode(id);
        if (node) {
            node.midiArmed = true;
            console.log('[MockBackend] MIDI armed on', id);
        }
    }
}

/** Diagnostics fixture (engine parity: {devices, dropped}). */
export function getMidiInputs() {
    return { devices: ['Mock Keys 61'], dropped: 0 };
}

export function setEffectScope(id, active) {
    // Engine parity (FxScope::setActive): scope telemetry only exists
    // while a panel watches.
    const node = findNode(id);
    if (node) {
        node._scopeOn = !!active;
        console.log('[MockBackend] Effect scope on', id, '→', active ? 'OPEN' : 'CLOSED');
    }
}
