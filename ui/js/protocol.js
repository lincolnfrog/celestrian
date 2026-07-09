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
    { name: 'renameNode', params: ['uuid', 'name'] },
    { name: 'reorderNode', params: ['uuid', 'newParentUuid', 'newIndex'] },
    { name: 'setNodePosition', params: ['uuid', 'x', 'y'] },
    { name: 'combineNodes', params: ['draggedUuid', 'targetUuid'], returns: 'new stack uuid' },
    { name: 'toggleStackExpand', params: ['uuid'] },

    // Per-node audio state
    { name: 'togglePlay', params: ['uuid'] },
    { name: 'toggleSolo', params: ['uuid'] },
    { name: 'toggleMute', params: ['uuid'] },
    { name: 'setLoopPoints', params: ['uuid', 'startSamples', 'endSamples'] },
    // Loop window activation is data, not view state (docs/time_maps.md):
    // toggles a stack's window between active and bypassed.
    { name: 'toggleLoopWindow', params: ['uuid'] },

    // Hardware
    { name: 'getInputList', params: [], returns: '{ inputs: string[] }' },
    { name: 'setNodeInput', params: ['uuid', 'channelIndex'] },

    // Latency calibration (docs/performance.md §7): emits a click while
    // capturing input; the measured round-trip supersedes device-reported
    // latencies in recording alignment.
    { name: 'startLatencyCalibration', params: [], returns: 'true' },
    { name: 'getLatencyCalibration', params: [], returns: '{ phase, roundTripSamples, roundTripMs, calibrated }' },

    // Debug
    { name: 'nativeLog', params: ['message'] },
];

export const BRIDGE_METHOD_NAMES = BRIDGE_METHODS.map(m => m.name);
