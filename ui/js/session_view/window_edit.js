/**
 * A lane's loop-window brackets (docs/session_view.md law 13;
 * docs/time_maps.md): drag a bracket to edit the window, click the chip
 * to toggle it active ↔ bypassed.
 *
 * TWO-LAYER DRAG FEEDBACK: the handle follows the pointer CONTINUOUSLY
 * while a dashed snap-ghost bracket, the dims and the chip preview the
 * Q-SNAPPED landing a release commits (setLoopPoints). The overlay is
 * frozen for the drag and held until the commit settles (gesture.js,
 * the freeze law).
 */

import { ctx } from './context.js';
import { pct, fmtQ, setText } from './sv_util.js';
import { beginGesture, holdUntilSettled } from './gesture.js';
import { selectOnly } from './selection.js';
import { buildWindowDims } from './dims.js';
import { windowDragTarget } from '../view_model.js';
import { slideSegs } from '../map_edit.js';

/* Two brackets within this many Q of each other share one place. */
const BRACKET_EPS_Q = 1e-9;
/* The Q-definer drags FREE (sub-Q); this floor keeps Q positive — the
 * smallest TEMPO it may set (not map_moves' MIN_CUT_Q, the smallest cut
 * a band may hold). */
const Q_DEFINER_MIN_LEN_Q = 0.05;

/**
 * WHERE A BRACKET SITS ON THE LANE (frame Q). Window Qs are
 * content-relative and the content's origin is the take tile (anchorQ)
 * — which the frame's end may CLIP: the rest of the take then sounds,
 * and is drawn, from the frame's start, and a bracket past the frame's
 * end belongs there too (at `anchorQ + q` it would sit off the lane, out
 * of reach).
 *
 * `q` is that unwrapped place. The START bracket of a region that begins
 * exactly at the frame's end is the frame's start; the END bracket of
 * one that ends there stays on the right edge.
 */
export function bracketQ(q, cycleQ, edge) {
    if (!(cycleQ > 0)) return q;
    while (edge === 'start' ? q >= cycleQ - BRACKET_EPS_Q
                            : q > cycleQ + BRACKET_EPS_Q) q -= cycleQ;
    return q;
}

/**
 * THE CONTENT Q UNDER THE POINTER, for a lane whose take tile may wrap
 * the frame: a frame position stands for content `cycleQ` apart on
 * either side of the wrap, so take the one NEAREST `nearQ` — where the
 * dragged edge last was. The edge then follows the hand continuously on
 * whichever side of the frame's edge it sits.
 */
export function contentQNear(rawQ, nearQ, cycleQ) {
    if (!(cycleQ > 0) || !Number.isFinite(nearQ)) return rawQ;
    return rawQ + cycleQ * Math.round((nearQ - rawQ) / cycleQ);
}

/** ⌥ = SLIDE the window by `deltaQ` — any amount — its length held,
 * clamped to [0, maxQ]: the map's slide law for one window (map_edit
 * slideSegs; the anchoring law keeps content in place, only which
 * stretch is heard changes). */
export function slideWindow(win, deltaQ, maxQ) {
    const [[startQ, endQ]] = slideSegs([[win.startQ, win.endQ]], deltaQ, maxQ).segs;
    return { startQ, endQ };
}

/** ⌥ RELEASED mid-drag: the slid window re-lands on whole Q, its whole-Q
 * length held. The plain snap computes its targets FROM the window, so a
 * fraction left in it would survive every later snap, and the commit. */
export function relandWindow(win, maxQ) {
    const len = Math.max(1, Math.round(win.endQ - win.startQ));
    const startQ = Math.max(0, Math.min(maxQ - len, Math.round(win.startQ)));
    return { startQ, endQ: startQ + len };
}

export function wireWindow(o, lane, vm, body, win) {
    // A step audition's DERIVED window is shown, not edited (view_model).
    if (win.audition) return;
    const multi = !!(win.segs && win.segs.length > 1);
    const chip = o.querySelector('.win-chip');
    // Clip and group windows toggle alike (I5). The Q-definer's chip is
    // a live readout, not a toggle (there is no window to bypass).
    if (chip && !lane.isQDefiner) {
        chip.classList.add('toggle');
        // A suspended window's chip keeps the reason it was built with.
        if (!win.suspended) {
            chip.title = multi
                ? 'Toggle the map: active ↔ bypassed (bypass keeps its shape)'
                : 'Toggle window: active ↔ bypassed (brackets stay editable)';
        }
        chip.addEventListener('click', () => ctx.cb.onToggleWindow(lane.id));
    }
    // A clip's bypassed MULTI-SEGMENT map rests here raw-framed: the
    // chip above switches it back on; its brackets mark the outer
    // bounds and take no drag (the cut bands and the region panel own
    // that geometry).
    if (multi) return;
    // A raw inspector maps through its own frame, not the shared one.
    const laneCycleQ = lane.frameQ || vm.cycleQ;

    const brackets = {
        start: o.querySelector('.win-bracket.start'),
        end: o.querySelector('.win-bracket.end'),
    };
    const maxQ = Math.round(lane.intrinsicQ || 0);
    if (maxQ < 1) return;
    let cur = { startQ: win.startQ, endQ: win.endQ };
    const dimsLive = (win.active && !win.bypassed) || win.latent;
    // Window Qs are CONTENT-relative; the pointer moves in FRAME Qs. The
    // brackets wrap with a clipped take tile (bracketQ) and the pointer
    // reads the content on its own side of the wrap (contentQNear).
    const anchorQ = lane.takeStartQ || 0;
    /** The lane position (%) of content `q`'s bracket of `edge`. */
    const at = (q, edge) => pct(bracketQ(anchorQ + q, laneCycleQ, edge), laneCycleQ);
    /** The content Q under the pointer, nearest `nearQ`. */
    const pointerQ = (clientX, r, nearQ) => contentQNear(
        ((clientX - r.left) / r.width) * laneCycleQ - anchorQ, nearQ, laneCycleQ);

    /** Re-render the SNAPPED preview: ghost bracket, dims, chip badge. */
    const previewSnap = (t, edge, ghost) => {
        cur = t;
        ghost.style.left = at(edge === 'start' ? t.startQ : t.endQ, edge);
        if (chip) {
            chip.style.left = at(t.endQ, 'end');
            chip.classList.toggle('at-end',
                bracketQ(anchorQ + t.endQ, laneCycleQ, 'end') >= laneCycleQ);
            setText(chip, lane.isQDefiner
                ? 'Q = ' + ((t.endQ - t.startQ) * vm.quantum / vm.sampleRate).toFixed(2) + 's'
                : fmtQ(t.endQ - t.startQ) + 'Q window');
        }
        if (dimsLive) {
            // Only THIS window's dims: the enclosing map's projection
            // (parent-map-dim) is not ours to redraw.
            o.querySelectorAll('.win-dim:not(.parent-map-dim)').forEach(d => d.remove());
            buildWindowDims(o, t, lane, laneCycleQ);
        }
    };

    ['start', 'end'].forEach(edge => {
        const bracket = brackets[edge];
        const otherEdge = edge === 'start' ? 'end' : 'start';
        const edgeQ = (t, e) => (e === 'start' ? t.startQ : t.endQ);
        let ghost = null;
        let grab = null;
        let lastQ = 0;       // the content Q the pointer last read
        let wasAlt = false;  // last move was an ⌥ free slide
        bracket.addEventListener('pointerdown', e => {
            const g = beginGesture(e, {
                node: bracket,
                onMove: mv => onDrag(mv),
                onEnd: committed => finish(committed),
            });
            if (!g.live()) return;
            // The press selects this track alone (several selected
            // collapse to the one whose handle is pressed).
            selectOnly(lane.id);
            g.freeze(body);
            bracket.classList.add('dragging');
            g.defer(() => bracket.classList.remove('dragging'));
            // The snap ghost starts AT the handle (same classes → same
            // shape/transform), marking the landing position.
            ghost = bracket.cloneNode(false);
            ghost.classList.remove('dragging', 'latent');
            ghost.classList.add('snap-ghost');
            o.appendChild(ghost);
            g.defer(() => { if (ghost) { ghost.remove(); ghost = null; } });
            // The grab point: the window and the content Q under the
            // pointer (an ⌥ slide is a displacement from here).
            const r0 = body.getBoundingClientRect();
            grab = { win: { ...cur }, q: pointerQ(e.clientX, r0, edgeQ(cur, edge)) };
            lastQ = grab.q;
            wasAlt = false;
        });
        const onDrag = e => {
            if (!ghost) return;
            const r = body.getBoundingClientRect();
            const rawQ = pointerQ(e.clientX, r, lastQ);
            lastQ = rawQ;
            // ⌥ FREE SLIDE (slideWindow). Not for the Q-definer: its
            // brackets define Q; there is nothing to slide against.
            if (e.altKey && grab && !lane.isQDefiner) {
                const t = slideWindow(grab.win, rawQ - grab.q, maxQ);
                bracket.style.left = at(edgeQ(t, edge), edge);
                const other = brackets[otherEdge];
                if (other) other.style.left = at(edgeQ(t, otherEdge), otherEdge);
                previewSnap(t, edge, ghost);
                wasAlt = true;
                return;
            }
            if (wasAlt && !lane.isQDefiner) {
                cur = relandWindow(cur, maxQ);
                wasAlt = false;
            }
            // Q13: the Q-definer drags FREE (sub-Q) — it DEFINES Q, it
            // does not snap to it. Clamped to the RAW buffer extent (the
            // rounded maxQ would let the end land up to half a Q past the
            // recorded material).
            if (lane.isQDefiner) {
                const minLen = Q_DEFINER_MIN_LEN_Q;
                const extQ = lane.intrinsicQ || 0;
                const t = edge === 'start'
                    ? { startQ: Math.min(Math.max(0, rawQ), cur.endQ - minLen), endQ: cur.endQ }
                    : { startQ: cur.startQ, endQ: Math.max(Math.min(extQ, rawQ), cur.startQ + minLen) };
                bracket.style.left = at(edgeQ(t, edge), edge);
                previewSnap(t, edge, ghost);
                return;
            }
            // The handle tracks the pointer continuously, inside the
            // bounds the snap enforces (≥ 1Q window, lane extent).
            const freeQ = edge === 'start'
                ? Math.min(Math.max(0, rawQ), cur.endQ - 1)
                : Math.max(Math.min(maxQ, rawQ), cur.startQ + 1);
            bracket.style.left = at(freeQ, edge);
            const t = windowDragTarget({ edge, rawQ, ...cur, maxQ });
            if (t.startQ !== cur.startQ || t.endQ !== cur.endQ) {
                previewSnap(t, edge, ghost);
            }
        };
        const finish = commit => {
            // The next patch that may rebuild does, from settled state.
            o._key = '';
            // NO MOVE, NO COMMIT: a plain click on a bracket must not
            // land as an (identity) edit on the undo path.
            const moved = grab == null ||
                Math.abs(cur.startQ - grab.win.startQ) > 1e-9 ||
                Math.abs(cur.endQ - grab.win.endQ) > 1e-9;
            if (!commit || !moved) return;
            // The previewed brackets/dims show the committed geometry:
            // held until the engine answers.
            holdUntilSettled(body, ctx.cb.onSetWindow(lane.id,
                Math.round(cur.startQ * vm.quantum),
                Math.round(cur.endQ * vm.quantum)));
        };
    });
}
