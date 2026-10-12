/**
 * CUT BANDS (time_maps.md §4) and THE SAME-SCALE REVEAL.
 *
 * A cut is a first-class object in the bracket vocabulary: a dim band
 * with two bracket-style handles and a length chip. Double-click the
 * take → a 1Q cut on that Q cell; double-click a cut → it heals; drag
 * the chip → the cut SLIDES freely, length held; drag a handle → resize,
 * the length ALWAYS snapping to whole Qs (the seam theorem is
 * categorical). Bands are only the INNER gaps — leading/trailing
 * exclusions are the window brackets'. One gesture = one undo step.
 *
 * THE REVEAL: cut/trim geometry is RAW-frame data and a heard lane is
 * the wrong surface to edit it on (a seam has no width, a grip wraps).
 * On a real drag the lane UNROLLS the raw take at its own px-per-Q,
 * placed so the grabbed thing stays exactly under the pointer: excluded
 * material appears as dims beside the kept region, a cut becomes a real
 * band, nothing rescales. Dragging toward a lane edge PANS the raw take
 * under the hand (edge_pan.js). It serves ⇧ on a lane splice (the LENGTH
 * there, splice_handles.js) and a ONE-SHOT lane's edge grips and seam
 * handles — a one-shot's offset IS its placement (Q5), so it has no
 * splice to swap and no ↺ to shift. Live commits stream; after release
 * the lane relaxes to the heard view in ONE frame, once the commit has
 * settled (map_core runMapDrag, the held picture).
 */

import { ctx } from './context.js';
import { el, pct } from './sv_util.js';
import { selectOnly } from './selection.js';
import { drawEnvelope, mappedColumns, peaksBoost } from '../canvas_renderer.js';
import { innerCuts, applyCut, healCut, cellCutAt, cutBounds } from '../map_edit.js';
import { mapOffset } from '../time_map.js';
import { posMod } from '../math_utils.js';
import { bandState, coveredSegs, commitBandSegs, makeHealMenu, runRawDrag,
         viewPct, rawCursorQ, placeCursor, CUT_HANDLE_W_PX, LOCKED_TITLE }
    from './map_core.js';
import { trimMoveFn, seamMoveFn, bandMoveFn, cutChipLabel } from './map_moves.js';
import { spliceSpots } from './splice_spots.js';
import { maskPlayheadOverInspectors } from './playhead_mask.js';
import { makeViewPanner, panViewQ0 } from './edge_pan.js';

/* A dblclick within this many px of a heard seam means HEAL (the
 * handle's reach — the seam itself has no width to hit). */
const SEAM_HIT_PX = 12;
/* Seam handle glyph half-width (px offset baked into calc()). */
const SEAM_HANDLE_HALF_PX = 7;
/* A one-shot's coincident edge grips (it fills its frame from mid-lane)
 * nudge apart by this much, so both stay grabbable. */
const GRIP_PAIR_NUDGE_PX = 8;
/* Seam chip edge threshold (Q): keep the chip readable at the frame
 * edges. */
const CHIP_EDGE_Q = 0.4;

/** How often a heard lane's content sounds: a one-shot's firing cadence,
 * else its own period. Seams and hit tests repeat at this spacing. */
const cadenceQ = st => st.everyQ || st.periodQ;

/** Pointer x → heard offset from the content's top, folded on the cadence.
 * At or past `st.periodQ` the pointer is in a one-shot's rest. */
function heardOffsetAt(st, body, clientX) {
    const r = body.getBoundingClientRect();
    const laneQ = ((clientX - r.left) / r.width) * st.cycleQ;
    return posMod(laneQ - st.anchorQ, cadenceQ(st));
}

/** Pointer x → CONTENT Q (raw-take coordinates). On a heard lane the
 * pointer lives in heard time — hop through the map to the RAW position
 * it selects; on a raw-framed lane it is a plain wrap into the take. */
function bandContentQ(st, body, clientX) {
    const r = body.getBoundingClientRect();
    const laneQ = ((clientX - r.left) / r.width) * st.cycleQ;
    if (st.heard && st.periodQ > 0) {
        // In a one-shot's rest the nearest content is the shot's end.
        const h = Math.min(heardOffsetAt(st, body, clientX), st.periodQ - 1e-6);
        return mapOffset({ segs: coveredSegs(st) }, h);
    }
    // A press ON the take's last pixel gives rel === totalQ, which the
    // wrap would turn into 0 (the FIRST cell): in-range positions clamp;
    // only content resting mid-phase wraps.
    const rel = laneQ - st.anchorQ;
    if (rel >= 0 && rel <= st.totalQ) return Math.min(rel, st.totalQ - 1e-6);
    return posMod(rel, st.totalQ);
}

/* ---------- THE SAME-SCALE REVEAL ---------- */

/** Draw the reveal layer for `view`: raw-Q gridlines and the visible
 * slice of the raw take's waveform, at the lane's own px-per-Q and
 * waveform height (body._waveH). */
function drawReveal(layer, body, st, view) {
    const bodyW = body.clientWidth;
    const a = Math.max(0, view.q0);
    const b = Math.min(st.totalQ, view.q0 + view.spanQ);
    let grid = layer.querySelector('.reveal-grid');
    if (!grid) { grid = el('div', 'reveal-grid'); layer.appendChild(grid); }
    grid.textContent = '';
    for (let q = Math.ceil(a - 1e-9); q <= b + 1e-9; q++) {
        if (q <= 0 || q >= st.totalQ) continue;
        const d = el('div', 'gridline' + (q % 4 === 0 ? ' major' : ''));
        d.style.left = viewPct(q, view);
        grid.appendChild(d);
    }
    let tile = layer.querySelector('.reveal-tile');
    if (!tile) {
        tile = el('div', 'reveal-tile');
        tile.appendChild(document.createElement('canvas'));
        layer.appendChild(tile);
    }
    if (b <= a) { tile.style.display = 'none'; return; }
    tile.style.display = '';
    tile.style.left = viewPct(a, view);
    const cssW = Math.max(2, bodyW * (b - a) / view.spanQ);
    tile.style.width = cssW + 'px';
    const peaks = body._peaks;
    const canvas = tile.firstElementChild;
    if (!peaks || !peaks.length) { canvas.style.display = 'none'; return; }
    canvas.style.display = '';
    const w = Math.round(cssW);
    const key = a + ':' + b + ':' + w + ':' + peaks.length;
    if (tile._rk === key && tile._peaksRef === peaks) return;
    tile._rk = key;
    tile._peaksRef = peaks;
    canvas.style.width = w + 'px';
    const { cols, boost } = revealColumns(peaks, st.totalQ, a, b, w);
    drawEnvelope(canvas, cols, { cssWidth: w, cssHeight: body._waveH,
                                 isComposite: body._isGroup, fixedBoost: boost });
}

/** The reveal tile's columns for raw [a, b) of a `totalQ` take at `cssW`
 * px, and the gain they draw at: sampled through the heard tiles' own
 * sampler (mappedColumns — fractional edges, so the tile sits exactly
 * at `a` and a pan never jumps by a peak), at the WHOLE take's gain
 * (peaksBoost), so grabbing a grip never re-levels the waveform the
 * heard tiles just showed. Pure; exported for the tests. */
export function revealColumns(peaks, totalQ, a, b, cssW) {
    return {
        cols: mappedColumns(peaks, cssW, { src: [[a / totalQ, b / totalQ]] }),
        boost: peaksBoost(peaks),
    };
}

/** The reveal drag: a heard-lane handle grabbed at `anchorQ` (its raw
 * position) drags in raw coordinates at the lane's own scale. The view
 * is placed so the grab pixel IS anchorQ — the handle never leaves the
 * pointer — and pans when the hand reaches a visible edge. */
export function runRevealDrag(ev, o, st, body, anchorQ, onMove) {
    const r0 = body.getBoundingClientRect();
    const pxPerQ = r0.width / st.cycleQ;
    const view = { q0: anchorQ - (ev.clientX - r0.left) / pxPerQ, spanQ: st.cycleQ };
    let layer = null;
    let pending = null;
    const pan = makeViewPanner({
        // The zone is measured against the VISIBLE lane (the body
        // clipped by the session's viewport).
        rect: () => {
            const br = body.getBoundingClientRect();
            const sr = ctx.els.session.getBoundingClientRect();
            return { left: Math.max(br.left, sr.left),
                     right: Math.min(br.right, sr.right) };
        },
        grabX: ev.clientX,
        view: () => view,
        totalQ: st.totalQ,
        pxPerQ: () => pxPerQ,
        onPan: dq => {
            view.q0 = panViewQ0(view.q0, dq, view.spanQ, st.totalQ);
            if (layer) drawReveal(layer, body, st, view);
            run.reapply();
        },
    });
    const run = runRawDrag(ev, o, st, {
        rawQAt: clientX => {
            const r = body.getBoundingClientRect();
            return view.q0 + (clientX - r.left) / pxPerQ;
        },
        view: () => view,
        onMove: (q, alt) => {
            const res = onMove(q, alt);
            if (res) pending = res.segs;
            return res;
        },
        freeze: [body],
        onEngage: () => {
            body.classList.add('revealing');
            layer = el('div', 'body-layer reveal-layer');
            body.insertBefore(layer, o);   // under the overlay's chrome
            layer.appendChild(el('div', 'reveal-cursor'));
            drawReveal(layer, body, st, view);
            body._reveal = { view, st, segs: () => pending };
            // Raw coordinates from this frame on: carve the lane out of
            // the white playhead now, not at the next poll.
            maskPlayheadOverInspectors();
        },
        onPointer: mv => pan.update(mv.clientX),
        onRelease: () => pan.stop(),
        // THE REVEAL OUTLIVES THE POINTER (the held picture): the raw
        // view stays up until the patch that re-tiles the heard lane
        // from the committed state — then both go in that same frame.
        onTeardown: () => {
            body._reveal = null;
            body.classList.remove('revealing');
            if (layer) { layer.remove(); layer = null; }
            maskPlayheadOverInspectors();
        },
    });
}

/** Per poll (lane_body, before the frozen gate): the amber cursor of a
 * revealing lane — where the sound is in RAW coordinates, mapped through
 * the map as committed so far, placed in the reveal view. */
export function patchRevealCursor(body, lane, vm, node) {
    const rv = body._reveal;
    if (!rv) return;
    const cur = body.querySelector('.reveal-layer > .reveal-cursor');
    if (!cur) return;
    const rawQ = vm.isPlaying ? rawCursorQ(lane, vm, node) : null;
    placeCursor(cur, rawQ === null ? null : (rawQ - rv.view.q0) / rv.view.spanQ);
}

/* ---------- creation + the bands ---------- */

/** The once-per-host dblclick wiring: a cell-snapped 1Q cut on the take,
 * or the heal of the cut under (on a heard lane: beside) the pointer.
 * Wired ONCE per element (`_bandsWired`); every patch refreshes
 * `_bandState`, so the handler always reads current-frame state. Shared
 * by lane bodies and the region panel's strip. */
export function wireBandCreate(body, lane, vm, cycleQ) {
    body._bandState = bandState(lane, vm, cycleQ);
    if (body._bandsWired) return;
    body._bandsWired = true;
    body.addEventListener('dblclick', ev => {
        const st = body._bandState;
        if (!st || !st.editable || st.totalQ < 2) return;
        selectOnly(st.laneId);
        // On a HEARD lane a cut has ZERO width (it IS the splice): a
        // dblclick meant to heal lands on adjacent content — and would
        // cut ANOTHER Q beside it. Near a seam it means HEAL.
        if (st.heard && st.segs && st.segs.length > 1) {
            const br = body.getBoundingClientRect();
            const seam = spliceSpots(coveredSegs(st), st.anchorQ, cadenceQ(st), st.cycleQ)
                .find(sp => sp.cut && !sp.end && Math.abs(ev.clientX -
                    (br.left + (sp.x / st.cycleQ) * br.width)) < SEAM_HIT_PX);
            if (seam) {
                commitBandSegs(st, healCut(st.segs, seam.cut[0], seam.cut[1], st.totalQ));
                return;
            }
        }
        // A one-shot's rest holds no content to cut.
        if (st.heard && st.everyQ &&
            heardOffsetAt(st, body, ev.clientX) >= st.periodQ) return;
        const q = bandContentQ(st, body, ev.clientX);
        const cut = innerCuts(st.segs, st.totalQ)
            .find(([a, b]) => q >= a && q < b);
        if (cut) {
            commitBandSegs(st, healCut(st.segs, cut[0], cut[1], st.totalQ));
        } else {
            const [a, b] = cellCutAt(q, st.totalQ);
            commitBandSegs(st, applyCut(st.segs, a, b, st.totalQ));
        }
    });
}

/** The cuts themselves, rebuilt per overlay reconcile. A raw-framed host
 * (a windowless lane, a bypassed map, the comp editor, the region
 * panel's strip) gets BANDS. A heard host — a ONE-SHOT's lane; every
 * other heard lane's cuts are splice handles — gets SEAM HANDLES, drawn
 * INERT under the recording gate. */
export function appendCutBands(o, lane, vm, body, cycleQ) {
    const st = bandState(lane, vm, cycleQ);
    if (st.totalQ < 2) return;
    if (st.heard) {
        if (st.editable || st.locked) appendSeamHandles(o, st, body, cycleQ);
        return;
    }
    if (!st.editable) return;
    // The host frames raw Q `q` at anchorQ + q of its cycleQ.
    const view = { q0: -st.anchorQ, spanQ: cycleQ };
    const cuts = innerCuts(st.segs, st.totalQ);
    cuts.forEach(cut => {
        const [a, b] = cut;
        const band = el('div', 'cut-band');
        band.style.left = viewPct(a, view);
        band.style.width = pct(b - a, cycleQ);
        const label = cutChipLabel(b - a);
        const chip = el('div', 'cut-chip mono' +
            (label.incoherent ? ' incoherent' : ''), {
            textContent: label.text,
            title: 'Drag to slide the cut (length held) — ' +
                'right-click or double-click heals' });
        chip.style.left = viewPct((a + b) / 2, view);
        const handles = {};
        for (const edge of ['start', 'end']) {
            handles[edge] = el('div', 'cut-handle ' + edge,
                { title: 'Drag to resize — length snaps to whole Qs' });
        }
        handles.start.style.left = viewPct(a, view);
        handles.end.style.left =
            'calc(' + viewPct(b, view) + ' - ' + CUT_HANDLE_W_PX + 'px)';

        // `edge` null = the chip's slide; else that handle's resize.
        const startDrag = edge => ev => {
            // The gesture may meet a neighbouring gap only at exact
            // adjacency (cutBounds).
            const [loQ, hiQ] = cutBounds(st.segs, cut, st.totalQ);
            runRawDrag(ev, o, st, {
                rawQAt: x => bandContentQ(st, body, x),
                view: () => view,
                onMove: bandMoveFn(st, cut, edge,
                    bandContentQ(st, body, ev.clientX), loQ, hiQ),
                freeze: [body],
            });
        };
        chip.addEventListener('pointerdown', startDrag(null));
        handles.start.addEventListener('pointerdown', startDrag('start'));
        handles.end.addEventListener('pointerdown', startDrag('end'));
        const healMenu = makeHealMenu(st, cut);
        [chip, handles.start, handles.end].forEach(node =>
            node.addEventListener('contextmenu', healMenu));

        o.append(band, handles.start, handles.end, chip);
    });
}

/** A heard lane's SEAM HANDLES (see appendCutBands): passive ticks at
 * every audible splice, and per cut one grabbable handle + length chip
 * on the take rep — drag slides the cut freely (length held), ⌥-drag
 * resizes (whole-Q snap), double-click or right-click heals. INERT (no
 * gesture, no heal, `.inert`) while the recording gate locks them. */
function appendSeamHandles(o, st, body, cycleQ) {
    const segs = coveredSegs(st);
    if (segs.length < 2) return;  // no inner cuts, no seams
    const inert = !st.editable;
    // Heard position of each join + the raw cut behind it.
    const seams = [];
    let acc = 0;
    for (let i = 0; i < segs.length - 1; i++) {
        acc += segs[i][1] - segs[i][0];
        seams.push({ heardQ: acc, cut: [segs[i][1], segs[i + 1][0]] });
    }
    const baseQ = st.anchorQ;
    // A lane position for a heard offset, WRAPPED into the frame (the
    // content may rest mid-phase; an unwrapped seam would land on the
    // frame edge, half-clipped and out of reach).
    const wrapQ = heardQ => posMod(baseQ + heardQ, cycleQ);
    // Passive ticks at every heard seam across the frame (not on its
    // edges).
    for (const sp of spliceSpots(segs, baseQ, cadenceQ(st), cycleQ)) {
        if (!sp.cut || sp.end || sp.x < 1e-9) continue;
        const t = el('div', 'map-seam-tick');
        t.style.left = pct(sp.x, cycleQ);
        o.appendChild(t);
    }
    seams.forEach(seam => {
        const handle = el('div', 'seam-handle' + (inert ? ' inert' : ''), {
            title: inert ? LOCKED_TITLE
                : 'The cut lives here — drag to slide it, ' +
                  '⌥-drag to resize, right-click (or double-click) to heal' });
        const chip = el('div', 'cut-chip mono' + (inert ? ' inert' : ''));
        const q = wrapQ(seam.heardQ);
        handle.style.left = 'calc(' + pct(q, cycleQ) +
            ' - ' + SEAM_HANDLE_HALF_PX + 'px)';
        chip.style.left = pct(q, cycleQ);
        chip.style.transform = q < CHIP_EDGE_Q ? 'translate(0, -50%)'
            : q > cycleQ - CHIP_EDGE_Q ? 'translate(-100%, -50%)'
            : 'translate(-50%, -50%)';
        const label = cutChipLabel(seam.cut[1] - seam.cut[0]);
        chip.textContent = '‖ ' + label.text;
        chip.classList.toggle('incoherent', label.incoherent);
        o.append(handle, chip);
        if (inert) return;

        handle.addEventListener('dblclick', ev => {
            ev.stopPropagation();
            commitBandSegs(st,
                healCut(st.segs, seam.cut[0], seam.cut[1], st.totalQ));
        });
        const healMenu = makeHealMenu(st, seam.cut);
        handle.addEventListener('contextmenu', healMenu);
        chip.addEventListener('contextmenu', healMenu);
        const startDrag = ev => {
            // The reveal unrolls around the seam, the cut a real band
            // over visible content. Anchored by the mode chosen at the
            // grab: a slide carries the cut's start, ⌥-resize its end.
            const anchor0 = ev.altKey ? seam.cut[1] : seam.cut[0];
            const [loQ, hiQ] = cutBounds(st.segs, seam.cut, st.totalQ);
            runRevealDrag(ev, o, st, body, anchor0,
                seamMoveFn(st, seam.cut, loQ, hiQ));
        };
        handle.addEventListener('pointerdown', startDrag);
        chip.addEventListener('pointerdown', startDrag);
    });
}

/** A ONE-SHOT heard lane's TRIM handles on its outer edges. Dragging
 * inward consumes kept time (whole-Q snap); outward reveals more of the
 * take — at the lane's own scale, the grip glued to the pointer (the
 * reveal); ⌥ slides the loop, length held. Live commits stream under
 * one undo step. Under the recording gate the grips still draw — INERT:
 * no gesture, `.inert`. */
export function appendTrimGrips(o, lane, vm, body, cycleQ) {
    const st = bandState(lane, vm, cycleQ);
    if (!(st.editable || st.locked) || st.totalQ < 2) return;
    const inert = !st.editable;
    const segs = coveredSegs(st);
    const periodQ = st.periodQ;
    // The grips hug the CONTENT's heard bounds (the shot may rest
    // mid-phase: its top is the bright tile's start, not the frame edge).
    const startPos = st.anchorQ % cycleQ;
    const endRaw = startPos + Math.min(periodQ, cycleQ);
    const endPos = endRaw <= cycleQ + 1e-9 ? Math.min(endRaw, cycleQ)
                                           : endRaw % cycleQ;
    // A shot that fills its frame from mid-lane meets itself there:
    // nudge the grips apart so the end cannot hide behind the start.
    const coincident = (Math.abs(startPos - endPos) < 1e-6 ||
        Math.abs(Math.abs(startPos - endPos) - cycleQ) < 1e-6) &&
        startPos > 1e-6 && startPos < cycleQ - 1e-6;
    ['start', 'end'].forEach(edge => {
        const basePos = edge === 'start' ? startPos : endPos;
        const grip = el('div', 'win-bracket latent ' + edge + ' trim-grip' +
            (inert ? ' inert' : ''));
        grip.style.left = coincident
            ? 'calc(' + pct(basePos, cycleQ) +
              (edge === 'start' ? ' + ' + GRIP_PAIR_NUDGE_PX + 'px)'
                                : ' - ' + GRIP_PAIR_NUDGE_PX + 'px)')
            : pct(basePos, cycleQ);
        grip.title = inert ? LOCKED_TITLE : (edge === 'start'
            ? 'Loop START — drag right to trim it in, left to reveal ' +
              'earlier material (whole-Q snap)'
            : 'Loop END — drag left to trim it in, right to reveal ' +
              'later material (whole-Q snap)') +
            ' · ⌥-drag SLIDES the loop by any amount (length held)';
        o.appendChild(grip);
        if (inert) return;
        grip.addEventListener('pointerdown', ev => {
            // The bracket rides an ABSOLUTE raw bound over visible
            // content: dragging back over dimmed content restores it.
            const bound0 = edge === 'start'
                ? segs[0][0] : segs[segs.length - 1][1];
            runRevealDrag(ev, o, st, body, bound0,
                trimMoveFn(st, segs, edge, bound0));
        });
    });
}
