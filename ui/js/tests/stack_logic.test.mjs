import test from 'node:test';
import assert from 'node:assert/strict';
import { groupNodesByVisualX, calculateButtonPosition } from '../stack_logic.js';

test('Stack Logic - Grouping', async (t) => {
    await t.test('should group nodes by visual X position', () => {
        const nodes = [
            { id: 'a', x: 0, _visualX: 100, y: 0, h: 50 },
            { id: 'b', x: 0, _visualX: 120, y: 60, h: 50 }, // Should group with A (diff 20)
            { id: 'c', x: 0, _visualX: 500, y: 0, h: 50 }   // Far away
        ];

        const groups = groupNodesByVisualX(nodes);
        assert.equal(groups.length, 2);
        assert.equal(groups[0].length, 2); // a, b
        assert.equal(groups[1].length, 1); // c
        assert.equal(groups[0][0].id, 'a'); // Sorted by ID
    });

    await t.test('should fallback to raw X if visualX missing', () => {
        const nodes = [
            { id: 'a', x: 100, y: 0, h: 50 },
            { id: 'b', x: 120, y: 60, h: 50 }
        ];
        const groups = groupNodesByVisualX(nodes);
        assert.equal(groups.length, 1);
    });

    await t.test('REGRESSION TEST: ignoring global grid shift', () => {
        // Scenario: Global grid shifts clips.
        // Node A: Raw X = 0. Visual X = 200.
        // Node B: Raw X = 0. Visual X = 200.
        // Node C: Raw X = 500. Visual X = 200 (Wrapped?).
        // If they align visually, they should stack.
        const nodes = [
            { id: 'a', x: 0, _visualX: 200, y: 0, h: 50 },
            { id: 'c', x: 500, _visualX: 210, y: 100, h: 50 }
        ];

        const groups = groupNodesByVisualX(nodes);
        assert.equal(groups.length, 1, 'Should group based on visual proximity');
    });
});

test('Stack Logic - Positioning', async (t) => {
    await t.test('should calculate position based on visual X and max Y', () => {
        const group = [
            { id: 'a', _visualX: 100, x: 0, y: 0, h: 50 },
            { id: 'b', _visualX: 100, x: 0, y: 100, h: 50 } // Ends at 150
        ];

        const props = calculateButtonPosition(group);
        assert.equal(props.x, 100);
        assert.equal(props.y, 150, 'Should be at bottom of lowest clip');
        assert.ok(props.id.includes('stack-btn-a'));
    });
});
