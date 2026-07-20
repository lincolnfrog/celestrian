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
 */

import { launchPointFor, nextStopBoundary } from './timeline_model.js';

// In-memory state
let state = {
    isPlaying: false,
    nodes: [],
    nextId: 1
};

// --- Undo / redo (mirrors AudioEngine's edits-as-events observably) ---
// The C++ engine records inverse EDITS; the mock takes the simpler
// equivalent for e2e — a snapshot of the mutable graph taken before every
// undoable mutation. Same observable contract: canUndo/canRedo on
// getState, undo() restores the pre-edit graph, a fresh edit clears redo.
let undoStack = [];
let redoStack = [];
const UNDOABLE = new Set([
    'createNode', 'deleteNode', 'renameNode', 'reorderNode', 'combineNodes',
    'setNodePosition', 'toggleMute', 'setLoopPoints', 'toggleLoopWindow',
    'setNodeInput',
]);

function undoSnapshot() {
    return JSON.stringify({ nodes: state.nodes, islandEpoch: state.islandEpoch || 0,
                            islandQ: state.islandQ || 0 });
}
function undoRestore(snap) {
    const o = JSON.parse(snap);
    state.nodes = o.nodes;
    state.islandEpoch = o.islandEpoch;
    state.islandQ = o.islandQ || 0;
}
function pushUndo() {
    undoStack.push(undoSnapshot());
    if (undoStack.length > 128) undoStack.shift();
    redoStack = [];  // a fresh action invalidates the redo branch
}
function mockUndo() {
    if (!undoStack.length) return false;
    redoStack.push(undoSnapshot());
    undoRestore(undoStack.pop());
    return true;
}
function mockRedo() {
    if (!redoStack.length) return false;
    undoStack.push(undoSnapshot());
    undoRestore(redoStack.pop());
    return true;
}
function deleteNode(id) {
    const node = findNode(id);
    if (!node || node.isRecording) return;  // cancel is the verb for takes
    removeNodeFromParent(id);
    // Q13 revert (engine parity, applyEdit Remove): deleting the last
    // committed content leaves nothing defining Q — (Q, epoch) revert to
    // unestablished. Undo restores them via the snapshot. A 2→1 delete
    // touches nothing (mutability is derived from the count).
    if (state.islandQ > 0 && committedClipCount() === 0) {
        state.islandQ = 0;
        state.islandEpoch = 0;
        console.log('[MockBackend] Q13 revert: island (Q, epoch) → unestablished');
    }
    // RE-OPEN ⟹ UNCOLLAPSE (engine parity): back down to the sole take
    // with a lock-collapse behind it — restore the full material with
    // the old trim as the window, so it can be trimmed LONGER again.
    // Audio-neutral; Q/epoch untouched. Undo snapshot covers.
    if (committedClipCount() === 1) {
        const survivor = (function find(ns) {
            for (const n of ns || []) {
                if (n.type === 'clip' && !n.isRecording && (n.duration || 0) > 0) return n;
                const c = n.nodes && find(n.nodes);
                if (c) return c;
            }
            return null;
        })(state.nodes);
        if (survivor && survivor._precollapse) {
            const pre = survivor._precollapse;
            survivor.duration = pre.dur;
            survivor.loopStart = pre.ls;
            survivor.loopEnd = pre.le;
            survivor.origin = pre.origin;
            delete survivor._precollapse;
            console.log('[MockBackend] Q13 re-open: uncollapsed', survivor.id);
        }
    }
    console.log('[MockBackend] Deleted node:', id);
}

// Save/Load (mirrors AudioEngine's session_io observably). The mock keeps
// the bundle in memory instead of a session.json + audio/ directory, so
// e2e can round-trip without a filesystem. Load clears undo history.
let mockSavedSession = null;
function saveSession(_path) {
    mockSavedSession = JSON.stringify({ nodes: state.nodes, islandEpoch: state.islandEpoch || 0,
                                        islandQ: state.islandQ || 0 });
    return true;
}
function loadSession(_path) {
    if (!mockSavedSession) return false;
    const o = JSON.parse(mockSavedSession);
    state.nodes = o.nodes;
    state.islandEpoch = o.islandEpoch;
    state.islandQ = o.islandQ || 0;
    undoStack = [];
    redoStack = [];
    return true;
}

// --- The project model (docs/projects.md), mirrored in memory ---
// The mock keeps a fake projects "disk" so the UI's birth/rename/template
// flows are drivable in the browser and by e2e. Birth parity: first
// committed take (checked on getProjectInfo polls — the mock's tick).
const mockProjects = {
    current: { id: '', name: '', born: false },
    recents: [],                  // [{id, name, path}]
    templates: [{ id: 'My Rig', name: 'My Rig', path: '/templates/My Rig' }],
    serial: 0,
};
function projectDateId() {
    const d = new Date();
    const ymd = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    mockProjects.serial += 1;
    return `${ymd}-${String(mockProjects.serial).padStart(2, '0')}`;
}
function getProjectInfo() {
    // Birth at first committed take (ProjectManager::tick parity).
    if (!mockProjects.current.born && committedClipCount() > 0 &&
        !anyNodeRecording()) {
        const id = projectDateId();
        mockProjects.current = { id, name: id, born: true };
        mockProjects.recents.unshift({ id, name: id, path: '/projects/' + id });
        console.log('[MockBackend] Project born:', id);
    }
    return JSON.stringify(mockProjects.current);
}
function renameProject(name) {
    // Display name only — the id (folder) never changes.
    if (name && name.trim()) mockProjects.current.name = name.trim();
    const r = mockProjects.recents.find(x => x.id === mockProjects.current.id);
    if (r) r.name = mockProjects.current.name;
    return true;
}
function newProjectFromTemplate(_name) {
    // Template = structure only, pre-Q: the mock resets to an empty
    // session (scenario graphs stand in for template structure).
    loadScenario('empty');
    mockProjects.current = { id: '', name: '', born: false };
    return true;
}

/**
 * Handler table for every protocol method. Keys must match
 * protocol.js BRIDGE_METHOD_NAMES exactly (see protocol_contract.test.mjs).
 */
export const handlers = {
    getProjectInfo: () => getProjectInfo(),
    renameProject: (name) => renameProject(name),
    saveProjectNow: () => { if (!mockProjects.current.born) { const id = projectDateId(); mockProjects.current = { id, name: id, born: true }; mockProjects.recents.unshift({ id, name: id, path: '/projects/' + id }); } return true; },
    listTemplates: () => JSON.stringify(mockProjects.templates),
    listRecentProjects: () => JSON.stringify(mockProjects.recents),
    newProjectFromTemplate: (name) => newProjectFromTemplate(name),
    openProjectPath: (path) => {
        const r = mockProjects.recents.find(x => x.path === path);
        if (!r) return false;
        mockProjects.current = { id: r.id, name: r.name, born: true };
        return true;
    },
    saveAsTemplate: (name) => {
        if (!name || !name.trim()) return false;
        const n = name.trim();
        if (!mockProjects.templates.some(t => t.id === n)) {
            mockProjects.templates.push({ id: n, name: n, path: '/templates/' + n });
        }
        return true;
    },
    duplicateProject: () => {
        if (!mockProjects.current.born) return '';
        const id = projectDateId();
        const name = mockProjects.current.name;
        mockProjects.current = { id, name, born: true };
        mockProjects.recents.unshift({ id, name, path: '/projects/' + id });
        return id;
    },
    ping: () => 'pong',
    togglePlayback: () => togglePlayback(),
    startRecordingInNode: (id) => startRecordingInNode(id),
    stopRecordingInNode: (id) => stopRecordingInNode(id),
    getGraphState: () => getState(),
    getWaveform: (id, numPeaks) => getWaveform(id, numPeaks),
    toggleStackExpand: (id) => toggleStackExpand(id),
    createNode: (type, parentId) => createNode(type, parentId),
    deleteNode: (id) => deleteNode(id),
    undo: () => mockUndo(),
    redo: () => mockRedo(),
    saveSession: (path) => saveSession(path),
    loadSession: (path) => loadSession(path),
    renameNode: (id, name) => renameNode(id, name),
    reorderNode: (id, parentId, index) => reorderNode(id, parentId, index),
    setNodePosition: (id, x, y) => setNodePosition(id, x, y),
    combineNodes: (draggedId, targetId) => combineNodes(draggedId, targetId),
    getInputList: () => getInputList(),
    setNodeInput: (id, channelIndex) => setNodeInput(id, channelIndex),
    setEffectEnabled: (id, fx, enabled) => setEffectEnabled(id, fx, enabled),
    setEffectParam: (id, fx, param, value) => setEffectParam(id, fx, param, value),
    setEffectScope: (id, active) => setEffectScope(id, active),
    startLatencyCalibration: () => startLatencyCalibration(),
    getLatencyCalibration: () => getLatencyCalibration(),
    setLoopPoints: (id, start, end) => setLoopPoints(id, start, end),
    toggleLoopWindow: (id) => toggleLoopWindow(id),
    togglePlay: (id) => togglePlay(id),
    toggleSolo: (id) => toggleSolo(id),
    toggleMute: (id) => toggleMute(id),
    nativeLog: (msg) => { console.log('[JS]', msg); return true; },
    dumpStateToFile: (json) => { console.log('[MockBackend] dumpStateToFile (no-op in mock)'); return true; }
};

// Polyfill for callNative - simulates the native C++ bridge
export async function callNative(method, ...args) {
    console.log(`[MockBackend] callNative: ${method}`, args);

    const handler = handlers[method];
    if (!handler) {
        console.warn(`[MockBackend] Unknown method: ${method}`);
        return null;
    }
    // Snapshot BEFORE any undoable mutation so undo restores the pre-edit
    // graph (single interception point, mirrors AudioEngine::record).
    if (UNDOABLE.has(method)) pushUndo();
    return handler(...args);
}

// Polyfill for log - just console.log in browser
export function log(...args) {
    console.log('[App]', ...args);
}

// Generate unique IDs
function generateId() {
    return `node-${state.nextId++}`;
}

// Find node by ID (recursive for stacks)
function findNode(id, nodes = state.nodes) {
    for (const node of nodes) {
        if (node.id === id) return node;
        if (node.type === 'stack' && node.nodes) {
            const found = findNode(id, node.nodes);
            if (found) return found;
        }
    }
    return null;
}

// Find parent of a node
function findParent(nodeId, nodes = state.nodes, parent = null) {
    for (const node of nodes) {
        if (node.id === nodeId) return parent;
        if (node.type === 'stack' && node.nodes) {
            const found = findParent(nodeId, node.nodes, node);
            if (found !== null) return found;
        }
    }
    return null;
}

// Remove node from parent
function removeNodeFromParent(nodeId) {
    const parent = findParent(nodeId);
    if (parent && parent.nodes) {
        parent.nodes = parent.nodes.filter(n => n.id !== nodeId);
    } else {
        // Top-level
        state.nodes = state.nodes.filter(n => n.id !== nodeId);
    }
}

// createNode(type, parentId)
function createNode(type, parentId = null) {
    const node = {
        id: generateId(),
        name: type === 'clip' ? 'New Clip' : 'New Stack',
        type: type,
        x: 0,
        y: 0,
        w: 200,
        h: 100,
        duration: 0,
        isRecording: false,
        isPlaying: false,
        isMuted: false,
        isSoloed: false,
        effectiveQuantum: 0,
        inputChannel: -1
    };

    if (type === 'stack') {
        node.nodes = [];
        node.isExpanded = true;
    }

    // Add to parent or top-level
    if (parentId) {
        const parent = findNode(parentId);
        if (parent && parent.type === 'stack') {
            parent.nodes = parent.nodes || [];
            parent.nodes.push(node);
        }
    } else {
        state.nodes.push(node);
    }

    console.log('[MockBackend] Created node:', node.id, type);
    return node.id;
}

// Mirrors AudioEngine::togglePlayback — pause/resume: the clock is
// never reset (kernel.md); stopping freezes the view where it is.
function togglePlayback() {
    state.isPlaying = !state.isPlaying;
    transport.running = state.isPlaying;
    console.log('[MockBackend] togglePlayback →', state.isPlaying);
    return true;
}

// Deterministic waveform peaks for a node (no Math.random — stable for tests).
function getWaveform(id, numPeaks = 100) {
    const node = findNode(id);
    if (!node) return [];
    if (node.type === 'stack') return generateStackWaveform(node, numPeaks);
    if (!node.duration || node.duration <= 0) return [];

    const peaks = [];
    for (let i = 0; i < numPeaks; i++) {
        peaks.push(0.5 + 0.4 * Math.sin((i / numPeaks) * Math.PI * 4));
    }
    return peaks;
}

/**
 * The island quantum, mirroring the C++ model (P0-3): a STORED fact
 * (`state.islandQ` — established at first commit, re-established by a
 * provisional re-trim, reverted when the last committed clip goes).
 * The legacy min-duration/declared derivation survives only for
 * scenario fixtures that predate the stored field.
 */
function effectiveQuantumForState() {
    if (state.islandQ > 0) return state.islandQ;
    let minDuration = 0;
    let declaredQ = 0;

    const visit = (nodes) => (nodes || []).forEach(n => {
        if (n.type === 'clip' && !n.isRecording && n.duration > 0) {
            if (minDuration === 0 || n.duration < minDuration) minDuration = n.duration;
        }
        if (n.effectiveQuantum > 0 && (declaredQ === 0 || n.effectiveQuantum < declaredQ)) {
            declaredQ = n.effectiveQuantum;
        }
        if (n.nodes) visit(n.nodes);
    });
    visit(state.nodes);

    return minDuration > 0 ? minDuration : declaredQ;
}

function renameNode(id, newName) {
    const node = findNode(id);
    if (node) {
        node.name = newName;
        console.log('[MockBackend] Renamed node:', id, '→', newName);
    }
}

function reorderNode(nodeId, newParentId, newIndex) {
    const node = findNode(nodeId);
    if (!node) return;

    // Remove from current parent
    removeNodeFromParent(nodeId);

    // Add to new parent at specified index
    const newParent = findNode(newParentId);
    if (newParent && newParent.type === 'stack') {
        newParent.nodes = newParent.nodes || [];

        // Clamp index to valid range
        const index = Math.max(0, Math.min(newIndex, newParent.nodes.length));

        // Insert at specified index
        newParent.nodes.splice(index, 0, node);
        console.log('[MockBackend] Reordered node:', nodeId, 'to', newParentId, 'at index', index);
    }
}

function setNodePosition(nodeId, x, y) {
    const node = findNode(nodeId);
    if (node) {
        node.x = x;
        node.y = y;
        console.log('[MockBackend] Set position:', nodeId, 'to', x, y);
    }
}

function togglePlay(id) {
    const node = findNode(id);
    if (node) {
        node.isPlaying = !node.isPlaying;
        console.log('[MockBackend] Toggle play:', id, '→', node.isPlaying);
    }
}

function toggleSolo(id) {
    const node = findNode(id);
    if (node) {
        node.isSoloed = !node.isSoloed;
        console.log('[MockBackend] Toggle solo:', id, '→', node.isSoloed);
    }
}

function toggleMute(id) {
    const node = findNode(id);
    if (node) {
        node.isMuted = !node.isMuted;
        console.log('[MockBackend] Toggle mute:', id, '→', node.isMuted);
    }
}

function toggleStackExpand(id) {
    const node = findNode(id);
    if (node && node.type === 'stack') {
        node.isExpanded = !node.isExpanded;
        console.log('[MockBackend] Toggle expand:', id, '→', node.isExpanded);
    }
}

function getInputList() {
    // Shape matches AudioEngine::getInputList: { inputs: [...] }
    return { inputs: ['Built-in Microphone', 'External Audio'] };
}

function setNodeInput(id, channelIndex) {
    const node = findNode(id);
    if (node) {
        node.inputChannel = channelIndex;
        console.log('[MockBackend] Set input:', id, '→ channel', channelIndex);
    }
}

// Built-in effects (engine parity: dsp::EffectRack defaults — the same
// keys and values AudioNode publishes in metadata).
function defaultEffects() {
    return {
        eq: { enabled: false, low: 0, mid: 0, high: 0 },
        compressor: { enabled: false, threshold: -18, ratio: 4, attack: 10, release: 100, makeup: 0 },
        echo: { enabled: false, time: 0.35, feedback: 0.35, mix: 0.35 },
        reverb: { enabled: false, size: 0.5, damp: 0.5, mix: 0.3 },
    };
}
function ensureEffects(node) {
    if (!node.effects) node.effects = defaultEffects();
    return node.effects;
}

function setEffectEnabled(id, fx, enabled) {
    const node = findNode(id);
    if (node && ensureEffects(node)[fx]) {
        node.effects[fx].enabled = !!enabled;
        console.log('[MockBackend] Effect', fx, 'on', id, '→', enabled ? 'ENABLED' : 'DISABLED');
    }
}

function setEffectParam(id, fx, param, value) {
    const node = findNode(id);
    if (node && ensureEffects(node)[fx] &&
        Object.prototype.hasOwnProperty.call(node.effects[fx], param)) {
        node.effects[fx][param] = value;
        console.log('[MockBackend] Effect param', fx + '.' + param, 'on', id, '→', value);
    }
}

function setEffectScope(id, active) {
    // Engine parity (EffectRack::setScopeActive): scope telemetry only
    // exists while a panel watches.
    const node = findNode(id);
    if (node) {
        node._scopeOn = !!active;
        console.log('[MockBackend] Effect scope on', id, '→', active ? 'OPEN' : 'CLOSED');
    }
}

// Latency calibration (docs/performance.md §7). The mock simulates a 2 s
// capture window and reports a plausible fixed round trip.
let calibration = { phase: 'idle', startedAt: 0, roundTripSamples: -1 };
const MOCK_ROUND_TRIP_SAMPLES = 1024;

function startLatencyCalibration() {
    calibration = { phase: 'capturing', startedAt: Date.now(), roundTripSamples: -1 };
    console.log('[MockBackend] Latency calibration started');
    return true;
}

function getLatencyCalibration() {
    if (calibration.phase === 'capturing' && Date.now() - calibration.startedAt >= 2000) {
        calibration.phase = 'done';
        calibration.roundTripSamples = MOCK_ROUND_TRIP_SAMPLES;
    }
    const calibrated = calibration.roundTripSamples >= 0;
    return {
        phase: calibration.phase,
        roundTripSamples: calibration.roundTripSamples,
        roundTripMs: calibrated ? (calibration.roundTripSamples / 44100) * 1000 : -1,
        calibrated,
    };
}

// Any armed/capturing take (parity with StackNode::hasActiveTake) —
// gates provisional re-trim: a performing take already plays against
// the current grid, so a drag mid-take is an ordinary window edit.
function anyNodeRecording() {
    return (function visit(nodes) {
        return (nodes || []).some(n => n.isRecording || (n.nodes && visit(n.nodes)));
    })(state.nodes);
}

// Committed clips in the island (parity with
// AudioEngine::islandCommittedClipCount) — drives Q13 mutability.
function committedClipCount() {
    let n = 0;
    (function visit(nodes) {
        (nodes || []).forEach(node => {
            if (node.type === 'clip' && !node.isRecording && (node.duration || 0) > 0) n++;
            if (node.nodes) visit(node.nodes);
        });
    })(state.nodes);
    return n;
}

function setLoopPoints(id, loopStart, loopEnd) {
    const node = findNode(id);
    if (!node) return;
    // Pre-edit window (the phase-preserve math below needs it).
    const oldLs = node.loopStart || 0;
    const oldLe = Math.min(node.loopEnd || 0, node.duration || 0);
    node.loopStart = loopStart;
    node.loopEnd = loopEnd;
    // Clamp to the recorded material (engine parity): a fractional-Q
    // drag rounded past the take's end must not window silence.
    if (node.type === 'clip' && (node.duration || 0) > 0) {
        loopStart = Math.max(0, loopStart);
        loopEnd = Math.min(loopEnd, node.duration);
        node.loopStart = loopStart;
        node.loopEnd = loopEnd;
    }
    // Q13 parity (AudioEngine::setLoopPoints): while the island's only
    // committed content is this clip (and no take is in flight), its
    // loop region re-establishes the STORED island (Q, epoch):
    // Q := window length, epoch := origin + window start. PHASE-
    // PRESERVING (engine parity): re-anchor origin so the buffer
    // position sounding right now doesn't move — fold it into the new
    // window and solve origin' = t0 − p_target.
    if (loopEnd > loopStart && node.type === 'clip' && (node.duration || 0) > 0 &&
        committedClipCount() === 1 && !anyNodeRecording()) {
        const t0 = state.masterPos || 0;
        const mod = (a, m) => ((a % m) + m) % m;
        const oldLen = oldLe - oldLs;
        const len = loopEnd - loopStart;
        const p0 = oldLen > 0
            ? oldLs + mod(t0 - (node.origin || 0) - oldLs, oldLen)
            : loopStart;
        const pT = loopStart + mod(p0 - loopStart, len);
        node.origin = t0 - pT;
        state.islandQ = len;
        state.islandEpoch = node.origin + loopStart;
        console.log('[MockBackend] Q13 re-trim → Q =', state.islandQ);
    }
    console.log('[MockBackend] Set loop points:', id, '→', loopStart, '-', loopEnd);
}

function toggleLoopWindow(id) {
    // Fractal (I5, engine parity): clips toggle their single-segment
    // window exactly like stacks toggle their time-map.
    const node = findNode(id);
    if (node) {
        node.loopBypassed = !node.loopBypassed;
        console.log('[MockBackend] Loop window', id, '→',
            node.loopBypassed ? 'BYPASSED' : 'ACTIVE');
    }
}

function startRecordingInNode(id) {
    const node = findNode(id);
    if (!node) return;

    console.log('[MockBackend] startRecordingInNode', id);

    // Q13 LOCK-COLLAPSE (engine parity, AudioEngine::startRecordingInNode
    // → Edit::CollapseTake): arming a take against a provisionally
    // trimmed island finalizes the trim — the sole committed clip's
    // window BECOMES the take (duration = window len, origin moves to
    // the window top, window consumed). Undo (snapshot) restores.
    if (committedClipCount() === 1) {
        const definer = (function find(ns) {
            for (const n of ns || []) {
                if (n.type === 'clip' && !n.isRecording && (n.duration || 0) > 0) return n;
                const c = n.nodes && find(n.nodes);
                if (c) return c;
            }
            return null;
        })(state.nodes);
        if (definer && definer.id !== id && !definer.loopBypassed) {
            const ls = definer.loopStart || 0;
            const le = Math.min(definer.loopEnd || 0, definer.duration);
            const len = le - ls;
            if (len > 0 && !(ls === 0 && le >= definer.duration)) {
                pushUndo();
                // The engine keeps the cut material behind content_base_;
                // the mock (no buffers) remembers the pre-collapse facts
                // so a re-opening delete can uncollapse (see deleteNode).
                definer._precollapse = { dur: definer.duration, ls, le,
                                         origin: definer.origin || 0 };
                definer.origin = (definer.origin || 0) + ls;
                definer.duration = len;
                definer.loopStart = 0;
                definer.loopEnd = len;
                console.log('[MockBackend] Q13 lock-collapse:', definer.id,
                    '→ duration =', len);
            }
        }
    }

    // FIRST CLIP SNAP LOGIC (Simulation)
    // If this is the "first clip" (no effective quantum established globally yet),
    // we reset the global transport to 0.
    // In Mock, we can check if any other clip has duration > 0.
    const hasExistingAudio = state.nodes.some(n =>
        (n.type === 'clip' && n.duration > 0) ||
        (n.type === 'stack' && n.nodes && n.nodes.some(c => c.duration > 0))
    );

    if (!hasExistingAudio) {
        state.masterPos = 0;
        console.log('[MockBackend] First Clip Detected -> Reset Global Transport to 0');
    }

    // Freeze the view base (mirrors AudioEngine view_base_/view_anchor_t_):
    // from here the published masterPos grows linearly past the cycle.
    // Base = the EFFECTIVE (window-aware) view the user was watching;
    // lcmBefore = INTRINSIC (commit/re-base compares committed material).
    if (!recView.active) {
        const raw = state.masterPos || 0;
        const Q = effectiveQuantumForState();
        const viewCycle = effectiveCycle(Q);
        const rel = raw - (state.islandEpoch || 0);
        recView.base = viewCycle > 0 ? ((rel % viewCycle) + viewCycle) % viewCycle : rel;
        recView.anchor = raw;
        recView.lcmBefore = committedCycle(Q); // engine's lcm_before_take_
        recView.heardAtArm = viewCycle;        // engine's heard_cycle_at_arm_
        recView.active = true;
    }

    node.isRecording = true;

    // Q11 (engine parity): with Q established, arming PENDS until the
    // next Q boundary in the epoch frame — recording begins there, so
    // origins always land ON boundaries. (The mock once started
    // instantly: a mid-Q origin made the commit re-base shift every
    // lane's grid by a fraction — the "squash/stretch" repro was
    // mock-tainted until this.) Exactly-on-boundary starts immediately.
    const Q = effectiveQuantumForState();
    const raw = state.masterPos || 0;
    if (Q > 0) {
        const rel = ((raw - (state.islandEpoch || 0)) % Q + Q) % Q;
        const toNext = rel === 0 ? 0 : Q - rel;
        if (toNext > 0) {
            node.isPendingStart = true;
            node.pendingStartAt = raw + toNext;
            node.duration = 0;
            console.log('[MockBackend] Pending start at raw', node.pendingStartAt);
            return;
        }
    }
    node.recordingStartPos = raw;
}

function stopRecordingInNode(id) {
    const node = findNode(id);
    if (!node || !node.isRecording) return;

    console.log('[MockBackend] stopRecordingInNode', id);

    const Q = effectiveQuantumForState();
    // Length authority: live duration (grown by the transport) and the
    // masterPos delta must agree; setMasterPos-driven tests only move
    // the latter, so reconcile here
    const rawLen = Math.max(node.duration || 0,
        (state.masterPos || 0) - (node.recordingStartPos || 0));
    node.duration = rawLen;

    // ENGINE PARITY (ClipNode::stopRecording + owner ruling 2026-07-10:
    // stops always pad FORWARD): with Q established, a stop request
    // enters AWAITING-STOP — recording continues to nextStopBoundary and
    // commits there (growRecordingClips). Only the first clip (no Q)
    // commits immediately at its raw length.
    if (Q > 0) {
        node.isAwaitingStop = true;
        node.awaitingStopAt = nextStopBoundary(rawLen, Q);
        console.log('[MockBackend] Awaiting stop at len', node.awaitingStopAt,
            '(current', rawLen + ')');
        return;
    }
    commitClip(node, rawLen);
}

/** Commit a recording at exactly `duration` (mirrors commitRecording). */
function commitClip(node, duration) {
    // Q BEFORE committing, so the stopping clip cannot define its own
    // quantum (mirrors C++ commit order)
    const Q = effectiveQuantumForState();

    node.isRecording = false;
    node.isAwaitingStop = false;
    const loopEnd = duration;

    node.duration = duration;
    node.isPlaying = true;
    node.loopStart = 0;
    node.loopEnd = loopEnd;

    // First committed take ESTABLISHES Q (design_language.md Q1: the DNA
    // of the scratch track) — STORED island state (P0-3), plus the
    // per-node declaration legacy consumers still read.
    if (Q <= 0 && duration > 0) {
        state.islandQ = duration;
        node.effectiveQuantum = duration;
        console.log('[MockBackend] First take establishes Q =', duration);
    }

    // HEARD-FRAME ORIGIN FOLD (Q15, mirrors ClipNode::armEvaluate):
    // when active windows made the audible cycle shorter than the
    // intrinsic one at arm, every heard boundary is audibly identical —
    // store the representative in the FIRST heard window of the frame.
    let foldedOrigin = node.recordingStartPos || 0;
    const heardAtArm = recView.heardAtArm || 0;
    if (heardAtArm > 0 && recView.lcmBefore > heardAtArm) {
        const relT = (((foldedOrigin - (state.islandEpoch || 0)) %
            recView.lcmBefore) + recView.lcmBefore) % recView.lcmBefore;
        foldedOrigin -= Math.floor(relT / heardAtArm) * heardAtArm;
    }

    // The take's HEARD FRAME (Q14/Q15): the EFFECTIVE cycle it was
    // performed against — display take-marking folds by this.
    node.contextCycle = heardAtArm > 0 ? heardAtArm
        : (recView.lcmBefore > 0 ? recView.lcmBefore : 0);

    // Commit epoch re-base (mirrors StackNode::takeCommitted,
    // 2026-07-16): when the cycle GREW, the epoch moves to the HEARD
    // top the take was performed against — its (folded) origin floored
    // to whole pre-take INTRINSIC cycles. Phase-neutral for every
    // committed lane; the frame the user watched while recording
    // persists at commit.
    const newCycle = committedCycle(effectiveQuantumForState());
    if (recView.lcmBefore > 0 && newCycle > recView.lcmBefore && duration > 0) {
        const rel = Math.max(0, foldedOrigin - (state.islandEpoch || 0));
        state.islandEpoch = (state.islandEpoch || 0) +
            Math.floor(rel / recView.lcmBefore) * recView.lcmBefore;
        console.log('[MockBackend] Cycle grew: epoch re-based to heard top',
            state.islandEpoch);
    }

    // Release the frozen view base when the LAST recording stops
    // (mirrors the engine's was_any_node_recording_ edge)
    const anyStillRecording = (function visit(ns) {
        return (ns || []).some(n => n.isRecording || (n.nodes && visit(n.nodes)));
    })(state.nodes);
    if (!anyStillRecording) recView.active = false;

    // Origin is THE canonical timing fact (docs/kernel.md): the cycle
    // moment content[0] belongs to — heard-frame FOLDED (Q15, above).
    // Launch point is its projection, kept for UI compatibility.
    node.origin = foldedOrigin;
    node.launchPoint = launchPointFor(node.origin, duration);

    console.log(`[MockBackend] Committed ${node.id}: Dur=${duration} (Q=${Q})`);
}

/**
 * Combine two nodes into a new stack.
 * Creates a new stack at the target's position, containing both nodes.
 */
function combineNodes(draggedId, targetId) {
    const draggedNode = findNode(draggedId);
    const targetNode = findNode(targetId);

    if (!draggedNode || !targetNode) {
        console.warn('[MockBackend] combineNodes: Node not found');
        return null;
    }

    // Find parent of target to insert new stack there
    const targetParent = findParent(targetId);
    const targetList = targetParent ? targetParent.nodes : state.nodes;
    let targetIndex = targetList.findIndex(n => n.id === targetId);
    // Account for the dragged node vacating an earlier slot in the same list
    const draggedIndex = targetList.findIndex(n => n.id === draggedId);
    if (draggedIndex >= 0 && draggedIndex < targetIndex) targetIndex--;

    // Remove both nodes from their parents
    removeNodeFromParent(draggedId);
    removeNodeFromParent(targetId);

    // Create new stack
    const newStack = {
        id: `stack-${state.nextId++}`,
        name: 'Combined Stack',
        type: 'stack',
        x: targetNode.x || 0,
        y: targetNode.y || 0,
        w: Math.max(targetNode.w || 400, draggedNode.w || 400),
        h: 300,
        isExpanded: true,
        effectiveQuantum: targetNode.effectiveQuantum || 44100,
        nodes: [targetNode, draggedNode]  // Target first, then dragged
    };

    // Insert at target's original position. Re-resolve the list first:
    // removeNodeFromParent REPLACES the parent's nodes array, so the
    // pre-removal targetList reference is orphaned by now.
    const insertList = targetParent ? targetParent.nodes : state.nodes;
    if (targetIndex >= 0) {
        insertList.splice(Math.min(targetIndex, insertList.length), 0, newStack);
    } else {
        insertList.push(newStack);
    }

    console.log('[MockBackend] Combined nodes into stack:', newStack.id);
    return newStack.id;
}

// Generate mock waveform data for a stack (aggregates children)
function generateStackWaveform(node, numPeaks = 100) {
    if (node.type !== 'stack') return [];

    const children = node.nodes || [];
    if (children.length === 0) return [];

    // Simple aggregation: sum of sine-like patterns based on child count
    const peaks = [];
    for (let i = 0; i < numPeaks; i++) {
        let sum = 0;
        children.forEach((child, idx) => {
            // Each child contributes a sine wave at different frequency
            const freq = 2 + idx;
            sum += Math.sin((i / numPeaks) * Math.PI * freq) * 0.3;
        });
        peaks.push(Math.min(1, Math.max(0, 0.5 + sum / children.length)));
    }
    return peaks;
}

// Recursively add waveform and transport data to nodes
function enrichNodes(nodes) {
    return nodes.map(node => {
        // NO synthetic `waveform` on stacks: the ENGINE's state metadata
        // carries no waveform field, so the UI composites stacks from
        // child peaks (composite_waveform.js). The mock once attached
        // count-normalized sines, which short-circuited that path AND
        // dimmed when a silent track was added (mock/engine drift —
        // test_harness.md gotcha 10, field 2026-07-10).
        const updatedNode = node.type === 'stack'
            ? { ...node, nodes: node.nodes ? enrichNodes(node.nodes) : [] }
            : { ...node };

        // Loop window state — FRACTAL, engine parity (AudioNode base):
        // active iff valid and not bypassed, published for clips and
        // stacks alike; `playhead` carries the window phase while
        // active: (masterPos − epoch) mod len.
        const bypassed = !!node.loopBypassed;
        const windowActive = !bypassed && node.loopEnd > node.loopStart;
        updatedNode.loopBypassed = bypassed;
        updatedNode.windowActive = windowActive;
        // Effect rack state publishes on EVERY node (engine parity:
        // AudioNode::getMetadata always carries `effects`)
        updatedNode.effects = node.effects || defaultEffects();
        // Scope telemetry (engine parity: published only while a panel
        // WATCHES — setEffectScope). Synthesized: a pink-ish spectrum
        // that breathes with the transport, a peak, and the
        // compressor's theoretical GR.
        const fxs = updatedNode.effects;
        if (node._scopeOn) {
            const t = (state.masterPos || 0) / 44100;
            const peak = state.isPlaying
                ? 0.35 + 0.3 * Math.abs(Math.sin(t * 2.1 + 0.4)) : 0;
            let gr = 0;
            if (fxs.compressor.enabled && peak > 0) {
                const peakDb = 20 * Math.log10(peak);
                const c = fxs.compressor;
                if (peakDb > c.threshold) {
                    gr = (peakDb - c.threshold) * (1 - 1 / c.ratio);
                }
            }
            // Engine parity: a stopped transport is SILENCE — bins near
            // zero (this is what the durable line's slow fall exists for)
            const live = state.isPlaying ? 1 : 0;
            updatedNode.effects = {
                ...fxs,
                scope: {
                    spectrum: Array.from({ length: 24 }, (_, i) =>
                        Math.max(0, Math.min(1,
                            0.72 - i * 0.022 + 0.2 * Math.sin(t * 3 + i * 0.7))) * live),
                    peak,
                    gr,
                },
            };
        }
        if (windowActive) {
            const loopLen = node.loopEnd - node.loopStart;
            // Engine parity: a STACK's window phase is island-aligned
            // ((t − epoch) mod len); a CLIP's anchors at the window
            // top's own performance moment, origin + loopStart (the
            // kernel playback equation applied to the surviving
            // material — clip_node.cc, 2026-07-19).
            const anchor = node.type === 'clip'
                ? (node.origin || 0) + node.loopStart
                : (state.islandEpoch || 0);
            const rel = (state.masterPos || 0) - anchor;
            updatedNode.playhead = (((rel % loopLen) + loopLen) % loopLen) / loopLen;
        }

        return updatedNode;
    });
}

// Export state getter for polling
/**
 * masterPos CONTRACT (mirrors AudioEngine::getGraphState — kernel.md
 * step 3): the engine's clock is monotonic and never exposed raw. The
 * published masterPos is a DERIVED VIEW — wrapped to the cycle when
 * idle/playing, but during recording it grows linearly from a base
 * frozen at record start, so the cursor extends past the committed LCM.
 * Consumers must NOT re-wrap it (re-wrapping caused the "looping 1Q
 * over and over" field bug, 2026-07-09).
 */
function viewMasterPos() {
    const raw = state.masterPos || 0;
    if (recView.active) return recView.base + (raw - recView.anchor);
    const Q = effectiveQuantumForState();
    // E-C (engine parity): the view wraps on the EFFECTIVE cycle — the
    // playhead loops with what is heard, never past an active window.
    const cycle = effectiveCycle(Q);
    const rel = raw - (state.islandEpoch || 0); // engine: rel = t − islandEpoch()
    return cycle > 0 ? ((rel % cycle) + cycle) % cycle : rel;
}

/** LCM of committed clip durations (the engine's calculateTimelineLength). */
function committedCycle(Q) {
    let cycle = Q > 0 ? Q : 0;
    const visit = ns => (ns || []).forEach(n => {
        if (n.type === 'clip' && !n.isRecording && n.duration > 0) {
            cycle = cycle > 0 ? lcmInt(cycle, Math.round(n.duration)) : Math.round(n.duration);
        }
        if (n.nodes) visit(n.nodes);
    });
    visit(state.nodes);
    return cycle;
}

/**
 * The AUDIBLE island cycle (the engine's calculateEffectiveCycleLength,
 * E-C): an active loop window makes a node contribute its window length
 * instead of its intrinsic period — recursion stops at the window. The
 * published masterPos wraps on THIS; commit/re-base logic stays on
 * committedCycle (windows are view-of-time state, not material).
 */
function effectivePeriodOf(node) {
    if (node.isRecording) return 0;
    if (!node.loopBypassed && node.loopEnd > node.loopStart) {
        return Math.round(node.loopEnd - node.loopStart);
    }
    if (node.type !== 'stack') return node.duration > 0 ? Math.round(node.duration) : 0;
    let composite = 0;
    (node.nodes || []).forEach(c => {
        const p = effectivePeriodOf(c);
        if (p > 0) composite = composite > 0 ? lcmInt(composite, p) : p;
    });
    return composite;
}
function effectiveCycle(Q) {
    let cycle = Q > 0 ? Q : 0;
    state.nodes.forEach(n => {
        const p = effectivePeriodOf(n);
        if (p > 0) cycle = cycle > 0 ? lcmInt(cycle, p) : p;
    });
    return cycle;
}
function lcmInt(a, b) {
    const g = (x, y) => (y ? g(y, x % y) : x);
    return a / g(a, b) * b;
}

const recView = { active: false, base: 0, anchor: 0, lcmBefore: 0 };

export function getState() {
    // Auto-advance transport if running (simulates real-time playback/recording)
    advanceTransport();

    return {
        isPlaying: state.isPlaying,
        masterPos: viewMasterPos(),
        // Island epoch (mirrors getGraphState): the UI's frame origin.
        // Commit re-bases it to the newest origin on simple extensions.
        islandEpoch: state.islandEpoch || 0,
        // The STORED island quantum (mirrors the root stack's `quantum`
        // metadata). 0 for scenario fixtures that predate the field —
        // the VM then falls back to its min-over-nodes derivation.
        quantum: state.islandQ || 0,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
        nodes: enrichNodes(state.nodes),
        // Mirrors AudioEngine::makePerfState so calibration-aware UI
        // (e.g. the calibrate button label) behaves in mock mode.
        perf: {
            maxBlockUs: 0,
            avgLoadPct: 0,
            xruns: 0,
            latencyCompensationSamples:
                calibration.roundTripSamples >= 0 ? calibration.roundTripSamples : 0,
            calibrated: calibration.roundTripSamples >= 0,
            sampleRate: 44100,
        },
    };
}

// Allow tests to set master position on underlying state
export function setMasterPos(pos) {
    state.masterPos = pos;
}

// Allow tests to set isPlaying on underlying state
export function setIsPlaying(playing) {
    state.isPlaying = playing;
}

// --- Transport Simulation ---
// Simulates the C++ audio engine advancing masterPos and recording clip duration.
// Auto-advance mode hooks into getState() polls (~50ms intervals).
// Deterministic mode uses advanceBy() for exact sample-count stepping.

let transport = {
    running: false,           // Is transport auto-advancing?
    samplesPerTick: 2205,     // Samples per poll tick (~50ms at 44100Hz)
    speed: 1.0                // Speed multiplier (1.0 = real-time)
};

// Grow recording clips by a given sample count. An AWAITING-STOP clip
// commits the moment its length reaches the boundary (engine parity:
// ClipNode's awaiting_stop_at crossing check).
function growRecordingClips(nodes, samples) {
    (nodes || []).forEach(node => {
        if (node.isRecording) {
            if (node.isPendingStart) {
                // Q11 trigger: recording begins AT the boundary
                if ((state.masterPos || 0) >= node.pendingStartAt) {
                    node.isPendingStart = false;
                    node.recordingStartPos = node.pendingStartAt;
                    node.duration = (state.masterPos || 0) - node.pendingStartAt;
                    node.currentPeak = 0.3 + Math.random() * 0.4;
                }
            } else {
                node.duration = (node.duration || 0) + samples;
                // Simulate live peak data (oscillating value)
                node.currentPeak = 0.3 + Math.random() * 0.4;
                if (node.isAwaitingStop && node.duration >= node.awaitingStopAt) {
                    commitClip(node, node.awaitingStopAt);
                }
            }
        }
        if (node.nodes) growRecordingClips(node.nodes, samples);
    });
}

// Called on every getState() poll when transport is running
function advanceTransport() {
    if (!transport.running) return;

    const advance = Math.round(transport.samplesPerTick * transport.speed);
    state.masterPos = (state.masterPos || 0) + advance;
    growRecordingClips(state.nodes, advance);
}

// Start auto-advancing transport (hooks into getState polls)
export function startTransport(speed = 1.0) {
    transport.running = true;
    transport.speed = speed;
    state.isPlaying = true;
    console.log(`[MockBackend] Transport started (speed=${speed})`);
}

// Pause auto-advancing transport
export function pauseTransport() {
    transport.running = false;
    console.log('[MockBackend] Transport paused');
}

// Deterministic advance by exact sample count (for reliable test assertions)
export function advanceBy(samples) {
    state.masterPos = (state.masterPos || 0) + samples;
    growRecordingClips(state.nodes, samples);
    console.log(`[MockBackend] Advanced by ${samples} samples → masterPos=${state.masterPos}`);
}

// Test scenario loaders
export function loadScenario(name) {
    console.log('[MockBackend] Loading scenario:', name);
    state.nextId = 1;

    // Reset transport simulation on scenario load
    transport.running = false;
    transport.speed = 1.0;
    recView.active = false;
    state.islandEpoch = 0;
    // Loading a scenario is a fresh session — undo history does not carry
    // across it (test isolation + mirrors constructing a fresh engine).
    undoStack = [];
    redoStack = [];

    switch (name) {
        case 'empty':
            state.nodes = [];
            break;

        case 'single-clip':
            state.nodes = [{
                id: 'clip-1',
                name: 'Recorded Clip',
                type: 'clip',
                x: 0,
                y: 0,
                w: 400,
                h: 100,
                duration: 2.0,
                isRecording: false,
                isPlaying: false,
                isMuted: false,
                isSoloed: false,
                effectiveQuantum: 2.0,
                inputChannel: 0
            }];
            state.nextId = 2;
            break;

        case 'stack-with-clips':
            state.nodes = [{
                id: 'stack-1',
                name: 'Main Stack',
                type: 'stack',
                x: 100,
                y: 100,
                w: 600,
                h: 400,
                isExpanded: true,
                effectiveQuantum: 2.0,
                nodes: [
                    {
                        id: 'clip-1',
                        name: 'Clip A',
                        type: 'clip',
                        x: 0,
                        y: 0,
                        w: 400,
                        h: 100,
                        duration: 2.0,
                        loopStart: 0,  // Match native C++ backend defaults
                        loopEnd: 0,    // Match native C++ backend defaults (triggers bug!)
                        isRecording: false,
                        isPlaying: false,
                        isMuted: false,
                        isSoloed: false,
                        effectiveQuantum: 2.0,
                        inputChannel: 0
                    },
                    {
                        id: 'clip-2',
                        name: 'Clip B',
                        type: 'clip',
                        x: 0,
                        y: 120,
                        w: 600,
                        h: 100,
                        duration: 3.0,
                        loopStart: 0,
                        loopEnd: 0,
                        isRecording: false,
                        isPlaying: false,
                        isMuted: false,
                        isSoloed: false,
                        effectiveQuantum: 2.0,
                        inputChannel: 0
                    },
                    {
                        id: 'clip-3',
                        name: 'Clip C',
                        type: 'clip',
                        x: 0,
                        y: 240,
                        w: 200,
                        h: 100,
                        duration: 1.0,
                        loopStart: 0,
                        loopEnd: 0,
                        isRecording: false,
                        isPlaying: false,
                        isMuted: false,
                        isSoloed: false,
                        effectiveQuantum: 2.0,
                        inputChannel: 0
                    }
                ]
            }];
            state.nextId = 4;
            break;

        case 'multiple-stacks':
            state.nodes = [
                {
                    id: 'stack-1',
                    name: 'Stack 1',
                    type: 'stack',
                    x: 50,
                    y: 50,
                    w: 500,
                    h: 300,
                    isExpanded: true,
                    effectiveQuantum: 2.0,
                    nodes: [
                        {
                            id: 'clip-1',
                            name: 'Beat',
                            type: 'clip',
                            x: 0,
                            y: 0,
                            w: 400,
                            h: 100,
                            duration: 2.0,
                            effectiveQuantum: 2.0
                        }
                    ]
                },
                {
                    id: 'stack-2',
                    name: 'Stack 2',
                    type: 'stack',
                    x: 600,
                    y: 50,
                    w: 500,
                    h: 300,
                    isExpanded: true,
                    effectiveQuantum: 3.0,
                    nodes: [
                        {
                            id: 'clip-2',
                            name: 'Melody',
                            type: 'clip',
                            x: 0,
                            y: 0,
                            w: 600,
                            h: 100,
                            duration: 3.0,
                            effectiveQuantum: 3.0
                        }
                    ]
                }
            ];
            state.nextId = 3;
            break;

        // ========================================
        // Recording.md Example Scenarios
        // ========================================

        // Example 1: 1Q + 4Q (LCM = 4Q)
        // Expected: Clip 1 (1Q) should have 3 ghosts, Clip 2 (4Q) should have 0 ghosts
        case 'example-1q-4q':
            state.isPlaying = true;
            state.masterPos = 22050;  // ~0.5Q into the timeline
            state.nodes = [{
                id: 'stack-1',
                name: 'LCM Test Stack',
                type: 'stack',
                x: 100,
                y: 100,
                w: 900,
                h: 350,
                isExpanded: true,
                effectiveQuantum: 44100,  // 1Q = 44100 samples
                loopStart: 0,             // Stack-level loop points (for collapsed mode)
                loopEnd: 176400,          // Full LCM duration (4Q)
                nodes: [
                    {
                        id: 'clip-1q',
                        name: 'Clip 1Q',
                        type: 'clip',
                        x: 0,
                        y: 0,
                        w: 200,
                        h: 100,
                        duration: 44100,      // 1Q
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0.5,  // 50% through the clip
                        loopStart: 0,
                        loopEnd: 44100
                    },
                    {
                        id: 'clip-4q',
                        name: 'Clip 4Q',
                        type: 'clip',
                        x: 0,
                        y: 120,
                        w: 800,
                        h: 100,
                        duration: 176400,     // 4Q
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0.125,  // 12.5% through the clip (= 0.5Q / 4Q)
                        loopStart: 0,
                        loopEnd: 176400
                    }
                ]
            }];
            state.nextId = 3;
            break;

        // Example 2: 1Q + 4Q + 3Q (LCM = 12Q)
        // Expected: Clip 1 has 11 ghosts, Clip 2 has 2 ghosts, Clip 3 has 3 ghosts
        case 'example-1q-4q-3q':
            state.nodes = [{
                id: 'stack-1',
                name: 'Polyrhythm Stack',
                type: 'stack',
                x: 100,
                y: 100,
                w: 2500,
                h: 450,
                isExpanded: true,
                effectiveQuantum: 44100,
                nodes: [
                    {
                        id: 'clip-1q',
                        name: 'Clip 1Q',
                        type: 'clip',
                        x: 0,
                        y: 0,
                        w: 200,
                        h: 100,
                        duration: 44100,
                        effectiveQuantum: 44100,
                        isRecording: false
                    },
                    {
                        id: 'clip-4q',
                        name: 'Clip 4Q',
                        type: 'clip',
                        x: 0,
                        y: 120,
                        w: 800,
                        h: 100,
                        duration: 176400,
                        effectiveQuantum: 44100,
                        isRecording: false
                    },
                    {
                        id: 'clip-3q',
                        name: 'Clip 3Q',
                        type: 'clip',
                        x: 0,
                        y: 240,
                        w: 600,
                        h: 100,
                        duration: 132300,
                        effectiveQuantum: 44100,
                        isRecording: false
                    }
                ]
            }];
            state.nextId = 4;
            break;

        case 'clip-3-anchor-at-2q':
            // ========================================
            // Clip 3 Anchor Bug Test Scenario
            // ========================================
            // Scenario: Clip 1 = 1Q, Clip 2 = 4Q, Clip 3 = 1Q at 2Q
            // Expected: Clip 3 x=400 (2Q slot), ghosts wrap at 0Q→2Q
            state.isPlaying = true;
            state.masterPos = 88200;  // 2Q in samples
            state.nodes = [{
                id: 'stack-1',
                name: 'Anchor Bug Test Stack',
                type: 'stack',
                x: 100,
                y: 100,
                w: 900,
                h: 450,
                isExpanded: true,
                effectiveQuantum: 44100,  // 1Q = 44100 samples
                nodes: [
                    {
                        id: 'clip-1',
                        name: 'Clip 1Q',
                        type: 'clip',
                        x: 0,
                        y: 0,
                        w: 200,
                        h: 100,
                        duration: 44100,      // 1Q
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true,
                        loopStart: 0,
                        loopEnd: 44100,
                        origin: 0
                    },
                    {
                        id: 'clip-2',
                        name: 'Clip 4Q',
                        type: 'clip',
                        x: 0,
                        y: 120,
                        w: 800,
                        h: 100,
                        duration: 176400,     // 4Q
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true,
                        loopStart: 0,
                        loopEnd: 176400,
                        origin: 0
                    },
                    {
                        id: 'clip-3',
                        name: 'Clip 1Q@2Q',
                        type: 'clip',
                        x: 400,
                        y: 240,
                        w: 200,
                        h: 100,
                        duration: 44100,      // 1Q
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true,
                        loopStart: 0,
                        loopEnd: 44100,
                        origin: 88200         // KEY: started at 2Q (slot 2 derives from this)
                    }
                ]
            }];
            state.nextId = 4;
            break;

        case 'nested-stacks':
            // ========================================
            // Nested Stacks Scenario
            // ========================================
            state.isPlaying = true;
            state.masterPos = 22050;
            state.nodes = [{
                id: 'parent-stack',
                name: 'Parent Stack',
                type: 'stack',
                x: 100,
                y: 100,
                w: 900,
                h: 500,
                isExpanded: true,
                effectiveQuantum: 44100,
                nodes: [
                    {
                        id: 'clip-1',
                        name: 'Top Level Clip',
                        type: 'clip',
                        x: 0,
                        y: 0,
                        w: 200,
                        h: 100,
                        duration: 44100,
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true
                    },
                    {
                        id: 'child-stack',
                        name: 'Nested Stack',
                        type: 'stack',
                        x: 0,
                        y: 120,
                        w: 600,
                        h: 250,
                        isExpanded: true,
                        effectiveQuantum: 44100,
                        nodes: [
                            {
                                id: 'nested-clip-1',
                                name: 'Nested Clip A',
                                type: 'clip',
                                x: 0,
                                y: 0,
                                y: 0,
                                w: 400,
                                h: 100,
                                duration: 88200,
                                effectiveQuantum: 44100,
                                isRecording: false,
                                isPlaying: true
                            },
                            {
                                id: 'nested-clip-2',
                                name: 'Nested Clip B',
                                type: 'clip',
                                x: 0,
                                y: 120,
                                w: 200,
                                h: 100,
                                duration: 44100,
                                effectiveQuantum: 44100,
                                isRecording: false,
                                isPlaying: true
                            }
                        ]
                    }
                ]
            }];
            state.nextId = 10;
            break;

        // ========================================
        // Loop Region Bug Test Scenario
        // ========================================
        // Reproduces bug: 1Q + 3Q clips, collapse, modify loop to 0-2Q
        // Bug: Loop alternates between 1Q and 2Q instead of consistent 2Q
        case '1q-3q-loop-bug':
            state.isPlaying = true;
            state.masterPos = 0;
            state.nodes = [{
                id: 'stack-1',
                name: 'Loop Bug Test Stack',
                type: 'stack',
                x: 100,
                y: 100,
                w: 700,
                h: 350,
                isExpanded: true,  // User will collapse in test
                effectiveQuantum: 44100,  // 1Q = 44100 samples
                loopStart: 0,
                loopEnd: 132300,  // Full LCM = 3Q (44100 * 3)
                nodes: [
                    {
                        id: 'clip-1q',
                        name: 'Clip 1Q',
                        type: 'clip',
                        x: 0,
                        y: 0,
                        w: 200,
                        h: 100,
                        duration: 44100,      // 1Q
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0,
                        loopStart: 0,
                        loopEnd: 44100
                    },
                    {
                        id: 'clip-3q',
                        name: 'Clip 3Q',
                        type: 'clip',
                        x: 0,
                        y: 120,
                        w: 600,
                        h: 100,
                        duration: 132300,     // 3Q
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0,
                        loopStart: 0,
                        loopEnd: 132300
                    }
                ]
            }];
            state.nextId = 3;
            break;

        case 'recording-1q-plus-growing':
            // Recording Scenario (for ghost testing)
            // ========================================
            // Simulates: Clip 1 = 1Q committed, Clip 2 = actively recording at ~2.5Q
            state.isPlaying = true;
            state.masterPos = 110250;  // 2.5Q in samples
            state.nodes = [{
                id: 'stack-1',
                name: 'Recording Test Stack',
                type: 'stack',
                x: 100,
                y: 100,
                w: 600,
                h: 350,
                isExpanded: true,
                effectiveQuantum: 44100,
                nodes: [
                    {
                        id: 'clip-1',
                        name: 'New Clip',
                        type: 'clip',
                        x: 0, y: 0, w: 200, h: 100,
                        duration: 44100,  // 1Q
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true,
                        playhead: 0.5,
                        loopStart: 0, loopEnd: 44100
                    },
                    {
                        id: 'clip-2',
                        name: 'New Clip',
                        type: 'clip',
                        x: 0, y: 120, w: 500, h: 100,
                        duration: 110250,  // 2.5Q - recording
                        effectiveQuantum: 44100,
                        isRecording: true,
                        isPlaying: false,
                        currentPeak: 0.002,
                        loopStart: 0, loopEnd: 110250
                    }
                ]
            }];
            state.nextId = 3;
            break;

        default:
            console.warn('[MockBackend] Unknown scenario:', name);
    }
}

// Initialize with the launch-ritual boot (ProjectManager parity,
// docs/projects.md): the app never boots empty — one ready track.
// Tests reset with loadScenario(...) as ever.
loadScenario('empty');
{
    const bootId = createNode('clip', '');
    const boot = findNode(bootId) ||
        (state.nodes[0] && state.nodes[0].type === 'clip' ? state.nodes[0] : null);
    if (boot) boot.name = 'Track 1';
    undoStack = [];  // boot setup is not a user action
}
