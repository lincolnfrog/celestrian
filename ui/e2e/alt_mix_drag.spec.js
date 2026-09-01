/* ⌥→PLAIN MIXED BRACKET DRAG (audit 2026-08-31 U2, regression).
 *
 * ⌥ free-slide then plain drag in ONE bracket gesture: pre-fix, the ⌥
 * branch left BOTH window ends fractional in `cur` and releasing ⌥
 * mid-drag snapped only the grabbed edge — the commit sent a
 * FRACTIONAL-length window that the engine's coherence guard refused
 * silently (while the status line claimed success). window_edit.js now
 * re-lands `cur` on whole Q at the ⌥→plain transition (length held),
 * so the commit is always coherent; app.js verifies the landed state
 * (U9) so the status line cannot lie.
 */
import { test, expect } from '@playwright/test';

async function loadHarness(page, scenario) {
    await page.goto('/index_test.html');
    await page.waitForSelector('#test-controls', { timeout: 5000 });
    await page.click(`button:has-text("${scenario}")`);
    await page.waitForFunction(
        () => document.querySelectorAll('.lane').length > 0);
    await page.waitForTimeout(150);
}

test('⌥→plain mixed bracket drag lands a whole-Q window', async ({ page }) => {
    await loadHarness(page, '1Q + 3Q (Loop)');
    const Q = await page.evaluate(() =>
        window.celestrian.getState().perf.sampleRate);
    const clip3Q = page.locator('.lane[data-kind="clip"]').nth(1);
    const body = clip3Q.locator('.lane-body');

    // Create a real 1Q window [1Q, 2Q) so ⌥-slide has room both ways.
    await page.evaluate(q => window.celestrian.callNative(
        'setLoopPoints', 'clip-3q', q, 2 * q), Q);
    // Open the inspector so the editable brackets exist.
    await clip3Q.locator('.win-open-chip').click();
    const start = clip3Q.locator('.win-bracket.start:not(.latent)');
    await expect(start).toBeVisible();

    const st0 = await page.evaluate(() =>
        window.celestrian.getState().nodes.find(n => n.type === 'stack')
            .nodes.find(c => c.id === 'clip-3q'));

    const bb = await body.boundingBox();
    const sb = await start.boundingBox();
    const y = bb.y + bb.height / 2;
    await page.mouse.move(sb.x + sb.width / 2, y);
    await page.mouse.down();
    // ⌥ free slide: +0.6Q (both ends move fractionally in `cur`).
    await page.keyboard.down('Alt');
    await page.mouse.move(sb.x + sb.width / 2 + bb.width * (0.6 / 3), y, { steps: 6 });
    // Release ⌥ mid-drag, nudge in plain mode: the U2 re-snap lands
    // `cur` back on whole Q FIRST (len held → [2Q, 3Q)), then plain
    // snapping resumes from that grid.
    await page.keyboard.up('Alt');
    await page.mouse.move(sb.x + sb.width / 2 + bb.width * (0.65 / 3), y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const st1 = await page.evaluate(() =>
        window.celestrian.getState().nodes.find(n => n.type === 'stack')
            .nodes.find(c => c.id === 'clip-3q'));
    const log = await page.locator('#log-line').textContent();
    console.log('window before:', st0.loopStart / Q, st0.loopEnd / Q,
        'after:', st1.loopStart / Q, st1.loopEnd / Q, '| status:', log);
    const lenQ = (st1.loopEnd - st1.loopStart) / Q;
    const changed = st1.loopStart !== st0.loopStart || st1.loopEnd !== st0.loopEnd;
    const startQ = st1.loopStart / Q;
    console.log('changed:', changed, 'lenQ:', lenQ, 'startQ:', startQ);
    // The slide crossed a whole Q, so the gesture must LAND (pre-fix it
    // was silently refused as fractional) — and land whole-Q on both
    // length and position.
    expect(changed, 'mixed-mode drag must land').toBe(true);
    expect(Math.abs(lenQ - Math.round(lenQ)) < 1e-9,
        'whole-Q length').toBe(true);
    expect(Math.abs(startQ - Math.round(startQ)) < 1e-9,
        'whole-Q position').toBe(true);
});
