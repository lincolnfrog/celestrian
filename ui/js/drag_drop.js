import { callNative, log } from './bridge.js';

// Drag-and-drop state
let dragState = {
    isDragging: false,
    node: null,          // The node being dragged
    nodeData: null,      // { id, type, parent, isTopLevel }
    startX: 0,
    startY: 0,
    ghost: null          // Ghost preview element
};

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
    nodeElement.dataset.dragInitialized = 'true';

    const grabHandle = nodeElement.querySelector('.grab-handle');
    if (!grabHandle) {
        log('[initDragDrop] No grab handle found!');
        return;
    }

    log('[initDragDrop] Attaching mousedown listener');
    grabHandle.addEventListener('mousedown', (e) => {
        log('[Drag Start] Mouse down on grab handle');
        e.preventDefault();
        e.stopPropagation();

        startDrag(nodeElement, nodeData, e.pageX, e.pageY);
    });
}

function startDrag(nodeElement, nodeData, startX, startY) {
    dragState.isDragging = true;
    dragState.node = nodeElement;
    dragState.nodeData = nodeData;
    dragState.startX = startX;
    dragState.startY = startY;

    // Store initial element position for offset calculation
    const rect = nodeElement.getBoundingClientRect();
    dragState.offsetX = startX - rect.left;
    dragState.offsetY = startY - rect.top;

    // For top-level elements, store original position
    if (nodeData.isTopLevel) {
        dragState.originalLeft = parseFloat(nodeElement.style.left) || 0;
        dragState.originalTop = parseFloat(nodeElement.style.top) || 0;
    }

    // Add dragging class (keeps element visible, changes cursor)
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

    // Find drop target
    const dropTarget = findDropTarget(e.pageX, e.pageY);

    // Update drop indicators
    updateDropIndicators(dropTarget);

    // Dynamic reordering preview for clips in stacks
    if (dropTarget && dropTarget.type === 'reorder' && dragState.node && !dragState.nodeData.isTopLevel) {
        const parentContainer = document.querySelector(`#stack-wrapper-${dropTarget.parentId} .stack-children`);
        if (parentContainer) {
            const clips = Array.from(parentContainer.querySelectorAll('.node'));
            const currentIndex = clips.indexOf(dragState.node);
            const targetIndex = dropTarget.index;

            // Only reorder if different position
            if (currentIndex !== -1 && currentIndex !== targetIndex) {
                if (targetIndex >= clips.length) {
                    parentContainer.appendChild(dragState.node);
                } else {
                    const referenceNode = clips[targetIndex];
                    if (referenceNode && referenceNode !== dragState.node) {
                        parentContainer.insertBefore(dragState.node, referenceNode);
                    }
                }
            }
        }
    }
}

function onDragEnd(e) {
    if (!dragState.isDragging) return;

    // Remove dragging class
    if (dragState.node) {
        dragState.node.classList.remove('dragging');
    }

    // Handle drop
    const dropTarget = findDropTarget(e.pageX, e.pageY);
    if (dropTarget) {
        handleDrop(dropTarget);
    }

    // Clear drop indicators
    clearDropIndicators();

    // Remove global handlers
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);

    // Reset state
    dragState.isDragging = false;
    dragState.node = null;
    dragState.nodeData = null;
}

function findDropTarget(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target) return null;

    // Check if dropping on a stack wrapper
    const stackWrapper = target.closest('.stack-wrapper');
    if (stackWrapper && !dragState.nodeData.isTopLevel) {
        // Can drop clips into stacks
        return {
            type: 'stack',
            element: stackWrapper,
            stackId: stackWrapper.id.replace('stack-wrapper-', '')
        };
    }

    // Check if dropping between clips in a stack
    const childrenContainer = target.closest('.stack-children');
    if (childrenContainer && !dragState.nodeData.isTopLevel) {
        const clipNodes = Array.from(childrenContainer.querySelectorAll('.node.clip'));
        const dropIndex = findInsertIndex(clipNodes, y);
        return {
            type: 'reorder',
            parentId: childrenContainer.closest('.stack-wrapper').id.replace('stack-wrapper-', ''),
            index: dropIndex
        };
    }

    return null;
}

function findInsertIndex(elements, y) {
    for (let i = 0; i < elements.length; i++) {
        const rect = elements[i].getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
            return i;
        }
    }
    return elements.length;
}

function updateDropIndicators(dropTarget) {
    // Clear existing indicators
    clearDropIndicators();

    if (!dropTarget) return;

    if (dropTarget.type === 'stack') {
        dropTarget.element.classList.add('drag-over');
    }
    // TODO: Add insert marker for reorder
}

function clearDropIndicators() {
    document.querySelectorAll('.drag-over').forEach(el => {
        el.classList.remove('drag-over');
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
        // Move to different stack
        if (parent !== dropTarget.stackId) {
            await callNative('moveNode', id, dropTarget.stackId, 0);
        }
    } else if (dropTarget.type === 'reorder') {
        // Reorder within same stack
        const newY = dropTarget.index * 120; // 120px spacing per clip
        await callNative('moveNode', id, dropTarget.parentId, newY);
    }
}
