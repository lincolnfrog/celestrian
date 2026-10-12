/**
 * The bridge protocol: every method the UI may call on a backend. Two
 * implementations must match this list exactly —
 *   - the C++ bridge: the table in src/bridge_dispatch.cc (boolMethod /
 *     valueMethod / voidMethod), plus the verbs that need the window
 *     (bindWindowVerb, src/main_component.cc);
 *   - the mock: the `handlers` table in ui/js/mock_backend.js —
 * and ui/js/tests/protocol_contract.test.mjs fails when either lacks a
 * method, has an extra one, or answers another kind. To add a method:
 * add it HERE first, then to both.
 *
 * `params` is documentation. `returns` is THE ANSWER'S KIND, and each
 * registration is held to it:
 *   'bool — …'   a verb that can be REFUSED answers whether it applied:
 *                `true` it did what the text says; `false` it was
 *                refused and nothing changed. An edit that would change
 *                nothing is not applied. The status line reads this
 *                answer (shell_io.js `call`).
 *   other text   the value the page reads.
 *   absent       a knob or a notification nothing can refuse: answered
 *                `true` once it ran.
 * A call the bridge lost answers `null` whatever its kind. `read` marks
 * a query that changes nothing: the only calls a transport may send
 * twice (bridge_http.js).
 *
 * Sample-domain values are int64 samples. No verb carries view state:
 * fold and lane placement are UI-local (view_prefs.js). What a verb
 * does, and when the engine refuses it, is in the doc its group names.
 */
export const BRIDGE_METHODS = [
    { name: 'ping', params: [], returns: "'pong'", read: true },

    // Transport. A pause is refused under a live take. seekTransport
    // takes a phase ADVANCE, not a position (seek.js); refused under a
    // live take; not undoable.
    { name: 'togglePlayback', params: [], returns: 'bool — the transport toggled' },
    { name: 'seekTransport', params: ['deltaSamples', 'atClock?'], returns: '{advance, clock} — what was applied and when; false refused (take live/armed)' },

    // Recording (docs/recording.md). One take at a time: an arm under a
    // live take is refused. A stop answers false when nothing beneath
    // `uuid` was armed or capturing.
    { name: 'startRecordingInNode', params: ['uuid'], returns: 'bool — a take is armed' },
    { name: 'stopRecordingInNode', params: ['uuid'], returns: 'bool — a live take was asked to stop' },

    // State
    { name: 'getGraphState', params: [], read: true, returns: "GraphState (the root's metadata tree + isPlaying/masterPos/masterVuL/masterVuR; per-node isSoloed, Q16)" },
    { name: 'getWaveform', params: ['uuid', 'numPeaks'], read: true, returns: 'float[] peaks (the ACTIVE take)' },

    // Takes and comping (docs/takes.md). newTake arms one more take of
    // a committed clip (or of a stack's committed direct clips) at the
    // slot's next top. Select, delete and comp are undoable and refused
    // mid-take. setComp's cells: one take index per Q cell of the
    // period (−1 = the active take); [] clears.
    { name: 'newTake', params: ['uuid'], returns: 'bool — a new take is armed' },
    { name: 'selectTake', params: ['uuid', 'index'], returns: 'bool — that take is now the active one' },
    { name: 'deleteTake', params: ['uuid', 'index'], returns: 'bool — the take was removed' },
    { name: 'setComp', params: ['uuid', 'cells'], returns: 'bool — the comp changed' },
    { name: 'getTakeWaveform', params: ['uuid', 'index', 'numPeaks'], read: true, returns: 'float[] peaks of take `index`' },
    { name: 'dumpStateToFile', params: ['json'], returns: 'bool — the file was written' },

    // Graph structure. The two verbs that make a node answer its uuid.
    // Delete, move and combine are refused under a live take.
    { name: 'createNode', params: ['type', 'parentUuid?'], returns: 'the new node uuid; "" refused' },
    { name: 'deleteNode', params: ['uuid'], returns: 'bool — the node and its subtree were removed' },
    { name: 'renameNode', params: ['uuid', 'name'], returns: 'bool — the name changed' },
    { name: 'reorderNode', params: ['uuid', 'newParentUuid', 'newIndex'], returns: 'bool — the node moved' },
    { name: 'combineNodes', params: ['draggedUuid', 'targetUuid'], returns: 'the new stack uuid; "" refused' },

    // Undo / redo. cancelGesture ends the drag open on `uuid` with no
    // trace: the node is put back, the gesture's undo step is dropped,
    // and the redo branch it invalidated returns. It answers false when
    // what the drag did stands (no drag open there, or a take is live).
    { name: 'undo', params: [], returns: 'bool — a step was undone' },
    { name: 'redo', params: [], returns: 'bool — a step was redone' },
    { name: 'cancelGesture', params: ['uuid'], returns: 'bool — the node is as the drag found it' },

    // Sessions: a bundle directory (src/session_io.h). An empty path
    // opens the native chooser.
    { name: 'saveSession', params: ['path?'], returns: 'bool — saved' },
    { name: 'loadSession', params: ['path?'], returns: 'bool — loaded' },

    // Bounce (docs/bounce.md): an offline render of a node to a WAV —
    // the root for one cycle, any other node for one period. `start`
    // (absolute samples) names where the render begins; absent, the
    // node's own top. False when refused or cancelled.
    { name: 'bounce', params: ['uuid', 'path', 'start?'], returns: 'bool — the file was rendered' },
    { name: 'bounceWithDialog', params: ['uuid', 'start?'], returns: 'bool — the file was rendered' },

    // Audio file import (docs/import.md): a file becomes a committed
    // take at `originSamples` (absolute; the engine snaps it to the Q
    // grid). Undoable. False when refused or cancelled.
    { name: 'importAudio', params: ['uuid', 'path', 'originSamples'], returns: 'bool — the file became a take' },
    { name: 'importAudioWithDialog', params: ['uuid', 'originSamples'], returns: 'bool — the file became a take' },

    // A MIDI clip's notes, paired (docs/vst3.md §8.5). Empty for an
    // audio clip or while a take is live on it.
    { name: 'getMidiNotes', params: ['uuid'], read: true, returns: '[[posQnum, posQden, note, velocity, lenQnum, lenQden], ...]' },

    // The project model (docs/projects.md): a project is a folder
    // named by its id, born at the first committed take and mirrored
    // after; a template is a project with no performances.
    { name: 'getProjectInfo', params: [], read: true, returns: '{id, name, born, projectsRoot, trackTemplatesRoot}' },
    { name: 'setProjectsRoot', params: ['path'], returns: 'bool — the folder is the projects root' },
    { name: 'chooseProjectsRoot', params: [], returns: 'the chosen path, or ""' },
    { name: 'renameProject', params: ['name'] },
    { name: 'saveProjectNow', params: [], returns: 'bool — the project is on disk' },
    { name: 'listTemplates', params: [], read: true, returns: '[{id, name, path}]' },
    { name: 'listRecentProjects', params: [], read: true, returns: '[{id, name, path}]' },
    { name: 'newProjectFromTemplate', params: ['name'], returns: 'bool — the template is the session' },
    { name: 'openProjectPath', params: ['path'], returns: 'bool — the project is the session' },
    { name: 'saveAsTemplate', params: ['name'], returns: 'bool — the template was saved' },
    { name: 'duplicateProject', params: [], returns: 'new project id or ""' },

    // Track templates (design_language.md Q17): a track or group's
    // structure, names and inputs, in a user-level library. An insert
    // is one undoable edit.
    { name: 'listTrackTemplates', params: [], read: true, returns: '[{name, kind: "clip"|"group", tracks}]' },
    { name: 'saveTrackTemplate', params: ['uuid', 'name'], returns: 'bool — the template was saved' },
    { name: 'createFromTrackTemplate', params: ['name', 'parentUuid?'], returns: 'bool — the tracks were added' },

    // Mute / solo: with the one transport, the per-node play controls.
    // Mute is undoable; solo is a monitoring gesture.
    { name: 'toggleSolo', params: ['uuid'] },
    { name: 'toggleMute', params: ['uuid'], returns: 'bool — the mute flipped' },

    // Loop windows and maps (docs/time_maps.md). `live?` is true for
    // every commit of a drag after its first: it coalesces into that
    // gesture's undo step. Omitted, the commit is a new step.
    { name: 'setLoopPoints', params: ['uuid', 'startSamples', 'endSamples', 'live?'], returns: 'bool — the window changed' },
    { name: 'setSegments', params: ['uuid', 'flatSegments', 'live?'], returns: 'bool — the map changed' },
    // The re-time (docs/loop_selection.md §9): moves a clip's origin by
    // `shiftSamples` and adds the same to its `retime`; a `topSamples`
    // ≥ 0 also stores the loop's top, and must lie in the clip's kept
    // set or the whole call is refused. One undoable step.
    { name: 'setTiming', params: ['uuid', 'shiftSamples', 'topSamples?', 'live?'], returns: 'bool — the timing changed' },
    { name: 'warpPointer', params: ['x', 'y', 'viewportW', 'viewportH'], returns: 'bool — the OS cursor moved' },
    // A window's activation is data: active or bypassed.
    { name: 'toggleLoopWindow', params: ['uuid'], returns: 'bool — the bypass flipped' },

    // The sequencer (docs/sequencer.md). A sequence is { steps: [{name,
    // len}], gates: {uuid: [0/1 per step]} }, lengths in samples; null
    // clears. `zero` (absolute samples) anchors a song on the ROOT at
    // the frame zero the view seated (docs/frame.md §4). The bypass is
    // a fact of the song: there is none to toggle without one.
    { name: 'setSequence', params: ['uuid', 'sequence', 'zero?'], returns: 'bool — the song changed' },
    { name: 'toggleSequence', params: ['uuid'], returns: "bool — the song's bypass flipped" },
    { name: 'auditionStep', params: ['uuid', 'step'], returns: 'bool — the step loops (−1: the loop is released)' },

    // Inputs. getInputList answers only the ACTIVE input channels, in
    // callback order: the index handed to setNodeInput IS the audio
    // callback's channel index. setNodeInputRight −1 is mono.
    { name: 'getInputList', params: [], read: true, returns: '{ inputs: string[] }' },
    { name: 'setNodeInput', params: ['uuid', 'channelIndex'], returns: 'bool — the input changed' },
    { name: 'setNodeInputRight', params: ['uuid', 'channelIndex'], returns: 'bool — the right input changed' },
    // Software input monitoring (design_language.md Q20); clips only.
    { name: 'setMonitor', params: ['uuid', 'on'], returns: 'bool — the clip monitors as asked' },

    // Mixer knobs, not undoable: pan −1 (L) .. +1 (R), gain 0 .. 1
    // (unity; attenuate only).
    { name: 'setNodePan', params: ['uuid', 'pan'] },
    { name: 'setNodeGain', params: ['uuid', 'gain'] },

    // The period source (Q5): 'context' makes the node a one-shot,
    // 'own' a loop. Undoable.
    { name: 'setPeriodSource', params: ['uuid', 'source'], returns: 'bool — the period source changed' },

    // Hand Q to a track (Q22): the node becomes the island's
    // Q-definer. Undoable; published as `definerId`.
    { name: 'setDefiner', params: ['uuid'], returns: 'bool — the node defines Q' },

    // Audio device (docs/performance.md §4). A rate or buffer of 0
    // means the device's preference; the choice is persisted.
    {
        name: 'getAudioDeviceState', params: [], read: true,
        returns: '{ types, currentType, devices, currentDevice, sampleRates, ' +
            'currentSampleRate, bufferSizes, currentBufferSize, inputChannels, ' +
            'outputChannels, availableInputChannels, asioAvailable, error }'
    },
    {
        name: 'setAudioDevice', params: ['type', 'device', 'sampleRate', 'bufferSize'],
        returns: '"" on success, else an error string'
    },

    // The effect chain (docs/vst3.md): per-node slots, edited by slot
    // uuid. Enable and params are knobs (not undoable); move, add and
    // remove are undoable structure edits. An add answers once the
    // plugin has loaded: true with its slot in the chain, false when it
    // is not in the registry, could not be loaded, or its node is gone.
    // Only plugin slots can be removed.
    { name: 'setSlotEnabled', params: ['uuid', 'slotUuid', 'enabled'], returns: 'bool — the slot is switched as asked' },
    { name: 'setSlotParam', params: ['uuid', 'slotUuid', 'key', 'value'] },
    { name: 'moveChainSlot', params: ['uuid', 'slotUuid', 'newIndex'], returns: 'bool — the slot moved' },
    { name: 'addPluginToChain', params: ['uuid', 'pluginUid', 'index?'], returns: "bool — the plugin's slot is in the chain" },
    { name: 'removeChainSlot', params: ['uuid', 'slotUuid'], returns: 'bool — the slot was removed' },
    { name: 'openPluginEditor', params: ['uuid', 'slotUuid'], returns: "bool — the plugin's editor is on screen" },
    // Live MIDI (docs/vst3.md §8): arming a node clears every other.
    // getMidiInputs is a diagnostics readout no panel shows.
    { name: 'setMidiArmed', params: ['uuid', 'on'] },
    { name: 'getMidiInputs', params: [], read: true, returns: '{ devices: [name], dropped }' },
    // Whether an effects row is watching: gates the node's scope capture.
    { name: 'setEffectScope', params: ['uuid', 'active'] },

    // Latency calibration (docs/performance.md §7). A run in flight is
    // left to finish: a second start is refused.
    { name: 'startLatencyCalibration', params: [], returns: 'bool — a run started' },
    { name: 'getLatencyCalibration', params: [], read: true, returns: '{ phase, roundTripSamples, roundTripMs, calibrated }' },

    // The plugin registry (docs/vst3.md): a scan runs in the
    // background; the UI polls its status while the panel is open.
    { name: 'getKnownPlugins', params: [], read: true, returns: '[{name, uid, file, maker, category, version, isInstrument}] name-sorted' },
    { name: 'scanPlugins', params: ['extraPath?'] },
    { name: 'getPluginScanStatus', params: [], read: true, returns: '{ scanning, progress, current, count, blacklistCount, crashed: [file names excluded this scan], crashedCount, error, outOfProcess }' },

    // Debug
    { name: 'nativeLog', params: ['message'] },
];

export const BRIDGE_METHOD_NAMES = BRIDGE_METHODS.map(m => m.name);

/** A method's answer kind, as its `returns` declares it: 'bool' (a verb
 * that can be refused), 'value', or 'void'. */
export function answerKind(method) {
    if (!method.returns) return 'void';
    return /^bool\b/.test(method.returns) ? 'bool' : 'value';
}

const namesOfKind = kind => new Set(
    BRIDGE_METHODS.filter(m => answerKind(m) === kind).map(m => m.name));

/** The verbs that answer whether they applied. */
export const BOOL_METHODS = namesOfKind('bool');
/** The verbs nothing can refuse: a backend answers `true` once one ran. */
export const VOID_METHODS = namesOfKind('void');
/** The queries: they change nothing, so one may be sent again when its
 * answer was lost. No verb may. */
export const READ_METHODS = new Set(
    BRIDGE_METHODS.filter(m => m.read).map(m => m.name));

/** THE HEARTBEAT: the graph poll and the project poll. Every invocation
 * trace skips them (mock_backend.js; logCall in src/bridge_dispatch.cc)
 * — they would bury every real call, and a WebView console retains
 * each logged state object. They are also the only calls bridge.js
 * gives a deadline: a poll is asked again, a verb is not. */
export const QUIET_POLLS = new Set(['getGraphState', 'getProjectInfo']);
