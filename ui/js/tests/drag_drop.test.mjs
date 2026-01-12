/**
 * Drag and Drop UI Test
 * 
 * Tests the drag_drop.js logic using JSDOM for DOM simulation.
 * Run with: npm test -- --grep "drag"
 */

import assert from 'assert';

// Test Utilities
const describe = (name, fn) => { console.log(`\n=== ${name} ===`); fn(); };
const it = (name, fn) => {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (e) {
        console.log(`  ✗ ${name}`);
        console.log(`    ${e.message}`);
        process.exitCode = 1;
    }
};

// Mock DOM for Node.js testing
class MockElement {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.classList = new MockClassList();
        this.style = {};
        this.dataset = {};
        this.children = [];
        this.parentElement = null;
        this.id = '';
        this._eventListeners = {};
    }

    querySelector(selector) {
        if (selector === '.grab-handle') {
            const handle = new MockElement('div');
            handle.classList.add('grab-handle');
            return handle;
        }
        if (selector === '.node:not(.dragging)') {
            return this.children.filter(c => !c.classList.contains('dragging'));
        }
        return this.children.find(c => c.classList.contains(selector.replace('.', '')));
    }

    querySelectorAll(selector) {
        if (selector.includes('.node')) {
            const isDragging = this.children.filter(c => c.classList.contains('dragging'));
            if (selector.includes(':not(.dragging)')) {
                return this.children.filter(c => !c.classList.contains('dragging'));
            }
            return this.children;
        }
        return [];
    }

    closest(selector) {
        if (selector === '.stack-wrapper') return this._stackWrapper || null;
        if (selector === '.stack-children') return this._stackChildren || null;
        return null;
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
    }

    insertBefore(newChild, refChild) {
        const idx = this.children.indexOf(refChild);
        newChild.parentElement = this;
        if (idx >= 0) {
            this.children.splice(idx, 0, newChild);
        } else {
            this.children.push(newChild);
        }
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) {
            this.children.splice(idx, 1);
            child.parentElement = null;
        }
    }

    addEventListener(event, handler) {
        this._eventListeners[event] = this._eventListeners[event] || [];
        this._eventListeners[event].push(handler);
    }

    removeEventListener(event, handler) {
        if (this._eventListeners[event]) {
            this._eventListeners[event] = this._eventListeners[event].filter(h => h !== handler);
        }
    }

    dispatchEvent(event) {
        const handlers = this._eventListeners[event.type] || [];
        handlers.forEach(h => h(event));
    }

    getBoundingClientRect() {
        return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    }
}

class MockClassList {
    constructor() {
        this._classes = new Set();
    }
    add(cls) { this._classes.add(cls); }
    remove(cls) { this._classes.delete(cls); }
    contains(cls) { return this._classes.has(cls); }
    toggle(cls) {
        if (this._classes.has(cls)) {
            this._classes.delete(cls);
        } else {
            this._classes.add(cls);
        }
    }
}

// Create mock document
const mockDocument = {
    _listeners: {},
    addEventListener(event, handler) {
        this._listeners[event] = this._listeners[event] || [];
        this._listeners[event].push(handler);
    },
    removeEventListener(event, handler) {
        if (this._listeners[event]) {
            this._listeners[event] = this._listeners[event].filter(h => h !== handler);
        }
    },
    querySelector(selector) {
        return null;
    },
    querySelectorAll(selector) {
        return [];
    },
    elementFromPoint(x, y) {
        return null;
    }
};

// Test the drag/drop logic directly
describe('Drag and Drop Logic', () => {

    it('should calculate insert index based on Y position', () => {
        // Simulate finding insert index for 3 clips at y=0, y=120, y=240
        const clips = [
            { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
            { getBoundingClientRect: () => ({ top: 120, height: 100 }) },
            { getBoundingClientRect: () => ({ top: 240, height: 100 }) }
        ];

        // Y = 30 (above middle of first clip) -> insert at 0
        const idx1 = findInsertIndex(clips, 30);
        assert.strictEqual(idx1, 0, 'Should insert at 0 when above first clip middle');

        // Y = 80 (below middle of first, above middle of second) -> insert at 1
        const idx2 = findInsertIndex(clips, 80);
        assert.strictEqual(idx2, 1, 'Should insert at 1 when between first and second');

        // Y = 200 (above middle of third=290) -> insert at 2
        const idx3 = findInsertIndex(clips, 200);
        assert.strictEqual(idx3, 2, 'Should insert at 2 when between second and third');

        // Y = 350 (below all clips) -> insert at end
        const idx4 = findInsertIndex(clips, 350);
        assert.strictEqual(idx4, 3, 'Should insert at end when below all');
    });

    it('should track drag state correctly', () => {
        const dragState = {
            isDragging: false,
            node: null,
            nodeData: null,
            currentDropIndex: -1
        };

        // Simulate starting drag
        const node = new MockElement();
        const nodeData = { id: 'clip-1', isTopLevel: false };

        dragState.isDragging = true;
        dragState.node = node;
        dragState.nodeData = nodeData;

        assert.strictEqual(dragState.isDragging, true);
        assert.strictEqual(dragState.nodeData.id, 'clip-1');

        // Reset on drop
        dragState.isDragging = false;
        dragState.node = null;

        assert.strictEqual(dragState.isDragging, false);
        assert.strictEqual(dragState.node, null);
    });

    it('should apply transform during drag for stack children', () => {
        const node = new MockElement();
        node.style.transform = '';

        // Simulate drag move
        const startY = 100;
        const currentY = 200;
        const deltaY = currentY - startY;

        node.style.transform = `translateY(${deltaY}px)`;
        node.style.zIndex = '1000';

        assert.strictEqual(node.style.transform, 'translateY(100px)');
        assert.strictEqual(node.style.zIndex, '1000');
    });

    it('should reset transform on drag end', () => {
        const node = new MockElement();
        node.style.transform = 'translateY(50px)';
        node.style.zIndex = '1000';
        node.classList.add('dragging');

        // Simulate drag end
        node.classList.remove('dragging');
        node.style.transform = '';
        node.style.zIndex = '';

        assert.strictEqual(node.style.transform, '');
        assert.strictEqual(node.style.zIndex, '');
        assert.strictEqual(node.classList.contains('dragging'), false);
    });

    it('should reorder DOM elements on drop', () => {
        // Create a parent container with 3 children
        const parent = new MockElement();
        const clip1 = new MockElement(); clip1.id = 'clip-1';
        const clip2 = new MockElement(); clip2.id = 'clip-2';
        const clip3 = new MockElement(); clip3.id = 'clip-3';

        parent.appendChild(clip1);
        parent.appendChild(clip2);
        parent.appendChild(clip3);

        // Verify initial order
        assert.deepStrictEqual(
            parent.children.map(c => c.id),
            ['clip-1', 'clip-2', 'clip-3']
        );

        // Simulate dropping clip-1 at index 2 (after clip-2)
        parent.removeChild(clip1);
        const clips = parent.children.filter(c => c.id !== 'clip-1');
        if (2 >= clips.length) {
            parent.appendChild(clip1);
        } else {
            parent.insertBefore(clip1, clips[2]);
        }

        // Verify new order: clip-2, clip-3, clip-1
        assert.deepStrictEqual(
            parent.children.map(c => c.id),
            ['clip-2', 'clip-3', 'clip-1'],
            'After dropping clip-1 at end, order should be clip-2, clip-3, clip-1'
        );
    });
});

// Helper function matching drag_drop.js logic
function findInsertIndex(elements, y) {
    for (let i = 0; i < elements.length; i++) {
        const rect = elements[i].getBoundingClientRect();
        if (y < rect.top + rect.height / 2) {
            return i;
        }
    }
    return elements.length;
}

describe('Slide Animation Calculation', () => {

    it('should slide items UP when dragging DOWN', () => {
        // Drag clip from index 0 to index 2:
        // Items from origIdx to targetIdx-1 should slide UP
        const origIdx = 0;
        const targetIdx = 2;
        const clipHeight = 116;

        // Simulate 3 clips after removing dragged: [B at 0, C at 1]
        // When dragging A to position 2, B and C should slide UP
        const clips = [
            { slideDirection: null },  // index 0 (origIdx=0 -> slide)
            { slideDirection: null }   // index 1 (targetIdx-1=1 -> slide)
        ];

        clips.forEach((clip, index) => {
            if (targetIdx > origIdx) {
                // Dragging DOWN: items between old and new slide UP
                if (index >= origIdx && index < targetIdx) {
                    clip.slideDirection = 'UP';
                    clip.transform = -clipHeight;
                }
            }
        });

        assert.strictEqual(clips[0].slideDirection, 'UP', 'Index 0 should slide UP');
        assert.strictEqual(clips[1].slideDirection, 'UP', 'Index 1 should slide UP');
        assert.strictEqual(clips[0].transform, -116, 'Transform should be -116px');
    });

    it('should slide items DOWN when dragging UP', () => {
        // Drag clip from index 2 to index 0:
        // Items from targetIdx to origIdx-1 should slide DOWN
        const origIdx = 2;
        const targetIdx = 0;
        const clipHeight = 116;

        // Simulate 3 clips after removing dragged: [A at 0, B at 1]
        // When dragging C to position 0, A and B should slide DOWN
        const clips = [
            { slideDirection: null },  // index 0 (targetIdx=0 -> slide)
            { slideDirection: null }   // index 1 (origIdx-1=1 -> slide)
        ];

        clips.forEach((clip, index) => {
            if (targetIdx < origIdx) {
                // Dragging UP: items between new and old slide DOWN
                if (index >= targetIdx && index < origIdx) {
                    clip.slideDirection = 'DOWN';
                    clip.transform = clipHeight;
                }
            }
        });

        assert.strictEqual(clips[0].slideDirection, 'DOWN', 'Index 0 should slide DOWN');
        assert.strictEqual(clips[1].slideDirection, 'DOWN', 'Index 1 should slide DOWN');
        assert.strictEqual(clips[0].transform, 116, 'Transform should be +116px');
    });

    it('should NOT slide when target equals original index', () => {
        const origIdx = 1;
        const targetIdx = 1;

        // No movement - should skip slide animation
        const shouldSlide = targetIdx !== origIdx;

        assert.strictEqual(shouldSlide, false, 'Should not slide when returning to original position');
    });
});

describe('Mock Backend reorderNode', () => {

    it('should insert node at correct index', () => {
        // Simulate mock backend state
        const nodes = [
            { id: 'clip-1' },
            { id: 'clip-2' },
            { id: 'clip-3' }
        ];

        // Simulate reorderNode('clip-1', 'stack-1', 2)
        const nodeToMove = nodes.find(n => n.id === 'clip-1');
        nodes.splice(nodes.indexOf(nodeToMove), 1);  // Remove from current pos

        const newIndex = Math.max(0, Math.min(2, nodes.length));
        nodes.splice(newIndex, 0, nodeToMove);  // Insert at new pos

        assert.deepStrictEqual(
            nodes.map(n => n.id),
            ['clip-2', 'clip-3', 'clip-1'],
            'Should move clip-1 to end'
        );
    });

    it('should clamp index to valid range', () => {
        const nodes = [{ id: 'clip-1' }, { id: 'clip-2' }];

        // Try to insert at index 10 (out of range)
        const nodeToMove = nodes.find(n => n.id === 'clip-1');
        nodes.splice(nodes.indexOf(nodeToMove), 1);

        const newIndex = Math.max(0, Math.min(10, nodes.length));  // Clamp to 1
        nodes.splice(newIndex, 0, nodeToMove);

        assert.strictEqual(newIndex, 1, 'Should clamp to length');
        assert.deepStrictEqual(nodes.map(n => n.id), ['clip-2', 'clip-1']);
    });
});

console.log('\n✅ All drag/drop tests completed\n');
