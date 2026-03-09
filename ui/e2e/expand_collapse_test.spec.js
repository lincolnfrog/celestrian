import { test, expect } from '@playwright/test';

test.describe('Stack Expand/Collapse Round-Trip', () => {
    test('collapsed stack can be re-expanded', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.click('text=Stack with 3 Clips');
        await page.waitForTimeout(300);

        const stackWrapper = page.locator('.stack-wrapper').first();
        await expect(stackWrapper).toBeVisible();

        // Verify initially expanded
        expect(await stackWrapper.evaluate(el => !el.classList.contains('stack-collapsed'))).toBe(true);
        const childrenBefore = await stackWrapper.locator('.stack-children .node').count();
        expect(childrenBefore).toBeGreaterThan(0);

        // Collapse
        const expandHandle = stackWrapper.locator('.stack-expand-handle');
        await expandHandle.click();
        await page.waitForTimeout(300);
        expect(await stackWrapper.evaluate(el => el.classList.contains('stack-collapsed'))).toBe(true);

        // Verify expand handle is the top element (not covered)
        const handleBox = await expandHandle.boundingBox();
        const elementAtPoint = await page.evaluate(({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return el?.className || 'null';
        }, { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 });
        expect(elementAtPoint).toContain('stack-expand-handle');

        // Re-expand
        await expandHandle.click();
        await page.waitForTimeout(300);

        const isExpandedAfter = await stackWrapper.evaluate(el => !el.classList.contains('stack-collapsed'));
        expect(isExpandedAfter).toBe(true);

        // Children should be visible again
        const childrenAfter = await stackWrapper.locator('.stack-children .node').count();
        expect(childrenAfter).toBeGreaterThan(0);
    });
});
