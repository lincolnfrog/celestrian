import { callNative, log } from './bridge.js';

// Drag-and-drop state
let dragState = {
    isDragging: false,
    node: null,          // The node being dragged
    nodeData: null,      // { id, type, parent, isTopLevel }
    startX: 0,
    startY: 0,
    originalIndex: -1,   // Original DOM index before drag
    currentDropIndex: -1 // Current target drop index
};

// Animation lock - prevents syncUI from interfering during FLIP animation
let isAnimatingDrop = false;

/**
 * Check if a node is currently being dragged
 */
export function isDragging(nodeId) {
    return dragState.isDragging && dragState.nodeData && dragState.nodeData.id === nodeId;
}

/**
 * Check if any drag operation is in progress
 */
export function isAnyDragActive() {
    return dragState.isDragging;
}

/**
 * Check if drop animation is in progress (used by syncUI to skip style updates)
 */
export function isDropAnimating() {
    return isAnimatingDrop;
}

/**
 * Initialize drag-and-drop for a node element
 */
export function initDragDrop(nodeElement, nodeData) {
    log('[initDragDrop] Called for:', nodeData.id, 'isTopLevel:', nodeData.isTopLevel);

    // Prevent re-initialization
    if (nodeElement.dataset.dragInitialized === 'true') {
        log('[initDragDrop] Already initialized, skipping');
        return;
    }

    const grabHandle = nodeElement.querySelector('.grab-handle');
    if (!grabHandle) {
        log('[initDragDrop] No grab handle found!');
        // Don't set the flag - allow retry on next call
        return;
    }

    log('[initDragDrop] Attaching mousedown listener');
    grabHandle.addEventListener('mousedown', (e) => {
        log('[Drag Start] Mouse down on grab handle');
        e.preventDefault();
        e.stopPropagation();

        startDrag(nodeElement, nodeData, e.pageX, e.pageY);
    });

    // Only set flag AFTER successfully attaching listener
    nodeElement.dataset.dragInitialized = 'true';
}

function startDrag(nodeElement, nodeData, startX, startY) {
    dragState.isDragging = true;
    dragState.node = nodeElement;
    dragState.nodeData = nodeData;
    dragState.startX = startX;
    dragState.startY = startY;
    dragState.currentDropIndex = -1;

    // Store initial element position for offset calculation
    const rect = nodeElement.getBoundingClientRect();
    dragState.offsetX = startX - rect.left;
    dragState.offsetY = startY - rect.top;

    // For top-level elements, store original position
    if (nodeData.isTopLevel) {
        dragState.originalLeft = parseFloat(nodeElement.style.left) || 0;
        dragState.originalTop = parseFloat(nodeElement.style.top) || 0;
    }

    // Store original index in parent for stack children
    if (!nodeData.isTopLevel) {
        const parent = nodeElement.parentElement;
        if (parent) {
            const siblings = Array.from(parent.querySelectorAll('.node'));
            dragState.originalIndex = siblings.indexOf(nodeElement);
        }
    }

    // Add dragging class
    nodeElement.classList.add('dragging');

    // Add global handlers
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
    if (!dragState.isDragging) return;

    // For top-level elements: update absolute position to follow cursor
    if (dragState.nodeData.isTopLevel && dragState.node) {
        const newLeft = dragState.originalLeft + (e.pageX - dragState.startX);
        const newTop = dragState.originalTop + (e.pageY - dragState.startY);
        dragState.node.style.left = `${newLeft}px`;
        dragState.node.style.top = `${newTop}px`;
    }

    // For clips inside stacks: use transform for visual feedback
    if (!dragState.nodeData.isTopLevel && dragState.node) {
        const deltaY = e.pageY - dragState.startY;
        dragState.node.style.transform = `translateY(${deltaY}px)`;
    }

    // Find drop target and update visual indicators (use clientX/Y for elementFromPoint)
    const dropTarget = findDropTarget(e.clientX, e.clientY);
    updateDropIndicators(dropTarget);

    // Track current drop index for when we release
    if (dropTarget && dropTarget.type === 'reorder') {
        dragState.currentDropIndex = dropTarget.index;
    } else {
        dragState.currentDropIndex = -1;
    }
}

function onDragEnd(e) {
    if (!dragState.isDragging) return;

    // Calculate if we actually moved (minimum threshold to count as a drag)
    const deltaX = Math.abs(e.pageX - dragState.startX);
    const deltaY = Math.abs(e.pageY - dragState.startY);
    const didMove = deltaX > 5 || deltaY > 5;

    // Find drop target only if we actually moved
    const dropTarget = didMove ? findDropTarget(e.clientX, e.clientY) : null;

    // Determine if we should do DOM reorder
    const shouldReorder = !dragState.nodeData.isTopLevel && dropTarget && dropTarget.type === 'reorder';

    if (shouldReorder) {
        const parentContainer = document.querySelector(`#stack-wrapper-${dropTarget.parentId} .stack-children`);
        if (parentContainer && dragState.node) {
            // STEP 1: Capture current visual positions of ALL clips (including dragged)
            const allClips = Array.from(parentContainer.querySelectorAll('.node'));
            const visualPositions = new Map();
            allClips.forEach(clip => {
                const rect = clip.getBoundingClientRect();
                visualPositions.set(clip, rect.top);
            });

            // STEP 2: Do the DOM reorder
            const clips = Array.from(parentContainer.querySelectorAll('.node:not(.dragging)'));
            const targetIndex = dropTarget.index;

            log(`[Drop] Reordering to index ${targetIndex}`);

            // Remove dragged clip from current position
            if (dragState.node.parentElement === parentContainer) {
                parentContainer.removeChild(dragState.node);
            }

            // Insert at new position
            const remainingClips = Array.from(parentContainer.querySelectorAll('.node'));
            if (targetIndex >= remainingClips.length) {
                parentContainer.appendChild(dragState.node);
            } else {
                const referenceNode = remainingClips[targetIndex];
                parentContainer.insertBefore(dragState.node, referenceNode || null);
            }

            // STEP 3: Clear all transforms and force layout to get new natural positions
            allClips.forEach(clip => {
                clip.style.transition = 'none';
                clip.style.transform = '';
            });
            // Also clear dragging class to get true natural positions
            dragState.node.classList.remove('dragging');
            dragState.node.style.zIndex = '';
            dragState.node.style.visibility = '';

            // Force layout recalculation
            parentContainer.offsetHeight;

            // STEP 4: Calculate inverse transforms to maintain old visual positions
            allClips.forEach(clip => {
                const oldVisual = visualPositions.get(clip);
                const newRect = clip.getBoundingClientRect();
                const delta = oldVisual - newRect.top;

                if (Math.abs(delta) > 1) {
                    clip.style.transform = `translateY(${delta}px)`;
                }
            });

            // LOCK: Prevent syncUI from overriding transforms during animation
            isAnimatingDrop = true;

            // STEP 5: Animate to zero (final positions)
            requestAnimationFrame(() => {
                allClips.forEach(clip => {
                    clip.style.transition = 'transform 0.15s ease-out';
                    clip.style.transform = '';
                });

                // Clean up after animation and UNLOCK
                setTimeout(() => {
                    allClips.forEach(clip => {
                        clip.style.transition = '';
                    });
                    isAnimatingDrop = false;  // UNLOCK
                }, 160);
            });

            // Notify backend of new order
            handleDrop(dropTarget);
        }
    } else {
        // No reorder - just clear everything
        if (dragState.node) {
            dragState.node.classList.remove('dragging');
            dragState.node.style.zIndex = '';
            dragState.node.style.visibility = '';
        }
        clearSlideTransforms();

        if (dropTarget) {
            handleDrop(dropTarget);
        }
    }

    // Reset for next drag
    previousDropIndex = -1;
    clearDropIndicators();

    // Remove global handlers
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);

    // Reset state
    dragState.isDragging = false;
    dragState.node = null;
    dragState.nodeData = null;
    dragState.originalIndex = -1;
    dragState.currentDropIndex = -1;
}


function findDropTarget(x, y) {
    // Temporarily hide the dragged element to find what's underneath
    if (dragState.node) {
        dragState.node.style.pointerEvents = 'none';
    }

    const target = document.elementFromPoint(x, y);

    if (dragState.node) {
        dragState.node.style.pointerEvents = '';
    }

    if (!target) return null;

    // Check if hovering over a specific clip (for zone detection)
    const clipNode = target.closest('.node:not(.dragging)');
    if (clipNode && !dragState.nodeData.isTopLevel) {
        const zone = getDropZone(clipNode, y);

        if (zone === 'center') {
            // Center zone = combine into stack
            return {
                type: 'combine',
                targetId: clipNode.id,
                element: clipNode
            };
        }
        // Top/bottom zones fall through to reorder logic below
    }

    // Check if dropping on a stack (for drop INTO stack)
    const stackWrapper = target.closest('.stack-wrapper');
    const childrenContainer = target.closest('.stack-children');

    // If hovering over stack-header-waveform or empty space, allow drop INTO stack
    if (stackWrapper && !childrenContainer && !dragState.nodeData.isTopLevel) {
        // Check if this is the same parent - if so, ignore
        const stackId = stackWrapper.id.replace('stack-wrapper-', '');
        if (dragState.nodeData.parent !== stackId) {
            return {
                type: 'stack',
                element: stackWrapper,
                stackId: stackId
            };
        }
    }

    // Check for reorder within stack (top/bottom zones only)
    if (childrenContainer && !dragState.nodeData.isTopLevel) {
        // Get clips excluding the one being dragged
        const clipNodes = Array.from(childrenContainer.querySelectorAll('.node:not(.dragging)'));
        const dropResult = findInsertIndexWithZone(clipNodes, y);

        if (dropResult.zone === 'center') {
            // In center zone of a clip - return combine target
            return {
                type: 'combine',
                targetId: dropResult.clipId,
                element: dropResult.clipElement
            };
        }

        return {
            type: 'reorder',
            parentId: childrenContainer.closest('.stack-wrapper').id.replace('stack-wrapper-', ''),
            index: dropResult.index,
            container: childrenContainer
        };
    }

    return null;
}

/**
 * Get the drop zone (top/center/bottom third) for a clip
 */
function getDropZone(clipElement, mouseY) {
    const rect = clipElement.getBoundingClientRect();
    const relativeY = mouseY - rect.top;
    const height = rect.height;

    if (relativeY < height * 0.33) return 'top';
    if (relativeY > height * 0.67) return 'bottom';
    return 'center';
}

/**
 * Find insert index, but also return zone info for center detection
 */
function findInsertIndexWithZone(elements, y) {
    for (let i = 0; i < elements.length; i++) {
        const rect = elements[i].getBoundingClientRect();
        const relativeY = y - rect.top;
        const height = rect.height;

        // Top third - insert before this element
        if (relativeY < height * 0.33) {
            return { index: i, zone: 'top', clipId: null, clipElement: null };
        }

        // Center third - combine with this element
        if (relativeY <= height * 0.67) {
            return {
                index: i,
                zone: 'center',
                clipId: elements[i].id,
                clipElement: elements[i]
            };
        }

        // Bottom third of last element - insert after
        if (i === elements.length - 1) {
            return { index: elements.length, zone: 'bottom', clipId: null, clipElement: null };
        }

        // Bottom third - check if we're in the gap before next element
        // If cursor is past 67% of this element but not yet in next element's top third,
        // treat as insert after this element
        if (i < elements.length - 1) {
            const nextRect = elements[i + 1].getBoundingClientRect();
            if (y < nextRect.top + nextRect.height * 0.33) {
                return { index: i + 1, zone: 'bottom', clipId: null, clipElement: null };
            }
        }
    }

    return { index: elements.length, zone: 'bottom', clipId: null, clipElement: null };
}

function findInsertIndex(elements, y) {
    // Simple version for backwards compatibility
    const result = findInsertIndexWithZone(elements, y);
    return result.index;
}

// Track previous drop target to avoid clearing transforms on every mousemove
let previousDropIndex = -1;

function updateDropIndicators(dropTarget) {
    // Clear all drop indicators
    document.querySelectorAll('.drag-over').forEach(el => {
        el.classList.remove('drag-over');
    });
    document.querySelectorAll('.drop-zone-center').forEach(el => {
        el.classList.remove('drop-zone-center');
    });

    if (!dropTarget) {
        if (previousDropIndex !== -1) {
            clearSlideTransforms();
            previousDropIndex = -1;
        }
        return;
    }

    if (dropTarget.type === 'combine') {
        // Highlight the target clip for combining
        dropTarget.element.classList.add('drop-zone-center');
        if (previousDropIndex !== -1) {
            clearSlideTransforms();
            previousDropIndex = -1;
        }
    } else if (dropTarget.type === 'stack') {
        dropTarget.element.classList.add('drag-over');
        if (previousDropIndex !== -1) {
            clearSlideTransforms();
            previousDropIndex = -1;
        }
    } else if (dropTarget.type === 'reorder' && dropTarget.container) {
        // Only update if drop index changed
        if (dropTarget.index === previousDropIndex) {
            return;
        }

        const origIdx = dragState.originalIndex;
        const targetIdx = dropTarget.index;

        // Skip slide animation if we're at the original position
        if (targetIdx === origIdx) {
            if (previousDropIndex !== -1 && previousDropIndex !== origIdx) {
                clearSlideTransforms();
            }
            previousDropIndex = targetIdx;
            return;
        }

        previousDropIndex = targetIdx;

        // Get sibling clips (excluding the one being dragged)
        const clips = Array.from(dropTarget.container.querySelectorAll('.node:not(.dragging)'));

        // Calculate clip height dynamically
        // Spacing = CSS gap (16px) + marginBottom applied by syncUI (12px) = 28px
        const draggedRect = dragState.node.getBoundingClientRect();
        const clipHeight = draggedRect.height + 28;  // height + total spacing

        // Slide siblings to make room
        clips.forEach((clip, index) => {
            clip.style.transition = 'transform 0.15s ease-out';

            if (targetIdx > origIdx) {
                // Dragging DOWN: items between old and new position slide UP
                if (index >= origIdx && index < targetIdx) {
                    clip.style.transform = `translateY(-${clipHeight}px)`;
                } else {
                    clip.style.transform = '';
                }
            } else {
                // Dragging UP: items between new and old position slide DOWN
                if (index >= targetIdx && index < origIdx) {
                    clip.style.transform = `translateY(${clipHeight}px)`;
                } else {
                    clip.style.transform = '';
                }
            }
        });
    }
}

function clearDropIndicators() {
    document.querySelectorAll('.drag-over').forEach(el => {
        el.classList.remove('drag-over');
    });
    document.querySelectorAll('.drop-zone-center').forEach(el => {
        el.classList.remove('drop-zone-center');
    });
}

function clearSlideTransforms() {
    document.querySelectorAll('.stack-children .node:not(.dragging)').forEach(el => {
        el.style.transition = 'transform 0.15s ease-out';
        el.style.transform = '';
    });
}

async function handleDrop(dropTarget) {
    const { id, type, parent, isTopLevel } = dragState.nodeData;

    // Top-level stacks: commit position change
    if (isTopLevel && dragState.node) {
        const newLeft = parseFloat(dragState.node.style.left) || 0;
        const newTop = parseFloat(dragState.node.style.top) || 0;
        await callNative('setNodePosition', id, newLeft, newTop);
        return;
    }

    // Stack children: handle moves/reorders
    if (dropTarget.type === 'stack') {
        // Move to different stack (append to end)
        if (parent !== dropTarget.stackId) {
            const stackChildren = document.querySelector(`#stack-wrapper-${dropTarget.stackId} .stack-children`);
            const numChildren = stackChildren ? stackChildren.querySelectorAll('.node').length : 0;
            await callNative('reorderNode', id, dropTarget.stackId, numChildren);
        }
    } else if (dropTarget.type === 'reorder') {
        // Reorder within same stack - pass index directly
        log(`[handleDrop] Reordering ${id} to index ${dropTarget.index} in parent ${dropTarget.parentId}`);
        await callNative('reorderNode', id, dropTarget.parentId, dropTarget.index);
    } else if (dropTarget.type === 'combine') {
        // Combine dragged clip with target clip into a new stack
        log(`[handleDrop] Combining ${id} with ${dropTarget.targetId}`);
        await callNative('combineNodes', id, dropTarget.targetId);
    }
}
