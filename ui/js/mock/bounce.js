/**
 * mock/bounce.js — the bounce verbs (docs/bounce.md; engine
 * AudioEngine::bounce). The mock renders nothing: it answers as the
 * engine would and records an accepted request (getLastBounce).
 */

import { state, nodeOrRoot, takeLive } from './state.js';
import { audibleCycle, ownPeriodOfNode } from './cycles.js';
import { DIALOG_PATH } from './import.js';

export { DIALOG_PATH };

/** Engine ClipNode::kMaxTakeSamples: a longer span is refused. */
export const kMaxTakeSamples = 2 ** 30;

/** The span a bounce renders: the root's audible cycle, any other
 * node's own period; 0 for an unknown node or one with nothing to play. */
export function bounceSpanOf(uuid) {
    const node = nodeOrRoot(uuid);
    if (!node) return 0;
    return node === state.root ? audibleCycle() : ownPeriodOfNode(node);
}

/** `start` (absolute samples, optional) is where the app asks the render
 * to begin; recorded, not rendered. Refused under a live take, for
 * nothing to render, and past the take ceiling. */
export function bounce(uuid, path, start) {
    const span = bounceSpanOf(uuid);
    if (takeLive() || !(span > 0) || span > kMaxTakeSamples) return false;
    state.lastBounce = { uuid, path, start: Number.isFinite(start) ? Math.round(start) : null };
    return true;
}

export function bounceWithDialog(uuid, start) {
    return bounce(uuid, DIALOG_PATH, start);
}

/** The last accepted bounce ({ uuid, path, start }), or null. */
export function getLastBounce() {
    return state.lastBounce || null;
}

export function resetLastBounce() {
    state.lastBounce = null;
}
