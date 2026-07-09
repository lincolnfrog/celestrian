/**
 * Stack Element DOM Construction
 *
 * Creates the DOM element for a stack wrapper, including expand/collapse
 * handle, header waveform, loop handles, add menu, and child container.
 */

/**
 * Create a stack wrapper DOM element.
 *
 * @param {Object} stack - Stack node data from the backend state
 * @param {Object} api   - API dependency bag
 * @param {Function} api.callNative         - Backend call function
 * @param {Function} api.log                - Logging function
 * @param {Function} api.toggleStackExpand  - Toggle stack expand/collapse
 * @param {Function} api.createNode         - Create a new node
 * @returns {HTMLElement} The constructed stack wrapper element
 */
export function createStackWrapper(stack, api) {
    const { callNative, log, toggleStackExpand, createNode } = api;

    const wrapper = document.createElement('div');
    wrapper.id = `stack-wrapper-${stack.id}`;
    wrapper.className = 'stack-wrapper';
    // Position is set via CSS and updated in syncUI

    wrapper.innerHTML = `
        <div class="grab-handle" title="Drag to reorder"></div>
        <div class="stack-expand-handle" data-stack-id="${stack.id}"></div>
        <div class="loop-window-toggle" data-stack-id="${stack.id}"
             title="Toggle loop window active/bypassed (docs/time_maps.md)">⟳</div>
        <div class="stack-header-waveform">
            <canvas class="stack-waveform-canvas"></canvas>
            <div class="stack-playhead"></div>
            <!-- Loop region UI (same as clips - hierarchical design) -->
            <div class="loop-handle-start" title="Drag to adjust loop start"></div>
            <div class="loop-handle-end" title="Drag to adjust loop end"></div>
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

    // Loop window active/bypassed toggle (time_maps.md): activation is
    // DATA — expansion no longer changes whether the window applies.
    const loopToggle = wrapper.querySelector('.loop-window-toggle');
    loopToggle.onclick = async (e) => {
        e.stopPropagation();
        await callNative('toggleLoopWindow', stack.id);
        log(`Toggled loop window for ${stack.id}`);
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
            createNode(action, stack.id);
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

            // Loop handles are editable in ANY view state (time_maps.md:
            // the window is data; expansion is purely visual).
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
                    if (ghost) ghost.style.opacity = '0';
                }

                // 4. Grid Ghosts
                headerWaveform.querySelectorAll('.snap-point-grid').forEach(p => p.remove());
                if (quantum > 0 && (duration / quantum) < 50) {
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
