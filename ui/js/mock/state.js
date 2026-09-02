/**
 * mock/state.js — the mock engine's single mutable state root, plus the
 * pure graph queries every other mock module builds on (find/walk/count
 * helpers, the island quantum derivation, and graph serialization shared
 * by undo snapshots and the in-memory session "disk").
 *
 * The `state` object is a SINGLETON: it is exported `const` and never
 * rebound — mutate its properties (undo restore and session load assign
 * `state.nodes = ...` etc., and every module sees the change through the
 * live binding). The full shape is declared up front so downstream code
 * can read `state.masterPos` / `state.islandQ` without `|| 0` guards.
 */

import { singleSegment, mapActive, mapOffset, mapPeriod } from '../time_map.js';
import { lcm, posMod } from '../math_utils.js';

// In-memory state
export const state = {
    isPlaying: false,
    nodes: [],
    nextId: 1,
    masterPos: 0,     // the raw monotonic clock, in samples
    islandEpoch: 0,   // the island frame origin (P0-3 stored fact)
    islandQ: 0,       // the STORED island quantum (0 = unestablished)
    masterGain: 1,    // the root output stage — the master fader
    rootAuditionStep: -1,  // the root's step audition (§11.2), −1 = none
};

// Generate unique IDs
export function generateId() {
    return `node-${state.nextId++}`;
}

// Find node by ID (recursive for stacks)
export function findNode(id, nodes = state.nodes) {
    for (const node of nodes) {
        if (node.id === id) return node;
        if (node.type === 'stack' && node.nodes) {
            const found = findNode(id, node.nodes);
            if (found) return found;
        }
    }
    return null;
}

// Find parent of a node
export function findParent(nodeId, nodes = state.nodes, parent = null) {
    for (const node of nodes) {
        if (node.id === nodeId) return parent;
        if (node.type === 'stack' && node.nodes) {
            const found = findParent(nodeId, node.nodes, node);
            if (found !== null) return found;
        }
    }
    return null;
}

// Remove node from parent
export function removeNodeFromParent(nodeId) {
    const parent = findParent(nodeId);
    if (parent && parent.nodes) {
        parent.nodes = parent.nodes.filter(n => n.id !== nodeId);
    } else {
        // Top-level
        state.nodes = state.nodes.filter(n => n.id !== nodeId);
    }
}

/**
 * Depth-first "does ANY node satisfy `pred`" walk — the shared skeleton
 * behind anyNodeRecording, subtreeRecording, and the VU's any-audio
 * probe (each was a hand-rolled recursive `some` before the split).
 */
export function someNode(pred, nodes = state.nodes) {
    return (nodes || []).some(n => pred(n) || someNode(pred, n.nodes || []));
}

// Any armed/capturing take (parity with StackNode::hasActiveTake) —
// gates provisional re-trim: a performing take already plays against
// the current grid, so a drag mid-take is an ordinary window edit.
export function anyNodeRecording() {
    return someNode(n => n.isRecording);
}

// A live take anywhere in this subtree (parity with the engine's
// per-node isArmedOrRecording) — gates mid-take map edits.
export function subtreeRecording(node) {
    if (!node) return false;
    return someNode(n => n.isRecording, [node]);
}

// Committed clips in the island (parity with
// AudioEngine::islandCommittedClipCount) — drives Q13 mutability.
export function committedClipCount() {
    let n = 0;
    (function visit(nodes) {
        (nodes || []).forEach(node => {
            if (node.type === 'clip' && !node.isRecording && (node.duration || 0) > 0) n++;
            if (node.nodes) visit(node.nodes);
        });
    })(state.nodes);
    return n;
}

/**
 * The island's single committed clip — the Q13 definer. Pre-order walk,
 * first committed clip wins; only meaningful when committedClipCount()
 * is 1 (the lock-collapse and re-open paths both gate on that first).
 */
export function findSoleCommittedClip(nodes = state.nodes) {
    for (const n of nodes || []) {
        if (n.type === 'clip' && !n.isRecording && (n.duration || 0) > 0) return n;
        const c = n.nodes && findSoleCommittedClip(n.nodes);
        if (c) return c;
    }
    return null;
}

/**
 * Q13 sole-definer predicate: `node` is a committed clip AND the
 * island's ONLY committed content, with no take in flight — the state
 * in which its window/map edits re-establish Q rather than obey it.
 * (Shared by the setLoopPoints / setSegments guards and re-trims.)
 */
/**
 * ONLY GEOMETRY WINS (audit 2026-08-31, engine parity
 * hasActiveGeometryOutside): true when any node OUTSIDE `exclude`'s
 * subtree carries an active window or map override. A Q13
 * re-establishment under such geometry would strand it permanently
 * incoherent with the new grid; ancestor warps are covered too (they
 * are outside the subtree). A committed clip's full-span [0, D)
 * window is commit furniture, not geometry.
 */
export function activeGeometryOutside(exclude, nodes = state.nodes) {
    for (const n of nodes || []) {
        if (n === exclude) continue;
        if (Array.isArray(n.segments) && n.segments.length >= 2 &&
            !n.loopBypassed) return true;
        const ls = n.loopStart || 0, le = n.loopEnd || 0;
        const fullSpanClip = n.type === 'clip' && ls <= 0 &&
            (n.duration || 0) > 0 && le >= n.duration;
        if (le > ls && !fullSpanClip && !n.loopBypassed) return true;
        if (n.type === 'stack' && activeGeometryOutside(exclude, n.nodes)) {
            return true;
        }
    }
    return false;
}

export function isQ13SoleDefiner(node) {
    if (!(node.type === 'clip' && (node.duration || 0) > 0 &&
          committedClipCount() === 1 && !anyNodeRecording())) return false;
    // ONLY GEOMETRY WINS (see activeGeometryOutside; subsumes the
    // ancestor-warp guard — ancestors are outside the subtree).
    return !activeGeometryOutside(node);
}

function committedClipCountIn(nodes) {
    let n = 0;
    (function visit(list) {
        (list || []).forEach(node => {
            if (node.type === 'clip' && !node.isRecording && (node.duration || 0) > 0) n++;
            if (node.nodes) visit(node.nodes);
        });
    })(nodes);
    return n;
}

/** True when `node` IS the island's definer stack and no take is in
 * flight — the state in which its window re-establishes Q. */
export function isQ13DefinerStack(node) {
    if (!node || node.type !== 'stack' || anyNodeRecording()) return false;
    // A live step audition derives its own window over the stack — its
    // geometry is not the definer's to re-establish (audit 2026-08-31
    // E7, engine parity: !ds->auditionActive()).
    if (typeof node.auditionStep === 'number' && node.auditionStep >= 0) {
        return false;
    }
    const d = definerStackNode();
    if (d !== node) return false;
    // ONLY GEOMETRY WINS (engine parity: definerStack's outside scan).
    return !activeGeometryOutside(node);
}

/**
 * Q13 FOR GROUPS (owner ruling 2026-08-21, engine parity
 * `definerStack`): the island's DEFINER STACK — the stack whose direct
 * clip children are the island's ONLY committed content and were
 * recorded as ONE take (identical origin and duration), two or more of
 * them (a single committed clip keeps the clip-definer path). Its
 * window re-establishes (Q, epoch) exactly as a sole clip's does.
 * Walks from the root's child list; returns the stack node or null.
 */
export function definerStackNode(nodes = state.nodes, owner = null) {
    let direct = 0, origin = 0, duration = 0, nested = null;
    for (const n of nodes || []) {
        if (n.type === 'clip') {
            if (n.isRecording || !(n.duration > 0)) continue;
            // A one-shot member reads its period from CONTEXT — not
            // "one take looping as one part" (audit 2026-08-31 U4;
            // engine definerStack and VM definerStackOf agree).
            if (n.periodSource === 'context') return null;
            if (direct === 0) { origin = n.origin || 0; duration = n.duration; }
            else if ((n.origin || 0) !== origin || n.duration !== duration) return null;
            direct++;
        } else if (n.type === 'stack' && committedClipCountIn(n.nodes) > 0) {
            if (nested || direct > 0) return null;
            nested = n;
        }
    }
    if (nested) {
        if (direct !== 0) return null;
        // WRAPPER WARP GUARD (audit 2026-08-31 E7, engine parity): a
        // stack on the path that remaps time — an active override or
        // its own engaged window — sits between the island clock and
        // the definer. No definer through a warp.
        const wrapper = owner || null;
        if (wrapper && ((Array.isArray(wrapper.segments) &&
                         wrapper.segments.length >= 2) ||
                        (!wrapper.loopBypassed &&
                         (wrapper.loopEnd || 0) > (wrapper.loopStart || 0)))) {
            return null;
        }
        return definerStackNode(nested.nodes, nested);
    }
    return direct >= 2 ? owner : null;
}

// A node's RAW map geometry (phase 3): the multi-segment override when
// installed, else the single window. Callers gate on loopBypassed
// themselves (parity with activeTimeMap's split responsibilities).
export function nodeMap(n) {
    if (n.segments && n.segments.length >= 2) return { segs: n.segments };
    return singleSegment(n.loopStart || 0, n.loopEnd || 0);
}

// The node's ACTIVE map (engine parity: StackNode::activeTimeMap): a
// stack's step audition (docs/sequencer.md §11.2) is a DERIVED window
// that wins over the authored one; otherwise the authored window iff
// not bypassed. Returns null when no map applies. (Defined here, the
// shared query layer, so cycles/publish/recording all agree.)
export function activeMapOf(n) {
    if (n.type === 'stack') {
        const a = auditionMapOf(n);
        if (a) return a;
        if (windowSuspendedOf(n)) return null;  // S16
    }
    if (n.loopBypassed) return null;
    const m = nodeMap(n);
    return mapActive(m) ? m : null;
}

// S16 (docs/sequencer.md §11.8): a sequence-domain window is SUSPENDED
// while the sequence is off (bypassed/cleared) — never deleted.
export function windowSuspendedOf(n) {
    if (n.type !== 'stack' || n.windowDomain !== 'sequence') return false;
    const seqOn = !n.sequenceBypassed && n.sequence &&
        (n.sequence.steps || []).some(s => s.len > 0);
    if (seqOn) return false;
    return !n.loopBypassed && mapActive(nodeMap(n));
}

// Lazy twin of mock/sequence.js auditionMap (no import cycle: sequence.js
// imports state.js). Kept minimal and in lockstep.
export function auditionMapOf(holder) {
    const i = holder.auditionStep;
    if (!(i >= 0) || holder.sequenceBypassed) return null;
    const steps = holder.sequence && holder.sequence.steps;
    if (!steps || i >= steps.length) return null;
    let b = 0;
    for (let k = 0; k < i; k++) b += steps[k].len > 0 ? Math.round(steps[k].len) : 0;
    const len = steps[i].len > 0 ? Math.round(steps[i].len) : 0;
    return len > 0 ? { segs: [[b, b + len]] } : null;
}

// The ROOT's active map (the root's audition — the root has no authored
// window in the mock).
export function rootActiveMap() {
    return auditionMapOf({
        auditionStep: state.rootAuditionStep ?? -1,
        sequenceBypassed: state.rootSequenceBypassed,
        sequence: state.rootSequence,
    });
}

// Intrinsic composite duration (clip: duration; stack: LCM of the
// LOOPING children — one-shots excluded, engine parity
// StackNode::getIntrinsicDuration / composition.md §1).
export function intrinsicOfNode(n) {
    if (n.type !== 'stack') return n.isRecording ? 0 : (n.duration || 0);
    let comp = 0;
    (n.nodes || []).forEach(c => {
        if (c.periodSource === 'context') return;
        const d = intrinsicOfNode(c);
        if (d > 0) comp = comp > 0 ? lcm(comp, d) : d;
    });
    return comp;
}

// --- Q18: origins on every node (composition.md §5, engine parity
// AudioEngine::settleAnchors / shiftOriginsGated / cycleTopOf) ---

/** Committed content anywhere in `node`'s subtree (engine
 * hasCommittedContent): a clip with material, or a stack holding one. */
export function hasCommittedContent(node) {
    if (node.type !== 'stack') return !node.isRecording && (node.duration || 0) > 0;
    return (node.nodes || []).some(hasCommittedContent);
}

/** The earliest committed descendant's origin (Infinity when none). */
export function earliestCommittedOrigin(node) {
    if (node.type !== 'stack') {
        return hasCommittedContent(node) ? (node.origin || 0) : Infinity;
    }
    let best = Infinity;
    for (const c of node.nodes || []) best = Math.min(best, earliestCommittedOrigin(c));
    return best;
}

/** shiftOrigins (composition.md §5, I11): re-anchoring a node
 * re-anchors its SUBTREE — the node's origin and every descendant's
 * move by the same delta. The one primitive behind the definer trim,
 * continuity, lock-collapse and seek, for clips and stacks alike. */
export function shiftOrigins(node, delta) {
    if (!delta) return;
    node.origin = (node.origin || 0) + delta;
    if (node.type === 'stack') (node.nodes || []).forEach(c => shiftOrigins(c, delta));
}

/** A stack's anchoring (engine StackNode::isAnchored): true once
 * committed content exists in its subtree and the settle stored an
 * origin. Clips are always anchored. */
export function isAnchored(node) {
    return node.type !== 'stack' || !!node.anchored;
}

/** The RECEIVED cycle top of `node`'s frame (engine AudioEngine::
 * cycleTopOf): the island epoch, mapped down through every enclosing
 * active map — each mapping ancestor's child frame tops at
 * O + mapOffset(0), O being its own origin once anchored, else the top
 * it received. The mock's root is synthetic (no node): its frame is
 * the epoch, through the root's step audition when one is on. */
export function cycleTopOf(node) {
    const parent = findParent(node.id);
    if (!parent) {
        const top = state.islandEpoch || 0;
        const m = rootActiveMap();
        return m ? top + mapOffset(m, 0) : top;
    }
    const top = cycleTopOf(parent);
    const m = activeMapOf(parent);
    if (!m) return top;
    const O = parent.anchored ? (parent.origin || 0) : top;
    return O + mapOffset(m, 0);
}

/** THE ANCHOR (composition.md §2): the origin a node's inner timeline
 * is measured from — its own once anchored (clips always), else the
 * received cycle top (the empty case; engine StackNode::frameOrigin). */
export function frameOriginOf(node) {
    return isAnchored(node) ? (node.origin || 0) : cycleTopOf(node);
}

/** THE NODE EQUATION (engine heard::nodeInner): the inner position
 * `node` presents at clock `t` under `map` (its active map, else its
 * whole inner span) anchored at `origin`:
 * inner(t) = mapOffset((t − O − a0) mod P). */
export function innerUnder(map, origin, t) {
    const period = mapPeriod(map);
    if (!(period > 0)) return 0;
    return mapOffset(map, posMod(t - origin - mapOffset(map, 0), period));
}

/** A node's effective map (engine heard::effectiveMap): the active
 * map, else the full inner span [0, D). */
export function effectiveMapOf(node) {
    const m = activeMapOf(node);
    if (m && mapPeriod(m) > 0) return m;
    return { segs: [[0, intrinsicOfNode(node)]] };
}

/** nodeInner(node, t): the node equation on the node's current state. */
export function nodeInner(node, t) {
    return innerUnder(effectiveMapOf(node), frameOriginOf(node), t);
}

/** The origin that makes a node present inner position `p` at `t0`
 * under map `m` (engine heard::originForHeard) — or, when the new map
 * no longer covers `p`, the old heard phase `fallbackH` folded into the
 * new period. */
export function originForHeard(m, t0, p, fallbackH) {
    const period = mapPeriod(m);
    let h = heardOffsetOfMap(m, p);
    if (h < 0) h = posMod(fallbackH, period);
    return t0 - mapOffset(m, 0) - h;
}

// (Lazy twin of time_map.heardOffsetOf — kept local so state.js stays
// the leaf module; identical semantics.)
function heardOffsetOfMap(map, inner) {
    let acc = 0;
    for (const [s, e] of map.segs || []) {
        if (inner >= s && inner < e) return acc + (inner - s);
        acc += e - s;
    }
    return -1;
}

/**
 * SETTLE ANCHORS (engine AudioEngine::settleAnchors, composition.md
 * §5): every stack whose anchoring disagrees with its content settles —
 * the first committed content under a stack anchors it at the EARLIEST
 * committed descendant's origin (set once, never re-derived while
 * anchored); the last content leaving un-anchors it. Geometry authored
 * while unanchored was expressed from the received cycle top: it is
 * re-expressed from the new origin so nothing audible moves (a window
 * the new origin cannot carry is cleared — the establishment-scrub
 * discipline). Pre-order, like the engine's forEachStack: a parent's
 * anchoring is settled before its children read their cycle top.
 * Undo needs no riders here: the snapshot restores the exact stored
 * `anchored`/`origin` (the engine's Edit::anchors made observable).
 */
export function settleAnchors(nodes = state.nodes) {
    (nodes || []).forEach(n => {
        if (n.type !== 'stack') return;
        settleStack(n);
        settleAnchors(n.nodes);
    });
}

function settleStack(n) {
    const has = hasCommittedContent(n);
    if (has === !!n.anchored) return;
    if (!has) {
        n.anchored = false;
        n.origin = 0;
        return;
    }
    const oldTop = cycleTopOf(n);
    const origin = earliestCommittedOrigin(n);
    const shift = origin - oldTop;  // inner positions move by −shift
    const inner = intrinsicOfNode(n);
    if (shift !== 0 && inner > 0) {
        const d = posMod(shift, inner);
        const shifted = ([s, e]) => {
            let ns = s - d, ne = e - d;
            if (ns < 0) { ns += inner; ne += inner; }
            return ne <= inner ? [ns, ne] : null;  // representable?
        };
        if (Array.isArray(n.segments) && n.segments.length >= 2) {
            const fresh = n.segments.map(shifted);
            if (fresh.every(Boolean)) {
                n.segments = fresh.sort((a, b) => a[0] - b[0]);
            } else {
                delete n.segments;
                n.loopStart = 0;
                n.loopEnd = 0;
                console.log('[MockBackend] cleared a pre-anchor map on', n.id);
            }
        } else if ((n.loopEnd || 0) > (n.loopStart || 0)) {
            const w = shifted([n.loopStart || 0, n.loopEnd || 0]);
            if (w) { [n.loopStart, n.loopEnd] = w; }
            else {
                n.loopStart = 0;
                n.loopEnd = 0;
                console.log('[MockBackend] cleared a pre-anchor window on', n.id);
            }
        }
    }
    n.anchored = true;
    n.origin = origin;
}

/**
 * The island quantum, mirroring the C++ model (P0-3): a STORED fact
 * (`state.islandQ` — established at first commit, re-established by a
 * provisional re-trim, reverted when the last committed clip goes;
 * 0 = unestablished). Scenario fixtures set it directly, so there is
 * no derivation from node durations here.
 */
export function effectiveQuantumForState() {
    return state.islandQ;
}

/**
 * Serialize the mutable graph + island facts to a JSON string — the
 * shared form behind undo snapshots AND the in-memory saved session
 * (they were two identical stringify sites before the split).
 */
export function serializeGraph() {
    return JSON.stringify({ nodes: state.nodes, islandEpoch: state.islandEpoch,
                            islandQ: state.islandQ,
                            // The root's sequence (docs/sequencer.md) —
                            // node-level sequences ride state.nodes.
                            rootSequence: state.rootSequence || null,
                            rootSequenceBypassed: !!state.rootSequenceBypassed });
}

/** Restore a serializeGraph() string into the live state singleton. */
export function restoreGraph(snap) {
    const o = JSON.parse(snap);
    state.nodes = o.nodes;
    state.islandEpoch = o.islandEpoch;
    state.islandQ = o.islandQ || 0;
    state.rootSequence = o.rootSequence || null;
    state.rootSequenceBypassed = !!o.rootSequenceBypassed;
}
