/**
 * The track verbs of the rail, against the mock (/?mock=true), each
 * driven by real input: grouping by drag (HTML5 drag-and-drop from one
 * rail onto another, onto a group, onto the ＋ Track row), the selection
 * bar's Group, a group's ungroup, delete, solo, the pan dial, and the R
 * key. Each case asserts the graph the engine holds, the status line
 * and — where the verb is undoable — what ⌘Z gives back.
 */

import { test, expect } from '@playwright/test';
import { boot, laneOf, call, graph, node, mock, centreOf, undo, consoleDrained }
    from './helpers.js';

const ROOT = 'mock-root';

/** The graph as nested ids: a track is its id, a group [id, [members]]. */
const shape = nodes => nodes.map(n => n.nodes ? [n.id, shape(n.nodes)] : n.id);
const tree = async page => shape((await graph(page)).nodes);

/** Armed or capturing. */
const isHot = async (page, id) => {
    const n = await node(page, id);
    return !!(n && (n.isRecording || n.isPendingStart));
};

const logLine = page => page.locator('#log-line');
const nameOf = (page, id) => laneOf(page, id).locator('.rail-name');
const railOf = (page, id) => laneOf(page, id).locator('.lane-rail');

/** Birth the project now (⌘S): the project poll announces a birth on
 * the status line, and it must not land there mid-test. */
async function birthProject(page) {
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.locator('#project-menu-btn')).toHaveText(/^\d{8}-\d\d ▾$/);
}

/** Main Stack ▸ Clip A (2Q), Clip B (3Q), Clip C (1Q). */
async function groupOfThree(page) {
    await boot(page, { scenario: 'stack-with-clips' });
    await expect(laneOf(page, 'clip-3')).toBeVisible();
    await birthProject(page);
}

/** Clip A, Clip B and Clip C as three top-level tracks, with an empty
 * undo log (a session load starts one). */
async function looseTracks(page) {
    await boot(page, { scenario: 'stack-with-clips' });
    await page.evaluate(async root => {
        const c = window.__celestrianTest.callNative;
        for (const [i, id] of ['clip-1', 'clip-2', 'clip-3'].entries()) {
            await c('reorderNode', id, root, i);
        }
        await c('deleteNode', 'stack-1');
        await c('saveSession', '');
        await c('loadSession', '');
    }, ROOT);
    expect(await tree(page)).toEqual(['clip-1', 'clip-2', 'clip-3']);
    await expect(page.locator('.lane[data-kind="group"]')).toHaveCount(0);
    await expect(laneOf(page, 'clip-3')).toBeVisible();
    await birthProject(page);
}

/** Every bridge call the page makes from now on, in order (the mock
 * logs each non-poll call): {method, args}. The methods are complete
 * after `consoleDrained`; an entry's args land a moment after it. */
function recordCalls(page) {
    const calls = [];
    page.on('console', async msg => {
        const m = /^\[MockBackend\] callNative: (\w+)/.exec(msg.text());
        if (!m) return;
        const entry = { method: m[1], args: [] };
        calls.push(entry);
        try { entry.args = await msg.args()[1].jsonValue(); } catch (_) { /* page gone */ }
    });
    return calls;
}
const methodsOf = calls => calls.map(c => c.method);

/** Where each HTML5 drop lands from now on: the lane's id, or the
 * element's own. Proves a drag ended in a real drop. */
async function recordDrops(page) {
    await page.evaluate(() => {
        window.__drops = [];
        document.addEventListener('drop', e => {
            const lane = e.target.closest('.lane');
            const row = e.target.closest('#create-row');
            window.__drops.push(lane ? lane.dataset.id : row ? row.id : '?');
        }, true);
    });
    return () => page.evaluate(() => window.__drops);
}

/**
 * Drag lane `id`'s rail, by its name, to the centre of `target` with
 * the real mouse — the browser's own drag-and-drop: dragstart on the
 * rail, dragover and drop on whatever lies under the pointer. `hold`
 * leaves the button down over the target.
 */
async function dragRail(page, id, target, { hold = false } = {}) {
    // The lanes scroll: the ＋ Track row can lie below the fold.
    await target.scrollIntoViewIfNeeded();
    const from = await centreOf(nameOf(page, id));
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // A drag begins once the pointer has travelled a few pixels.
    await page.mouse.move(from.x + 6, from.y + 4, { steps: 3 });
    await hoverDrag(page, target);
    if (!hold) await page.mouse.up();
}

/** Carry the drag in hand over `target` and rest there. A browser
 * fires dragover continuously over a resting pointer; the automated
 * mouse fires one per move, and none on the move that enters an
 * element — so the last move is made twice. */
async function hoverDrag(page, target) {
    const to = await centreOf(target);
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.move(to.x, to.y);
}

/** No uncaught error may reach the page during a case. */
function watchErrors(page) {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    return errors;
}

test.describe('Grouping by drag', () => {

    test('a rail dropped on another track wraps both in a new group; ⌘Z takes it back', async ({ page }) => {
        const errors = watchErrors(page);
        await looseTracks(page);
        const drops = await recordDrops(page);

        await dragRail(page, 'clip-3', nameOf(page, 'clip-1'));
        await expect(logLine(page))
            .toHaveText('Grouped with "Clip A" — rename the group on its rail');
        expect(await drops()).toEqual(['clip-1']);
        const [[groupId, members], ...rest] = await tree(page);
        expect(members).toEqual(['clip-1', 'clip-3']);  // target first
        expect(rest).toEqual(['clip-2']);               // in the target's slot
        await expect(laneOf(page, groupId)).toHaveAttribute('data-kind', 'group');
        await expect(railOf(page, 'clip-3')).not.toHaveClass(/dragging/);
        await expect(railOf(page, 'clip-1')).not.toHaveClass(/drop-target/);

        await undo(page);
        await expect(logLine(page)).toHaveText('Undo');
        await expect(page.locator('.lane[data-kind="group"]')).toHaveCount(0);
        expect(await tree(page)).toEqual(['clip-1', 'clip-2', 'clip-3']);
        expect((await graph(page)).canUndo).toBe(false);  // the one step
        expect(errors).toEqual([]);
    });

    test('a rail dropped on a group moves inside it', async ({ page }) => {
        await looseTracks(page);
        const groupId = await call(page, 'combineNodes', 'clip-2', 'clip-1');
        await expect(laneOf(page, groupId)).toBeVisible();
        await call(page, 'renameNode', groupId, 'Rhythm');
        await expect(nameOf(page, groupId)).toHaveText('Rhythm');

        await dragRail(page, 'clip-3', nameOf(page, groupId));
        await expect(logLine(page)).toHaveText('Moved into "Rhythm"');
        expect(await tree(page)).toEqual([[groupId, ['clip-1', 'clip-2', 'clip-3']]]);
    });

    test('dragging one of several selected rails carries them all', async ({ page }) => {
        await looseTracks(page);
        await nameOf(page, 'clip-2').click();
        await nameOf(page, 'clip-3').click({ modifiers: ['ControlOrMeta'] });
        const bar = page.locator('#selection-bar');
        await expect(bar.locator('.sel-count')).toHaveText('2 tracks selected');

        await dragRail(page, 'clip-3', nameOf(page, 'clip-1'));
        await expect(logLine(page)).toHaveText('Grouped 2 tracks with "Clip A"');
        const [[groupId, members], ...rest] = await tree(page);
        expect(members).toEqual(['clip-1', 'clip-2', 'clip-3']);
        expect(rest).toEqual([]);
        await expect(laneOf(page, groupId)).toHaveAttribute('data-kind', 'group');
        // The drop spends the selection.
        await expect(bar).not.toHaveClass(/open/);
    });

    test('a rail dropped on itself does nothing', async ({ page }) => {
        await looseTracks(page);
        const drops = await recordDrops(page);
        await page.evaluate(() => { document.getElementById('log-line').textContent = ''; });
        const calls = recordCalls(page);

        // Out over the next lane and back: a real drag that ends at home.
        await dragRail(page, 'clip-1', nameOf(page, 'clip-2'), { hold: true });
        await expect(railOf(page, 'clip-2')).toHaveClass(/drop-target/);
        await hoverDrag(page, nameOf(page, 'clip-1'));
        await page.mouse.up();

        await expect.poll(drops).toEqual(['clip-1']);
        expect(await tree(page)).toEqual(['clip-1', 'clip-2', 'clip-3']);
        expect((await graph(page)).canUndo).toBe(false);
        await consoleDrained(page);
        expect(methodsOf(calls)).toEqual([]);
        await expect(logLine(page)).toHaveText('');
        await expect(railOf(page, 'clip-2')).not.toHaveClass(/drop-target/);
    });

    test('a group dropped on its own member is refused: nothing changes, no undo step', async ({ page }) => {
        await groupOfThree(page);
        const drops = await recordDrops(page);
        const before = await tree(page);
        expect((await graph(page)).canUndo).toBe(false);

        await dragRail(page, 'stack-1', nameOf(page, 'clip-2'));
        await expect(logLine(page)).toHaveText('Grouping refused — nothing changed');
        expect(await drops()).toEqual(['clip-2']);
        expect(await tree(page)).toEqual(before);
        expect((await graph(page)).canUndo).toBe(false);
        await expect(laneOf(page, 'stack-1')).toBeVisible();
    });

    test('a member dropped on the ＋ Track row moves to the top level', async ({ page }) => {
        await groupOfThree(page);
        const drops = await recordDrops(page);
        const row = page.locator('#create-row');
        const button = page.locator('#create-track-btn');
        await expect(button).toHaveText('＋ Track');

        await dragRail(page, 'clip-2', button, { hold: true });
        await expect(button).toHaveText('⤒ Move to top level');
        await expect(row).toHaveClass(/drop-target/);
        await page.mouse.up();

        await expect(logLine(page)).toHaveText('Moved to the top level');
        expect(await drops()).toEqual(['create-row']);
        expect(await tree(page)).toEqual([['stack-1', ['clip-1', 'clip-3']], 'clip-2']);
        await expect(button).toHaveText('＋ Track');
        await expect(row).not.toHaveClass(/drop-target/);
        // The row is still the creation button: no menu opened by the drop.
        await expect(page.locator('.creation-menu')).toHaveCount(0);
    });
});

test.describe('Selection bar and ungroup', () => {

    test('⌘-click two rails, then Group: the group holds them in the first one\'s slot', async ({ page }) => {
        await looseTracks(page);
        const bar = page.locator('#selection-bar');
        const selectTwo = async () => {
            await nameOf(page, 'clip-2').click();
            await nameOf(page, 'clip-3').click({ modifiers: ['ControlOrMeta'] });
            await expect(bar).toHaveClass(/open/);
            await expect(bar.locator('.sel-count')).toHaveText('2 tracks selected');
        };
        // Clear lets the selection go and changes nothing.
        await selectTwo();
        await bar.locator('.sel-clear').click();
        await expect(bar).not.toHaveClass(/open/);
        await expect(page.locator('.lane-rail.selected')).toHaveCount(0);
        expect(await tree(page)).toEqual(['clip-1', 'clip-2', 'clip-3']);

        await selectTwo();
        await bar.locator('.sel-group').click();
        await expect(logLine(page))
            .toHaveText('Grouped 2 tracks — rename the group on its rail');
        const [first, [groupId, members]] = await tree(page);
        expect(first).toBe('clip-1');
        expect(members).toEqual(['clip-2', 'clip-3']);
        await expect(laneOf(page, groupId)).toHaveAttribute('data-kind', 'group');
        await expect(bar).not.toHaveClass(/open/);
    });

    test('a group\'s ⤒ returns its tracks to the group\'s slot; ⌘Z steps back through it', async ({ page }) => {
        await boot(page, { scenario: 'stack-with-clips' });
        // A track either side of the group, so its slot shows.
        const [before, after] = await page.evaluate(async root => {
            const c = window.__celestrianTest.callNative;
            const a = await c('createNode', 'clip', '');
            const b = await c('createNode', 'clip', '');
            await c('reorderNode', a, root, 0);
            await c('saveSession', '');
            await c('loadSession', '');
            return [a, b];
        }, ROOT);
        const grouped = [before, ['stack-1', ['clip-1', 'clip-2', 'clip-3']], after];
        expect(await tree(page)).toEqual(grouped);
        await expect(laneOf(page, after)).toBeVisible();
        await birthProject(page);

        await laneOf(page, 'stack-1').locator('.ungroup-btn').click();
        await expect(logLine(page)).toHaveText(
            'Ungrouped "Main Stack" — tracks moved up (⌘Z steps back through it)');
        expect(await tree(page)).toEqual([before, 'clip-1', 'clip-2', 'clip-3', after]);
        await expect(page.locator('.lane[data-kind="group"]')).toHaveCount(0);

        // One step for the emptied group — back where the tracks left
        // it, below them — then one per track moved.
        await undo(page);
        await expect(laneOf(page, 'stack-1')).toBeVisible();
        expect(await tree(page)).toEqual(
            [before, 'clip-1', 'clip-2', 'clip-3', ['stack-1', []], after]);
        for (const left of [2, 1, 0]) {
            await undo(page);
            await expect.poll(async () =>
                (await node(page, 'stack-1')).nodes.length).toBe(3 - left);
        }
        expect(await tree(page)).toEqual(grouped);
        expect((await graph(page)).canUndo).toBe(false);
    });

    test('an ungroup refused under a live take says so: no track moves, and the group is not deleted', async ({ page }) => {
        await groupOfThree(page);
        const lane = laneOf(page, 'clip-3');
        await lane.locator('.arm-btn').click();
        await expect(lane.locator('.delete-btn')).toBeDisabled();  // the view has the take
        const calls = recordCalls(page);

        await laneOf(page, 'stack-1').locator('.ungroup-btn').click();
        await expect(logLine(page)).toHaveText('Ungroup refused — a take is live');
        expect(await tree(page)).toEqual([['stack-1', ['clip-1', 'clip-2', 'clip-3']]]);
        // The first refusal ended it: one move asked, no delete.
        await consoleDrained(page);
        expect(methodsOf(calls)).toEqual(['reorderNode']);
        await expect(laneOf(page, 'stack-1')).toBeVisible();
    });
});

test.describe('Delete, solo, pan', () => {

    test('✕ deletes the lane and ⌘Z restores it; a lane with a live take cannot be deleted', async ({ page }) => {
        await groupOfThree(page);
        const lane = laneOf(page, 'clip-3');
        const del = lane.locator('.delete-btn');
        await expect(del).toBeEnabled();
        await del.click();
        await expect(logLine(page)).toHaveText('Deleted — ⌘Z to undo');
        await expect(lane).toHaveCount(0);
        expect(await tree(page)).toEqual([['stack-1', ['clip-1', 'clip-2']]]);

        await undo(page);
        await expect(lane).toBeVisible();
        expect(await tree(page)).toEqual([['stack-1', ['clip-1', 'clip-2', 'clip-3']]]);

        // Its ● starts a new take of the slot: live from the arm.
        await lane.locator('.arm-btn').click();
        await expect.poll(() => isHot(page, 'clip-3')).toBe(true);
        await expect(del).toBeDisabled();
        await lane.locator('.arm-btn').click();
        await expect.poll(() => isHot(page, 'clip-3')).toBe(false);
        await expect(del).toBeEnabled();
    });

    test('a ✕ refused under another lane\'s live take says so', async ({ page }) => {
        await groupOfThree(page);
        const hot = laneOf(page, 'clip-3');
        await hot.locator('.arm-btn').click();
        await expect(hot.locator('.delete-btn')).toBeDisabled();  // the view has the take

        await laneOf(page, 'clip-1').locator('.delete-btn').click();
        await expect(logLine(page)).toHaveText('Delete refused — a take is live');
        await expect(laneOf(page, 'clip-1')).toBeVisible();
        expect(await tree(page)).toEqual([['stack-1', ['clip-1', 'clip-2', 'clip-3']]]);
    });

    test('S solos a lane, a second lane adds to it, and S again releases one', async ({ page }) => {
        await groupOfThree(page);
        const solo = id => laneOf(page, id).locator('.solo-btn');
        const soloed = async () => {
            const out = [];
            for (const id of ['clip-1', 'clip-2', 'clip-3']) {
                if ((await node(page, id)).isSoloed) out.push(id);
            }
            return out;
        };
        await solo('clip-1').click();
        await expect(solo('clip-1')).toHaveClass(/\bon\b/);
        expect(await soloed()).toEqual(['clip-1']);

        await solo('clip-3').click();
        await expect(solo('clip-3')).toHaveClass(/\bon\b/);
        await expect(solo('clip-1')).toHaveClass(/\bon\b/);
        expect(await soloed()).toEqual(['clip-1', 'clip-3']);

        await solo('clip-1').click();
        await expect(solo('clip-1')).not.toHaveClass(/\bon\b/);
        await expect(solo('clip-3')).toHaveClass(/\bon\b/);
        expect(await soloed()).toEqual(['clip-3']);
        // A monitoring gesture: nothing to undo.
        expect((await graph(page)).canUndo).toBe(false);
    });

    test('the pan dial streams the pan while dragged; a double-click recentres', async ({ page }) => {
        await groupOfThree(page);
        const dial = laneOf(page, 'clip-2').locator('.pan-dial');
        const pan = async () => (await node(page, 'clip-2')).pan;
        expect(await pan()).toBe(0);
        const calls = recordCalls(page);
        const at = await centreOf(dial);

        // 75px of travel is one unit of pan: 30px right is 40% right.
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x + 15, at.y, { steps: 3 });
        await expect.poll(pan).toBeCloseTo(0.2, 5);   // streamed mid-drag
        await page.mouse.move(at.x + 30, at.y, { steps: 3 });
        await page.mouse.up();
        await expect.poll(pan).toBeCloseTo(0.4, 5);
        await consoleDrained(page);
        expect(methodsOf(calls).filter(m => m === 'setNodePan').length)
            .toBeGreaterThan(1);
        expect(new Set(methodsOf(calls))).toEqual(new Set(['setNodePan']));
        await expect(dial).toHaveClass(/off-center/);
        await expect(dial).toHaveAttribute('title', 'Pan: 40% right');
        // The dial's drag is not the rail's: nothing was selected by it.
        await expect(railOf(page, 'clip-2')).not.toHaveClass(/selected/);

        // The far stop: a drag past it stays hard left.
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x - 200, at.y, { steps: 4 });
        await page.mouse.up();
        await expect.poll(pan).toBe(-1);
        await expect(dial).toHaveAttribute('title', 'Pan: 100% left');

        await dial.dblclick();
        await expect.poll(pan).toBe(0);
        await expect(dial).not.toHaveClass(/off-center/);
        await expect(dial).toHaveAttribute('title',
            'Pan: center (drag; double-click to center)');
        expect((await graph(page)).canUndo).toBe(false);  // a knob
    });
});

test.describe('The status line reads the engine\'s answer', () => {

    /** Main Stack ▸ Clip A with two takes (the second one sounds), Clip
     * B, Clip C — and Clip C taking a new take: live, for as long as the
     * clock stands. */
    async function underAnotherLanesTake(page) {
        await groupOfThree(page);
        const Q = (await graph(page)).quantum;
        await call(page, 'newTake', 'clip-1');
        await mock(page, 'advanceBy', 2 * Q);
        await expect(laneOf(page, 'clip-1').locator('.take-btn')).toHaveText('T2/2');
        await laneOf(page, 'clip-3').locator('.arm-btn').click();
        await expect.poll(() => isHot(page, 'clip-3')).toBe(true);
        await expect(laneOf(page, 'clip-3').locator('.delete-btn')).toBeDisabled();
    }

    test('under another lane\'s live take: a one-shot and a take selection are refused and say why; nothing changes', async ({ page }) => {
        await underAnotherLanesTake(page);
        const lane = laneOf(page, 'clip-1');
        const before = await node(page, 'clip-1');

        await lane.locator('.oneshot-btn').click();
        await expect(logLine(page)).toHaveText('Still a loop — a take is live');
        expect((await node(page, 'clip-1')).periodSource).toBe('own');

        await lane.locator('.take-btn').click();
        await lane.locator('.take-menu .take-item[data-take="0"] .take-pick').click();
        await expect(logLine(page)).toHaveText('Take 1 not selected — a take is live');
        await expect(lane.locator('.take-btn')).toHaveText('T2/2');

        await lane.locator('.take-btn').click();
        await lane.locator('.take-menu .take-item[data-take="0"] .take-delete').click();
        await expect(logLine(page)).toHaveText('Take 1 not removed — a take is live');
        const after = await node(page, 'clip-1');
        expect([after.takes, after.activeTake, after.periodSource])
            .toEqual([before.takes, before.activeTake, before.periodSource]);
        expect((await graph(page)).canRedo).toBe(false);
    });

    test('under another lane\'s live take a rename still lands: wiring stays live', async ({ page }) => {
        await underAnotherLanesTake(page);
        await nameOf(page, 'clip-1').dblclick();
        const input = laneOf(page, 'clip-1').locator('.rail-name-input');
        await input.fill('Bass');
        await page.keyboard.press('Enter');
        await expect(logLine(page)).toHaveText('Renamed to "Bass"');
        await expect(nameOf(page, 'clip-1')).toHaveText('Bass');
        expect((await node(page, 'clip-1')).name).toBe('Bass');
        expect(await isHot(page, 'clip-3')).toBe(true);
    });

    test('a rename to the name the track has asks the engine for nothing', async ({ page }) => {
        await groupOfThree(page);
        await page.evaluate(() => { document.getElementById('log-line').textContent = ''; });
        const calls = recordCalls(page);
        await nameOf(page, 'clip-1').dblclick();
        await laneOf(page, 'clip-1').locator('.rail-name-input').fill('  Clip A ');
        await page.keyboard.press('Enter');
        await expect(nameOf(page, 'clip-1')).toHaveText('Clip A');
        await consoleDrained(page);
        expect(methodsOf(calls)).toEqual([]);
        await expect(logLine(page)).toHaveText('');
        expect((await graph(page)).canUndo).toBe(false);
    });

    test('⌘Z with nothing to undo, and ⌘⇧Z with nothing to redo, say so', async ({ page }) => {
        await looseTracks(page);
        expect((await graph(page)).canUndo).toBe(false);
        await undo(page);
        await expect(logLine(page)).toHaveText('Nothing to undo');
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect(logLine(page)).toHaveText('Nothing to redo');
        expect(await tree(page)).toEqual(['clip-1', 'clip-2', 'clip-3']);

        // One step in the log: undone, then nothing more to undo.
        await call(page, 'renameNode', 'clip-1', 'Bass');
        await expect(nameOf(page, 'clip-1')).toHaveText('Bass');
        await undo(page);
        await expect(logLine(page)).toHaveText('Undo');
        await expect(nameOf(page, 'clip-1')).toHaveText('Clip A');
        await undo(page);
        await expect(logLine(page)).toHaveText('Nothing to undo');
    });

    test('⌘Z while a take is live waits: the step is kept and the line says why', async ({ page }) => {
        await looseTracks(page);
        await call(page, 'renameNode', 'clip-1', 'Bass');
        await expect(nameOf(page, 'clip-1')).toHaveText('Bass');
        await laneOf(page, 'clip-3').locator('.arm-btn').click();
        await expect.poll(() => isHot(page, 'clip-3')).toBe(true);

        // Pressed at once: the reason is the graph's as it is now, not
        // the last poll's.
        await undo(page);
        await expect(logLine(page)).toHaveText('Undo waits — a take is live');
        await expect(nameOf(page, 'clip-1')).toHaveText('Bass');
        expect((await graph(page)).canUndo).toBe(true);

        await laneOf(page, 'clip-3').locator('.arm-btn').click();   // cancels the new take
        await expect.poll(() => isHot(page, 'clip-3')).toBe(false);
        await undo(page);
        await expect(logLine(page)).toHaveText('Undo');
        await expect(nameOf(page, 'clip-1')).toHaveText('Clip A');
    });

    test('a move to the top level refused under a live take says so, and nothing moved', async ({ page }) => {
        await groupOfThree(page);
        await laneOf(page, 'clip-3').locator('.arm-btn').click();
        await expect.poll(() => isHot(page, 'clip-3')).toBe(true);

        await dragRail(page, 'clip-2', page.locator('#create-track-btn'));
        await expect(logLine(page)).toHaveText('Move refused — a take is live');
        expect(await tree(page)).toEqual([['stack-1', ['clip-1', 'clip-2', 'clip-3']]]);
    });
});

test.describe('The R key', () => {

    /** Three loose tracks and a fourth, empty one; answers its id. */
    async function withEmptyTrack(page) {
        await looseTracks(page);
        const id = await call(page, 'createNode', 'clip', '');
        await expect(laneOf(page, id)).toBeVisible();
        return id;
    }

    test('R arms the selected track', async ({ page }) => {
        const id = await withEmptyTrack(page);
        await nameOf(page, id).click();
        await expect(railOf(page, id)).toHaveClass(/selected/);

        await page.keyboard.press('r');
        await expect(logLine(page)).toHaveText('Recording');
        await expect.poll(() => isHot(page, id)).toBe(true);
        for (const other of ['clip-1', 'clip-2', 'clip-3']) {
            expect(await isHot(page, other)).toBe(false);
        }
    });

    test('R while a take is live stops it, whatever is selected', async ({ page }) => {
        const id = await withEmptyTrack(page);
        const Q = (await graph(page)).quantum;
        // The mock's clock stands still unless the test moves it.
        const roll = samples => mock(page, 'advanceBy', samples);
        await nameOf(page, id).click();
        await page.keyboard.press('r');
        await expect.poll(() => isHot(page, id)).toBe(true);
        await roll(1.5 * Q);
        await expect.poll(async () => {
            const n = await node(page, id);
            return n.isRecording && !n.isPendingStart;
        }).toBe(true);
        await expect(laneOf(page, id).locator('.recording-bar')).toBeVisible();

        // The selection moves to a full track: with nothing live, R
        // there would start a new take of it.
        await nameOf(page, 'clip-1').click();
        await expect(railOf(page, 'clip-1')).toHaveClass(/selected/);
        const calls = recordCalls(page);
        await page.keyboard.press('r');
        await expect(logLine(page)).toHaveText('Stopped recording');
        await consoleDrained(page);
        expect(methodsOf(calls)).toEqual(['stopRecordingInNode']);
        await expect.poll(() => calls[0].args).toEqual([ROOT]);

        // The take finishes to its boundary and lands whole.
        await roll(Q);
        await expect.poll(() => isHot(page, id)).toBe(false);
        const landed = (await node(page, id)).duration;
        expect(landed).toBeGreaterThan(0);
        expect(landed % Q).toBe(0);
        expect(await isHot(page, 'clip-1')).toBe(false);
    });

    test('R with nothing selected and several tracks asks for a selection', async ({ page }) => {
        await looseTracks(page);
        await page.keyboard.press('Escape');
        await expect(page.locator('.lane-rail.selected')).toHaveCount(0);
        const calls = recordCalls(page);

        await page.keyboard.press('r');
        await expect(logLine(page)).toHaveText('Select a track to record (R)');
        await consoleDrained(page);
        expect(methodsOf(calls)).toEqual([]);
        const g = await graph(page);
        expect(g.nodes.some(n => n.isRecording || n.isPendingStart)).toBe(false);
    });

    test('R with nothing selected and one top-level lane records that lane', async ({ page }) => {
        await boot(page, { scenario: 'empty' });
        const id = await call(page, 'createNode', 'clip', '');
        await expect(laneOf(page, id)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('.lane-rail.selected')).toHaveCount(0);

        await page.keyboard.press('r');
        await expect(logLine(page)).toHaveText('Recording');
        await expect.poll(() => isHot(page, id)).toBe(true);
    });
});
