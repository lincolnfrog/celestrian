/**
 * MIDI lane rendering e2e (docs/vst3.md §8.5), against the mock: the
 * midi-clip scenario's Keys lane fetches its notes (getMidiNotes) and
 * paints note-bar tiles — every resting tile of the lane carries the
 * take's note count, ghosts included (the same tiling as audio).
 */

import { test, expect } from '@playwright/test';
import { boot, laneOf } from './helpers.js';

test('the Keys lane shows note-bar tiles carrying four notes', async ({ page }) => {
    await boot(page, { scenario: 'midi-clip' });
    const tiles = laneOf(page, 'midi-1').locator('.rep.midi');
    await expect(tiles.first()).toBeVisible();
    const count = await tiles.count();
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < count; i++) {
        await expect(tiles.nth(i)).toHaveAttribute('data-notes', '4');
        await expect(tiles.nth(i).locator('canvas')).toHaveCount(1);
    }
    // The audio seed beside it paints the envelope, not notes.
    await expect(laneOf(page, 'seed').locator('.rep')).not.toHaveCount(0);
    await expect(laneOf(page, 'seed').locator('.rep.midi')).toHaveCount(0);
});
