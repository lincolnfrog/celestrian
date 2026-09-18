/**
 * mock/bounce.js — the bounce verbs (design_language.md Q19,
 * docs/bounce.md) mirrored observably: the mock renders nothing, it
 * records what was asked and answers the way the engine does. A live
 * or armed take refuses (AudioEngine::bounce parity); otherwise the
 * request lands in state.lastBounce for the UI tests to read.
 */

import { state, someNode, findNode } from './state.js';
import { effectiveCycle, effectivePeriodOf } from './cycles.js';

/** The path the dialog verb records in place of a chosen file. */
export const DIALOG_PATH = '<dialog>';

/** The engine's take ceiling (ClipNode::kMaxTakeSamples): a bounce
 * whose span passes it is refused (the render buffer is sized from
 * the span; a saturated lcm would be an overflow). */
export const kMaxTakeSamples = 2 ** 30;

/** A take armed or rolling anywhere (the engine's isArmedOrRecording). */
const takeIsLive = () => someNode(n => n.isRecording || n.isPendingStart);

/** The span the engine would render (docs/bounce.md): the root's
 * effective island cycle, any other node's effective period. */
export function bounceSpanOf(uuid) {
    if (uuid === state.root.id) return effectiveCycle(state.islandQ);
    const node = findNode(uuid);
    return node ? effectivePeriodOf(node) : 0;
}

/** `start` (optional, absolute samples) is the render's start the app
 * names — the frame zero the view seated, for the root (docs/frame.md);
 * absent, the node's own top. Recorded, not rendered. */
export function bounce(uuid, path, start) {
    if (takeIsLive()) return false;
    if (bounceSpanOf(uuid) > kMaxTakeSamples) return false;
    state.lastBounce = { uuid, path,
                         start: Number.isFinite(start) ? Math.round(start) : null };
    return true;
}

export function bounceWithDialog(uuid, start) {
    return bounce(uuid, DIALOG_PATH, start);
}

/** The last accepted bounce request ({uuid, path}), or null. */
export function getLastBounce() {
    return state.lastBounce || null;
}

export function resetLastBounce() {
    state.lastBounce = null;
}
