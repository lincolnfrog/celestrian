/**
 * Session view patch layer (docs/ui_overhaul.md §2, §4 — P2-10).
 *
 * patchSessionView(vm, aux) renders the Q-unit view model from
 * view_model.js into the DOM. THE ONLY Q→geometry conversion in the app
 * happens here, as percentages of the cycle — which is what makes I2
 * (simultaneity ⇔ same x) structural: every lane body spans the same
 * cycle, so equal Q is equal % is equal x, always.
 *
 * This module is DOM + geometry only. It never calls the backend;
 * interactions are injected as callbacks from app.js.
 */

import { drawWaveform } from './canvas_renderer.js';
import { generateCompositeWaveform } from './composite_waveform.js';
import { calculateStackLCM } from './timeline_model.js';
import { liveBoost, PEAKS_PER_SECOND } from './live_peaks.js';
import { windowDragTarget } from './view_model.js';
import { innerCuts, applyCut, healCut, cellCutAt, resizeCutTarget,
         slideCutTarget } from './map_edit.js';
import { mapOffset } from './time_map.js';
import {
    forwardDelta, estimateVelocity, advancePosition, correctPosition,
} from './playhead_clock.js';
import { EFFECT_SCHEMA } from './effect_schema.js';
import {
    drawEqViz, drawCompViz, drawEchoViz, drawReverbViz,
    echoTaps, reverbTailSeconds, holdSpectrum,
} from './fx_viz.js';

const pct = (q, cycleQ) => (q / cycleQ) * 100 + '%';

/* Q labels: snap fp noise to the whole Q it means (an exactly-1Q map
 * once printed "0.9999…Q" — field 2026-07-25); honest fractions keep
 * two decimals. */
const fmtQ = q => {
    const r = Math.round(q);
    if (Math.abs(q - r) < 1e-6) return String(r);
    return String(Math.round(q * 100) / 100);
};

/**
 * Idempotent DOM writes. Assigning textContent/innerHTML REPLACES the
 * text node even when the string is identical — and WebKit (the JUCE
 * webview) swallows a click whose mousedown target node is destroyed
 * before mouseup. With a 50ms patch tick, unconditional writes made
 * most human clicks on rail buttons land in a replaced-node window
 * ("clicking collapse did nothing the first several times" — field
 * report 2026-07-09). Never write unless the value changed.
 */
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
const setHtml = (el, s) => { if (el.innerHTML !== s) el.innerHTML = s; };
const setTitle = (el, s) => { if (el.title !== s) el.title = s; };

let cb = {};           // callbacks injected by app.js
let els = {};          // static chrome elements
const laneEls = new Map();   // lane id → row element
const compositeCache = new Map();

export function initSessionView(callbacks) {
    cb = callbacks;
    els = {
        playBtn: document.getElementById('play-btn'),
        readout: document.getElementById('position-readout'),
        qInfo: document.getElementById('q-info'),
        ruler: document.getElementById('ruler'),
        lanes: document.getElementById('lanes'),
        playhead: document.getElementById('playhead'),
        emptyState: document.getElementById('empty-state'),
        gridArea: document.getElementById('grid-area'),
    };
    els.playBtn.addEventListener('click', () => cb.onTogglePlay());
    // Creation lives in the CANVAS (2026-07-19g): the persistent row
    // under the lanes makes tracks/groups; the transport is transport.
    document.getElementById('create-track-btn')
        .addEventListener('click', () => cb.onAddTrack());

    // Selection: Escape or a click on empty canvas clears; the floating
    // bar groups the selection in place.
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            clearSelection();
            if (cb.onWindowEdit) cb.onWindowEdit(null, false);
        }
    });
    document.getElementById('session').addEventListener('click', e => {
        if (e.target.id === 'session' || e.target.id === 'grid-area' ||
            e.target.id === 'lanes') clearSelection();
    });
    const selBar = document.getElementById('selection-bar');
    if (selBar) {
        selBar.querySelector('.sel-group').addEventListener('click', () => {
            const ids = [...selection];
            clearSelection();
            cb.onGroupSelection(ids);
        });
        selBar.querySelector('.sel-clear')
            .addEventListener('click', clearSelection);
    }

    // The ＋ Track row doubles as the DRAG-OUT target: drop a nested
    // track here to move it to the top level (the inverse of
    // drag-onto-to-group, in the same physical language).
    const createRow = document.getElementById('create-row');
    const trackBtn = document.getElementById('create-track-btn');
    createRow.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        createRow.classList.add('drop-target');
        trackBtn.textContent = '⤒ Move to top level';
    });
    createRow.addEventListener('dragleave', () => {
        createRow.classList.remove('drop-target');
        trackBtn.textContent = '＋ Track';
    });
    createRow.addEventListener('drop', e => {
        e.preventDefault();
        createRow.classList.remove('drop-target');
        trackBtn.textContent = '＋ Track';
        let ids;
        try { ids = JSON.parse(e.dataTransfer.getData('text/plain')); }
        catch { return; }
        if (!Array.isArray(ids)) ids = [ids];
        if (ids.length) { clearSelection(); cb.onMoveToTop(ids); }
    });

    wireZoom();

    // Input menus dismiss on outside press or Escape
    document.addEventListener('pointerdown', e => {
        if (!e.target.closest('.input-menu') && !e.target.closest('.input-btn')) {
            closeInputMenus();
        }
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeInputMenus();
    });
}

/* ---------- horizontal zoom (design.md: mouse wheel or Q/E) ----------
 * Everything on the timeline is positioned in PERCENT of the ruler, so
 * zoom is just #grid-area growing past the viewport — no renderer
 * changes, the browser owns the scroll. The plain wheel is left alone
 * (it scrolls the tracks vertically); Ctrl+wheel zooms about the
 * cursor like every DAW. */
let zoomZ = 1;
const ZOOM_MIN = 1, ZOOM_MAX = 16, ZOOM_STEP = 1.25;

function setZoom(z, anchorClientX) {
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (z === zoomZ) { updateZoomUI(); return; }
    const session = document.getElementById('session');
    // Hold the timeline instant under the anchor (cursor or viewport
    // center) still: the rail column is fixed width, so the anchor is
    // measured against the RULER, which scales linearly.
    const wBefore = els.ruler.offsetWidth;
    const rulerLeft = els.ruler.getBoundingClientRect().left;
    const box = session.getBoundingClientRect();
    const ax = anchorClientX ?? (box.left + box.width / 2);
    const frac = (ax - rulerLeft) / wBefore;
    zoomZ = z;
    els.gridArea.style.width = z === 1 ? '' : (z * 100) + '%';
    session.scrollLeft += frac * (els.ruler.offsetWidth - wBefore);
    // The animator caches the ruler width between polls — refresh it
    // now or the playhead runs on the old scale for up to 50ms.
    anim.timelineW = els.ruler.offsetWidth;
    updateZoomUI();
}

function updateZoomUI() {
    const label = document.getElementById('zoom-level');
    const zin = document.getElementById('zoom-in-btn');
    const zout = document.getElementById('zoom-out-btn');
    if (label) label.textContent = Math.round(zoomZ * 100) + '%';
    if (zin) zin.disabled = zoomZ >= ZOOM_MAX;
    if (zout) zout.disabled = zoomZ <= ZOOM_MIN;
}

function wireZoom() {
    const zin = document.getElementById('zoom-in-btn');
    const zout = document.getElementById('zoom-out-btn');
    const label = document.getElementById('zoom-level');
    if (zin) zin.addEventListener('click', () => setZoom(zoomZ * ZOOM_STEP));
    if (zout) zout.addEventListener('click', () => setZoom(zoomZ / ZOOM_STEP));
    if (label) label.addEventListener('click', () => setZoom(1));
    document.addEventListener('keydown', e => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key === 'q' || e.key === 'Q') setZoom(zoomZ * ZOOM_STEP);
        else if (e.key === 'e' || e.key === 'E') setZoom(zoomZ / ZOOM_STEP);
    });
    document.getElementById('session').addEventListener('wheel', e => {
        if (!e.ctrlKey) return; // plain wheel keeps native vertical scroll
        e.preventDefault();
        setZoom(zoomZ * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX);
    }, { passive: false });
    updateZoomUI();
}

/* ---------- ruler ---------- */
let rulerKey = '';
function patchRuler(vm) {
    const key = vm.cycleQ + ':' + vm.ruler.ticks.length + ':' + vm.frameExtended;
    if (key === rulerKey) return;
    rulerKey = key;
    els.ruler.textContent = '';
    vm.ruler.ticks.forEach(t => {
        const tick = document.createElement('div');
        tick.className = 'tick' + (t.major ? ' major' : '');
        tick.style.left = pct(t.q, vm.cycleQ);
        els.ruler.appendChild(tick);
        // Sparse labels (Tape Room): majors only, plus the frame end.
        // ↺ marks the SETTLED cycle; a growing frame ends provisionally (…)
        if (t.q > 0 && (t.major || t.q === vm.cycleQ)) {
            const lb = document.createElement('div');
            lb.className = 'tick-label' + (t.q === vm.cycleQ ? ' cycle-end' : '');
            lb.style.left = pct(t.q, vm.cycleQ);
            lb.textContent = t.q === vm.cycleQ
                ? fmtQ(vm.cycleQ) + 'Q' + (vm.frameExtended ? '…' : ' ↺')
                : fmtQ(t.q) + 'Q';
            els.ruler.appendChild(lb);
        }
    });
}

/* ---------- lane construction ---------- */
function buildLane(lane) {
    const row = document.createElement('div');
    row.className = 'lane';
    row.id = 'lane-' + lane.id;
    row.dataset.id = lane.id;
    row.dataset.kind = lane.kind;

    // Synthetic effects-panel row (built once; values patch in place)
    if (lane.kind === 'fx') return buildFxRow(row, lane);

    // Synthetic add-track row at the bottom of an open group
    if (lane.kind === 'add') {
        row.classList.add('lane-add');
        row.dataset.depth = String(Math.min(lane.depth, 2));
        const spacer = document.createElement('div');
        const btn = document.createElement('button');
        btn.className = 'add-track-row-btn';
        btn.textContent = '+ Add track';
        btn.title = 'Add an empty track to this group';
        btn.addEventListener('click', () => cb.onAddClip(lane.groupId));
        row.append(spacer, btn);
        return row;
    }

    // Rail = two rows: the name owns the top line; controls + status own
    // the bottom line. Nothing ever competes with the name for width.
    const rail = document.createElement('div');
    rail.className = 'lane-rail';

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
        if (e.target.closest('button, input, .pan-dial')) return;
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
        let ids;
        try { ids = JSON.parse(e.dataTransfer.getData('text/plain')); }
        catch { return; }
        if (!Array.isArray(ids)) ids = [ids];
        const target = row._lane;
        ids = ids.filter(id => id && id !== target.id);
        if (!ids.length) return;
        clearSelection();
        cb.onDropLane(ids, target);
    });

    const head = document.createElement('div');
    head.className = 'rail-head';
    if (lane.kind === 'group') {
        const fold = document.createElement('button');
        fold.className = 'fold-btn';
        fold.title = 'Fold/unfold (display only — sound never changes)';
        fold.addEventListener('click', () => cb.onFold(lane.id));
        head.appendChild(fold);
    }
    const name = document.createElement('div');
    name.className = 'rail-name';
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', () => beginRename(row));
    head.appendChild(name);
    // Status word lives on the name row, right-aligned — it never
    // competes with the buttons row for width
    const status = document.createElement('span');
    status.className = 'rail-status armed-word mono';
    head.appendChild(status);
    // The Q-DEFINER badge (owner request 2026-07-19g): while the island's
    // tempo is still provisional, the track that defines it says so.
    // Locked islands own their Q — the badge retires at the 2nd take.
    const tempo = document.createElement('span');
    tempo.className = 'tempo-chip mono';
    tempo.textContent = 'tempo';
    tempo.title = 'This take defines the loop length (Q) — drag its ' +
        'handles to trim. Locks when you record another track.';
    tempo.style.display = 'none';
    head.appendChild(tempo);
    if (lane.kind === 'group') {
        // Ungroup: children move up to this group's slot; the shell
        // deletes. The inverse of drag-to-group, one hover away.
        const ungroup = document.createElement('button');
        ungroup.className = 'rail-btn ungroup-btn';
        ungroup.textContent = '⤒';
        ungroup.title = 'Ungroup — move the tracks up and remove the group';
        ungroup.addEventListener('click', () => cb.onUngroup(lane.id));
        head.appendChild(ungroup);
    }
    // Delete — top-right of the rail (card-close position); the flexing
    // name yields the room, so it never overflows the button row. No
    // confirm: undo is the safety net (⌘Z). Disabled mid-take (the engine
    // refuses to delete an armed/capturing take — cancel is that verb).
    const del = document.createElement('button');
    del.className = 'rail-btn delete-btn';
    del.textContent = '✕';
    del.title = 'Delete (⌘Z to undo)';
    del.addEventListener('click', () => cb.onDelete && cb.onDelete(lane.id));
    // Pan dial — every lane, in the HEAD row (the flexing name yields
    // the room; the foot's button row is already at the rail's width).
    // Fractal like fx: a group's pan scales the summed group. The
    // engine value streams while dragging; `_hot` keeps the 50ms tick
    // from fighting the gesture (the fx-slider lesson).
    head.appendChild(buildPanDial(row));
    head.appendChild(del);
    rail.appendChild(head);

    const foot = document.createElement('div');
    foot.className = 'rail-foot';
    const sub = document.createElement('div');
    sub.className = 'rail-sub mono';
    foot.appendChild(sub);

    // Arm/record: on clips it starts/stops the take; on groups it arms
    // every ARMABLE child (Q7 — arm targets emptiness). State is set in
    // patchRail; the click hands the current lane back to app.js.
    // Arm is a STATE TOGGLE, not a record button — the transport's red
    // circle is the one record verb (owner ruling 2026-07-19: three
    // identical red dots read as three mystery record buttons). The
    // ring fills red when armed; the glyph stays empty at rest.
    const arm = document.createElement('button');
    arm.className = 'rail-btn arm-btn';
    arm.title = 'Record into this track';
    arm.addEventListener('click', () => cb.onArm(row._lane));

    const mute = document.createElement('button');
    mute.className = 'rail-btn mute-btn';
    mute.textContent = 'M';
    mute.title = 'Mute';
    mute.addEventListener('click', () => cb.onMute(lane.id));
    const solo = document.createElement('button');
    solo.className = 'rail-btn solo-btn';
    solo.textContent = 'S';
    solo.title = 'Solo';
    solo.addEventListener('click', () => cb.onSolo(lane.id));
    foot.append(arm, mute, solo);

    // Effects rack toggle — every lane (fractal: a stack's rack shapes
    // the summed group). Chip shows the enabled count at rest.
    const fx = document.createElement('button');
    fx.className = 'rail-btn fx-btn mono';
    fx.textContent = 'fx';
    fx.title = 'Effects: EQ · Compressor · Echo · Reverb';
    fx.addEventListener('click', () => cb.onToggleFx(lane.id));
    foot.appendChild(fx);


    // Recording input picker — clips only (Q7: group record captures
    // each child from ITS OWN input; a group has no input of its own)
    if (lane.kind === 'clip') {
        const input = document.createElement('button');
        input.className = 'rail-btn input-btn mono';
        input.title = 'Recording input — click to choose';
        input.addEventListener('click', () => toggleInputMenu(row));
        foot.appendChild(input);
    }

    if (lane.kind === 'group') {
        const add = document.createElement('button');
        add.className = 'rail-btn add-clip-btn';
        add.textContent = '+';
        add.title = 'Add a track to this group';
        add.addEventListener('click', () => cb.onAddClip(lane.id));
        foot.appendChild(add);
    }

    rail.appendChild(foot);

    const body = document.createElement('div');
    body.className = 'lane-body';

    row.append(rail, body);
    return row;
}

/* ---------- pan dial ----------
 *
 * A small rotary: the tick sweeps −90° (hard left, pointing at the L
 * channel) .. +90° (hard right). The full quarter-turn each way is the
 * point — a 45° stop reads as "half way" when the signal is already
 * fully panned. Horizontal drag edits (right = right, matching the axis
 * the control represents: 150px for the full sweep); double-click
 * recenters. Engine semantics are the balance law — center is unity,
 * panning attenuates the far channel only.
 */
function buildPanDial(row) {
    const dial = document.createElement('div');
    dial.className = 'pan-dial';
    dial.title = 'Pan (drag; double-click to center)';
    // The rail is an HTML5 drag source (lane reorder) and children
    // inherit that; a HORIZONTAL dial drag looks exactly like the start
    // of a rail drag, so opt this element out explicitly rather than
    // relying on the pointerdown preventDefault alone.
    dial.draggable = false;
    const tick = document.createElement('div');
    tick.className = 'pan-tick';
    dial.appendChild(tick);
    dial._tick = tick;

    const send = v => {
        const lane = row._lane;
        if (lane) cb.onSetPan(lane.id, v);
    };
    dial.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        try { dial.setPointerCapture(ev.pointerId); } catch (_) {}
        dial._hot = true;
        dial._startX = ev.clientX;
        dial._startPan = (row._lane && row._lane.pan) || 0;
    });
    dial.addEventListener('pointermove', ev => {
        if (!dial._hot) return;
        const v = Math.max(-1, Math.min(1,
            dial._startPan + (ev.clientX - dial._startX) / 75));
        setPanDial(dial, v);
        send(v);
    });
    const end = () => { dial._hot = false; };
    dial.addEventListener('pointerup', end);
    dial.addEventListener('pointercancel', end);
    dial.addEventListener('dblclick', () => {
        setPanDial(dial, 0);
        send(0);
    });
    return dial;
}

function setPanDial(dial, pan) {
    dial._tick.style.transform =
        `translateX(-50%) rotate(${(pan * 90).toFixed(1)}deg)`;
    dial.classList.toggle('off-center', Math.abs(pan) > 0.01);
    const pc = Math.round(Math.abs(pan) * 100);
    dial.title = pan === 0 ? 'Pan: center (drag; double-click to center)'
        : `Pan: ${pc}% ${pan < 0 ? 'left' : 'right'}`;
}

/* ---------- input picker ----------
 *
 * The chip shows the channel at rest (glanceability first — Tape Room
 * hover-density rule); the menu fetches the device's input names ON OPEN
 * so hot-plugged interfaces appear without a reload. The menu lives on
 * the rail, which patchRail never rebuilds, so the 50ms tick can't
 * destroy it mid-choice.
 */
export function closeInputMenus() {
    document.querySelectorAll('.input-menu').forEach(m => m.remove());
}

async function toggleInputMenu(row) {
    const rail = row.querySelector('.lane-rail');
    if (rail.querySelector('.input-menu')) { closeInputMenus(); return; }
    closeInputMenus(); // at most one open across all lanes
    const lane = row._lane;
    if (!lane) return;

    const menu = document.createElement('div');
    menu.className = 'input-menu';
    const loading = document.createElement('div');
    loading.className = 'input-menu-note';
    loading.textContent = 'inputs…';
    menu.appendChild(loading);
    rail.appendChild(menu);

    const inputs = await cb.getInputs();
    if (!menu.isConnected) return; // closed while fetching
    menu.textContent = '';
    if (!inputs.length) {
        const none = document.createElement('div');
        none.className = 'input-menu-note';
        none.textContent = 'no inputs found';
        menu.appendChild(none);
        return;
    }
    // Two columns: the INPUT (left/mono) list, and the RIGHT list that
    // makes the track a stereo pair (docs: stereo overheads). "mono"
    // clears the right assignment; the channel count of a take is fixed
    // at arm, so mid-take flips take effect on the next arm.
    const head = document.createElement('div');
    head.className = 'input-menu-note';
    head.textContent = lane.inputChannelR >= 0 ? 'input · L' : 'input';
    menu.appendChild(head);
    inputs.forEach((name, i) => {
        const item = document.createElement('button');
        item.className = 'input-item' + (i === lane.inputChannel ? ' current' : '');
        item.textContent = `${i + 1} · ${name}`;
        item.addEventListener('click', () => {
            closeInputMenus();
            cb.onSetInput(lane.id, i);
        });
        menu.appendChild(item);
    });
    const rHead = document.createElement('div');
    rHead.className = 'input-menu-note';
    rHead.textContent = 'right (stereo pair)';
    menu.appendChild(rHead);
    const monoItem = document.createElement('button');
    monoItem.className = 'input-item' + (lane.inputChannelR < 0 ? ' current' : '');
    monoItem.textContent = '· mono';
    monoItem.addEventListener('click', () => {
        closeInputMenus();
        cb.onSetInputRight(lane.id, -1);
    });
    menu.appendChild(monoItem);
    inputs.forEach((name, i) => {
        const item = document.createElement('button');
        item.className = 'input-item' +
            (i === lane.inputChannelR ? ' current' : '');
        item.textContent = `${i + 1} · ${name}`;
        item.addEventListener('click', () => {
            closeInputMenus();
            cb.onSetInputRight(lane.id, i);
        });
        menu.appendChild(item);
    });
}

/* ---------- effects panel (docs/ui_overhaul.md effects bar) ----------
 *
 * A synthetic row under the lane: four fixed cards (EQ, COMP, ECHO,
 * VERB — the engine's rack order), each a power switch + sliders.
 * Built once from EFFECT_SCHEMA; values PATCH in place. A slider being
 * dragged is never overwritten by the 50ms tick (the rename-editor
 * lesson applied to inputs: `_hot` between pointerdown and pointerup).
 */
function buildFxRow(row, lane) {
    row.classList.add('lane-fx');
    row.dataset.depth = String(Math.min(lane.depth, 2));

    const rail = document.createElement('div');
    rail.className = 'fx-rail mono';
    rail.textContent = 'EFFECTS';

    const body = document.createElement('div');
    body.className = 'fx-body';
    EFFECT_SCHEMA.forEach(fx => {
        const card = document.createElement('div');
        card.className = 'fx-card';
        card.dataset.fx = fx.type;

        const head = document.createElement('div');
        head.className = 'fx-card-head';
        const power = document.createElement('button');
        power.className = 'fx-power';
        power.textContent = '⏻';
        power.title = 'Enable / disable';
        power.addEventListener('click', () => {
            const cur = row._lane && row._lane.effects &&
                row._lane.effects[fx.type];
            cb.onSetEffectEnabled(row._lane.ownerId, fx.type,
                !(cur && cur.enabled));
        });
        const title = document.createElement('span');
        title.className = 'fx-title';
        title.textContent = fx.label;
        head.append(power, title);
        if (fx.type === 'compressor') {
            // Live gain-reduction readout beside the title
            const gr = document.createElement('span');
            gr.className = 'fx-gr mono';
            head.appendChild(gr);
        }
        card.appendChild(head);

        // The card's visualization (fx_viz.js): EQ spectrum+curve,
        // compressor envelope+threshold+GR, echo taps, reverb tail
        const viz = document.createElement('canvas');
        viz.className = 'fx-viz';
        card.appendChild(viz);

        fx.params.forEach(p => {
            const line = document.createElement('label');
            line.className = 'fx-param';
            const name = document.createElement('span');
            name.className = 'fx-param-name mono';
            name.textContent = p.label;
            const input = document.createElement('input');
            input.type = 'range';
            input.min = String(p.min);
            input.max = String(p.max);
            input.step = String(p.step);
            input.dataset.key = p.key;
            input.addEventListener('pointerdown', () => { input._hot = true; });
            input.addEventListener('pointerup', () => { input._hot = false; });
            input.addEventListener('input', () => {
                cb.onSetEffectParam(row._lane.ownerId, fx.type, p.key,
                    parseFloat(input.value));
                setText(line.querySelector('.fx-param-value'), p.fmt(parseFloat(input.value)));
            });
            const value = document.createElement('span');
            value.className = 'fx-param-value mono';
            line.append(name, input, value);
            card.appendChild(line);
        });
        body.appendChild(card);
    });

    row.append(rail, body);
    return row;
}

function patchFxRow(row, lane) {
    row._lane = lane;
    const effects = lane.effects;
    if (!effects) return;
    EFFECT_SCHEMA.forEach(fx => {
        const state = effects[fx.type];
        if (!state) return;
        const card = row.querySelector(`.fx-card[data-fx="${fx.type}"]`);
        card.classList.toggle('off', !state.enabled);
        card.querySelector('.fx-power').classList.toggle('on', !!state.enabled);
        fx.params.forEach(p => {
            const input = card.querySelector(`input[data-key="${p.key}"]`);
            const v = state[p.key];
            if (typeof v !== 'number') return;
            // Never fight the user's drag; otherwise idempotent write
            if (!input._hot && parseFloat(input.value) !== v) {
                input.value = String(v);
            }
            setText(input.parentElement.querySelector('.fx-param-value'), p.fmt(v));
        });

        // Visualization: redrawn per poll (~20 Hz) from the published
        // scope (spectrum / peak / GR) + the card's own parameters
        const viz = card.querySelector('.fx-viz');
        const scope = effects.scope || null;
        if (fx.type === 'eq') {
            // Durable line: slow-falling high-water mark of the
            // spectrum (fx_viz.js), accumulated per poll on the canvas
            viz._avgSpec = holdSpectrum(viz._avgSpec, scope && scope.spectrum);
            drawEqViz(viz, scope && scope.spectrum,
                { low: state.low, mid: state.mid, high: state.high },
                undefined, viz._avgSpec);
        } else if (fx.type === 'compressor') {
            // Scrolling envelope: accumulate the pre-rack peak per poll
            // (the live_peaks pattern, at panel scale)
            const hist = viz._hist || (viz._hist = []);
            hist.push(scope ? scope.peak || 0 : 0);
            if (hist.length > 90) hist.shift();
            const gr = scope ? scope.gr || 0 : 0;
            drawCompViz(viz, hist, state.threshold, gr);
            setText(card.querySelector('.fx-gr'),
                gr > 0.05 ? '−' + gr.toFixed(1) + ' dB' : '');
        } else if (fx.type === 'echo') {
            drawEchoViz(viz, echoTaps(state), scope ? scope.peak : 0);
        } else if (fx.type === 'reverb') {
            drawReverbViz(viz, reverbTailSeconds(state), state.mix,
                scope ? scope.peak : 0);
        }
    });
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
    const input = document.createElement('input');
    input.className = 'rail-name-input';
    input.type = 'text';
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
            cb.onRename(lane.id, next);
        }
    };
    input.addEventListener('keydown', e => {
        e.stopPropagation(); // space must not reach the transport toggle
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

/* ---------- lane body: gridlines, reps, window, arm ----------
 *
 * RECONCILED IN LAYERS, never nuked: destroying and recreating every
 * gridline/rep/canvas on any key change made commits (and every Q
 * crossing, via armAtQ in the old whole-body key) render as a global
 * "pop" (field report 2026-07-10). Rep divs are REUSED — position
 * updates morph via CSS transitions — and canvases redraw only when
 * their own peaks/geometry change.
 */
const setStyle = (el, prop, v) => { if (el.style[prop] !== v) el.style[prop] = v; };

function layersOf(body) {
    if (!body._layers) {
        const grid = document.createElement('div');
        grid.className = 'body-layer grid-layer';
        const reps = document.createElement('div');
        reps.className = 'body-layer reps-layer';
        const overlay = document.createElement('div');
        overlay.className = 'body-layer overlay-layer';
        body.append(grid, reps, overlay);
        body._layers = { grid, reps, overlay };
    }
    return body._layers;
}

/** Redraw a rep canvas only when its peaks identity/length/size changed.
 * `src` (window echoes): [startFrac, endFrac] of the peaks to draw — the
 * window segment. Sliced only on redraw; identity tracking stays on the
 * ORIGINAL peaks array so polls don't churn.
 * `isGhost`: EVERY ghost tile is an audible repetition ("ghosts show
 * what sounds") and draws in the cool ECHO tone — warm hues are
 * reserved for material (the take tile / the live bar). */
function drawRepCanvas(div, peaks, cssWidth, cssHeight, isComposite, live,
                       pxPerSlot, src, isGhost, rotFrac) {
    let canvas = div.firstElementChild;
    if (!peaks || !peaks.length) {
        // Peaks can be transiently empty around a commit (cache regen /
        // fetch in flight): KEEP the last drawn content — stale for a
        // poll beats blinking to nothing
        div._peaksRef = null;
        div._dk = null;
        return;
    }
    if (!canvas) {
        canvas = document.createElement('canvas');
        div.appendChild(canvas);
    }
    // Peaks arrays are replaced on refetch (new ref) and mutated in place
    // while recording (same ref, growing length) — both covered here
    const dk = peaks.length + ':' + Math.round(cssWidth) + ':' +
        Math.round(cssHeight) + ':' + isComposite + ':' + !!live + ':' +
        Math.round((pxPerSlot || 0) * 1000) + ':' +
        (src ? src.map(r => r[0].toFixed(4) + '-' + r[1].toFixed(4)).join(',') : '') +
        ':' + !!isGhost + ':' + ((rotFrac || 0).toFixed(4));
    if (div._peaksRef === peaks && div._dk === dk) return false;

    // CONTENT SWAP → CROSS-FADE: a new peaks array replacing an old one
    // (live meter peaks → fetched waveform at commit; composite regen)
    // is a re-rendering of the same audio with features shifted a few
    // px — hard-swapping it read as squish/stretch (field video
    // 2026-07-10). The old canvas fades out over the new one.
    if (!live && div._peaksRef && div._peaksRef !== peaks && canvas.width > 0) {
        const old = canvas;
        old.style.transition = 'opacity 240ms linear';
        requestAnimationFrame(() => { old.style.opacity = '0'; });
        setTimeout(() => old.remove(), 320);
        canvas = document.createElement('canvas');
        div.insertBefore(canvas, old); // new below; old fades on top
    }
    div._peaksRef = peaks;
    div._dk = dk;
    if (live) {
        // Smoothed ratcheting normalization (live_peaks.liveBoost):
        // converges to the committed boost, so commit doesn't pop. The
        // FIXED px-per-slot scale pins every drawn peak to its slot's
        // pixels for the life of the take (poolColumns fixed mode).
        div._liveBoost = liveBoost(div._liveBoost, peaks);
        canvas.style.width = Math.round(cssWidth) + 'px';
        drawWaveform(canvas, peaks, { cssWidth, cssHeight,
            fixedBoost: div._liveBoost, pxPerPeak: pxPerSlot || undefined });
    } else {
        if (div._liveBoost !== undefined) delete div._liveBoost;
        // Pinned, like the live bar: the div's transition reveals/clips
        // the canvas — stretching it mid-morph distorted the content
        canvas.style.width = Math.round(cssWidth) + 'px';
        // Map content draws only its segment(s) — `src` is a LIST of
        // content ranges (phase 3: a multi-segment map concatenates its
        // slices, the heard-time picture); all ghosts draw in the echo
        // tone (audible repetitions — warm is for material).
        let drawPeaks = peaks;
        if (src) {
            const n = peaks.length;
            drawPeaks = [];
            for (const [f0, f1] of src) {
                const a = Math.max(0, Math.floor(f0 * n));
                const b = Math.min(n, Math.max(a + 1, Math.ceil(f1 * n)));
                for (let i = a; i < b; i++) drawPeaks.push(peaks[i]);
            }
            // Phase rotation (heard tiles sit on the frame grid; the
            // loop's top appears at rotFrac of the tile — every sample
            // stays at its true island phase with no wrap sliver).
            const m = drawPeaks.length;
            const rotN = Math.round(((rotFrac || 0) % 1) * m);
            if (rotN > 0 && m > 1) {
                drawPeaks = drawPeaks.slice(m - rotN)
                    .concat(drawPeaks.slice(0, m - rotN));
            }
        }
        // Tone follows GHOSTNESS, not segment-ness: a heard-view lane's
        // bright tile carries `src` (it draws the window segment) but is
        // the sounding material — warm tape, not the cool echo tone.
        drawWaveform(canvas, drawPeaks,
            { cssWidth, cssHeight, isComposite, isEcho: !!isGhost });
    }
    return true; // redrew
}

/** Keep `container`'s children to exactly the built descriptors. */
function reconcileMarkers(container, key, build) {
    if (container._key === key) return;
    container._key = key;
    container.textContent = '';
    build(container);
}

function patchLaneBody(row, lane, vm, aux) {
    if (lane.kind === 'add' || lane.kind === 'fx') return;
    const body = row.querySelector('.lane-body');
    // Per-lane scale (law 13 amendment): a window-EDITING lane shows its
    // full raw take on its own horizontal frame — an inspector, not a
    // timeline. Everything below maps through this local cycle.
    const cycleQ = lane.frameQ || vm.cycleQ;
    const { grid, reps: repsL, overlay } = layersOf(body);
    const peaks = lanePeaks(lane, aux);
    const bodyW = body.clientWidth;
    const bodyH = body.clientHeight - 6 || 58;

    // State classes (idempotent via classList.toggle)
    body.classList.toggle('win-bypassed', !!(lane.window && lane.window.bypassed));
    body.classList.toggle('is-recording', !!lane.recording);
    body.classList.toggle('armed-empty',
        lane.kind === 'clip' && !lane.recording && lane.reps.length === 0 && lane.armed);
    // Inspector honesty (field 2026-07-22): an edit-view lane frames
    // its raw take on its own scale — the global playhead is suppressed
    // over it (stacking, see .inspecting) and the amber heard cursor is
    // its one honest cursor.
    body.classList.toggle('inspecting', !!lane.windowEditing);

    // Grid layer: rebuilt only when the frame's tick set changes
    reconcileMarkers(grid, 'g:' + cycleQ + ':' + vm.ruler.ticks.length, g => {
        vm.ruler.ticks.forEach(t => {
            if (t.q === 0 || t.q === cycleQ) return;
            const d = document.createElement('div');
            d.className = 'gridline' + (t.major ? ' major' : '');
            d.style.left = pct(t.q, cycleQ);
            g.appendChild(d);
        });
    });

    // Reps layer: RECONCILE — reuse divs, update geometry in place.
    // The bar anchors at its Q boundary; in the first-take frame there
    // is no Q yet (quantum = 1 sample — rounding is meaningless and the
    // latency wobble made the left edge vibrate), and the first take by
    // definition starts the timeline: anchor 0.
    const wantBar = lane.recording && !lane.pendingStart;
    const barStartQ = !vm.qEstablished ? 0
        : Math.max(0, Math.round(vm.playheadQ - lane.recordingLengthQ));
    // The bar's edge is "now" (the playhead) — the written content
    // (canvas) trails inside by the latency compensation, and the bar's
    // background marks the being-written zone. Ending the bar at
    // start+length left the playhead visibly ahead of the waveform
    // (field screenshot 2026-07-10).
    const tiles = wantBar
        ? [{
            startQ: barStartQ,
            endQ: Math.max(vm.playheadQ,
                barStartQ + Math.max(lane.recordingLengthQ, 0.05)),
            ghost: false, bar: true,
        }]
        : lane.reps;

    // Surplus tiles FADE OUT through the settle instead of vanishing:
    // instant removal while the surviving tile is still mid-morph left a
    // momentary gap (the group lane's "squish" at commit — the engine
    // replay proved the state trajectory clean; this was the DOM layer)
    const live = [...repsL.children].filter(d => !d._exiting);
    for (let i = live.length - 1; i >= tiles.length; i--) {
        const d = live[i];
        d._exiting = true;
        d.style.opacity = '0';
        setTimeout(() => d.remove(), 220);
    }
    const rows = live.slice(0, tiles.length);
    tiles.forEach((rep, i) => {
        let div = rows[i];
        if (!div) {
            div = document.createElement('div');
            // A fresh tile must appear AT its geometry, never animate
            // from width 0 ("composite collapses to zero then expands" —
            // field 2026-07-10, when a commit changes the tile count)
            div.style.transition = 'none';
            repsL.appendChild(div);
            requestAnimationFrame(() =>
                requestAnimationFrame(() => { div.style.transition = ''; }));
        }
        const cls = 'rep' + (rep.ghost ? ' ghost' : '') +
            (rep.echo ? ' echo' : '') +
            (rep.bar
                ? ' recording-bar' + (lane.throughMap ? ' map-bar' : '')
                : '');
        if (div.className !== cls) div.className = cls;
        // The live bar draws at a FIXED px-per-slot scale: a peak's
        // pixels are a function of its slot index only, never of the
        // growing count — fit-to-width remapped every column each poll
        // (the "vibrates left and right" field report; worst after a
        // frame extension shrinks the scale). The bar div's edge still
        // advances smoothly, ≤1 slot ahead of the canvas.
        let cssW = Math.max(2, bodyW * (rep.endQ - rep.startQ) / cycleQ);
        let pxPerSlot = 0;
        if (rep.bar && peaks && aux.sampleRate) {
            const slotQ = aux.sampleRate / (PEAKS_PER_SECOND * aux.vmQuantum);
            pxPerSlot = bodyW * slotQ / cycleQ;
            cssW = Math.max(2, Math.ceil(peaks.length * pxPerSlot));
        }
        const redrew = drawRepCanvas(div, peaks, cssW, bodyH,
            lane.kind === 'group', !!rep.bar, pxPerSlot,
            rep.srcSegs || (rep.src ? [rep.src] : null), !!rep.ghost,
            rep.srcTopFrac || 0);

        // MORPH ONLY PURE MOVES; SNAP RE-LAYOUTS. When the canvas was
        // redrawn AND the geometry changed in the same patch (a commit
        // or frame settle), animating the container over new content
        // reads as false motion — the composite visibly "stretched"
        // 255→510px at every growing commit (field 2026-07-10). Since
        // px-per-Q is preserved across the settle, snapping makes the
        // change read as the ghost half lighting up, not movement.
        const newLeft = pct(rep.startQ, cycleQ);
        const newWidth = pct(rep.endQ - rep.startQ, cycleQ);
        const geomChanged = div.style.left !== newLeft || div.style.width !== newWidth;
        if (redrew && geomChanged && !rep.bar) {
            div.style.transition = 'none';
            requestAnimationFrame(() =>
                requestAnimationFrame(() => { div.style.transition = ''; }));
        }
        setStyle(div, 'left', newLeft);
        setStyle(div, 'width', newWidth);
    });

    // Overlay layer: window brackets + arm marker (small, cheap rebuild).
    // NEVER rebuilt under an active bracket drag: the drag holds pointer
    // capture on a bracket element — replacing it mid-drag would orphan
    // the gesture (same node-replacement class as the setText law).
    const armedEmpty = (lane.kind === 'clip' && !lane.recording &&
        lane.reps.length === 0 && lane.armed) || (lane.recording && lane.pendingStart);
    const armQ = vm.armAtQ % cycleQ;
    // Cut-band creation is wired ONCE per body and reads per-patch
    // state — refresh it before any early return so a lane changing
    // views never leaves a stale (wrong-frame) editor behind.
    wireBandCreate(body, lane, vm, cycleQ);
    // HEARD-VIEW chrome (law 13 amendment): a quiet chip + edge grips
    // that EXPAND the lane into its edit view (full raw take with the
    // selection brackets — the seed track's trim view, per lane).
    if (lane.windowChipQ && !lane.windowEditing) {
        // HEARD-VIEW chrome, MODELESS (field 2026-07-23: "just let me
        // manipulate the drag handles live"): the edge grips ARE trim
        // handles (drag adjusts the outer bounds directly, whole-Q
        // snap, commit on release); cuts render as SEAM HANDLES (drag
        // slides the cut freely, ⌥-drag resizes, double-click heals);
        // the chip opens the raw-take inspector for INSPECTION only —
        // never required for editing, and it no longer eats a drag.
        const heardKey = JSON.stringify(
            ['heard', lane.bandSegs, lane.bandTotalQ, lane.windowChipQ,
             lane.mapMulti, cycleQ, lane.takeStartQ, lane.bandEditable,
             lane.reps.map(r => [r.startQ, r.endQ])]);
        if (body._winDrag) return;
        reconcileMarkers(overlay, heardKey, o => {
            const chip = document.createElement('div');
            chip.className = 'win-chip win-open-chip toggle';
            chip.title = 'Inspect the whole take (editing works right here)';
            chip.textContent = (lane.mapMulti ? 'map ' : 'window ') +
                fmtQ(lane.windowChipQ) + 'Q';
            chip.addEventListener('click', () => cb.onWindowEdit(lane.id, true));
            o.appendChild(chip);
            appendTrimGrips(o, lane, vm, body, cycleQ);
            appendCutBands(o, lane, vm, body, cycleQ);  // heard → seams
        });
        return;
    }
    // MULTI-SEGMENT map on a group (phase 3): dims over the uncovered
    // regions + segment boundary ticks + ONE chip (bypass toggle) + the
    // inner cuts as draggable BANDS. No per-segment brackets.
    if (lane.mapSegs) {
        const mapKey = JSON.stringify(
            ['map', lane.mapSegs, lane.mapBypassed, cycleQ,
             lane.bandEditable]);
        // The sound cursor keeps moving through a band drag (the
        // reconcile below is frozen, but the ear isn't).
        patchWinCursor(overlay, lane, vm, cycleQ);
        if (body._winDrag) return;
        reconcileMarkers(overlay, mapKey, o => {
            if (!lane.mapBypassed) {
                buildWindowDims(o, { segs: lane.mapSegs }, lane, cycleQ);
            }
            for (const [s, e] of lane.mapSegs) {
                for (const q of [s, e]) {
                    const t = document.createElement('div');
                    t.className = 'map-seam-tick';
                    t.style.left = pct(q, cycleQ);
                    o.appendChild(t);
                }
            }
            const chip = document.createElement('div');
            chip.className = 'win-chip toggle' +
                (lane.mapSegs[lane.mapSegs.length - 1][1] >= cycleQ
                    ? ' at-end' : '');
            chip.style.left =
                pct(lane.mapSegs[lane.mapSegs.length - 1][1], cycleQ);
            chip.textContent = lane.mapBypassed
                ? 'map · bypassed'
                : 'map · ' + fmtQ(lane.mapChipQ) + 'Q';
            chip.title = 'Toggle the map (bypass keeps its shape)';
            chip.addEventListener('click', () => cb.onToggleWindow(lane.id));
            o.appendChild(chip);
            if (!lane.mapBypassed) {
                // Heard-time cursor: jumps across the cuts (seam-aware
                // positioning below) — the honest line on a lane whose
                // intrinsic frame the audible cycle no longer matches.
                const cur = document.createElement('div');
                cur.className = 'win-cursor';
                o.appendChild(cur);
            }
            appendCutBands(o, lane, vm, body, cycleQ);
        });
        patchWinCursor(overlay, lane, vm, cycleQ);
        return;
    }
    const win = lane.window || latentWindow(lane, vm);
    // Window geometry is CONTENT-relative; the lane's content-frame
    // origin is its take tile (takeStartQ) — brackets/dims/cursor all
    // shift by it (field 2026-07-16c: they drew a phase off for takes
    // not anchored at the frame top).
    const anchorQ = lane.takeStartQ || 0;
    const overlayKey = JSON.stringify(
        [win, armedEmpty && armQ, cycleQ, anchorQ,
         lane.bandSegs || null, lane.bandEditable || false,
         lane.windowEditing || false, lane.parentMapSegs || null]);

    // The heard-time WINDOW CURSOR: where in its window this lane is
    // sounding right now (the engine publishes the window phase on
    // `playhead`). The island playhead sweeps ISLAND time — under an
    // active window the lane hears MAPPED time, and without this cursor
    // the loop looked dead ("the loop window doesn't work anymore",
    // field 2026-07-11). Patched every poll, OUTSIDE the keyed rebuild —
    // and BEFORE the drag gate: during an expanded map drag this same
    // lane frames the RAW take (per-lane scale), the phase maps through
    // the live-committed segments, and the cursor jumps the cuts — the
    // "where is the sound" line the editing view was missing (field
    // 2026-07-25).
    patchWinCursor(overlay, lane, vm, cycleQ);
    if (body._winDrag) return;

    reconcileMarkers(overlay, overlayKey, o => {
        // Enclosing-map projection (phase 3): the group map's excluded
        // regions dim this child lane too — what the map silences, the
        // child shows silenced. Tiled per GROUP cycle.
        if (lane.parentMapSegs && lane.parentMapPeriodQ > 0) {
            const P = lane.parentMapPeriodQ;
            const addDim = (fromQ, toQ) => {
                const from = Math.max(0, fromQ);
                const to = Math.min(cycleQ, toQ);
                if (to - from <= 1e-9) return;
                const d = document.createElement('div');
                d.className = 'win-dim parent-map-dim';
                d.style.left = pct(from, cycleQ);
                d.style.width = pct(to - from, cycleQ);
                o.appendChild(d);
            };
            for (let base = 0; base < cycleQ; base += P) {
                let prev = 0;
                for (const [s, e] of lane.parentMapSegs) {
                    addDim(base + prev, base + s);
                    prev = e;
                }
                addDim(base + prev, base + P);
            }
        }
        if (armedEmpty) {
            const m = document.createElement('div');
            m.className = 'arm-marker';
            m.style.left = pct(armQ, cycleQ);
            const label = document.createElement('div');
            label.className = 'arm-label';
            label.style.left = pct(armQ, cycleQ);
            label.textContent = '● at ' + (armQ === 0 ? '↺' : armQ + 'Q');
            o.append(m, label);
        }
        if (win) {
            const { startQ, endQ, active, bypassed, latent } = win;
            if (active && !bypassed) {
                // The window is a SUBSET of every repetition: the frame
                // stays intrinsic (displayPeriodQ), so dim the outside
                // regions once per period tile across the whole cycle
                buildWindowDims(o, { startQ, endQ }, lane, cycleQ);
            }
            // Q13: the sole Q-definer's handles re-establish Q — style
            // them as "sets tempo" and always show the chip (even latent).
            const qDef = !!lane.isQDefiner;
            const qCls = qDef ? ' q-definer' : '';
            const latentCls = latent ? ' latent' : '';
            const b1 = document.createElement('div');
            b1.className = 'win-bracket start' + latentCls + qCls;
            b1.style.left = pct(anchorQ + startQ, cycleQ);
            const b2 = document.createElement('div');
            b2.className = 'win-bracket end' + latentCls + qCls;
            b2.style.left = pct(anchorQ + endQ, cycleQ);
            o.append(b1, b2);
            if (!latent || qDef) {
                const chip = document.createElement('div');
                // A window ending AT the display cycle would put the
                // chip past the lane's overflow clip — align it inward
                chip.className = 'win-chip' + qCls +
                    (anchorQ + endQ >= cycleQ ? ' at-end' : '');
                chip.style.left = pct(anchorQ + endQ, cycleQ);
                chip.textContent = qDef
                    ? 'sets tempo · drag to trim'
                    : bypassed ? 'window · bypassed' : active ? 'window · active' : 'window';
                o.appendChild(chip);
                if (lane.windowEditing) {
                    const done = document.createElement('div');
                    done.className = 'win-chip win-done-chip toggle';
                    done.textContent = 'done';
                    done.title = 'Close the window editor (Esc)';
                    done.style.left = pct(anchorQ + startQ, cycleQ);
                    done.addEventListener('click', () =>
                        cb.onWindowEdit(lane.id, false));
                    o.appendChild(done);
                }
                if (active && !bypassed && !qDef) {
                    // Heard-time cursor: positioned per poll below. NOT
                    // on the Q-definer — there the MAIN playhead is
                    // mapped into the selection (vm.loopStartQ), and a
                    // second cursor over the same span was the "two
                    // cursors" field bug (2026-07-19).
                    const cur = document.createElement('div');
                    cur.className = 'win-cursor';
                    o.appendChild(cur);
                }
            }
            wireWindow(o, lane, vm, body, win);
        }
        // Cut bands ride alongside the bracket chrome wherever the lane
        // frames its raw material (groups, clip edit views, windowless
        // resting clips).
        appendCutBands(o, lane, vm, body, cycleQ);
        if (lane.windowEditing && !o.querySelector('.win-done-chip')) {
            const done = document.createElement('div');
            done.className = 'win-chip win-done-chip toggle';
            done.textContent = 'done';
            done.title = 'Close the take view (Esc)';
            done.addEventListener('click', () =>
                cb.onWindowEdit(lane.id, false));
            o.appendChild(done);
        }
    });
}

/* ---------- CUT BANDS (time_maps.md §4, owner-chosen design A) ----------
 *
 * A cut is a first-class object in the bracket vocabulary: a dim band
 * with two bracket-style handles and a length chip. Double-click the
 * take → a 1Q cut on that Q cell; double-click a cut → it heals; drag
 * the chip → the cut SLIDES freely, length held (the "exclude 1Q off
 * the boundary" move); drag a handle → resize, length snapping to
 * whole Qs on release (⌥ = free, badged "N.NNQ ⚠" — the seam theorem
 * made visible). One setSegments per finished gesture = one undo step.
 * Leading/trailing exclusions stay the WINDOW brackets' domain — bands
 * are only the INNER gaps, so the two gestures never overlap.
 */

/** Per-patch band state stashed on the body for the once-wired
 * creation/drag handlers (elements rebuild per reconcile; handlers on
 * the body must read fresh state). */
function bandState(lane, vm, cycleQ) {
    return {
        laneId: lane.id,
        segs: lane.bandSegs,           // covered set (Q); null = full span
        totalQ: lane.bandTotalQ || 0,
        anchorQ: lane.takeStartQ || 0,
        editable: !!lane.bandEditable,
        heard: !!lane.bandHeard,       // lane frames HEARD time (seams,
        periodQ: lane.bandPeriodQ || 0,  // not bands)
        quantum: vm.quantum,
        cycleQ,
    };
}

function commitBandSegs(st, segsQ) {
    if (segsQ === null) return;  // refusal: keep the previous map
    const flat = [];
    segsQ.forEach(([s, e]) =>
        flat.push(Math.round(s * st.quantum), Math.round(e * st.quantum)));
    cb.onSetSegments(st.laneId, flat);
}

function bandContentQ(st, body, clientX) {
    const r = body.getBoundingClientRect();
    const laneQ = ((clientX - r.left) / r.width) * st.cycleQ;
    if (st.heard && st.periodQ > 0) {
        // Heard lane: the pointer lives in heard time — hop through the
        // map to the RAW position it selects.
        const h = (((laneQ - st.anchorQ) % st.periodQ) + st.periodQ)
            % st.periodQ;
        return mapOffset({ segs: st.segs || [[0, st.totalQ]] }, h);
    }
    const P = st.totalQ;
    return (((laneQ - st.anchorQ) % P) + P) % P;
}

/* While any map gesture is live, the SHARED display frame is PINNED:
 * live commits change the audible cycle, and letting the frame follow
 * re-scaled every lane + the ruler under the pointer mid-drag (owner
 * video, 2026-07-23g — the world must not squirm while you hold it).
 * The frame settles once, on release. */
/* Map-gesture flight recorder (field 2026-07-25g: a flicker survives
 * that the mock cannot reproduce). Ring of the last 400 gesture events
 * — read `window.__mapDbg` in the app's console after a repro. Also
 * warns loudly when two renders under a near-still pointer disagree on
 * the pending segments (the flicker's signature). */
const mapDbgRing = (typeof window !== 'undefined')
    ? (window.__mapDbg = []) : [];
let mapDbgPrev = null;
function mapDbg(a, rec) {
    const e = Object.assign({ t: Math.round(performance.now()), a }, rec);
    mapDbgRing.push(e);
    if (mapDbgRing.length > 400) mapDbgRing.splice(0, mapDbgRing.length - 400);
    if (a === 'render') {
        const sig = JSON.stringify(rec.segs);
        if (mapDbgPrev && Math.abs(rec.bound - mapDbgPrev.bound) < 0.05 &&
            sig !== mapDbgPrev.sig) {
            console.warn('[map-flicker] segs changed under a still pointer:',
                mapDbgPrev.sig, '→', sig, 'bound', rec.bound);
        }
        mapDbgPrev = { bound: rec.bound, sig };
    } else if (a === 'up' || a === 'engage') {
        mapDbgPrev = null;
    }
}

let dragPinQ = null;
let dragPinFoldQ = null;  // audible-cycle fold pinned with the frame
let lastFrameQ = 0;  // vm.cycleQ as of the latest patch (pin source)
let lastFoldQ = 0;   // vm.loopCycleQ ditto — the cursor's fold cycle
export function mapDragPinQ() { return dragPinQ; }
export function mapDragPinFoldQ() { return dragPinFoldQ; }

/* ---------- EXPANDED MAP DRAG (owner-ruled, field 2026-07-23e) -------
 *
 * "When you are dragging a drag handle the clip expands to show the
 * entire clip timeline (including excluded sections)." Geometry edits
 * are RAW-frame facts; editing them in heard space made handles wrap,
 * chunks vanish off edges, and the ground shift mid-gesture. So:
 * grabbing any handle on a heard lane EXPANDS it to the raw take for
 * the duration of the drag — excluded material visible as dims, the
 * cut a real band, the trim bracket over visible content — commits
 * stream live (audible), and release collapses back to the heard view.
 * The main cursor is suppressed over the expanded lane (.inspecting);
 * the raw-frame preview is the ground truth under the pointer.
 */

/** Absolute pointer → RAW-take Q inside the expanded lane. */
function rawQAt(st, body, clientX) {
    const r = body.getBoundingClientRect();
    const q = ((clientX - r.left) / r.width) * st.totalQ;
    return Math.max(0, Math.min(st.totalQ, q));
}

/** Trim one outer bound to an absolute raw position (heal reveals,
 * cut consumes); null = refusal, keep previous. */
function trimBoundTo(segs, edge, boundQ, totalQ) {
    const cov = (segs && segs.length) ? segs : [[0, totalQ]];
    if (edge === 'start') {
        const first = cov[0][0];
        if (boundQ < first - 1e-9) return healCut(cov, boundQ, first, totalQ);
        return applyCut(cov, 0, boundQ, totalQ);
    }
    const last = cov[cov.length - 1][1];
    if (boundQ > last + 1e-9) return healCut(cov, last, boundQ, totalQ);
    return applyCut(cov, boundQ, totalQ, totalQ);
}

/** The raw-frame drag preview — TWO-LAYER FEEDBACK (the bracket law):
 * a pointer-attached FOLLOW element moves continuously with the mouse
 * (`follow`: a bracket or a band), while a dashed snap ghost + badge
 * show the whole-Q landing (`active`), over dims of the pending kept
 * set. Rebuilt per move (a dozen nodes; the overlay is frozen and
 * OWNED by the gesture). */
function renderRawPreview(o, st, segsPreview, active, follow) {
    // NEVER wipe the overlay itself: the grabbed handle lives there and
    // holds the pointer capture — clearing it mid-gesture killed the
    // drag (found by real-input verification, 2026-07-23e). The preview
    // owns a dedicated layer; the stale chrome fades via .drag-live.
    let layer = o.querySelector('.drag-preview-layer');
    if (!layer) {
        layer = document.createElement('div');
        layer.className = 'drag-preview-layer';
        o.appendChild(layer);
        o.classList.add('drag-live');
    }
    layer.textContent = '';
    o._key = 'expanded-drag';  // poisons the key → fresh reconcile after
    const cov = (segsPreview && segsPreview.length)
        ? segsPreview
        : (segsPreview ? [[0, st.totalQ]] : null);
    if (!cov) return;
    const fake = { intrinsicQ: st.totalQ, takeStartQ: 0, kind: 'clip' };
    buildWindowDims(layer, { segs: cov }, fake, st.totalQ);
    // Resting bracket lines at the PENDING kept bounds (context).
    for (const [edge, q] of [['start', cov[0][0]],
                             ['end', cov[cov.length - 1][1]]]) {
        if (follow && follow.kind === 'bracket' && follow.edge === edge) {
            continue;  // the follow element replaces this edge's bracket
        }
        const b = document.createElement('div');
        b.className = 'win-bracket ' + edge;
        b.style.left = pct(q, st.totalQ);
        layer.appendChild(b);
    }
    // THE FOLLOW ELEMENT: attached to the pointer, continuous — you
    // always see exactly what you're holding.
    if (follow) {
        if (follow.kind === 'bracket') {
            const fb = document.createElement('div');
            fb.className = 'win-bracket dragging ' + follow.edge;
            fb.style.left = pct(follow.q, st.totalQ);
            layer.appendChild(fb);
        } else {
            const band = document.createElement('div');
            band.className = 'cut-band';
            band.style.left = pct(follow.a, st.totalQ);
            band.style.width = pct(follow.b - follow.a, st.totalQ);
            layer.appendChild(band);
            for (const [edge, q] of [['start', follow.a], ['end', follow.b]]) {
                const h = document.createElement('div');
                h.className = 'cut-handle ' + edge;
                h.style.left = 'calc(' + pct(q, st.totalQ) +
                    (edge === 'end' ? ' - 14px)' : ')');
                h.style.pointerEvents = 'none';
                layer.appendChild(h);
            }
        }
    }
    if (active) {
        const badge = document.createElement('div');
        badge.className = 'cut-chip mono' +
            (active.incoherent ? ' incoherent' : '');
        badge.textContent = active.text;
        badge.style.left = pct(active.q, st.totalQ);
        // Ride above the lane's midline: at center the badge text sat
        // right on the follow bracket and the snap ghost (unreadable
        // "loop er,d" in the field video).
        badge.style.top = '22%';
        // Edge-aware anchoring so the text never clips off the lane
        // ("oop start · 3Q" in the field video).
        badge.style.transform = active.q < st.totalQ * 0.15
            ? 'translate(0, -50%)'
            : active.q > st.totalQ * 0.85 ? 'translate(-100%, -50%)'
            : 'translate(-50%, -50%)';
        layer.appendChild(badge);
        // Dashed snap ghost only when the landing differs from the
        // pointer (free slides have no snap to preview).
        if (active.ghost) {
            const line = document.createElement('div');
            line.className = 'cut-ghost';
            line.style.display = '';
            line.style.left = pct(active.q, st.totalQ);
            layer.appendChild(line);
        }
    }
}

/** Shared gesture runner: expand → drag in raw space → live commits →
 * final commit → collapse. `onMove(rawQ, altKey)` receives the
 * pointer's EFFECTIVE raw-take Q (null for the at-rest render at
 * pointerdown) and returns { segs, active, follow } or null.
 *
 * EASED CAPTURE (field 2026-07-25b, replacing both earlier schemes):
 * the grab pixel lives in HEARD geometry but the expanded lane is RAW
 * geometry, so once the lane opens the pointer is genuinely NOT over
 * the thing it grabbed — a pure delta kept that offset forever (the
 * handle rode ~1 cut-width from the mouse; edge bounds unreachable),
 * and a pure absolute glue TELEPORTED the handle on the first move.
 * Resolution (owner-ruled 2026-07-25f): the bound is RELATIVE —
 * `anchorQ` (the grabbed thing's raw position) plus accumulated
 * pointer deltas — and the native cursor WARP that unifies pointer
 * and handle is purely cosmetic, so its timing can never disturb the
 * gesture. Where warping is unsupported the mode flips to ABSOLUTE
 * (handle snaps to the pointer, stays glued). (> 4px before anything
 * happens — a sloppy grab-release must not edit.) */
function runExpandedDrag(ev, o, lane, st, body, anchorQ, onMove) {
    ev.preventDefault();
    ev.stopPropagation();
    try { ev.target.setPointerCapture(ev.pointerId); } catch (_) {}
    const downX = ev.clientX;
    // THE GORDIAN CUT, simplified (owner-ruled 2026-07-25f): the bound
    // is RELATIVE — anchorQ plus accumulated pointer deltas — for the
    // whole gesture, and the warp is pure COSMETICS. Because the
    // cursor's absolute position never feeds the bound, the warp can
    // land early, late, or mid-flight without resetting anything: a
    // user who grabs and immediately moves fast loses nothing. The
    // delta filter also swallows warp echoes (CGWarp during a held
    // button can interleave warped and un-warped event positions — the
    // suppression-interval gotcha; any single ≥150px jump is not a
    // hand, it only rebases).
    //
    // Backends that cannot warp (the mock harness) resolve false and
    // the mode flips to ABSOLUTE: the handle snaps to the pointer and
    // stays glued (one visible jump, but every bound stays reachable —
    // owner-ruled: better a snap than easing complexity).
    let boundQ = anchorQ;
    let absolute = false;
    let prevX = ev.clientX;
    let lastClientY = ev.clientY;
    let warpState = 0;  // 0 untried · 1 requesting · 2 settled
    let echoUntil = 0;  // echo filter armed only just after the warp
    let lastAlt = ev.altKey;
    let engaged = false;
    let last = null;
    let lastLive = 0;
    const apply = () => {
        const res = onMove(boundQ, lastAlt);
        if (!res) return;
        last = res;
        renderRawPreview(o, st, res.segs, res.active, res.follow);
        mapDbg('render', { bound: +boundQ.toFixed(3),
            segs: res.segs && res.segs.map(s => +((s[1] - s[0]).toFixed(2))) });
        const now = performance.now();
        if (res.segs && now - lastLive > 90) {
            lastLive = now;
            commitBandSegs(st, res.segs);  // LIVE: audible while dragging
        }
    };
    // Warp the OS cursor onto the grabbed handle, once the raw view
    // has landed (the pixel mapping is expanded-frame; the horizontal
    // geometry flips in one patch — the lane-open ease is vertical
    // only, so there is no intermediate to ride).
    const tryWarp = () => {
        if (warpState || !body._winDrag) return;
        if (!cb.onWarpPointer) { warpState = 2; absolute = true; return; }
        if (!body.classList.contains('inspecting')) {
            setTimeout(tryWarp, 30);   // expansion still in flight
            return;
        }
        warpState = 1;
        const br = body.getBoundingClientRect();
        const x = br.left + (boundQ / st.totalQ) * br.width;
        Promise.resolve(cb.onWarpPointer(x, lastClientY)).then(ok => {
            warpState = 2;
            mapDbg('warp', { ok });
            if (!ok) { absolute = true; return; }  // snap-to-pointer
            // Warp echoes (warped/un-warped stream interleave) can only
            // exist inside the macOS suppression interval — arm the
            // jump filter for just that window. Armed forever, it ate
            // genuine fast-flick deltas and the handle fell ~1Q behind
            // the pointer with no way to resync (owner video
            // 2026-07-25h, "drag quickly → cursor disconnected").
            echoUntil = performance.now() + 400;
        });
    };
    // THE ENGAGE GATE (field 2026-07-25g): expansion AND warp start
    // only once the press is a real drag — > 4px of travel or a 160ms
    // hold. A quick click(-click) never expands and never moves the
    // cursor, so double-click heal/create keeps stable geometry under
    // both of its clicks (the immediate warp used to teleport the
    // cursor between them, and the expansion moved the seam out from
    // under click two — the "doubled split").
    const engage = () => {
        if (engaged || !body.isConnected) return;
        engaged = true;
        mapDbg('engage', {});
        clearTimeout(body._flashT);     // a drag supersedes a flash
        body._winDrag = true;           // freeze the overlay reconcile
        dragPinQ = lastFrameQ;          // freeze the SHARED frame
        dragPinFoldQ = lastFoldQ;       // …and the cursor's fold cycle
        cb.onWindowEdit(lane.id, true); // expand to the raw take
        // The raw-frame SOUND CURSOR lives through the gesture (the
        // poll keeps positioning it — patchWinCursor runs before the
        // _winDrag gates): you hear the live splice AND see where it
        // is sounding.
        if (!o.querySelector('.win-cursor')) {
            const cur = document.createElement('div');
            cur.className = 'win-cursor';
            o.appendChild(cur);
        }
        // Immediate feedback: the preview (dims + the followed handle
        // at rest) appears with the expansion, not on the first move.
        const initial = onMove(null, lastAlt);
        if (initial) {
            renderRawPreview(o, st, initial.segs, initial.active,
                initial.follow);
        }
        tryWarp();
    };
    const holdT = setTimeout(engage, 160);
    const move = mv => {
        if (!engaged && Math.abs(mv.clientX - downX) <= 4) return;
        engage();
        if (absolute) {
            boundQ = rawQAt(st, body, mv.clientX);
        } else {
            const dx = mv.clientX - prevX;
            if (Math.abs(dx) >= 150 && performance.now() < echoUntil) {
                mapDbg('echo', { dx: Math.round(dx) });
                // warp echo (only possible in the post-warp suppression
                // window): rebase without applying
            } else {
                const w = body.getBoundingClientRect().width || 1;
                boundQ = Math.max(0, Math.min(st.totalQ,
                    boundQ + (dx / w) * st.totalQ));
            }
        }
        prevX = mv.clientX;
        lastAlt = mv.altKey;
        lastClientY = mv.clientY;
        apply();
    };
    const up = () => {
        ev.target.removeEventListener('pointermove', move);
        ev.target.removeEventListener('pointerup', up);
        ev.target.removeEventListener('pointercancel', up);
        clearTimeout(holdT);
        if (!engaged) return;             // a click: nothing to undo
        mapDbg('up', {});
        body._winDrag = false;
        dragPinQ = null;                  // let the frame settle once
        dragPinFoldQ = null;
        const layer = o.querySelector('.drag-preview-layer');
        if (layer) layer.remove();
        o.classList.remove('drag-live');
        if (last && last.segs) commitBandSegs(st, last.segs);
        cb.onWindowEdit(lane.id, false);  // relax back to the heard view
    };
    ev.target.addEventListener('pointermove', move);
    ev.target.addEventListener('pointerup', up);
    ev.target.addEventListener('pointercancel', up);
}

/** The once-per-body dblclick wiring: create a cell-snapped 1Q cut on
 * the take; heal the cut under the pointer. */
function wireBandCreate(body, lane, vm, cycleQ) {
    body._bandState = bandState(lane, vm, cycleQ);
    if (body._bandsWired) return;
    body._bandsWired = true;
    body.addEventListener('dblclick', ev => {
        const st = body._bandState;
        if (!st || !st.editable || st.totalQ < 2) return;
        // HEARD lanes: a cut has ZERO width (it IS the splice), so the
        // pointer can never be "inside" it — a dblclick meant to heal
        // instead landed on adjacent content and cut ANOTHER Q, which
        // merged into a doubled cut (field 2026-07-25g, "‖ 2Q cut").
        // Near a seam (±12px, matching the handle's reach) the dblclick
        // means HEAL.
        if (st.heard && st.segs && st.segs.length > 1) {
            const br = body.getBoundingClientRect();
            const periodQ = st.periodQ ||
                st.segs.reduce((n, [a, b]) => n + (b - a), 0);
            let acc = 0;
            for (let i = 0; i < st.segs.length - 1; i++) {
                acc += st.segs[i][1] - st.segs[i][0];
                const first = ((((st.anchorQ + acc) % st.cycleQ) +
                    st.cycleQ) % st.cycleQ) % periodQ;
                for (let q = first; q < st.cycleQ; q += periodQ) {
                    const px = br.left + (q / st.cycleQ) * br.width;
                    if (Math.abs(ev.clientX - px) < 12) {
                        commitBandSegs(st, healCut(st.segs,
                            st.segs[i][1], st.segs[i + 1][0], st.totalQ));
                        return;
                    }
                }
            }
        }
        const q = bandContentQ(st, body, ev.clientX);
        const cut = innerCuts(st.segs, st.totalQ)
            .find(([a, b]) => q >= a && q < b);
        if (cut) {
            commitBandSegs(st, healCut(st.segs, cut[0], cut[1], st.totalQ));
        } else {
            const [a, b] = cellCutAt(q, st.totalQ);
            commitBandSegs(st, applyCut(st.segs, a, b, st.totalQ));
        }
        // FLASH-EXPAND (the one principle: every manipulation shows the
        // whole clip + map structure): a heard lane opens briefly so
        // the new cut is seen landing in raw context, then relaxes —
        // unless a drag has taken over in the meantime.
        if (st.heard) {
            clearTimeout(body._flashT);
            cb.onWindowEdit(st.laneId, true);
            body._flashT = setTimeout(() => {
                if (!body._winDrag) cb.onWindowEdit(st.laneId, false);
            }, 900);
        }
    });
}

/** The bands themselves, rebuilt per overlay reconcile. On heard-view
 * lanes a cut has ZERO width (it IS the splice), so it renders as a
 * SEAM HANDLE: passive ticks on every rep, one grabbable handle + chip
 * per cut on the take rep — drag slides the cut freely (length held),
 * ⌥-drag resizes (whole-Q snap), double-click heals. */
function appendCutBands(o, lane, vm, body, cycleQ) {
    const st = bandState(lane, vm, cycleQ);
    if (!st.editable || st.totalQ < 2) return;
    if (st.heard) {
        appendSeamHandles(o, lane, st, body, cycleQ);
        return;
    }
    const cuts = innerCuts(st.segs, st.totalQ);
    cuts.forEach(cut => {
        const band = document.createElement('div');
        band.className = 'cut-band';
        const chip = document.createElement('div');
        chip.className = 'cut-chip mono';
        chip.title = 'Drag to slide the cut (length held) — ' +
            'right-click or double-click heals';
        const handles = {};
        for (const edge of ['start', 'end']) {
            const h = document.createElement('div');
            h.className = 'cut-handle ' + edge;
            h.title = 'Drag to resize — length snaps to whole Qs, ⌥ for free';
            handles[edge] = h;
        }
        const ghost = document.createElement('div');
        ghost.className = 'cut-ghost';
        ghost.style.display = 'none';

        const layout = (a, b, raw) => {
            band.style.left = pct(st.anchorQ + a, cycleQ);
            band.style.width = pct(b - a, cycleQ);
            handles.start.style.left =
                'calc(' + pct(st.anchorQ + (raw && raw.edge === 'start'
                    ? raw.q : a), cycleQ) + ')';
            handles.end.style.left =
                'calc(' + pct(st.anchorQ + (raw && raw.edge === 'end'
                    ? raw.q : b), cycleQ) + ' - 14px)';
            chip.style.left = pct(st.anchorQ + (a + b) / 2, cycleQ);
            const lenQ = b - a;
            const whole = Math.abs(lenQ - Math.round(lenQ)) < 0.02;
            chip.textContent =
                (whole ? Math.round(lenQ) : lenQ.toFixed(2)) + 'Q cut' +
                (whole ? '' : ' ⚠');
            chip.classList.toggle('incoherent', !whole);
        };
        layout(cut[0], cut[1]);

        // Drag machinery — the bracket pattern: pointer capture, the
        // handle/chip follows the pointer, the ghost previews the snap,
        // release commits ONE setSegments.
        const startDrag = (kind, edge) => ev => {
            ev.preventDefault();
            ev.stopPropagation();
            // Capture keeps the drag alive off-element; a webview that
            // refuses (or a synthetic pointer) must not kill the
            // gesture wiring below.
            try { ev.target.setPointerCapture(ev.pointerId); } catch (_) {}
            body._winDrag = true;
            dragPinQ = lastFrameQ;  // freeze the shared frame (see above)
            dragPinFoldQ = lastFoldQ;
            const q0 = bandContentQ(st, body, ev.clientX);
            let target = null;
            const move = mv => {
                const q = bandContentQ(st, body, mv.clientX);
                if (kind === 'slide') {
                    target = slideCutTarget({
                        cut, rawStartQ: cut[0] + (q - q0), maxQ: st.totalQ });
                    layout(target.inQ, target.outQ);
                    ghost.style.display = 'none';
                } else {
                    target = resizeCutTarget({
                        cut, edge, rawQ: q, maxQ: st.totalQ,
                        free: mv.altKey });
                    layout(target.inQ, target.outQ, { edge, q });
                    if (!mv.altKey) {
                        ghost.style.display = '';
                        ghost.style.left = pct(st.anchorQ +
                            (edge === 'start' ? target.inQ : target.outQ),
                            cycleQ);
                    } else {
                        ghost.style.display = 'none';
                    }
                }
                // LIVE SPLICE (see the seam handles): audible preview
                // while dragging, coalesced undo.
                const now = performance.now();
                if (target && now - (band._lastLive || 0) > 90) {
                    band._lastLive = now;
                    let liveNext = healCut(st.segs, cut[0], cut[1], st.totalQ);
                    liveNext = applyCut(liveNext, target.inQ, target.outQ,
                                        st.totalQ);
                    commitBandSegs(st, liveNext);
                }
            };
            const up = () => {
                ev.target.removeEventListener('pointermove', move);
                ev.target.removeEventListener('pointerup', up);
                ev.target.removeEventListener('pointercancel', up);
                body._winDrag = false;
                dragPinQ = null;
                dragPinFoldQ = null;
                if (target) {
                    let next = healCut(st.segs, cut[0], cut[1], st.totalQ);
                    next = applyCut(next, target.inQ, target.outQ, st.totalQ);
                    commitBandSegs(st, next);
                }
            };
            ev.target.addEventListener('pointermove', move);
            ev.target.addEventListener('pointerup', up);
            ev.target.addEventListener('pointercancel', up);
        };
        chip.addEventListener('pointerdown', startDrag('slide'));
        handles.start.addEventListener('pointerdown', startDrag('resize', 'start'));
        handles.end.addEventListener('pointerdown', startDrag('resize', 'end'));
        // Right-click = heal (see the seam handles): the explicit,
        // timing-proof path.
        const healMenu = ev => {
            ev.preventDefault();
            ev.stopPropagation();
            commitBandSegs(st, healCut(st.segs, cut[0], cut[1], st.totalQ));
        };
        [band, chip, handles.start, handles.end].forEach(el =>
            el.addEventListener('contextmenu', healMenu));

        o.append(band, handles.start, handles.end, chip, ghost);
    });
}

/** Seam handles for heard-view lanes (see appendCutBands). */
function appendSeamHandles(o, lane, st, body, cycleQ) {
    const segs = (st.segs && st.segs.length)
        ? st.segs : [[0, st.totalQ]];
    if (segs.length < 2) return;  // no inner cuts, no seams
    // Heard position of each join + the raw cut behind it.
    const seams = [];
    let acc = 0;
    for (let i = 0; i < segs.length - 1; i++) {
        acc += segs[i][1] - segs[i][0];
        seams.push({ heardQ: acc, cut: [segs[i][1], segs[i + 1][0]] });
    }
    const baseQ = st.anchorQ;
    const periodQ = st.periodQ ||
        segs.reduce((n, [a, b]) => n + (b - a), 0);
    // A lane position for a heard offset, WRAPPED into the frame (the
    // content may rest mid-phase — field 2026-07-23b: an unwrapped seam
    // landed on the frame edge, half-clipped and out of reach).
    const wrapQ = heardQ => {
        const q = (((baseQ + heardQ) % cycleQ) + cycleQ) % cycleQ;
        return q;
    };
    // Passive ticks at every audible splice across the frame.
    for (const s of seams) {
        const first = wrapQ(s.heardQ) % periodQ;
        for (let q = first; q < cycleQ; q += periodQ) {
            if (q < 1e-9 || q > cycleQ - 1e-9) continue;
            const t = document.createElement('div');
            t.className = 'map-seam-tick';
            t.style.left = pct(q, cycleQ);
            o.appendChild(t);
        }
    }
    // Grabbable handle + chip, wrapped with the content.
    seams.forEach(seam => {
        const handle = document.createElement('div');
        handle.className = 'seam-handle';
        handle.title = 'The cut lives here — drag to slide it, ' +
            '⌥-drag to resize, right-click (or double-click) to heal';
        const chip = document.createElement('div');
        chip.className = 'cut-chip mono';
        const layout = (heardQ, cut) => {
            const q = wrapQ(heardQ);
            handle.style.left = 'calc(' + pct(q, cycleQ) + ' - 7px)';
            chip.style.left = pct(q, cycleQ);
            // Keep the chip readable at the frame edges.
            chip.style.transform = q < 0.4 ? 'translate(0, -50%)'
                : q > cycleQ - 0.4 ? 'translate(-100%, -50%)'
                : 'translate(-50%, -50%)';
            const lenQ = cut[1] - cut[0];
            const whole = Math.abs(lenQ - Math.round(lenQ)) < 0.02;
            chip.textContent = '‖ ' +
                (whole ? Math.round(lenQ) : lenQ.toFixed(2)) + 'Q cut' +
                (whole ? '' : ' ⚠');
            chip.classList.toggle('incoherent', !whole);
        };
        layout(seam.heardQ, seam.cut);

        handle.addEventListener('dblclick', ev => {
            ev.stopPropagation();
            commitBandSegs(st,
                healCut(st.segs, seam.cut[0], seam.cut[1], st.totalQ));
        });
        // Right-click = heal, explicitly (field 2026-07-25g: dblclick
        // near a seam is a fiddly target and the drag warp can split
        // its two clicks apart — this path has no timing to break).
        const healMenu = ev => {
            ev.preventDefault();
            ev.stopPropagation();
            commitBandSegs(st,
                healCut(st.segs, seam.cut[0], seam.cut[1], st.totalQ));
        };
        handle.addEventListener('contextmenu', healMenu);
        chip.addEventListener('contextmenu', healMenu);
        const startDrag = ev => {
            // EXPANDED DRAG (owner-ruled): the lane opens to the raw
            // take; the cut is a real band over visible content. Drag
            // slides it freely (length held), ⌥-drag resizes (whole-Q
            // snap). Deltas are RAW-frame from the first post-expansion
            // pointer sample, so nothing jumps.
            // Anchor by the mode chosen at the grab: a slide carries
            // the cut's start, ⌥-resize carries its end edge.
            const anchor0 = ev.altKey ? seam.cut[1] : seam.cut[0];
            runExpandedDrag(ev, o, lane, st, body, anchor0, (rawQ, alt) => {
                // The seam glyph marks where the cut BEGINS — the cut's
                // start is what rides the pointer on a slide; ⌥-resize
                // glues the END edge to it instead.
                const target = rawQ === null
                    ? { inQ: seam.cut[0], outQ: seam.cut[1] } // at rest
                    : alt
                        ? resizeCutTarget({ cut: seam.cut, edge: 'end',
                                            rawQ, maxQ: st.totalQ })
                        : slideCutTarget({ cut: seam.cut,
                                           rawStartQ: rawQ,
                                           maxQ: st.totalQ });
                let next = healCut(st.segs, seam.cut[0], seam.cut[1],
                                   st.totalQ);
                next = applyCut(next, target.inQ, target.outQ, st.totalQ);
                if (next === null) return null;  // refusal: keep previous
                const lenQ = target.outQ - target.inQ;
                const whole = Math.abs(lenQ - Math.round(lenQ)) < 0.02;
                // Follow: the BAND rides the pointer. Slides are free
                // (band = landing, no ghost); ⌥-resize shows the raw
                // edge under the pointer with the snap ghost at the
                // whole-Q landing.
                const rawEnd = alt && rawQ !== null
                    ? Math.min(st.totalQ,
                               Math.max(seam.cut[0] + 0.05, rawQ))
                    : target.outQ;
                return { segs: next,
                    follow: { kind: 'band', a: target.inQ, b: rawEnd },
                    active: {
                        q: alt ? target.outQ
                               : (target.inQ + target.outQ) / 2,
                        text: (whole ? Math.round(lenQ) : lenQ.toFixed(2)) +
                            'Q cut' + (whole ? '' : ' ⚠'),
                        incoherent: !whole,
                        ghost: alt && Math.abs(rawEnd - target.outQ) > 0.02,
                    } };
            });
        };
        handle.addEventListener('pointerdown', startDrag);
        chip.addEventListener('pointerdown', startDrag);
        o.append(handle, chip);
    });
}

/** Live TRIM handles on a heard-view lane's outer edges (field
 * 2026-07-23: grips must DRAG, never open a mode). Dragging inward
 * consumes kept time (whole-Q snap); outward reveals more of the take.
 * One setSegments on release — the single-window case delegates to
 * setLoopPoints inside the engine, preserving the existing semantics.
 */
function appendTrimGrips(o, lane, vm, body, cycleQ) {
    const st = bandState(lane, vm, cycleQ);
    if (!st.editable || st.totalQ < 2) return;
    const segs = (st.segs && st.segs.length) ? st.segs : [[0, st.totalQ]];
    const periodQ = st.periodQ ||
        segs.reduce((n, [a, b]) => n + (b - a), 0);
    // The grips hug the CONTENT's heard bounds (the loop may rest
    // mid-phase — its top is the bright tile's start, not the frame
    // edge; field 2026-07-23b).
    const startPos = st.anchorQ % cycleQ;
    const endRaw = startPos + Math.min(periodQ, cycleQ);
    const endPos = endRaw <= cycleQ + 1e-9 ? Math.min(endRaw, cycleQ)
                                           : endRaw % cycleQ;
    // The LOOP TOP: when the loop rests mid-phase its start/end meet
    // mid-lane — mark the spot so the paired grips read as intentional
    // ("loop end ][ loop start"), not noise (field 2026-07-23c).
    const coincident = Math.abs(startPos - endPos) < 1e-6 ||
        Math.abs(Math.abs(startPos - endPos) - cycleQ) < 1e-6;
    if (coincident && startPos > 1e-6 && startPos < cycleQ - 1e-6) {
        const top = document.createElement('div');
        top.className = 'loop-top-chip mono';
        top.textContent = '↺';
        top.title = 'The loop\'s top — its end wraps to its start here';
        top.style.left = pct(startPos, cycleQ);
        o.appendChild(top);
    }
    ['start', 'end'].forEach(edge => {
        const basePos = edge === 'start' ? startPos : endPos;
        const grip = document.createElement('div');
        grip.className = 'win-bracket latent ' + edge + ' trim-grip';
        grip.style.left = coincident
            ? 'calc(' + pct(basePos, cycleQ) +
              (edge === 'start' ? ' + 3px)' : ' - 3px)')
            : pct(basePos, cycleQ);
        grip.title = edge === 'start'
            ? 'Loop START — drag right to trim it in, left to reveal ' +
              'earlier material (whole-Q snap)'
            : 'Loop END — drag left to trim it in, right to reveal ' +
              'later material (whole-Q snap)';
        grip.addEventListener('pointerdown', ev => {
            // EXPANDED DRAG (owner-ruled): the lane opens to the raw
            // take, the excluded material stays visible, and the trim
            // bracket rides an ABSOLUTE raw bound — dragging back over
            // dimmed content restores it (nothing is ever off-screen).
            const bound0 = edge === 'start'
                ? segs[0][0] : segs[segs.length - 1][1];
            runExpandedDrag(ev, o, lane, st, body, bound0, rawQ => {
                const rawBound = rawQ === null
                    ? bound0                       // at-rest render
                    : Math.max(0, Math.min(st.totalQ, rawQ));
                // No snap until the pointer moves — the rest render is
                // the bound as it IS (a free-trimmed fractional bound
                // must not preview a rounded landing it never had).
                const bound = rawQ === null ? rawBound : Math.round(rawBound);
                const next = trimBoundTo(segs, edge, bound, st.totalQ);
                if (next === null) return null;  // refusal: keep previous
                const p = next.length
                    ? next.reduce((n, [a, b]) => n + (b - a), 0)
                    : st.totalQ;
                return { segs: next,
                    // The bracket rides the pointer; the dashed ghost
                    // marks the whole-Q landing.
                    follow: { kind: 'bracket', edge, q: rawBound },
                    active: {
                        q: bound,
                        text: 'loop ' + edge + ' · ' + p + 'Q',
                        incoherent: false,
                        ghost: Math.abs(rawBound - bound) > 0.02,
                    } };
            });
        });
        o.appendChild(grip);
    });
}

/**
 * The heard-time WINDOW/MAP CURSOR — where in its map this lane is
 * sounding right now (the engine publishes the phase on `playhead`).
 * Patched every poll, OUTSIDE the keyed rebuild. SEAM-AWARE (phase 3):
 * the heard phase maps through the SEGMENTS, so over a multi-segment
 * map the cursor JUMPS across cuts instead of gliding through removed
 * time; multi lanes skip the linear animator (its glide assumes a
 * contiguous span) and big jumps snap instead of sweeping.
 */
function patchWinCursor(overlay, lane, vm, cycleQ) {
    const winCursor = overlay.querySelector('.win-cursor');
    const w = lane.window ||
        (lane.mapSegs ? { segs: lane.mapSegs, periodQ: lane.mapChipQ } : null);
    if (!winCursor || !w) return;
    const anchorQ = lane.takeStartQ || 0;
    const lenQ = w.periodQ ?? (w.endQ - w.startQ);
    if (!(lenQ > 0)) return;
    const multi = !!(w.segs && w.segs.length > 1);
    if (anim.running && !multi) {
        // The animator draws this cursor at 60fps (same clock as the
        // playhead); the poll corrects its phase (wrap-aware, ease
        // small errors, snap teleports)
        winCursor._startQ = anchorQ + w.startQ;
        winCursor._lenQ = lenQ;
        winCursor._cycleQ = cycleQ;
        const target = lane.windowPhase || 0;
        if (winCursor._phase === undefined) {
            winCursor._phase = target;
        } else {
            winCursor._phase = correctPosition(winCursor._phase, target, 1, 0.15);
        }
        if (winCursor.style.transition !== 'none') winCursor.style.transition = 'none';
    } else {
        const heardQ = (lane.windowPhase || 0) * lenQ;
        const posQ = anchorQ + (multi
            ? mapOffset({ segs: w.segs }, heardQ)
            : (w.startQ ?? 0) + heardQ);
        // Glides like the playhead; a wrap (phase 1 → 0) must snap
        // back, never sweep backwards through the window — and a SEAM
        // jump must snap forward, never sweep through the cut.
        const frac = posQ / cycleQ;
        const jumpQ = winCursor._pos !== undefined
            ? Math.abs(frac - winCursor._pos) * cycleQ : 0;
        if (winCursor.style.transition === 'none') winCursor.style.transition = '';
        if (winCursor._pos !== undefined &&
            (frac < winCursor._pos - 0.5 * lenQ / cycleQ ||
             (multi && jumpQ > 0.3))) {
            winCursor.style.transition = 'none';
            requestAnimationFrame(() =>
                requestAnimationFrame(() => { winCursor.style.transition = ''; }));
        }
        winCursor._pos = frac;
        winCursor._phase = undefined;
        setStyle(winCursor, 'left', pct(posQ, cycleQ));
    }
    const disp = vm.isPlaying ? '' : 'none';
    if (winCursor.style.display !== disp) winCursor.style.display = disp;
}

/**
 * LATENT window for a lane that has none: full-span brackets
 * (hover-revealed) so a window can be CREATED by dragging an edge in —
 * the same gesture as editing, no separate affordance. Full span is
 * "no window" (windowOf suppresses it), so dragging back out to the
 * full span removes the window — creation and deletion are symmetric.
 * FRACTAL (I5): clips and groups alike — a clip's loop region is the
 * single-segment case of the stack's time-map.
 */
function latentWindow(lane, vm) {
    if (lane.window || lane.recording || !vm.qEstablished) return null;
    // Heard-view windowed lanes edit through the EXPAND view (chip /
    // edge grip) — a latent full-span drag here would reinterpret the
    // collapsed coordinates as raw loop points.
    if (lane.windowChipQ) return null;
    const maxQ = Math.round(lane.intrinsicQ || 0);
    // (The Q-definer never reaches here: its lane always carries a
    // window — the provisional branch builds the selection explicitly.)
    if (maxQ < 2) return null; // a 1Q lane has no sub-window to make
    return { startQ: 0, endQ: maxQ, active: false, bypassed: false, latent: true };
}

/**
 * Dim everything OUTSIDE the window, in EVERY repetition of the lane's
 * period across the cycle — the frame stays intrinsic (displayPeriodQ),
 * so the window reads as a subset of each tile, never as a reframe.
 */
function buildWindowDims(o, win, lane, cycleQ) {
    const intrinsicQ = lane.intrinsicQ || 0;
    if (intrinsicQ <= 0) return;
    const addDim = (fromQ, toQ) => {
        const from = Math.max(0, fromQ);
        const to = Math.min(cycleQ, toQ);
        if (to - from <= 1e-9) return;
        const d = document.createElement('div');
        d.className = 'win-dim';
        d.style.left = pct(from, cycleQ);
        d.style.width = pct(to - from, cycleQ);
        o.appendChild(d);
    };
    // Segment-general (phase 3): dim the COMPLEMENT of the map's
    // covered set. A single window is the one-segment case.
    const segs = win.segs || [[win.startQ, win.endQ]];
    const dimComplement = (baseQ, spanQ) => {
        let prev = 0;
        for (const [s, e] of segs) {
            addDim(baseQ + prev, baseQ + s);
            prev = e;
        }
        addDim(baseQ + prev, baseQ + spanQ);
    };
    const anchorQ = lane.takeStartQ || 0;
    if (lane.kind === 'clip') {
        // Clips render raw material in ONE place — the take tile; every
        // other tile is an audible echo of the window segment and must
        // not be dimmed as "outside the window" (ghosts show what
        // sounds, Q 2026-07-16). Use the RAW intrinsicQ (not rounded):
        // the provisional Q-definer's tile is buffer/selection, a
        // fractional number of Q, so rounding dropped its trailing dim.
        dimComplement(anchorQ, intrinsicQ);
        return;
    }
    // Groups: every tile shows the composite (raw material) — dim the
    // uncovered regions per period tile, on the lane's grid.
    const P = Math.round(intrinsicQ);
    if (P <= 0) return;
    const first = ((anchorQ % P) + P) % P;
    for (let base = first - P; base < cycleQ; base += P) {
        dimComplement(base, P);
    }
}

/* ---------- loop-window interactions (docs/ui_overhaul.md §2) ----------
 *
 * Drag a bracket to edit; click the chip to toggle active/bypassed.
 * TWO-LAYER DRAG FEEDBACK (owner request 2026-07-11, restoring the old
 * handles' feel): the handle itself follows the pointer CONTINUOUSLY
 * (you see your motion), while a dashed snap-ghost bracket + the dims +
 * the chip preview the Q-SNAPPED landing position (you see what a
 * release commits). Release commits the snap via setLoopPoints. During
 * the drag the overlay is frozen (body._winDrag) — replacing the
 * captured bracket node would orphan the gesture.
 */
function wireWindow(o, lane, vm, body, win) {
    // Multi-segment maps have no draggable brackets (phase 3): the
    // cell/punch editor owns their geometry. Bypass still toggles via
    // the map chip (wired in the mapSegs overlay branch).
    if (win.segs && win.segs.length > 1) return;
    // Per-lane scale (law 13 amendment): an editing lane maps through
    // its own frame, not the shared one.
    const laneCycleQ = lane.frameQ || vm.cycleQ;
    const chip = o.querySelector('.win-chip');
    // Fractal (I5): clip and group windows toggle alike — the engine's
    // toggleLoopWindow works on any node since 2026-07-11. The Q-definer's
    // chip is a live readout, not a toggle (there's no window to bypass).
    if (chip && !lane.isQDefiner) {
        chip.classList.add('toggle');
        chip.title = 'Toggle window: active ↔ bypassed (brackets stay editable)';
        chip.addEventListener('click', () => cb.onToggleWindow(lane.id));
    }

    const brackets = {
        start: o.querySelector('.win-bracket.start'),
        end: o.querySelector('.win-bracket.end'),
    };
    const maxQ = Math.round(lane.intrinsicQ || 0);
    if (maxQ < 1) return;
    let cur = { startQ: win.startQ, endQ: win.endQ };
    const dimsLive = (win.active && !win.bypassed) || win.latent;
    // Window Qs are CONTENT-relative; the pointer moves in FRAME Qs.
    // The lane's content-frame origin is its take tile.
    const anchorQ = lane.takeStartQ || 0;

    /** Re-render the SNAPPED preview: ghost bracket, dims, chip badge. */
    const previewSnap = (t, edge, ghost) => {
        cur = t;
        ghost.style.left =
            pct(anchorQ + (edge === 'start' ? t.startQ : t.endQ), laneCycleQ);
        if (chip) {
            chip.style.left = pct(anchorQ + t.endQ, laneCycleQ);
            chip.classList.toggle('at-end', anchorQ + t.endQ >= laneCycleQ);
            setText(chip, lane.isQDefiner
                ? 'Q = ' + ((t.endQ - t.startQ) * vm.quantum / vm.sampleRate).toFixed(2) + 's'
                : (t.endQ - t.startQ) + 'Q window');
        }
        if (dimsLive) {
            o.querySelectorAll('.win-dim').forEach(d => d.remove());
            buildWindowDims(o, t, lane, laneCycleQ);
        }
    };

    ['start', 'end'].forEach(edge => {
        const el = brackets[edge];
        let ghost = null;
        el.addEventListener('pointerdown', e => {
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            body._winDrag = true;
            el.classList.add('dragging');
            // The snap ghost starts AT the handle (same classes → same
            // shape/transform), marking the landing position
            ghost = el.cloneNode(false);
            ghost.classList.remove('dragging', 'latent');
            ghost.classList.add('snap-ghost');
            o.appendChild(ghost);
        });
        el.addEventListener('pointermove', e => {
            if (!body._winDrag || !ghost) return;
            const r = body.getBoundingClientRect();
            // Frame Q under the pointer → content Q for the snap math
            const rawQ =
                ((e.clientX - r.left) / r.width) * laneCycleQ - anchorQ;
            // Q13: the Q-definer drags FREE (sub-Q) — we're DEFINING Q,
            // not snapping to it. The handle position is the landing; a
            // small min length keeps Q positive. Clamp to the RAW
            // fractional buffer extent: the rounded maxQ let the end
            // handle land up to half a Q past the recorded material,
            // making a window (and a Q) longer than the content.
            if (lane.isQDefiner) {
                const minLen = 0.05;
                const extQ = lane.intrinsicQ || 0;
                const t = edge === 'start'
                    ? { startQ: Math.min(Math.max(0, rawQ), cur.endQ - minLen), endQ: cur.endQ }
                    : { startQ: cur.startQ, endQ: Math.max(Math.min(extQ, rawQ), cur.startQ + minLen) };
                el.style.left = pct(anchorQ + (edge === 'start' ? t.startQ : t.endQ), laneCycleQ);
                previewSnap(t, edge, ghost);
                return;
            }
            // The handle tracks the pointer continuously, inside the
            // same bounds the snap enforces (≥1Q window, lane extent)
            const freeQ = edge === 'start'
                ? Math.min(Math.max(0, rawQ), cur.endQ - 1)
                : Math.max(Math.min(maxQ, rawQ), cur.startQ + 1);
            el.style.left = pct(anchorQ + freeQ, laneCycleQ);
            const t = windowDragTarget({ edge, rawQ, ...cur, maxQ });
            if (t.startQ !== cur.startQ || t.endQ !== cur.endQ) {
                previewSnap(t, edge, ghost);
            }
        });
        const end = commit => e => {
            if (!body._winDrag) return;
            body._winDrag = false;
            el.classList.remove('dragging');
            if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
            if (ghost) { ghost.remove(); ghost = null; }
            if (commit) {
                cb.onSetWindow(lane.id,
                    Math.round(cur.startQ * vm.quantum),
                    Math.round(cur.endQ * vm.quantum));
            }
            o._key = ''; // rebuild from settled state on the next patch
        };
        el.addEventListener('pointerup', end(true));
        el.addEventListener('pointercancel', end(false));
    });
}

/** Peaks for a lane: clip peaks from the store; group = composite. */
function lanePeaks(lane, aux) {
    if (lane.kind === 'clip') return aux.livePeaks.get(lane.id);
    const node = aux.nodesById.get(lane.id);
    if (!node || !node.nodes || node.nodes.length === 0) return null;
    const stackDuration = Math.max(
        calculateStackLCM(node.nodes, aux.vmQuantum),
        node.effectiveQuantum || aux.vmQuantum);
    return generateCompositeWaveform({
        stack: node, stackDuration, effectiveQ: aux.vmQuantum,
        canvasWidth: 800, livePeaks: aux.livePeaks, cache: compositeCache,
        excludeIds: aux.pendingFetch,
        epochSamples: aux.epochSamples || 0,
    });
}

/* ---------- selection (view state) ----------
 * Click a rail to select it (⌘/shift-click adds, Escape or a canvas
 * click clears). Selection feeds the two bulk verbs: the floating
 * "Group N tracks" bar, and multi-drag (dragging a selected rail
 * carries the whole selection).
 */
const selection = new Set();

function updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    if (!bar) return;
    const n = selection.size;
    if (n < 2) { bar.classList.remove('open'); return; }
    bar.classList.add('open');
    bar.querySelector('.sel-count').textContent =
        `${n} tracks selected`;
}

function clearSelection() {
    selection.clear();
    document.querySelectorAll('.lane-rail.selected')
        .forEach(el => el.classList.remove('selected'));
    updateSelectionBar();
}

function toggleSelect(row, additive) {
    const id = row._lane.id;
    if (!additive) {
        const wasSole = selection.size === 1 && selection.has(id);
        clearSelection();
        if (wasSole) return;  // plain click on the sole selection clears
        selection.add(id);
    } else if (selection.has(id)) {
        selection.delete(id);
    } else {
        selection.add(id);
    }
    document.querySelectorAll('.lane').forEach(r => {
        const rail = r.querySelector('.lane-rail');
        if (rail && r._lane) {
            rail.classList.toggle('selected', selection.has(r._lane.id));
        }
    });
    updateSelectionBar();
}

/* ---------- rail state ---------- */
function patchRail(row, lane, vm) {
    if (lane.kind === 'add') return; // affordance row: nothing to patch
    if (lane.kind === 'fx') return patchFxRow(row, lane);
    row._lane = lane; // current lane snapshot for click handlers
    {
        const railEl = row.querySelector('.lane-rail');
        if (railEl) railEl.classList.toggle('selected', selection.has(lane.id));
    }
    row.dataset.depth = String(Math.min(lane.depth, 2));
    // Never patch the name over an open rename editor (or its optimistic
    // value — the backend echoes the new name on the next poll anyway)
    if (!row._renaming) setText(row.querySelector('.rail-name'), lane.name);
    const tempoChip = row.querySelector('.tempo-chip');
    if (tempoChip) {
        const show = lane.isQDefiner ? '' : 'none';
        if (tempoChip.style.display !== show) tempoChip.style.display = show;
    }

    const arm = row.querySelector('.arm-btn');
    arm.classList.toggle('recording', lane.recording);
    if (lane.kind === 'group') {
        const g = lane.groupArm;
        arm.classList.toggle('on', g.state === 'all');
        arm.classList.toggle('some', g.state === 'some');
        if (arm.disabled !== (g.armable === 0)) arm.disabled = g.armable === 0;
        setTitle(arm, g.armable === 0
            ? 'Nothing to record: every track has a take (re-recording arrives with takes)'
            : g.state === 'none'
                ? `Record all ${g.armable} empty track${g.armable > 1 ? 's' : ''} (full ones just play)`
                : 'Stop recording');
    } else {
        arm.classList.toggle('on', lane.armed);
        if (arm.disabled !== !lane.armable) arm.disabled = !lane.armable;
        setTitle(arm, !lane.armable
            ? 'Already has a take (re-recording arrives with takes)'
            : lane.recording ? 'Stop recording'
            : lane.armed ? 'Recording starts at the next Q boundary'
                : 'Record into this track');
    }

    // Sub-line: the period only. Status is the red word on the name row.
    const sub = row.querySelector('.rail-sub');
    if (lane.kind === 'group') {
        setText(sub, lane.periodQ > 0 ? fmtQ(lane.periodQ) + 'Q' : 'group');
    } else if (lane.periodQ > 0) {
        setText(sub, fmtQ(lane.periodQ) + 'Q');
    } else {
        setText(sub, lane.recording ? '' : 'empty');
    }

    const status = row.querySelector('.rail-status');
    // "A map is shaping time" (time_maps.md ruling 5): through-map
    // takes carry the ⟲ cue on the recording lane AND the mapping
    // group's rail.
    const mapCue = lane.throughMap ? ' ⟲' + lane.mapPeriodQ + 'Q map' : '';
    setText(status, lane.recording
        ? (lane.awaitingStop ? 'finishing…' : 'recording…') + mapCue
        : lane.kind === 'group'
            ? (lane.mapRecording ? '⟲ map live'
                : lane.groupArm.state !== 'none'
                    ? 'armed ' + (lane.groupArm.state === 'all' ? 'all' : 'some') : '')
            : lane.armed ? 'armed' + mapCue : '');

    const fold = row.querySelector('.fold-btn');
    if (fold) setText(fold, lane.folded ? '▸' : '▾');
    row.querySelector('.mute-btn').classList.toggle('on', lane.muted);
    row.querySelector('.solo-btn').classList.toggle('on', lane.soloed);

    // Delete is refused mid-take by the engine (cancel is the verb), so
    // disable it while recording/armed rather than offer a dead click.
    const del = row.querySelector('.delete-btn');
    if (del) {
        const busy = lane.recording || lane.armed;
        if (del.disabled !== busy) del.disabled = busy;
    }

    const fxBtn = row.querySelector('.fx-btn');
    if (fxBtn) {
        setText(fxBtn, lane.fxCount > 0 ? 'fx·' + lane.fxCount : 'fx');
        fxBtn.classList.toggle('on', lane.fxCount > 0);
    }


    const input = row.querySelector('.input-btn');
    if (input) {
        // −1 = device default (no explicit assignment yet). A stereo
        // pair shows both channels, compact ("3/4" — the rail foot runs
        // at the rail's full width, no room for a prefix).
        const stereo = lane.inputChannelR >= 0;
        setText(input, stereo
            ? ((lane.inputChannel >= 0 ? lane.inputChannel : 0) + 1) +
              '/' + (lane.inputChannelR + 1)
            : lane.inputChannel >= 0 ? 'in ' + (lane.inputChannel + 1) : 'in ·');
        input.title = stereo
            ? 'Recording inputs (stereo pair) — click to choose'
            : 'Recording input — click to choose';
        // The take is being written from its input NOW — switching
        // mid-take is not a thing (the engine reads the channel per block)
        if (input.disabled !== !!lane.recording) input.disabled = !!lane.recording;
    }

    // Pan dial: reflect the engine value unless the user is mid-drag.
    const dial = row.querySelector('.pan-dial');
    if (dial && !dial._hot) setPanDial(dial, lane.pan || 0);
}

/* ---------- playhead animator (idle/playing only) ----------
 *
 * Between 50ms polls the playhead DEAD-RECKONS at the estimated
 * transport velocity and wraps EXACTLY at the audible cycle
 * (vm.loopCycleQ) — the CSS-glide approach lagged the target by the
 * transition time, so the sweep visually wrapped early and restarted
 * past zero (field 2026-07-11). Window cursors ride the same clock
 * (heard time advances at the same rate everywhere). While RECORDING
 * the animator is off and the 140ms glide keeps the playhead in
 * lockstep with the recording bar's edge (law 10) — there is no wrap
 * to touch during a take.
 */
const anim = {
    raf: 0, running: false, posQ: 0, velQperMs: 0,
    loopQ: 0, loopStartQ: 0, cycleQ: 1, timelineW: 0, lastFrame: 0,
    lastPollQ: null, lastPollMs: 0,
};

function animatorPoll(vm, aux) {
    const now = performance.now();
    const nominal = aux.sampleRate > 0 && vm.quantum > 1
        ? aux.sampleRate / vm.quantum / 1000 : 0;
    // The audible loop may not start at frame 0 (Q13 trim view: the
    // playhead loops over the SELECTION, [loopStartQ, loopStartQ +
    // loopCycleQ)). The wrap math (forwardDelta/advance/correct) runs in
    // LOOP coordinates; drawing adds the offset back.
    const relQ = vm.playheadQ - (vm.loopStartQ || 0);
    if (anim.lastPollQ === null) {
        anim.posQ = relQ;
        anim.velQperMs = 0; // ramps up from observation, never assumed
    } else {
        const d = forwardDelta(relQ, anim.lastPollQ, vm.loopCycleQ);
        const { vel, teleport } = estimateVelocity(
            anim.velQperMs, d, now - anim.lastPollMs, nominal);
        anim.velQperMs = vel;
        anim.posQ = teleport ? relQ
            : correctPosition(anim.posQ, relQ, vm.loopCycleQ);
    }
    anim.lastPollQ = relQ;
    anim.lastPollMs = now;
    anim.loopQ = vm.loopCycleQ;
    anim.loopStartQ = vm.loopStartQ || 0;
    anim.cycleQ = vm.cycleQ;
    anim.timelineW = els.ruler.clientWidth;
    if (!anim.running) {
        anim.running = true;
        anim.lastFrame = now;
        anim.raf = requestAnimationFrame(animTick);
    }
}

function stopAnimator() {
    if (!anim.running) return;
    anim.running = false;
    anim.lastPollQ = null;
    cancelAnimationFrame(anim.raf);
}

function animTick(t) {
    if (!anim.running) return;
    const dt = Math.min(t - anim.lastFrame, 100); // hidden-tab clamp
    anim.lastFrame = t;
    anim.posQ = advancePosition(anim.posQ, anim.velQperMs, dt, anim.loopQ);
    const frameQ = anim.loopStartQ + anim.posQ; // loop coords → frame coords
    els.playhead.style.left = (frameQ / anim.cycleQ) * anim.timelineW + 'px';
    els.playhead._left = (frameQ / anim.cycleQ) * anim.timelineW;
    // Window cursors: same clock, own phase, wrap at their own window
    document.querySelectorAll('.win-cursor').forEach(el => {
        if (!(el._lenQ > 0)) return;
        el._phase = advancePosition(el._phase || 0, anim.velQperMs / el._lenQ, dt, 1);
        el.style.left = ((el._startQ + el._phase * el._lenQ) / el._cycleQ) * 100 + '%';
    });
    anim.raf = requestAnimationFrame(animTick);
}

/* ---------- top-level patch ---------- */
export function patchSessionView(vm, aux) {
    lastFrameQ = vm.cycleQ;  // pin source for map gestures (see dragPinQ)
    lastFoldQ = vm.loopCycleQ > 0 ? vm.loopCycleQ : vm.cycleQ;
    // Transport (all writes idempotent — see setText note above)
    setText(els.playBtn, vm.isPlaying ? '⏸' : '▶');
    els.playBtn.classList.toggle('playing', vm.isPlaying);
    const anyRecording = vm.lanes.some(l => l.recording);
    if (vm.provisionalDefiner) {
        // Q13: while trimming the sole clip, Q-units are circular (the
        // loop IS 1Q by definition). Read out the tempo being set — the
        // loop length in seconds — not the full-buffer frame in Q.
        const sr = aux.sampleRate || vm.sampleRate || 44100;
        setText(els.readout, 'loop ' + (vm.quantum / sr).toFixed(2) + ' s · sets tempo');
    } else if (vm.qEstablished) {
        // When windows shorten the audible cycle (E-C) the playhead
        // wraps before the frame end — the readout says why
        const loopNote = !vm.frameExtended && vm.loopCycleQ < vm.lcmQ
            ? ' · loop ' + fmtQ(vm.loopCycleQ) + 'Q' : '';
        setText(els.readout, vm.playheadQ.toFixed(1) + 'Q / ' + fmtQ(vm.cycleQ) + 'Q'
            + (vm.frameExtended ? '…' : ' ↺') + loopNote);
    } else if (anyRecording) {
        // First take: no Q yet — this recording will define it
        const sr = aux.sampleRate || 44100;
        setText(els.readout, (vm.playheadQ * vm.quantum / sr).toFixed(1) + ' s · first take');
    } else {
        setText(els.readout, '—');
    }
    if (aux.sampleRate) {
        setText(els.qInfo,
            'Q = ' + (vm.quantum / aux.sampleRate).toFixed(2) + ' s · ' +
            (aux.sampleRate / 1000) + ' kHz');
    }

    patchRuler(vm);

    // Lanes: keyed reconciliation in VM order
    const seen = new Set();
    let prev = null;
    vm.lanes.forEach(lane => {
        let row = laneEls.get(lane.id);
        if (!row) {
            row = buildLane(lane);
            laneEls.set(lane.id, row);
        }
        if (prev ? row.previousElementSibling !== prev : row !== els.lanes.firstElementChild) {
            els.lanes.insertBefore(row, prev ? prev.nextElementSibling : els.lanes.firstElementChild);
        }
        patchRail(row, lane, vm);
        patchLaneBody(row, lane, vm, aux);
        // Add rows match their sibling lanes' real height by measurement
        if (lane.kind === 'add' && prev) {
            const btn = row.querySelector('.add-track-row-btn');
            const h = prev.getBoundingClientRect().height + 'px';
            if (btn.style.minHeight !== h) btn.style.minHeight = h;
        }
        seen.add(lane.id);
        prev = row;
    });
    laneEls.forEach((row, id) => {
        if (!seen.has(id)) {
            row.remove();
            laneEls.delete(id);
        }
    });

    els.emptyState.style.display = vm.lanes.length ? 'none' : 'block';

    // The one playhead (I8): a single line from the ruler through the
    // last audio lane — never through the add-track affordance below.
    if (vm.isPlaying && vm.lanes.length) {
        els.playhead.style.display = 'block';
        if (!anyRecording && vm.qEstablished) {
            // Idle/playing: the animator draws at 60fps and wraps
            // exactly at the audible cycle; the poll only corrects it
            if (els.playhead.style.transition !== 'none') {
                els.playhead.style.transition = 'none';
            }
            animatorPoll(vm, aux);
        } else {
            stopAnimator();
            if (els.playhead.style.transition === 'none') {
                els.playhead.style.transition = '';
            }
            const timelineW = els.ruler.clientWidth;
            const newLeft = (vm.playheadQ / vm.cycleQ) * timelineW;
            // Recording: glide with the same 140ms linear timing as the
            // recording bar's edge (they move in lockstep, law 10) — a
            // commit jump must snap, not sweep backwards
            const prev = els.playhead._left ?? newLeft;
            if (newLeft < prev - 40) {
                els.playhead.style.transition = 'none';
                requestAnimationFrame(() =>
                    requestAnimationFrame(() => { els.playhead.style.transition = ''; }));
            }
            els.playhead._left = newLeft;
            els.playhead.style.left = newLeft + 'px';
        }
        const audioRows = [...els.lanes.children].filter(r =>
            !r.classList.contains('lane-add') && !r.classList.contains('lane-fx'));
        const last = audioRows[audioRows.length - 1];
        if (last) {
            const h = last.offsetTop + last.offsetHeight;
            const hpx = h + 'px';
            if (els.playhead.style.height !== hpx) els.playhead.style.height = hpx;
        }
        maskPlayheadOverInspectors();
    } else {
        stopAnimator();
        els.playhead.style.display = 'none';
    }
}

/* Suppression of the white playhead over INSPECTOR lanes, made
 * paint-order-independent (field 2026-07-25b): the z-index scheme
 * (.inspecting body z 7 over playhead z 6) relies on the lane painting
 * OPAQUELY above the line, and the webview compositor let the line
 * bleed through in stray frames mid-drag. A vertical mask carves the
 * inspecting lanes' bands out of the line itself — no stacking, no
 * compositor, no bleed. */
function maskPlayheadOverInspectors() {
    const ph = els.playhead;
    const bodies = document.querySelectorAll('.lane-body.inspecting');
    if (!bodies.length) {
        if (ph._masked) {
            ph._masked = false;
            ph.style.webkitMaskImage = '';
            ph.style.maskImage = '';
        }
        return;
    }
    const pr = ph.getBoundingClientRect();
    if (!(pr.height > 0)) return;
    const bands = [...bodies].map(b => b.getBoundingClientRect())
        .map(r => [Math.max(0, (r.top - pr.top) / pr.height * 100),
                   Math.min(100, (r.bottom - pr.top) / pr.height * 100)])
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
    let prevPct = 0;
    const stops = [];
    for (const [a, b] of bands) {
        stops.push('black ' + prevPct + '%, black ' + a + '%, ' +
                   'transparent ' + a + '%, transparent ' + b + '%');
        prevPct = b;
    }
    stops.push('black ' + prevPct + '%, black 100%');
    const img = 'linear-gradient(to bottom, ' + stops.join(', ') + ')';
    if (ph._maskImg !== img) {
        ph._maskImg = img;
        ph._masked = true;
        ph.style.webkitMaskImage = img;
        ph.style.maskImage = img;
    }
}
