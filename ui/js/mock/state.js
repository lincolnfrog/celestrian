/**
 * mock/state.js — the mock engine's one mutable state and the graph
 * queries every other mock module builds on. The laws live in the engine
 * (src/engine/definer.cc, island_geometry.cc) and docs/; a function here
 * names its twin and says only what the mock does differently.
 *
 * THE RAW NODE. publish.js lists what is published; the rest is private.
 * Lengths and positions are samples; "absolute" is the raw clock.
 *   duration        a clip's committed length — or, while its FIRST take
 *                   records, that take's live length (see takeLength)
 *   origin          absolute: where content[0] sounds; a stack's is a
 *                   fact only while `anchored`
 *   loopStart, loopEnd   the stored single window, inner positions
 *   segments        the stored cell map [[start, end], …] — never beside
 *                   a window (setStoredMap)
 *   storedTop       the ↺ top, a raw inner position; null/absent = unset
 *   retime          the cumulative user shift of the origin
 *   contentBase, collapsedFrom   a lock-collapsed clip: how far its
 *                   content view moved, and the length it had before
 *   takes           [{seed, imported?}]; absent = one implicit take
 *   comp, compCellLen, compOffset   a take index per cell, the cell
 *                   length, the first cell's inner position
 *   midi            a MIDI fixture's events [pos, status, data1, data2]
 *   _scopeOn        a panel watches the rack
 * A take in flight (gone once it settles):
 *   isRecording     a take is up here FROM THE ARM (published narrower)
 *   isPendingStart, pendingStartAt   armed; absolute start
 *   recordingStartPos                absolute: where capture began
 *   isAwaitingStop, awaitingStopAt   stop asked; the length it commits at
 *   _mapArm { C, period, innerOrigin }  a through-map take: its commit
 *                   length, its one-pass cap, its origin
 *   _retake { period, captured, cancel? }  a new take of a committed slot
 *   _retakeDone     'committed' | 'cancelled' until the performance logs
 */

import { singleSegment, mapActive, mapOffset } from '../time_map.js';
import { lcm, posMod } from '../math_utils.js';
import { activeSeqLen, auditionMapOf } from './seq_query.js';

export const ROOT_ID = 'mock-root';

/** An empty root: a stack like any other, the island's top. */
export function freshRoot() {
    return { id: ROOT_ID, type: 'stack', name: 'Root', nodes: [], gain: 1, pan: 0,
             auditionStep: -1, anchored: false, origin: 0 };
}

export const state = {
    isPlaying: false,
    root: freshRoot(),
    nextId: 1,
    masterPos: 0,            // the raw clock
    islandZero: 0,
    islandQ: 0,              // 0 = no Q yet
    definerDesignation: '',  // the node Q was handed to; '' = derived
    lastImport: null,
    lastBounce: null,
    get nodes() { return this.root.nodes; },
    set nodes(list) { this.root.nodes = list; },
};

/** The simulation step: how far the clock moves per getState() poll
 * while the transport runs. A fixed sample count, not a duration — a
 * test that plays and polls reads the clock at its multiples whatever
 * the mock's rate. */
export const DEFAULT_SAMPLES_PER_TICK = 2205;

/** The simulated clock's run state (transport.js drives it). `running`:
 * each poll ticks the clock. `stepped`: A TEST STEPS THE CLOCK — an arm
 * still starts the transport, as the engine's does, but not the poll
 * tick; time passes by advanceBy, or in real time once the test plays
 * (togglePlayback, startTransport). On from the start outside a page
 * (the node tests), and on a page that sets `window.__celestrianMockClock
 * = 'stepped'` before the mock loads (the e2e boot); transport.js
 * stepClock switches it. */
export const transport = {
    running: false,
    samplesPerTick: DEFAULT_SAMPLES_PER_TICK,
    speed: 1.0,
    stepped: typeof window === 'undefined' || globalThis.__celestrianMockClock === 'stepped',
};

export function generateId() {
    return `node-${state.nextId++}`;
}

// ---- the tree -----------------------------------------------------------

/** A node BELOW the root, by id. */
export function findNode(id, nodes = state.nodes) {
    for (const node of nodes) {
        if (node.id === id) return node;
        const found = findNode(id, node.nodes || []);
        if (found) return found;
    }
    return null;
}

/** Any node by id, the root included (engine findNodeByUuid). */
export function nodeOrRoot(id) {
    return id === ROOT_ID ? state.root : findNode(id);
}

/** The stack holding node `id` — the root for a top-level node; null for
 * the root itself and for an unknown id. */
export function findParent(id, parent = state.root) {
    for (const node of parent.nodes || []) {
        if (node.id === id) return parent;
        const found = node.type === 'stack' ? findParent(id, node) : null;
        if (found) return found;
    }
    return null;
}

/** The stacks above `node`, nearest first, the root last. */
export function ancestorsOf(node) {
    const out = [];
    for (let p = findParent(node.id); p; p = findParent(p.id)) out.push(p);
    return out;
}

export function removeNodeFromParent(id) {
    const parent = findParent(id);
    if (parent) parent.nodes = parent.nodes.filter(n => n.id !== id);
}

/** Does `pred` hold for a node in `nodes` or beneath them? */
export function someNode(pred, nodes = state.nodes) {
    return nodes.some(n => pred(n) || someNode(pred, n.nodes || []));
}

/** `visit(node)` for `node` and everything beneath it, parents first. */
export function eachNode(visit, node = state.root) {
    visit(node);
    (node.nodes || []).forEach(c => eachNode(visit, c));
}

// ---- takes and content --------------------------------------------------

/** A take is armed or capturing on this node. */
export const isLive = n => !!(n.isRecording || n.isPendingStart);

/** A take is armed or capturing in `node`'s subtree (the island's by
 * default) — engine isArmedOrRecording / hasActiveTake. */
export function takeLive(node = state.root) {
    return isLive(node) || (node.nodes || []).some(takeLive);
}

/** A clip's COMMITTED length (engine getIntrinsicDuration): 0 while its
 * first take records; the slot's while a new take of it does. */
export function takeLength(clip) {
    return clip.isRecording && !clip._retake ? 0 : (clip.duration || 0);
}

export const isCommittedClip = n => n.type === 'clip' && takeLength(n) > 0;

/** A clip's take list: `takes` once materialized, else the one implicit
 * take of a committed clip (engine takeCount). */
export function takesOf(clip) {
    if (Array.isArray(clip.takes) && clip.takes.length) return clip.takes;
    return takeLength(clip) > 0 ? [{ seed: 0 }] : [];
}

/** Committed clips in `node`'s subtree, `node` included (engine
 * countCommittedClips). */
export function committedClipCount(node = state.root) {
    if (node.type !== 'stack') return isCommittedClip(node) ? 1 : 0;
    return (node.nodes || []).reduce((n, c) => n + committedClipCount(c), 0);
}

function firstCommittedClip(node = state.root) {
    if (node.type !== 'stack') return isCommittedClip(node) ? node : null;
    for (const c of node.nodes || []) {
        const hit = firstCommittedClip(c);
        if (hit) return hit;
    }
    return null;
}

/** A node's whole inner span (engine getIntrinsicDuration): a clip's
 * take; a stack's LCM of its looping children's spans. */
export function intrinsicOfNode(n) {
    if (n.type !== 'stack') return takeLength(n);
    let span = 0;
    for (const c of n.nodes || []) {
        if (c.periodSource === 'context') continue;
        const d = intrinsicOfNode(c);
        if (d > 0) span = span > 0 ? lcm(span, d) : d;
    }
    return span;
}

// ---- maps ---------------------------------------------------------------

/** The node's STORED map, bypass ignored (engine storedMap). */
export function storedMap(n) {
    if (Array.isArray(n.segments) && n.segments.length >= 2) return { segs: n.segments };
    return singleSegment(n.loopStart || 0, n.loopEnd || 0);
}

/** Store `segs` ([[start, end], …]) as the node's one map: a cell map,
 * a single window, or none. */
export function setStoredMap(n, segs) {
    if (segs.length >= 2) {
        n.segments = segs.map(([s, e]) => [s, e]);
        n.loopStart = 0;
        n.loopEnd = 0;
        return;
    }
    delete n.segments;
    [n.loopStart, n.loopEnd] = segs.length && segs[0][1] > segs[0][0] ? segs[0] : [0, 0];
}

/** Engine storesGeometry: a cell map, or a window that is not a clip's
 * whole take. */
export function storesGeometry(n) {
    const segs = storedMap(n).segs;
    if (segs.length !== 1) return segs.length >= 2;
    const span = intrinsicOfNode(n);
    return !(n.type === 'clip' && segs[0][0] <= 0 && span > 0 && segs[0][1] >= span);
}

/** A sequence-domain window is suspended while its song is off (S16). */
export function windowSuspendedOf(n) {
    return n.type === 'stack' && n.windowDomain === 'sequence' &&
        !(activeSeqLen(n) > 0) && !n.loopBypassed && mapActive(storedMap(n));
}

/** The map the node PLAYS, or null (engine activeTimeMap): a stack's
 * step audition first, else the stored map unless bypassed or suspended. */
export function activeMapOf(n) {
    if (n.type === 'stack') {
        const audition = auditionMapOf(n);
        if (audition) return audition;
        if (windowSuspendedOf(n)) return null;
    }
    if (n.loopBypassed) return null;
    const m = storedMap(n);
    return mapActive(m) ? m : null;
}

// ---- the Q-definer (engine definer.cc) ----------------------------------

/** Engine isOneTakeStack: the committed direct clips are one take — two
 * or more, one duration, one origin, and (once anchored) that origin the
 * stack's own. */
function isOneTakeStack(stack) {
    let direct = 0, origin = stack.origin || 0, duration = 0;
    for (const c of stack.nodes || []) {
        if (c.type !== 'clip') {
            if (committedClipCount(c) > 0) return false;
            continue;
        }
        const d = takeLength(c);
        if (!(d > 0)) continue;
        if (c.periodSource === 'context') return false;
        if (direct === 0) {
            if (!stack.anchored) origin = c.origin || 0;
            duration = d;
        }
        if ((c.origin || 0) !== origin || d !== duration) return false;
        direct++;
    }
    return direct >= 2;
}

function oneTakeStackUnder(stack) {
    if (isOneTakeStack(stack)) return stack;
    let nested = null;
    for (const c of stack.nodes || []) {
        if (committedClipCount(c) === 0) continue;
        if (c.type !== 'stack' || nested) return null;
        nested = c;
    }
    return nested ? oneTakeStackUnder(nested) : null;
}

function geometryInUseOutside(node, exclude) {
    if (node === exclude) return false;
    if (!node.loopBypassed && storesGeometry(node)) return true;
    return (node.nodes || []).some(c => geometryInUseOutside(c, exclude));
}

/** Engine isDefinerTarget: may Q be handed to `node`? */
export function isDefinerTarget(node) {
    if (node === state.root || node.periodSource === 'context' || takeLive(node)) return false;
    if (node.type === 'clip') {
        if (!(takeLength(node) > 0)) return false;
    } else if (activeSeqLen(node) > 0 || !isOneTakeStack(node)) {
        return false;
    }
    return !ancestorsOf(node).some(a => a !== state.root &&
        (activeMapOf(a) || activeSeqLen(a) > 0 || a.periodSource === 'context'));
}

/** Engine holdsAllCommittedContent. */
export function holdsAllContent(node) {
    const inside = committedClipCount(node);
    return inside > 0 && inside === committedClipCount();
}

/** Engine engine_internal::definer — the one node whose map
 * re-establishes (Q, zero), or null. */
export function islandDefiner() {
    if (takeLive()) return null;
    const handed = state.definerDesignation ? findNode(state.definerDesignation) : null;
    if (handed && isDefinerTarget(handed) &&
        !(handed.type === 'stack' && auditionMapOf(handed))) return handed;
    if (committedClipCount() === 1) {
        const clip = firstCommittedClip();
        return geometryInUseOutside(state.root, clip) ? null : clip;
    }
    const stack = oneTakeStackUnder(state.root);
    if (!stack || geometryInUseOutside(state.root, stack)) return null;
    return auditionMapOf(stack) ? null : stack;
}

// ---- origins and anchors (engine island_geometry.cc) --------------------

/** Move `node` and its whole subtree by `delta`. */
export function shiftOrigins(node, delta) {
    if (!delta) return;
    eachNode(n => { n.origin = (n.origin || 0) + delta; }, node);
}

/** Engine liftAncestorsGated: the stacks anchored ON `node` follow it —
 * each ancestor, nearest first, while `node`'s subtree holds all of its
 * committed content. One that holds other content stays, and so does
 * everything above it. */
export function liftAncestors(node, delta) {
    if (!delta) return;
    const inside = committedClipCount(node);
    for (const p of ancestorsOf(node)) {
        if (committedClipCount(p) !== inside) break;
        if (p.anchored) p.origin = (p.origin || 0) + delta;
    }
}

/** Clips are always anchored; a stack once content anchored it (the
 * root: while it carries a song). */
export const isAnchored = node => node.type !== 'stack' || !!node.anchored;

/** Engine cycleTopOf: the island zero, re-based by each mapped ancestor. */
function cycleTopOf(node) {
    const parent = findParent(node.id);
    if (!parent) return state.islandZero || 0;
    const top = cycleTopOf(parent);
    const m = activeMapOf(parent);
    if (!m) return top;
    return (isAnchored(parent) ? (parent.origin || 0) : top) + mapOffset(m, 0);
}

/** The origin a node measures from: its own once anchored, else the
 * cycle top it receives. The root's is the frame top the cursor folds
 * from (engine rootFrameTop). */
export function frameOriginOf(node) {
    return isAnchored(node) ? (node.origin || 0) : cycleTopOf(node);
}

function earliestCommittedOrigin(node) {
    let best = Infinity;
    eachNode(n => { if (isCommittedClip(n)) best = Math.min(best, n.origin || 0); }, node);
    return best;
}

/** Engine settleAnchors: every stack below the root whose anchoring
 * disagrees with its content settles; a map authored before the anchor
 * is re-expressed from the new origin, or cleared when it would wrap. */
export function settleAnchors() {
    eachNode(n => {
        if (n.type !== 'stack' || n === state.root) return;
        const has = committedClipCount(n) > 0;
        if (has === !!n.anchored) return;
        if (!has) {
            n.anchored = false;
            n.origin = 0;
            return;
        }
        const origin = earliestCommittedOrigin(n);
        const shift = origin - cycleTopOf(n);
        const inner = intrinsicOfNode(n);
        const segs = storedMap(n).segs;
        if (shift !== 0 && inner > 0 && segs.length) {
            const d = posMod(shift, inner);
            const moved = segs.map(([s, e]) => (s - d < 0 ? [s - d + inner, e - d + inner]
                                                          : [s - d, e - d]));
            setStoredMap(n, moved.every(([, e]) => e <= inner)
                ? moved.sort((a, b) => a[0] - b[0]) : []);
        }
        n.anchored = true;
        n.origin = origin;
    });
}

/** A seek's phase jump on a graph — the live state, or a parsed
 * snapshot: the zero and every origin move together (an unanchored root
 * has no origin to move). */
export function shiftIsland(graph, delta) {
    graph.islandZero = (graph.islandZero || 0) + delta;
    (graph.root.nodes || []).forEach(n => shiftOrigins(n, delta));
    if (graph.root.anchored) graph.root.origin = (graph.root.origin || 0) + delta;
}

// ---- snapshots ----------------------------------------------------------

/** The graph and the island facts as a string: an undo snapshot, a
 * saved session. */
export function serializeGraph() {
    return JSON.stringify({ root: state.root, islandZero: state.islandZero,
                            islandQ: state.islandQ,
                            definerDesignation: state.definerDesignation });
}

/** A restored graph holds no take in flight: a first take's clip comes
 * back empty, a new take's slot as it stood. */
function settleRestoredTake(n) {
    if (!isLive(n) && !n.isAwaitingStop) return;
    if (!n._retake) {
        n.duration = 0;
        n.contextCycle = 0;
    }
    n.isRecording = false;
    n.isPendingStart = false;
    n.isAwaitingStop = false;
    for (const k of ['pendingStartAt', 'recordingStartPos', 'awaitingStopAt',
                     '_mapArm', '_retake', '_retakeDone']) delete n[k];
}

export function restoreGraph(snap) {
    const o = JSON.parse(snap);
    eachNode(settleRestoredTake, o.root);
    state.root = o.root;
    state.islandZero = o.islandZero || 0;
    state.islandQ = o.islandQ || 0;
    state.definerDesignation = o.definerDesignation || '';
}
