/**
 * Canonical bridge protocol between the Celestrian UI and its backends.
 *
 * This file is the single source of truth for which methods exist on the
 * native bridge. Two implementations must match it exactly:
 *
 *   1. The C++ JUCE bridge  — src/main_component.cc (withNativeFunction bindings)
 *   2. The mock backend     — ui/js/mock_backend.js (handlers table)
 *
 * The contract test (ui/js/tests/protocol_contract.test.mjs) parses both and
 * fails if either implementation is missing a method or has an extra one.
 * If you add a bridge method: add it HERE first, then to both backends.
 *
 * `params` and `returns` are documentation (not runtime-enforced yet); all
 * sample-domain values are int64 samples, positions are CSS pixels.
 */
export const BRIDGE_METHODS = [
    { name: 'ping', params: [], returns: "'pong'" },

    // Transport
    { name: 'togglePlayback', params: [] },

    // Recording
    { name: 'startRecordingInNode', params: ['uuid'] },
    { name: 'stopRecordingInNode', params: ['uuid'] },

    // State
    { name: 'getGraphState', params: [], returns: 'GraphState (focused node metadata tree + isPlaying/masterPos/soloedId)' },
    { name: 'getWaveform', params: ['uuid', 'numPeaks'], returns: 'float[] peaks' },
    { name: 'dumpStateToFile', params: ['json'] },

    // Graph structure
    { name: 'createNode', params: ['type', 'parentUuid?'] },
    { name: 'deleteNode', params: ['uuid'] },
    { name: 'renameNode', params: ['uuid', 'name'] },
    { name: 'reorderNode', params: ['uuid', 'newParentUuid', 'newIndex'] },
    { name: 'setNodePosition', params: ['uuid', 'x', 'y'] },
    { name: 'combineNodes', params: ['draggedUuid', 'targetUuid'], returns: 'new stack uuid' },
    { name: 'toggleStackExpand', params: ['uuid'] },

    // Undo / redo (edits-as-events, unification_audit.md §2.2 Step 1).
    // Every structural + property mutation is reversible; canUndo/canRedo
    // publish on getGraphState. Effect enable/param edits are excluded
    // this pass (non-destructive; a documented follow-up).
    { name: 'undo', params: [] },
    { name: 'redo', params: [] },

    // Save / Load (edits-as-events Step 2). A session is a bundle dir
    // (session.json + audio/*.wav), device-independent + QTime-based
    // (src/session_io.h). An empty path opens a native file chooser.
    { name: 'saveSession', params: ['path?'], returns: 'true on success' },
    { name: 'loadSession', params: ['path?'], returns: 'true on success' },

    // The project model (docs/projects.md): a project is a FOLDER named
    // YYYYMMDD-NN (the ID — renames never move it), BORN at the first
    // committed take, continuously MIRRORED after. A template is a
    // project with no performances (pre-Q by construction).
    { name: 'getProjectInfo', params: [], returns: 'JSON {id, name, born}' },
    { name: 'renameProject', params: ['name'] },
    { name: 'saveProjectNow', params: [], returns: 'true on success' },
    { name: 'listTemplates', params: [], returns: 'JSON [{id, name, path}]' },
    { name: 'listRecentProjects', params: [], returns: 'JSON [{id, name, path}]' },
    { name: 'newProjectFromTemplate', params: ['name'], returns: 'true on success' },
    { name: 'openProjectPath', params: ['path'], returns: 'true on success' },
    { name: 'saveAsTemplate', params: ['name'], returns: 'true on success' },
    { name: 'duplicateProject', params: [], returns: 'new project id or ""' },

    // Per-node audio state
    { name: 'togglePlay', params: ['uuid'] },
    { name: 'toggleSolo', params: ['uuid'] },
    { name: 'toggleMute', params: ['uuid'] },
    { name: 'setLoopPoints', params: ['uuid', 'startSamples', 'endSamples'] },
    { name: 'setSegments', params: ['uuid', 'flatSegments'] },
    { name: 'warpPointer', params: ['x', 'y'] },
    // Loop window activation is data, not view state (docs/time_maps.md):
    // toggles a stack's window between active and bypassed.
    { name: 'toggleLoopWindow', params: ['uuid'] },

    // Hardware
    { name: 'getInputList', params: [], returns: '{ inputs: string[] }' },
    { name: 'setNodeInput', params: ['uuid', 'channelIndex'] },

    // Built-in effects (src/dsp/effects.h): a FIXED per-node rack in
    // canonical order eq → compressor → echo → reverb. State publishes
    // on every node's metadata as `effects`; these two methods are the
    // whole edit surface (VST3 later replaces the rack's internals,
    // not this bridge shape).
    { name: 'setEffectEnabled', params: ['uuid', 'fx', 'enabled'] },
    { name: 'setEffectParam', params: ['uuid', 'fx', 'param', 'value'] },
    // Panel open/closed: gates the node's scope capture + telemetry —
    // when no panel watches, the audio thread doesn't even copy.
    { name: 'setEffectScope', params: ['uuid', 'active'] },

    // Latency calibration (docs/performance.md §7): emits a click while
    // capturing input; the measured round-trip supersedes device-reported
    // latencies in recording alignment.
    { name: 'startLatencyCalibration', params: [], returns: 'true' },
    { name: 'getLatencyCalibration', params: [], returns: '{ phase, roundTripSamples, roundTripMs, calibrated }' },

    // Debug
    { name: 'nativeLog', params: ['message'] },
];

export const BRIDGE_METHOD_NAMES = BRIDGE_METHODS.map(m => m.name);
