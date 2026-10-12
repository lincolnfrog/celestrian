/**
 * PENDING EDITS (session_view/pending_edits.js): a gesture's preview,
 * applied to shallow clones of the edited nodes before anything is
 * derived, so the seat, the tiles and the lane fields follow the pointer
 * with no bridge round trip. Each override takes the shape the backend
 * PUBLISHES once the edit lands, so the preview and the landed state
 * derive alike:
 *
 *   segments     flat samples. Two or more pairs publish `segments` with
 *                loopStart = loopEnd = 0; one pair publishes loopStart /
 *                loopEnd and no `segments`; none clears the map.
 *                `windowActive` follows: a map, not bypassed — and, on a
 *                stack, not suspended.
 *   originShift  samples; moves `origin` and `retime` together
 *                (setTiming's effect).
 *   top          raw samples; sets `loopTop`.
 */

/**
 * `state` with `edits` applied — a Map (or plain object) of lane id →
 * override. The state and each node on an edited node's path are
 * cloned; nothing else is touched, and with nothing to apply the state
 * comes back as is. deriveViewModel calls this for opts.pendingEdits;
 * exported for the tests.
 */
export function applyPendingEdits(state, edits) {
    const byId = edits instanceof Map ? edits
        : new Map(Object.entries(edits || {}));
    if (!byId.size) return state;
    const walk = ns => {
        let changed = false;
        const out = (ns || []).map(n => {
            let c = n;
            if (n.type === 'stack' && Array.isArray(n.nodes)) {
                const kids = walk(n.nodes);
                if (kids !== n.nodes) c = { ...n, nodes: kids };
            }
            const e = byId.get(n.id);
            if (e) c = withPendingEdit(c === n ? { ...n } : c, e);
            if (c !== n) changed = true;
            return c;
        });
        return changed ? out : ns;
    };
    const nodes = walk(state.nodes);
    return nodes === state.nodes ? state : { ...state, nodes };
}

/** One override onto a node clone `c` (mutated and returned). */
function withPendingEdit(c, e) {
    if (Array.isArray(e.segments)) {
        const n = Math.floor(e.segments.length / 2);
        if (n >= 2) {
            c.segments = e.segments.slice(0, 2 * n);
            c.loopStart = 0;
            c.loopEnd = 0;
        } else {
            delete c.segments;
            c.loopStart = n === 1 ? e.segments[0] : 0;
            c.loopEnd = n === 1 ? e.segments[1] : 0;
        }
        c.windowActive = n > 0 && !c.loopBypassed &&
            !(c.type === 'stack' && c.windowSuspended);
    }
    if (Number.isFinite(e.originShift) && e.originShift !== 0) {
        c.origin = (c.origin || 0) + e.originShift;
        c.retime = (Number.isFinite(c.retime) ? c.retime : 0) + e.originShift;
    }
    if (Number.isFinite(e.top)) c.loopTop = e.top;
    return c;
}
