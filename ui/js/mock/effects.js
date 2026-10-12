/**
 * mock/effects.js — the effect chain (docs/vst3.md; engine dsp::FxChain
 * and the AudioEngine slot verbs). node.effects = { chain: [entry…] },
 * an entry being { slot, type, enabled, …params } — the array the engine
 * publishes and saves. Every node carries its rack from creation
 * (ensureEffects), the root's being the master rack; slot uuids are
 * stable. Chain STRUCTURE is undoable; a slot's switch and parameters
 * are knobs.
 */

import { EFFECT_SCHEMA } from '../effect_schema.js';
import { state, findNode, nodeOrRoot, eachNode } from './state.js';
import { getKnownPlugins } from './plugins.js';

let slotCounter = 0;

/** The built-ins' initial values (engine: the dsp:: classes'). */
const BUILT_IN_DEFAULTS = [
    ['eq', { low: 0, mid: 0, high: 0 }],
    ['compressor', { threshold: -18, ratio: 4, attack: 10, release: 100, makeup: 0 }],
    ['echo', { time: 0.35, feedback: 0.35, mix: 0.35 }],
    ['reverb', { size: 0.5, damp: 0.5, mix: 0.3 }],
];

/** Engine FxChain::makeDefault: the four built-ins, all off. */
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

/** The node's rack, installed if it has none. */
export function ensureEffects(node) {
    if (!node.effects) node.effects = defaultEffects();
    return node.effects;
}

const chainOf = id => {
    const node = nodeOrRoot(id);
    return node ? ensureEffects(node).chain : null;
};

/** Engine FxChain::makeFromSlots: instruments head the chain, each group
 * keeping its order. */
function instrumentsFirst(chain) {
    chain.splice(0, chain.length, ...chain.filter(s => s.isInstrument),
        ...chain.filter(s => !s.isInstrument));
}

/** False for an unknown node or slot. */
export function setSlotEnabled(id, slotUuid, enabled) {
    const entry = (chainOf(id) || []).find(s => s.slot === slotUuid);
    if (!entry) return false;
    entry.enabled = !!enabled;
    return true;
}

/** A built-in's parameter clamps to its row's range (effect_schema.js,
 * pinned to fx_chain.cc). */
export function setSlotParam(id, slotUuid, key, value) {
    const entry = (chainOf(id) || []).find(s => s.slot === slotUuid);
    if (!entry || ['slot', 'type', 'enabled'].includes(key) ||
        !Object.prototype.hasOwnProperty.call(entry, key)) return;
    const schema = EFFECT_SCHEMA.find(e => e.type === entry.type);
    const row = schema && schema.params.find(p => p.key === key);
    entry[key] = row ? Math.max(row.min, Math.min(row.max, Number(value))) : value;
}

export function moveChainSlot(id, slotUuid, newIndex) {
    const chain = chainOf(id);
    if (!chain) return;
    const from = chain.findIndex(s => s.slot === slotUuid);
    if (from < 0) return;
    const to = Math.max(0, Math.min(chain.length - 1, newIndex | 0));
    chain.splice(to, 0, chain.splice(from, 1)[0]);
    instrumentsFirst(chain);
}

/** The engine instantiates a plugin asynchronously; the mock lands the
 * slot at once, enabled. An unknown uid adds nothing. */
export function addPluginToChain(id, pluginUid, index) {
    const chain = chainOf(id);
    const known = chain && getKnownPlugins().find(p => p.uid === pluginUid);
    if (!known) return;
    const at = typeof index === 'number' && index >= 0 ? Math.min(chain.length, index)
                                                       : chain.length;
    chain.splice(at, 0, {
        slot: 'slot-vst3-' + (++slotCounter),
        type: 'vst3',
        enabled: true,
        name: known.name,
        uid: known.uid,
        file: known.file,
        missing: false,
        unsupported: false,
        isInstrument: !!known.isInstrument,
        latency: 0,
    });
    instrumentsFirst(chain);
}

/** Only a plugin slot is removable: the built-ins are the fixed cards. */
export function removeChainSlot(id, slotUuid) {
    const chain = chainOf(id);
    const at = chain ? chain.findIndex(s => s.slot === slotUuid && s.type === 'vst3') : -1;
    if (at >= 0) chain.splice(at, 1);
}

/** No native window in the mock: answers whether there is an editor to
 * show — a plugin slot whose plugin is loaded. */
export function openPluginEditor(id, slotUuid) {
    const entry = (chainOf(id) || []).find(s => s.slot === slotUuid);
    return !!entry && entry.type === 'vst3' && !entry.missing;
}

/** One node holds the live MIDI play-through at a time. */
export function setMidiArmed(id, on) {
    eachNode(n => { n.midiArmed = false; });
    const node = on ? findNode(id) : null;
    if (node) node.midiArmed = true;
}

export function getMidiInputs() {
    return { devices: ['Mock Keys 61'], dropped: 0 };
}

/** Scope telemetry is published only while a panel watches. */
export function setEffectScope(id, active) {
    const node = nodeOrRoot(id);
    if (node) node._scopeOn = !!active;
}
