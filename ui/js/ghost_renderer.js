/**
 * Ghost Repetition Renderer
 *
 * Renders faded "ghost" copies of looping clips to visualize the full
 * LCM timeline. Each stack is processed independently — its children's
 * durations are combined via LCM to determine the timeline extent, and
 * ghosts fill every position except where the main clip sits.
 */

import { lcm } from './math_utils.js';
import { drawWaveform } from './canvas_renderer.js';

/**
 * Calculate LCM for a stack's children (recursive for nested stacks).
 *
 * @param {Array} stackNodes - The stack's child node list
 * @param {number} effectiveQ - The global quantum
 * @returns {number} The LCM duration for this stack
 */
export function calculateStackLCM(stackNodes, effectiveQ) {
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

/**
 * Render ghost repetitions for all stacks and top-level clips.
 *
 * @param {Object} opts
 * @param {Array}  opts.stacks       - Top-level stack node data
 * @param {Array}  opts.clips        - Top-level clip node data (not in stacks)
 * @param {number} opts.effectiveQ   - Global quantum (samples)
 * @param {number} opts.baseWidth    - Pixels per quantum (200)
 * @param {Element} opts.nodeLayer   - The DOM container for ghost elements
 * @param {Map}    opts.livePeaks    - Map of nodeId → peak arrays
 * @param {number} opts.masterPos    - Current transport position (samples)
 * @param {Object} opts.viewport     - Viewport instance (for scale)
 * @param {number} opts.VISUAL_OFFSET - Pixel offset for rendering
 * @param {Function} opts.log        - Logging function
 * @returns {number} maxX — the rightmost pixel extent (for viewport bounds)
 */
export function renderGhosts({
    stacks, clips, effectiveQ, baseWidth,
    nodeLayer, livePeaks, masterPos,
    viewport, VISUAL_OFFSET, log
}) {
    let maxX = -Infinity;

    // Clean up old ghosts
    nodeLayer.querySelectorAll('.ghost-clip').forEach(g => g.remove());

    // Render ghost repetitions only if effectiveQ is established
    log(`[Ghost] effectiveQ=${effectiveQ}, stacks.length=${stacks.length}, clips.length=${clips.length}`);

    if (effectiveQ <= 1) return maxX;

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

            // One-shots don't get ghosts
            if (isOneShot) {
                log(`[Ghost] Skipping ${node.id} - one-shot`);
                return;
            }

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
                    const timelinePos = masterPos % stackLCM;
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

        // For top-level clips, use their own duration as timeline (no LCM needed for single clip)
        // Top-level clips don't get right ghosts (no other clips to LCM with)
        // They only get left-wrap ghosts if needed
        maxX = Math.max(maxX, node.x + clipWidth);
    });

    return maxX;
}
