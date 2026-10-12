/**
 * The app shell e2e, against the mock (/?mock=true): what app.js and
 * the chrome modules owe that no pure module can pin —
 *   - the poll and the project refresh leave clickable chrome's DOM
 *     alone while nothing changed (the patch-layer law: WebKit drops a
 *     click whose mousedown text node was replaced before mouseup);
 *   - a retaking lane asks the backend for no take peaks;
 *   - Space: a held key is one press, and a second Space while a take
 *     finishes keeps the queued pause;
 *   - opening an existing project is not a birth;
 *   - a refused grouping says so;
 *   - a lost plugin-scan status ends the scan poll;
 *   - a master meter's clip lamp stays lit until its face is clicked.
 */

import { test, expect } from '@playwright/test';

async function boot(page, scenario) {
    await page.goto('/?mock=true');
    await page.waitForFunction(
        () => typeof window.__celestrianTest?.loadScenario === 'function',
        { timeout: 5000 });
    await page.evaluate(s => window.__celestrianTest.loadScenario(s), scenario);
    await expect(page.locator('.lane').first()).toBeVisible();
}

/** Birth the project now (⌘S), so the project poll's own birth
 * announcement cannot land on the status line mid-test. Answers the
 * project id. */
async function birthProject(page) {
    const button = page.locator('#project-menu-btn');
    await page.keyboard.press('ControlOrMeta+s');
    await expect(button).toHaveText(/^\d{8}-\d\d ▾$/);
    return (await button.textContent()).replace(' ▾', '');
}

const graphState = page =>
    page.evaluate(() => window.__celestrianTest.callNative('getGraphState'));

/** The published state of one node (depth-first by id). */
async function nodeState(page, id) {
    const find = nodes => {
        for (const n of nodes || []) {
            if (n.id === id) return n;
            const hit = find(n.nodes);
            if (hit) return hit;
        }
        return null;
    };
    return find((await graphState(page)).nodes);
}

/** Resolves once the poll has run and patched again: a rename shows on
 * the rail only through a poll. */
async function afterAPoll(page, id, name) {
    await page.evaluate(([i, n]) =>
        window.__celestrianTest.callNative('renameNode', i, n), [id, name]);
    await expect(page.locator(`.lane[data-id="${id}"] .rail-name`)).toHaveText(name);
}

/** Count every DOM write to `selector` from now on. `deep` also counts
 * its text and child nodes (a button's label); `title` writes count
 * either way. */
async function watchWrites(page, selector, deep = true) {
    await page.evaluate(([sel, subtree]) => {
        const counts = (window.__writes = window.__writes || {});
        counts[sel] = 0;
        new MutationObserver(records => { counts[sel] += records.length; })
            .observe(document.querySelector(sel), {
                attributes: true, attributeFilter: ['title'],
                childList: subtree, characterData: subtree, subtree,
            });
    }, [selector, deep]);
}
const writes = (page, selector) =>
    page.evaluate(sel => window.__writes[sel], selector);

test.describe('App shell', () => {

    test('the poll does not rewrite the Calibrate button; a click that spans a poll lands', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        await afterAPoll(page, 'clip-2', 'settled');
        await page.click('#prefs-btn');
        const button = page.locator('#calibrate-btn');
        await expect(button).toHaveText('🎯 Calibrate');
        await watchWrites(page, '#calibrate-btn');

        const box = await button.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await afterAPoll(page, 'clip-2', 'one poll');
        await afterAPoll(page, 'clip-2', 'two polls');
        expect(await writes(page, '#calibrate-btn')).toBe(0);
        await page.mouse.up();
        await expect(page.locator('#calibration-status')).toHaveText(/^Calibrating/);
    });

    test('a project refresh that changes nothing does not rewrite the Project button', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        await birthProject(page);
        await watchWrites(page, '#project-menu-btn');
        await page.evaluate(() => { document.getElementById('log-line').textContent = ''; });
        await page.keyboard.press('ControlOrMeta+s');
        await expect(page.locator('#log-line')).toHaveText(/^Saved /);
        expect(await writes(page, '#project-menu-btn')).toBe(0);
    });

    test('the master monitor title is not rewritten while its reading stands', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        await afterAPoll(page, 'clip-2', 'settled');
        await expect(page.locator('#master-monitor')).toHaveAttribute('title', /Master output/);
        await watchWrites(page, '#master-monitor', false);
        await afterAPoll(page, 'clip-2', 'one poll');
        await afterAPoll(page, 'clip-2', 'two polls');
        expect(await writes(page, '#master-monitor')).toBe(0);
    });

    test('a retaking lane asks the backend for no take peaks', async ({ page }) => {
        const asked = [];
        page.on('console', m => {
            if (m.text().includes('callNative: getTakeWaveform')) asked.push(m.text());
        });
        await boot(page, 'stack-with-clips');
        const lane = page.locator('.lane[data-id="clip-1"]');
        await afterAPoll(page, 'clip-2', 'settled');
        await lane.locator('.arm-btn').click();
        await expect.poll(async () => {
            const c = await nodeState(page, 'clip-1');
            return c.isRecording || c.isPendingStart;
        }).toBe(true);
        await expect.poll(() => lane.locator('.rep.silent').count()).toBeGreaterThan(0);
        for (const name of ['one poll', 'two polls', 'three polls']) {
            await afterAPoll(page, 'clip-2', name);
        }
        await expect(lane.locator('.rep.silent').first()).toBeVisible();
        expect(asked).toEqual([]);
    });

    test('a held Space is one press: the transport toggles once', async ({ page }) => {
        const toggles = [];
        page.on('console', m => {
            // (The mock's dispatch traces every bridge call.)
            if (m.text().includes('callNative: togglePlayback')) toggles.push(m.text());
        });
        await boot(page, 'stack-with-clips');
        await page.keyboard.down('Space');
        await page.keyboard.down('Space');  // auto-repeat
        await page.keyboard.down('Space');
        await page.keyboard.up('Space');
        await expect.poll(async () => (await graphState(page)).isPlaying).toBe(true);
        await afterAPoll(page, 'clip-2', 'one poll');
        expect(toggles).toHaveLength(1);
    });

    test('a second Space while the take finishes keeps the queued pause', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        await birthProject(page);
        // A frozen clock the test advances by hand: the transport reads
        // as playing, and nothing lands until the test says so.
        const { id, step } = await page.evaluate(async () => {
            const t = window.__celestrianTest;
            const quarter = (await t.callNative('getGraphState')).quantum / 4;
            t.setIsPlaying(true);
            await t.callNative('createNode', 'clip', '');
            const top = (await t.callNative('getGraphState')).nodes;
            const fresh = top[top.length - 1].id;
            await t.callNative('startRecordingInNode', fresh);
            return { id: fresh, step: quarter };
        });
        const advanceUntil = async done => {
            for (let i = 0; i < 16 && !done(await nodeState(page, id)); i++) {
                await page.evaluate(s => window.__celestrianTest.advanceBy(s), step);
            }
        };
        await advanceUntil(n => n.isRecording && !n.isPendingStart);
        await page.evaluate(s => window.__celestrianTest.advanceBy(s), step);
        await expect(page.locator(`.lane[data-id="${id}"] .recording-bar`)).toBeVisible();

        const log = page.locator('#log-line');
        await page.keyboard.press('Space');
        await expect(log).toHaveText('Stopping recording at the boundary, then pausing');
        expect((await nodeState(page, id)).isRecording).toBe(true);
        await page.keyboard.press('Space');
        await afterAPoll(page, 'clip-2', 'one poll');
        expect((await graphState(page)).isPlaying).toBe(true);

        await advanceUntil(n => !n.isRecording && n.duration > 0);
        await expect(log).toHaveText('Recording stopped — paused');
        expect((await graphState(page)).isPlaying).toBe(false);
    });

    test('opening an existing project is not a birth: no "created", no folds carried over', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        const button = page.locator('#project-menu-btn');
        const menu = page.locator('#project-menu');
        const log = page.locator('#log-line');
        const projectId = await birthProject(page);  // a project to reopen

        // Back to an unborn session, as a fresh launch is.
        await button.click();
        await menu.locator('.pm-item:has-text("My Rig")').click();
        await expect(button).toHaveText('Project ▾');
        await expect(page.locator(
            '.lane[data-kind="clip"], .lane[data-kind="group"]')).toHaveCount(0);

        // Fold a group in the unborn session.
        const groupId = await page.evaluate(async () => {
            const t = window.__celestrianTest;
            await t.callNative('createNode', 'clip', '');
            await t.callNative('createNode', 'clip', '');
            const [a, b] = (await t.callNative('getGraphState')).nodes;
            return t.callNative('combineNodes', b.id, a.id);
        });
        const group = page.locator(`.lane[data-id="${groupId}"]`);
        await group.locator('.fold-btn').click();
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(0);

        await button.click();
        await menu.locator(`.pm-item:has-text("${projectId}")`).click();
        await expect(button).toHaveText(`${projectId} ▾`);
        await expect(log).toHaveText(`Opened ${projectId}`);
        // The project poll comes round and still does not call it a birth.
        await page.evaluate(() => { document.getElementById('log-line').textContent = ''; });
        await page.keyboard.press('ControlOrMeta+s');
        await expect(log).toHaveText(`Saved ${projectId}`);
        const stored = await page.evaluate(id =>
            localStorage.getItem(`celestrian.viewPrefs.${id}.folded`), projectId);
        expect(JSON.parse(stored || '[]')).not.toContain(groupId);
    });

    test('"Save as template" says where the template is used, and the menu then offers it', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        await birthProject(page);
        const menu = page.locator('#project-menu');
        await page.click('#project-menu-btn');
        const row = menu.locator('.pm-inline', { has: page.locator('input[placeholder="e.g. My Rig"]') });
        await row.locator('input').fill('Trio');
        await row.locator('button').click();
        await expect(page.locator('#log-line'))
            .toHaveText('Template "Trio" saved — Project ▾ → New from template');
        await expect(menu).toBeHidden();

        await page.click('#project-menu-btn');
        await expect(menu.locator('.pm-head:has-text("New from template")')).toBeVisible();
        await expect(menu.locator('.pm-item', { hasText: /^Trio$/ })).toBeVisible();
    });

    test('grouping refused under a live take says so', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        await birthProject(page);
        await page.locator('.lane[data-id="clip-1"] .rail-name').click();
        await page.locator('.lane[data-id="clip-2"] .rail-name')
            .click({ modifiers: ['ControlOrMeta'] });
        const group = page.locator('#selection-bar .sel-group');
        await expect(group).toBeVisible();
        await page.evaluate(() =>
            window.__celestrianTest.callNative('newTake', 'clip-3'));
        // The view has the take (its slot's tiles go silent) before the click.
        await expect.poll(() =>
            page.locator('.lane[data-id="clip-3"] .rep.silent').count())
            .toBeGreaterThan(0);
        await group.click();
        await expect(page.locator('#log-line')).toHaveText('Grouping refused — a take is live');
        expect((await graphState(page)).nodes).toHaveLength(1);
    });

    test('a lost plugin-scan status ends the scan poll and frees the Scan button', async ({ page }) => {
        // The mock's plugin registry, with a scan whose status never
        // arrives (callNative answers null for a lost call).
        await page.route('**/js/mock/plugins.js', route => route.fulfill({
            contentType: 'application/javascript',
            body: `
                export const getKnownPlugins = () => [];
                export const scanPlugins = () => true;
                export const getPluginScanStatus = () => null;
                export const resetPlugins = () => {};
            `,
        }));
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await boot(page, 'stack-with-clips');
        await birthProject(page);
        await page.click('#plugins-btn');
        const scan = page.locator('#plugin-scan-btn');
        await scan.click();
        await expect(page.locator('#log-line')).toHaveText(/plugin scan status lost/);
        await expect(scan).toBeEnabled();
        await afterAPoll(page, 'clip-2', 'one poll');
        expect(errors).toEqual([]);
    });

    test('a master meter\'s clip lamp stays lit through silence; a click on its face releases it', async ({ page }) => {
        // The mock's synthesized level never reaches full scale: its
        // publisher is served with an over the test can raise.
        await page.route('**/js/mock/publish.js', async route => {
            const res = await route.fetch();
            const src = await res.text();
            const anchor = 'function mockMasterVu(phase) {';
            if (!src.includes(anchor)) throw new Error('mock/publish.js anchor moved');
            await route.fulfill({ response: res, body: src.replace(anchor,
                anchor + '\n    if (window.__masterOver) return window.__masterOver;') });
        });
        await boot(page, 'stack-with-clips');
        const left = page.locator('#vu-l');
        const right = page.locator('#vu-r');
        await afterAPoll(page, 'clip-2', 'settled');
        await expect(left).not.toHaveClass(/clipped/);

        await page.evaluate(() => { window.__masterOver = 1.25; });
        await expect(left).toHaveClass(/clipped/);
        await expect(right).toHaveClass(/clipped/);
        await page.evaluate(() => { window.__masterOver = 0; });
        await afterAPoll(page, 'clip-2', 'one poll');
        await afterAPoll(page, 'clip-2', 'two polls');
        await expect(left).toHaveClass(/clipped/);
        await expect(left.locator('.peak')).toHaveClass(/latched/);

        // Each face releases its own lamp.
        await left.click();
        await expect(left).not.toHaveClass(/clipped/);
        await expect(left.locator('.peak')).not.toHaveClass(/latched/);
        await expect(right).toHaveClass(/clipped/);
        await right.click();
        await expect(right).not.toHaveClass(/clipped/);
    });
});

test.describe('Shell popovers', () => {

    /** Select clip-1 by its rail name; answers the rail. */
    async function selectLane(page) {
        const rail = page.locator('.lane[data-id="clip-1"] .lane-rail');
        await rail.locator('.rail-name').click();
        await expect(rail).toHaveClass(/selected/);
        return rail;
    }

    /** A real press on the canvas's top-left corner, clear of every
     * popover (they hang from the right of the transport and the
     * status strip). */
    async function pressOutside(page) {
        const box = await page.locator('#session').boundingBox();
        await page.mouse.move(box.x + 40, box.y + 40);
        await page.mouse.down();
        await page.mouse.up();
    }

    test('Escape closes the Project menu and leaves the selection alone', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        const rail = await selectLane(page);
        const menu = page.locator('#project-menu');
        await page.click('#project-menu-btn');
        await expect(menu).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(rail).toHaveClass(/selected/);
        // With the menu closed, Escape is the view's again.
        await page.keyboard.press('Escape');
        await expect(rail).not.toHaveClass(/selected/);
    });

    test('each popover toggles on its button and closes on a press outside', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        const popovers = [
            ['#project-menu-btn', '#project-menu'],
            ['#prefs-btn', '#prefs-panel'],
            ['#plugins-btn', '#status-strip .audio-panel'],
        ];
        for (const [button, panel] of popovers) {
            await page.click(button);
            await expect(page.locator(panel), panel).toBeVisible();
            await page.click(button);
            await expect(page.locator(panel), panel).toBeHidden();
            await page.click(button);
            await expect(page.locator(panel), panel).toBeVisible();
            await pressOutside(page);
            await expect(page.locator(panel), panel).toBeHidden();
        }
    });

    test('a press inside a popover keeps it open; opening another closes it', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        const prefs = page.locator('#prefs-panel');
        await page.click('#prefs-btn');
        await expect(prefs).toBeVisible();
        await prefs.locator('.ap-head').click();
        await expect(prefs).toBeVisible();

        await page.click('#project-menu-btn');
        await expect(page.locator('#project-menu')).toBeVisible();
        await expect(prefs).toBeHidden();

        await page.click('#plugins-btn');
        const plugins = page.locator('#status-strip .audio-panel');
        await expect(plugins).toBeVisible();
        await expect(page.locator('#project-menu')).toBeHidden();
        // The plugin panel re-renders itself when its list arrives: a
        // press on what it shows now is still a press inside.
        await plugins.locator('#plugin-scan-btn').click();
        await expect(plugins).toBeVisible();
    });

    test('the plugin panel lists the registry; a scan shows its progress, then what it found', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        await birthProject(page);
        await page.click('#plugins-btn');
        const panel = page.locator('#status-strip .audio-panel');
        const rows = panel.locator('.plugin-row');
        await expect(rows).toHaveCount(2);
        await expect(rows.first()).toContainText('Aurora Reverb');
        await expect(rows.first()).toHaveAttribute('title', /AuroraReverb\.vst3$/);

        // The scan's status line shows before the scan ends; hold the
        // first poll's paint by watching for it as it happens.
        const progress = page.evaluate(() => new Promise(resolve => {
            const seen = new MutationObserver(() => {
                const line = document.querySelector('#plugin-scan-status');
                if (line && line.textContent) { seen.disconnect(); resolve(line.textContent); }
            });
            seen.observe(document.querySelector('#status-strip'),
                { childList: true, characterData: true, subtree: true });
        }));
        await panel.locator('#plugin-scan-btn').click();
        expect(await progress).toMatch(/^\d+% CinderSynth\.vst3$/);

        await expect(page.locator('#log-line')).toHaveText('plugin scan done: 3 known');
        await expect(rows).toHaveCount(3);
        await expect(rows.nth(2)).toContainText('Cinder Synth');
        await expect(panel.locator('#plugin-scan-btn')).toBeEnabled();
    });

    test('Escape closes the plugin panel and leaves the selection alone', async ({ page }) => {
        await boot(page, 'stack-with-clips');
        const rail = await selectLane(page);
        const plugins = page.locator('#status-strip .audio-panel');
        await page.click('#plugins-btn');
        await expect(plugins).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(plugins).toHaveCount(0);
        await expect(rail).toHaveClass(/selected/);
    });
});
