/**
 * The plugin registry panel (the status strip's 🔌 Plugins) and the
 * plugin chip of an effects row, against the mock page (/?mock=true):
 * the empty registry's note, a scan from its first progress line to the
 * list it leaves, what the status line says of a scan that lost
 * plugins, names drawn as text, and the chip's name asking for the
 * plugin's own editor. app_shell.spec.js holds the panel's popover
 * behaviour and a scan of the mock's own registry.
 */

import { test, expect } from '@playwright/test';
import { boot, laneOf } from './helpers.js';

const panelOf = page => page.locator('#status-strip .audio-panel');
const logLine = page => page.locator('#log-line');

const plugin = (name, extra = {}) => ({
    name, uid: 'VST3-' + name.toLowerCase().replace(/\W+/g, '-'),
    file: `/Library/Audio/Plug-Ins/VST3/${name.replace(/\W+/g, '')}.vst3`,
    maker: 'Mocksound', category: 'Fx', version: '1.0', isInstrument: false,
    ...extra,
});

/**
 * Serve the page a plugin registry this test scripts, in place of the
 * mock's own (mock/plugins.js, same exports and status shape). `known`
 * is the list before any scan. Each scan takes the next entry of
 * `scans` — {current, finds, report, held} — answers two status polls
 * as running (a third and two thirds through, probing `current`), then
 * ends: `finds` join the list and `report` overrides the final status
 * (crashed, blacklistCount, error). A `held` scan keeps running until
 * the page sets `window.__releaseScan`.
 */
async function serveRegistry(page, { known = [], scans = [] } = {}) {
    await page.route('**/js/mock/plugins.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: `
            let known = ${JSON.stringify(known)};
            const scans = ${JSON.stringify(scans)};
            let scan = null;
            let polls = 0;
            export const getKnownPlugins = () => [...known];
            export function scanPlugins() {
                scan = scans.shift() || {};
                polls = 0;
                return true;
            }
            export function getPluginScanStatus() {
                const idle = { scanning: false, progress: 1, current: '',
                    count: known.length, blacklistCount: 0, crashed: [], error: '' };
                if (!scan) return idle;
                polls += 1;
                if (polls < 3 || (scan.held && !window.__releaseScan)) {
                    return { ...idle, scanning: true,
                             progress: Math.min(polls, 2) / 3,
                             current: scan.current || '' };
                }
                known = known.concat(scan.finds || []);
                const done = { ...idle, ...(scan.report || {}), count: known.length };
                scan = null;
                return done;
            }
            export const resetPlugins = () => {};
        `,
    }));
}

/** The mock page on Main Stack ▸ three tracks, its project born (the
 * birth line must not land on the status line mid-test). */
async function open(page) {
    await boot(page, { scenario: 'stack-with-clips' });
    await expect(laneOf(page, 'clip-3')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('#project-menu-btn')).toHaveText(/^\d{8}-\d\d ▾$/);
}

/** Every text the scan's progress line shows from now on, in order. */
async function watchProgress(page) {
    await page.evaluate(() => {
        window.__progress = [];
        new MutationObserver(() => {
            const line = document.querySelector('#plugin-scan-status');
            const text = line ? line.textContent : '';
            const seen = window.__progress;
            if (text && seen[seen.length - 1] !== text) seen.push(text);
        }).observe(document.querySelector('#status-strip'),
            { childList: true, characterData: true, subtree: true });
    });
    return () => page.evaluate(() => window.__progress);
}

test.describe('Plugin registry panel', () => {

    test('an empty registry says so; a scan shows its progress and leaves the list', async ({ page }) => {
        await serveRegistry(page, { scans: [{
            current: '/Library/Audio/Plug-Ins/VST3/CinderSynth.vst3',
            finds: [plugin('Basalt Compressor', { version: '1.4' }),
                    plugin('Cinder Synth', { version: '3.0', isInstrument: true })],
        }] });
        await open(page);
        const panel = panelOf(page);
        const scan = panel.locator('#plugin-scan-btn');
        const rows = panel.locator('.plugin-row');

        await page.click('#plugins-btn');
        await expect(panel.locator('.ap-note')).toHaveText(
            'No plugins known yet — scan to find the VST3 plugins installed on this machine.');
        await expect(rows).toHaveCount(0);
        await expect(scan).toBeEnabled();

        const progress = await watchProgress(page);
        await scan.click();
        await expect(scan).toBeDisabled();
        await expect(logLine(page)).toHaveText('plugin scan done: 2 known');
        expect(await progress()).toEqual(
            ['33% CinderSynth.vst3', '67% CinderSynth.vst3']);

        await expect(rows).toHaveCount(2);
        await expect(panel.locator('.ap-note')).toHaveCount(0);
        await expect(rows.nth(0)).toHaveText('🎚Basalt CompressorMocksound · 1.4');
        await expect(rows.nth(1)).toHaveText('🎹Cinder SynthMocksound · 3.0');
        await expect(rows.nth(1)).toHaveAttribute('title',
            '/Library/Audio/Plug-Ins/VST3/CinderSynth.vst3');
        await expect(scan).toBeEnabled();
        await expect(panel.locator('#plugin-scan-status')).toHaveText('');

        // Closed and opened again, the panel reads the registry afresh.
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);
        await page.click('#plugins-btn');
        await expect(rows).toHaveCount(2);
        const box = await page.locator('#session').boundingBox();
        await page.mouse.click(box.x + 40, box.y + 40);
        await expect(panel).toHaveCount(0);
    });

    test('a scan outlives its panel: reopened, the panel shows it running; closed, the status line still reports it', async ({ page }) => {
        await serveRegistry(page, { scans: [{
            held: true, current: '/plugins/Slow.vst3', finds: [plugin('Slow Verb')],
        }] });
        await open(page);
        const panel = panelOf(page);
        const scan = panel.locator('#plugin-scan-btn');
        const progress = panel.locator('#plugin-scan-status');

        await page.click('#plugins-btn');
        await scan.click();
        await expect(progress).toHaveText('67% Slow.vst3');
        await page.keyboard.press('Escape');
        await expect(panel).toHaveCount(0);

        await page.click('#plugins-btn');
        await expect(scan).toBeDisabled();
        await expect(progress).toHaveText('67% Slow.vst3');
        await expect(panel.locator('.plugin-row')).toHaveCount(0);

        // Any press outside closes the panel; the scan goes on.
        const box = await page.locator('#session').boundingBox();
        await page.mouse.click(box.x + 40, box.y + 40);
        await expect(panel).toHaveCount(0);
        await page.evaluate(() => { window.__releaseScan = true; });
        await expect(logLine(page)).toHaveText('plugin scan done: 1 known');

        await page.click('#plugins-btn');
        await expect(panel.locator('.plugin-row')).toHaveText('🎚Slow VerbMocksound · 1.0');
        await expect(scan).toBeEnabled();
        await expect(progress).toHaveText('');
    });

    test('a scan that lost plugins names them; a blacklist is counted', async ({ page }) => {
        await serveRegistry(page, {
            known: [plugin('Aurora Reverb')],
            scans: [
                { report: { crashed: ['Brittle.vst3', 'Stuck.vst3'],
                            blacklistCount: 2, error: 'worker would not start' } },
                { report: { blacklistCount: 2 } },
            ],
        });
        await open(page);
        const scan = panelOf(page).locator('#plugin-scan-btn');
        await page.click('#plugins-btn');

        await scan.click();
        await expect(logLine(page)).toHaveText(
            'plugin scan done: 1 known; excluded 2 that crashed or hung: ' +
            'Brittle.vst3, Stuck.vst3; scan error: worker would not start');
        await expect(scan).toBeEnabled();

        await scan.click();
        await expect(logLine(page)).toHaveText('plugin scan done: 1 known (2 blacklisted)');
        await expect(panelOf(page).locator('.plugin-row')).toHaveCount(1);
    });

    test('a plugin\'s name, maker, version and file are drawn as text, never as markup', async ({ page }) => {
        const hostile = plugin('Amp', {
            name: '<img src=x onerror="window.__ran=1"> & "Co"',
            maker: '<b>Maker</b>', version: '<i>2</i>',
            file: '/plugins/"quoted" & <odd>.vst3',
        });
        await serveRegistry(page, { known: [hostile] });
        await open(page);
        await page.click('#plugins-btn');
        const row = panelOf(page).locator('.plugin-row');
        await expect(row).toHaveCount(1);
        await expect(row.locator('b')).toHaveText(hostile.name);
        await expect(row.locator('span').nth(1)).toHaveText('<b>Maker</b> · <i>2</i>');
        await expect(row).toHaveAttribute('title', hostile.file);
        await expect(row.locator('img, i, b b')).toHaveCount(0);
        expect(await page.evaluate(() => window.__ran)).toBeUndefined();
    });
});

test.describe('Plugin chip of an effects row', () => {

    /** Open clip-1's effects row; answers it. */
    async function openFxRow(page) {
        await laneOf(page, 'clip-1').locator('.fx-btn').click();
        const row = page.locator('.lane-fx');
        await expect(row.locator('.fx-card')).toHaveCount(4);
        return row;
    }

    test('the chip\'s name asks for the plugin\'s own editor, on its lane and slot', async ({ page }) => {
        await open(page);
        const row = await openFxRow(page);
        await row.locator('.fx-add').click();
        await row.locator('.fx-picker-item', { hasText: 'Aurora Reverb' }).click();
        const chip = row.locator('.fx-card.fx-vst3');
        await expect(chip.locator('.fx-vst3-name')).toHaveText('Aurora Reverb');
        const slot = await chip.getAttribute('data-slot');
        expect(slot).toBeTruthy();

        const asked = [];
        page.on('console', async msg => {
            if (!msg.text().startsWith('[MockBackend] callNative: openPluginEditor')) return;
            asked.push(await msg.args()[1].jsonValue());
        });
        await chip.locator('.fx-vst3-name').click();
        await expect.poll(() => asked).toEqual([['clip-1', slot]]);
        // The editor is the plugin's window: the chain is as it was.
        await expect(chip).not.toHaveClass(/off/);
        await expect(row.locator('.fx-card.fx-vst3')).toHaveCount(1);
    });

    test('with no plugins known, the ＋ picker points at the Plugins panel', async ({ page }) => {
        await serveRegistry(page);
        await open(page);
        const row = await openFxRow(page);
        await row.locator('.fx-add').click();
        const picker = row.locator('.fx-picker');
        await expect(picker.locator('.fx-picker-empty'))
            .toHaveText('No plugins known — scan from the 🔌 Plugins panel');
        await expect(picker.locator('.fx-picker-item')).toHaveCount(0);
        // The panel it points at is one press away, and takes its place.
        await page.click('#plugins-btn');
        await expect(panelOf(page).locator('.ap-note')).toHaveText(/^No plugins known yet/);
        await expect(picker).toHaveCount(0);
    });
});
