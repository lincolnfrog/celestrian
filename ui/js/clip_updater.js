/**
 * Clip State Updater
 *
 * Updates the DOM state for all clips — position, size, waveform,
 * playhead, loop handles, button states, input selection, and
 * live recording peaks. Called once per sync cycle from syncUI.
 */

import { drawWaveform } from './canvas_renderer.js';
import { isDragging, initDragDrop } from './drag_drop.js';

/**
 * Update all clips' DOM state for the current sync cycle.
 *
 * @param {Object} ctx - Context from syncUI
 * @param {Array}  ctx.allClips       - All clip nodes to update (top-level + nested)
 * @param {Array}  ctx.clips          - Top-level clips only (for isStackChild detection)
 * @param {Array}  ctx.stacks         - Stack node data
 * @param {number} ctx.effectiveQ     - Global quantum (samples)
 * @param {number} ctx.baseWidth      - Pixels per quantum (200)
 * @param {number} ctx.VISUAL_OFFSET  - Pixel offset for rendering
 * @param {Object} ctx.state          - The full state from backend
 * @param {Map}    ctx.livePeaks      - Map of nodeId → peak arrays
 * @param {Array}  ctx.availableInputs - Available audio input names
 * @param {Element} ctx.nodeLayer     - DOM container
 * @param {Function} ctx.log          - Logging function
 * @param {Function} ctx.fetchWaveform - Fetch static waveform data
 * @param {Function} ctx.createNodeElement - Create a new node DOM element
 * @param {Object} ctx.api            - API bag for createNodeElement
 * @returns {{ maxX: number, maxY: number, minX: number }} Updated viewport bounds
 */
export function updateAllClips(ctx) {
    const {
        allClips, clips, stacks, effectiveQ, baseWidth,
        VISUAL_OFFSET, state, livePeaks, availableInputs,
        nodeLayer, log, fetchWaveform, createNodeElement, api
    } = ctx;

    let maxY = 0;
    let minX = Infinity;
    let maxX = -Infinity;

    allClips.forEach(node => {
        let div = document.getElementById(node.id);
        if (!div) {
            // For top-level clips only, create and append
            if (clips.includes(node)) {
                div = createNodeElement(node, api);
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
            }
        } else if (node.duration > 0 && !isPreQuantum) {
            displayWidth = (node.duration / effectiveQ) * baseWidth;
        } else if (node.duration > 0) {
            displayWidth = baseWidth;
        } else {
            displayWidth = baseWidth;
        }

        // Detect one-shot (for visual styling only)
        const clipDuration = node.duration || effectiveQ;
        const isOneShot = effectiveQ > 1 && clipDuration < effectiveQ;
        div.classList.toggle('one-shot', isOneShot);

        // Collapsed clip: host waveform area logic
        const isActivelyRecording = node.isRecording && !node.isPendingStart;
        const hasRecordedAudio = (node.duration || 0) > 10 && !node.isPendingStart;
        const shouldCollapse = !isActivelyRecording && !hasRecordedAudio;
        const isStackChild = !clips.includes(node);

        // Skip position/size updates for nodes being dragged
        const nodeIsBeingDragged = isDragging(node.id);

        // UI = Data: Position comes directly from C++ data
        if (!isStackChild && !nodeIsBeingDragged) {
            div.style.left = `${(node.x || 0) + VISUAL_OFFSET}px`;
            div.style.top = `${node.y || 0}px`;
        }

        // Node container width
        const nodeWidth = Math.max(260, shouldCollapse ? 0 : (displayWidth || 0));
        if (!isStackChild) {
            div.style.width = isFinite(nodeWidth) ? `${nodeWidth}px` : '260px';
        }

        const headerH = 38;
        const contentH = Math.max(20, (node.h || 100) - headerH);

        const finalNodeH = shouldCollapse ? headerH : (node.h || 100);
        if (!isStackChild) {
            div.style.height = isFinite(finalNodeH) ? `${finalNodeH}px` : '38px';
        }

        // Content width/height
        const content = div.querySelector('.node-content');
        if (content && !nodeIsBeingDragged) {
            const cWidth = isFinite(displayWidth) ? displayWidth : 200;
            content.style.width = `${cWidth}px`;
            content.style.height = `${contentH}px`;

            if (isStackChild && node.x > 0) {
                content.style.transform = `translateX(${node.x}px)`;
            } else if (!isStackChild) {
                content.style.transform = 'none';
            }
        }

        maxY = Math.max(maxY, node.y + node.h);
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x + displayWidth);

        node._visualX = node.x;
        div._latestNode = node;

        const playhead = div.querySelector('.playhead');
        playhead.style.left = `${node.playhead * 100}%`;
        playhead.style.display = node.isPlaying ? 'block' : 'none';

        // Loop Handles & Dim Layers
        const dur = node.duration || 1;
        let loopStart = node.loopStart || 0;
        let loopEnd = node.loopEnd || dur;

        if (loopEnd <= loopStart) {
            loopStart = 0;
            loopEnd = dur;
        }

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

        // Update launch marker
        const launchMarker = div.querySelector('.launch-marker');
        if (launchMarker && dur > 0) {
            const launchPct = ((node.launchPoint || 0) / dur) * 100;
            launchMarker.style.left = `${launchPct}%`;
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
            peakInfo.innerText = pVal.toFixed(4);
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

            recBtn.classList.toggle('active', node.isRecording && !node.isAwaitingStop);
            recBtn.classList.toggle('pending', isPending);
            playBtn.classList.toggle('active', node.isPlaying);
        }

        const muteBtn = div.querySelector('.node-btn-mute');
        if (muteBtn) {
            muteBtn.classList.toggle('active', node.isMuted);
        }

        if (soloBtn) {
            const isSoloed = state.soloedId === node.id;
            soloBtn.classList.toggle('active', isSoloed);
        }

        div.classList.toggle('muted', node.isMuted);

        // Log recording state change
        if (node.isRecording !== div._last_rec_state) {
            log(`Node ${node.id} isRecording: ${node.isRecording}`);
            div._last_rec_state = node.isRecording;
        }

        if (node.isRecording) {
            // Live waveform: Dual-mode peak allocation
            const recordedSamples = node.duration || 0;

            let samplesPerPeak;
            if (effectiveQ > 1) {
                samplesPerPeak = effectiveQ / 400;
            } else {
                samplesPerPeak = 110;
            }

            const index = Math.floor(recordedSamples / samplesPerPeak);
            const requiredSize = index + 1;

            if (!livePeaks.has(node.id)) {
                livePeaks.set(node.id, new Array(Math.max(requiredSize, 400)).fill(0.01));
            }

            const peaks = livePeaks.get(node.id);

            if (peaks.length < requiredSize) {
                const newSize = Math.max(requiredSize, peaks.length + 400);
                while (peaks.length < newSize) {
                    peaks.push(0.01);
                }
            }

            const p = node.currentPeak > 0.005 ? node.currentPeak : 0.01;
            if (index >= 0 && index < peaks.length) {
                peaks[index] = Math.max(peaks[index] || 0.01, p);
            }

            const validPeaks = peaks.slice(0, index + 1);

            const fixedStep = (effectiveQ > 1) ? (baseWidth / 400) : null;
            drawWaveform(div.querySelector('.node-waveform'), validPeaks, fixedStep);

            // Show quantum grid marks during recording
            const contentForGrid = div.querySelector('.node-content');
            div.querySelectorAll('.recording-grid-mark').forEach(m => m.remove());
            if (effectiveQ > 1 && recordedSamples > 0) {
                const numQsRecorded = Math.floor(recordedSamples / effectiveQ);
                for (let i = 1; i <= numQsRecorded && i < 20; i++) {
                    const markPct = (i * effectiveQ / recordedSamples) * 100;
                    const mark = document.createElement('div');
                    mark.className = 'recording-grid-mark snap-point-grid';
                    mark.style.left = `${markPct}%`;
                    contentForGrid.appendChild(mark);
                }
            }
        }
        else if (node.duration > 0) {
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

    return { maxX, maxY, minX };
}
