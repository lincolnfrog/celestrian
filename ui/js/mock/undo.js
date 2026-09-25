/**
 * mock/undo.js — undo/redo stacks and the per-call snapshot protocol.
 *
 * The stacks are private to this module: callers reach them only through
 * the accessors below (push/pop-for-refusal/clear/can/note/was), so the
 * refusal convention — "a refused edit records nothing" — has exactly
 * one implementation (popUndoForRefusal) instead of scattered
 * `undoStack.pop()` sites.
 */

// --- Undo / redo (mirrors AudioEngine's edits-as-events observably) ---
// The C++ engine records inverse EDITS; the mock takes the simpler
// equivalent for e2e — a snapshot of the mutable graph taken before every
// undoable mutation. Same observable contract: canUndo/canRedo on
// getState, undo() restores the pre-edit graph, a fresh edit clears redo.

import { serializeGraph, restoreGraph } from './state.js';

let undoStack = [];
let redoStack = [];
const UNDOABLE = new Set([
    'createNode', 'deleteNode', 'renameNode', 'reorderNode', 'combineNodes',
    'toggleMute', 'setLoopPoints', 'toggleLoopWindow',
    'setSegments', 'setNodeInput', 'setNodeInputRight', 'setPeriodSource',
    // Q22: handing Q to a track is one undo step (island facts ride it).
    'setDefiner',
    // Chain STRUCTURE is undoable (docs/vst3.md §6); slot enable/params
    // stay non-undoable knobs like pan/gain.
    'moveChainSlot', 'addPluginToChain', 'removeChainSlot',
    // Q17: a template insert is ONE undoable step — a 5-track group
    // arrives and departs the undo log whole (engine: single Insert
    // edit). saveTrackTemplate is a LIBRARY write, deliberately absent.
    'createFromTrackTemplate',
    // The SEQUENCER (docs/sequencer.md): both verbs are musical facts
    // (engine parity: Edit::Sequence / Edit::SequenceBypass).
    'setSequence', 'toggleSequence',
    // Takes (docs/takes.md): selection, deletion and the comp are
    // musical facts (engine parity: Edit::SelectTake / DeleteTake /
    // Comp). newTake rides the take's pending snapshot like record.
    'selectTake', 'deleteTake', 'setComp',
    // Audio file import (docs/import.md): a committed take arrives
    // whole in one call (engine parity: the Untake entry is logged in
    // the same message-thread call), so the dispatch snapshot IS the
    // take's undo entry.
    'importAudio', 'importAudioWithDialog',
    // The re-time (loop_selection.md §9, engine parity Edit::Timing):
    // origin, re-time and top in one step.
    'setTiming',
]);

let undoPushedForCall = false;
let coalescedForCall = false;  // this dispatch joined its gesture's step
let redoSavedForCall = null;  // the redo branch, restorable on refusal
// THE OPEN GESTURE (see the live-drag notes below).
let gesture = null;           // { family, arg0, logged } — null: none open
let gestureOnArrival = null;  // what a call that logs nothing leaves

/** Push a pre-edit snapshot (a fresh action invalidates the redo branch). */
export function pushUndo() {
    pushUndoSnapshot(serializeGraph());
}

/** Push a snapshot taken EARLIER (takes: captured at arm, logged at
 * commit — engine parity, reconcileTakes). */
export function pushUndoSnapshot(snap) {
    undoStack.push(snap);
    if (undoStack.length > 128) undoStack.shift();
    redoStack = [];  // a fresh action invalidates the redo branch
    gesture = null;  // any step logged ends the open gesture
}

/**
 * LIVE map-edit drags stream commits (audible splice preview): a commit
 * carrying the trailing `live` flag COALESCES into its gesture's undo
 * step (the oldest snapshot restores furthest). Owner ruling
 * 2026-09-10: only live commits merge — separate gestures are separate
 * undo steps. A gesture's map commits may switch verb (setSegments ↔
 * setLoopPoints); a re-time drag (setTiming's trailing `live`) coalesces
 * the same way, but only into a re-time: swap and shift are different
 * gestures (engine sameGesture).
 *
 * THE OPEN GESTURE (engine parity AudioEngine::gesture_, edit_log.cc) is
 * TRACKED, never read off the last call: a whole-Q drag's first commit
 * is usually an IDENTITY (the pointer engaged, no whole Q crossed yet)
 * that records nothing, so the step on top may be the PREVIOUS
 * gesture's on the same lane. A non-live commit opens its gesture
 * whatever it records (noteGestureCommit); the gesture's first live
 * commit to apply logs its step; the live commits after it coalesce. A
 * live commit that records nothing (an identity, a refusal) keeps the
 * gesture — a drag that dwells, or returns to its start, is one step —
 * and so does any call that logs nothing. Any other step logged
 * (another node or family, a take), an undo and a redo end it, so a
 * stray live commit logs its own step instead of joining an unrelated
 * one.
 */
const GESTURE_FAMILY = {
    setSegments: 'map', setLoopPoints: 'map', setTiming: 'timing',
};
const LIVE_ARG = { setSegments: 2, setLoopPoints: 3, setTiming: 3 };

/** A gesture verb's commit ARRIVES (engine parity: setLoopPoints,
 * setSegments and setTiming open the gesture before any gate — the
 * dispatch's live-take gate included): a non-live one opens its
 * gesture, whatever it goes on to record. */
export function noteGestureCommit(method, arg0, args = []) {
    if (!(method in GESTURE_FAMILY) || args[LIVE_ARG[method]] === true) return;
    gesture = { family: GESTURE_FAMILY[method], arg0, logged: false };
}

/**
 * The dispatch-side undo interception (called by callNative before the
 * handler runs). Snapshot BEFORE any undoable mutation so undo restores
 * the pre-edit graph (single interception point, mirrors
 * AudioEngine::record) — unless the call is a live commit of the open
 * gesture, which coalesces into the step that gesture logged.
 */
export function interceptUndoableCall(method, arg0, args = []) {
    undoPushedForCall = false;
    coalescedForCall = false;
    noteGestureCommit(method, arg0, args);
    gestureOnArrival = gesture;
    if (!UNDOABLE.has(method)) return;
    const family = GESTURE_FAMILY[method];
    const live = family !== undefined && args[LIVE_ARG[method]] === true;
    const coalesce = live && gesture !== null && gesture.logged &&
        gesture.family === family && gesture.arg0 === arg0;
    coalescedForCall = coalesce;
    if (coalesce) return;
    // Save the redo branch BEFORE the push clears it: a REFUSED edit
    // mutates nothing, so it must not destroy the user's redo either —
    // engine parity (AudioEngine::record clears redo only for edits that
    // actually apply). pushUndoSnapshot replaces the array, so the saved
    // reference survives intact.
    redoSavedForCall = redoStack;
    pushUndo();
    undoPushedForCall = true;
    // A map or re-time step is its gesture's FIRST (engine parity
    // record) — the one a non-live commit opened, or a stray live
    // commit's own. A refusal takes it back (popUndoForRefusal).
    if (family !== undefined) gesture = { family, arg0, logged: true };
}

/** Did the current dispatch push a snapshot? (Coalesced calls didn't.) */
function wasPushedThisCall() {
    return undoPushedForCall;
}

/** Did the current dispatch COALESCE into its gesture's logged step (a
 * live commit of the same gesture)? A live map commit then reconciles
 * the top against the gesture's first state (mock/maps.js topBaseFor). */
export function coalescedThisCall() {
    return coalescedForCall;
}

/**
 * The refusal convention (engine parity): a REFUSED edit — or an
 * identity — records nothing: the dispatch snapshotted before the
 * handler could refuse, so every such path calls this to drop that
 * snapshot (only if the dispatch pushed one for THIS call — coalesced
 * calls didn't). The gesture stands as the call's ARRIVAL left it: a
 * non-live commit's gesture open with no step logged, anything else's
 * untouched — a live commit that records nothing never breaks its
 * gesture's chain.
 */
export function popUndoForRefusal() {
    if (undoPushedForCall) {
        undoStack.pop();
        // Restore the redo branch the dispatch's push cleared — a
        // refusal is a no-op, and no-ops keep redo.
        if (redoSavedForCall) redoStack = redoSavedForCall;
        undoPushedForCall = false;
    }
    redoSavedForCall = null;
    gesture = gestureOnArrival;
}

/** Drop all history (fresh session / scenario load / session load). */
export function clearUndoHistory() {
    undoStack = [];
    redoStack = [];
    gesture = null;
    historyClearedHooks.forEach(fn => fn());
}

// Modules holding history-adjacent state (recording.js' pending takes)
// register here; no import cycle (recording imports undo).
const historyClearedHooks = [];
export function onHistoryCleared(fn) { historyClearedHooks.push(fn); }

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function mockUndo() {
    if (!undoStack.length) return false;
    gesture = null;  // a later live commit logs its own step
    redoStack.push(serializeGraph());
    restoreGraph(undoStack.pop());
    return true;
}

export function mockRedo() {
    if (!redoStack.length) return false;
    gesture = null;  // a later live commit logs its own step
    undoStack.push(serializeGraph());
    restoreGraph(redoStack.pop());
    return true;
}
