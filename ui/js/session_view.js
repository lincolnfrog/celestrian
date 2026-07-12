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
import {
    forwardDelta, estimateVelocity, advancePosition, correctPosition,
} from './playhead_clock.js';

const pct = (q, cycleQ) => (q / cycleQ) * 100 + '%';

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
        recordBtn: document.getElementById('record-btn'),
        readout: document.getElementById('position-readout'),
        qInfo: document.getElementById('q-info'),
        ruler: document.getElementById('ruler'),
        lanes: document.getElementById('lanes'),
        playhead: document.getElementById('playhead'),
        emptyState: document.getElementById('empty-state'),
        gridArea: document.getElementById('grid-area'),
    };
    els.playBtn.addEventListener('click', () => cb.onTogglePlay());
    // Global record = group record over the island (Q7): records every
    // armable (empty) track; full ones just play. With nothing armable
    // it creates a fresh track and records into it.
    els.recordBtn.addEventListener('click', () => cb.onRecord());
    document.getElementById('add-stack-btn')
        .addEventListener('click', () => cb.onAddStack());

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
                ? vm.cycleQ + 'Q' + (vm.frameExtended ? '…' : ' ↺')
                : t.q + 'Q';
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
    rail.appendChild(head);

    const foot = document.createElement('div');
    foot.className = 'rail-foot';
    const sub = document.createElement('div');
    sub.className = 'rail-sub mono';
    foot.appendChild(sub);

    // Arm/record: on clips it starts/stops the take; on groups it arms
    // every ARMABLE child (Q7 — arm targets emptiness). State is set in
    // patchRail; the click hands the current lane back to app.js.
    const arm = document.createElement('button');
    arm.className = 'rail-btn arm-btn';
    arm.textContent = '●';
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

/** Redraw a rep canvas only when its peaks identity/length/size changed. */
function drawRepCanvas(div, peaks, cssWidth, cssHeight, isComposite, live, pxPerSlot) {
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
        Math.round((pxPerSlot || 0) * 1000);
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
        drawWaveform(canvas, peaks, { cssWidth, cssHeight, isComposite });
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
    if (lane.kind === 'add') return;
    const body = row.querySelector('.lane-body');
    const cycleQ = vm.cycleQ;
    const { grid, reps: repsL, overlay } = layersOf(body);
    const peaks = lanePeaks(lane, aux);
    const bodyW = body.clientWidth;
    const bodyH = body.clientHeight - 6 || 58;

    // State classes (idempotent via classList.toggle)
    body.classList.toggle('win-bypassed', !!(lane.window && lane.window.bypassed));
    body.classList.toggle('is-recording', !!lane.recording);
    body.classList.toggle('armed-empty',
        lane.kind === 'clip' && !lane.recording && lane.reps.length === 0 && lane.armed);

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
        const cls = 'rep' + (rep.ghost ? ' ghost' : '') + (rep.bar ? ' recording-bar' : '');
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
            lane.kind === 'group', !!rep.bar, pxPerSlot);

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
    const win = lane.window || latentWindow(lane, vm);
    const overlayKey = JSON.stringify([win, armedEmpty && armQ, cycleQ]);
    if (body._winDrag) return;

    // The heard-time WINDOW CURSOR: where in its window this lane is
    // sounding right now (the engine publishes the window phase on
    // `playhead`). The island playhead sweeps ISLAND time — under an
    // active window the lane hears MAPPED time, and without this cursor
    // the loop looked dead ("the loop window doesn't work anymore",
    // field 2026-07-11). Patched every poll, OUTSIDE the keyed rebuild.
    const winCursor = overlay.querySelector('.win-cursor');
    if (winCursor && lane.window) {
        const w = lane.window;
        const lenQ = w.endQ - w.startQ;
        if (anim.running) {
            // The animator draws this cursor at 60fps (same clock as
            // the playhead); the poll corrects its phase (wrap-aware,
            // ease small errors, snap teleports)
            winCursor._startQ = w.startQ;
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
            const posQ = w.startQ + (lane.windowPhase || 0) * lenQ;
            // Glides like the playhead; a wrap (phase 1 → 0) must snap
            // back, never sweep backwards through the window
            const frac = posQ / cycleQ;
            if (winCursor.style.transition === 'none') winCursor.style.transition = '';
            if (winCursor._pos !== undefined &&
                frac < winCursor._pos - 0.5 * lenQ / cycleQ) {
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

    reconcileMarkers(overlay, overlayKey, o => {
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
            const latentCls = latent ? ' latent' : '';
            const b1 = document.createElement('div');
            b1.className = 'win-bracket start' + latentCls;
            b1.style.left = pct(startQ, cycleQ);
            const b2 = document.createElement('div');
            b2.className = 'win-bracket end' + latentCls;
            b2.style.left = pct(endQ, cycleQ);
            o.append(b1, b2);
            if (!latent) {
                const chip = document.createElement('div');
                // A window ending AT the display cycle would put the
                // chip past the lane's overflow clip — align it inward
                chip.className = 'win-chip' + (endQ >= cycleQ ? ' at-end' : '');
                chip.style.left = pct(endQ, cycleQ);
                chip.textContent = bypassed ? 'window · bypassed' : active ? 'window · active' : 'window';
                o.appendChild(chip);
                if (active && !bypassed) {
                    // Heard-time cursor: positioned per poll below
                    const cur = document.createElement('div');
                    cur.className = 'win-cursor';
                    o.appendChild(cur);
                }
            }
            wireWindow(o, lane, vm, body, win);
        }
    });
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
    const maxQ = Math.round(lane.intrinsicQ || 0);
    if (maxQ < 2) return null; // a 1Q lane has no sub-window to make
    return { startQ: 0, endQ: maxQ, active: false, bypassed: false, latent: true };
}

/**
 * Dim everything OUTSIDE the window, in EVERY repetition of the lane's
 * period across the cycle — the frame stays intrinsic (displayPeriodQ),
 * so the window reads as a subset of each tile, never as a reframe.
 */
function buildWindowDims(o, win, lane, cycleQ) {
    const P = Math.round(lane.intrinsicQ || 0);
    if (P <= 0) return;
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
    for (let base = 0; base < cycleQ; base += P) {
        addDim(base, base + win.startQ);
        addDim(base + win.endQ, base + P);
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
    const chip = o.querySelector('.win-chip');
    // Fractal (I5): clip and group windows toggle alike — the engine's
    // toggleLoopWindow works on any node since 2026-07-11
    if (chip) {
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

    /** Re-render the SNAPPED preview: ghost bracket, dims, chip badge. */
    const previewSnap = (t, edge, ghost) => {
        cur = t;
        ghost.style.left = pct(edge === 'start' ? t.startQ : t.endQ, vm.cycleQ);
        if (chip) {
            chip.style.left = pct(t.endQ, vm.cycleQ);
            chip.classList.toggle('at-end', t.endQ >= vm.cycleQ);
            setText(chip, (t.endQ - t.startQ) + 'Q window');
        }
        if (dimsLive) {
            o.querySelectorAll('.win-dim').forEach(d => d.remove());
            buildWindowDims(o, t, lane, vm.cycleQ);
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
            const rawQ = ((e.clientX - r.left) / r.width) * vm.cycleQ;
            // The handle tracks the pointer continuously, inside the
            // same bounds the snap enforces (≥1Q window, lane extent)
            const freeQ = edge === 'start'
                ? Math.min(Math.max(0, rawQ), cur.endQ - 1)
                : Math.max(Math.min(maxQ, rawQ), cur.startQ + 1);
            el.style.left = pct(freeQ, vm.cycleQ);
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
    });
}

/* ---------- rail state ---------- */
function patchRail(row, lane) {
    if (lane.kind === 'add') return; // affordance row: nothing to patch
    row._lane = lane; // current lane snapshot for click handlers
    row.dataset.depth = String(Math.min(lane.depth, 2));
    // Never patch the name over an open rename editor (or its optimistic
    // value — the backend echoes the new name on the next poll anyway)
    if (!row._renaming) setText(row.querySelector('.rail-name'), lane.name);

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
            : lane.armed || lane.recording ? 'Stop recording'
                : 'Record into this track');
    }

    // Sub-line: the period only. Status is the red word on the name row.
    const sub = row.querySelector('.rail-sub');
    if (lane.kind === 'group') {
        setText(sub, lane.periodQ > 0 ? lane.periodQ + 'Q' : 'group');
    } else if (lane.periodQ > 0) {
        setText(sub, lane.periodQ + 'Q');
    } else {
        setText(sub, lane.recording ? '' : 'empty');
    }

    const status = row.querySelector('.rail-status');
    setText(status, lane.recording
        ? (lane.awaitingStop ? 'finishing…' : 'recording…')
        : lane.kind === 'group'
            ? (lane.groupArm.state !== 'none'
                ? 'armed ' + (lane.groupArm.state === 'all' ? 'all' : 'some') : '')
            : lane.armed ? 'armed' : '');

    const fold = row.querySelector('.fold-btn');
    if (fold) setText(fold, lane.folded ? '▸' : '▾');
    row.querySelector('.mute-btn').classList.toggle('on', lane.muted);
    row.querySelector('.solo-btn').classList.toggle('on', lane.soloed);

    const input = row.querySelector('.input-btn');
    if (input) {
        // −1 = device default (no explicit assignment yet)
        setText(input, lane.inputChannel >= 0 ? 'in ' + (lane.inputChannel + 1) : 'in ·');
        // The take is being written from its input NOW — switching
        // mid-take is not a thing (the engine reads the channel per block)
        if (input.disabled !== !!lane.recording) input.disabled = !!lane.recording;
    }
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
    loopQ: 0, cycleQ: 1, timelineW: 0, lastFrame: 0,
    lastPollQ: null, lastPollMs: 0,
};

function animatorPoll(vm, aux) {
    const now = performance.now();
    const nominal = aux.sampleRate > 0 && vm.quantum > 1
        ? aux.sampleRate / vm.quantum / 1000 : 0;
    if (anim.lastPollQ === null) {
        anim.posQ = vm.playheadQ;
        anim.velQperMs = 0; // ramps up from observation, never assumed
    } else {
        const d = forwardDelta(vm.playheadQ, anim.lastPollQ, vm.loopCycleQ);
        const { vel, teleport } = estimateVelocity(
            anim.velQperMs, d, now - anim.lastPollMs, nominal);
        anim.velQperMs = vel;
        anim.posQ = teleport ? vm.playheadQ
            : correctPosition(anim.posQ, vm.playheadQ, vm.loopCycleQ);
    }
    anim.lastPollQ = vm.playheadQ;
    anim.lastPollMs = now;
    anim.loopQ = vm.loopCycleQ;
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
    els.playhead.style.left = (anim.posQ / anim.cycleQ) * anim.timelineW + 'px';
    els.playhead._left = (anim.posQ / anim.cycleQ) * anim.timelineW;
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
    // Transport (all writes idempotent — see setText note above)
    setText(els.playBtn, vm.isPlaying ? '⏸' : '▶');
    els.playBtn.classList.toggle('playing', vm.isPlaying);
    const anyRecording = vm.lanes.some(l => l.recording);
    const anyArmed = vm.lanes.some(l => l.armed && !l.recording);
    els.recordBtn.classList.toggle('recording', anyRecording);
    els.recordBtn.classList.toggle('armed', anyArmed);
    setTitle(els.recordBtn, anyRecording ? 'Stop recording'
        : anyArmed ? 'Recording starts at the next Q boundary'
            : 'Record every empty track (or a new one)');
    if (vm.qEstablished) {
        // When windows shorten the audible cycle (E-C) the playhead
        // wraps before the frame end — the readout says why
        const loopNote = !vm.frameExtended && vm.loopCycleQ < vm.lcmQ
            ? ' · loop ' + vm.loopCycleQ + 'Q' : '';
        setText(els.readout, vm.playheadQ.toFixed(1) + 'Q / ' + vm.cycleQ + 'Q'
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
        patchRail(row, lane);
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
        const audioRows = [...els.lanes.children].filter(r => !r.classList.contains('lane-add'));
        const last = audioRows[audioRows.length - 1];
        if (last) {
            const h = last.offsetTop + last.offsetHeight;
            const hpx = h + 'px';
            if (els.playhead.style.height !== hpx) els.playhead.style.height = hpx;
        }
    } else {
        stopAnimator();
        els.playhead.style.display = 'none';
    }
}
