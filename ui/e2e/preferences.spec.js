/**
 * The preferences panel e2e (tasks.md B8), against the mock: the
 * transport's gear opens the one panel — device pickers, calibration,
 * the projects root read from getProjectInfo — "Change…" hands the
 * folder pick to chooseProjectsRoot and the line follows, and Escape
 * closes the panel (PANEL scope: the selection stays). Each device
 * picker applies its choice through setAudioDevice and re-reads the
 * device; Calibrate runs to its result; Dump State (the status strip)
 * hands the state to the backend and says where it went.
 */

import { test, expect } from '@playwright/test';

/** Every bridge call the page makes from now on, in order (the mock
 * logs each non-poll call): {method, args}. */
function recordCalls(page) {
    const calls = [];
    page.on('console', async msg => {
        const m = /^\[MockBackend\] callNative: (\w+)/.exec(msg.text());
        if (!m) return;
        const entry = { method: m[1], args: null };
        calls.push(entry);
        try { entry.args = await msg.args()[1].jsonValue(); } catch (_) { /* page gone */ }
    });
    return calls;
}

const graphState = page =>
    page.evaluate(() => window.__celestrianTest.callNative('getGraphState'));

test.describe('Preferences (B8)', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
        await page.evaluate(() => window.__celestrianTest.loadScenario('stack-with-clips'));
        await expect(page.locator('.lane[data-id="clip-1"]')).toBeVisible();
    });

    test('gear opens; root shown; Change… calls the mock; Escape closes', async ({ page }) => {
        // A selected lane first: PANEL-scope Escape must close the
        // panel and leave the selection alone.
        // Click the NAME: the rail's centre is a rail button, which
        // swallows the click (the rail-click gotcha).
        const rail = page.locator('.lane[data-id="clip-1"] .lane-rail');
        await rail.locator('.rail-name').click();
        await expect(rail).toHaveClass(/selected/);

        const panel = page.locator('#prefs-panel');
        await expect(panel).toBeHidden();
        await page.click('#prefs-btn');
        await expect(panel).toBeVisible();
        await expect(panel).toHaveClass(/open/);

        // The device pickers render into the panel (the mock's device).
        await expect(panel.locator('#audio-device-host select')).toHaveCount(4);
        await expect(panel.locator('#calibrate-btn')).toBeVisible();

        await expect(panel.locator('#projects-root'))
            .toHaveText('/Users/mock/Music/Celestrian/Projects');
        await panel.locator('#projects-root-change').click();
        await expect(panel.locator('#projects-root'))
            .toHaveText('/Volumes/Studio/Celestrian/Projects');
        await expect(page.locator('#log-line'))
            .toHaveText('Projects folder → /Volumes/Studio/Celestrian');

        // Escape closes the panel and does NOT clear the lane selection.
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect(rail).toHaveClass(/selected/);
    });

    test('each device picker applies its choice and the pickers follow the device', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        const host = page.locator('#audio-device-host');
        const log = page.locator('#log-line');
        /** The <select> of the row labelled `label`. */
        const picker = label => host.locator('.ap-row')
            .filter({ has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) })
            .locator('select');
        const calls = recordCalls(page);
        /** Pick `value` in a picker; answers setAudioDevice's arguments
         * once the status line has reported the answer. */
        const pick = async (label, value) => {
            await page.evaluate(() => { document.getElementById('log-line').textContent = ''; });
            const seen = calls.length;
            await picker(label).selectOption(value);
            await expect(log).toHaveText('Audio device updated.');
            await expect.poll(() => calls.slice(seen)
                .filter(c => c.method === 'setAudioDevice' && c.args).length).toBe(1);
            return calls.slice(seen).find(c => c.method === 'setAudioDevice').args;
        };

        await page.click('#prefs-btn');
        await expect(picker('Driver')).toHaveValue('Windows Audio');
        await expect(picker('Device')).toHaveValue('Microphone (USB Audio Device)');
        await expect(host.locator('.ap-stat')).toHaveText('2 inputs · 2 outputs');
        await expect(host.locator('.ap-hint')).toHaveText(/Switch Driver to ASIO/);

        // A driver switch names no device: the engine picks that type's.
        expect(await pick('Driver', 'ASIO')).toEqual(['ASIO', '', 0, 0]);
        await expect(picker('Driver')).toHaveValue('ASIO');
        await expect(picker('Device')).toHaveValue('MOTU Audio ASIO');
        await expect(picker('Device').locator('option'))
            .toHaveText(['MOTU Audio ASIO', 'ASIO4ALL v2']);
        await expect(host.locator('.ap-stat')).toHaveText('10 inputs · 2 outputs');
        await expect(host.locator('.ap-hint')).toHaveCount(0);

        expect(await pick('Device', 'ASIO4ALL v2')).toEqual(['ASIO', 'ASIO4ALL v2', 0, 0]);
        await expect(picker('Device')).toHaveValue('ASIO4ALL v2');
        await expect(host.locator('.ap-stat')).toHaveText('2 inputs · 2 outputs');

        // A rate other than the one in force: the engine re-rates.
        const rate = (await graphState(page)).perf.sampleRate === 96000 ? 48000 : 96000;
        expect(await pick('Sample rate', String(rate)))
            .toEqual(['ASIO', 'ASIO4ALL v2', rate, 0]);
        await expect(picker('Sample rate')).toHaveValue(String(rate));
        await expect.poll(async () => (await graphState(page)).perf.sampleRate).toBe(rate);

        expect(await pick('Buffer', '512')).toEqual(['ASIO', 'ASIO4ALL v2', 0, 512]);
        await expect(picker('Buffer')).toHaveValue('512');
        // The buffer's latency reads at the rate now in force.
        await expect(picker('Buffer').locator('option:checked'))
            .toHaveText(`512 samples (${(512 / rate * 1000).toFixed(1)} ms)`);
        expect(errors).toEqual([]);
    });

    test('Calibrate runs to its result; the button then offers a recalibration', async ({ page }) => {
        await page.click('#prefs-btn');
        const button = page.locator('#calibrate-btn');
        const status = page.locator('#calibration-status');
        await expect(button).toHaveText('🎯 Calibrate');
        await expect(status).toHaveText('');
        const calls = recordCalls(page);

        await button.click();
        await expect(button).toBeDisabled();
        await expect(status).toHaveText('Calibrating… (keep quiet, click incoming)');
        await expect(button).toHaveText('🎯 Calibrate');  // not relabelled mid-measure

        // The mock measures for two seconds, then reports 1024 samples.
        const ms = (1024 / (await graphState(page)).perf.sampleRate * 1000).toFixed(1);
        await expect(status).toHaveText(`Latency: 1024 samples (${ms} ms)`, { timeout: 8000 });
        await expect(button).toBeEnabled();
        await expect(button).toHaveText(`🎯 Recalibrate (${ms} ms)`);
        expect(calls.filter(c => c.method === 'startLatencyCalibration')).toHaveLength(1);
        expect((await graphState(page)).perf).toMatchObject(
            { calibrated: true, latencyCompensationSamples: 1024 });
    });

    test('Dump State hands the published state to the backend and says where it went', async ({ page }) => {
        const calls = recordCalls(page);
        await page.click('#dump-state-btn');
        await expect(page.locator('#log-line'))
            .toHaveText('State dumped to celestrian_state.json');
        const dumped = () => calls.find(c => c.method === 'dumpStateToFile');
        await expect.poll(() => !!(dumped() && dumped().args)).toBe(true);
        const state = JSON.parse(dumped().args[0]);
        expect(state.id).toBe('mock-root');
        expect(state.nodes.map(n => n.id)).toEqual(['stack-1']);
        expect(state.nodes[0].nodes.map(n => n.id)).toEqual(['clip-1', 'clip-2', 'clip-3']);
    });
});
