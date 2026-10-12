/**
 * THE EDIT BAR (#region-dock, loop_selection.md §15): every lane builds
 * its region panel once and mounts it HERE, not in its row — selecting a
 * track swaps what the bar shows and never moves a lane. One panel shows
 * at a time: the most recently selected track's; when that track has
 * none, the bar says why. The bar sits outside the session's scroll, so
 * a panel keeps one width at every main zoom and scroll.
 */

import { ctx } from './context.js';
import { fmtQ, setText } from './sv_util.js';
import { activeSelectedId } from './selection.js';
import { shownPanelRow, repaintPanel } from './region_nav.js';

/** Mount a lane's panel element in the bar (before the first patch the
 * bar may not exist: the tests' rows). */
export function mountInDock(nav) {
    const dock = ctx.els && ctx.els.regionDock;
    if (dock) dock.appendChild(nav);
}

/** Why a SELECTED clip/group shows no panel — the bar's hint — or null
 * when it shows one: a take of at least 2Q; not a Q-definer (its trim
 * SETS Q, on the lane), a child shown through a parent's map (the parent
 * owns the edit), nor a live take. Exported for the tests. */
export function noPanelReason(lane) {
    if (lane.recording) return 'Recording…';
    if (lane.isQDefiner) return 'This track sets Q — drag its brackets on the lane';
    if (lane.underMap || lane.definerMember) {
        return 'Played through its group’s loop region — select the group to edit it';
    }
    if (lane.windowEditing) return null;
    if (!(lane.bandTotalQ > 0)) return 'Nothing recorded yet';
    if (!(lane.bandTotalQ >= 2)) {
        return 'A ' + fmtQ(lane.bandTotalQ) + 'Q take — no loop region to edit';
    }
    return null;
}

/** Should this lane show the panel right now? The most recently
 * selected clip/group with nothing in noPanelReason's way, and not
 * while it is its own raw inspector (windowEditing). */
export function wantPanel(lane) {
    if (lane.kind !== 'clip' && lane.kind !== 'group') return false;
    if (activeSelectedId() !== lane.id) return false;
    if (lane.windowEditing) return false;
    return noPanelReason(lane) === null;
}

/** The bar per patch (after every lane's patchRegionPanel): shown while
 * there are lanes — a fixed height, so a selection never resizes the
 * session view — with the selected track's panel, or a one-line hint
 * saying why there is none. */
export function patchRegionDock(vm) {
    const dock = ctx.els && ctx.els.regionDock;
    if (!dock) return;
    const lanes = vm.lanes.filter(l => l.kind === 'clip' || l.kind === 'group');
    dock.classList.toggle('open', lanes.length > 0);
    const shown = !!shownPanelRow();
    const id = activeSelectedId();
    const lane = lanes.find(l => l.id === id) || null;
    const hint = shown ? ''
        : !lane ? 'Select a track to edit its loop'
            : noPanelReason(lane) || '';
    setText(dock.querySelector(':scope > .region-dock-hint'), hint);
    dock.classList.toggle('empty', !shown);
}

/** The bar repaints its panel at once when its width changes (the
 * window resized): the next patch would lag, and idle polls are slower
 * still. */
export function wireRegionDock() {
    const dock = ctx.els.regionDock;
    if (!dock || typeof ResizeObserver === 'undefined') return;
    new ResizeObserver(() => {
        const row = shownPanelRow();
        if (row) repaintPanel(row);
    }).observe(dock);
}
