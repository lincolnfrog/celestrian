/**
 * Mock Backend for Celestrian UI Testing
 *
 * Simulates the JUCE native bridge without requiring the C++ backend.
 * Maintains audio node state in memory and provides realistic responses.
 *
 * Contract: this backend must implement exactly the methods declared in
 * `ui/js/protocol.js` (the canonical bridge protocol, also implemented by
 * src/main_component.cc). Enforced by ui/js/tests/protocol_contract.test.mjs.
 *
 * Timing math (quantum snap, launch points, LCM) comes from
 * `ui/js/timeline_model.js` — the mock holds state and protocol, not math —
 * so its behavior cannot drift from the UI or the C++ engine.
 *
 * This file is the FACADE: it owns the protocol handler table and the
 * callNative dispatch (with its undo interception), and re-exports the
 * public test surface. The implementation lives in js/mock/:
 *   rate.js       — the mock's sample rate (one systemic variable)
 *   state.js      — the state singleton + pure graph queries
 *   undo.js       — undo/redo stacks behind accessors
 *   cycles.js     — committed/effective island cycle math
 *   graph_crud.js — structural edits, toggles, per-node knobs
 *   maps.js       — loop windows, multi-segment maps, bypass
 *   recording.js  — arm/stop/commit lifecycle + recView + newTake
 *   takes.js      — the take list, the comp, per-take peaks
 *   transport.js  — the simulated clock + published masterPos view
 *   publish.js    — getState/enrichNodes/VU + test clock hooks
 *   waveform.js   — deterministic peak synthesis
 *   devices.js    — audio device / input / latency-calibration mocks
 *   effects.js    — effect rack defaults and setters
 *   projects.js   — project model + in-memory session save/load
 *   scenarios.js  — test scenario loaders (boots 'empty', Q17 parity)
 */

import { interceptUndoableCall, mockUndo, mockRedo } from './mock/undo.js';
import {
    createNode, deleteNode, renameNode, reorderNode,
    combineNodes, toggleSolo, toggleMute,
    setNodeInput, setNodeInputRight, setNodePan, setNodeGain,
    setPeriodSource, setMonitor,
} from './mock/graph_crud.js';
import {
    saveTrackTemplate, listTrackTemplates, createFromTrackTemplate,
} from './mock/track_templates.js';
import { setLoopPoints, setSegments, toggleLoopWindow } from './mock/maps.js';
import { someNode, state } from './mock/state.js';
import { setSequence, toggleSequence, auditionStep } from './mock/sequence.js';
import { startRecordingInNode, stopRecordingInNode, newTake } from './mock/recording.js';
import { selectTake, deleteTake, setComp, getTakeWaveform } from './mock/takes.js';
import { togglePlayback, seekTransport } from './mock/transport.js';
import { getState } from './mock/publish.js';
import { getWaveform } from './mock/waveform.js';
import {
    getAudioDeviceState, setAudioDevice, getInputList,
    startLatencyCalibration, getLatencyCalibration,
} from './mock/devices.js';
import {
    setSlotEnabled, setSlotParam, moveChainSlot, setEffectScope,
    addPluginToChain, removeChainSlot, openPluginEditor,
    setMidiArmed, getMidiInputs,
} from './mock/effects.js';
import {
    getKnownPlugins, scanPlugins, getPluginScanStatus,
} from './mock/plugins.js';
import {
    saveSession, loadSession, getProjectInfo, renameProject, saveProjectNow,
    listTemplates, listRecentProjects, newProjectFromTemplate,
    openProjectPath, saveAsTemplate, duplicateProject,
    setProjectsRoot, chooseProjectsRoot,
} from './mock/projects.js';
import { bounce, bounceWithDialog } from './mock/bounce.js';
import { importAudio, importAudioWithDialog } from './mock/import.js';
import { getMidiNotes } from './mock/midi.js';
import './mock/scenarios.js';  // module load runs the launch-ritual boot

// The public test surface (index_test.html, backend.js, and the node
// tests import exactly these — keep this list stable).
export { getState, setMasterPos, setIsPlaying } from './mock/publish.js';
export { startTransport, pauseTransport, advanceBy,
         SIMULATED_SAMPLES_PER_SECOND } from './mock/transport.js';
export { loadScenario } from './mock/scenarios.js';
// The last accepted bounce request (Q19) — what the e2e reads after
// the project menu's "Bounce song…".
export { getLastBounce } from './mock/bounce.js';
// The last accepted import request (docs/import.md) — what the e2e
// reads after a menu import or a lane drop.
export { getLastImport } from './mock/import.js';
// The mock's sample rate — every rate-dependent value derives from it.
// Set it BEFORE loadScenario (fixture lengths are read at load time);
// ?rate= / CELESTRIAN_MOCK_RATE do this early enough automatically.
export { getSampleRate, setSampleRate, quantumSamples } from './mock/rate.js';

/**
 * Handler table for every protocol method. Keys must match
 * protocol.js BRIDGE_METHOD_NAMES exactly (see protocol_contract.test.mjs).
 */
export const handlers = {
    getProjectInfo,
    renameProject,
    saveProjectNow,
    listTemplates,
    listRecentProjects,
    newProjectFromTemplate,
    openProjectPath,
    saveAsTemplate,
    duplicateProject,
    ping: () => 'pong',
    togglePlayback,
    // Ruler scrub — transport phase, engine parity; NOT undoable
    // (a monitoring gesture, like auditionStep).
    seekTransport,
    startRecordingInNode,
    stopRecordingInNode,
    getGraphState: getState,
    getWaveform,
    // Takes and comping (docs/takes.md): newTake arms like record (its
    // commit rides the take's pending snapshot); the rest are undoable.
    newTake,
    selectTake,
    deleteTake,
    setComp,
    getTakeWaveform,
    createNode,
    deleteNode,
    undo: mockUndo,
    redo: mockRedo,
    saveSession,
    loadSession,
    // Bounce (Q19): records the request; refuses under a live take.
    bounce,
    bounceWithDialog,
    // Audio file import (docs/import.md): synthesizes the take,
    // records the request; UNDOABLE (the dispatch snapshot).
    importAudio,
    importAudioWithDialog,
    // MIDI lane rendering (docs/vst3.md §11): paired notes on demand.
    getMidiNotes,
    // Preferences: the base folder (projects root + template library).
    setProjectsRoot,
    chooseProjectsRoot,
    renameNode,
    reorderNode,
    combineNodes,
    getInputList,
    setNodeInput,
    setNodeInputRight,
    // Software input monitoring (Q20): a monitoring gesture — NOT
    // undoable (absent from UNDOABLE, like solo and the mixer knobs).
    setMonitor,
    setNodePan,
    setNodeGain,
    setPeriodSource,
    getAudioDeviceState,
    setAudioDevice,
    setSlotEnabled,
    setSlotParam,
    moveChainSlot,
    addPluginToChain,
    removeChainSlot,
    openPluginEditor,
    setMidiArmed,
    getMidiInputs,
    setEffectScope,
    startLatencyCalibration,
    getLatencyCalibration,
    // Plugin hosting (docs/vst3.md phase 1): registry + simulated scan.
    getKnownPlugins,
    scanPlugins,
    getPluginScanStatus,
    setLoopPoints,
    setSegments,
    // The mock cannot move the OS cursor — returning false makes the
    // expanded drag fall back to its eased-capture path.
    warpPointer: () => false,
    toggleLoopWindow,
    // The SEQUENCER (docs/sequencer.md) — engine parity, undoable.
    setSequence,
    toggleSequence,
    // The step audition (§11.2): a monitoring gesture — NOT undoable.
    auditionStep,
    // Track templates (Q17): createFrom is UNDOABLE as one step (see
    // mock/undo.js); save writes the LIBRARY, not the graph. There is
    // no per-node togglePlay (Q16).
    listTrackTemplates,
    saveTrackTemplate,
    createFromTrackTemplate,
    toggleSolo,
    toggleMute,
    nativeLog: (msg) => { console.log('[JS]', msg); return true; },
    dumpStateToFile: (json) => { console.log('[MockBackend] dumpStateToFile (no-op in mock)'); return true; }
};

// Polyfill for callNative - simulates the native C++ bridge
/**
 * Dispatch a protocol method to its handler, mirroring the JUCE bridge.
 *
 * Undo interception (single point, mirrors AudioEngine::record): before
 * an UNDOABLE method's handler runs, a pre-edit snapshot is pushed —
 * except when a streamed setSegments on the same node COALESCES into
 * the previous one (live splice-preview drags = one undo step). A
 * handler that REFUSES calls popUndoForRefusal, so a refused edit
 * records nothing (see mock/undo.js).
 *
 * Unknown methods warn and resolve to null.
 */
// The POLLS are exempt from the invocation trace (C++ bridge parity —
// logBridgeCall): the 50ms graph poll and the 2s project poll are the
// heartbeat, not events; tracing them buries every real call.
// Event-shaped methods all trace.
const QUIET_POLLS = new Set(['getGraphState', 'getProjectInfo']);

// THE LIVE-TAKE GATE (engine parity AudioEngine::refusedUnderLiveTake,
// owner ruling 2026-09-09): while any take is armed or capturing, every
// verb that changes what sounds when is refused — structure, geometry,
// sequences, takes, period source, undo/redo, pause, a second arm.
// Mixer/wiring knobs (mute, rename, input, fx slots, solo, gain, pan,
// monitor) and creating an empty node stay live.
const REFUSED_UNDER_LIVE_TAKE = new Set([
    'deleteNode', 'reorderNode', 'combineNodes', 'setLoopPoints',
    'toggleLoopWindow', 'setSegments', 'setPeriodSource',
    'createFromTrackTemplate', 'setSequence', 'toggleSequence',
    'auditionStep', 'selectTake', 'deleteTake', 'setComp', 'importAudio',
    'undo', 'redo', 'togglePlayback', 'seekTransport',
    'startRecordingInNode', 'newTake',
]);
const takeIsLive = () => someNode(n => n.isRecording || n.isPendingStart);

export async function callNative(method, ...args) {
    if (!QUIET_POLLS.has(method)) {
        console.log(`[MockBackend] callNative: ${method}`, args);
    }

    const handler = handlers[method];
    if (!handler) {
        console.warn(`[MockBackend] Unknown method: ${method}`);
        return null;
    }
    // (Stopping is the verb for a live take — never gated; and a
    // togglePlayback while PAUSED is a resume, which the engine allows:
    // only a PAUSE under a take is refused.)
    const isResume = method === 'togglePlayback' && !state.isPlaying;
    if (REFUSED_UNDER_LIVE_TAKE.has(method) && !isResume && takeIsLive()) {
        console.log(`[MockBackend] ${method} refused - a take is armed or capturing`);
        // Refusals answer like the engine's boolean verbs (seek, undo,
        // redo, import: false); combine answers no uuid.
        return method === 'combineNodes' ? null : false;
    }
    // Snapshot BEFORE any undoable mutation so undo restores the pre-edit
    // graph (see interceptUndoableCall for the coalescing rules).
    interceptUndoableCall(method, args[0]);
    return handler(...args);
}

// Polyfill for log - just console.log in browser
export function log(...args) {
    console.log('[App]', ...args);
}
