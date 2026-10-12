/**
 * mock/graph_crud.js — the structural edits (engine edit_structure.cc:
 * Insert, Remove, Move, Combine), the per-node switches and the knobs
 * (engine verbs.cc). A refusal returns with the graph untouched.
 */

import {
    state, generateId, findNode, nodeOrRoot, findParent, removeNodeFromParent,
    committedClipCount, islandDefiner, settleAnchors,
} from './state.js';
import { setIslandQuantum } from './sequence.js';
import { reopenCollapsed } from './definer.js';
import { ensureEffects } from './effects.js';

/** A fresh node as the engine creates one: empty, idle, its rack
 * installed; a clip records input 1. `facts` override the defaults. */
export function newNode(type, facts = {}) {
    const node = {
        id: facts.id || generateId(),
        name: type === 'clip' ? 'New Clip' : 'New Stack',
        type,
        duration: 0,
        origin: 0,
        isMuted: false,
        isSoloed: false,
        pan: 0,
        gain: 1,
        periodSource: 'own',
        ...(type === 'clip' ? { inputChannel: 0, inputChannelR: -1, channels: 1 }
                            : { nodes: [], auditionStep: -1, anchored: false }),
        ...facts,
    };
    ensureEffects(node);
    return node;
}

/** The stack a parent id names; `emptyIsRoot` reads no id as the root
 * (createNode's rule alone). */
function parentStack(parentId, emptyIsRoot = false) {
    if (!parentId && emptyIsRoot) return state.root;
    const parent = nodeOrRoot(parentId);
    return parent && parent.type === 'stack' ? parent : null;
}

/** Any type but "clip" makes a stack. Answers the new node's id, '' when
 * the parent is not a stack. */
export function createNode(type, parentId = null) {
    const parent = parentStack(parentId, true);
    if (!parent) return '';
    const node = newNode(type === 'clip' ? 'clip' : 'stack');
    parent.nodes.push(node);
    return node.id;
}

/** A delete that leaves no committed content reverts (Q, zero); one that
 * removed content and leaves a lock-collapsed definer re-opens it. */
export function deleteNode(id) {
    const node = findNode(id);
    if (!node) return;
    const before = committedClipCount();
    removeNodeFromParent(id);
    const after = committedClipCount();
    if (after === 0 && state.islandQ !== 0) setIslandQuantum(0, 0);
    const definer = after < before ? islandDefiner() : null;
    if (definer) reopenCollapsed(definer);
    settleAnchors();
}

export function renameNode(id, newName) {
    const node = findNode(id);
    if (node) node.name = newName;
}

const within = (node, id) => node.id === id || (node.nodes || []).some(n => within(n, id));

/** A move needs a stack's or the root's id; a node moved into its own
 * subtree stays. */
export function reorderNode(nodeId, newParentId, newIndex) {
    const node = findNode(nodeId);
    const newParent = parentStack(newParentId);
    if (!node || !newParent || within(node, newParent.id)) return;
    removeNodeFromParent(nodeId);
    const list = newParent.nodes;
    list.splice(Math.max(0, Math.min(newIndex, list.length)), 0, node);
    settleAnchors();
}

/** Wrap two nodes in a new stack at the target's place, the target
 * first, and answer its id. Refused ('') when either holds the other. */
export function combineNodes(draggedId, targetId) {
    const dragged = findNode(draggedId);
    const target = findNode(targetId);
    if (!dragged || !target || within(dragged, targetId) ||
        within(target, draggedId)) return '';
    const parent = findParent(targetId);
    let index = parent.nodes.findIndex(n => n.id === targetId);
    const draggedIndex = parent.nodes.findIndex(n => n.id === draggedId);
    if (draggedIndex >= 0 && draggedIndex < index) index--;
    removeNodeFromParent(draggedId);
    removeNodeFromParent(targetId);
    const stack = newNode('stack', { id: `stack-${state.nextId++}`, name: 'Combined Stack',
                                     nodes: [target, dragged] });
    parent.nodes.splice(Math.min(index, parent.nodes.length), 0, stack);
    settleAnchors();
    return stack.id;
}

/** Solo: additive, island-wide; a monitoring gesture, not logged. */
export function toggleSolo(id) {
    const node = findNode(id);
    if (node) node.isSoloed = !node.isSoloed;
}

export function toggleMute(id) {
    const node = findNode(id);
    if (node) node.isMuted = !node.isMuted;
}

const clipOf = id => {
    const node = findNode(id);
    return node && node.type === 'clip' ? node : null;
};

export function setNodeInput(id, channelIndex) {
    const clip = clipOf(id);
    if (clip) clip.inputChannel = channelIndex;
}

export function setNodeInputRight(id, channelIndex) {
    const clip = clipOf(id);
    if (!clip) return;
    clip.inputChannelR = channelIndex;
    clip.channels = channelIndex >= 0 ? 2 : 1;
}

/** Clips only: false for anything else. */
export function setMonitor(id, on) {
    const clip = clipOf(id);
    if (!clip) return false;
    clip.monitor = !!on;
    return true;
}

export function setNodePan(id, pan) {
    const node = findNode(id);
    if (node) node.pan = Math.max(-1, Math.min(1, pan));
}

/** The fader, [0, 1]; the root's is the master fader. */
export function setNodeGain(id, gain) {
    const node = nodeOrRoot(id);
    if (node) node.gain = Math.max(0, Math.min(1, gain));
}

/** Loop or one-shot. A node holding all the island's committed content
 * cannot become a one-shot: nothing would define the cycle it fires in. */
export function setPeriodSource(id, source) {
    const node = findNode(id);
    const next = source === 'context' ? 'context' : 'own';
    if (!node || (node.periodSource || 'own') === next) return;
    const inside = committedClipCount(node);
    if (next === 'context' && inside > 0 && inside === committedClipCount()) return;
    node.periodSource = next;
}
