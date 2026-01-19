/**
 * Mock Backend for Celestrian UI Testing
 * 
 * Simulates the JUCE native bridge without requiring C++ backend.
 * Maintains audio node state in memory and provides realistic responses.
 */

// In-memory state
let state = {
    isPlaying: false,
    nodes: [],
    nextId: 1
};

// Polyfill for callNative - simulates the native C++ bridge
export async function callNative(method, ...args) {
    console.log(`[MockBackend] callNative: ${method}`, args);

    switch (method) {
        case 'createNode':
            return createNode(...args);
        case 'deleteNode':
            return deleteNode(...args);
        case 'renameNode':
            return renameNode(...args);
        case 'reorderNode':
            return reorderNode(...args);
        case 'setNodePosition':
            return setNodePosition(...args);
        case 'togglePlay':
            return togglePlay(...args);
        case 'toggleSolo':
            return toggleSolo(...args);
        case 'toggleMute':
            return toggleMute(...args);
        case 'toggleStackExpand':
            return toggleStackExpand(...args);
        case 'getInputList':
            return getInputList();
        case 'setNodeInput':
            return setNodeInput(...args);
        case 'combineNodes':
            return combineNodes(...args);
        default:
            console.warn(`[MockBackend] Unknown method: ${method}`);
            return null;
    }
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

// createNode(type, x, y, parentId)
function createNode(type, x = -1, y = -1, parentId = null) {
    const node = {
        id: generateId(),
        name: type === 'clip' ? 'New Clip' : 'New Stack',
        type: type,
        x: x >= 0 ? x : 0,
        y: y >= 0 ? y : (state.nodes.length * 120),
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

function deleteNode(id) {
    removeNodeFromParent(id);
    console.log('[MockBackend] Deleted node:', id);
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
    return ['Built-in Microphone', 'External Audio'];
}

function setNodeInput(id, channelIndex) {
    const node = findNode(id);
    if (node) {
        node.inputChannel = channelIndex;
        console.log('[MockBackend] Set input:', id, '→ channel', channelIndex);
    }
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

// Recursively add waveform data to stacks
function addWaveformToNodes(nodes) {
    return nodes.map(node => {
        if (node.type === 'stack') {
            const updatedNode = {
                ...node,
                waveform: generateStackWaveform(node),
                nodes: node.nodes ? addWaveformToNodes(node.nodes) : []
            };
            return updatedNode;
        }
        return node;
    });
}

// Export state getter for polling
export function getState() {
    return {
        isPlaying: state.isPlaying,
        masterPos: state.masterPos || 0,
        nodes: addWaveformToNodes(state.nodes)
    };
}

// Test scenario loaders
export function loadScenario(name) {
    console.log('[MockBackend] Loading scenario:', name);
    state.nextId = 1;

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
