/**
 * Bounce e2e (docs/bounce.md): the project menu's "Bounce song…" hands
 * the island root to the dialog verb — the mock records the request and
 * the status line says so — and "Bounce selected…" names the lane's
 * start: its ↺ as shown (view_model bounceStartOf). (An empty island
 * offers the verb disabled: session_view.spec.js, the Project ▾ case.)
 */

import { test, expect } from '@playwright/test';
import { mock, call, slottedTopology, selectLane, laneMarks } from './helpers.js';

test('"Bounce selected…" starts at the ↺ AS SHOWN — a loop that slots in opens on the frame\'s top, where the song bounce does', async ({ page }) => {
    // B places the frame (its ↺ sounds at 5Q); C slots in — its own
    // stored top, the region start, sounds at 20Q, a moment nothing on
    // screen marks. Its ↺ as shown is the frame's top.
    const { Q, b, c } = await slottedTopology(page);
    const bounce = async label => {
        await page.click('#project-menu-btn');
        const item = page.locator(`#project-menu .pm-item:has-text("${label}")`);
        await expect(item).toBeEnabled();
        await item.click();
    };
    const bounced = (uuid, startQ) => expect.poll(() => mock(page, 'getLastBounce'))
        .toEqual({ uuid, path: '<dialog>', start: startQ * Q });

    await selectLane(page, c);
    await bounce('Bounce selected…');
    await bounced(c, 5);
    // The song opens on the same sample: the stem lines up with it.
    await bounce('Bounce song…');
    await bounced('mock-root', 5);
    await expect(page.locator('#log-line')).toHaveText('Bounced');
    // The placing loop opens on its own ↺ — moved 1Q into its region,
    // the frame follows it (6Q), and so does every stem.
    await call(page, 'setTiming', b, 0, 5 * Q);
    await expect.poll(() => laneMarks(page, c)).toEqual(['top@0', 'wrap@2']);
    await selectLane(page, b);
    await bounce('Bounce selected…');
    await bounced(b, 6);
    await selectLane(page, c);
    await bounce('Bounce selected…');
    await bounced(c, 6);
});
