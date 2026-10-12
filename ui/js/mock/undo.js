/**
 * mock/undo.js — the undo and redo logs (engine twin: edit_log.cc).
 *
 * The engine logs inverse EDITS; the mock logs whole-graph SNAPSHOTS
 * (state.js serializeGraph), taken by the dispatch before an undoable
 * verb runs. Three rules make a snapshot behave as the engine's entry:
 *   - a call that leaves the graph as it found it logs nothing, and one
 *     that changed it APPLIED — the answer of an undoable verb (endCall);
 *   - a restore keeps the knobs the engine never logs (restoreStep);
 *   - a take's step is built when it settles, from the graph as it is
 *     then (pushTakeStep), so edits made under the take stay.
 */

import {
    state, serializeGraph, restoreGraph, eachNode, shiftIsland, takeLive,
} from './state.js';

const UNDOABLE = new Set([
    'createNode', 'deleteNode', 'renameNode', 'reorderNode', 'combineNodes',
    'toggleMute', 'setLoopPoints', 'toggleLoopWindow', 'setSegments', 'setTiming',
    'setNodeInput', 'setNodeInputRight', 'setPeriodSource', 'setDefiner',
    'moveChainSlot', 'addPluginToChain', 'removeChainSlot',
    'createFromTrackTemplate', 'setSequence', 'toggleSequence',
    'selectTake', 'deleteTake', 'setComp', 'importAudio', 'importAudioWithDialog',
]);
const MAX_STEPS = 128;

/** Node facts the engine keeps out of its log: mixer and monitoring. */
const KNOBS = ['pan', 'gain', 'isSoloed', 'monitor', 'midiArmed', '_scopeOn'];
/** What an edit made under a live take may change on a node that was
 * there at the arm: the tree, the wiring, the knobs. */
const LIVE_UNDER_TAKE = new Set([...KNOBS, 'id', 'type', 'nodes', 'name', 'isMuted',
    'inputChannel', 'inputChannelR', 'channels', 'effects', 'auditionStep']);

let undoStack = [];
let redoStack = [];
/** The open gesture (engine AudioEngine::gesture_): { family, arg0,
 * logged, redo } — a drag's live commits coalesce into the step its
 * first applied commit logged. */
let gesture = null;
/** The dispatch in flight: the graph an undoable verb found (`before`,
 * null for any other verb), what it pushed, and what a call that logs
 * nothing must leave behind. */
let call = { before: null, pushed: false, coalesced: false, redo: null, gesture: null };

/** Is `method` a verb the log brackets? */
export function isUndoable(method) {
    return UNDOABLE.has(method);
}

const GESTURE_FAMILY = { setSegments: 'map', setLoopPoints: 'map', setTiming: 'timing' };
const LIVE_ARG = { setSegments: 2, setLoopPoints: 3, setTiming: 3 };

function push(snap) {
    undoStack.push(snap);
    if (undoStack.length > MAX_STEPS) undoStack.shift();
    redoStack = [];
    gesture = null;
}

/** Log a snapshot taken earlier (an arm's own edits, logged once the arm
 * is certain). */
export function pushUndoSnapshot(snap) {
    push(snap);
}

/** A gesture verb's commit arrives (engine openGesture: before any
 * gate): a non-live one opens its gesture, whatever it goes on to log. */
export function noteGestureCommit(method, args) {
    if (!(method in GESTURE_FAMILY) || args[LIVE_ARG[method]] === true) return;
    gesture = { family: GESTURE_FAMILY[method], arg0: args[0], logged: false };
}

/** Before an undoable verb's handler: snapshot — unless the call is a
 * live commit of the open gesture, which joins that gesture's step. */
export function beginCall(method, args) {
    noteGestureCommit(method, args);
    call = { before: null, pushed: false, coalesced: false, redo: null, gesture };
    if (!UNDOABLE.has(method)) return;
    call.before = serializeGraph();
    const family = GESTURE_FAMILY[method];
    const live = family !== undefined && args[LIVE_ARG[method]] === true;
    call.coalesced = live && gesture !== null && gesture.logged &&
        gesture.family === family && gesture.arg0 === args[0];
    if (call.coalesced) return;
    call.redo = redoStack;
    push(call.before);
    call.pushed = true;
    if (family !== undefined) {
        gesture = { family, arg0: args[0], logged: true, redo: call.redo };
    }
}

/** After the handler: AN UNCHANGED GRAPH RECORDS NOTHING (engine: a Nop
 * is not logged) — the step goes, the redo branch it cleared returns and
 * the gesture stands as the call found it. Answers whether an undoable
 * verb changed the graph: the engine's "the edit was applied". */
export function endCall() {
    if (call.before === null) return false;
    const changed = call.before !== serializeGraph();
    if (call.pushed && !changed) {
        undoStack.pop();
        redoStack = call.redo;
        gesture = call.gesture;
    }
    call.pushed = false;
    return changed;
}

/** Did this dispatch join its gesture's logged step? */
export function coalescedThisCall() {
    return call.coalesced;
}

const historyClearedHooks = [];
export function onHistoryCleared(fn) { historyClearedHooks.push(fn); }

export function clearUndoHistory() {
    undoStack = [];
    redoStack = [];
    gesture = null;
    historyClearedHooks.forEach(fn => fn());
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

const sameSteps = (a, b) => !!a && !!b && a.steps.length === b.steps.length;

/** Restore a logged snapshot, keeping what the engine does not log: each
 * surviving node's knobs and slot settings, and a step audition while
 * its song keeps its shape. */
function restoreStep(snap) {
    const live = new Map();
    eachNode(n => live.set(n.id, n));
    restoreGraph(snap);
    eachNode(n => {
        const was = live.get(n.id);
        if (!was) return;
        for (const k of KNOBS) {
            if (k in was) n[k] = was[k];
            else delete n[k];
        }
        if (n.type === 'stack') {
            n.auditionStep = sameSteps(was.sequence, n.sequence) ? (was.auditionStep ?? -1) : -1;
        }
        const slots = new Map(((was.effects && was.effects.chain) || []).map(s => [s.slot, s]));
        if (n.effects) {
            n.effects.chain = n.effects.chain.map(s => (slots.has(s.slot) ? { ...slots.get(s.slot) } : s));
        }
    });
}

export function mockUndo() {
    if (!undoStack.length) return false;
    gesture = null;
    redoStack.push(serializeGraph());
    restoreStep(undoStack.pop());
    return true;
}

export function mockRedo() {
    if (!redoStack.length) return false;
    gesture = null;
    undoStack.push(serializeGraph());
    restoreStep(redoStack.pop());
    return true;
}

/** Engine cancelGesture: the open gesture's step is restored and
 * dropped, and the redo branch it cleared returns. True when the node is
 * as the drag found it — its step taken back, or none logged. False when
 * what the drag did stands: no gesture is open on `arg0`, or a take is
 * live (the step is kept, like undo's). */
export function mockCancelGesture(arg0) {
    const g = gesture;
    if (!g || g.arg0 !== arg0) return false;
    if (!g.logged || !undoStack.length) {
        gesture = null;
        return true;
    }
    if (takeLive()) return false;
    gesture = null;
    restoreStep(undoStack.pop());
    redoStack = g.redo || [];
    return true;
}

/** A settled take's step (engine Untake): the graph as it is now, with
 * every node that was there at the arm put back to its arm-time facts —
 * content, geometry, anchors, songs — and the island facts with them. */
export function pushTakeStep(armSnap) {
    const then = JSON.parse(armSnap);
    const now = JSON.parse(serializeGraph());
    const before = new Map();
    eachNode(n => before.set(n.id, n), then.root);
    eachNode(n => {
        const was = before.get(n.id);
        if (!was) return;
        for (const k of Object.keys(n)) if (!LIVE_UNDER_TAKE.has(k)) delete n[k];
        for (const [k, v] of Object.entries(was)) if (!LIVE_UNDER_TAKE.has(k)) n[k] = v;
    }, now.root);
    push(JSON.stringify({ ...then, root: now.root }));
}

/** A seek re-frames what the logs hold (engine shiftHistoryAbsolutes). */
export function reframeHistory(delta) {
    const shifted = snap => {
        const o = JSON.parse(snap);
        shiftIsland(o, delta);
        return JSON.stringify(o);
    };
    undoStack = undoStack.map(shifted);
    redoStack = redoStack.map(shifted);
    if (gesture && gesture.redo) gesture.redo = gesture.redo.map(shifted);
}
