/**
 * mock/undo.js — undo/redo stacks and the per-call snapshot protocol.
 *
 * The stacks are private to this module: callers reach them only through
 * the accessors below (push/pop-for-refusal/clear/can/mark/was), so the
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
    'setNodePosition', 'toggleMute', 'setLoopPoints', 'toggleLoopWindow',
    'setSegments', 'setNodeInput', 'setNodeInputRight', 'setPeriodSource',
    // Chain STRUCTURE is undoable (docs/vst3.md §6); slot enable/params
    // stay non-undoable knobs like pan/gain.
    'moveChainSlot', 'addPluginToChain', 'removeChainSlot',
    // Q17: a template insert is ONE undoable step — a 5-track group
    // arrives and departs the undo log whole (engine: single Insert
    // edit). saveTrackTemplate is a LIBRARY write, deliberately absent.
    'createFromTrackTemplate',
]);

let lastUndoable = { method: null, arg0: null };
let undoPushedForCall = false;

/** Push a pre-edit snapshot (a fresh action invalidates the redo branch). */
export function pushUndo() {
    undoStack.push(serializeGraph());
    if (undoStack.length > 128) undoStack.shift();
    redoStack = [];  // a fresh action invalidates the redo branch
}

/**
 * The dispatch-side undo interception (called by callNative before the
 * handler runs). Snapshot BEFORE any undoable mutation so undo restores
 * the pre-edit graph (single interception point, mirrors
 * AudioEngine::record).
 * LIVE map-edit drags stream setSegments (audible splice preview):
 * consecutive commits on the same node COALESCE to one undo step
 * (mirrors editsCoalesce; the oldest snapshot restores furthest).
 */
export function interceptUndoableCall(method, arg0) {
    undoPushedForCall = false;
    if (UNDOABLE.has(method)) {
        const coalesce = method === 'setSegments' &&
            lastUndoable.method === 'setSegments' &&
            lastUndoable.arg0 === arg0;
        if (!coalesce) {
            pushUndo();
            undoPushedForCall = true;
        }
    }
    lastUndoable = { method, arg0 };
}

/** Did the current dispatch push a snapshot? (Coalesced calls didn't.) */
export function wasPushedThisCall() {
    return undoPushedForCall;
}

/**
 * The refusal convention (engine parity): a REFUSED edit records
 * nothing — the dispatch snapshotted before the handler could refuse,
 * so every refusal path calls this to drop that snapshot (only if the
 * dispatch pushed one for THIS call — coalesced calls didn't) and
 * break the coalescing chain (nothing mutated).
 */
export function popUndoForRefusal() {
    if (undoPushedForCall) {
        undoStack.pop();
        undoPushedForCall = false;
    }
    lastUndoable = { method: null, arg0: null };
}

/** Overwrite the coalescing key (rarely needed outside the dispatch). */
export function markLastUndoable(method, arg0) {
    lastUndoable = { method, arg0 };
}

/** Drop all history (fresh session / scenario load / session load). */
export function clearUndoHistory() {
    undoStack = [];
    redoStack = [];
    lastUndoable = { method: null, arg0: null };
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function mockUndo() {
    if (!undoStack.length) return false;
    lastUndoable = { method: null, arg0: null };  // break coalescing
    redoStack.push(serializeGraph());
    restoreGraph(undoStack.pop());
    return true;
}

export function mockRedo() {
    if (!redoStack.length) return false;
    undoStack.push(serializeGraph());
    restoreGraph(redoStack.pop());
    return true;
}
