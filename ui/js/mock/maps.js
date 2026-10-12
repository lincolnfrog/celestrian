/**
 * mock/maps.js — the map verbs (engine src/engine/map_edits.cc:
 * setLoopPoints, setSegments, commitMap, toggleLoopWindow, setTiming)
 * and what rides a map edit (edit_geometry.cc: the top, the bypass, the
 * window domain, members whole, the origin and the island facts). Every
 * verb resolves and refuses before it changes anything; a refusal
 * returns with the graph untouched, which is all the dispatch needs.
 */

import {
    mapPeriod, mapOffset, mapActive, heardOffsetOf, keepsTop, reconcileTop,
    effectiveTop, singleSegment, MAX_SEGMENTS,
} from '../time_map.js';
import { periodDrifts } from '../period_law.js';
import {
    state, findNode, nodeOrRoot, storedMap, setStoredMap, intrinsicOfNode, isAnchored,
    shiftOrigins, liftAncestors, islandDefiner, holdsAllContent, isCommittedClip,
    storesGeometry, takeLength,
} from './state.js';
import { coalescedThisCall } from './undo.js';
import { activeSeqLen } from './seq_query.js';
import { setIslandQuantum } from './sequence.js';
import {
    receivedAt, ownInnerAt, foldIntoWindow, originForHeard, continuityOrigin,
} from './heard.js';

export { continuityOriginFor, nearestRepresentative } from './heard.js';

/** Does the node's STORED map play (its bypass applied)? */
const storedMapPlays = node => !node.loopBypassed && mapActive(storedMap(node));

/** The top the node shows now (engine AudioNode::effectiveTop). */
function topOf(node) {
    return effectiveTop(storedMap(node), storedMapPlays(node), intrinsicOfNode(node),
        node.storedTop ?? null);
}

/** Store the top a map edit leaves (engine reconcileTopRider): `base`
 * while the new map plays it, else the new region start. */
function reconcileStoredTop(node, base) {
    node.storedTop = reconcileTop(storedMap(node), storedMapPlays(node),
        intrinsicOfNode(node), base);
}

/** The top a commit reconciles from: the one the node showed before
 * this call — or, for a live commit that joined its gesture's step, the
 * one the gesture started with. */
let topGesture = null;  // { id, top }
function topBaseFor(node, topBefore) {
    if (!coalescedThisCall() || !topGesture || topGesture.id !== node.id) {
        topGesture = { id: node.id, top: topBefore };
    }
    return topGesture.top;
}

const sameMap = (a, b) => a.segs.length === b.segs.length &&
    a.segs.every(([s, e], i) => s === b.segs[i][0] && e === b.segs[i][1]);

/** Engine soleDefinerOrigin: the origin at which the sole definer goes
 * on sounding through a re-trim to `map`. Read before the map is stored. */
function soleDefinerOrigin(node, map) {
    const r = receivedAt(node, state.masterPos);
    const sounding = ownInnerAt(node, r.clock, r.scope).inner;
    if (map.segs.length === 1) {
        return r.clock - foldIntoWindow(sounding, map.segs[0][0], mapPeriod(map));
    }
    const oldHeard = storedMapPlays(node) ? heardOffsetOf(storedMap(node), sounding) : 0;
    return originForHeard(map, r.clock, sounding, oldHeard);
}

/** Engine attachMapEditRiders: the continuity re-anchor, or null when
 * nothing heard changes — a bypassed node, an unanchored stack, a
 * stopped transport — or the origin already holds. */
function continuityRider(node, map) {
    if (node.loopBypassed || !isAnchored(node) || !state.isPlaying) return null;
    const origin = continuityOrigin(node, map, state.masterPos);
    return origin !== (node.origin || 0) ? origin : null;
}

/** Engine attachMembersWholeRiders: under the definer stack's window a
 * member holding a region of its own goes whole, its top riding. */
function makeMembersWhole(stack) {
    for (const member of stack.nodes || []) {
        if (!isCommittedClip(member) || !storesGeometry(member)) continue;
        const top = topOf(member);
        setStoredMap(member, []);
        reconcileStoredTop(member, top);
    }
}

/** The root of an island with no Q has no region to set or bypass. */
const rootOfEmptyIsland = node => node === state.root && !(state.islandQ > 0);

/** Engine commitMap + its applier: store `map` on `target` with every
 * rider. Identity and coherence are judged on the map as stored. */
function commitMap(target, map) {
    if (mapActive(map) && rootOfEmptyIsland(target)) return;
    if (sameMap(storedMap(target), map)) return;
    const duration = intrinsicOfNode(target);
    const definer = duration > 0 && islandDefiner() === target;
    const q = state.islandQ;
    if (mapActive(map) && !definer && q > 0 && periodDrifts(mapPeriod(map), q)) return;

    let origin = null;   // { to, lift }
    let island = null;   // { q, zero }
    if (definer) {
        const anchored = isAnchored(target);
        const from = anchored ? (target.origin || 0) : (state.islandZero || 0);
        if (!mapActive(map)) {
            island = { q: duration, zero: from };
        } else if (!holdsAllContent(target)) {
            island = { q: mapPeriod(map), zero: from + mapOffset(map, 0) };
        } else {
            const reAnchored = soleDefinerOrigin(target, map);
            if (anchored) origin = { to: reAnchored, lift: true };
            island = { q: mapPeriod(map), zero: reAnchored + mapOffset(map, 0) };
        }
    } else if (duration > 0) {
        const to = continuityRider(target, map);
        if (to !== null) origin = { to, lift: false };
    }

    const topBefore = topOf(target);
    setStoredMap(target, map.segs);
    reconcileStoredTop(target, topBaseFor(target, topBefore));
    if (!mapActive(storedMap(target))) target.loopBypassed = false;
    if (target.type === 'stack') {
        target.windowDomain = activeSeqLen(target) > 0 ? 'sequence' : 'intrinsic';
        if (definer) makeMembersWhole(target);
    }
    if (origin) {
        const delta = origin.to - (target.origin || 0);
        shiftOrigins(target, delta);
        if (origin.lift) liftAncestors(target, delta);
    }
    if (island) setIslandQuantum(island.q, island.zero);
}

/** A sample argument as the bridge reads it: a whole number, truncated. */
const samples = v => Math.trunc(Number(v) || 0);

/** Set the single window [loopStart, loopEnd): clamped to the material
 * on a clip and on the definer stack; refused past the inner cycle on
 * any other stack. */
export function setLoopPoints(id, loopStart, loopEnd) {
    const target = nodeOrRoot(id);
    if (!target) return;
    const isClip = target.type === 'clip';
    const duration = intrinsicOfNode(target);
    const definerStack = !isClip && islandDefiner() === target;
    const start = Math.max(0, samples(loopStart));
    const end = samples(loopEnd);
    if (!isClip && !definerStack && duration > 0 && end > duration) return;
    const clamps = isClip || definerStack;
    commitMap(target, singleSegment(start, clamps ? Math.min(end, duration) : end));
}

/** Install a cell map from the protocol's flat [s0, e0, s1, e1, …]; the
 * bridge reads at most MAX_SEGMENTS pairs. */
export function setSegments(id, flat) {
    const target = nodeOrRoot(id);
    if (!target) return;
    const segs = [];
    for (let i = 0; i + 1 < (flat || []).length && segs.length < MAX_SEGMENTS; i += 2) {
        segs.push([samples(flat[i]), samples(flat[i + 1])]);
    }
    const duration = intrinsicOfNode(target);
    if (segs.length >= 2 && duration <= 0 && target.type === 'clip') return;
    let previousEnd = 0;
    for (const [s, e] of segs) {
        if (e <= s || s < previousEnd || (duration > 0 && e > duration)) return;
        previousEnd = e;
    }
    if (segs.length === 0) return setLoopPoints(id, 0, 0);
    if (segs.length === 1) return setLoopPoints(id, segs[0][0], segs[0][1]);
    commitMap(target, { segs });
}

/** The re-time: move the node by `shiftSamples` (a group with its
 * subtree), count it into `retime`, and optionally store the top. */
export function setTiming(id, shiftSamples, topSamples = null) {
    const node = findNode(id);
    if (!node) return;
    const committed = node.type === 'stack' ? isAnchored(node) : takeLength(node) > 0;
    if (!committed || islandDefiner() === node) return;
    const shift = Number(shiftSamples);
    if (!Number.isFinite(shift)) return;
    const s = Math.round(shift);
    const top = typeof topSamples === 'number' && Number.isFinite(topSamples) &&
        topSamples >= 0 ? Math.round(topSamples) : null;
    if (top !== null && !keepsTop(storedMap(node), intrinsicOfNode(node), top)) return;
    if (s === 0 && (top === null || top === (node.storedTop ?? null))) return;
    shiftOrigins(node, s);
    node.retime = (node.retime || 0) + s;
    if (top !== null) node.storedTop = top;
}

/** Bypass toggles whether the stored map applies, not what it keeps. */
export function toggleLoopWindow(id) {
    const node = nodeOrRoot(id);
    if (node && !rootOfEmptyIsland(node)) node.loopBypassed = !node.loopBypassed;
}
