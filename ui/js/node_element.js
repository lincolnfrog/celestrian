/**
 * Node Element DOM Construction
 *
 * Creates the DOM element for a clip node, including header controls,
 * waveform canvas, loop handles, and all event bindings.
 */

/**
 * Create a clip node DOM element.
 *
 * @param {Object} node - Node data from the backend state
 * @param {Object} api  - API dependency bag
 * @param {Function} api.callNative    - Backend call function
 * @param {Function} api.log           - Logging function
 * @param {Function} api.toggleRecord  - Toggle recording for a node
 * @param {Function} api.togglePlay    - Toggle playback for a node
 * @param {Function} api.toggleSolo    - Toggle solo for a node
 * @param {Function} api.renameNode    - Rename a node
 * @returns {HTMLElement} The constructed node element
 */
export function createNodeElement(node, api) {
    const { callNative, toggleRecord, togglePlay, toggleSolo, renameNode } = api;

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
