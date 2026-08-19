/**
 * Lane construction: the per-lane row (rail + body + nav dock) built
 * once per lane id; patchRail/patchLaneBody keep it current in place.
 * Also the inline rename editor (the one piece of rail chrome that
 * must survive the 50ms patch tick).
 */

import { ctx } from './context.js';
import { el, setText, parseDropIds } from './sv_util.js';
import { selection, clearSelection, toggleSelect } from './selection.js';
import { buildGainDial, buildPanDial } from './dials.js';
import { buildNavDock } from './teleport.js';
import { toggleInputMenu } from './input_menu.js';
import { openCreationMenu } from './creation_menu.js';
import { buildFxRow } from './fx_row.js';

/**
 * Build one lane row for the vm lane: synthetic fx/add rows get their
 * own shapes; clips and groups get the two-line rail (name row on top;
 * controls + status below — nothing ever competes with the name for
 * width), the body, and the nav dock. Wired once; all state patches in
 * patchRail / patchLaneBody.
 */
export function buildLane(lane) {
    const row = el('div', 'lane', { id: 'lane-' + lane.id });
    row.dataset.id = lane.id;
    row.dataset.kind = lane.kind;

    // Synthetic effects-panel row (built once; values patch in place)
    if (lane.kind === 'fx') return buildFxRow(row, lane);

    // Synthetic add-track row at the bottom of an open group. Since
    // Q17 the + opens the creation menu (template picker) targeting
    // this group — click-click on the default row keeps the old speed.
    if (lane.kind === 'add') {
        row.classList.add('lane-add');
        row.dataset.depth = String(Math.min(lane.depth, 2));
        const spacer = document.createElement('div');
        const btn = el('button', 'add-track-row-btn', {
            textContent: '+ Add track',
            title: 'Add a track to this group — templates on the menu' });
        btn.addEventListener('click', e => openCreationMenu(e, lane.groupId));
        row.append(spacer, btn);
        return row;
    }

    // Rail = two rows: the name owns the top line; controls + status own
    // the bottom line. Nothing ever competes with the name for width.
    const rail = el('div', 'lane-rail');

    // GROUPING BY DRAG (owner ruling 2026-07-19h): grouping is a
    // post-hoc gesture, not an upfront decision — drag one track's rail
    // onto another's. Clip target → the two combine into a new group
    // (engine Combine edit, undoable); group target → the dragged track
    // moves inside. Nested groups fall out (drop onto a track that
    // lives in a group combines in place).
    rail.draggable = true;
    // Click = select (buttons, inputs, and the pan dial keep their own
    // verbs — a dial drag ends in a click on the rail, which would
    // otherwise select the lane on every pan tweak).
    rail.addEventListener('click', e => {
        if (e.target.closest('button, input, .pan-dial, .gain-dial')) return;
        toggleSelect(row, e.metaKey || e.ctrlKey || e.shiftKey);
    });
    rail.addEventListener('dragstart', e => {
        if (row._renaming) { e.preventDefault(); return; }
        // Dragging a SELECTED rail carries the whole selection.
        const ids = selection.has(row._lane.id) && selection.size > 1
            ? [...selection] : [row._lane.id];
        e.dataTransfer.setData('text/plain', JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'move';
        rail.classList.add('dragging');
    });
    rail.addEventListener('dragend', () => rail.classList.remove('dragging'));
    rail.addEventListener('dragover', e => {
        e.preventDefault();  // allow drop
        e.dataTransfer.dropEffect = 'move';
        rail.classList.add('drop-target');
    });
    rail.addEventListener('dragleave', () => rail.classList.remove('drop-target'));
    rail.addEventListener('drop', e => {
        e.preventDefault();
        rail.classList.remove('drop-target');
        let ids = parseDropIds(e);
        if (!ids) return;
        const target = row._lane;
        ids = ids.filter(id => id && id !== target.id);
        if (!ids.length) return;
        clearSelection();
        ctx.cb.onDropLane(ids, target);
    });

    const head = el('div', 'rail-head');
    if (lane.kind === 'group') {
        const fold = el('button', 'fold-btn', {
            title: 'Fold/unfold (display only — sound never changes)' });
        fold.addEventListener('click', () => ctx.cb.onFold(lane.id));
        head.appendChild(fold);
    }
    const name = el('div', 'rail-name', { title: 'Double-click to rename' });
    name.addEventListener('dblclick', () => beginRename(row));
    head.appendChild(name);
    // Status word lives on the name row, right-aligned — it never
    // competes with the buttons row for width
    head.appendChild(el('span', 'rail-status armed-word mono'));
    // The Q-DEFINER badge (owner request 2026-07-19g): while the island's
    // tempo is still provisional, the track that defines it says so.
    // Locked islands own their Q — the badge retires at the 2nd take.
    // A LAMP, not a word: fixed-size, so it can never truncate — the
    // text version crushed to "T…" on crowded rails (owner feedback
    // 2026-08-08e). A lit "Q" indicator in the deck's record-lamp
    // vocabulary; the tooltip carries the explanation.
    const tempo = el('span', 'tempo-chip mono', {
        textContent: 'Q',
        title: 'This take defines the loop length (Q — the tempo). ' +
            'Drag its handles in the lane to trim. Locks when you record ' +
            'another track.' });
    tempo.style.display = 'none';
    head.appendChild(tempo);
    if (lane.kind === 'group') {
        // Ungroup: children move up to this group's slot; the shell
        // deletes. The inverse of drag-to-group, one hover away.
        const ungroup = el('button', 'rail-btn ungroup-btn', {
            textContent: '⤒',
            title: 'Ungroup — move the tracks up and remove the group' });
        ungroup.addEventListener('click', () => ctx.cb.onUngroup(lane.id));
        head.appendChild(ungroup);
    }
    // Delete — top-right of the rail (card-close position); the flexing
    // name yields the room, so it never overflows the button row. No
    // confirm: undo is the safety net (⌘Z). Disabled mid-take (the engine
    // refuses to delete an armed/capturing take — cancel is that verb).
    const del = el('button', 'rail-btn delete-btn', {
        textContent: '✕', title: 'Delete (⌘Z to undo)' });
    del.addEventListener('click', () => ctx.cb.onDelete && ctx.cb.onDelete(lane.id));
    // Gain + pan dials — every lane, in the HEAD row (the flexing name
    // yields the room; the foot's button row is already at the rail's
    // width). Fractal like fx: a group's fader/pan scales the summed
    // group at its output stage. The engine value streams while
    // dragging; `_hot` keeps the 50ms tick from fighting the gesture
    // (the fx-slider lesson).
    // Period-source toggle (Q5) — clips only, in the HEAD next to the
    // dials (the foot button row is at the rail's full width; a foot
    // chip overflowed): ↺ = loops at its own length; 1× = one-shot
    // (sounds once per context cycle at its origin, then rests). A
    // musical fact — undoable engine-side. Groups never get one (a
    // stack has no origin to anchor a firing to).
    if (lane.kind === 'clip') {
        const ps = el('button', 'rail-btn oneshot-btn mono');
        ps.addEventListener('click', () => {
            const l = row._lane;
            if (l) ctx.cb.onSetPeriodSource(l.id, l.oneShot ? 'own' : 'context');
        });
        head.appendChild(ps);
    }
    head.appendChild(buildGainDial(row));
    head.appendChild(buildPanDial(row));
    head.appendChild(del);
    rail.appendChild(head);

    const foot = el('div', 'rail-foot');
    foot.appendChild(el('div', 'rail-sub mono'));

    // Arm/record: on clips it starts/stops the take; on groups it arms
    // every ARMABLE child (Q7 — arm targets emptiness). State is set in
    // patchRail; the click hands the current lane back to app.js.
    // Arm is a STATE TOGGLE, not a record button — the transport's red
    // circle is the one record verb (owner ruling 2026-07-19: three
    // identical red dots read as three mystery record buttons). The
    // ring fills red when armed; the glyph stays empty at rest.
    const arm = el('button', 'rail-btn arm-btn', {
        title: 'Record into this track' });
    arm.addEventListener('click', () => ctx.cb.onArm(row._lane));

    const mute = el('button', 'rail-btn mute-btn', {
        textContent: 'M', title: 'Mute' });
    mute.addEventListener('click', () => ctx.cb.onMute(lane.id));
    const solo = el('button', 'rail-btn solo-btn', {
        textContent: 'S', title: 'Solo' });
    solo.addEventListener('click', () => ctx.cb.onSolo(lane.id));
    foot.append(arm, mute, solo);

    // Effects rack toggle — every lane (fractal: a stack's rack shapes
    // the summed group). Chip shows the enabled count at rest.
    const fx = el('button', 'rail-btn fx-btn mono', {
        textContent: 'fx',
        title: 'Effects: EQ · Compressor · Echo · Reverb' });
    fx.addEventListener('click', () => ctx.cb.onToggleFx(lane.id));
    foot.appendChild(fx);

    // MIDI arm (docs/vst3.md §8): only shown when the chain carries an
    // instrument slot (patchRail toggles visibility); single-armed —
    // the backend clears every other node.
    const midi = el('button', 'rail-btn midi-btn', {
        textContent: '♪',
        title: 'MIDI: play this instrument live from your keyboard' });
    midi.style.display = 'none';
    midi.addEventListener('click', () =>
        ctx.cb.onMidiArm(lane.id, !(row._lane && row._lane.midiArmed)));
    foot.appendChild(midi);

    // Recording input picker — clips only (Q7: group record captures
    // each child from ITS OWN input; a group has no input of its own)
    if (lane.kind === 'clip') {
        const input = el('button', 'rail-btn input-btn mono', {
            title: 'Recording input — click to choose' });
        input.addEventListener('click', () => toggleInputMenu(row));
        foot.appendChild(input);
    }

    if (lane.kind === 'group') {
        const add = el('button', 'rail-btn add-clip-btn', {
            textContent: '+',
            title: 'Add a track to this group — templates on the menu' });
        // Q17: the + opens the creation menu targeting this group.
        add.addEventListener('click', e => openCreationMenu(e, lane.id));
        foot.appendChild(add);
    }

    rail.appendChild(foot);

    const body = el('div', 'lane-body');

    row.append(rail, body, buildNavDock(row));
    return row;
}

/* ---------- inline rename ----------
 *
 * The editor must survive the 50ms patch tick: patchRail skips the name
 * write while `row._renaming` is set, so typing is never clobbered by a
 * poll. Commit goes through cb.onRename (renameNode on the bridge); the
 * next poll patches the settled name back into the display div.
 */
function beginRename(row) {
    if (row._renaming) return;
    const lane = row._lane;
    if (!lane) return;
    row._renaming = true;

    const name = row.querySelector('.rail-name');
    const input = el('input', 'rail-name-input', { type: 'text' });
    input.value = lane.name;
    input.maxLength = 64;
    name.style.display = 'none';
    name.after(input);
    input.focus();
    input.select();

    let done = false; // Enter → commit → remove() fires blur: run once
    const finish = commit => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        input.remove();
        name.style.display = '';
        row._renaming = false;
        if (commit && next && next !== lane.name) {
            setText(name, next); // optimistic; the poll confirms
            ctx.cb.onRename(lane.id, next);
        }
    };
    input.addEventListener('keydown', e => {
        e.stopPropagation(); // space must not reach the transport toggle
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}
