/**
 * What the shell last learned of the session — the polled graph and the
 * frame the view seated on it — plus the graph predicates the verb
 * modules share. The facts are live bindings, written only by the
 * note* functions below.
 */

import { committedClip, subtreeHasCommitted } from './vm/published.js';

export let lastState = null;           // the last polled state
export let lastNodesById = new Map();  // its nodes, by id
export let lastRootId = '';            // the island root (move-to-top, master)
export let lastVm = null;              // the view model on screen

/**
 * THE FRAME FACTS (docs/frame.md), absolute samples; null before a
 * frame exists. Every seek and placement is computed against them:
 *   zero        the zero on screen
 *   rest        where the frame rests — what a placement lands on (an
 *               import, a bounce, a song's anchor), never a tween's
 *               passing zero
 *   seat        where the loops' tops line up; the default play start
 *   rawClock    the transport reading they were polled with
 *   loopSamples the audible loop's length
 *   quantum     Q
 */
export let lastFrame = null;

/** The poll's hand-over. */
export function notePoll(state, nodesById) {
    lastState = state;
    lastNodesById = nodesById;
    lastRootId = state.id || '';
}

/** A graph read between polls, for a verb that acts on what it just
 * made. The polled state stands until the next poll. */
export function noteGraphRead(state) {
    lastNodesById = indexNodes(state.nodes);
    lastRootId = state.id || lastRootId;
}

/** The view model just derived, and the frame facts it carries. */
export function noteView(vm, frame) {
    lastVm = vm;
    lastFrame = frame;
}

/** The frame facts after a seek the engine applied (seek.js). */
export function noteFrame(frame) {
    lastFrame = frame;
}

/** Every node of a published tree, by id. */
export function indexNodes(nodes, map = new Map()) {
    for (const n of nodes || []) {
        map.set(n.id, n);
        if (n.nodes) indexNodes(n.nodes, map);
    }
    return map;
}

/** Armed or capturing. */
export const isHotClip = c => !!(c.isRecording || c.isPendingStart);

/** A take is armed or capturing somewhere, as of the last graph read. */
export function anyTakeLive() {
    for (const n of lastNodesById.values()) if (isHotClip(n)) return true;
    return false;
}

/** The clips of a node's subtree (the node itself, when it is one). */
export function clipsUnder(node, out = []) {
    if (node.type === 'clip') out.push(node);
    for (const c of node.nodes || []) clipsUnder(c, out);
    return out;
}

/** Committed material at or below `n`: a clip holding a committed take,
 * or a group with one beneath it (the view model's own two tests). */
export const hasCommitted = n => committedClip(n) || subtreeHasCommitted(n);

/** The indexed node that holds `node` as a child; null at the top. */
export function parentOf(node) {
    for (const n of lastNodesById.values()) {
        if (n.nodes && n.nodes.includes(node)) return n;
    }
    return null;
}

/** The top-level nodes of the indexed graph. */
export const topLevelNodes = () =>
    [...lastNodesById.values()].filter(n => !parentOf(n));

/** The first node (depth-first, so a created group before its members)
 * of `nodes` whose id `before` does not hold. */
export function firstNewNodeId(nodes, before) {
    for (const n of nodes || []) {
        if (!before.has(n.id)) return n.id;
        const inner = firstNewNodeId(n.nodes, before);
        if (inner) return inner;
    }
    return null;
}
