/**
 * The Project menu's verbs and the project hotkeys, against the mock
 * (/?mock=true): save as template (the inline name entry's Enter and
 * Escape) and new from template, duplicate, open recent, ⌘S and ⌘O, and
 * the bounce and import refusals while a take is live. Each case reads
 * the status line and the project identity in the chrome.
 */

import { test, expect } from '@playwright/test';
import { boot, laneOf, graph, mock } from './helpers.js';

const PROJECT_ID = /^\d{8}-\d\d$/;

const logLine = page => page.locator('#log-line');
const menuButton = page => page.locator('#project-menu-btn');
const menu = page => page.locator('#project-menu');
/** A menu item by its exact label. */
const item = (page, label) => menu(page).locator('.pm-item', {
    hasText: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });

async function openMenu(page) {
    await menuButton(page).click();
    await expect(menu(page)).toBeVisible();
}

/** The project id the menu button's tooltip names ('' while unborn). */
async function projectId(page) {
    const title = await menuButton(page).getAttribute('title');
    const id = (title || '').split(' — ')[0];
    return PROJECT_ID.test(id) ? id : '';
}

/** Main Stack ▸ three committed tracks, in a project born by ⌘S;
 * answers its id. */
async function bornProject(page) {
    await boot(page, { scenario: 'stack-with-clips' });
    await expect(laneOf(page, 'clip-3')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+s');
    await expect(menuButton(page)).toHaveText(/^\d{8}-\d\d ▾$/);
    return projectId(page);
}

test.describe('Project menu verbs', () => {

    test('Save as template: Escape leaves nothing, Enter saves; New from template loads it', async ({ page }) => {
        await bornProject(page);
        const nameInput = menu(page).locator('input[placeholder="e.g. My Rig"]');

        await openMenu(page);
        await nameInput.click();
        await page.keyboard.press('Enter');          // no name: nothing to save
        await expect(menu(page)).toBeVisible();
        await page.keyboard.type('Trio');
        await page.keyboard.press('Escape');
        await expect(menu(page)).toBeHidden();
        await expect(logLine(page)).not.toHaveText(/Template/);

        await openMenu(page);
        await expect(item(page, 'My Rig')).toBeVisible();  // the list has loaded
        await expect(item(page, 'Trio')).toHaveCount(0);
        await expect(nameInput).toHaveValue('');
        await nameInput.click();
        await page.keyboard.type('  Trio ');
        await page.keyboard.press('Enter');
        await expect(logLine(page))
            .toHaveText('Template "Trio" saved — Project ▾ → New from template');
        await expect(menu(page)).toBeHidden();

        await openMenu(page);
        await item(page, 'Trio').click();
        await expect(logLine(page)).toHaveText('Template "Trio" loaded — play the seed');
        // A template is structure before any take: an unborn session.
        await expect(menuButton(page)).toHaveText('Project ▾');
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(0);
        expect(await projectId(page)).toBe('');
    });

    test('Duplicate forks to the next serial; the original opens again from the recents', async ({ page }) => {
        const original = await bornProject(page);

        await openMenu(page);
        await item(page, 'Duplicate project (next serial)').click();
        await expect(logLine(page)).toHaveText(
            /^Forked to \d{8}-\d\d — the original stays as a checkpoint$/);
        const fork = (await logLine(page).textContent()).split(' ')[2];
        expect(fork).not.toBe(original);
        await expect.poll(() => projectId(page)).toBe(fork);
        // The fork keeps the project's name; the folder is the new one.
        await expect(menuButton(page)).toHaveText(`${original} ▾`);

        await openMenu(page);
        await expect(item(page, `${original} · ${fork}`)).toBeVisible();
        await item(page, original).click();
        await expect(logLine(page)).toHaveText(`Opened ${original}`);
        await expect.poll(() => projectId(page)).toBe(original);
    });

    test('⌘S births an unborn project, then saves it', async ({ page }) => {
        await boot(page);
        await expect(menuButton(page)).toHaveText('Project ▾');
        expect(await projectId(page)).toBe('');

        await page.keyboard.press('ControlOrMeta+s');
        await expect(menuButton(page)).toHaveText(/^\d{8}-\d\d ▾$/);
        const id = await projectId(page);
        await expect(logLine(page)).toHaveText(`Project ${id} created — mirroring to disk`);

        await page.keyboard.press('ControlOrMeta+s');
        await expect(logLine(page)).toHaveText(`Saved ${id}`);
        expect(await projectId(page)).toBe(id);
        await openMenu(page);
        await expect(menu(page).locator('.pm-item').first()).toHaveText(`Save now (${id})`);
    });

    test('⌘O: a cancelled chooser says so; a chosen project loads and is not announced as new', async ({ page }) => {
        await boot(page);
        await page.keyboard.press('ControlOrMeta+o');
        await expect(logLine(page)).toHaveText('Open cancelled');
        await expect(menuButton(page)).toHaveText('Project ▾');

        // A session on the mock's disk: the chooser now answers it. (One
        // evaluate: no project poll may see the content in between.)
        await page.evaluate(async () => {
            const t = window.__celestrianTest;
            t.loadScenario('stack-with-clips');
            await t.callNative('saveSession', '');
            t.loadScenario('empty');
        });
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(0);
        await page.keyboard.press('ControlOrMeta+o');
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(3);
        await expect(menuButton(page)).toHaveText(/^\d{8}-\d\d ▾$/);
        await expect(logLine(page)).toHaveText('Project opened');

        // The menu's own item is the same verb.
        await page.keyboard.press('ControlOrMeta+s');
        await expect(logLine(page)).toHaveText(/^Saved /);
        await openMenu(page);
        await item(page, 'Open project folder…').click();
        await expect(menu(page)).toBeHidden();
        await expect(logLine(page)).toHaveText('Project opened');
    });

    test('Bounce and Import are refused, and say why, while a take is live', async ({ page }) => {
        await bornProject(page);
        const lane = laneOf(page, 'clip-3');
        await lane.locator('.arm-btn').click();
        // The view has the take: the lane's ✕ locks with it.
        await expect(lane.locator('.delete-btn')).toBeDisabled();

        await openMenu(page);
        await expect(item(page, 'Import audio…')).toBeDisabled();
        await item(page, 'Bounce song…').click();
        await expect(logLine(page)).toHaveText('Bounce refused — a take is live');
        expect(await mock(page, 'getLastBounce')).toBeNull();

        // The ＋ Track menu offers the import too.
        await page.locator('#create-track-btn').click();
        await page.locator('.creation-menu .creation-item.import').click();
        await expect(logLine(page)).toHaveText('Import refused — a take is live');
        expect(await mock(page, 'getLastImport')).toBeNull();
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(3);

        // With the take cancelled both go through.
        await lane.locator('.arm-btn').click();
        await expect(lane.locator('.delete-btn')).toBeEnabled();
        await openMenu(page);
        await item(page, 'Bounce song…').click();
        await expect(logLine(page)).toHaveText('Bounced');
        await page.locator('#create-track-btn').click();
        await page.locator('.creation-menu .creation-item.import').click();
        await expect(logLine(page)).toHaveText('Imported — ⌘Z to undo');
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(4);
        expect((await graph(page)).canUndo).toBe(true);
    });
});
