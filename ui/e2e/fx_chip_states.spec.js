/**
 * A plugin chip's STATES (docs/vst3.md §6), against the mock page: the
 * engine publishes two ways a hosted plugin can be in the chain and not
 * sound — `missing` (not installed here: a placeholder slot) and
 * `unsupported` (it would not run in stereo: the slot is bypassed) — and
 * the chip says which. The mock hosts no real plugin, so the page is
 * served the mock's state with those keys set on its plugin slots, as an
 * engine would publish them.
 */

import { test, expect } from '@playwright/test';
import { boot, call, laneOf, consoleDrained } from './helpers.js';

/** Serve the page the mock's graph state with `window.__slotFacts`
 * merged into every plugin slot it publishes. */
async function publishSlotFacts(page) {
    await page.route('**/js/backend.js', async route => {
        const res = await route.fetch();
        const src = await res.text();
        const anchor = '({ callNative, log, getState } = mockBackend);';
        if (!src.includes(anchor)) throw new Error('backend.js anchor moved');
        const wrapped = anchor + `
        {
            const withFacts = state => {
                const facts = window.__slotFacts;
                if (!facts || !state) return state;
                const walk = nodes => (nodes || []).forEach(n => {
                    if (n.effects && Array.isArray(n.effects.chain)) {
                        n.effects = { ...n.effects, chain: n.effects.chain.map(
                            s => (s.type === 'vst3' ? { ...s, ...facts } : s)) };
                    }
                    walk(n.nodes);
                });
                walk(state.nodes);
                return state;
            };
            const rawCall = callNative;
            const rawGet = getState;
            callNative = async (method, ...args) => {
                const answer = await rawCall(method, ...args);
                return method === 'getGraphState' ? withFacts(answer) : answer;
            };
            getState = () => withFacts(rawGet());
        }`;
        await route.fulfill({ response: res, body: src.replace(anchor, wrapped) });
    });
}

const setFacts = (page, facts) =>
    page.evaluate(f => { window.__slotFacts = f; }, facts);

/** The editor requests the page sends from here on. */
function recordEditorCalls(page) {
    const calls = [];
    page.on('console', msg => {
        if (msg.text().startsWith('[MockBackend] callNative: openPluginEditor')) {
            calls.push(msg.text());
        }
    });
    return calls;
}

test.describe('Plugin chip states', () => {

    test('a plugin that would not run in stereo says so; a missing one says that — ' +
         'and only the missing one has no editor to open', async ({ page }) => {
        await publishSlotFacts(page);
        await boot(page, { scenario: 'stack-with-clips' });
        await expect(laneOf(page, 'clip-1')).toBeVisible();
        const [known] = await call(page, 'getKnownPlugins');
        await call(page, 'addPluginToChain', 'clip-1', known.uid, -1);
        await laneOf(page, 'clip-1').locator('.fx-btn').click();
        const chip = page.locator('.lane-fx .fx-card.fx-vst3');
        const badge = chip.locator('.fx-vst3-badge');
        const name = chip.locator('.fx-vst3-name');
        await expect(name).toHaveText(known.name);

        // Loaded and running: no badge.
        await expect(badge).toHaveText('');
        await expect(chip).not.toHaveClass(/unsupported|missing/);

        // It refused the stereo layout: bypassed, and the chip says why.
        await setFacts(page, { unsupported: true });
        await expect(badge).toHaveText('no stereo');
        await expect(chip).toHaveClass(/\bunsupported\b/);
        await expect(chip).not.toHaveClass(/\bmissing\b/);
        await expect(badge).toHaveAttribute('title',
            'This plugin would not run in stereo, so it is bypassed: ' +
            'the chain plays on without it');
        // It is loaded all the same: its own editor still opens.
        const asked = recordEditorCalls(page);
        const at = await name.boundingBox();
        await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
        await consoleDrained(page);
        expect(asked.length).toBe(1);

        // Not installed here: the other state, with its own word.
        await setFacts(page, { unsupported: false, missing: true });
        await expect(badge).toHaveText('missing');
        await expect(chip).toHaveClass(/\bmissing\b/);
        await expect(chip).not.toHaveClass(/\bunsupported\b/);
        await expect(badge).toHaveAttribute('title', '');
        await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
        await consoleDrained(page);
        expect(asked.length).toBe(1);

        // Back to running: the chip is plain again.
        await setFacts(page, { unsupported: false, missing: false });
        await expect(badge).toHaveText('');
        await expect(chip).not.toHaveClass(/unsupported|missing/);
    });
});
