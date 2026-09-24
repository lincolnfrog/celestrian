/**
 * HEARD TILES DON'T LURCH OR BREATHE (loop-region phase 1, 2026-09-23;
 * field video "flashing waveforms", flash-chrome F2 / seam-model SM-7).
 *
 * THE INVARIANT (the owner's regression gate): by the anchoring law a
 * map SLIDE — the region moved with its length held — changes what
 * sounds only in the strip each seam sweeps over, on every repeat. The
 * lane must draw exactly that: every heard-tile column outside the
 * swept sliver(s) is unchanged. The old renderer sliced srcSegs at
 * whole peaks, rotated by a rounded peak count and refit the result to
 * the tile, so a −0.15Q slide jittered features all across the lane
 * (probe i_panel_jitter: ±8 px far from the seam), and each canvas
 * normalized to its own loudest peak, so a loud hit entering the loop
 * rescaled the whole tile (probe g_norm: −45 % height).
 *
 * Everything here runs the REAL deriveViewModel for srcSegs /
 * srcTopFrac / periodQ and the renderer's own column path
 * (lane_body.heardTileColumns → canvas_renderer.mappedColumns).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stubs: gesture.js's beginGesture (the live-gesture probe
// below) touches window/document; everything else is pure.
globalThis.window = globalThis.window || {
    addEventListener() {}, removeEventListener() {},
};
globalThis.document = globalThis.document || {
    activeElement: null, getElementById() { return null; },
    querySelectorAll() { return []; },
};

const { deriveViewModel } = await import('../view_model.js');
const { mapOffset } = await import('../time_map.js');
const { posMod } = await import('../math_utils.js');
const { slideSegs } = await import('../map_edit.js');
const { poolColumns, mappedColumns, peaksBoost, shapeColumns, envelopeBoost,
        canvasCssSize } = await import('../canvas_renderer.js');
const { sliceNotesToTile } = await import('../midi_notes.js');
const { heardTileColumns, tileMap, tileSpan, tileCssWidth, mapEditInFlight,
        retireSurplusTiles, wantsCrossfade } =
    await import('../session_view/lane_body.js');
const { holdOverlay, releaseOverlay, beginGesture } =
    await import('../session_view/gesture.js');
const { revealColumns } = await import('../session_view/map_bands.js');
const { pinFrame, unpinFrame, noteFrame } =
    await import('../session_view/drag_pin.js');

/* ------------------------------ scenes ------------------------------ */

const Q = 1000;
const OPTS = { fxOpen: new Set() };
/* "Unchanged": within a millionth of full scale — the pooled columns
 * are Float32 and the same raw position computed before and after a
 * slide differs in the last bits; one pixel of a 60 px lane is ~0.04. */
const TOL = 1e-6;

const clip = (id, origin, durQ, extra = {}) => ({
    id, name: id, type: 'clip', duration: durQ * Q, origin,
    effectiveQuantum: Q, isRecording: false, isPlaying: true,
    isMuted: false, isSoloed: false, loopStart: 0, loopEnd: 0,
    windowActive: false, loopBypassed: false, periodSource: 'own',
    playhead: 0, ...extra,
});
const island = nodes => ({
    id: 'root', type: 'stack', quantum: Q, islandZero: 0,
    isPlaying: true, masterPos: 0, islandPos: 0, nodes,
});
/** A windowed clip (single segment) or a mapped one (flat segments),
 * on whole samples as the engine publishes them. */
const S = q => Math.round(q * Q);
const windowed = (segsQ) => segsQ.length === 1
    ? { windowActive: true, loopStart: S(segsQ[0][0]), loopEnd: S(segsQ[0][1]) }
    : { windowActive: true, segments: segsQ.flat().map(S) };

/** Deterministic, feature-rich pseudo-audio: every peak distinct, so
 * any shift of the mapping shows as a changed column. */
function makePeaks(n, seed = 11, { lo = 0.05, hi = 0.9 } = {}) {
    const out = new Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) {
        s = (s * 48271) % 2147483647;
        out[i] = lo + (hi - lo) * (0.5 + 0.5 * Math.sin(i * 0.61 + (s % 997) / 97));
    }
    return out;
}

const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);

/** Derive a scene; `pin` holds the frame + zero the way a live map
 * gesture does (drag_pin → app.js → deriveViewModel). */
function derive(nodes, pin = null) {
    return deriveViewModel(island(nodes), pin
        ? { ...OPTS, pinFrameQ: pin.cycleQ, pinFoldQ: pin.loopCycleQ,
            pinZero: pin.frameZero }
        : OPTS);
}

/* A tile narrower than this is float noise of the view model's period
 * (win.periodQ = endQ − startQ in Q: 10.37 − 6.37 = 3.9999999999999991
 * leaves a [3.999999999999999, 4) tile) — invisible (.rep clips its
 * canvas), so the gate skips it. */
const NOISE_TILE_Q = 1e-9;

/** One lane's heard tiles as the renderer samples them. */
function laneTiles(vm, id, peaks, pxPerQ, sampler = heardTileColumns) {
    const lane = laneOf(vm, id);
    const bodyW = vm.cycleQ * pxPerQ;
    return lane.reps.filter(r => r.srcSegs &&
                            r.endQ - r.startQ > NOISE_TILE_Q).map(rep => {
        const cssW = canvasCssSize({}, {
            cssWidth: tileCssWidth(bodyW, rep, vm.cycleQ) }).cssW;
        return { rep, cssW, span: tileSpan(rep, lane.periodQ),
                 cols: sampler(peaks, rep, lane.periodQ, cssW) };
    });
}

/** The heard seams of a map-carrying rep, as PERIOD PHASES: the join
 * after each segment (the last one is the loop top). */
function seamPhases(rep) {
    const total = rep.srcSegs.reduce((n, [a, b]) => n + (b - a), 0);
    let acc = 0;
    return rep.srcSegs.map(([a, b]) => {
        acc += b - a;
        return posMod((rep.srcTopFrac || 0) + acc / total, 1);
    });
}

/** The swept slivers between each seam's old and new position (period
 * phases, the short way round), from the EDITED map's reps. */
function sweptSlivers(before, after) {
    const s0 = seamPhases(before);
    const s1 = seamPhases(after);
    assert.equal(s0.length, s1.length, 'a slide keeps the segment count');
    return s0.map((p, j) => {
        const d = posMod(s1[j] - p + 0.5, 1) - 0.5;
        return [p + Math.min(0, d), p + Math.max(0, d)];
    }).filter(([a, b]) => b - a > 1e-12);
}

/** Does column x of a tile (its period-phase span) touch a sliver on
 * any repeat? `dilate` widens by whole columns (the 3-point smoothing
 * re-shades one neighbour each side). */
function columnSwept(x, cssW, span, slivers, dilate = 0) {
    const du = (span.u1 - span.u0) / cssW;
    const lo = span.u0 + (x - dilate) * du - 1e-9;
    const hi = span.u0 + (x + 1 + dilate) * du + 1e-9;
    return slivers.some(([a, b]) => {
        for (let k = Math.floor(lo) - 1; k <= Math.floor(hi) + 1; k++) {
            if (a + k < hi && b + k > lo) return true;
        }
        return false;
    });
}

/**
 * THE GATE: before → after a slide, every column outside the swept
 * slivers is unchanged, on every heard tile of every lane the map
 * shapes. Returns {changed, swept} counts for teeth checks.
 */
function assertOnlySliversChange(tilesBefore, tilesAfter, slivers, label,
                                 { dilate = 0, tol = TOL } = {}) {
    assert.equal(tilesAfter.length, tilesBefore.length,
        `${label}: a slide never re-lays the tiles`);
    let swept = 0;
    let changedInSliver = 0;
    tilesBefore.forEach((t0, i) => {
        const t1 = tilesAfter[i];
        assert.ok(Math.abs(t1.rep.startQ - t0.rep.startQ) < 1e-9,
            `${label}: tile ${i} stays put`);
        assert.equal(t1.cssW, t0.cssW, `${label}: tile ${i} keeps its width`);
        assert.deepEqual(t1.span, t0.span, `${label}: tile ${i} spans the same phases`);
        for (let x = 0; x < t0.cssW; x++) {
            const d = Math.abs(t1.cols[x] - t0.cols[x]);
            if (columnSwept(x, t0.cssW, t0.span, slivers, dilate)) {
                swept++;
                if (d > tol) changedInSliver++;
                continue;
            }
            assert.ok(d <= tol,
                `${label}: tile ${i} column ${x}/${t0.cssW} changed by ${d} ` +
                `outside the swept sliver(s) ${JSON.stringify(slivers)}`);
        }
    });
    return { swept, changedInSliver };
}

/** Run one slide scenario: derive before/after (pinned like a live
 * gesture unless `unpinned`), sample every lane in `lanes`, assert the
 * gate. `edit(nodesFn)` builds the after-scene. */
function slideCase({ label, build, editedId, lanes, peaksBy, pxPerQ,
                     unpinned = false }) {
    const vm0 = derive(build(0));
    const vm1 = derive(build(1), unpinned ? null : vm0);
    const vm0p = unpinned ? vm0 : derive(build(0), vm0);
    const slivers = sweptSlivers(
        laneOf(vm0p, editedId).reps.find(r => r.srcSegs),
        laneOf(vm1, editedId).reps.find(r => r.srcSegs));
    assert.ok(slivers.length > 0, `${label}: the slide sweeps something`);
    let changed = 0;
    for (const id of lanes) {
        const r = assertOnlySliversChange(
            laneTiles(vm0p, id, peaksBy(id), pxPerQ),
            laneTiles(vm1, id, peaksBy(id), pxPerQ), slivers, `${label} [${id}]`);
        changed += r.changedInSliver;
    }
    // Non-vacuous: the swept strip really does show new material.
    assert.ok(changed > 0, `${label}: the swept strip changed`);
    return { vm0: vm0p, vm1, slivers };
}

/* The field topology: a 1Q definer, then a 12Q take windowed to 4Q. */
const fieldScene = (segsQ) => [
    clip('def', 0, 1),
    clip('b', 1 * Q, 12, windowed(segsQ)),
];

/* -------------------------- the invariant -------------------------- */

for (const { n, pxPerQ, why } of [
    { n: 800, pxPerQ: 156, why: 'the field: 800 peaks/take at 156 px/Q (upsampling)' },
    { n: 3000, pxPerQ: 137.3, why: 'dense peaks at a fractional scale (pooling)' },
    { n: 12 * 156, pxPerQ: 156, why: 'exactly one peak per column (the regime edge)' },
]) {
    const peaks = makePeaks(n);
    // −0.15Q is the field video's slide; −0.137Q moves by a non-whole
    // number of peaks at every density here.
    for (const dQ of [-0.15, -0.137, 0.37, -1]) {
        test(`single segment: a ${dQ}Q slide changes only the swept sliver — ${why}`, () => {
            const base = [[6, 10]];
            slideCase({
                label: `window ${dQ}Q`,
                build: k => fieldScene(k ? slideSegs(base, dQ, 12).segs : base),
                editedId: 'b', lanes: ['b'], peaksBy: () => peaks, pxPerQ,
            });
        });
    }
}

test('multi-segment: slideSegs, an inner-seam slide and a wrap-only slide each change only their slivers', () => {
    const peaks = makePeaks(800, 5);
    const base = [[5, 7], [8, 11]];  // period 5Q of a 12Q take
    const cases = [
        { label: 'slideSegs +0.3', segs: slideSegs(base, 0.3, 12).segs },
        { label: 'slideSegs −0.4', segs: slideSegs(base, -0.4, 12).segs },
        { label: 'inner seam +0.3', segs: [[5, 7.3], [8.3, 11]] },
        { label: 'wrap seam −0.4', segs: [[4.6, 7], [8, 10.6]] },
        { label: 'slideSegs −1 (whole Q)', segs: slideSegs(base, -1, 12).segs },
    ];
    for (const c of cases) {
        slideCase({
            label: c.label,
            build: k => fieldScene(k ? c.segs : base),
            editedId: 'b', lanes: ['b'], peaksBy: () => peaks, pxPerQ: 156,
        });
    }
});

test('repeats: a 2Q loop after a 4Q loop changes only its slivers on EVERY repeat (unpinned — the seat moves by whole cycles only)', () => {
    const peaks = makePeaks(800, 3);
    const base = [[6, 8]];
    const scene = segs => [
        clip('d', 0, 4),
        clip('b', 4 * Q, 12, windowed(segs)),
    ];
    for (const dQ of [0.3, -0.15]) {
        const { vm1, slivers } = slideCase({
            label: `2Q loop ${dQ}Q`, unpinned: true,
            build: k => scene(k ? slideSegs(base, dQ, 12).segs : base),
            editedId: 'b', lanes: ['b'], peaksBy: () => peaks, pxPerQ: 156,
        });
        assert.equal(vm1.cycleQ, 4, 'a 4Q frame');
        assert.equal(laneOf(vm1, 'b').reps.length, 2, 'two repeats of the 2Q loop');
        assert.equal(slivers.length, 1, 'one seam, swept on both repeats');
    }
});

test('groups: a group map slide changes only its slivers on the group lane AND on its member under the map', () => {
    const groupPeaks = makePeaks(1600, 17);   // stands in for the composite
    const memberPeaks = makePeaks(800, 23);
    const scene = segs => [
        clip('def', 0, 1),
        {
            id: 'g', name: 'g', type: 'stack', anchored: true, origin: 1 * Q,
            windowActive: true, loopStart: segs[0][0] * Q, loopEnd: segs[0][1] * Q,
            loopBypassed: false, periodSource: 'own', effectiveQuantum: Q,
            duration: 0, nodes: [clip('m', 1 * Q, 6)],
        },
    ];
    const base = [[1, 4]];
    for (const dQ of [0.37, -0.15]) {
        const { vm0 } = slideCase({
            label: `group ${dQ}Q`,
            build: k => scene(k ? slideSegs(base, dQ, 6).segs : base),
            editedId: 'g', lanes: ['g', 'm'],
            peaksBy: id => (id === 'g' ? groupPeaks : memberPeaks), pxPerQ: 156,
        });
        assert.equal(laneOf(vm0, 'm').underMap, true, 'the member shows the map\'s slice');
    }
});

test('THE GATE HAS TEETH: the old whole-peak slicer moves columns far from the seam on a −0.137Q slide', () => {
    // The pre-2026-09-23 drawRepCanvas, reproduced HERE ONLY to prove
    // the invariant above catches the field bug: slice srcSegs at
    // floor/ceil peaks, rotate by a rounded peak count, refit.
    const legacy = (peaks, rep, periodQ, cssW) => {
        const n = peaks.length;
        let d = [];
        for (const [f0, f1] of rep.srcSegs) {
            const a = Math.max(0, Math.floor(f0 * n));
            const b = Math.min(n, Math.max(a + 1, Math.ceil(f1 * n)));
            for (let i = a; i < b; i++) d.push(peaks[i]);
        }
        const m = d.length;
        const rotN = Math.round(((rep.srcTopFrac || 0) % 1) * m);
        if (rotN > 0 && m > 1) d = d.slice(m - rotN).concat(d.slice(0, m - rotN));
        return poolColumns(d, cssW);
    };
    const peaks = makePeaks(800);
    const base = [[6, 10]];
    const vm0 = derive(fieldScene(base));
    // (At 800 peaks over 12Q the field's −0.15Q is exactly 10 peaks —
    // the one case the old slicer got right; −0.137Q is 9.13.)
    const vm1 = derive(fieldScene(slideSegs(base, -0.137, 12).segs), vm0);
    const vm0p = derive(fieldScene(base), vm0);
    const slivers = sweptSlivers(laneOf(vm0p, 'b').reps[0], laneOf(vm1, 'b').reps[0]);
    const t0 = laneTiles(vm0p, 'b', peaks, 156, legacy);
    const t1 = laneTiles(vm1, 'b', peaks, 156, legacy);
    let outside = 0;
    for (let x = 0; x < t0[0].cssW; x++) {
        if (columnSwept(x, t0[0].cssW, t0[0].span, slivers)) continue;
        if (Math.abs(t1[0].cols[x] - t0[0].cols[x]) > TOL) outside++;
    }
    assert.ok(outside > t0[0].cssW / 4,
        `the legacy slicer lurched ${outside} of ${t0[0].cssW} columns outside the sliver`);
});

test('ONE GAIN PER TAKE: a loud hit entering the loop changes no other column (the old self-normalization rescaled the whole tile)', () => {
    // Quiet material, one loud hit just past the window's end (10.1Q–
    // 10.2Q of the 12Q take): a +0.37Q slide brings it into the loop.
    const n = 1200;
    const peaks = makePeaks(n, 29, { lo: 0.05, hi: 0.3 });
    for (let i = Math.floor(10.1 / 12 * n); i < Math.ceil(10.2 / 12 * n); i++) peaks[i] = 1;
    const base = [[6, 10]];
    const { vm0, vm1, slivers } = slideCase({
        label: 'loud hit', build: k => fieldScene(k ? slideSegs(base, 0.37, 12).segs : base),
        editedId: 'b', lanes: ['b'], peaksBy: () => peaks, pxPerQ: 156,
    });
    const t0 = laneTiles(vm0, 'b', peaks, 156)[0];
    const t1 = laneTiles(vm1, 'b', peaks, 156)[0];
    assert.ok(Math.max(...t1.cols) > 0.99 && Math.max(...t0.cols) < 0.31,
        'the hit is outside the loop before and inside after');
    // The drawn heights at the take's one boost: only the sliver (and
    // the one-column smoothing halo either side) moves.
    const boost = peaksBoost(peaks);
    const h0 = shapeColumns(t0.cols, boost);
    const h1 = shapeColumns(t1.cols, boost);
    for (let x = 0; x < t0.cssW; x++) {
        if (columnSwept(x, t0.cssW, t0.span, slivers, 1)) continue;
        assert.ok(Math.abs(h1[x] - h0[x]) <= TOL, `drawn column ${x} rescaled`);
    }
    // Teeth: normalizing each tile to its OWN loudest column (the old
    // drawWaveform default) rescales nearly every column.
    const a0 = shapeColumns(t0.cols, envelopeBoost(t0.cols));
    const a1 = shapeColumns(t1.cols, envelopeBoost(t1.cols));
    let rescaled = 0;
    for (let x = 0; x < t0.cssW; x++) {
        if (!columnSwept(x, t0.cssW, t0.span, slivers, 1) &&
            Math.abs(a1[x] - a0[x]) > 0.01) rescaled++;
    }
    assert.ok(rescaled > t0.cssW / 2, `self-normalization rescaled ${rescaled} columns`);
});

test('peaksBoost: the whole array\'s auto boost, cached per identity, capped for silence', () => {
    const p = [0.1, 0.5, 0.25];
    assert.equal(peaksBoost(p), 0.95 / 0.5);
    p[1] = 0.9;  // same identity → the cached value (arrays are replaced on refetch)
    assert.equal(peaksBoost(p), 0.95 / 0.5);
    assert.equal(peaksBoost([0, 0]), 1, 'silence draws flat');
    assert.equal(peaksBoost([0.01]), 8, 'the NORM_MAX_BOOST cap');
    assert.equal(peaksBoost(['0.5', '0.25']), 1.9, 'string peaks (JSON) read as numbers');
    assert.equal(peaksBoost([]), 1);
    // The whole-array boost IS what the self-normalizing path picks for
    // a canvas that shows the whole array (downsampled).
    const q = makePeaks(1000, 3);
    assert.ok(Math.abs(envelopeBoost(poolColumns(q, 300)) - peaksBoost(q)) < 1e-6);
});

test('THE REVEAL draws at the take\'s gain and on the exact raw grid: its columns ARE the whole take\'s at the lane scale', () => {
    // 8Q take, 500 peaks (62.5 per Q): a reveal view starting at 2.37Q
    // does not start on a peak, so a whole-peak slice would sit up to a
    // peak off (the lurch a pan showed). A loud hit OUTSIDE the view
    // sets the take's gain — the quiet slice must not re-level to it.
    const totalQ = 8;
    const peaks = makePeaks(500, 17, { lo: 0.05, hi: 0.3 });
    peaks[450] = 0.95;
    const pxPerQ = 100;
    const a = 2.37, b = 5.37;
    const W = Math.round((b - a) * pxPerQ);
    const { cols, boost } = revealColumns(peaks, totalQ, a, b, W);
    assert.equal(boost, peaksBoost(peaks), 'one gain per take');
    assert.ok(Math.abs(envelopeBoost(cols) - boost) > 0.5,
        'teeth: the slice\'s own auto boost is a different gain');
    const whole = mappedColumns(peaks, totalQ * pxPerQ, { src: [[0, 1]] });
    const off = Math.round(a * pxPerQ);
    for (let x = 0; x < W; x++) {
        assert.ok(Math.abs(cols[x] - whole[off + x]) <= TOL, `column ${x}`);
    }
    // Teeth: the old whole-peak slice, refit to the tile, is misplaced.
    const n = peaks.length;
    const i0 = Math.floor((a / totalQ) * n), i1 = Math.ceil((b / totalQ) * n);
    const old = poolColumns(peaks.slice(i0, i1), W);
    let moved = 0;
    for (let x = 0; x < W; x++) if (Math.abs(old[x] - whole[off + x]) > 1e-3) moved++;
    assert.ok(moved > W / 4, `the whole-peak slice moved ${moved} columns`);
});

/* -------------------- the sampler's own contract -------------------- */

test('mappedColumns over the whole take is poolColumns (one pooling kernel)', () => {
    for (const [n, W] of [[800, 300], [800, 1400], [1872, 1872]]) {
        const peaks = makePeaks(n, 41);
        const a = poolColumns(peaks, W);
        const b = mappedColumns(peaks, W, { src: [[0, 1]] });
        for (let x = 0; x < W; x++) {
            assert.ok(Math.abs(a[x] - b[x]) <= TOL, `n=${n} W=${W} column ${x}`);
        }
    }
});

test('mappedColumns: a column straddling a seam pools BOTH sides; a rotation is exact', () => {
    // Two segments of a 4-peak take: heard order = peak 3, then peak 0.
    const peaks = [0.2, 0.1, 0.1, 0.9];
    const src = [[0.75, 1], [0, 0.25]];
    // Two columns: each covers exactly one segment.
    assert.deepEqual([...mappedColumns(peaks, 2, { src })].map(v => +v.toFixed(3)),
                     [0.9, 0.2]);
    // One column over the whole period straddles the seam: the max.
    assert.equal(+mappedColumns(peaks, 1, { src })[0].toFixed(3), 0.9);
    // A rotation by half a period swaps them — exactly, no rounding.
    assert.deepEqual([...mappedColumns(peaks, 2, { src, rotFrac: 0.5 })]
        .map(v => +v.toFixed(3)), [0.2, 0.9]);
});

test('tileSpan: full tiles span one period; a frame-clipped tile its leading part; float noise snaps', () => {
    assert.deepEqual(tileSpan({ startQ: 8, endQ: 12 }, 4), { u0: 2, u1: 3 });
    assert.deepEqual(tileSpan({ startQ: 4, endQ: 5 }, 4), { u0: 1, u1: 1.25 });
    assert.deepEqual(tileSpan({ startQ: 0.1 * 3, endQ: 0.9 }, 0.3), { u0: 1, u1: 3 });
    assert.deepEqual(tileSpan({ startQ: 2, endQ: 6 }, 0), { u0: 0.5, u1: 1.5 },
        'no period: the tile\'s own length is one period');
});

test('full repeats of a lane share one sampling (the memo) and match a direct mappedColumns', () => {
    const peaks = makePeaks(800, 13);
    const rep = k => ({ srcSegs: [[0.5, 2 / 3]], srcTopFrac: 0.37,
                        startQ: 2 * k, endQ: 2 * k + 2 });
    const first = heardTileColumns(peaks, rep(0), 2, 312);
    for (const k of [1, 2, 7]) {
        assert.equal(heardTileColumns(peaks, rep(k), 2, 312), first,
            `repeat ${k} reuses the columns`);
    }
    const direct = mappedColumns(peaks, 312, tileMap(rep(3), 2));
    for (let x = 0; x < 312; x++) assert.ok(Math.abs(direct[x] - first[x]) <= TOL);
    // A different window, width or peaks identity samples afresh.
    assert.notEqual(heardTileColumns(peaks, { ...rep(0), endQ: 1, wrapped: true }, 2, 156), first);
    assert.notEqual(heardTileColumns(peaks.slice(), rep(0), 2, 312), first);
});

test('a frame-clipped heard tile draws the LEADING part of its period, not the whole period squeezed', () => {
    const peaks = makePeaks(800, 7);
    const rep = { srcSegs: [[0.5, 5 / 6]], srcTopFrac: 0, startQ: 4, endQ: 5, wrapped: true };
    // 4Q period, the tile shows [0, 1Q) of it at 100 px: the same
    // columns as the first quarter of a full 400 px tile.
    const clipped = heardTileColumns(peaks, rep, 4, 100);
    const full = heardTileColumns(peaks, { ...rep, startQ: 0, endQ: 4 }, 4, 400);
    for (let x = 0; x < 100; x++) {
        assert.ok(Math.abs(clipped[x] - full[x]) <= TOL, `column ${x}`);
    }
});

/* ------------------------------- MIDI ------------------------------- */

const notesQ = [
    { posQ: 0.5, lenQ: 0.4, note: 60, vel: 100 },
    { posQ: 6.2, lenQ: 0.5, note: 62, vel: 90 },
    { posQ: 7.9, lenQ: 0.6, note: 64, vel: 80 },   // crosses the 8Q cut
    { posQ: 9.1, lenQ: 1.3, note: 65, vel: 70 },   // crosses the 10.4 end
];

test('MIDI: the tile window is the identity for a whole period (any whole-period u0)', () => {
    const src = [[6 / 12, 8 / 12], [9 / 12, 11 / 12]];
    const plain = sliceNotesToTile(notesQ, 12, src, 0.3);
    assert.deepEqual(sliceNotesToTile(notesQ, 12, src, 0.3, { u0: 3, u1: 4 }), plain);
    assert.deepEqual(sliceNotesToTile(notesQ, 12, src, 0.3, { u0: 0, u1: 1 }), plain);
});

test('MIDI: a clipped window shows its part of the period, rescaled; a piece cut by the window start is not an onset', () => {
    const notes = [{ posQ: 0.4, lenQ: 0.2, note: 60, vel: 100 },   // [0.4, 0.6)
                   { posQ: 0.7, lenQ: 0.1, note: 61, vel: 100 }];  // [0.7, 0.8)
    // The leading quarter: nothing of these notes.
    assert.deepEqual(sliceNotesToTile(notes, 1, null, 0, { u0: 2, u1: 2.25 }), []);
    // The second half: the first note from its middle (no onset), the
    // second whole — at twice the scale.
    const out = sliceNotesToTile(notes, 1, null, 0, { u0: 1.5, u1: 2 });
    assert.equal(out.length, 2);
    assert.ok(Math.abs(out[0].f0 - 0) < 1e-12 && Math.abs(out[0].f1 - 0.2) < 1e-12);
    assert.equal(out[0].onset, false, 'continued from before the window');
    assert.ok(Math.abs(out[1].f0 - 0.4) < 1e-12 && Math.abs(out[1].f1 - 0.6) < 1e-12);
    assert.equal(out[1].onset, true);
});

test('MIDI tiles and audio tiles share ONE exact mapping (every note piece lands where the sampler reads that note\'s raw time)', () => {
    // A MIDI take whose "peaks" are 1 exactly under its notes: the audio
    // sampler's loud columns and the MIDI pieces must coincide, on a
    // real heard lane (a rotated multi-segment map) and on a clipped tile.
    const n = 12 * 250;
    const peaks = new Array(n).fill(0);
    for (const nt of notesQ) {
        for (let i = Math.floor(nt.posQ / 12 * n); i < Math.ceil((nt.posQ + nt.lenQ) / 12 * n); i++) {
            peaks[i] = 1;
        }
    }
    const vm = derive([clip('d', 0, 4), clip('b', 4 * Q + 300, 12, windowed([[6, 8], [9, 10.4]]))]);
    const lane = laneOf(vm, 'b');
    const rep0 = lane.reps.find(r => r.srcSegs);
    assert.ok(rep0.srcTopFrac > 0, 'a rotated heard lane');
    for (const rep of [rep0, { ...rep0, endQ: rep0.startQ + 1.3, wrapped: true }]) {
        const W = Math.round((rep.endQ - rep.startQ) * 200);
        const map = tileMap(rep, lane.periodQ);
        const cols = mappedColumns(peaks, W, map);
        const pieces = sliceNotesToTile(notesQ, 12, map.src, map.rotFrac, map);
        const covered = new Array(W).fill(false);
        for (const p of pieces) {
            for (let x = Math.floor(p.f0 * W); x < Math.ceil(p.f1 * W); x++) covered[x] = true;
        }
        let mismatched = 0;
        for (let x = 0; x < W; x++) {
            const near = k => covered[Math.max(0, Math.min(W - 1, x + k))];
            const loud = cols[x] > 0.5;
            // ±1 column: the audio bins are 1/250 Q wide.
            if (loud && !(near(-1) || near(0) || near(1))) mismatched++;
            if (covered[x] && !(cols[Math.max(0, x - 1)] > 0.5 || loud ||
                                cols[Math.min(W - 1, x + 1)] > 0.5)) mismatched++;
        }
        assert.equal(mismatched, 0, `tile ${rep.startQ}–${rep.endQ}: audio and MIDI disagree`);
        assert.ok(pieces.length > 0 && covered.some(Boolean), 'notes are drawn');
        // And each piece's midpoint reads its own note's raw time
        // through the heard mapping (mapOffset of the heard phase).
        const total = map.src.reduce((s, [a, b]) => s + b - a, 0);
        for (const p of pieces) {
            const u = map.u0 + ((p.f0 + p.f1) / 2) * (map.u1 - map.u0);
            const raw = mapOffset({ segs: map.src }, posMod(u - map.rotFrac, 1) * total) * 12;
            const nt = notesQ.find(q => q.note === p.note);
            assert.ok(raw >= nt.posQ - 1e-9 && raw <= nt.posQ + nt.lenQ + 1e-9,
                `note ${p.note} piece reads raw ${raw}`);
        }
    }
});

/* ---------------- map edits swap tiles, never fade ---------------- */

test('mapEditInFlight: live gesture, frame pin, lane and panel holds, a landed map change — then quiet after the settle', () => {
    const body = {};
    const strip = {};
    const row = { _regionStrip: strip };
    let t = 1e6;
    assert.equal(mapEditInFlight(row, body, null, t), false, 'quiet at rest');
    // The lane's own post-commit hold.
    holdOverlay(body);
    assert.equal(mapEditInFlight(row, body, null, t += 1000), true, 'lane hold');
    releaseOverlay(body);
    assert.equal(mapEditInFlight(row, body, null, t + 100), true, 'settling');
    assert.equal(mapEditInFlight(row, body, null, t += 1000), false, 'settled');
    // The region panel's hold (a panel drag freezes the strip, not the lane).
    holdOverlay(strip);
    assert.equal(mapEditInFlight(row, body, null, t += 1000), true, 'panel hold');
    releaseOverlay(strip);
    assert.equal(mapEditInFlight(row, body, null, t += 1000), false);
    // A MEMBER row sees a group's edit through the shared frame pin.
    noteFrame(4, 4, 0);
    pinFrame();
    assert.equal(mapEditInFlight({}, {}, null, t += 1000), true, 'frame pinned');
    unpinFrame();
    assert.equal(mapEditInFlight({}, {}, null, t += 1000), false);
    // Any live gesture (every beginGesture site is a map/window edit).
    const node = { addEventListener() {}, removeEventListener() {},
                   setPointerCapture() {}, hasPointerCapture() { return false; } };
    const g = beginGesture({ preventDefault() {}, stopPropagation() {}, pointerId: 1 },
                           { node });
    assert.equal(mapEditInFlight({}, {}, null, t += 1000), true, 'gesture live');
    g.end(false);
    assert.equal(mapEditInFlight({}, {}, null, t += 1000), false);
    // A map edit that LANDED without a gesture (a ← / → nudge, undo):
    // the lanes' map geometry changed since the last view model.
    const vm = segs => ({ lanes: [{ id: 'b', bandSegs: segs }, { id: 'c', bandSegs: null }] });
    assert.equal(mapEditInFlight({}, {}, vm([[6, 10]]), t += 1000), false, 'first view');
    assert.equal(mapEditInFlight({}, {}, vm([[6, 10]]), t += 1000), false, 'same geometry');
    const nudged = vm([[7, 11]]);
    assert.equal(mapEditInFlight({}, {}, nudged, t += 1000), true, 'a nudge landed');
    assert.equal(mapEditInFlight({}, {}, nudged, t + 100), true, 'every lane of that patch');
    assert.equal(mapEditInFlight({}, {}, vm([[7, 11]]), t += 1000), false, 'settled');
    // Lanes arriving or leaving (a new track, a fold, a delete) are not
    // map edits: their re-lays keep the settle fade.
    assert.equal(mapEditInFlight({}, {}, { lanes: [{ id: 'b', bandSegs: [[7, 11]] },
        { id: 'c', bandSegs: null }, { id: 'new', bandSegs: [[0, 2]] }] },
    t += 1000), false, 'a lane appeared');
    assert.equal(mapEditInFlight({}, {}, { lanes: [{ id: 'b', bandSegs: [[7, 11]] }] },
        t += 1000), false, 'lanes left');
});

/** A reps layer of fake divs (the children the reconcile walks). */
function fakeLayer(k) {
    const layer = { children: [] };
    for (let i = 0; i < k; i++) {
        const d = { id: i, style: {}, remove() {
            layer.children = layer.children.filter(c => c !== d);
        } };
        layer.children.push(d);
    }
    return layer;
}

test('retireSurplusTiles: fades surplus at rest; removes it AT ONCE under a map edit', async () => {
    const rest = fakeLayer(4);
    const kept = retireSurplusTiles(rest, 2, false);
    assert.deepEqual(kept.map(d => d.id), [0, 1]);
    assert.equal(rest.children.length, 4, 'fading tiles linger for the fade');
    assert.ok(rest.children[3]._exiting && rest.children[3].style.opacity === '0');
    // A re-lay mid-fade keeps the fading ones out of the reuse pool.
    assert.deepEqual(retireSurplusTiles(rest, 3, false).map(d => d.id), [0, 1]);
    await new Promise(r => setTimeout(r, 260));
    assert.equal(rest.children.length, 2, 'gone after the fade');

    const editing = fakeLayer(4);
    const kept2 = retireSurplusTiles(editing, 1, true);
    assert.deepEqual(kept2.map(d => d.id), [0]);
    assert.equal(editing.children.length, 1, 'no double image of the old layout');
    // A fade begun just before the edit goes at once too.
    const mixed = fakeLayer(3);
    retireSurplusTiles(mixed, 2, false);
    retireSurplusTiles(mixed, 2, true);
    assert.equal(mixed.children.length, 2);
});

test('wantsCrossfade: only a committed tile whose peaks identity changed under a drawn canvas, never mid-edit', () => {
    const a = [1], b = [2];
    const base = { live: false, crossfade: true, prev: a, peaks: b, drawn: true };
    assert.equal(wantsCrossfade(base), true, 'fetched waveform replacing live peaks');
    assert.equal(wantsCrossfade({ ...base, crossfade: false }), false, 'map edit in flight');
    assert.equal(wantsCrossfade({ ...base, live: true }), false, 'the live bar');
    assert.equal(wantsCrossfade({ ...base, prev: b }), false, 'same identity (a map redraw)');
    assert.equal(wantsCrossfade({ ...base, prev: null }), false, 'first draw');
    assert.equal(wantsCrossfade({ ...base, drawn: false }), false, 'nothing drawn yet');
});
