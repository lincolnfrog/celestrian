/**
 * mock/bounce.js — the bounce verbs (design_language.md Q19,
 * docs/bounce.md) mirrored observably: the mock renders nothing, it
 * records what was asked and answers the way the engine does. A live
 * or armed take refuses (AudioEngine::bounce parity); otherwise the
 * request lands in state.lastBounce for the UI tests to read.
 */

import { state, someNode } from './state.js';

/** The path the dialog verb records in place of a chosen file. */
export const DIALOG_PATH = '<dialog>';

/** A take armed or rolling anywhere (the engine's isArmedOrRecording). */
const takeIsLive = () => someNode(n => n.isRecording || n.isPendingStart);

export function bounce(uuid, path) {
    if (takeIsLive()) return false;
    state.lastBounce = { uuid, path };
    return true;
}

export function bounceWithDialog(uuid) {
    return bounce(uuid, DIALOG_PATH);
}

/** The last accepted bounce request ({uuid, path}), or null. */
export function getLastBounce() {
    return state.lastBounce || null;
}

export function resetLastBounce() {
    state.lastBounce = null;
}
