// Detect environment: Use mock backend if window.celestrian exists, otherwise JUCE bridge
let callNative, log, getState;

const useMock = typeof window !== 'undefined' && (
    (window.celestrian) ||
    (new URLSearchParams(window.location.search).get('mock') === 'true')
);

if (useMock) {
    if (window.celestrian) {
        // Test harness environment - use provided backend
        ({ callNative, log, getState } = window.celestrian);
        console.log('[App] Using Harness backend');
    } else {
        // Browser/Playwright Manual Mock Mode
        const mockBackend = await import('./mock_backend.js');
        callNative = mockBackend.callNative;
        log = mockBackend.log;
        getState = mockBackend.getState;

        // Expose mock helpers for Playwright
        window.loadScenario = mockBackend.loadScenario;
        window.setMasterPos = mockBackend.setMasterPos;
        window.setIsPlaying = mockBackend.setIsPlaying;
        window.callNative = mockBackend.callNative;
        // Transport simulation
        window.startTransport = mockBackend.startTransport;
        window.pauseTransport = mockBackend.pauseTransport;
        window.advanceBy = mockBackend.advanceBy;

        console.log('[App] Using Loaded Mock backend');
    }
} else {
    // Production environment - use JUCE bridge
    const bridge = await import('./bridge.js');
    ({ callNative, log } = bridge);
    getState = null; // Not used in production (polling uses callNative('getGraphState'))
    console.log('[App] Using JUCE bridge');
}

import { drawWaveform } from './canvas_renderer.js';
import { Viewport } from './viewport.js';
import { calculateStackLCM, computeEffectiveQuantum, stackPlayheadPercent } from './timeline_model.js';
import { isDropAnimating, isAnyDragActive } from './drag_drop.js';
import { renderGhosts } from './ghost_renderer.js';
import { generateCompositeWaveform } from './composite_waveform.js';
import { createNodeElement } from './node_element.js';
import { createStackWrapper } from './stack_element.js';
import { updateAllClips } from './clip_updater.js';

const nodeLayer = document.getElementById('node-layer');
const creationUI = document.getElementById('creation-ui');
const playBtn = document.getElementById('play-btn');

const livePeaks = new Map();
const compositeWaveformCache = new Map();  // stackId -> { key, peaks }
let viewport;
let availableInputs = [];

// Global API Hooks
window.createNode = (type, parent) => {
    callNative('createNode', type, parent || '');
};

window.togglePlayback = () => callNative('togglePlayback');
window.toggleRecord = (id) => toggleRecord(id);

// DOM Content Timeout Monitor (Moved from index.html)
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            const status = document.getElementById('loading-status');
            if (status && status.innerText === "Loading modules...") {
                status.innerHTML = '<span style="color:#ef4444">Module load timeout. Check bridge/CORS.</span>';
            }
        }, 5000);
    });
}

export function initApp() {
    viewport = new Viewport(document.getElementById('viewport'), document.getElementById('canvas-root'));

    // Global Keyboard Listeners
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT') return;

        if (e.code === 'Space') {
            e.preventDefault();
            // If any clip is recording, spacebar stops recording (not playback)
            const recordingNodes = document.querySelectorAll('.node-btn-record.active');
            if (recordingNodes.length > 0) {
                recordingNodes.forEach(btn => {
                    const nodeDiv = btn.closest('.node');
                    if (nodeDiv) toggleRecord(nodeDiv.id);
                });
            } else {
                togglePlayback();
            }
        }
        if (e.key === 'Escape') exitBox();

        const step = 25 / viewport.scale;
        if (e.key === 'w') viewport.pan(0, step);
        if (e.key === 's') viewport.pan(0, -step);
        if (e.key === 'a') viewport.pan(step, 0);
        if (e.key === 'd') viewport.pan(-step, 0);
        if (e.key === 'q') viewport.zoom(1.1);
        if (e.key === 'e') viewport.zoom(0.9);
    });

    // Global click listener to close menus
    window.addEventListener('click', (e) => {
        const menu = document.getElementById('creation-menu');
        const ui = document.getElementById('creation-ui');
        if (menu && ui && !ui.contains(e.target)) {
            menu.classList.remove('active');
        }
    });

    // Transport buttons click
    const backBtn = document.getElementById('back-btn');
    if (backBtn) {
        backBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            exitBox();
        });
    }

    if (playBtn) {
        playBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            togglePlayback();
        });
    }

    // State dump button for debugging
    const dumpBtn = document.getElementById('dump-state-btn');
    if (dumpBtn) {
        dumpBtn.addEventListener('click', async () => {
            try {
                const state = await callNative('getGraphState');
                const stateJson = JSON.stringify(state, null, 2);
                // Write to file via bridge
                await callNative('dumpStateToFile', stateJson);
                log('State dumped to celestrian_state.json');
            } catch (err) {
                log('Error dumping state: ' + err.message);
            }
        });
    }

    // Latency calibration (docs/performance.md §7): plays a click, listens
    // for it on the input, and the measured round trip becomes the recording
    // alignment compensation.
    const calibrateBtn = document.getElementById('calibrate-btn');
    const calibrationStatus = document.getElementById('calibration-status');
    if (calibrateBtn) {
        calibrateBtn.addEventListener('click', async () => {
            try {
                calibrateBtn.disabled = true;
                calibrationStatus.textContent = 'Calibrating… (keep quiet, click incoming)';
                await callNative('startLatencyCalibration');

                // Poll until the 2s capture window completes
                let result = null;
                for (let i = 0; i < 40; i++) {
                    await new Promise(r => setTimeout(r, 250));
                    result = await callNative('getLatencyCalibration');
                    if (result && result.phase !== 'capturing') break;
                }

                if (result && result.calibrated) {
                    calibrationStatus.textContent =
                        `Latency: ${result.roundTripSamples} samples (${result.roundTripMs.toFixed(1)} ms) — now used for recording alignment`;
                    log(`Latency calibrated: ${result.roundTripSamples} samples`);
                } else {
                    calibrationStatus.textContent =
                        'Calibration failed — no loopback signal. Route output to input (cable or speaker→mic) and retry.';
                    log('Latency calibration failed');
                }
            } catch (err) {
                calibrationStatus.textContent = 'Calibration error: ' + err.message;
            } finally {
                calibrateBtn.disabled = false;
            }
        });
    }

    startPolling();
    window.addEventListener('bridge-ready', () => {
        fetchInputs();
    });
}

async function fetchInputs() {
    try {
        const result = await callNative('getInputList');
        if (result && Array.isArray(result.inputs)) {
            availableInputs = result.inputs;
        }
    } catch (err) {
        console.error("fetchInputs error:", err);
    }
}

async function startPolling() {
    const isMock = getState !== null;
    console.log(`Starting state polling loop (${isMock ? 'MOCK BACKEND' : 'JUCE BRIDGE'})...`);

    while (true) {
        try {
            // Use appropriate backend method
            const state = isMock ? getState() : await callNative('getGraphState');
            if (state) syncUI(state);
        } catch (err) {
            console.error("Polling error:", err);
        }
        await new Promise(r => setTimeout(r, 50));
    }
}

function syncUI(state) {
    // Playback state
    const isPlaying = state.isPlaying;
    playBtn.classList.toggle('playing', isPlaying);
    playBtn.innerText = isPlaying ? "STOP" : "PLAY";

    const nodes = state.nodes || [];
    const newNodeIds = nodes.map(n => n.id);
    const uiNodeIds = Array.from(nodeLayer.children).map(c => c.id);

    // Effective quantum for width scaling (minimum of all reported quantums,
    // including clips inside stacks) — timeline_model.js
    const effectiveQ = computeEffectiveQuantum(nodes);
    const baseWidth = 200; // 1 quantum = 200px

    let maxY = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    // UI = Data: C++ sets x_pos based on anchor_phase
    // JS displays node.x directly with no transformation
    const VISUAL_OFFSET = 120; // Shift for UI rendering

    // Separate stacks from clips for different rendering
    const stacks = nodes.filter(n => n.type === 'stack');
    const clips = nodes.filter(n => n.type === 'clip');

    // Render stacks first (they contain clips)
    stacks.forEach(stack => {
        let stackWrapper = document.getElementById(`stack-wrapper-${stack.id}`);
        if (!stackWrapper) {
            stackWrapper = createStackWrapper(stack, _api);
            nodeLayer.appendChild(stackWrapper);
        }

        // Update stack wrapper position and state
        stackWrapper.style.left = `${stack.x + VISUAL_OFFSET}px`;
        stackWrapper.style.top = `${stack.y}px`;
        stackWrapper.classList.toggle('stack-collapsed', !stack.isExpanded);

        // Render stack header waveform (ALWAYS visible in both expanded and collapsed states)
        // When collapsed: shows full opacity composite waveform (Loop-on-Collapse model)
        // When expanded: shows faded (~50% opacity) composite waveform
        {
            const headerWaveform = stackWrapper.querySelector('.stack-header-waveform');
            const canvas = stackWrapper.querySelector('.stack-waveform-canvas');
            const playhead = stackWrapper.querySelector('.stack-playhead');

            if (headerWaveform && canvas) {
                // LCM of all children = full stack timeline width.
                // Same calculation the ghost renderer uses (timeline_model.js),
                // so header width and ghost extent can never disagree.
                const stackLCM = calculateStackLCM(stack.nodes, effectiveQ);

                // Use calculated LCM for width, not just effectiveQuantum
                const stackDuration = Math.max(stackLCM, stack.effectiveQuantum || effectiveQ);
                const quantumWidth = effectiveQ > 1
                    ? (stackDuration / effectiveQ) * baseWidth
                    : baseWidth;

                // Set header container width to match LCM (covers all child clip loops)
                headerWaveform.style.width = `${Math.max(200, quantumWidth)}px`;

                canvas.width = Math.max(200, quantumWidth);
                canvas.height = headerWaveform.offsetHeight || 50;

                // IMPORTANT: Store computed LCM values on wrapper for loop handle access
                // The loop handle drag code needs these for proper quantum snapping
                stackWrapper._latestStack = {
                    ...stack,
                    lcmDuration: stackDuration,          // The LCM of all children
                    computedQuantum: effectiveQ,         // The global quantum for snapping
                    loopStart: stack.loopStart || 0,
                    loopEnd: stack.loopEnd || stackDuration
                };

                // Get stack's composite waveform (aggregated from children)
                const waveformData = generateCompositeWaveform({
                    stack, stackDuration, effectiveQ,
                    canvasWidth: canvas.width,
                    livePeaks, cache: compositeWaveformCache
                });

                // Always draw (empty waveform shows placeholder line)
                drawWaveform(canvas, waveformData, null, true /* isComposite */);

                // Update playhead position based on masterPos relative to stack loop region
                // When collapsed, the stack loops within loopStart to loopEnd
                // (its own internal transport) — math in timeline_model.js.
                if (playhead && state.isPlaying) {
                    const playheadPct = stackPlayheadPercent({
                        masterPos: state.masterPos || 0,
                        internalTransport: stack.internalTransport,
                        isExpanded: stack.isExpanded,
                        loopStart: stack.loopStart || 0,
                        loopEnd: stack.loopEnd || stackDuration,
                        stackDuration
                    });

                    playhead.style.left = `${playheadPct * 100}%`;
                    playhead.style.display = 'block';
                } else if (playhead) {
                    playhead.style.display = 'none';
                }

                // Position stack loop handles, dim layers, and launch marker
                // IMPORTANT: Use stackDuration (LCM) for positioning, NOT effectiveQuantum
                // effectiveQuantum = smallest child quantum (for snapping)
                // stackDuration = LCM of all children (actual timeline length)
                const stackDur = stackDuration; // Use LCM, not effectiveQuantum!
                let stackLoopStart = stack.loopStart || 0;
                let stackLoopEnd = stack.loopEnd || stackDur;

                // Fallback: If loop points are not set or invalid, use full duration
                if (stackLoopEnd <= stackLoopStart) {
                    stackLoopStart = 0;
                    stackLoopEnd = stackDur;
                }

                // Calculate percentages
                const stackStartPct = isFinite(stackLoopStart / stackDur) ? (stackLoopStart / stackDur) * 100 : 0;
                const stackEndPct = isFinite(stackLoopEnd / stackDur) ? (stackLoopEnd / stackDur) * 100 : 100;

                // Position loop handles
                const hStart = headerWaveform.querySelector('.loop-handle-start');
                const hEnd = headerWaveform.querySelector('.loop-handle-end');
                const dimLeft = headerWaveform.querySelector('.dim-left');
                const dimRight = headerWaveform.querySelector('.dim-right');
                const launchMarker = headerWaveform.querySelector('.launch-marker');

                if (hStart && hEnd && dimLeft && dimRight) {
                    log(`[SyncUI] Stack ${stack.id}: loopEnd=${stack.loopEnd}, stackDur=${stackDur}, loopStart=${stackLoopStart}, computedEnd=${stackLoopEnd}, Pct=${stackEndPct}%`);
                    hStart.style.left = `${stackStartPct}%`;
                    hEnd.style.left = `${stackEndPct}%`;
                    dimLeft.style.width = `${stackStartPct}%`;
                    dimRight.style.left = `${stackEndPct}%`;
                    dimRight.style.width = `${100 - stackEndPct}%`;
                }

                // Position launch marker
                if (launchMarker && stackDur > 0) {
                    const launchPct = ((stack.launchPoint || 0) / stackDur) * 100;
                    launchMarker.style.left = `${launchPct}%`;
                    // Only show if stack has non-zero anchor
                    launchMarker.style.display = (stack.anchorPhase > 0) ? 'block' : 'none';
                }
            }
        }

        // Render stack's children
        const childContainer = stackWrapper.querySelector('.stack-children');
        const stackChildren = stack.nodes || [];

        if (stack.isExpanded && stackChildren.length > 0) {
            // Show all children when expanded
            // Track which children exist
            const childIds = new Set(stackChildren.map(c => c.id));

            // Remove children that no longer exist (both clips and nested stacks)
            childContainer.querySelectorAll('.node, .stack-wrapper').forEach(childDiv => {
                const childId = childDiv.id.replace('stack-wrapper-', '');
                if (!childIds.has(childDiv.id) && !childIds.has(childId)) {
                    childDiv.remove();
                }
            });

            // Add new children - handle both clips and nested stacks
            stackChildren.forEach((child) => {
                if (child.type === 'stack') {
                    // Nested stack: create or update stack wrapper
                    let nestedWrapper = document.getElementById(`stack-wrapper-${child.id}`);
                    if (!nestedWrapper) {
                        nestedWrapper = createStackWrapper(child, _api);
                        nestedWrapper.classList.add('nested-stack');
                        childContainer.appendChild(nestedWrapper);
                    }
                    // Guard against null nestedWrapper
                    if (!nestedWrapper) {
                        return;
                    }
                    // Update nested stack state
                    nestedWrapper.classList.toggle('stack-collapsed', !child.isExpanded);
                    if (!isAnyDragActive() && !isDropAnimating()) {
                        nestedWrapper.style.position = 'relative';
                        nestedWrapper.style.left = '0';
                        nestedWrapper.style.top = '0';
                        nestedWrapper.style.marginBottom = '12px';
                    }
                    // Recursively render nested stack's children
                    const nestedChildContainer = nestedWrapper.querySelector('.stack-children');
                    const nestedChildren = child.nodes || [];
                    if (child.isExpanded && nestedChildren.length > 0) {
                        nestedChildren.forEach((nestedChild) => {
                            let nestedDiv = document.getElementById(nestedChild.id);
                            if (!nestedDiv && nestedChild.type === 'clip') {
                                nestedDiv = createNodeElement(nestedChild, _api);
                                nestedChildContainer.appendChild(nestedDiv);
                            }
                        });
                    } else if (!child.isExpanded) {
                        nestedChildContainer.innerHTML = '';
                    }
                } else {
                    // Regular clip
                    let childDiv = document.getElementById(child.id);
                    if (!childDiv) {
                        childDiv = createNodeElement(child, _api);
                        childContainer.appendChild(childDiv);
                    }
                    // Skip style updates during drag/drop to preserve slide transforms
                    if (!isAnyDragActive() && !isDropAnimating()) {
                        childDiv.style.position = 'relative';
                        childDiv.style.left = '0';
                        childDiv.style.top = '0';
                        childDiv.style.marginBottom = '12px';
                    }
                }
            });
        } else if (!stack.isExpanded) {
            // When collapsed, clear children only if they exist
            if (childContainer.children.length > 0) {
                childContainer.innerHTML = '';
            }
        }
    });

    // Recursive helper to collect all clips from a node list (including nested stacks)
    function collectAllClips(nodeList, parentStack = null) {
        const result = [];
        (nodeList || []).forEach(n => {
            if (n.type === 'clip') {
                result.push({ ...n, parentStack });
            } else if (n.type === 'stack' && n.nodes) {
                // Recursively collect from nested stacks
                result.push(...collectAllClips(n.nodes, n));
            }
        });
        return result;
    }

    // Collect all clips for update (both top-level and those inside stacks at any depth)
    const allClips = [...clips];
    stacks.forEach(stack => {
        if (stack.nodes) {
            allClips.push(...collectAllClips(stack.nodes, stack));
        }
    });

    // Update all clips (top-level and stack children)
    const clipBounds = updateAllClips({
        allClips, clips, stacks, effectiveQ, baseWidth,
        VISUAL_OFFSET, state, livePeaks, availableInputs,
        nodeLayer, log, fetchWaveform, createNodeElement, api: _api
    });
    maxX = Math.max(maxX, clipBounds.maxX);
    maxY = Math.max(maxY, clipBounds.maxY);
    minX = Math.min(minX, clipBounds.minX);

    // Ghost Repetition Rendering (delegated to ghost_renderer.js)
    const ghostMaxX = renderGhosts({
        stacks, clips, effectiveQ, baseWidth,
        nodeLayer, livePeaks, masterPos: state.masterPos || 0,
        viewport, VISUAL_OFFSET, log
    });
    if (ghostMaxX > maxX) maxX = ghostMaxX;

    // Removal check - clean up nodes that no longer exist
    // Skip stack wrappers (they have 'stack-wrapper-' prefix and are managed separately)
    uiNodeIds.forEach(id => {
        if (!newNodeIds.includes(id)) {
            const el = document.getElementById(id);
            if (el && !el.classList.contains('stack-btn') && !el.classList.contains('stack-wrapper')) {
                el.remove();
                livePeaks.delete(id);
            }
        }
    });

    // Clean up orphaned stack wrappers (stacks that no longer exist)
    // Collect ALL stack IDs including nested stacks
    function collectAllStackIds(nodeList, ids = new Set()) {
        (nodeList || []).forEach(n => {
            if (n.type === 'stack') {
                ids.add(n.id);
                if (n.nodes) {
                    collectAllStackIds(n.nodes, ids);
                }
            }
        });
        return ids;
    }
    const allStackIds = collectAllStackIds(nodes);
    nodeLayer.querySelectorAll('.stack-wrapper').forEach(wrapper => {
        const stackId = wrapper.id.replace('stack-wrapper-', '');
        if (!allStackIds.has(stackId)) {
            wrapper.remove();
        }
    });
}



// API Wrappers
export async function togglePlayback() { await callNative('togglePlayback'); }
export async function toggleRecord(id) {
    console.log(`toggleRecord called for ${id}`);
    const div = document.getElementById(id);
    if (!div) return;
    const isActive = div.querySelector('.node-btn-record').classList.contains('active');

    if (!isActive) {
        // Start recording: Clear stale peaks
        livePeaks.delete(id);
        log(`Recording started for ${id}: Cleared stale peaks.`);
    }

    log(`Toggling record for ${id} (currently ${isActive ? 'ACTIVE' : 'IDLE'})`);
    await callNative(isActive ? 'stopRecordingInNode' : 'startRecordingInNode', id);
}
export async function createNode(type, parent) {
    await callNative('createNode', type, parent || '');
}

export async function toggleStackExpand(id) {
    await callNative('toggleStackExpand', id);
}

export async function togglePlay(id) { await callNative('togglePlay', id); }
export async function toggleSolo(id) { await callNative('toggleSolo', id); }
// function renameNode moved to bottom section
export async function renameNode(id, name) {
    await callNative('renameNode', id, name);
    log(`Renamed node to ${name}`);
}

export async function fetchWaveform(id) {
    if (window.isFetchingWaveform === id) return;
    window.isFetchingWaveform = id;

    try {
        log(`Fetching static waveform for ${id}...`);
        // Fix Waveform Drift: Request peaks based on actual pixel width to maintain 1:1 resolution
        // and prevent "stretching" artifacts as the clip grows.
        const nodeElement = document.getElementById(id);
        const width = nodeElement ? parseFloat(nodeElement.querySelector('.node-content')?.style.width) || 200 : 200;
        const peaks = await callNative('getWaveform', id, Math.ceil(width));
        if (peaks && peaks.length > 0) {
            livePeaks.set(id, peaks);
            log(`Fetched ${peaks.length} peaks for ${id}`);
        }
    } catch (err) {
        console.error("Waveform fetch failed:", err);
    } finally {
        window.isFetchingWaveform = null;
    }
}

// API bag for dependency injection into extracted modules
const _api = { callNative, log, toggleRecord, togglePlay, toggleSolo, renameNode, toggleStackExpand, createNode };

try {
    console.log("Calling initApp()...");
    initApp();
    console.log("App Initialized. Hiding overlay.");
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
} catch (err) {
    console.error("Critical Init Error:", err);
    const status = document.getElementById('loading-status');
    if (status) status.innerHTML = `<span style="color:#ef4444">Init Failed: ${err.message}</span>`;
}
