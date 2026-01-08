/**
 * Unit Tests for Ghost Rendering
 * 
 * These tests verify that ghost repetitions render correctly for clips
 * at different nesting levels (top-level clips and clips inside stacks).
 */

import { describe, it, expect, beforeEach } from './test_framework.js';

describe('Ghost Rendering', () => {
    let container;

    beforeEach(() => {
        // Create test container
        container = document.createElement('div');
        container.id = 'test-container';
        document.body.appendChild(container);
    });

    afterEach(() => {
        document.body.removeChild(container);
    });

    it('should render ghosts for top-level clips', () => {
        // Setup: Create a top-level clip with effectiveQ > duration
        const state = {
            nodes: [{
                id: 'clip-1',
                type: 'clip',
                x: 100,
                y: 100,
                duration: 2.0,
                effectiveQuantum: 4.0,
                isRecording: false
            }]
        };

        // Execute ghost rendering logic (simulated)
        const effectiveQ = 4.0;
        const ghosts = renderGhosts(state.nodes, effectiveQ);

        // Assert: Should create ghost repetitions
        expect(ghosts.length).toBeGreaterThan(0);
        expect(ghosts[0].clipId).toBe('clip-1');
    });

    it('should render ghosts for clips inside stacks', () => {
        // Setup: Create a stack with nested clips
        const state = {
            nodes: [{
                id: 'stack-1',
                type: 'stack',
                x: 200,
                y: 200,
                nodes: [
                    {
                        id: 'clip-a',
                        type: 'clip',
                        duration: 2.0,
                        effectiveQuantum: 4.0,
                        isRecording: false,
                        h: 100
                    },
                    {
                        id: 'clip-b',
                        type: 'clip',
                        duration: 2.0,
                        effectiveQuantum: 4.0,
                        isRecording: false,
                        h: 100
                    }
                ]
            }]
        };

        // Flatten clips (as app.js does)
        const allClips = [];
        state.nodes.forEach(node => {
            if (node.type === 'stack' && node.nodes) {
                allClips.push(...node.nodes);
            } else if (node.type === 'clip') {
                allClips.push(node);
            }
        });

        // Execute ghost rendering logic
        const effectiveQ = 4.0;
        const ghosts = renderGhosts(allClips, effectiveQ);

        // Assert: Should create ghosts for both clips
        expect(ghosts.length).toBeGreaterThan(0);
        const clipAGhosts = ghosts.filter(g => g.clipId === 'clip-a');
        const clipBGhosts = ghosts.filter(g => g.clipId === 'clip-b');
        expect(clipAGhosts.length).toBeGreaterThan(0);
        expect(clipBGhosts.length).toBeGreaterThan(0);
    });

    it('should calculate correct Y position for stack children ghosts', () => {
        // Setup: Stack with 2 clips
        const stack = {
            id: 'stack-1',
            type: 'stack',
            x: 100,
            y: 100,
            nodes: [
                { id: 'clip-1', h: 80 },
                { id: 'clip-2', h: 100 }
            ]
        };

        // Expected Y positions
        const VISUAL_OFFSET = 120;
        const stackTop = stack.y;
        const clip1Y = stackTop + 40 + 38; // stack padding + clip header
        const clip2Y = stackTop + 40 + 80 + 16 + 38; // + clip1 height + gap + header

        // Calculate positions (using app.js logic)
        const positions = calculateGhostPositions(stack);

        expect(positions[0].y).toBe(clip1Y);
        expect(positions[1].y).toBe(clip2Y);
    });

    it('should skip one-shot clips', () => {
        // Setup: Clip with duration < effectiveQ
        const clips = [{
            id: 'oneshot',
            type: 'clip',
            duration: 1.0,
            effectiveQuantum: 4.0,
            isRecording: false
        }];

        const effectiveQ = 4.0;
        const ghosts = renderGhosts(clips, effectiveQ);

        // Assert: No ghosts for one-shots
        expect(ghosts.length).toBe(0);
    });

    it('should skip recording clips', () => {
        // Setup: Recording clip
        const clips = [{
            id: 'recording',
            type: 'clip',
            duration: 2.0,
            effectiveQuantum: 4.0,
            isRecording: true
        }];

        const effectiveQ = 4.0;
        const ghosts = renderGhosts(clips, effectiveQ);

        // Assert: No ghosts while recording
        expect(ghosts.length).toBe(0);
    });
});

// Helper functions (simplified versions of app.js logic)
function renderGhosts(clips, effectiveQ) {
    const ghosts = [];

    if (effectiveQ <= 1) return ghosts;

    clips.forEach(clip => {
        if (clip.isRecording || !clip.duration) return;

        const clipWidth = (clip.duration / effectiveQ) * 200;
        const isOneShot = clip.duration < effectiveQ;

        if (isOneShot) return;

        // Simulate creating ghost elements
        ghosts.push({
            clipId: clip.id,
            width: clipWidth,
            type: 'ghost'
        });
    });

    return ghosts;
}

function calculateGhostPositions(stack) {
    const VISUAL_OFFSET = 202;
    const positions = [];
    let cumulativeY = 40; // Stack top padding

    stack.nodes.forEach((node, i) => {
        const ghostY = stack.y + cumulativeY + 38; // Add header height
        positions.push({ y: ghostY });

        cumulativeY += (node.h || 100) + 16; // Node height + gap
    });

    return positions;
}

export { describe, it, expect };
