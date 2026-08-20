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
 *   recording.js  — arm/stop/commit lifecycle + recView
 *   transport.js  — the simulated clock + published masterPos view
 *   publish.js    — getState/enrichNodes/VU + test clock hooks
 *   waveform.js   — deterministic peak synthesis
 *   devices.js    — audio device / input / latency-calibration mocks
 *   effects.js    — effect rack defaults and setters
 *   projects.js   — project model + in-memory session save/load
 *   scenarios.js  — test scenario loaders + the launch-ritual boot
 */

import { interceptUndoableCall, mockUndo, mockRedo } from './mock/undo.js';
import {
    createNode, deleteNode, renameNode, reorderNode, setNodePosition,
    combineNodes, toggleSolo, toggleMute, toggleStackExpand,
    setNodeInput, setNodeInputRight, setNodePan, setNodeGain,
    setPeriodSource,
} from './mock/graph_crud.js';
import {
    saveTrackTemplate, listTrackTemplates, createFromTrackTemplate,
} from './mock/track_templates.js';
import { setLoopPoints, setSegments, toggleLoopWindow } from './mock/maps.js';
import { setSequence, toggleSequence } from './mock/sequence.js';
import { startRecordingInNode, stopRecordingInNode } from './mock/recording.js';
import { togglePlayback } from './mock/transport.js';
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
} from './mock/projects.js';
import './mock/scenarios.js';  // module load runs the launch-ritual boot

// The public test surface (index_test.html, backend.js, and the node
// tests import exactly these — keep this list stable).
export { getState, setMasterPos, setIsPlaying } from './mock/publish.js';
export { startTransport, pauseTransport, advanceBy,
         SIMULATED_SAMPLES_PER_SECOND } from './mock/transport.js';
export { loadScenario } from './mock/scenarios.js';
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
    startRecordingInNode,
    stopRecordingInNode,
    getGraphState: getState,
    getWaveform,
    toggleStackExpand,
    createNode,
    deleteNode,
    undo: mockUndo,
    redo: mockRedo,
    saveSession,
    loadSession,
    renameNode,
    reorderNode,
    setNodePosition,
    combineNodes,
    getInputList,
    setNodeInput,
    setNodeInputRight,
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
    // Track templates (Q17): createFrom is UNDOABLE as one step (see
    // mock/undo.js); save writes the LIBRARY, not the graph. togglePlay
    // is GONE (Q16: per-node play superseded).
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
// The POLLS are exempt from the invocation trace (owner report
// 2026-08-13, C++ bridge parity — logBridgeCall): the 50ms graph poll
// and the 2s project poll are the heartbeat, not events; tracing them
// buries every real call. Event-shaped methods all still trace.
const QUIET_POLLS = new Set(['getGraphState', 'getProjectInfo']);

export async function callNative(method, ...args) {
    if (!QUIET_POLLS.has(method)) {
        console.log(`[MockBackend] callNative: ${method}`, args);
    }

    const handler = handlers[method];
    if (!handler) {
        console.warn(`[MockBackend] Unknown method: ${method}`);
        return null;
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
