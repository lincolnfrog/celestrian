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

import { snapCommittedDuration, launchPointFor } from './timeline_model.js';

// In-memory state
let state = {
    isPlaying: false,
    nodes: [],
    nextId: 1
};

/**
 * Handler table for every protocol method. Keys must match
 * protocol.js BRIDGE_METHOD_NAMES exactly (see protocol_contract.test.mjs).
 */
export const handlers = {
    ping: () => 'pong',
    togglePlayback: () => togglePlayback(),
    startRecordingInNode: (id) => startRecordingInNode(id),
    stopRecordingInNode: (id) => stopRecordingInNode(id),
    getGraphState: () => getState(),
    getWaveform: (id, numPeaks) => getWaveform(id, numPeaks),
    toggleStackExpand: (id) => toggleStackExpand(id),
    createNode: (type, parentId) => createNode(type, parentId),
    renameNode: (id, name) => renameNode(id, name),
    reorderNode: (id, parentId, index) => reorderNode(id, parentId, index),
    setNodePosition: (id, x, y) => setNodePosition(id, x, y),
    combineNodes: (draggedId, targetId) => combineNodes(draggedId, targetId),
    getInputList: () => getInputList(),
    setNodeInput: (id, channelIndex) => setNodeInput(id, channelIndex),
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

// Mirrors AudioEngine::togglePlayback (transport resets to 0 on stop).
function togglePlayback() {
    state.isPlaying = !state.isPlaying;
    transport.running = state.isPlaying;
    if (!state.isPlaying) {
        state.masterPos = 0;
    }
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
 * The effective quantum for the mock graph, mirroring the C++ derivation
 * (minimum positive committed clip duration), with the scenario-declared
 * `effectiveQuantum` as fallback.
 */
function effectiveQuantumForState() {
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

function setLoopPoints(id, loopStart, loopEnd) {
    const node = findNode(id);
    if (node) {
        node.loopStart = loopStart;
        node.loopEnd = loopEnd;
        // Window phase is derived from the clock (time_maps.md) —
        // nothing to reset when the region changes.
        console.log('[MockBackend] Set loop points:', id, '→', loopStart, '-', loopEnd);
    }
}

function toggleLoopWindow(id) {
    const node = findNode(id);
    if (node && node.type === 'stack') {
        node.loopBypassed = !node.loopBypassed;
        console.log('[MockBackend] Loop window', id, '→',
            node.loopBypassed ? 'BYPASSED' : 'ACTIVE');
    }
}

function startRecordingInNode(id) {
    const node = findNode(id);
    if (!node) return;

    console.log('[MockBackend] startRecordingInNode', id);

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

    node.isRecording = true;
    node.recordingStartPos = state.masterPos || 0;
}

function stopRecordingInNode(id) {
    const node = findNode(id);
    if (!node || !node.isRecording) return;

    console.log('[MockBackend] stopRecordingInNode', id);

    // Compute Q BEFORE committing this node, so the stopping clip cannot
    // define its own quantum (mirrors C++ commit order).
    const Q = effectiveQuantumForState();

    node.isRecording = false;

    const currentPos = state.masterPos || 0;
    const rawDuration = currentPos - (node.recordingStartPos || 0);

    // Hysteresis snap — same math as the C++ engine (timeline_model.js).
    // First clip (no Q established) commits at its raw duration.
    let duration = rawDuration;
    let loopEnd = rawDuration;
    if (Q > 0) {
        const snap = snapCommittedDuration(rawDuration, Q);
        duration = snap.duration;
        loopEnd = snap.loopEnd;
    }

    node.duration = duration;
    node.isPlaying = true;
    node.loopStart = 0;
    node.loopEnd = loopEnd;

    // Origin is THE canonical timing fact (docs/kernel.md): the cycle
    // moment content[0] belongs to. Launch point is its projection,
    // kept for UI compatibility (Audio Memory Principle, recording.md).
    node.origin = node.recordingStartPos || 0;
    node.launchPoint = launchPointFor(node.origin, duration);

    console.log(`[MockBackend] Recorded ${id}: Dur=${duration} (Raw=${rawDuration}, Q=${Q})`);
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
    const targetIndex = targetList.findIndex(n => n.id === targetId);

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

    // Insert at target's original position
    if (targetIndex >= 0) {
        targetList.splice(targetIndex, 0, newStack);
    } else {
        targetList.push(newStack);
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
        if (node.type === 'stack') {
            const updatedNode = {
                ...node,
                waveform: generateStackWaveform(node),
                nodes: node.nodes ? enrichNodes(node.nodes) : []
            };

            // Loop window state (time_maps.md): active iff valid and not
            // bypassed — independent of expansion. Window phase mirrors
            // the engine: (masterPos − epoch) mod len (mock epoch = 0).
            const bypassed = !!node.loopBypassed;
            const windowActive = !bypassed && node.loopEnd > node.loopStart;
            updatedNode.loopBypassed = bypassed;
            updatedNode.windowActive = windowActive;
            if (windowActive) {
                const loopLen = node.loopEnd - node.loopStart;
                updatedNode.playhead = ((state.masterPos || 0) % loopLen) / loopLen;
            }

            return updatedNode;
        }
        return node;
    });
}

// Export state getter for polling
export function getState() {
    // Auto-advance transport if running (simulates real-time playback/recording)
    advanceTransport();

    return {
        isPlaying: state.isPlaying,
        masterPos: state.masterPos || 0,
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

// Grow recording clips by a given sample count
function growRecordingClips(nodes, samples) {
    (nodes || []).forEach(node => {
        if (node.isRecording) {
            node.duration = (node.duration || 0) + samples;
            // Simulate live peak data (oscillating value)
            node.currentPeak = 0.3 + Math.random() * 0.4;
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
                        anchorPhase: 0
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
                        anchorPhase: 0
                    },
                    {
                        id: 'clip-3',
                        name: 'Clip 1Q@2Q',
                        type: 'clip',
                        x: 400,               // KEY: anchored at 2Q slot (2 * 200px)
                        y: 240,
                        w: 200,
                        h: 100,
                        duration: 44100,      // 1Q
                        effectiveQuantum: 44100,
                        isRecording: false,
                        isPlaying: true,
                        loopStart: 0,
                        loopEnd: 44100,
                        anchorPhase: 88200    // Started at 2Q
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

// Initialize with empty state
loadScenario('empty');
