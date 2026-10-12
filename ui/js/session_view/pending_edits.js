/**
 * PENDING EDITS: a gesture's preview, drawn AHEAD of the engine
 * (loop_selection.md §10 — the splice and ↺ drags render their tiles
 * locally, with no round trip).
 *
 * A gesture sets its preview on every move and asks for a render
 * (render_request.js): the app re-derives from the last POLLED state
 * with the preview applied to a clone of the lane's node
 * (view_model.applyPendingEdits) and patches at once.
 *
 *   setPendingEdit(laneId, { segments?, originShift?, top? })
 *     segments     the map the gesture shows — flat samples [s0,e0,…]
 *     originShift  samples the gesture moves the take's origin, from
 *                  where the gesture FOUND it — `retime` moves with it
 *     top          the raw top the gesture sets (samples, `loopTop`)
 *
 * Each call REPLACES the lane's preview. The first captures the lane's
 * origin as the shift's BASE (at the next derive, from the polled node)
 * and the base lives as long as the preview, so a live setTiming landing
 * mid-drag never counts twice: the preview resolves to the shift still
 * OUTSTANDING against the polled origin.
 *
 * A preview outlives the pointer, like the frame pin (gesture.js): it
 * is dropped once no gesture is live and the polled node MATCHES it —
 * the engine has answered — or COMMIT_HOLD_MAX_MS after it was last
 * touched (a refused commit lets go). While any gesture is live every
 * preview counts as touched.
 */

import { COMMIT_HOLD_MAX_MS, isGestureLive } from './gesture.js';
import { publishedMap } from '../time_map.js';

/* A published value within this many samples of the preview's is the
 * engine's answer (the bridge rounds to whole samples). */
const MATCH_SAMPLES = 1;

const pending = new Map();  // lane id → { edit, base, t }

/**
 * Set (replace) `laneId`'s preview. Absent keys preview nothing.
 *
 * @param {string} laneId
 * @param {{segments?: number[], originShift?: number, top?: number}} edit
 * @param {number} [now] performance.now() (injectable for the tests)
 */
export function setPendingEdit(laneId, edit = {}, now = performance.now()) {
    const prev = pending.get(laneId);
    pending.set(laneId, {
        edit: {
            segments: Array.isArray(edit.segments) ? edit.segments.slice() : undefined,
            originShift: Number.isFinite(edit.originShift) ? edit.originShift : undefined,
            top: Number.isFinite(edit.top) ? edit.top : undefined,
        },
        base: prev ? prev.base : null,
        t: now,
    });
}

/** Drop `laneId`'s preview now (a gesture's start or cancel). */
export function clearPendingEdit(laneId) {
    pending.delete(laneId);
}

/** Drop every preview (tests; a new island). */
export function clearAllPendingEdits() {
    pending.clear();
}

/**
 * `laneId`'s preview as last set — { segments?, originShift?, top? } —
 * or null: none, or one past COMMIT_HOLD_MAX_MS (the next derive drops
 * it). A gesture that begins while an earlier one's commit is still in
 * flight BUILDS ON this instead of clearing it: cleared, the lane would
 * show the stale poll for a round trip, and a shift would take its base
 * from the pre-commit origin and never match (splice_handles.js).
 *
 * @param {string} laneId
 * @param {number} [now]
 * @returns {?{segments?: number[], originShift?: number, top?: number}}
 */
export function pendingEditOf(laneId, now = performance.now()) {
    const rec = pending.get(laneId);
    if (!rec || now - rec.t > COMMIT_HOLD_MAX_MS) return null;
    const out = {};
    if (rec.edit.segments) out.segments = rec.edit.segments.slice();
    if (rec.edit.originShift !== undefined) out.originShift = rec.edit.originShift;
    if (rec.edit.top !== undefined) out.top = rec.edit.top;
    return out;
}

/** Is any preview pending? (Tests.) */
export function hasPendingEdits() {
    return pending.size > 0;
}

/**
 * The previews for one derive — deriveViewModel's `pendingEdits` —
 * or null with none. Each resolves against the POLLED node: its shift
 * to what is still outstanding from its base; previews the engine has
 * answered, and expired ones, are dropped here.
 *
 * @param {function(string): ?Object} nodeOf  lane id → the polled node
 * @param {number} rootFrame  the polled state's root frame (islandZero):
 *                            bases are relative to it, so a seek mid-drag
 *                            moves them with every origin
 * @param {number} [now]
 * @param {boolean} [live]    a gesture is live (isGestureLive)
 * @returns {?Map<string, {segments?: number[], originShift?: number, top?: number}>}
 */
export function pendingEditsFor(nodeOf, rootFrame, now = performance.now(),
                                live = isGestureLive()) {
    if (!pending.size) return null;
    const out = new Map();
    for (const [id, rec] of [...pending]) {
        const node = nodeOf(id);
        if (!node) {
            pending.delete(id);  // the lane is gone
            continue;
        }
        if (live) rec.t = now;
        const { edit } = rec;
        if (edit.originShift !== undefined && !rec.base) {
            rec.base = { originRel: (node.origin || 0) - rootFrame };
        }
        const target = edit.originShift !== undefined
            ? rootFrame + rec.base.originRel + edit.originShift : null;
        if (!live && (answered(node, edit, target) ||
                      now - rec.t > COMMIT_HOLD_MAX_MS)) {
            pending.delete(id);
            continue;
        }
        const o = {};
        if (edit.segments) o.segments = edit.segments;
        if (edit.originShift !== undefined) o.originShift = target - (node.origin || 0);
        if (edit.top !== undefined) o.top = edit.top;
        out.set(id, o);
    }
    return out.size ? out : null;
}

/** Has the polled node landed on the preview? Every part the preview
 * sets must match: its segments against the node's published map
 * (time_map.publishedMap — run for run; none for none). */
function answered(node, edit, targetOrigin) {
    const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= MATCH_SAMPLES;
    if (edit.segments) {
        const flat = edit.segments;
        const { segs } = publishedMap(node);
        if (segs.length !== Math.floor(flat.length / 2)) return false;
        if (!segs.every(([s, e], i) => near(s, flat[2 * i]) && near(e, flat[2 * i + 1]))) {
            return false;
        }
    }
    if (targetOrigin !== null && !near(node.origin || 0, targetOrigin)) return false;
    if (edit.top !== undefined && !near(node.loopTop, edit.top)) return false;
    return true;
}
