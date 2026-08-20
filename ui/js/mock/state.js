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

import { singleSegment, mapActive } from '../time_map.js';
import { lcm } from '../math_utils.js';

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
export function isQ13SoleDefiner(node) {
    return node.type === 'clip' && (node.duration || 0) > 0 &&
        committedClipCount() === 1 && !anyNodeRecording();
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

// Intrinsic composite duration (clip: duration; stack: LCM of children).
export function intrinsicOfNode(n) {
    if (n.type !== 'stack') return n.isRecording ? 0 : (n.duration || 0);
    let comp = 0;
    (n.nodes || []).forEach(c => {
        const d = intrinsicOfNode(c);
        if (d > 0) comp = comp > 0 ? lcm(comp, d) : d;
    });
    return comp;
}

/**
 * The island quantum, mirroring the C++ model (P0-3): a STORED fact
 * (`state.islandQ` — established at first commit, re-established by a
 * provisional re-trim, reverted when the last committed clip goes).
 * The legacy min-duration/declared derivation survives only for
 * scenario fixtures that predate the stored field.
 */
export function effectiveQuantumForState() {
    if (state.islandQ > 0) return state.islandQ;
    let minDuration = 0;
    let declaredQ = 0;

    const visit = (nodes) => (nodes || []).forEach(n => {
        if (n.type === 'clip' && !n.isRecording && n.duration > 0) {
            if (minDuration === 0 || n.duration < minDuration) minDuration = n.duration;
        }
        if (n.effectiveQuantum > 0 && (declaredQ === 0 || n.effectiveQuantum < declaredQ)) {
            declaredQ = n.effectiveQuantum;
        }
        if (n.nodes) visit(n.nodes);
    });
    visit(state.nodes);

    return minDuration > 0 ? minDuration : declaredQ;
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
