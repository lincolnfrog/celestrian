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
    // Ruler scrub (owner ruling 2026-08-27): seek to a position in the
    // SAME domain the published masterPos wraps in — epoch-relative
    // samples, folded on the audible cycle. NOT undoable (a monitoring
    // gesture, like auditionStep). Refused while any take is live or
    // armed (returns false): takes place audio by the clock.
    { name: 'seekTransport', params: ['posSamples'], returns: 'true when applied; false refused (take live/armed)' },

    // Recording
    { name: 'startRecordingInNode', params: ['uuid'] },
    { name: 'stopRecordingInNode', params: ['uuid'] },

    // State
    { name: 'getGraphState', params: [], returns: 'GraphState (focused node metadata tree + isPlaying/masterPos/masterVuL/masterVuR; per-node isSoloed since Q16)' },
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

    // Track templates (design_language.md Q17 — the Q7 companion):
    // SUBTREE templates — a track or group's structure + names + input
    // assignments, saved once from the selection and replayed from the
    // creation menu. A GLOBAL user-level library, distinct from the
    // whole-session templates above. Insert is ONE undoable edit.
    { name: 'listTrackTemplates', params: [], returns: 'JSON [{name, kind: "clip"|"group", tracks}]' },
    { name: 'saveTrackTemplate', params: ['uuid', 'name'], returns: 'true on success' },
    { name: 'createFromTrackTemplate', params: ['name', 'parentUuid?'], returns: 'true on success' },

    // Per-node audio state. (togglePlay was deleted with Q16: per-node
    // Play/Stop is superseded — mute/solo + the one transport are the
    // per-node play controls. Solo is per-node, additive, fractal.)
    { name: 'toggleSolo', params: ['uuid'] },
    { name: 'toggleMute', params: ['uuid'] },
    { name: 'setLoopPoints', params: ['uuid', 'startSamples', 'endSamples'] },
    { name: 'setSegments', params: ['uuid', 'flatSegments'] },
    { name: 'warpPointer', params: ['x', 'y', 'viewportW', 'viewportH'] },
    // Loop window activation is data, not view state (docs/time_maps.md):
    // toggles a stack's window between active and bypassed.
    { name: 'toggleLoopWindow', params: ['uuid'] },
    // The SEQUENCER (docs/sequencer.md): install/replace/clear a stack's
    // sequence — { steps: [{name, len}], gates: {uuid: [0/1 per step]} },
    // lengths in samples; null/void clears. Undoable; refused mid-take.
    { name: 'setSequence', params: ['uuid', 'sequence'] },
    // The sequence's jam toggle (bypass) — the loop-window twin.
    { name: 'toggleSequence', params: ['uuid'] },
    { name: 'auditionStep', params: ['uuid', 'step'] },

    // Hardware
    // getInputList returns only ACTIVE input channels, in callback order —
    // the index handed to setNodeInput IS the audio callback's channel index.
    { name: 'getInputList', params: [], returns: '{ inputs: string[] }' },
    { name: 'setNodeInput', params: ['uuid', 'channelIndex'] },
    // Right input of a stereo pair (−1 = mono). Channel count of a take
    // is fixed at arm; committed takes keep their recorded channels.
    { name: 'setNodeInputRight', params: ['uuid', 'channelIndex'] },

    // Mixer: pan/balance −1 (L) .. +1 (R). Balance law (center unity),
    // applied at render on clips and groups; NOT undoable (mixer knob —
    // the effect-param ruling). State publishes as `pan` per node.
    { name: 'setNodePan', params: ['uuid', 'pan'] },
    // Mixer: volume fader 0 (silent) .. 1 (unity default — attenuate
    // only, the pan no-boost law), applied at the node's output stage
    // after fx; NOT undoable. State publishes as `gain` per node.
    { name: 'setNodeGain', params: ['uuid', 'gain'] },

    // The period-source knob (Q5): 'context' makes the clip a ONE-SHOT
    // (period := context cycle — sounds once per scope cycle at its
    // origin, then rests); 'own' restores the loop. Clips only;
    // UNDOABLE (a musical fact). State publishes as `periodSource`.
    { name: 'setPeriodSource', params: ['uuid', 'source'] },

    // Audio device selection. On Windows a multi-channel interface only
    // appears whole under ASIO — its WDM driver splits the box into stereo
    // endpoints — so picking the driver TYPE matters as much as the device.
    // The choice persists to <app data>/Celestrian/audio_device.xml and is
    // restored at launch. Rate/buffer of 0 mean "the device's preference".
    {
        name: 'getAudioDeviceState', params: [],
        returns: '{ types, currentType, devices, currentDevice, sampleRates, ' +
            'currentSampleRate, bufferSizes, currentBufferSize, inputChannels, ' +
            'outputChannels, availableInputChannels, asioAvailable, error }'
    },
    {
        name: 'setAudioDevice', params: ['type', 'device', 'sampleRate', 'bufferSize'],
        returns: '"" on success, else an error string'
    },

    // The effect chain (src/dsp/fx_chain.h, docs/vst3.md phase 2): a
    // dynamic per-node slot chain (built-ins now; VST3 slots in phase
    // 3). State publishes on every node's metadata as `effects` =
    // {chain: [{slot, type, enabled, ...params}], scope?}; edits are
    // keyed by the stable slot uuid. moveChainSlot is UNDOABLE (chain
    // structure); enable/params are knobs (not undoable, like pan).
    { name: 'setSlotEnabled', params: ['uuid', 'slotUuid', 'enabled'] },
    { name: 'setSlotParam', params: ['uuid', 'slotUuid', 'key', 'value'] },
    { name: 'moveChainSlot', params: ['uuid', 'slotUuid', 'newIndex'] },
    // VST3 slots (docs/vst3.md phase 3): add is ASYNC on the backend
    // (instantiation completes later; the chip appears when the chain
    // publishes) and lands enabled; add/remove are UNDOABLE structure
    // edits; removal is VST3-only (built-ins are the fixed cards).
    // openPluginEditor raises the plugin's native floating window.
    { name: 'addPluginToChain', params: ['uuid', 'pluginUid', 'index?'] },
    { name: 'removeChainSlot', params: ['uuid', 'slotUuid'] },
    { name: 'openPluginEditor', params: ['uuid', 'slotUuid'] },
    // Live MIDI (docs/vst3.md §8, phase 4): single-armed play-through
    // target (arming a node clears every other); a monitoring gesture
    // like solo — not undoable, not persisted. getMidiInputs is the
    // diagnostics readout for the plugins panel.
    { name: 'setMidiArmed', params: ['uuid', 'on'] },
    { name: 'getMidiInputs', params: [], returns: '{ devices: [name], dropped }' },
    // Panel open/closed: gates the node's scope capture + telemetry —
    // when no panel watches, the audio thread doesn't even copy.
    { name: 'setEffectScope', params: ['uuid', 'active'] },

    // Latency calibration (docs/performance.md §7): emits a click while
    // capturing input; the measured round-trip supersedes device-reported
    // latencies in recording alignment.
    { name: 'startLatencyCalibration', params: [], returns: 'true' },
    { name: 'getLatencyCalibration', params: [], returns: '{ phase, roundTripSamples, roundTripMs, calibrated }' },

    // Plugin hosting (docs/vst3.md phase 1): the known-plugin registry.
    // Scanning runs on a backend background thread with the
    // dead-man's-pedal crash blacklist; the UI polls status while the
    // plugin panel is open (poll-shaped, like the device panel).
    { name: 'getKnownPlugins', params: [], returns: '[{name, uid, file, maker, category, version, isInstrument}] name-sorted' },
    { name: 'scanPlugins', params: ['extraPath?'] },
    { name: 'getPluginScanStatus', params: [], returns: '{ scanning, progress, current, count, blacklistCount, crashed: [file names excluded this scan], crashedCount, error, outOfProcess }' },

    // Debug
    { name: 'nativeLog', params: ['message'] },
];

export const BRIDGE_METHOD_NAMES = BRIDGE_METHODS.map(m => m.name);
