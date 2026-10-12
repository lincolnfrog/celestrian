/**
 * mock/definer.js — the Q hand-off (engine AudioEngine::setDefiner,
 * applyDefiner) and the lock-collapse both ways (engine edit_geometry.cc:
 * collapseNode, reopenCollapsed, spliceAtLock; ClipNode::collapseContent
 * / uncollapseContent / spliceToMap). The mock holds no audio: a
 * collapsed clip remembers how far its content view moved (`contentBase`)
 * and the length it had (`collapsedFrom`), which is all a re-open reads.
 */

import { mapOffset, mapPeriod, heardOffsetOf } from '../time_map.js';
import {
    state, findNode, islandDefiner, isDefinerTarget, activeMapOf, storedMap,
    setStoredMap, isCommittedClip, takeLength, shiftOrigins, liftAncestors,
} from './state.js';
import { setIslandQuantum } from './sequence.js';
import { rawPeriodOfNode } from './cycles.js';

/** The leaves a lock-collapse acts on: a clip is its own; a stack's are
 * its committed direct clip members. */
function collapseLeaves(node) {
    if (node.type === 'clip') return [node];
    return (node.nodes || []).filter(isCommittedClip);
}

const hasCells = n => storedMap(n).segs.length >= 2;

/** Engine collapseNode: the node's stored window becomes the take. */
function collapseNode(node) {
    if (node.loopBypassed || hasCells(node)) return false;
    const leaves = collapseLeaves(node);
    if (!leaves.length) return false;
    const duration = takeLength(leaves[0]);
    if (leaves.some(leaf => takeLength(leaf) !== duration)) return false;
    const start = Math.max(0, node.loopStart || 0);
    const end = Math.min(node.loopEnd || 0, duration);
    const length = end - start;
    if (length <= 0 || (start === 0 && end >= duration)) return false;
    for (const leaf of leaves) {
        if (!leaf.collapsedFrom) leaf.collapsedFrom = leaf.duration;
        leaf.contentBase = (leaf.contentBase || 0) + start;
        leaf.duration = length;
        setStoredMap(leaf, []);
        if (leaf.storedTop != null) leaf.storedTop -= start;
        if (leaf.compCellLen > 0) leaf.compOffset = (leaf.compOffset || 0) - start;
    }
    if (node.type === 'stack' && node.storedTop != null) node.storedTop -= start;
    shiftOrigins(node, start);
    liftAncestors(node, start);
    setStoredMap(node, []);
    return true;
}

/** Engine uncollapseNode: the full takes return, the trim comes back as
 * the node's window. */
function uncollapseNode(node, shift, oldDuration, winStart, winEnd) {
    for (const leaf of collapseLeaves(node)) {
        if (!leaf.collapsedFrom) continue;
        leaf.contentBase = (leaf.contentBase || 0) - shift;
        leaf.duration = oldDuration;
        if (leaf.storedTop != null) leaf.storedTop += shift;
        if (leaf.compCellLen > 0) leaf.compOffset = (leaf.compOffset || 0) + shift;
        if (leaf.contentBase === 0) leaf.collapsedFrom = 0;
    }
    if (node.type === 'stack' && node.storedTop != null) node.storedTop += shift;
    shiftOrigins(node, -shift);
    liftAncestors(node, -shift);
    setStoredMap(node, [[winStart, winEnd]]);
}

/** Engine reopenCollapsed: a lock-collapsed node re-opens — unless a map
 * was authored on it or its leaves since the lock. */
export function reopenCollapsed(node) {
    const leaves = collapseLeaves(node);
    if (!leaves.length || !leaves[0].collapsedFrom) return false;
    if ([node, ...leaves].some(n => storedMap(n).segs.length > 0)) return false;
    const unwound = leaves[0].contentBase || 0;
    uncollapseNode(node, unwound, leaves[0].collapsedFrom, unwound,
        unwound + leaves[0].duration);
    return true;
}

/** Engine spliceAtLock: a clip's cell map collapses by a splice — the
 * kept cells become the take, the comp is consumed. */
function spliceAtLock(clip) {
    const map = storedMap(clip);
    const a0 = mapOffset(map, 0);
    if (clip.storedTop != null) clip.storedTop = Math.max(0, heardOffsetOf(map, clip.storedTop));
    clip.comp = [];
    clip.compCellLen = 0;
    clip.compOffset = 0;
    clip.duration = mapPeriod(map);
    clip.contentBase = 0;
    clip.collapsedFrom = 0;
    clip.origin = (clip.origin || 0) + a0;
    liftAncestors(clip, a0);
    setStoredMap(clip, []);
}

/** The definer's trim locks at an arm (engine applyCollapse, forward):
 * a bypassed map is not in use and stays; a clip's cells splice; a
 * window collapses. True when something changed. */
export function lockCollapse(node) {
    if (node.loopBypassed) return false;
    if (node.type === 'clip' && hasCells(node)) {
        spliceAtLock(node);
        return true;
    }
    return collapseNode(node);
}

/** Hand Q to node `id`: its loop becomes Q and its loop top the island
 * zero. A lock-collapsed target re-opens; a clip's stored top resets. */
export function setDefiner(id) {
    if (!(state.islandQ > 0)) return;
    const node = findNode(id);
    if (!node || !isDefinerTarget(node)) return;
    const own = rawPeriodOfNode(node);
    if (!(own > 0) || islandDefiner() === node) return;
    const map = activeMapOf(node);
    const zero = (node.origin || 0) + (map ? mapOffset(map, 0) : 0);
    reopenCollapsed(node);
    if (node.type === 'clip') node.storedTop = null;
    state.definerDesignation = node.id;
    setIslandQuantum(own, zero);
}
