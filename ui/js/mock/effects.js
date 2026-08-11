/**
 * mock/effects.js — the built-in effect rack: default parameter sets,
 * lazy per-node installation, and the enable/param/scope setters.
 */

import { findNode } from './state.js';

// Built-in effects (engine parity: dsp::EffectRack defaults — the same
// keys and values AudioNode publishes in metadata).
export function defaultEffects() {
    return {
        eq: { enabled: false, low: 0, mid: 0, high: 0 },
        compressor: { enabled: false, threshold: -18, ratio: 4, attack: 10, release: 100, makeup: 0 },
        echo: { enabled: false, time: 0.35, feedback: 0.35, mix: 0.35 },
        reverb: { enabled: false, size: 0.5, damp: 0.5, mix: 0.3 },
    };
}

export function ensureEffects(node) {
    if (!node.effects) node.effects = defaultEffects();
    return node.effects;
}

export function setEffectEnabled(id, fx, enabled) {
    const node = findNode(id);
    if (node && ensureEffects(node)[fx]) {
        node.effects[fx].enabled = !!enabled;
        console.log('[MockBackend] Effect', fx, 'on', id, '→', enabled ? 'ENABLED' : 'DISABLED');
    }
}

export function setEffectParam(id, fx, param, value) {
    const node = findNode(id);
    if (node && ensureEffects(node)[fx] &&
        Object.prototype.hasOwnProperty.call(node.effects[fx], param)) {
        node.effects[fx][param] = value;
        console.log('[MockBackend] Effect param', fx + '.' + param, 'on', id, '→', value);
    }
}

export function setEffectScope(id, active) {
    // Engine parity (EffectRack::setScopeActive): scope telemetry only
    // exists while a panel watches.
    const node = findNode(id);
    if (node) {
        node._scopeOn = !!active;
        console.log('[MockBackend] Effect scope on', id, '→', active ? 'OPEN' : 'CLOSED');
    }
}
