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

    // Overlay layer: window brackets + arm marker (small, cheap rebuild)
    const armedEmpty = (lane.kind === 'clip' && !lane.recording &&
        lane.reps.length === 0 && lane.armed) || (lane.recording && lane.pendingStart);
    const armQ = vm.armAtQ % cycleQ;
    const overlayKey = JSON.stringify([lane.window, armedEmpty && armQ, cycleQ]);
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
        if (lane.window) {
            const { startQ, endQ, active, bypassed } = lane.window;
            if (active && !bypassed) {
                const dimL = document.createElement('div');
                dimL.className = 'win-dim';
                dimL.style.left = '0';
                dimL.style.width = pct(startQ, cycleQ);
                const dimR = document.createElement('div');
                dimR.className = 'win-dim';
                dimR.style.left = pct(endQ, cycleQ);
                dimR.style.width = pct(cycleQ - endQ, cycleQ);
                o.append(dimL, dimR);
            }
            const b1 = document.createElement('div');
            b1.className = 'win-bracket start';
            b1.style.left = pct(startQ, cycleQ);
            const b2 = document.createElement('div');
            b2.className = 'win-bracket end';
            b2.style.left = pct(endQ, cycleQ);
            const chip = document.createElement('div');
            chip.className = 'win-chip';
            chip.style.left = pct(endQ, cycleQ);
            chip.textContent = bypassed ? 'window · bypassed' : active ? 'window · active' : 'window';
            o.append(b1, b2, chip);
        }
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
    setText(row.querySelector('.rail-name'), lane.name);

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
        setText(els.readout, vm.playheadQ.toFixed(1) + 'Q / ' + vm.cycleQ + 'Q'
            + (vm.frameExtended ? '…' : ' ↺'));
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
        const timelineW = els.ruler.clientWidth;
        const newLeft = (vm.playheadQ / vm.cycleQ) * timelineW;
        // The playhead glides with the same 140ms linear timing as the
        // recording bar's edge (they move in lockstep) — but a loop wrap
        // or commit jump must snap, not sweep backwards
        const prev = els.playhead._left ?? newLeft;
        if (newLeft < prev - 40) {
            els.playhead.style.transition = 'none';
            requestAnimationFrame(() =>
                requestAnimationFrame(() => { els.playhead.style.transition = ''; }));
        }
        els.playhead._left = newLeft;
        els.playhead.style.left = newLeft + 'px';
        const audioRows = [...els.lanes.children].filter(r => !r.classList.contains('lane-add'));
        const last = audioRows[audioRows.length - 1];
        if (last) {
            const h = last.offsetTop + last.offsetHeight;
            const hpx = h + 'px';
            if (els.playhead.style.height !== hpx) els.playhead.style.height = hpx;
        }
    } else {
        els.playhead.style.display = 'none';
    }
}
