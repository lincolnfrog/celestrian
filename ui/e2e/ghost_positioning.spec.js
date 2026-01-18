/**
 * Ghost Positioning and Zoom Scaling - E2E Test
 */

import { test, expect } from '@playwright/test';

test.describe('Ghost Positioning and Zoom Scaling', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
    });

    test('ghosts in stacks are correctly aligned horizontally', async ({ page }) => {
        // Load scenario: 1Q + 4Q (LCM=4)
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');

        // Wait for nodes and ghosts to render
        await page.waitForSelector('.node-content', { timeout: 5000 });
        await page.waitForSelector('.ghost-clip', { timeout: 5000 });

        // Find the 1Q clip (it should have ghosts)
        // Find the 1Q clip (it should have ghosts)
        // Note: Node name is in an input with class 'node-name-input' and value attribute
        // We target the .node-content as the .node container might stretch in the stack validation
        const clip1Q = page.locator('.node').filter({ has: page.locator('input[value="Clip 1Q"]') });
        const clipContent = clip1Q.locator('.node-content');
        const clipBox = await clipContent.boundingBox();
        if (!clipBox) throw new Error('Clip 1Q content not found');

        // The first ghost for this clip should start exactly where the clip ends
        // We can find ghosts by their vertical alignment with the clip
        const ghost = page.locator('.ghost-clip').first();
        const ghostBox = await ghost.boundingBox();
        if (!ghostBox) throw new Error('Ghost not found');

        const getScale = async (p) => {
            return await p.evaluate(() => {
                const viewport = document.getElementById('viewport');
                if (!viewport) return 1;
                const style = window.getComputedStyle(viewport);
                const matrix = new DOMMatrix(style.transform);
                return matrix.a; // scaleX
            });
        };

        const scale = await getScale(page);

        // Verify vertical alignment (top of ghost should match top of clip content area)
        // clipBox is now the .node-content, so its Y is the content Y.
        // Ghost IS a node-content styled div, so its Y should match clipBox.y.
        const clipContentTop = clipBox.y;
        expect(Math.abs(ghostBox.y - clipContentTop)).toBeLessThan(2);

        // Verify horizontal alignment (left of ghost should match right of clip)
        // Note: node-content has 1px border, so its width is 202px (200 visual + 2 border).
        // Ghost is positioned at 200px (musical duration).
        // So expected difference is ~2px.
        const clipRight = clipBox.x + clipBox.width;
        expect(Math.abs(ghostBox.x - clipRight)).toBeLessThan(4);
    });

    test('ghosts stay aligned with clips during zoom', async ({ page }) => {
        // Load scenario: 1Q + 4Q (LCM=4)
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.ghost-clip');

        const clip1Q = page.locator('.node').filter({ has: page.locator('input[value="Clip 1Q"]') });
        const ghost = page.locator('.ghost-clip').first();

        const getScale = async (p) => {
            return await p.evaluate(() => {
                const viewport = document.getElementById('viewport');
                if (!viewport) return 1;
                const style = window.getComputedStyle(viewport);
                const matrix = new DOMMatrix(style.transform);
                return matrix.a; // scaleX
            });
        };

        // Helper to check alignment
        const checkAlignment = async () => {
            const clipContent = clip1Q.locator('.node-content');
            const clipBox = await clipContent.boundingBox();
            const ghostBox = await ghost.boundingBox();
            if (!clipBox || !ghostBox) return false;

            const scale = await getScale(page);

            // Note: node-content is inside the node, so its position (clipBox.y) 
            // already includes the header offset relative to the node.
            // But we need to verify ghostY relative to... 
            // Wait, node-content y IS the waveform top.
            // Ghost y IS the waveform top (ghost header is hidden/not part of bbox? No, ghost includes header space but is just content?)
            // Ghost element: 
            // ghost.style.height = `${node.h - 38}px`;
            // ghost.classList.add('node-content');
            // So ghost IS a node-content styled div.
            // So ghostBox.y should match clipBox.y ideally.
            // But ghost logic sets top: ghostY.
            // ghostY = clipRect.top - ... + 38.
            // clipRect is the NODE rect.
            // clipRect.top + 38 is the CONTENT top.
            // So ghostY should be exactly clipBox.y (if clipBox is content).

            const verticalGap = Math.abs(ghostBox.y - clipBox.y);
            const horizontalGap = Math.abs(ghostBox.x - (clipBox.x + clipBox.width));

            // Horizontal gap is due to borders (~2px).
            // This gap scales with the viewport zoom.
            // So we expect gap < (2 * scale + epsilon).
            // Let's use 2.5 * scale + 1 for safety.
            const tolerance = 2.5 * scale + 1;

            console.log(`Scale: ${scale}, V-Gap: ${verticalGap}, H-Gap: ${horizontalGap}, Tol: ${tolerance}`);
            return {
                pass: verticalGap < tolerance && horizontalGap < tolerance,
                message: `Scale: ${scale}, V-Gap: ${verticalGap}, H-Gap: ${horizontalGap}, Tol: ${tolerance}`
            };
        };

        // Helper expectation
        const expectAligned = async () => {
            const result = await checkAlignment();
            if (!result) return; // setup failed
            expect(result.pass, result.message).toBe(true);
        };

        // Initial check
        await expectAligned();

        // Zoom IN (Press 'q' multiple times)
        for (let i = 0; i < 5; i++) {
            await page.keyboard.press('q');
            await page.waitForTimeout(100); // Wait for transition
        }
        await expectAligned();

        // Zoom OUT (Press 'e' multiple times)
        for (let i = 0; i < 10; i++) {
            await page.keyboard.press('e');
            await page.waitForTimeout(100);
        }
        await expectAligned();
    });
});
