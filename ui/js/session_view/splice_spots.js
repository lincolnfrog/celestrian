/**
 * WHERE A HEARD LANE'S SPLICES AND ↺ SIT — pure geometry, no DOM: every
 * heard splice and top across the frame, which of them belong to the
 * take tile, and how a pool of handle elements pairs with them. The
 * handles themselves are splice_handles.js; the heal-by-double-click
 * hit test (map_bands.js) reads the same spots.
 */

import { posMod } from '../math_utils.js';

/* A splice within this of its period's end is ON the left edge (the
 * next repeat's), not a sliver past the right one. */
const EDGE_EPS = 1e-7;
/* A handle within this of a tile's bounds belongs to that tile. */
export const TILE_EPS = 1e-6;
/* The degenerate-frame guard: never more handles than this per lane
 * (a tiny period in a huge frame draws no tiles either — unrollReps). */
export const MAX_SPOTS = 256;

/**
 * Every heard splice across the frame: the WRAP (j = 0, at the region
 * start's heard position `anchorQ`) and one per inner cut (j ≥ 1, the
 * kept length before it later), each on every repeat of `periodQ`
 * inside [0, cycleQ).
 *
 * BOTH EDGES: a splice ON the frame's left edge is the end of the last
 * repeat as much as the start of the first, so it shows at the RIGHT
 * edge too (`end: true`, x = cycleQ) — the loop's END, grabbed where the
 * loop ends. ⇧ moves the end of the material BEFORE a splice: from the
 * right-edge handle the loop shortens by dragging INWARD, with the
 * material it gives up in view (from the left one it would run off the
 * lane, into the reveal's edge pan).
 *
 * @param {Array<[number, number]>} segs  the covered set, raw Q
 * @param {number} anchorQ  where the wrap first sounds (lane.takeStartQ)
 * @returns {Array<{kind: 'wrap'|'cut', j: number, k: number, x: number,
 *                  cut: ?[number, number], end?: boolean}>}
 */
export function spliceSpots(segs, anchorQ, periodQ, cycleQ) {
    const out = [];
    if (!(periodQ > 0) || !(cycleQ > 0) || !segs || !segs.length) return out;
    let h = 0;
    segs.forEach(([s, e], j) => {
        const spot = { kind: j === 0 ? 'wrap' : 'cut', j,
                       cut: j ? [segs[j - 1][1], s] : null };
        let x = posMod(anchorQ + h, periodQ);
        if (x > periodQ - EDGE_EPS) x -= periodQ;  // ON the left edge
        let k = 0;
        for (; x < cycleQ - EDGE_EPS && out.length < MAX_SPOTS; k++) {
            out.push({ ...spot, k, x });
            x += periodQ;
        }
        // The next repeat lands ON the right edge: the loop's end.
        if (Math.abs(x - cycleQ) <= EDGE_EPS && out.length < MAX_SPOTS) {
            out.push({ ...spot, k, x: cycleQ, end: true });
        }
        h += e - s;
    });
    return out;
}

/** The ↺ on every repeat: first at `topHeardQ` (lane.topHeardQ, in
 * [0, periodQ)), then every period inside [0, cycleQ). */
export function topSpots(topHeardQ, periodQ, cycleQ) {
    const out = [];
    if (!(periodQ > 0) || !(cycleQ > 0) || !Number.isFinite(topHeardQ)) return out;
    let x = posMod(topHeardQ, periodQ);
    if (x > periodQ - EDGE_EPS) x -= periodQ;
    for (let k = 0; x < cycleQ - EDGE_EPS && out.length < MAX_SPOTS; k++) {
        out.push({ kind: 'top', j: 0, k, x });
        x += periodQ;
    }
    return out;
}

/** Is lane position `x` inside the take tile (a non-ghost rep)? With no
 * tiles to judge by, every handle is the take's. */
export function inTakeTile(reps, x) {
    const tiles = (reps || []).filter(r => !r.ghost && !r.bar);
    if (!tiles.length) return true;
    return tiles.some(r => x >= r.startQ - TILE_EPS && x < r.endQ - TILE_EPS);
}

/** Is lane position `x` in the take's own PASS — its tile, or the part
 * of it the frame's end clips, which sounds at the frame's start? (A
 * PLAIN loop's ↺: its take tile sits where the take was performed, and a
 * top moved into the take can sound past the frame's end.) Exactly one ↺
 * lies in the pass. */
export function inTakePass(reps, x, periodQ, cycleQ) {
    if (inTakeTile(reps, x)) return true;
    const take = (reps || []).find(r => !r.ghost && !r.bar);
    const over = take ? take.startQ + periodQ - cycleQ : 0;
    return over > TILE_EPS && x < over - TILE_EPS;
}

/**
 * Pair a pool's elements with its spots. The GRABBED handle keeps its
 * element (it holds the pointer capture) and takes the spot nearest the
 * hand — so it stands for that repeat and no repeat shows twice; the
 * rest pair in order. Returns the pairs (a null element = make one) and
 * the elements left over.
 */
export function pairHandles(els, spots, dragEl = null, dragX = 0) {
    const pairs = [];
    let free = els;
    const rest = spots.slice();
    if (dragEl && els.includes(dragEl)) {
        free = els.filter(h => h !== dragEl);
        let bi = -1;
        rest.forEach((sp, i) => {
            if (bi < 0 || Math.abs(sp.x - dragX) < Math.abs(rest[bi].x - dragX)) bi = i;
        });
        pairs.push([dragEl, bi >= 0 ? rest.splice(bi, 1)[0] : null]);
    }
    rest.forEach((sp, i) => pairs.push([free[i] || null, sp]));
    return { pairs, surplus: free.slice(rest.length) };
}
