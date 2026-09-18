/**
 * Audio file import e2e (docs/import.md), against the mock: the
 * project menu's "Import audio…" hands the island root to the dialog
 * verb at the frame top; an OS file dropped on a lane body lands at
 * the pointer's Q — directly when the File exposes a path, through
 * the chooser (placed at the same Q) when it carries only its name.
 */

import { test, expect } from '@playwright/test';
import { deriveViewModel } from '../js/view_model.js';

/** The absolute origin the app names for a placement `q` whole Qs into
 * the frame the view seats (docs/frame.md), from the page's own state. */
async function originAtQ(page, q) {
    const st = await page.evaluate(() => window.__celestrianTest.callNative('getGraphState'));
    const vm = deriveViewModel(st);
    return vm.frameZero + q * vm.quantum;
}

/** Drop `file` on the lane body at `xFrac` of its width; answers the
 *  whole Q the lane maps that x to (lane_build.js's own law). */
async function dropFile(page, laneId, xFrac, { name, path }) {
    return page.evaluate(({ laneId, xFrac, name, path }) => {
        const body = document.querySelector(`.lane[data-id="${laneId}"] .lane-body`);
        const r = body.getBoundingClientRect();
        const file = new File(['RIFF'], name, { type: 'audio/wav' });
        if (path) Object.defineProperty(file, 'path', { value: path });
        const dt = new DataTransfer();
        dt.items.add(file);
        const init = { bubbles: true, cancelable: true, dataTransfer: dt,
                       clientX: r.left + xFrac * r.width, clientY: r.top + r.height / 2 };
        body.dispatchEvent(new DragEvent('dragover', init));
        const lit = body.classList.contains('drop-file');
        body.dispatchEvent(new DragEvent('drop', init));
        return { q: Math.round(xFrac * body._cycleQ), lit,
                 unlit: !body.classList.contains('drop-file') };
    }, { laneId, xFrac, name, path });
}

test.describe('Audio file import (B6)', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
        await page.evaluate(() => window.__celestrianTest.loadScenario('stack-with-clips'));
        await expect(page.locator('.lane[data-id="clip-1"]')).toBeVisible();
    });

    test('"Import audio…" in the project menu imports into the root at Q0', async ({ page }) => {
        await page.click('#project-menu-btn');
        const item = page.locator('#project-menu .pm-item:has-text("Import audio…")');
        await expect(item).toBeEnabled();
        await item.click();
        const origin = await originAtQ(page, 0);
        await expect.poll(() => page.evaluate(
            () => window.__celestrianTest.getLastImport())).toMatchObject({
                uuid: 'mock-root', path: '<dialog>', origin, form: 'first' });
        await expect(page.locator('#log-line')).toHaveText('Imported — ⌘Z to undo');
        // The new clip (named after the dialog placeholder) joins the grid.
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(4);
    });

    test('a drop with a path imports directly at the pointer\'s Q', async ({ page }) => {
        const { q, lit, unlit } = await dropFile(page, 'clip-1', 0.5,
            { name: 'kick.wav', path: '/tmp/kick.wav' });
        expect(lit).toBe(true);     // dragover outlined the body…
        expect(unlit).toBe(true);   // …and the drop cleared it
        const origin = await originAtQ(page, q);
        await expect.poll(() => page.evaluate(
            () => window.__celestrianTest.getLastImport())).toEqual({
                uuid: 'clip-1', path: '/tmp/kick.wav', origin,
                form: 'take', targetId: 'clip-1' });
        await expect(page.locator('#log-line'))
            .toHaveText(`Imported kick.wav at Q${q} — ⌘Z to undo`);
        await expect(page.locator('.lane[data-id="clip-1"] .take-btn')).toHaveText('T2/2');
    });

    test('a drop without a path falls back to the chooser at the same Q', async ({ page }) => {
        const { q } = await dropFile(page, 'clip-2', 0.7, { name: 'snare.wav' });
        const origin = await originAtQ(page, q);
        await expect.poll(() => page.evaluate(
            () => window.__celestrianTest.getLastImport())).toMatchObject({
                uuid: 'clip-2', path: '<dialog>', origin, form: 'take' });
    });
});
