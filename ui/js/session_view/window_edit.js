/**
 * Loop-window interactions (docs/ui_overhaul.md law 13 — the window
 * sets the part; docs/time_maps.md).
 *
 * Drag a bracket to edit; click the chip to toggle active/bypassed.
 * TWO-LAYER DRAG FEEDBACK (owner request 2026-07-11, restoring the old
 * handles' feel): the handle itself follows the pointer CONTINUOUSLY
 * (you see your motion), while a dashed snap-ghost bracket + the dims +
 * the chip preview the Q-SNAPPED landing position (you see what a
 * release commits). Release commits the snap via setLoopPoints. During
 * the drag the overlay is frozen (gesture.js isOverlayFrozen) —
 * replacing the captured bracket node would orphan the gesture.
 */

import { ctx } from './context.js';
import { pct, setText } from './sv_util.js';
import { selectOnly } from './selection.js';
import { beginGesture, isDragging, holdOverlay, releaseOverlay }
    from './gesture.js';
import { buildWindowDims } from './dims.js';
import { windowDragTarget } from '../view_model.js';

/* The Q-definer drags FREE (sub-Q); this floor keeps Q positive.
 * (Deliberately distinct from map_bands' MIN_CUT_Q: this is the
 * smallest TEMPO the definer may set; that is the smallest CUT a
 * band may hold — different laws, different numbers.) */
const Q_DEFINER_MIN_LEN_Q = 0.05;
/* After a release the overlay is HELD at the previewed geometry until
 * the engine has answered the commit — a state poll already in flight
 * at release still carries the OLD window and rebuilt the brackets
 * there for a tick (the snap-back on a slow bridge, WebView2). This
 * caps the hold if the bridge never answers. */
const COMMIT_HOLD_MAX_MS = 1500;

export function wireWindow(o, lane, vm, body, win) {
    // (Multi-segment maps never reach here: lane_body's mapSegs branch
    // returns before the bracket overlay is built — the cell/punch
    // editor owns their geometry. Kept as a guard only.)
    if (win.segs && win.segs.length > 1) return;
    // A step audition's DERIVED window is shown, not edited (view_model).
    if (win.audition) return;
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
            // Only THIS window's dims: the enclosing map's projection
            // (parent-map-dim) is not ours to redraw.
            o.querySelectorAll('.win-dim:not(.parent-map-dim)').forEach(d => d.remove());
            buildWindowDims(o, t, lane, laneCycleQ);
        }
    };

    ['start', 'end'].forEach(edge => {
        const bracket = brackets[edge];
        let ghost = null;
        let grab = null;
        let wasAlt = false;  // last move was an ⌥ free slide (U2)
        bracket.addEventListener('pointerdown', e => {
            if (isDragging(body)) return; // one gesture at a time (a second pointer)
            const g = beginGesture(e, {
                node: bracket,
                claim: lane.id, // grabbing a handle claims the track
                onMove: mv => onDrag(mv),
                onEnd: committed => finish(committed),
            });
            if (!g.live()) return;  // the runner is a singleton (U7)
            g.freeze(body);  // the drag holds capture on this overlay
            bracket.classList.add('dragging');
            g.defer(() => bracket.classList.remove('dragging'));
            // The snap ghost starts AT the handle (same classes → same
            // shape/transform), marking the landing position
            ghost = bracket.cloneNode(false);
            ghost.classList.remove('dragging', 'latent');
            ghost.classList.add('snap-ghost');
            o.appendChild(ghost);
            g.defer(() => { if (ghost) { ghost.remove(); ghost = null; } });
            // ⌥ FREE SLIDE needs the grab point: the window at the grab
            // and the frame-Q under the pointer (deltas from here).
            const r0 = body.getBoundingClientRect();
            grab = { win: { ...cur },
                     q: ((e.clientX - r0.left) / r0.width) * laneCycleQ - anchorQ };
            wasAlt = false;
        });
        const onDrag = e => {
            if (!ghost) return;
            const r = body.getBoundingClientRect();
            // Frame Q under the pointer → content Q for the snap math
            const rawQ =
                ((e.clientX - r.left) / r.width) * laneCycleQ - anchorQ;
            // ⌥ FREE SLIDE (owner request 2026-08-18): the grabbed edge
            // follows the pointer by ANY fractional amount and the OTHER
            // end moves by the same delta — the window length is held,
            // so Q coherence survives (the anchoring law keeps content
            // in place; only which stretch is heard changes). Clamped to
            // the take's extent. Not for the Q-definer (its brackets
            // define Q; there is nothing to slide against).
            if (e.altKey && grab && !lane.isQDefiner) {
                const len = grab.win.endQ - grab.win.startQ;
                let s = grab.win.startQ + (rawQ - grab.q);
                s = Math.max(0, Math.min(maxQ - len, s));
                const t = { startQ: s, endQ: s + len };
                bracket.style.left = pct(anchorQ + (edge === 'start' ? t.startQ : t.endQ), laneCycleQ);
                const other = brackets[edge === 'start' ? 'end' : 'start'];
                if (other) other.style.left = pct(anchorQ + (edge === 'start' ? t.endQ : t.startQ), laneCycleQ);
                previewSnap(t, edge, ghost);
                wasAlt = true;
                return;
            }
            // ⌥ RELEASED MID-DRAG (audit 2026-08-31 U2): the free slide
            // left `cur` on a fractional grid; plain snapping computes
            // its targets FROM cur, so the fraction survived every
            // subsequent snap (and the commit). Re-land on whole Q
            // first, preserving the whole-Q length the slide held.
            if (wasAlt && !lane.isQDefiner) {
                const len = Math.max(1, Math.round(cur.endQ - cur.startQ));
                let s = Math.round(cur.startQ);
                s = Math.max(0, Math.min(maxQ - len, s));
                cur = { startQ: s, endQ: s + len };
                wasAlt = false;
            }
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
        };
        const finish = commit => {
            // NO-MOVE, NO-COMMIT (audit 2026-08-31 U3): a plain click on
            // a bracket ended with cur === the window it started at, yet
            // still committed — a redundant engine round-trip that could
            // land as a real (if identity) edit on the undo path.
            const moved = grab == null ||
                Math.abs(cur.startQ - grab.win.startQ) > 1e-9 ||
                Math.abs(cur.endQ - grab.win.endQ) > 1e-9;
            if (commit && moved) {
                const p = ctx.cb.onSetWindow(lane.id,
                    Math.round(cur.startQ * vm.quantum),
                    Math.round(cur.endQ * vm.quantum));
                // HOLD until the engine answered (see COMMIT_HOLD_MAX_MS):
                // the previewed brackets/dims already show the committed
                // geometry; a rebuild from an in-flight OLD poll would
                // snap them back for a tick.
                holdOverlay(body);
                let done = false;
                const settle = () => {
                    if (done) return;
                    done = true;
                    releaseOverlay(body);
                    o._key = ''; // rebuild from settled state on the next patch
                };
                Promise.resolve(p).then(settle, settle);
                setTimeout(settle, COMMIT_HOLD_MAX_MS);
            } else {
                o._key = ''; // rebuild from settled state on the next patch
            }
        };
    });
}
