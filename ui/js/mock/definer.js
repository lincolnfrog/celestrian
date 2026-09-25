/**
 * mock/definer.js — HANDING Q TO A TRACK (Q22, design_language.md §5;
 * engine parity AudioEngine::setDefiner) and the lock-collapse's
 * reverse, the UNCOLLAPSE a re-opened definer takes (Q13: re-open ⟹
 * uncollapse), shared with the re-opening delete (graph_crud.js).
 *
 * The hand-off makes `id` THE definer: its loop becomes Q and its loop
 * top the island zero — nothing sounds different — and from then on its
 * region trims re-establish (Q, zero) exactly as a first take's do
 * (maps.js), keeping its origin beside the other tracks. The next take
 * that records new content ends it (recording.js endHandoffAtArm). Any
 * other track whose loop no longer fits Q drifts (the period law's
 * drift clause, timeline_model.js).
 */

import { mapOffset } from '../time_map.js';
import {
    state, findNode, islandDefiner, validDefinerTarget, activeMapOf,
    frameOriginOf,
} from './state.js';
import { popUndoForRefusal } from './undo.js';
import { retimeSequences } from './sequence.js';
import { rawPeriodOfNode } from './cycles.js';

/**
 * setDefiner(id) — hand Q to node `id`. Refused (recording nothing)
 * before Q exists, for an unknown node, for a target the engine would
 * refuse (validDefinerTarget: a committed looping clip, or a stack whose
 * committed direct clips are one take; nothing above remapping time),
 * for an empty loop, and for the definer itself. The live-take gate
 * refuses it in the dispatch. One undo step (the dispatch snapshot
 * holds the designation, the island facts and any collapse facts).
 */
export function setDefiner(id) {
    const refuse = why => {
        console.log('[MockBackend] setDefiner refused —', why);
        popUndoForRefusal();
    };
    if (!(state.islandQ > 0)) return refuse('no Q yet — record a take first');
    const node = findNode(id);
    if (!node) return refuse('no such node');
    if (!validDefinerTarget(node)) {
        return refuse(node.type === 'stack'
            ? 'a group takes Q only when its tracks are one take'
            : 'not a committed looping track, or inside a remapping group');
    }
    if (islandDefiner() === node) return refuse('it already defines Q');
    if (!(rawPeriodOfNode(node) > 0)) return refuse('nothing loops here');
    // RE-OPEN ⟹ UNCOLLAPSE: a lock-collapsed definer gets its whole take
    // back with the old trim as its window (audio-neutral — its loop is
    // the same length), so its loop can grow again. Not over a region
    // drawn since the lock: the old trim would replace it, audibly
    // (engine parity: the re-open needs no stored map on the node or its
    // leaves).
    if (!storesMap(node)) {
        if (node.type === 'stack') uncollapseStack(node);
        else uncollapseClip(node);
    }
    const own = rawPeriodOfNode(node);
    // The definer's "1" is its region start (Q13: zero := origin +
    // start) — a stored ↺ top resets.
    if (node.type === 'clip') node.storedTop = null;
    const map = activeMapOf(node);
    const a0 = map ? mapOffset(map, 0) : 0;
    state.definerDesignation = node.id;
    retimeSequences(state.islandQ, own);  // sequences track Q
    state.islandQ = own;
    state.islandZero = frameOriginOf(node) + a0;
    console.log('[MockBackend] Q handed to', node.id, '→ Q =', own,
        'zero =', state.islandZero);
}

/** Does `node` — or, for a stack, any of its clips — store a region
 * (a window or a multi-segment map, bypassed or not)? */
function storesMap(node) {
    const has = n => (Array.isArray(n.segments) && n.segments.length >= 2) ||
        (n.loopEnd || 0) > (n.loopStart || 0);
    if (has(node)) return true;
    return node.type === 'stack' && (node.nodes || []).some(c =>
        c.type === 'clip' && has(c));
}

/** Undo a clip's lock-collapse (engine ClipNode::uncollapseContent): the
 * full take returns with the pre-collapse trim as its window; the
 * origin and a stored top go back to the full take's coordinates. A
 * group member's collapse belongs to its stack (uncollapseStack). */
export function uncollapseClip(clip) {
    const pre = clip && clip._precollapse;
    if (!pre || pre.group) return false;
    clip.duration = pre.dur;
    clip.loopStart = pre.ls;
    clip.loopEnd = pre.le;
    clip.origin = pre.origin;
    if (clip.storedTop != null) clip.storedTop += pre.ls;
    delete clip._precollapse;
    console.log('[MockBackend] Q13 re-open: uncollapsed', clip.id);
    return true;
}

/** Undo a definer stack's lock-collapse (engine uncollapseNode on a
 * stack): full member takes back, the trim back on the stack, and the
 * subtree's origins unwound by the collapse shift. */
export function uncollapseStack(ds) {
    if (!ds || !ds._precollapse) return false;
    const shift = ds._precollapse.shift || 0;
    (ds.nodes || []).forEach(m => {
        if (m.type !== 'clip' || !m._precollapse) return;
        m.duration = m._precollapse.dur;
        m.loopStart = 0;
        m.loopEnd = 0;  // members whole (no window)
        m.origin = (m.origin || 0) - shift;
        if (m.storedTop != null) m.storedTop += shift;
        delete m._precollapse;
    });
    ds.origin = (ds.origin || 0) - shift;
    ds.loopStart = ds._precollapse.ls;
    ds.loopEnd = ds._precollapse.le;
    delete ds._precollapse;
    console.log('[MockBackend] Q13 re-open: group uncollapsed', ds.id);
    return true;
}
