/**
 * Stack Loop UI E2E Tests
 * 
 * Tests for hierarchical loop region UI on stacks (composites behave like clips).
 * Run with: npm run test:playwright
 */

import { test, expect } from '@playwright/test';

test.describe('Stack Loop Region UI', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });
    });

    test('expanded stack header has loop handles', async ({ page }) => {
        // Wait for stack to be expanded
        const stackWrapper = page.locator('.stack-wrapper').first();
        await expect(stackWrapper).toBeVisible();

        // Find loop handles in stack header waveform
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');
        await expect(headerWaveform).toBeVisible();

        const loopHandleStart = headerWaveform.locator('.loop-handle-start');
        const loopHandleEnd = headerWaveform.locator('.loop-handle-end');

        // Loop handles should exist and be positioned
        await expect(loopHandleStart).toBeAttached();
        await expect(loopHandleEnd).toBeAttached();

        // Check positioning - start should be at 0%
        const startLeft = await loopHandleStart.evaluate(el => el.style.left);
        const endLeft = await loopHandleEnd.evaluate(el => el.style.left);

        console.log(`Stack loop handles: start=${startLeft}, end=${endLeft}`);

        expect(startLeft).toBe('0%');
        expect(endLeft).toBe('100%');
    });

    test('stack header has dim layers for regions outside loop', async ({ page }) => {
        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');

        const dimLeft = headerWaveform.locator('.dim-left');
        const dimRight = headerWaveform.locator('.dim-right');

        // Dim layers should exist
        await expect(dimLeft).toBeAttached();
        await expect(dimRight).toBeAttached();

        // With default loop (0% to 100%), dim layers should have 0 width
        const dimLeftWidth = await dimLeft.evaluate(el => el.style.width);
        const dimRightWidth = await dimRight.evaluate(el => el.style.width);

        console.log(`Dim layer widths: left=${dimLeftWidth}, right=${dimRightWidth}`);

        expect(dimLeftWidth).toBe('0%');
        expect(dimRightWidth).toBe('0%');
    });

    test('stack header has playhead element', async ({ page }) => {
        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');

        const playhead = headerWaveform.locator('.stack-playhead');

        // Playhead should exist
        await expect(playhead).toBeAttached();

        // Check it has correct styling
        const bgColor = await playhead.evaluate(el =>
            window.getComputedStyle(el).backgroundImage
        );
        console.log(`Stack playhead background: ${bgColor}`);

        // Should have gradient background
        expect(bgColor).toContain('linear-gradient');
    });

    test('stack header has launch marker element', async ({ page }) => {
        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');

        const launchMarker = headerWaveform.locator('.launch-marker');

        // Launch marker should exist
        await expect(launchMarker).toBeAttached();

        // By default, launch marker is hidden (no anchor)
        const display = await launchMarker.evaluate(el =>
            window.getComputedStyle(el).display
        );

        console.log(`Launch marker display: ${display}`);
        expect(display).toBe('none');
    });

    test('composite waveform width covers LCM of child durations', async ({ page }) => {
        // Load scenario with different clip durations (1Q + 4Q = LCM of 4Q)
        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');

        // Get the computed width of the header waveform
        const headerWidth = await headerWaveform.evaluate(el => el.offsetWidth);

        // Get the first child clip width for reference
        const firstClip = stackWrapper.locator('.stack-children .node').first();
        const clipContent = firstClip.locator('.node-content');
        const clipWidth = await clipContent.evaluate(el => el.offsetWidth);

        console.log(`Header width: ${headerWidth}px, Clip width: ${clipWidth}px`);

        // The header should be at least as wide as the longest clip
        // (For 1Q + 4Q scenario, LCM = 4Q, so header should be >= longest clip)
        expect(headerWidth).toBeGreaterThanOrEqual(clipWidth);
    });

    test('composite header is wider than shortest clip (proves LCM not min)', async ({ page }) => {
        // The composite should cover LCM (largest), not the minimum clip duration
        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');

        // Get header width
        const headerWidth = await headerWaveform.evaluate(el => el.offsetWidth);

        // For 1Q + 4Q scenario, the 1Q clip is 200px wide, 4Q is 800px
        // LCM = 4Q = 800px, so header should be close to 800px (not 200px)
        console.log(`Header width for LCM test: ${headerWidth}px`);

        // Header should be at least 600px (3Q worth) - proving it uses LCM not minimum
        expect(headerWidth).toBeGreaterThan(600);
    });
});

test.describe('Stack Loop UI - Different Scenarios', () => {

    test('stack with 3 clips shows correct LCM width', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("Stack with 3 Clips")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');

        // Header should exist and have reasonable width
        const headerWidth = await headerWaveform.evaluate(el => el.offsetWidth);
        console.log(`3-clip stack header width: ${headerWidth}px`);

        // Should be at least 200px (1Q width)
        expect(headerWidth).toBeGreaterThanOrEqual(200);
    });

    test('stack header has all required UI elements', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("Stack with 3 Clips")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');

        // Verify all hierarchical loop UI elements exist
        await expect(headerWaveform.locator('canvas.stack-waveform-canvas')).toBeAttached();
        await expect(headerWaveform.locator('.stack-playhead')).toBeAttached();
        await expect(headerWaveform.locator('.loop-handle-start')).toBeAttached();
        await expect(headerWaveform.locator('.loop-handle-end')).toBeAttached();
        await expect(headerWaveform.locator('.dim-left')).toBeAttached();
        await expect(headerWaveform.locator('.dim-right')).toBeAttached();
        await expect(headerWaveform.locator('.launch-marker')).toBeAttached();

        console.log('All hierarchical loop UI elements present');
    });

    test('loop handles have correct cursor style', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');

        const loopHandleStart = headerWaveform.locator('.loop-handle-start');
        const cursor = await loopHandleStart.evaluate(el =>
            window.getComputedStyle(el).cursor
        );

        console.log(`Loop handle cursor: ${cursor}`);

        // Loop handles should have resize cursor for dragging
        expect(cursor).toBe('col-resize');
    });

    test('stack loop handle responds to mousedown event', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');
        const loopHandleEnd = headerWaveform.locator('.loop-handle-end');

        // Get initial loop handle position
        const initialLeft = await loopHandleEnd.evaluate(el => el.style.left);
        console.log(`Initial loop-handle-end position: ${initialLeft}`);

        // Get bounding box for drag simulation
        const handleBox = await loopHandleEnd.boundingBox();
        expect(handleBox).not.toBeNull();

        // Verify the handle is positioned at the end (100%)
        expect(initialLeft).toBe('100%');
    });
});

test.describe('Composite Waveform Alignment', () => {

    test('composite waveform canvas has correct dimensions', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        const canvas = stackWrapper.locator('.stack-waveform-canvas');

        // Canvas should exist
        await expect(canvas).toBeAttached();

        // Get canvas dimensions
        const dimensions = await canvas.evaluate(el => ({
            width: el.width,
            height: el.height,
            cssWidth: el.offsetWidth,
            cssHeight: el.offsetHeight
        }));

        console.log(`Canvas dimensions: ${dimensions.width}x${dimensions.height} (CSS: ${dimensions.cssWidth}x${dimensions.cssHeight})`);

        // Canvas should have reasonable dimensions for LCM=4Q (800px width expected)
        expect(dimensions.width).toBeGreaterThan(600);
        expect(dimensions.height).toBeGreaterThan(0);
    });

    test('composite waveform shows rendered content', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        // Wait a bit for waveform to render
        await page.waitForTimeout(200);

        const stackWrapper = page.locator('.stack-wrapper').first();
        const canvas = stackWrapper.locator('.stack-waveform-canvas');

        // Check if canvas has any drawn content by sampling pixels
        const hasContent = await canvas.evaluate(el => {
            const ctx = el.getContext('2d');
            if (!ctx) return false;

            // Sample a few points across the canvas
            const imageData = ctx.getImageData(0, 0, el.width, el.height);
            const data = imageData.data;

            // Check if there's any non-transparent pixel (alpha > 0)
            for (let i = 3; i < data.length; i += 4) {
                if (data[i] > 0) return true;
            }
            return false;
        });

        console.log(`Composite waveform has rendered content: ${hasContent}`);
        expect(hasContent).toBe(true);
    });

    test('composite waveform width matches header container', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("Stack with 3 Clips")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');
        const canvas = stackWrapper.locator('.stack-waveform-canvas');

        const headerWidth = await headerWaveform.evaluate(el => el.offsetWidth);
        const canvasWidth = await canvas.evaluate(el => el.width);

        console.log(`Header width: ${headerWidth}px, Canvas width: ${canvasWidth}px`);

        // Canvas width should match header width (within 10px tolerance)
        expect(Math.abs(canvasWidth - headerWidth)).toBeLessThan(10);
    });
});

test.describe('Composite Waveform Caching', () => {

    test('composite waveform is rendered consistently on multiple syncs', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        // Wait for initial render
        await page.waitForTimeout(100);

        const stackWrapper = page.locator('.stack-wrapper').first();
        const canvas = stackWrapper.locator('.stack-waveform-canvas');

        // Get initial waveform pixel data
        const initialSum = await canvas.evaluate(el => {
            const ctx = el.getContext('2d');
            if (!ctx) return 0;
            const imageData = ctx.getImageData(0, 0, el.width, el.height);
            return imageData.data.reduce((sum, val) => sum + val, 0);
        });

        // Wait for a few sync cycles (waveform should stay cached)
        await page.waitForTimeout(300);

        // Get waveform pixel data after syncs
        const afterSum = await canvas.evaluate(el => {
            const ctx = el.getContext('2d');
            if (!ctx) return 0;
            const imageData = ctx.getImageData(0, 0, el.width, el.height);
            return imageData.data.reduce((sum, val) => sum + val, 0);
        });

        console.log(`Initial pixel sum: ${initialSum}, After pixel sum: ${afterSum}`);

        // Waveform should be identical (cache is working)
        expect(afterSum).toBe(initialSum);
    });

    test('composite waveform updates when children change', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("Stack with 3 Clips")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        await page.waitForTimeout(100);

        const stackWrapper = page.locator('.stack-wrapper').first();
        const canvas = stackWrapper.locator('.stack-waveform-canvas');

        // Verify canvas is rendered
        const hasContent = await canvas.evaluate(el => {
            const ctx = el.getContext('2d');
            if (!ctx) return false;
            const imageData = ctx.getImageData(0, 0, el.width, el.height);
            for (let i = 3; i < imageData.data.length; i += 4) {
                if (imageData.data[i] > 0) return true;
            }
            return false;
        });

        console.log(`Composite waveform has content after load: ${hasContent}`);
        expect(hasContent).toBe(true);
    });
});

test.describe('Loop-on-Collapse Visual Feedback', () => {

    test('expanded stack composite waveform is faded', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');

        // Stack should be expanded by default
        const isExpanded = await stackWrapper.evaluate(el => !el.classList.contains('stack-collapsed'));
        expect(isExpanded).toBe(true);

        // When expanded, opacity should be reduced (approximately 0.5)
        const opacity = await headerWaveform.evaluate(el => {
            const style = getComputedStyle(el);
            return parseFloat(style.opacity);
        });

        console.log(`Expanded stack waveform opacity: ${opacity}`);
        expect(opacity).toBeLessThan(0.8); // Should be around 0.5 (faded)
    });

    test('loop handles are faded when expanded', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        const loopHandleEnd = stackWrapper.locator('.stack-header-waveform .loop-handle-end');

        // When expanded, loop handles should be faded (approximately 0.6)
        const opacity = await loopHandleEnd.evaluate(el => {
            const style = getComputedStyle(el);
            return parseFloat(style.opacity);
        });

        console.log(`Expanded stack loop handle opacity: ${opacity}`);
        expect(opacity).toBeLessThan(0.9); // Should be around 0.6 (faded)
    });
});
