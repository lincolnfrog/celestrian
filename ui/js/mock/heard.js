/**
 * mock/heard.js — "which inner position sounds at clock t" over the raw
 * mock node: the twin of src/heard_index.h, function for function, built
 * on the shared equations (time_map.js innerAt / stackFold, period_law.js
 * scopeCycleOf). A scope is { frameTop, contextCycle, quantum }; what a
 * node receives is { clock, scope }.
 *
 * originForHeard, nearestRepresentative and continuityOriginFor are pure
 * algebra with no JS home outside the mock (golden:
 * `continuity_origin_cases`).
 */

import { posMod } from '../math_utils.js';
import {
    innerAt, stackFold, mapPeriod, mapOffset, mapActive, heardOffsetOf, singleSegment,
} from '../time_map.js';
import { ownPeriod, scopeCycleOf } from '../period_law.js';
import { sequenceProgram } from '../sequence_program.js';
import {
    state, activeMapOf, isAnchored, intrinsicOfNode, ancestorsOf,
} from './state.js';
import { law, effectiveCycle } from './cycles.js';
import { activeSeqLen, anyCue, visitIndexAt, seqBounds, stepCued } from './seq_query.js';

const NO_MAP = { segs: [] };

/** The island frame (engine AudioEngine::rootScope). */
function rootScope() {
    return { frameTop: state.islandZero || 0, contextCycle: effectiveCycle(),
             quantum: state.islandQ };
}

export function effectiveMap(node, scope) {
    return activeMapOf(node) || singleSegment(0, node.periodSource === 'context'
        ? ownPeriod(node, law(scope.quantum)) : intrinsicOfNode(node));
}

function frameOrigin(node, scope) {
    return isAnchored(node) ? (node.origin || 0) : scope.frameTop;
}

function ownFold(node, map, scope) {
    const shot = mapPeriod(map);
    return node.periodSource === 'context' ? Math.max(scope.contextCycle, shot) : shot;
}

/** The node equation at the node's RECEIVED clock: innerAt's answer. */
export function ownInnerAt(node, clock, scope) {
    const m = effectiveMap(node, scope);
    if (!(mapPeriod(m) > 0)) return { h: 0, inner: 0, run: 1, rest: false };
    return innerAt(clock, frameOrigin(node, scope), m, ownFold(node, m, scope));
}

function foldedClockAt(stack, r, O, map) {
    const fold = stackFold(map || NO_MAP, stack.periodSource === 'context',
        ownPeriod(stack, law(r.scope.quantum)), r.scope.contextCycle);
    return fold.folds ? O + innerAt(r.clock, O, fold.eff, fold.fold).inner : r.clock;
}

/** The song position a sequenced stack reads at what it receives; −1
 * with no active song. */
export function songPositionAt(stack, r) {
    const total = activeSeqLen(stack);
    if (!(total > 0)) return -1;
    const O = frameOrigin(stack, r.scope);
    return posMod(foldedClockAt(stack, r, O, activeMapOf(stack)) - O, total);
}

/** THE DESCENT: what `node` receives at transport clock `t`. */
export function receivedAt(node, t, root = rootScope()) {
    const r = { clock: t, scope: root };
    for (const stack of ancestorsOf(node).reverse()) {
        const map = activeMapOf(stack);
        const O = frameOrigin(stack, r.scope);
        const child = {
            quantum: r.scope.quantum,
            frameTop: map ? O + mapOffset(map, 0) : r.scope.frameTop,
            contextCycle: scopeCycleOf(stack, law(r.scope.quantum), r.scope.contextCycle),
        };
        let clock = foldedClockAt(stack, r, O, map);
        const total = activeSeqLen(stack);
        if (total > 0 && anyCue(stack.sequence)) {
            const srel = posMod(clock - O, total);
            const k = visitIndexAt(stack.sequence, srel);
            if (stepCued(stack.sequence, sequenceProgram(stack.sequence).visits[k])) {
                clock = O + (srel - seqBounds(stack.sequence)[k]);
                child.frameTop = O;
            }
        }
        r.clock = clock;
        r.scope = child;
    }
    return r;
}

/** Fold an inner position into the window [start, start + len). */
export function foldIntoWindow(p, start, len) {
    return len > 0 ? start + posMod(p - start, len) : start;
}

export function originForHeard(m, t0, p, fallbackH) {
    const period = mapPeriod(m);
    let h = heardOffsetOf(m, p);
    if (h < 0) h = period > 0 ? posMod(fallbackH, period) : 0;
    return t0 - mapOffset(m, 0) - h;
}

export function nearestRepresentative(x, ref, m) {
    if (!(m > 0)) return x;
    let r = posMod(x - ref, m);
    if (r >= m - Math.floor(m / 2)) r -= m;
    return ref + r;
}

export function continuityOriginFor(oldMap, newMap, origin, t0, oldFold, newFold) {
    if (!(mapPeriod(oldMap) > 0) || !(mapPeriod(newMap) > 0)) return origin;
    const at = innerAt(t0, origin, oldMap, oldFold);
    if (at.rest) return origin;
    if (heardOffsetOf(newMap, at.inner) < 0) return origin;
    return nearestRepresentative(originForHeard(newMap, t0, at.inner, 0), origin,
        Math.max(newFold, mapPeriod(newMap)));
}

/** Engine continuityOrigin (island_geometry.cc): the origin at which
 * what sounds at `t0` keeps sounding once the node's map is `newMap`.
 * Read BEFORE the map is stored. */
export function continuityOrigin(node, newMap, t0) {
    const whole = singleSegment(0, intrinsicOfNode(node));
    const oldm = activeMapOf(node) || whole;
    const newm = mapActive(newMap) ? newMap : whole;
    const r = receivedAt(node, t0);
    return continuityOriginFor(oldm, newm, frameOrigin(node, r.scope), r.clock,
        ownFold(node, oldm, r.scope), ownFold(node, newm, r.scope));
}
