/**
 * The mock backend: the engine's bridge, in memory, for developing and
 * testing the UI without the C++ app. It implements exactly the methods
 * of `ui/js/protocol.js` (pinned by tests/protocol_contract.test.mjs),
 * and what it publishes is held to the real engine's by the differential
 * suite (ui/differential/). Timing math is imported from the shared
 * mirrors (timeline_model.js, time_map.js, period_law.js, qtime.js) —
 * the mock adapts its node shape to them and restates none of it.
 *
 * This file is the facade: the handler table, the dispatch, and the
 * public test surface. The implementation is js/mock/:
 *   state.js        the state, the raw node, the graph queries, the definer
 *   seq_query.js    reads of a stored sequence
 *   cycles.js       the period law over the mock node
 *   heard.js        which inner position sounds when (heard_index.h's twin)
 *   undo.js         the undo / redo logs
 *   graph_crud.js   create, delete, move, combine; switches and knobs
 *   maps.js         windows, cell maps, bypass, the re-time
 *   definer.js      the Q hand-off and the lock-collapse
 *   sequence.js     the sequencer's verbs
 *   recording.js    arm, stop, commit, settle
 *   takes.js        the take list and the comp
 *   import.js       audio file import
 *   bounce.js       the bounce verbs
 *   transport.js    the simulated clock, the seek, the published cursor
 *   publish.js      getState
 *   effects.js      the effect chain
 *   plugins.js      the plugin registry and its scan
 *   devices.js      audio devices, inputs, latency calibration
 *   midi.js         the MIDI note readout
 *   waveform.js     deterministic peaks
 *   projects.js     the project model, session save / load
 *   track_templates.js  the track-template library
 *   scenarios.js    the test scenarios (boots 'empty')
 *   rate.js         the mock's sample rate
 */

import {
    beginCall, endCall, isUndoable, noteGestureCommit, mockUndo, mockRedo,
    mockCancelGesture,
} from './mock/undo.js';
import { QUIET_POLLS, BOOL_METHODS, VOID_METHODS } from './protocol.js';
import {
    createNode, deleteNode, renameNode, reorderNode, combineNodes, toggleSolo,
    toggleMute, setNodeInput, setNodeInputRight, setNodePan, setNodeGain,
    setPeriodSource, setMonitor,
} from './mock/graph_crud.js';
import {
    saveTrackTemplate, listTrackTemplates, createFromTrackTemplate,
} from './mock/track_templates.js';
import { setLoopPoints, setSegments, setTiming, toggleLoopWindow } from './mock/maps.js';
import { setDefiner } from './mock/definer.js';
import { takeLive, state } from './mock/state.js';
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
import { getKnownPlugins, scanPlugins, getPluginScanStatus } from './mock/plugins.js';
import {
    saveSession, loadSession, getProjectInfo, renameProject, saveProjectNow,
    listTemplates, listRecentProjects, newProjectFromTemplate,
    openProjectPath, saveAsTemplate, duplicateProject,
    setProjectsRoot, chooseProjectsRoot,
} from './mock/projects.js';
import { bounce, bounceWithDialog } from './mock/bounce.js';
import { importAudio, importAudioWithDialog } from './mock/import.js';
import { getMidiNotes } from './mock/midi.js';
import './mock/scenarios.js';  // loading it boots the empty session

// The public test surface (index_test.html, backend.js and the node
// tests import exactly these).
export { getState, readState, setMasterPos, setIsPlaying } from './mock/publish.js';
export { startTransport, pauseTransport, advanceBy, stepClock,
         SIMULATED_SAMPLES_PER_SECOND } from './mock/transport.js';
export { loadScenario } from './mock/scenarios.js';
export { getLastBounce } from './mock/bounce.js';
export { getLastImport } from './mock/import.js';
// Set the rate BEFORE loadScenario: fixture lengths are read at load.
export { getSampleRate, setSampleRate, quantumSamples } from './mock/rate.js';

/** One handler per protocol method (protocol.js BRIDGE_METHOD_NAMES). */
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
    seekTransport,
    startRecordingInNode,
    stopRecordingInNode,
    getGraphState: getState,
    getWaveform,
    newTake,
    selectTake,
    deleteTake,
    setComp,
    getTakeWaveform,
    createNode,
    deleteNode,
    undo: mockUndo,
    redo: mockRedo,
    cancelGesture: mockCancelGesture,
    saveSession,
    loadSession,
    bounce,
    bounceWithDialog,
    importAudio,
    importAudioWithDialog,
    getMidiNotes,
    setProjectsRoot,
    chooseProjectsRoot,
    renameNode,
    reorderNode,
    combineNodes,
    getInputList,
    setNodeInput,
    setNodeInputRight,
    setMonitor,
    setNodePan,
    setNodeGain,
    setPeriodSource,
    setDefiner,
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
    getKnownPlugins,
    scanPlugins,
    getPluginScanStatus,
    setLoopPoints,
    setSegments,
    setTiming,
    // The mock cannot move the OS cursor: false sends an expanded drag
    // down its eased-capture path.
    warpPointer: () => false,
    toggleLoopWindow,
    setSequence,
    toggleSequence,
    auditionStep,
    listTrackTemplates,
    saveTrackTemplate,
    createFromTrackTemplate,
    toggleSolo,
    toggleMute,
    nativeLog: (msg) => { console.log('[JS]', msg); return true; },
    dumpStateToFile: () => true,
};

/** THE LIVE-TAKE GATE (engine AudioEngine::refusedUnderLiveTake): while
 * a take is armed or capturing, every verb that changes what sounds when
 * is refused. Knobs, wiring, the fx chain and creating an empty node
 * stay live; stopping is never gated, and a cancelled drag judges the
 * take itself (mock/undo.js mockCancelGesture). */
const REFUSED_UNDER_LIVE_TAKE = new Set([
    'deleteNode', 'reorderNode', 'combineNodes', 'setLoopPoints',
    'toggleLoopWindow', 'setSegments', 'setTiming', 'setPeriodSource',
    'setDefiner', 'setSequence', 'toggleSequence',
    'auditionStep', 'selectTake', 'deleteTake', 'setComp', 'importAudio',
    'undo', 'redo', 'togglePlayback', 'seekTransport',
    'startRecordingInNode', 'newTake',
]);

/**
 * Dispatch a protocol method to its handler. An undoable verb is
 * bracketed by the undo log (mock/undo.js beginCall / endCall): a
 * snapshot before, dropped again when the handler left the graph as it
 * found it — so a refusal, in any handler, records nothing. Unknown
 * methods warn and answer null. The polls are not traced.
 *
 * THE ANSWER (protocol.js `returns`), as the bridge gives it:
 *   - an UNDOABLE verb that answers whether it applied answers whether
 *     it changed the graph — a refusal and an edit that changes nothing
 *     are both `false`, whatever the handler returned;
 *   - a verb nothing can refuse answers `true` once it ran;
 *   - every other verb answers what its handler returns.
 */
export async function callNative(method, ...args) {
    if (!QUIET_POLLS.has(method)) console.log(`[MockBackend] callNative: ${method}`, args);
    const handler = handlers[method];
    if (!handler) {
        console.warn(`[MockBackend] Unknown method: ${method}`);
        return null;
    }
    // A togglePlayback while paused is a resume, which a take allows.
    const resume = method === 'togglePlayback' && !state.isPlaying;
    if (REFUSED_UNDER_LIVE_TAKE.has(method) && !resume && takeLive()) {
        console.log(`[MockBackend] ${method} refused - a take is armed or capturing`);
        // A refused map or re-time commit still arrives: it opens its gesture.
        noteGestureCommit(method, args);
        return method === 'combineNodes' ? '' : false;
    }
    beginCall(method, args);
    const answer = handler(...args);
    const changed = endCall();
    if (VOID_METHODS.has(method)) return true;
    if (BOOL_METHODS.has(method) && isUndoable(method)) return changed;
    return answer;
}

export function log(...args) {
    console.log('[App]', ...args);
}
