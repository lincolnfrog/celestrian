/**
 * CUT BANDS (time_maps.md §4, owner-chosen design A) + the lane-side
 * map gestures: seam handles and trim grips on the heard view, dragged
 * in place at the lane's own scale (THE SAME-SCALE REVEAL, owner-ruled
 * 2026-09-11 — supersedes the expanded map drag and its pointer warp).
 *
 * A cut is a first-class object in the bracket vocabulary: a dim band
 * with two bracket-style handles and a length chip. Double-click the
 * take → a 1Q cut on that Q cell; double-click a cut → it heals; drag
 * the chip → the cut SLIDES freely in position, length held (the
 * "exclude 1Q off the boundary" move); drag a handle → resize, length
 * ALWAYS snapping to whole Qs (the seam theorem is categorical). ⌥ is a
 * MODE key only — ⌥-drag a seam handle resizes instead of sliding, and
 * ⌥ on a trim grip / window bracket free-slides the whole region;
 * neither escapes the whole-Q snap. One gesture = one undo step.
 * Leading/trailing exclusions stay the WINDOW brackets' domain — bands
 * are only the INNER gaps, so the two gestures never overlap.
 *
 * THE REVEAL: cut/trim geometry is RAW-frame data and the heard view
 * is the wrong editing surface (seams have no width, grips wrap) — but
 * squeezing the whole raw take into the lane at grab time (the 2026-07
 * expanded drag) rescaled a 52Q take 13× under the pointer, teleported
 * the cursor, and lost the selection in a field of dims. Now the lane
 * keeps its px-per-Q: on a real drag the lane UNROLLS the raw take at
 * the same scale, positioned so the grabbed thing stays exactly under
 * the pointer — excluded material appears as dims beside the kept
 * region, a cut becomes a real band, nothing rescales, nothing warps.
 * Dragging toward a lane edge PANS the raw take under the hand; the
 * whole-take picture is the region panel below the lane
 * (region_panel.js). Live commits stream (audible); release commits,
 * and the lane relaxes to the heard view in ONE frame once that commit
 * has settled and the heard tiles re-tiled from it (runRawDrag's held
 * picture).
 */

import { ctx } from './context.js';
import { el, pct, setStyle, snapThenAnimate } from './sv_util.js';
import { beginGesture, isDragging } from './gesture.js';
import { selectOnly } from './selection.js';
import { drawEnvelope, mappedColumns, peaksBoost } from '../canvas_renderer.js';
import { innerCuts, applyCut, healCut, cellCutAt, resizeCutTarget,
         slideCutTarget, cutBounds } from '../map_edit.js';
import { mapOffset } from '../time_map.js';
import { posMod } from '../math_utils.js';
import { bandState, coveredSegs, commitBandSegs, newGesture,
         holdUntilSettled, cutChipLabel, makeHealMenu, runRawDrag,
         trimMoveFn, seamMoveFn, viewPct, rawCursorQ,
         LIVE_COMMIT_THROTTLE_MS, CUT_HANDLE_W_PX } from './map_core.js';
import { maskPlayheadOverInspectors } from './playhead_mask.js';
import { makeEdgePanner, canPanView, panViewQ0 } from './edge_pan.js';

/* Seam-heal hit reach: a dblclick within this many px of a seam means
 * HEAL (matching the handle's reach). */
const SEAM_HIT_PX = 12;
/* Seam handle glyph half-width (px offset baked into calc()). */
const SEAM_HANDLE_HALF_PX = 7;
/* Coincident trim grips nudge apart by this much ("loop end ][ loop
 * start"). */
const GRIP_PAIR_NUDGE_PX = 8;
/* Seam chip edge threshold (Q): keep the chip readable at the frame
 * edges. */
const CHIP_EDGE_Q = 0.4;
/* (Reveal autoscroll: edge_pan.js owns the zone + speed constants.) */
/* Waveform vertical inset inside the lane body (lane_body twin). */
const BODY_V_INSET_PX = 6;
/* The tooltip of map chrome the recording gate holds inert. */
const LOCKED_TITLE = 'Loop edits wait until the take finishes';

/** Pointer x → CONTENT Q (raw-take coordinates). On a heard lane the
 * pointer lives in heard time — hop through the map to the RAW
 * position it selects; on a raw-framed lane it's a plain wrap into
 * the take's period. */
function bandContentQ(st, body, clientX) {
    const r = body.getBoundingClientRect();
    const laneQ = ((clientX - r.left) / r.width) * st.cycleQ;
    if (st.heard && st.periodQ > 0) {
        const h = posMod(laneQ - st.anchorQ, st.periodQ);
        return mapOffset({ segs: coveredSegs(st) }, h);
    }
    // RIGHT-EDGE CLAMP: a dblclick ON the take's last pixel gives
    // rel === totalQ, which posMod would wrap to 0 (the FIRST cell).
    // In-range positions clamp; wrapping remains for content resting
    // mid-phase (rel outside [0, totalQ]).
    const rel = laneQ - st.anchorQ;
    if (rel >= 0 && rel <= st.totalQ) return Math.min(rel, st.totalQ - 1e-6);
    return posMod(rel, st.totalQ);
}

/* ---------- THE SAME-SCALE REVEAL ---------- */

/** Draw the reveal layer for `view`: raw-Q gridlines and the visible
 * slice of the raw take's waveform, at the lane's own px-per-Q. */
function drawReveal(layer, body, st, view) {
    const bodyW = body.clientWidth;
    const bodyH = (body.clientHeight - BODY_V_INSET_PX) || 58;
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
    drawEnvelope(canvas, cols, { cssWidth: w, cssHeight: bodyH,
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
function runRevealDrag(ev, o, lane, st, body, anchorQ, onMove) {
    const r0 = body.getBoundingClientRect();
    const pxPerQ = r0.width / st.cycleQ;
    const view = { q0: anchorQ - (ev.clientX - r0.left) / pxPerQ, spanQ: st.cycleQ };
    let layer = null;
    let pending = null;
    // AUTOSCROLL (edge_pan.js — the one direction-aware rule the region
    // panel's drags share): the hand at a visible edge pans the raw
    // take under it. The zone is measured against the VISIBLE lane
    // (the body clipped by the viewport).
    const pan = makeEdgePanner({
        rect: () => {
            const br = body.getBoundingClientRect();
            const sr = ctx.els.session.getBoundingClientRect();
            return { left: Math.max(br.left, sr.left),
                     right: Math.min(br.right, sr.right) };
        },
        grabX: ev.clientX,
        canPan: dir => canPanView(dir, view.q0, view.spanQ, st.totalQ),
        pxPerQ: () => pxPerQ,
        onPan: dq => {
            // Directional clamp: the anchored view may start out of
            // range and must glide, never snap (panViewQ0).
            view.q0 = panViewQ0(view.q0, dq, view.spanQ, st.totalQ);
            if (layer) drawReveal(layer, body, st, view);
            run.reapply();
        },
    });
    const stopPan = pan.stop;
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
        engage: true,
        onEngage: () => {
            clearTimeout(body._flashT);
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
        onRelease: () => {
            stopPan();
        },
        // THE REVEAL OUTLIVES THE POINTER (runRawDrag's held picture):
        // the raw view stays up, the preview at the committed landing
        // over it, until the patch that re-tiles the heard lane from
        // the committed state — then both go in that same frame.
        onTeardown: () => {
            body._reveal = null;
            body.classList.remove('revealing');
            if (layer) { layer.remove(); layer = null; }
            maskPlayheadOverInspectors();
        },
    });
}

/** Per poll (lane_body, before the frozen gate): the amber cursor of
 * a revealing lane — where the sound is in RAW coordinates, mapped
 * through the map as committed so far, positioned in the reveal view. */
export function patchRevealCursor(body, lane, vm, node) {
    const rv = body._reveal;
    if (!rv) return;
    const cur = body.querySelector('.reveal-layer > .reveal-cursor');
    if (!cur) return;
    const show = vm.isPlaying;
    setStyle(cur, 'display', show ? '' : 'none');
    if (!show) return;
    const rawQ = rawCursorQ(lane, vm, node);
    if (rawQ === null) return;
    const frac = (rawQ - rv.view.q0) / rv.view.spanQ;
    if (cur._frac !== undefined && frac < cur._frac - 0.02) snapThenAnimate(cur);
    cur._frac = frac;
    setStyle(cur, 'left', (frac * 100) + '%');
}

/* ---------- creation + the bands ---------- */

/** The once-per-body dblclick wiring: create a cell-snapped 1Q cut on
 * the take; heal the cut under the pointer. Wired ONCE per body
 * element (guarded by `body._bandsWired`); every patch refreshes
 * `body._bandState` so the handler always reads current-frame state —
 * a lane changing views must never leave a stale (wrong-frame) editor
 * behind. Shared by lane bodies and the region panel's strip. */
export function wireBandCreate(body, lane, vm, cycleQ) {
    body._bandState = bandState(lane, vm, cycleQ);
    if (body._bandsWired) return;
    body._bandsWired = true;
    body.addEventListener('dblclick', ev => {
        const st = body._bandState;
        if (!st || !st.editable || st.totalQ < 2) return;
        selectOnly(st.laneId); // editing a track claims it ([ ] target)
        // HEARD lanes: a cut has ZERO width (it IS the splice), so the
        // pointer can never be "inside" it — a dblclick meant to heal
        // would land on adjacent content and cut ANOTHER Q, merging
        // into a doubled cut. Near a seam (±SEAM_HIT_PX, matching the
        // handle's reach) the dblclick means HEAL.
        if (st.heard && st.segs && st.segs.length > 1) {
            const br = body.getBoundingClientRect();
            const periodQ = st.periodQ;
            let acc = 0;
            for (let i = 0; i < st.segs.length - 1; i++) {
                acc += st.segs[i][1] - st.segs[i][0];
                const first = posMod(st.anchorQ + acc, st.cycleQ) % periodQ;
                for (let q = first; q < st.cycleQ; q += periodQ) {
                    const px = br.left + (q / st.cycleQ) * br.width;
                    if (Math.abs(ev.clientX - px) < SEAM_HIT_PX) {
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
        // (The cut lands in raw context on the region panel below the
        // selected lane — the old flash-expand is gone with the
        // expanded drag.)
    });
}

/** The bands themselves, rebuilt per overlay reconcile. On heard-view
 * lanes a cut has ZERO width (it IS the splice), so it renders as a
 * SEAM HANDLE: passive ticks on every rep, one grabbable handle + chip
 * per cut on the take rep — drag slides the cut freely (length held),
 * ⌥-drag resizes (whole-Q snap), double-click heals. Raw-framed hosts
 * (windowless lanes, inspectors, the region panel's strip) get BANDS. */
export function appendCutBands(o, lane, vm, body, cycleQ) {
    const st = bandState(lane, vm, cycleQ);
    if (st.totalQ < 2) return;
    if (st.heard) {
        // Under the recording gate the seams draw INERT: where the cuts
        // are stays visible mid-take; nothing grabs.
        if (st.editable || st.locked) appendSeamHandles(o, lane, st, body, cycleQ);
        return;
    }
    if (!st.editable) return;
    const cuts = innerCuts(st.segs, st.totalQ);
    cuts.forEach(cut => {
        const band = el('div', 'cut-band');
        const chip = el('div', 'cut-chip mono', {
            title: 'Drag to slide the cut (length held) — ' +
                'right-click or double-click heals' });
        const handles = {};
        for (const edge of ['start', 'end']) {
            handles[edge] = el('div', 'cut-handle ' + edge,
                { title: 'Drag to resize — length snaps to whole Qs' });
        }
        const ghost = el('div', 'cut-ghost');
        ghost.style.display = 'none';

        const layout = (a, b, raw) => {
            band.style.left = pct(st.anchorQ + a, cycleQ);
            band.style.width = pct(b - a, cycleQ);
            handles.start.style.left =
                'calc(' + pct(st.anchorQ + (raw && raw.edge === 'start'
                    ? raw.q : a), cycleQ) + ')';
            handles.end.style.left =
                'calc(' + pct(st.anchorQ + (raw && raw.edge === 'end'
                    ? raw.q : b), cycleQ) +
                ' - ' + CUT_HANDLE_W_PX + 'px)';
            chip.style.left = pct(st.anchorQ + (a + b) / 2, cycleQ);
            const label = cutChipLabel(b - a);
            chip.textContent = label.text;
            chip.classList.toggle('incoherent', label.incoherent);
        };
        layout(cut[0], cut[1]);

        // Drag machinery — the bracket pattern: pointer capture, the
        // handle/chip follows the pointer, the ghost previews the snap,
        // release commits ONE setSegments.
        const startDrag = (kind, edge) => ev => {
            let target = null;
            newGesture();  // its first commit is a new undo step
            const g = beginGesture(ev, {
                stop: true,
                claim: lane.id, // grabbing a handle claims the track
                onMove: mv => move(mv),
                onEnd: committed => {
                    // HONOR THE END KIND: live splices streamed while
                    // dragging — a cancel must restore the pre-drag
                    // map, not keep the preview. RETURN the commit:
                    // the gesture runner then holds the frame pin until
                    // it settles (a poll carrying the last LIVE geometry
                    // must not re-seat the frame first — review
                    // 2026-09-23, the 7Q → 6Q → 5Q double settle).
                    let p;
                    if (committed && target) {
                        let next = healCut(st.segs, cut[0], cut[1], st.totalQ);
                        next = applyCut(next, target.inQ, target.outQ, st.totalQ);
                        p = commitBandSegs(st, next, true);
                    } else if (!committed && band._lastLive) {
                        p = commitBandSegs(st,
                            st.segs ? st.segs.map(sg => sg.slice())
                                    : [[0, st.totalQ]], true);
                    }
                    if (p) holdUntilSettled(body, p);
                    return p;
                },
            });
            if (!g.live()) return;  // gesture singleton
            g.freeze(body);
            g.pin();  // freeze the shared frame (see drag_pin.js)
            const q0 = bandContentQ(st, body, ev.clientX);
            // Kept-neighbourhood clamp (cutBounds): the gesture may
            // meet a neighbouring gap only at exact adjacency.
            const [loQ, hiQ] = cutBounds(st.segs, cut, st.totalQ);
            const move = mv => {
                const q = bandContentQ(st, body, mv.clientX);
                if (kind === 'slide') {
                    target = slideCutTarget({
                        cut, rawStartQ: cut[0] + (q - q0),
                        maxQ: st.totalQ, loQ, hiQ });
                    layout(target.inQ, target.outQ);
                    ghost.style.display = 'none';
                } else {
                    target = resizeCutTarget({
                        cut, edge, rawQ: q, maxQ: st.totalQ, loQ, hiQ });
                    layout(target.inQ, target.outQ, { edge, q });
                    ghost.style.display = '';
                    ghost.style.left = pct(st.anchorQ +
                        (edge === 'start' ? target.inQ : target.outQ),
                        cycleQ);
                }
                // LIVE SPLICE (see the seam handles): audible preview
                // while dragging, coalesced undo.
                const now = performance.now();
                if (target && now - (band._lastLive || 0) >
                        LIVE_COMMIT_THROTTLE_MS) {
                    band._lastLive = now;
                    let liveNext = healCut(st.segs, cut[0], cut[1], st.totalQ);
                    liveNext = applyCut(liveNext, target.inQ, target.outQ,
                                        st.totalQ);
                    commitBandSegs(st, liveNext, true);
                }
            };
        };
        chip.addEventListener('pointerdown', startDrag('slide'));
        handles.start.addEventListener('pointerdown', startDrag('resize', 'start'));
        handles.end.addEventListener('pointerdown', startDrag('resize', 'end'));
        // Right-click = heal (see the seam handles): the explicit,
        // timing-proof path.
        const healMenu = makeHealMenu(st, cut);
        [band, chip, handles.start, handles.end].forEach(node =>
            node.addEventListener('contextmenu', healMenu));

        o.append(band, handles.start, handles.end, chip, ghost);
    });
}

/** Seam handles for heard-view lanes (see appendCutBands) — INERT (no
 * gesture, no heal, `.inert`) while the recording gate locks them. */
function appendSeamHandles(o, lane, st, body, cycleQ) {
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
    const periodQ = st.periodQ;
    // A lane position for a heard offset, WRAPPED into the frame (the
    // content may rest mid-phase; an unwrapped seam would land on the
    // frame edge, half-clipped and out of reach).
    const wrapQ = heardQ => posMod(baseQ + heardQ, cycleQ);
    // Passive ticks at every audible splice across the frame.
    for (const s of seams) {
        const first = wrapQ(s.heardQ) % periodQ;
        for (let q = first; q < cycleQ; q += periodQ) {
            if (q < 1e-9 || q > cycleQ - 1e-9) continue;
            const t = el('div', 'map-seam-tick');
            t.style.left = pct(q, cycleQ);
            o.appendChild(t);
        }
    }
    // Grabbable handle + chip, wrapped with the content.
    seams.forEach(seam => {
        const handle = el('div', 'seam-handle' + (inert ? ' inert' : ''), {
            title: inert ? LOCKED_TITLE
                : 'The cut lives here — drag to slide it, ' +
                  '⌥-drag to resize, right-click (or double-click) to heal' });
        const chip = el('div', 'cut-chip mono' + (inert ? ' inert' : ''));
        const layout = (heardQ, cut) => {
            const q = wrapQ(heardQ);
            handle.style.left = 'calc(' + pct(q, cycleQ) +
                ' - ' + SEAM_HANDLE_HALF_PX + 'px)';
            chip.style.left = pct(q, cycleQ);
            // Keep the chip readable at the frame edges.
            chip.style.transform = q < CHIP_EDGE_Q ? 'translate(0, -50%)'
                : q > cycleQ - CHIP_EDGE_Q ? 'translate(-100%, -50%)'
                : 'translate(-50%, -50%)';
            const label = cutChipLabel(cut[1] - cut[0]);
            chip.textContent = '‖ ' + label.text;
            chip.classList.toggle('incoherent', label.incoherent);
        };
        layout(seam.heardQ, seam.cut);
        if (inert) {
            o.append(handle, chip);
            return;
        }

        handle.addEventListener('dblclick', ev => {
            ev.stopPropagation();
            commitBandSegs(st,
                healCut(st.segs, seam.cut[0], seam.cut[1], st.totalQ));
        });
        // Right-click = heal, explicitly (dblclick near a seam is a
        // fiddly target) — this path has no timing to break.
        const healMenu = makeHealMenu(st, seam.cut);
        handle.addEventListener('contextmenu', healMenu);
        chip.addEventListener('contextmenu', healMenu);
        const startDrag = ev => {
            if (isDragging(body)) return;
            selectOnly(lane.id); // grabbing a handle claims the track
            // THE REVEAL: the lane unrolls at its own scale around the
            // seam; the cut is a real band over visible content. Drag
            // slides it (length held), ⌥-drag resizes (whole-Q snap).
            // Anchor by the mode chosen at the grab: a slide carries
            // the cut's start, ⌥-resize carries its end edge.
            const anchor0 = ev.altKey ? seam.cut[1] : seam.cut[0];
            // Kept-neighbourhood clamp (cutBounds): exact adjacency
            // only — a slide/resize can never fractionally overlap a
            // neighbouring gap.
            const [loQ, hiQ] = cutBounds(st.segs, seam.cut, st.totalQ);
            runRevealDrag(ev, o, lane, st, body, anchor0,
                seamMoveFn(st, seam.cut, loQ, hiQ));
        };
        handle.addEventListener('pointerdown', startDrag);
        chip.addEventListener('pointerdown', startDrag);
        o.append(handle, chip);
    });
}

/** Live TRIM handles on a heard-view lane's outer edges (grips DRAG,
 * never open a mode). Dragging inward consumes kept time (whole-Q
 * snap); outward reveals more of the take — at the lane's own scale,
 * the grip glued to the pointer. One setSegments per release — the
 * single-window case delegates to setLoopPoints inside the engine,
 * preserving the existing semantics. While the recording gate locks the
 * lane (bandGate) the grips and the loop-top chip still draw — INERT:
 * no gesture, `.inert` (no hover reveal, no grab cursor). */
export function appendTrimGrips(o, lane, vm, body, cycleQ) {
    const st = bandState(lane, vm, cycleQ);
    if (!(st.editable || st.locked) || st.totalQ < 2) return;
    const inert = !st.editable;
    const segs = coveredSegs(st);
    const periodQ = st.periodQ;
    // The grips hug the CONTENT's heard bounds (the loop may rest
    // mid-phase — its top is the bright tile's start, not the frame
    // edge).
    const startPos = st.anchorQ % cycleQ;
    const endRaw = startPos + Math.min(periodQ, cycleQ);
    const endPos = endRaw <= cycleQ + 1e-9 ? Math.min(endRaw, cycleQ)
                                           : endRaw % cycleQ;
    // The LOOP TOP: when the loop rests mid-phase its start/end meet
    // mid-lane — mark the spot so the paired grips read as intentional
    // ("loop end ][ loop start"), not noise.
    const coincident = Math.abs(startPos - endPos) < 1e-6 ||
        Math.abs(Math.abs(startPos - endPos) - cycleQ) < 1e-6;
    // MID-LANE pair only: at the frame edges the two grips already sit
    // apart (start at 0%, end at 100%) — no nudge, no chip.
    const paired = coincident && startPos > 1e-6 && startPos < cycleQ - 1e-6;
    if (paired) {
        // Named, and visible at rest: a bare ][ pair mid-lane reads as
        // a split the user never made — a loop whose top rests
        // mid-phase must SAY so.
        const top = el('div', 'loop-top-chip mono', {
            textContent: '↺ loop top',
            title: 'The loop\'s top: its END wraps to its START here — the ' +
                'window was performed mid-cycle. Grips: ] end · start [' });
        top.style.left = pct(startPos, cycleQ);
        o.appendChild(top);
    }
    ['start', 'end'].forEach(edge => {
        const basePos = edge === 'start' ? startPos : endPos;
        const grip = el('div', 'win-bracket latent ' + edge + ' trim-grip' +
            (paired ? ' paired' : '') + (inert ? ' inert' : ''));
        grip.style.left = paired
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
            if (isDragging(body)) return;
            selectOnly(lane.id); // grabbing a handle claims the track
            // THE REVEAL: the take unrolls around the grip at the
            // lane's scale; the bracket rides an ABSOLUTE raw bound
            // over visible content — dragging back over dimmed content
            // restores it.
            const bound0 = edge === 'start'
                ? segs[0][0] : segs[segs.length - 1][1];
            runRevealDrag(ev, o, lane, st, body, bound0,
                trimMoveFn(st, segs, edge, bound0));
        });
    });
}
