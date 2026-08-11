/**
 * Loop-window interactions (docs/ui_overhaul.md §2).
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

import { ctx } from './context.js';
import { pct, setText, capturePointer } from './sv_util.js';
import { selectOnly } from './selection.js';
import { buildWindowDims } from './dims.js';
import { windowDragTarget } from '../view_model.js';

/* The Q-definer drags FREE (sub-Q); this floor keeps Q positive. */
const Q_DEFINER_MIN_LEN_Q = 0.05;

export function wireWindow(o, lane, vm, body, win) {
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
        chip.addEventListener('click', () => ctx.cb.onToggleWindow(lane.id));
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
        const bracket = brackets[edge];
        let ghost = null;
        bracket.addEventListener('pointerdown', e => {
            e.preventDefault();
            selectOnly(lane.id); // grabbing a handle claims the track
            capturePointer(bracket, e);
            body._winDrag = true;
            bracket.classList.add('dragging');
            // The snap ghost starts AT the handle (same classes → same
            // shape/transform), marking the landing position
            ghost = bracket.cloneNode(false);
            ghost.classList.remove('dragging', 'latent');
            ghost.classList.add('snap-ghost');
            o.appendChild(ghost);
        });
        bracket.addEventListener('pointermove', e => {
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
                const minLen = Q_DEFINER_MIN_LEN_Q;
                const extQ = lane.intrinsicQ || 0;
                const t = edge === 'start'
                    ? { startQ: Math.min(Math.max(0, rawQ), cur.endQ - minLen), endQ: cur.endQ }
                    : { startQ: cur.startQ, endQ: Math.max(Math.min(extQ, rawQ), cur.startQ + minLen) };
                bracket.style.left = pct(anchorQ + (edge === 'start' ? t.startQ : t.endQ), laneCycleQ);
                previewSnap(t, edge, ghost);
                return;
            }
            // The handle tracks the pointer continuously, inside the
            // same bounds the snap enforces (≥1Q window, lane extent)
            const freeQ = edge === 'start'
                ? Math.min(Math.max(0, rawQ), cur.endQ - 1)
                : Math.max(Math.min(maxQ, rawQ), cur.startQ + 1);
            bracket.style.left = pct(anchorQ + freeQ, laneCycleQ);
            const t = windowDragTarget({ edge, rawQ, ...cur, maxQ });
            if (t.startQ !== cur.startQ || t.endQ !== cur.endQ) {
                previewSnap(t, edge, ghost);
            }
        });
        const end = commit => e => {
            if (!body._winDrag) return;
            body._winDrag = false;
            bracket.classList.remove('dragging');
            if (bracket.hasPointerCapture(e.pointerId)) bracket.releasePointerCapture(e.pointerId);
            if (ghost) { ghost.remove(); ghost = null; }
            if (commit) {
                ctx.cb.onSetWindow(lane.id,
                    Math.round(cur.startQ * vm.quantum),
                    Math.round(cur.endQ * vm.quantum));
            }
            o._key = ''; // rebuild from settled state on the next patch
        };
        bracket.addEventListener('pointerup', end(true));
        bracket.addEventListener('pointercancel', end(false));
    });
}
