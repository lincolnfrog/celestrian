import { callNative, log } from './bridge.js';
import { drawWaveform } from './canvas_renderer.js';
import { Viewport } from './viewport.js';
import { groupNodesByVisualX, calculateButtonPosition } from './stack_logic.js';

const nodeLayer = document.getElementById('node-layer');
const creationUI = document.getElementById('creation-ui');
const creationMenu = document.getElementById('creation-menu');
const playBtn = document.getElementById('play-btn');

const livePeaks = new Map();
let viewport;
let availableInputs = [];
// Global API Hooks (Moved to top for reliable early initialization)
window.toggleCreationMenu = (e, x, y) => {
    if (e) e.stopPropagation();
    const menu = document.getElementById('creation-menu');
    const active = menu.classList.toggle('active');

    // Store spawn target for the menu items
    menu._spawnX = x;
    menu._spawnY = y;

    const btn = e ? e.currentTarget : null;
    if (btn && btn.classList.contains('btn-plus-circle')) {
        btn.style.background = '#ffffff';
        setTimeout(() => btn.style.background = '', 100);
    }
};

window.createNode = (type, x, y) => {
    const menu = document.getElementById('creation-menu');
    if (menu) menu.classList.remove('active');
    callNative('createNode', type, x || -1, y || -1);
};

window.exitBox = () => callNative('exitBox');
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
    console.log("Starting state polling loop...");
    while (true) {
        try {
            const state = await callNative('getGraphState');
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

    // Calculate the effective quantum for width scaling
    // The first clip's duration becomes the quantum, subsequent clips scale relative to it
    let effectiveQ = 1;
    nodes.forEach(n => {
        if (n.effectiveQuantum > 0) {
            effectiveQ = n.effectiveQuantum;
        }
    });
    const baseWidth = 200; // 1 quantum = 200px

    let maxY = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    // UI = Data: C++ sets x_pos based on anchor_phase
    // JS displays node.x directly with no transformation

    nodes.forEach(node => {
        let div = document.getElementById(node.id);
        if (!div) {
            div = createNodeElement(node);
            nodeLayer.appendChild(div);
        }

        // Calculate dynamic width based on clip duration relative to quantum
        // First clip (or during first recording): use base width
        // Subsequent clips: scale proportionally to quantum
        let displayWidth = node.w;

        if (node.isRecording) {
            // During recording: width grows based on recorded samples
            if (effectiveQ > 1) {
                const recordedDuration = node.duration || 0;
                // Width grows from min 20px as recording progresses
                displayWidth = Math.max(20, (recordedDuration / effectiveQ) * baseWidth);
            } else {
                displayWidth = baseWidth; // First clip: stay at base width
            }
        } else if (node.duration > 0 && effectiveQ > 1) {
            // After recording: scale based on final duration
            displayWidth = Math.max(baseWidth, (node.duration / effectiveQ) * baseWidth);
        } else {
            // New clip or collapsed: use base width (CSS hides content anyway)
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
        div.classList.toggle('collapsed', shouldCollapse);

        // UI = Data: Position comes directly from C++ data
        div.style.left = `${node.x || 0}px`;
        div.style.top = `${node.y || 0}px`;

        // Node container width: Match rhythmic duration but NEVER narrower than the header
        const nodeWidth = Math.max(260, shouldCollapse ? 0 : (displayWidth || 0));
        div.style.width = isFinite(nodeWidth) ? `${nodeWidth}px` : '260px';

        const headerH = 38;
        const contentH = Math.max(20, (node.h || 100) - headerH);

        // Final node height depends on collapsed state
        const finalNodeH = shouldCollapse ? headerH : (node.h || 100);
        div.style.height = isFinite(finalNodeH) ? `${finalNodeH}px` : '38px';

        // Content width/height
        const content = div.querySelector('.node-content');
        if (content) {
            const cWidth = isFinite(displayWidth) ? displayWidth : 200;
            content.style.width = `${cWidth}px`;
            content.style.height = `${contentH}px`;
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
        let loopStart = node.loopStart;
        let loopEnd = node.loopEnd;

        // Fallback: If loop points are not set or invalid, use full duration
        if (loopEnd <= loopStart) {
            loopStart = 0;
            loopEnd = node.duration;
        }

        const startPct = (loopStart / dur) * 100;
        const endPct = (loopEnd / dur) * 100;

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
            // Only show if clip has non-zero anchor (was recorded mid-quantum)
            launchMarker.style.display = node.anchorPhase > 0 ? 'block' : 'none';
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
            // Live waveform: Always show from index 0 and grow linearly.
            // Phase alignment is handled by C++ rotation AFTER recording completes,
            // so the live view shows the raw recording progress.
            const recordedSamples = node.duration || 0;
            const Q = node.effectiveQuantum || recordedSamples || 1;
            const numPeaksPerQ = 400;

            // Calculate index based on how much we've recorded
            const index = Math.floor((recordedSamples / Q) * numPeaksPerQ);
            const requiredSize = index + 1;

            if (!livePeaks.has(node.id)) {
                livePeaks.set(node.id, new Array(Math.max(requiredSize, numPeaksPerQ)).fill(0.01));
            }

            const peaks = livePeaks.get(node.id);

            // Grow array if needed
            if (peaks.length < requiredSize) {
                const newSize = Math.max(requiredSize, peaks.length + numPeaksPerQ);
                while (peaks.length < newSize) {
                    peaks.push(0.01);
                }
            }

            // Visibility floor: ensure we see something even in silence
            const p = node.currentPeak > 0.005 ? node.currentPeak : 0.01;
            if (index >= 0 && index < peaks.length) {
                peaks[index] = Math.max(peaks[index] || 0.01, p);
            }

            drawWaveform(div.querySelector('.node-waveform'), peaks);

            // Show quantum grid marks during recording
            // Marks at each Q boundary, positioned as percentage of current width
            const content = div.querySelector('.node-content');
            div.querySelectorAll('.recording-grid-mark').forEach(m => m.remove());
            if (Q > 0 && recordedSamples > 0) {
                const numQsRecorded = Math.floor(recordedSamples / Q);
                for (let i = 1; i <= numQsRecorded && i < 20; i++) {
                    // Mark at Q boundary i, positioned as percentage of recorded length
                    const markPct = (i * Q / recordedSamples) * 100;
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
    });

    // Ghost Repetition Rendering: Looping clips show faded repetitions
    // Show ghosts to fill timeline extent (longest clip determines width)
    let longestDuration = effectiveQ;
    nodes.forEach(n => {
        // Include recording nodes so ghosts appear as the recording grows
        if (n.duration > longestDuration) {
            longestDuration = n.duration;
        }
    });
    const timelineWidth = (longestDuration / effectiveQ) * baseWidth;

    // Clean up old ghosts
    nodeLayer.querySelectorAll('.ghost-clip').forEach(g => g.remove());

    // Render ghost repetitions only if effectiveQ is established
    if (effectiveQ > 1) {
        nodes.forEach(node => {
            if (node.isRecording || !node.duration) return;

            const clipWidth = (node.duration / effectiveQ) * baseWidth;
            const isOneShot = node.duration < effectiveQ;

            // One-shots don't get ghosts
            if (isOneShot) return;

            // Skip if this is already the longest clip (no ghosts needed)
            if (node.duration >= longestDuration) return;

            // Calculate how many ghosts fit in the remaining timeline
            const clipStartX = node.x;
            const remainingWidth = timelineWidth - clipWidth;
            // Use Math.ceil or a small epsilon to ensure we fill the timeline
            const numGhosts = Math.floor((remainingWidth + 1) / clipWidth);

            if (numGhosts > 0) {
                console.log(`[Ghost] Clip ${node.id.slice(0, 4)}: clipWidth=${clipWidth}, timelineWidth=${timelineWidth}, numGhosts=${numGhosts}`);
            }

            for (let i = 1; i <= numGhosts && i < 20; i++) {
                const ghostX = clipStartX + i * clipWidth;

                const ghost = document.createElement('div');
                ghost.className = 'ghost-clip';
                ghost.style.left = `${ghostX}px`;
                ghost.style.top = `${node.y}px`;
                ghost.style.width = `${clipWidth}px`;

                const headerHeight = 42;
                const contentHeight = Math.max(20, node.h - headerHeight);
                ghost.style.height = `${node.h}px`;

                // Keep background only for the content part? 
                // Actually ghosts are just the waveform, so they mimic .node-content
                ghost.classList.add('node-content');
                ghost.style.borderTop = '1px solid #334155';
                ghost.style.borderRadius = '8px';

                // Add faded waveform canvas
                const canvas = document.createElement('canvas');
                ghost.appendChild(canvas);

                // Draw the same waveform but faded
                if (livePeaks.has(node.id)) {
                    drawWaveform(canvas, livePeaks.get(node.id));
                }

                // Ghost Playhead
                const ghostPlayhead = document.createElement('div');
                ghostPlayhead.className = 'playhead';
                ghost.appendChild(ghostPlayhead);

                // Tracking Logic:
                // Check if global playhead is inside this ghost
                // Global Master Pos (samples) relative to Node Anchor
                // We need to convert masterPos to Visual X relative to Node X
                if (state.masterPos !== undefined && effectiveQ > 0) {
                    const pixelsPerSameple = baseWidth / effectiveQ; // 200px / Q samples

                    // Node Anchor Phase is where the node starts in the grid relative to Q
                    // node.x is purely visual based on anchor_phase
                    // Global Visual Playhead X = (masterPos wrapped?) No, linear.
                    // We need relative offset:
                    // deltaSamples = masterPos - (trigger_master_pos ?? implied_start)

                    // Simpler: state.masterPos is global transport.
                    // node.anchorPhase is local offset.
                    // We need the "Global Phase" relative to the CLIP's Loop.
                    // activeIndex = floor((masterPos - anchorAdjusted) / duration)
                    // Wait, node.anchorPhase is phase within context?

                    // Visual Approach:
                    // Main Node Start X (visual) = node.x
                    // Playhead Visual X = (masterPos % (something? No linear)) * scale?
                    // If we assume linear scrolling... but it's a loop.

                    // Let's use the local 'playhead' (0..1) as the truth.
                    // If node is playing, the playhead IS valid.
                    // Which ghost is it in?
                    // We rely on 'masterPos' effectively.

                    const qSamples = effectiveQ; // Samples per quantum
                    const clipsPerTimeline = timelineWidth / clipWidth;

                    // Relative Sample Position from the anchor
                    // anchorPhase is where in the context loop (0..MaxDuration) the clip starts.
                    // But here we just want to know "Global Time % Timeline Duration"?
                    // No, simpler:
                    // The clip repeats every 'node.duration'.
                    // offset = masterPos - (some zero reference).
                    // Let's assume Master Pos 0 aligns with Quantum 0.
                    // Clip Anchor Phase 0 aligns with Quantum 0.

                    // relativePos = (masterPos - node.recordingStartPhase??) 
                    // Use anchorPhase (which is loop-relative).
                    // If the timeline is consistent:

                    // We know the Main Node is technically at "Iteration 0" relative to... itself?
                    // Actually, if we just check if (masterPos % duration) is roughly playhead * duration...
                    // That doesn't tell us the iteration.

                    // Valid approach: 
                    // startGlobal = node.recordingStartPhase ?? 0 ? No.
                    // Let's use the visual position provided by the node. 
                    // node.x is based on anchor_phase.
                    // Global Playhead wrapped to Context Loop (e.g. 4Q).
                    // node.x is within 0..ContextLoopVisual.

                    // Wait, ghost rendering is for "filling timeline extent". 
                    // Does the timeline imply a linear scroll or a wrapped view?
                    // User says "longer clips".
                    // Implies Context Loop logic.
                    // The "Timeline" is effectively the duration of the LONGEST clip.
                    // Ghosts fill the Longest Clip.

                    // So:
                    // contextDuration = longestDuration.
                    // playheadOffset = (masterPos % contextDuration).
                    // We want to find which Visual Block (Main or Ghost N) overlaps with `playheadOffset`.
                    // Main Block X range: [node.x, node.x + node.w] (wrapped?)
                    // Ghost N X range: [node.x + N*w, ...]

                    // Calculate Global Visual Cursor X relative to Timeline Start (0)
                    const globalCursorSamples = state.masterPos % longestDuration;
                    const globalCursorPx = (globalCursorSamples / effectiveQ) * baseWidth;

                    // Check if cursor is in this ghost
                    // ghostX is relative to container (0..TimelineWidth)
                    // If (globalCursorPx >= ghostX && globalCursorPx < ghostX + clipWidth)
                    if (globalCursorPx >= ghostX && globalCursorPx < ghostX + clipWidth) {
                        ghost.classList.add('active-ghost');
                        ghostPlayhead.style.left = `${node.playhead * 100}%`;

                        // Hide main node playhead since we are in a ghost
                        const mainPlayhead = div.querySelector('.playhead');
                        if (mainPlayhead) mainPlayhead.style.display = 'none';
                    }
                }

                nodeLayer.appendChild(ghost);
            }
        });
    }

    // 0. Stability Sort: Ensure anchor selection is identical across polls
    const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));

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
        const nextLeft = `${stackX + 84}px`;
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

    // Removal check
    uiNodeIds.forEach(id => {
        if (!newNodeIds.includes(id)) {
            const el = document.getElementById(id);
            if (el && !el.classList.contains('stack-btn')) {
                el.remove();
                livePeaks.delete(id);
            }
        }
    });
}

function createNodeElement(node) {
    const div = document.createElement('div');
    div.id = node.id;
    div.className = `node ${node.type}`;
    div.innerHTML = `
        <div class="node-header">
            <input class="node-name-input" value="${node.name}" />
            <span class="peak-debug" style="font-size: 9px; color: #10b981; opacity: 0.6; pointer-events: none; width: 44px; text-align: right; padding-right: 4px; font-family: monospace;"></span>
            
            <div class="node-btn-mute">M</div>
            <div class="node-btn-solo">S</div>
            <div class="node-btn-record">
                <div class="record-dot"></div>
            </div>
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

    div.querySelector('.node-btn-record').onmousedown = (e) => {
        e.stopPropagation();
        toggleRecord(node.id);
    };

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

    div.ondblclick = (e) => {
        if (e.target.tagName !== 'INPUT') {
            e.stopPropagation();
            if (node.type === 'box') enterBox(node.id);
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
export async function createNode(type, x, y) {
    creationMenu.classList.remove('active');
    const spawnX = (x !== undefined) ? x : creationMenu._spawnX;
    const spawnY = (y !== undefined) ? y : creationMenu._spawnY;
    await callNative('createNode', type, spawnX || -1, spawnY || -1);
}
export async function enterBox(id) {
    await callNative('enterBox', id);
    nodeLayer.innerHTML = '';
    viewport.reset();
}
export async function togglePlay(id) { await callNative('togglePlay', id); }
export async function toggleSolo(id) { await callNative('toggleSolo', id); }

export async function exitBox() {
    await callNative('exitBox');
    nodeLayer.innerHTML = '';
}
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
        const peaks = await callNative('getWaveform', id, 200);
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
