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

import { findNode } from './state.js';

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
export function defaultEffects() {
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
    if (!node) return;
    const chain = ensureEffects(node).chain;
    const from = chain.findIndex(s => s.slot === slotUuid);
    const to = Math.max(0, Math.min(chain.length - 1, newIndex | 0));
    if (from < 0 || from === to) return;
    const [moved] = chain.splice(from, 1);
    chain.splice(to, 0, moved);
    console.log('[MockBackend] Slot', slotUuid, 'on', id, 'moved →', to);
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
