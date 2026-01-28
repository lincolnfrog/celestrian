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
import { groupNodesByVisualX, calculateButtonPosition } from './stack_logic.js';
import { initDragDrop, isDragging, isDropAnimating, isAnyDragActive } from './drag_drop.js';

const nodeLayer = document.getElementById('node-layer');
const creationUI = document.getElementById('creation-ui');
const playBtn = document.getElementById('play-btn');

const livePeaks = new Map();
const compositeWaveformCache = new Map();  // stackId -> { key, peaks }
let viewport;
let availableInputs = [];

// Global API Hooks
window.createNode = (type, x, y) => {
    callNative('createNode', type, x || -1, y || -1);
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

    // Calculate the effective quantum for width scaling (minimum of all reported quantums)
    // Must include clips inside stacks, not just top-level nodes
    let effectiveQ = Infinity;

    // Helper to collect all effectiveQuantum values recursively
    function collectQuantums(nodeList) {
        (nodeList || []).forEach(n => {
            if (n.effectiveQuantum > 0 && n.effectiveQuantum < effectiveQ) {
                effectiveQ = n.effectiveQuantum;
            }
            // Also check children (for stacks)
            if (n.type === 'stack' && n.nodes) {
                collectQuantums(n.nodes);
            }
        });
    }
    collectQuantums(nodes);

    if (effectiveQ === Infinity) effectiveQ = 1;
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
            stackWrapper = createStackWrapper(stack);
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
                // Calculate LCM of all children to get full stack timeline width
                // Helper functions for LCM calculation
                const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
                const lcm = (a, b) => (a === 0 || b === 0) ? Math.max(a, b) : Math.abs((a / gcd(a, b)) * b);

                // Calculate stack LCM from children (same logic as ghost rendering)
                let stackLCM = effectiveQ;
                (stack.nodes || []).forEach(child => {
                    if (child.isRecording) return;
                    if (child.type === 'clip' && child.duration > 0) {
                        stackLCM = lcm(Math.round(stackLCM), Math.round(child.duration));
                    } else if (child.type === 'stack' && child.effectiveQuantum > 0) {
                        stackLCM = lcm(Math.round(stackLCM), Math.round(child.effectiveQuantum));
                    }
                });

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
                // If backend doesn't provide waveform, generate from children's livePeaks
                let waveformData = stack.waveform || [];

                if (waveformData.length === 0 && stack.nodes) {
                    // Generate cache key from child state (invalidates when children change)
                    const targetPeaks = Math.ceil(canvas.width * 2);
                    const cacheKeyParts = [];
                    (stack.nodes || []).forEach(child => {
                        if (child.type === 'clip') {
                            // Include all properties that affect composite appearance
                            cacheKeyParts.push([
                                child.id,
                                child.duration || 0,
                                child.x || 0,
                                child.loopStart || 0,
                                child.loopEnd || 0,
                                child.launchPoint || 0
                            ].join(':'));
                        }
                    });
                    const cacheKey = `${targetPeaks}:${stack.loopStart || 0}:${stack.loopEnd || 0}:${cacheKeyParts.join(',')}`;

                    // Check cache
                    const cached = compositeWaveformCache.get(stack.id);
                    if (cached && cached.key === cacheKey) {
                        // Cache hit - use cached peaks
                        waveformData = cached.peaks;
                    } else {
                        // Cache miss - regenerate composite waveform
                        waveformData = new Array(targetPeaks).fill(0);

                        // Each clip contributes peaks at its position within the timeline
                        (stack.nodes || []).forEach(child => {
                            if (child.type !== 'clip' || !livePeaks.has(child.id)) return;

                            const childPeaks = livePeaks.get(child.id);
                            if (!childPeaks || childPeaks.length === 0) return;

                            // Calculate this clip's position as a fraction of the LCM timeline
                            const clipOffsetSamples = child.x || 0;  // x = anchor offset in samples
                            const clipDuration = child.duration || effectiveQ;

                            // Convert to pixel positions
                            const clipStartPx = (clipOffsetSamples / stackDuration) * canvas.width;
                            const clipWidthPx = (clipDuration / stackDuration) * canvas.width;

                            // Map this clip's peaks to the correct position in the composite
                            const clipPeakCount = childPeaks.length;
                            for (let i = 0; i < clipPeakCount; i++) {
                                // Calculate target index in composite waveform
                                const peakPctInClip = i / clipPeakCount;
                                const pxInComposite = clipStartPx + (peakPctInClip * clipWidthPx);
                                const targetIdx = Math.floor((pxInComposite / canvas.width) * targetPeaks);

                                if (targetIdx >= 0 && targetIdx < targetPeaks) {
                                    // Take max of overlapping peaks
                                    waveformData[targetIdx] = Math.max(waveformData[targetIdx], childPeaks[i] || 0);
                                }
                            }

                            // Also handle looping: if clip loops within LCM, repeat peaks
                            if (clipDuration < stackDuration && clipDuration > 0) {
                                const numLoops = Math.ceil(stackDuration / clipDuration);
                                for (let loopIdx = 1; loopIdx < numLoops && loopIdx < 10; loopIdx++) {
                                    const loopStartSamples = clipOffsetSamples + (loopIdx * clipDuration);
                                    if (loopStartSamples >= stackDuration) break;

                                    const loopStartPx = (loopStartSamples / stackDuration) * canvas.width;
                                    for (let i = 0; i < clipPeakCount; i++) {
                                        const peakPctInClip = i / clipPeakCount;
                                        const pxInComposite = loopStartPx + (peakPctInClip * clipWidthPx);
                                        const targetIdx = Math.floor((pxInComposite / canvas.width) * targetPeaks);

                                        if (targetIdx >= 0 && targetIdx < targetPeaks) {
                                            waveformData[targetIdx] = Math.max(waveformData[targetIdx], childPeaks[i] || 0);
                                        }
                                    }
                                }
                            }
                        });

                        // Store in cache
                        compositeWaveformCache.set(stack.id, { key: cacheKey, peaks: waveformData });
                    }
                }

                // Always draw (empty waveform shows placeholder line)
                drawWaveform(canvas, waveformData, null, true /* isComposite */);

                // Update playhead position based on masterPos relative to stack loop region
                // When collapsed, the stack loops within loopStart to loopEnd
                if (playhead && state.isPlaying) {
                    let masterPos = state.masterPos || 0;
                    const loopStart = stack.loopStart || 0;
                    const loopEnd = stack.loopEnd || stackDuration;
                    const loopLength = loopEnd - loopStart;

                    // DEBUG: Use internal transport if available (fixes loop sync for collapsed stacks)
                    if (!stack.isExpanded && typeof stack.internalTransport === 'number') {
                        // When collapsed, the stack runs on its own internal clock
                        // We construct a synthetic masterPos that aligns with the loop start
                        masterPos = loopStart + stack.internalTransport;
                    }

                    // Calculate position within the loop region
                    let playheadPct;
                    if (loopLength > 0 && stackDuration > 0) {
                        // Wrap masterPos within loop region
                        // For collapsed stacks (using internalTransport), this computes: loopStart + (internal % loopLength)
                        const posInLoop = loopStart + ((masterPos - loopStart) % loopLength);
                        // Convert to percentage of full timeline
                        playheadPct = posInLoop / stackDuration;
                    } else {
                        // Fallback: just use full duration
                        playheadPct = stackDuration > 0 ? (masterPos % stackDuration) / stackDuration : 0;
                    }

                    // DEBUG: Log playhead calculation (throttled)
                    if (Date.now() % 1000 < 50) {
                        log(`[SyncUI] Playhead: masterPos=${masterPos}, loopStart=${loopStart}, loopEnd=${loopEnd}, loopLength=${loopLength}, stackDuration=${stackDuration}, pct=${playheadPct}`);
                    }

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
                        nestedWrapper = createStackWrapper(child);
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
                                nestedDiv = createNodeElement(nestedChild);
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
                        childDiv = createNodeElement(child);
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
    allClips.forEach(node => {
        let div = document.getElementById(node.id);
        if (!div) {
            // For top-level clips only, create and append
            if (clips.includes(node)) {
                div = createNodeElement(node);
                nodeLayer.appendChild(div);
            } else {
                // Stack children are already created above
                return;
            }
        }

        // Calculate dynamic width based on clip duration relative to quantum
        // Dual-mode rendering per docs/implementation.md Section 7:
        // - Pre-quantum: Fixed canvas (200px), compressing waveform
        // - Post-quantum: Growing canvas from 0, stable waveform
        let displayWidth = node.w;
        const isPreQuantum = effectiveQ <= 1;  // Q not yet established

        if (node.isRecording) {
            if (isPreQuantum) {
                // PRE-QUANTUM: Fixed canvas, waveform compresses to fit
                displayWidth = baseWidth;
            } else {
                // POST-QUANTUM: Canvas grows from 0, peaks stay fixed
                const recordedDuration = node.duration || 0;
                displayWidth = (recordedDuration / effectiveQ) * baseWidth;
                // Note: No Math.max - true zero width is acceptable
            }
        } else if (node.duration > 0 && !isPreQuantum) {
            // After recording (post-quantum): scale based on final duration
            displayWidth = (node.duration / effectiveQ) * baseWidth;
        } else if (node.duration > 0) {
            // After recording (pre-quantum clip that established Q): use baseWidth
            displayWidth = baseWidth;
        } else {
            // New clip or collapsed: use base width
            displayWidth = baseWidth;
        }

        // Detect one-shot (for visual styling only)
        const clipDuration = node.duration || effectiveQ;
        const isOneShot = effectiveQ > 1 && clipDuration < effectiveQ;

        // Apply one-shot styling
        div.classList.toggle('one-shot', isOneShot);

        // Collapsed clip: host waveform area logic
        const isActivelyRecording = node.isRecording && !node.isPendingStart;
        const hasRecordedAudio = (node.duration || 0) > 10 && !node.isPendingStart;
        const shouldCollapse = !isActivelyRecording && !hasRecordedAudio;
        // Detect if this node is a child of a stack (vs top-level)
        const isStackChild = !clips.includes(node);

        // Skip position/size updates for nodes being dragged
        const nodeIsBeingDragged = isDragging(node.id);

        // UI = Data: Position comes directly from C++ data
        // Apply VISUAL_OFFSET for View (but NOT for stack children - they use relative positioning)
        // Skip POSITION updates during drag to not interfere with manual drag positioning
        if (!isStackChild && !nodeIsBeingDragged) {
            div.style.left = `${(node.x || 0) + VISUAL_OFFSET}px`;
            div.style.top = `${node.y || 0}px`;
        }

        // Node container width: Match rhythmic duration but NEVER narrower than the header
        // ALWAYS set dimensions - even during drag - so content doesn't collapse and clip loop handles
        const nodeWidth = Math.max(260, shouldCollapse ? 0 : (displayWidth || 0));
        if (!isStackChild) {
            div.style.width = isFinite(nodeWidth) ? `${nodeWidth}px` : '260px';
        }

        const headerH = 38;
        const contentH = Math.max(20, (node.h || 100) - headerH);

        // Final node height depends on collapsed state
        // ALWAYS set height - even during drag - so content doesn't collapse
        const finalNodeH = shouldCollapse ? headerH : (node.h || 100);
        if (!isStackChild) {
            div.style.height = isFinite(finalNodeH) ? `${finalNodeH}px` : '38px';
        }

        // Content width/height
        // Skip for dragged nodes to prevent resize-induced clipping of loop handles
        const content = div.querySelector('.node-content');
        if (content && !nodeIsBeingDragged) {
            const cWidth = isFinite(displayWidth) ? displayWidth : 200;
            content.style.width = `${cWidth}px`;
            content.style.height = `${contentH}px`;

            // For stack children, apply node.x as content offset (anchor position)
            // This shifts the waveform area horizontally within the clip container
            if (isStackChild && node.x > 0) {
                content.style.transform = `translateX(${node.x}px)`;
            } else if (!isStackChild) {
                content.style.transform = 'none';
            }
        }

        maxY = Math.max(maxY, node.y + node.h);
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x + displayWidth);

        node._visualX = node.x; // UI = Data: visual position is node.x

        div._latestNode = node; // Store latest state for drag handlers

        const playhead = div.querySelector('.playhead');
        playhead.style.left = `${node.playhead * 100}%`;
        // Ensure visible by default (ghost logic may hide it later)
        playhead.style.display = node.isPlaying ? 'block' : 'none';

        // Loop Handles & Dim Layers
        const dur = node.duration || 1;
        let loopStart = node.loopStart || 0;
        let loopEnd = node.loopEnd || dur;

        // Fallback: If loop points are not set or invalid, use full duration
        if (loopEnd <= loopStart) {
            loopStart = 0;
            loopEnd = dur;  // Use dur (guaranteed >= 1), not node.duration (could be 0)
        }

        // Guard against NaN/Infinity from division
        const startPct = isFinite(loopStart / dur) ? (loopStart / dur) * 100 : 0;
        const endPct = isFinite(loopEnd / dur) ? (loopEnd / dur) * 100 : 100;

        const hStart = div.querySelector('.loop-handle-start');
        const hEnd = div.querySelector('.loop-handle-end');
        const dimLeft = div.querySelector('.dim-left');
        const dimRight = div.querySelector('.dim-right');

        if (hStart && hEnd && dimLeft && dimRight) {
            hStart.style.left = `${startPct}%`;
            hEnd.style.left = `${endPct}%`;
            dimLeft.style.width = `${startPct}%`;
            dimRight.style.left = `${endPct}%`;
            dimRight.style.width = `${100 - endPct}%`;
        }

        // Update launch marker (shows where playback starts)
        const launchMarker = div.querySelector('.launch-marker');
        if (launchMarker && dur > 0) {
            const launchPct = ((node.launchPoint || 0) / dur) * 100;
            launchMarker.style.left = `${launchPct}%`;
            // Only show if clip has non-zero anchor AND is not a stack child with x offset
            // (Stack children with translateX offset make the marker position confusing)
            const hasXOffset = isStackChild && (node.x || 0) > 0;
            launchMarker.style.display = (node.anchorPhase > 0 && !hasXOffset) ? 'block' : 'none';
        }

        // Update input selection
        const inputSelect = div.querySelector('.node-input-select');
        const inputs = availableInputs || [];
        if (inputSelect) {
            if (inputSelect.options.length === 0) {
                if (inputs.length === 0) {
                    const opt = document.createElement('option');
                    opt.value = -1;
                    opt.textContent = "-- No Inputs --";
                    inputSelect.appendChild(opt);
                } else {
                    inputs.forEach((name, idx) => {
                        const opt = document.createElement('option');
                        opt.value = idx;
                        opt.textContent = name;
                        inputSelect.appendChild(opt);
                    });
                }
            }
            inputSelect.value = node.inputChannel || 0;
        }

        // Diagnostic: Peak text
        const peakInfo = div.querySelector('.peak-debug');
        if (peakInfo) {
            const pVal = node.currentPeak || 0;
            peakInfo.innerText = pVal.toFixed(4); // More precision to see activity
            if (pVal > 0.001) peakInfo.style.opacity = "1";
            else peakInfo.style.opacity = "0.4";
        }

        // Update button states
        const recBtn = div.querySelector('.node-btn-record');
        const playBtn = div.querySelector('.node-btn-play');
        const soloBtn = div.querySelector('.node-btn-solo');

        if (recBtn && playBtn) {
            const hasAudio = node.duration > 0;
            const isPending = node.isPendingStart || node.isAwaitingStop;
            const showRecord = !hasAudio || node.isRecording || isPending;
            recBtn.style.display = showRecord ? 'flex' : 'none';
            playBtn.style.display = showRecord ? 'none' : 'flex';

            // Yellow pending state for both pending start and awaiting stop
            recBtn.classList.toggle('active', node.isRecording && !node.isAwaitingStop);
            recBtn.classList.toggle('pending', isPending);
            playBtn.classList.toggle('active', node.isPlaying);
        }

        const muteBtn = div.querySelector('.node-btn-mute');

        if (muteBtn) {
            muteBtn.classList.toggle('active', node.isMuted);
        }

        if (soloBtn) {
            // state.soloedId comes from AudioEngine::getGraphState
            const isSoloed = state.soloedId === node.id;
            soloBtn.classList.toggle('active', isSoloed);
        }

        div.classList.toggle('muted', node.isMuted);

        // Diagnostic: Log recording state change
        if (node.isRecording !== div._last_rec_state) {
            log(`Node ${node.id} isRecording: ${node.isRecording}`);
            div._last_rec_state = node.isRecording;
        }

        if (node.isRecording) {
            // Live waveform: Dual-mode peak allocation
            const recordedSamples = node.duration || 0;

            // DUAL MODE:
            // - First clip (Q not established): Use fixed rate for stable performance
            // - Subsequent clips (Q established): Use Q-based rate for visual alignment
            let samplesPerPeak;
            if (effectiveQ > 1) {
                // Q is established from previous clip - use it for stable visual alignment
                // 400 peaks per Q = 2 peaks per pixel at baseWidth (200px per Q)
                samplesPerPeak = effectiveQ / 400;
            } else {
                // First clip - use fixed rate for performance
                samplesPerPeak = 110; // ~400 peaks/sec at 44.1kHz
            }

            // Calculate index based on fixed samples-per-peak rate
            const index = Math.floor(recordedSamples / samplesPerPeak);
            const requiredSize = index + 1;

            if (!livePeaks.has(node.id)) {
                livePeaks.set(node.id, new Array(Math.max(requiredSize, 400)).fill(0.01));
            }

            const peaks = livePeaks.get(node.id);

            // Grow array if needed (in chunks of 400 to reduce reallocation)
            if (peaks.length < requiredSize) {
                const newSize = Math.max(requiredSize, peaks.length + 400);
                while (peaks.length < newSize) {
                    peaks.push(0.01);
                }
            }

            // Visibility floor: ensure we see something even in silence
            const p = node.currentPeak > 0.005 ? node.currentPeak : 0.01;
            if (index >= 0 && index < peaks.length) {
                peaks[index] = Math.max(peaks[index] || 0.01, p);
            }

            // CRITICAL FIX: Only pass peaks up to current index to renderer.
            // Passing the full array (with pre-allocated empty slots) causes
            // the renderer to stretch peaks, making them appear to "drift".
            const validPeaks = peaks.slice(0, index + 1);

            // DUAL-MODE STEP:
            // - Pre-quantum: Pass null (renderer calculates dynamic step -> compression)
            // - Post-quantum: Fixed step (0.5 px/peak) for stable peak positions
            const fixedStep = (effectiveQ > 1) ? (baseWidth / 400) : null;
            drawWaveform(div.querySelector('.node-waveform'), validPeaks, fixedStep);

            // Show quantum grid marks during recording (only if Q is established)
            const content = div.querySelector('.node-content');
            div.querySelectorAll('.recording-grid-mark').forEach(m => m.remove());
            if (effectiveQ > 1 && recordedSamples > 0) {
                const numQsRecorded = Math.floor(recordedSamples / effectiveQ);
                for (let i = 1; i <= numQsRecorded && i < 20; i++) {
                    // Mark at Q boundary i, positioned as percentage of recorded length
                    const markPct = (i * effectiveQ / recordedSamples) * 100;
                    const mark = document.createElement('div');
                    mark.className = 'recording-grid-mark snap-point-grid';
                    mark.style.left = `${markPct}%`;
                    content.appendChild(mark);
                }
            }
        }
        else if (node.duration > 0) {
            // Check if we just stopped recording - the size will be small if it's the live buffer
            if (!livePeaks.has(node.id) || livePeaks.get(node.id).length < 20) {
                fetchWaveform(node.id);
            }
            const pks = livePeaks.get(node.id) || [];
            if (Math.random() < 0.05) {
                const samples = pks.slice(0, 3).map(v => v ? v.toFixed(3) : '0').join(', ');
                console.log(`SYNC STATIC: uuid=${node.id.slice(0, 4)}, name=${node.name}, peaks=${pks.length}, head=${samples}`);
            }
            drawWaveform(div.querySelector('.node-waveform'), pks);
        }
        else {
            // Only clear if we really have no data
            if (livePeaks.has(node.id)) {
                drawWaveform(div.querySelector('.node-waveform'), livePeaks.get(node.id));
            } else {
                drawWaveform(div.querySelector('.node-waveform'), []);
            }
        }

        // Initialize drag-and-drop for this node
        const parent = stacks.find(s => s.nodes && s.nodes.some(n => n.id === node.id));
        const nodeData = {
            id: node.id,
            type: node.type,
            parent: parent ? parent.id : null,
            isTopLevel: !parent
        };
        log(`[DragInit] ${node.id}: isTopLevel=${nodeData.isTopLevel}, parent=${nodeData.parent}`);
        initDragDrop(div, nodeData);
    });

    // Ghost Repetition Rendering: Looping clips show faded repetitions
    // Now calculated PER-STACK, not globally

    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
    const lcm = (a, b) => (a === 0 || b === 0) ? Math.max(a, b) : Math.abs((a / gcd(a, b)) * b);

    // Helper: Calculate LCM for a stack's children (recursive for nested stacks)
    function calculateStackLCM(stackNodes, effectiveQ) {
        let stackLCM = effectiveQ;
        let maxDuration = 0;

        (stackNodes || []).forEach(child => {
            if (child.isRecording) return; // Skip recording clips

            if (child.type === 'clip' && child.duration > 0) {
                stackLCM = lcm(Math.round(stackLCM), Math.round(child.duration));
                maxDuration = Math.max(maxDuration, child.duration);
            } else if (child.type === 'stack' && child.nodes) {
                // Nested stack: its internal LCM becomes its composite duration
                const childLCM = calculateStackLCM(child.nodes, effectiveQ);
                stackLCM = lcm(Math.round(stackLCM), Math.round(childLCM));
                maxDuration = Math.max(maxDuration, childLCM);
            }
        });

        return Math.max(stackLCM, maxDuration);
    }

    // Clean up old ghosts
    nodeLayer.querySelectorAll('.ghost-clip').forEach(g => g.remove());

    // Render ghost repetitions only if effectiveQ is established
    log(`[Ghost] effectiveQ=${effectiveQ}, stacks.length=${stacks.length}, clips.length=${clips.length}`);

    if (effectiveQ > 1) {
        // Process each stack independently
        stacks.forEach(stack => {
            const stackLCM = calculateStackLCM(stack.nodes, effectiveQ);
            const stableQ = Math.round(effectiveQ);
            const stackTimelineQuantums = Math.max(1, Math.ceil(stackLCM / stableQ));
            let stackTimelineWidth = stackTimelineQuantums * baseWidth;

            // During recording, extend timeline in LCM-sized chunks when recording crosses boundary
            // Per docs/recording.md: "ghosts only expand when recording crosses the committed LCM boundary"
            const recordingChild = (stack.nodes || []).find(n => n.isRecording && n.duration > 0);
            if (recordingChild) {
                const recordingWidthPx = (recordingChild.duration / effectiveQ) * baseWidth;
                // Calculate how many LCM chunks the recording has crossed
                const lcmWidthPx = (stackLCM / effectiveQ) * baseWidth;
                const lcmChunksCrossed = Math.floor(recordingWidthPx / lcmWidthPx);
                // Timeline extends by that many LCM chunks beyond the committed LCM
                const requiredWidth = (lcmChunksCrossed + 1) * lcmWidthPx;
                stackTimelineWidth = Math.max(stackTimelineWidth, requiredWidth);
                log(`[Ghost] Recording: ${recordingWidthPx.toFixed(0)}px crossed ${lcmChunksCrossed} LCM boundaries, timeline=${stackTimelineWidth}px`);
            }

            log(`[Ghost] Stack ${stack.id}: LCM=${stackLCM}, timelineWidth=${stackTimelineWidth}`);

            // Track max timeline width for viewport bounds
            maxX = Math.max(maxX, stack.x + stackTimelineWidth);

            // Skip ghost rendering if stack is collapsed - children aren't visible
            if (!stack.isExpanded) {
                log(`[Ghost] Skipping ${stack.id} - stack is collapsed`);
                return;
            }

            // Render ghosts for each clip in this stack
            (stack.nodes || []).forEach(node => {
                if (node.type !== 'clip' || node.isRecording || !node.duration) return;

                const clipWidth = (node.duration / effectiveQ) * baseWidth;
                const isOneShot = node.duration < effectiveQ;

                // CRITICAL DEBUG: Log the clip details
                log(`[Ghost] Clip ${node.id}: duration=${node.duration}, effectiveQ=${effectiveQ}, clipWidth=${clipWidth}, timelineWidth=${stackTimelineWidth}, willDrawGhosts=${clipWidth < stackTimelineWidth - 5}`);

                // One-shots don't get ghosts
                if (isOneShot) {
                    log(`[Ghost] Skipping ${node.id} - one-shot`);
                    return;
                }

                log(`[Ghost] Rendering ghosts for ${node.id} in stack ${stack.id}`);

                // Stack children use relative positioning; ghosts need absolute positioning
                // Stack wrapper padding (12px) + stack children padding (32px) + borders (2px) = 46px
                const STACK_PADDING_OFFSET = 46;
                const stackXOffset = stack.x + STACK_PADDING_OFFSET;

                // Query actual DOM Y position for accurate vertical alignment
                const clipElement = document.getElementById(node.id);
                let ghostY;
                if (clipElement) {
                    const clipRect = clipElement.getBoundingClientRect();
                    const nodeLayerRect = nodeLayer.getBoundingClientRect();
                    // Normalize by viewport scale to avoid double-scaling
                    const currentScale = (viewport && viewport.scale) || 1.0;
                    ghostY = (clipRect.top - nodeLayerRect.top) / currentScale + 38; // +38 for header
                } else {
                    // Fallback: calculate Y from data model
                    ghostY = stack.y;
                    const childIndex = stack.nodes.findIndex(n => n.id === node.id);
                    let cumulativeY = 40; // Stack top padding
                    for (let i = 0; i < childIndex; i++) {
                        cumulativeY += (stack.nodes[i].h || 100) + 16;
                    }
                    ghostY += cumulativeY + 38;
                }

                // Clips inside stacks use node.x as their anchor offset
                // This is the visual x-position set by C++ based on recording start phase
                const clipStartX = node.x || 0;
                const clipEndX = clipStartX + clipWidth;

                // UNIFIED GHOST RENDERING: Fill entire timeline with ghosts
                // except where the main clip is positioned
                // This handles both left-fill (before anchor) and right-fill (after anchor)
                let ghostCount = 0;
                let ghostX = 0;

                while (ghostX < stackTimelineWidth - 5 && ghostCount < 100) {
                    // Skip if this position overlaps with the MAIN clip
                    // (allow small tolerance for floating point)
                    const overlapsMainClip = (ghostX + clipWidth > clipStartX + 1) &&
                        (ghostX < clipEndX - 1);

                    if (overlapsMainClip) {
                        // Jump past the main clip
                        ghostX = clipEndX;
                        continue;
                    }

                    // Calculate ghost width (may be clipped at timeline end)
                    let thisGhostWidth = clipWidth;
                    if (ghostX + clipWidth > stackTimelineWidth) {
                        thisGhostWidth = stackTimelineWidth - ghostX;
                    }

                    // Skip tiny ghosts
                    if (thisGhostWidth < 5) {
                        ghostX += clipWidth;
                        continue;
                    }

                    const ghost = document.createElement('div');
                    ghost.className = 'ghost-clip';
                    ghost.style.position = 'absolute';
                    ghost.style.left = `${ghostX + stackXOffset + VISUAL_OFFSET}px`;
                    ghost.style.top = `${ghostY}px`;
                    ghost.style.width = `${thisGhostWidth}px`;
                    ghost.style.height = `${node.h - 38}px`;

                    ghost.classList.add('node-content');
                    ghost.style.borderRadius = '0 0 8px 8px';
                    ghost.style.border = '1px dashed rgba(56, 189, 248, 0.2)';
                    ghost.style.borderTop = 'none';
                    ghost.style.background = 'rgba(30, 41, 59, 0.3)';

                    const canvas = document.createElement('canvas');
                    ghost.appendChild(canvas);
                    if (livePeaks.has(node.id)) {
                        drawWaveform(canvas, livePeaks.get(node.id));
                    }

                    const ghostPlayhead = document.createElement('div');
                    ghostPlayhead.className = 'playhead';
                    ghostPlayhead.style.left = `${node.playhead * 100}%`;
                    ghostPlayhead.style.opacity = '0.4';

                    // Determine if this ghost is "active" (playhead is within it)
                    let timelinePosPx;
                    const recordingNode = (stack.nodes || []).find(n => n.isRecording);

                    if (recordingNode) {
                        timelinePosPx = (recordingNode.duration / effectiveQ) * baseWidth;
                    } else {
                        const timelinePos = state.masterPos % stackLCM;
                        timelinePosPx = (timelinePos / effectiveQ) * baseWidth;
                    }

                    const isActiveGhost = (timelinePosPx >= ghostX && timelinePosPx < ghostX + thisGhostWidth);

                    if (isActiveGhost) {
                        ghost.classList.add('active-ghost');
                        ghostPlayhead.style.display = 'block';
                    } else {
                        ghost.classList.remove('active-ghost');
                        ghostPlayhead.style.display = 'none';
                    }

                    ghost.appendChild(ghostPlayhead);
                    nodeLayer.appendChild(ghost);
                    ghostX += clipWidth;
                    ghostCount++;
                }
            });
        });

        // Also handle top-level clips (not in any stack) - treat them as individual items
        clips.forEach(node => {
            if (node.isRecording || !node.duration) return;

            const clipWidth = (node.duration / effectiveQ) * baseWidth;
            const isOneShot = node.duration < effectiveQ;

            if (isOneShot) return;

            log(`[Ghost] Rendering ghosts for top-level clip ${node.id}`);

            const ghostX = node.x;
            const ghostY = node.y;

            // For top-level clips, use their own duration as timeline (no LCM needed for single clip)
            const clipTimelineWidth = clipWidth;

            // Top-level clips don't get right ghosts (no other clips to LCM with)
            // They only get left-wrap ghosts if needed
            maxX = Math.max(maxX, ghostX + clipWidth);
        });
    }

    // 0. Stability Sort: Ensure anchor selection is identical across polls
    const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));

    /* OLD STACK BUTTON LOGIC - DISABLED (replaced by stack wrappers)
    // Render Stack (+) buttons: Group nodes by their visual X position
    const activeStackButtons = new Set();
    const groups = groupNodesByVisualX(nodes);

    groups.forEach(group => {
        const { id: stackBtnId, x: stackX, y: maxY } = calculateButtonPosition(group);
        activeStackButtons.add(stackBtnId);

        let btn = document.getElementById(stackBtnId);
        if (!btn) {
            btn = document.createElement('div');
            btn.id = stackBtnId;
            btn.className = 'stack-btn';
            btn.innerText = '+';
            nodeLayer.appendChild(btn);
        }

        // Update position only if meaningfully changed to avoid jitter/flicker
        // Align with left edge of stack (includes VISUAL_OFFSET)
        const nextLeft = `${stackX + VISUAL_OFFSET}px`;
        const nextTop = `${maxY + 10}px`;
        if (btn.style.left !== nextLeft) btn.style.left = nextLeft;
        if (btn.style.top !== nextTop) btn.style.top = nextTop;

        // Refresh mousedown to capture latest stackX/maxY closure
        btn.onmousedown = (e) => {
            e.stopPropagation();
            createNode('clip', stackX, maxY + 20);
        };
    });

    // Cleanup old stack buttons
    nodeLayer.querySelectorAll('.stack-btn').forEach(btn => {
        if (!activeStackButtons.has(btn.id)) {
            btn.remove();
        }
    });
    */

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

function createNodeElement(node) {
    const div = document.createElement('div');
    div.id = node.id;
    div.className = `node ${node.type}`;

    // Stacks should not show record button (they're containers, not recordable)
    const showRecordBtn = node.type !== 'stack';

    div.innerHTML = `
        <div class="grab-handle" title="Drag to reorder"></div>
        <div class="node-header">
            <input class="node-name-input" value="${node.name}" />
            <span class="peak-debug" style="font-size: 9px; color: #10b981; opacity: 0.6; pointer-events: none; width: 44px; text-align: right; padding-right: 4px; font-family: monospace;"></span>
            
            <div class="node-btn-mute">M</div>
            <div class="node-btn-solo">S</div>
            ${showRecordBtn ? `
            <div class="node-btn-record">
                <div class="record-dot"></div>
            </div>
            ` : ''}
            <div class="node-btn-play">
                <div class="play-icon"></div>
            </div>
            
            <select class="node-input-select"></select>
        </div>
        <div class="node-content">
            <canvas class="node-waveform" style="position: relative; z-index: 5;"></canvas>
            <div class="dim-layer dim-left" style="left: 0;"></div>
            <div class="dim-layer dim-right"></div>
            <div class="loop-handle loop-handle-start"></div>
            <div class="loop-handle loop-handle-end"></div>
            <div class="loop-ghost"></div>
            <div class="snap-marker"></div>
            <div class="snap-arrow"></div>
            <div class="launch-marker" title="Launch Point"></div>
            <div class="playhead"></div>
        </div>
    `;

    // Events
    const input = div.querySelector('.node-name-input');
    input.onblur = () => renameNode(node.id, input.value);
    input.onkeydown = (e) => {
        if (e.key === 'Enter') input.blur();
        e.stopPropagation();
    };

    const recordBtn = div.querySelector('.node-btn-record');
    if (recordBtn) {
        recordBtn.onmousedown = (e) => {
            e.stopPropagation();
            toggleRecord(node.id);
        };
    }

    div.querySelector('.node-btn-play').onmousedown = (e) => {
        e.stopPropagation();
        togglePlay(node.id);
    };

    div.querySelector('.node-btn-mute').onmousedown = (e) => {
        e.stopPropagation();
        callNative('toggleMute', { uuid: node.id });
    };

    div.querySelector('.node-btn-solo').onmousedown = (e) => {
        e.stopPropagation();
        toggleSolo(node.id);
    };

    const inputSelect = div.querySelector('.node-input-select');
    if (inputSelect) {
        inputSelect.onmousedown = (e) => e.stopPropagation();
        inputSelect.onchange = (e) => {
            callNative('setNodeInput', node.id, parseInt(e.target.value));
        };
    }

    // Double-click functionality removed - stacks use expand/collapse instead
    div.ondblclick = (e) => {
        if (e.target.tagName !== 'INPUT') {
            e.stopPropagation();
            // Stacks can be expanded/collapsed via the handle, not double-click
        }
    };

    // Dragging Loop Handles
    const setupHandle = (handle, isStart) => {
        if (!handle) return;

        // Custom Cursors: [ and ]
        const cursorSvg = (isStart, text) => {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><text x="${isStart ? 4 : 12}" y="18" fill="white" font-family="monospace" font-size="20" font-weight="bold">${text}</text></svg>`;
            return `url('data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}') 12 12, col-resize`;
        };
        handle.style.cursor = cursorSvg(isStart, isStart ? '[' : ']');

        handle.onmousedown = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const content = div.querySelector('.node-content');
            const rect = content.getBoundingClientRect();
            const ghost = div.querySelector('.loop-ghost');
            const marker = div.querySelector('.snap-marker');
            const arrow = div.querySelector('.snap-arrow');

            // Show feedback elements
            ghost.style.display = 'block';
            marker.style.display = 'block';
            arrow.style.display = 'block';

            const onMouseMove = (moveE) => {
                const latestNode = div._latestNode;
                if (!latestNode) return;

                const duration = latestNode.duration;
                const quantum = latestNode.effectiveQuantum;
                if (duration <= 0 || rect.width <= 0) return;

                // 1. Raw Position (Ghost)
                let x = moveE.clientX - rect.left;
                let pctRaw = Math.max(0, Math.min(1, x / rect.width));
                ghost.style.left = `${pctRaw * 100}%`;

                // 2. Snapped Position (Marker)
                let samples = pctRaw * duration;
                let snappedSamples = samples;
                if (quantum > 0) {
                    snappedSamples = Math.round(samples / quantum) * quantum;
                }

                // Constraint: Prevent crossing/zero-length
                const minGap = (quantum > 0) ? quantum : 1;
                if (isStart) {
                    // Cannot snap to or past the END handle
                    const maxAllowed = latestNode.loopEnd - minGap;
                    if (snappedSamples > maxAllowed) snappedSamples = maxAllowed;
                } else {
                    // Cannot snap to or past the START handle
                    const minAllowed = latestNode.loopStart + minGap;
                    if (snappedSamples < minAllowed) snappedSamples = minAllowed;
                }

                let pctSnap = snappedSamples / duration;
                marker.style.left = `${pctSnap * 100}%`;

                // 3. Arrow direction and visibility
                const diff = (pctSnap - pctRaw) * rect.width;
                // If we are extremely close to the snap point, hide the arrow/ghost to avoid "visual vibrating"
                if (Math.abs(diff) > 4) {
                    arrow.style.display = 'block';
                    arrow.style.left = `${(pctRaw + (pctSnap - pctRaw) / 2) * 100}%`;
                    arrow.style.transform = `translateY(-50%) rotate(${diff > 0 ? 45 : 225}deg)`;
                    ghost.style.opacity = '1';
                } else {
                    arrow.style.display = 'none';
                    ghost.style.opacity = '0'; // Hide ghost when perfectly snapped
                }

                // 4. Grid Ghosts (Clear and redraw for the current duration)
                div.querySelectorAll('.snap-point-grid').forEach(p => p.remove());
                if (quantum > 0 && (duration / quantum) < 50) { // Don't over-render
                    for (let s = 0; s <= duration; s += quantum) {
                        const gp = document.createElement('div');
                        gp.className = 'snap-point-grid';
                        gp.style.left = `${(s / duration) * 100}%`;
                        content.appendChild(gp);
                    }
                }

                // Actually update engine (throttled/batched ideally, but keeping as is for now)
                let newStart = isStart ? snappedSamples : latestNode.loopStart;
                let newEnd = isStart ? latestNode.loopEnd : snappedSamples;
                if (isStart && newStart >= newEnd) newStart = newEnd - (quantum || 1);
                if (!isStart && newEnd <= newStart) newEnd = newStart + (quantum || 1);

                callNative('setLoopPoints', node.id, Math.round(newStart), Math.round(newEnd));
            };

            const onMouseUp = () => {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                ghost.style.display = 'none';
                marker.style.display = 'none';
                arrow.style.display = 'none';
                div.querySelectorAll('.snap-point-grid').forEach(p => p.remove());
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        };
    };

    setupHandle(div.querySelector('.loop-handle-start'), true);
    setupHandle(div.querySelector('.loop-handle-end'), false);

    return div;
}

function createStackWrapper(stack) {
    const wrapper = document.createElement('div');
    wrapper.id = `stack-wrapper-${stack.id}`;
    wrapper.className = 'stack-wrapper';
    // Position is set via CSS and updated in syncUI

    wrapper.innerHTML = `
        <div class="grab-handle" title="Drag to reorder"></div>
        <div class="stack-expand-handle" data-stack-id="${stack.id}"></div>
        <div class="stack-header-waveform">
            <canvas class="stack-waveform-canvas"></canvas>
            <div class="stack-playhead"></div>
            <!-- Loop region UI (same as clips - hierarchical design) -->
            <div class="loop-handle-start" title="Drag to adjust loop start (only when collapsed)"></div>
            <div class="loop-handle-end" title="Drag to adjust loop end (only when collapsed)"></div>
            <div class="dim-left"></div>
            <div class="dim-right"></div>
            <!-- Visual feedback elements for quantum snapping (matching clip UX) -->
            <div class="loop-ghost"></div>
            <div class="snap-marker"></div>
            <div class="snap-arrow"></div>
            <div class="launch-marker"></div>
        </div>
        <div class="stack-children"></div>
        <div class="stack-add-container">
            <div class="stack-add-button" data-stack-id="${stack.id}">+</div>
            <div class="stack-add-menu">
                <div class="menu-item" data-action="clip">New Clip</div>
                <div class="menu-item" data-action="stack">New Stack</div>
                <div class="menu-item" data-action="template">Load Template</div>
            </div>
        </div>
    `;

    // Expand/collapse handle click
    const expandHandle = wrapper.querySelector('.stack-expand-handle');
    expandHandle.onclick = (e) => {
        e.stopPropagation();
        toggleStackExpand(stack.id);
    };

    // Stack add button click
    const addButton = wrapper.querySelector('.stack-add-button');
    const addMenu = wrapper.querySelector('.stack-add-menu');

    addButton.onclick = (e) => {
        e.stopPropagation();
        const isActive = addMenu.classList.toggle('active');

        if (isActive) {
            // Smart positioning: show above if space, below if near top
            const buttonRect = addButton.getBoundingClientRect();
            const menuHeight = 120; // Approximate menu height
            const spaceAbove = buttonRect.top - 50; // Account for top bar

            // Clear previous positioning
            addMenu.style.bottom = '';
            addMenu.style.top = '';

            if (spaceAbove >= menuHeight) {
                // Enough space above - show above button
                addMenu.style.bottom = '40px';
            } else {
                // Not enough space above - show below button  
                addMenu.style.top = '40px';
            }

            // Close menu on outside click
            const closeMenu = (event) => {
                if (!addMenu.contains(event.target) && !addButton.contains(event.target)) {
                    addMenu.classList.remove('active');
                    document.removeEventListener('click', closeMenu);
                }
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 0);
        }
    };

    // Menu item clicks
    addMenu.querySelectorAll('.menu-item').forEach(item => {
        item.onclick = (e) => {
            e.stopPropagation();
            const action = item.dataset.action;
            addMenu.classList.remove('active');

            if (action === 'template') {
                log('Load Template not yet implemented');
                return;
            }

            // Create new node within this stack by passing parent ID
            createNode(action, -1, -1, stack.id);
        };
    });

    // Stack Loop Handle Dragging (UNIFIED with clip UX - quantum snapping + visual feedback)
    const setupStackLoopHandle = (handle, isStart) => {
        if (!handle) return;

        // Custom Cursors: [ and ] (matching clip UX)
        const cursorSvg = (isStart, text) => {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><text x="${isStart ? 4 : 12}" y="18" fill="white" font-family="monospace" font-size="20" font-weight="bold">${text}</text></svg>`;
            return `url('data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}') 12 12, col-resize`;
        };
        handle.style.cursor = cursorSvg(isStart, isStart ? '[' : ']');

        handle.onmousedown = (e) => {
            console.log('[StackLoopHandle] mousedown fired on', isStart ? 'START' : 'END', 'handle');
            e.stopPropagation();
            e.preventDefault();

            // Early return if stack is expanded (loop is bypassed, handles disabled via CSS)
            if (!wrapper.classList.contains('stack-collapsed')) {
                // console.log('[LoopHandle] Ignoring mousedown on expanded stack - loop bypassed');
                return;
            }

            const headerWaveform = wrapper.querySelector('.stack-header-waveform');
            const rect = headerWaveform.getBoundingClientRect();
            const ghost = headerWaveform.querySelector('.loop-ghost');
            const marker = headerWaveform.querySelector('.snap-marker');
            const arrow = headerWaveform.querySelector('.snap-arrow');

            // Show feedback elements
            if (ghost) ghost.style.display = 'block';
            if (marker) marker.style.display = 'block';
            if (arrow) arrow.style.display = 'block';

            // Store the stack ID for reference during drag
            const stackId = stack.id;
            let isDragging = true;

            const onMouseMove = (moveE) => {
                if (!isDragging) return;

                // Get latest stack state from stored reference
                const latestStack = wrapper._latestStack;
                if (!latestStack) return;

                // Use stack's LCM duration for proper timeline coverage
                // computedQuantum is the global quantum for snap grid, lcmDuration is full timeline length
                const duration = latestStack.lcmDuration || 1;
                const quantum = latestStack.computedQuantum || latestStack.effectiveQuantum || 1;
                if (duration <= 0 || rect.width <= 0) return;

                console.log(`[StackLoopHandle] duration=${duration}, quantum=${quantum}, rect.width=${rect.width}`);

                // 1. Raw Position (Ghost)
                let x = moveE.clientX - rect.left;
                let pctRaw = Math.max(0, Math.min(1, x / rect.width));
                if (ghost) ghost.style.left = `${pctRaw * 100}%`;

                // 2. Snapped Position (Marker)
                let samples = pctRaw * duration;
                let snappedSamples = samples;
                if (quantum > 0) {
                    snappedSamples = Math.round(samples / quantum) * quantum;
                }

                // Constraint: Prevent crossing/zero-length
                const minGap = quantum > 0 ? quantum : 1;
                if (isStart) {
                    const maxAllowed = (latestStack.loopEnd || duration) - minGap;
                    if (snappedSamples > maxAllowed) snappedSamples = maxAllowed;
                    if (snappedSamples < 0) snappedSamples = 0;
                } else {
                    const minAllowed = (latestStack.loopStart || 0) + minGap;
                    if (snappedSamples < minAllowed) snappedSamples = minAllowed;
                    if (snappedSamples > duration) snappedSamples = duration;
                }

                let pctSnap = snappedSamples / duration;
                if (marker) marker.style.left = `${pctSnap * 100}%`;

                // 3. Arrow direction and visibility
                const diff = (pctSnap - pctRaw) * rect.width;
                if (Math.abs(diff) > 4) {
                    if (arrow) {
                        arrow.style.display = 'block';
                        arrow.style.left = `${(pctRaw + (pctSnap - pctRaw) / 2) * 100}%`;
                        arrow.style.transform = `translateY(-50%) rotate(${diff > 0 ? 45 : 225}deg)`;
                    }
                    if (ghost) ghost.style.opacity = '1';
                } else {
                    if (arrow) arrow.style.display = 'none';
                    if (ghost) ghost.style.opacity = '0'; // Hide ghost when perfectly snapped
                }

                // 4. Grid Ghosts (Clear and redraw for the current duration)
                headerWaveform.querySelectorAll('.snap-point-grid').forEach(p => p.remove());
                if (quantum > 0 && (duration / quantum) < 50) { // Don't over-render
                    for (let s = 0; s <= duration; s += quantum) {
                        const gp = document.createElement('div');
                        gp.className = 'snap-point-grid';
                        gp.style.left = `${(s / duration) * 100}%`;
                        headerWaveform.appendChild(gp);
                    }
                }

                // Calculate new loop points
                let newStart = isStart ? snappedSamples : (latestStack.loopStart || 0);
                let newEnd = isStart ? (latestStack.loopEnd || duration) : snappedSamples;

                // Update loop points via native call
                callNative('setLoopPoints', stackId, Math.round(newStart), Math.round(newEnd));
            };

            const onMouseUp = () => {
                isDragging = false;
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                if (ghost) ghost.style.display = 'none';
                if (marker) marker.style.display = 'none';
                if (arrow) arrow.style.display = 'none';
                headerWaveform.querySelectorAll('.snap-point-grid').forEach(p => p.remove());
            };

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        };
    };

    setupStackLoopHandle(wrapper.querySelector('.loop-handle-start'), true);
    setupStackLoopHandle(wrapper.querySelector('.loop-handle-end'), false);

    return wrapper;
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
export async function createNode(type, x, y, parent) {
    await callNative('createNode', type, x || -1, y || -1, parent || '');
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
