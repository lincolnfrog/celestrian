/**
 * The reified time-map (time_maps.md §2) — JS mirror of src/time_map.h.
 *
 * A map is an ordered list of segments over a node's inner timeline;
 * today's loop window is the single-segment case, and the phase-3
 * cell/punch editor edits the same object with more segments. Every
 * consumer is segment-general NOW.
 *
 * Shape: { segs: [[start, end), ...] } in samples. Pure functions, no
 * state — pinned to the `time_map_cases` golden vectors in
 * shared/timing_golden.json alongside the C++ side.
 */

export const MAX_SEGMENTS = 8;

/** Today's loop window: one segment, empty when invalid. */
export function singleSegment(start, end) {
    return end > start ? { segs: [[start, end]] } : { segs: [] };
}

/**
 * Whether a map restricts anything: non-null with at least one segment.
 * An empty/absent map means "play the full inner timeline".
 *
 * @param {?{segs: Array<[number, number]>}} map
 * @returns {boolean}
 */
export function mapActive(map) {
    return !!(map && map.segs && map.segs.length > 0);
}

/**
 * Heard-time period of an ENGINE-FLAT segments array
 * `[s0, e0, s1, e1, ...]` (samples, as published on node metadata):
 * Σ (end − start). The companion of {@link mapPeriod}, which does the
 * same sum over the reified pair-list shape. The `length >= 4`
 * activity check ("is this a multi-segment override at all?") stays at
 * the call sites — a short or absent array is a semantic fact about the
 * node, not about this sum.
 *
 * @param {number[]} flatSegs  flat [start, end, start, end, ...] samples
 * @returns {number}           summed segment length in samples
 */
export function flatSegPeriod(flatSegs) {
    let p = 0;
    for (let i = 0; i + 1 < flatSegs.length; i += 2) {
        p += flatSegs[i + 1] - flatSegs[i];
    }
    return p;
}

/** Heard-time length of one map pass: Σ (end − start). */
export function mapPeriod(map) {
    if (!mapActive(map)) return 0;
    let p = 0;
    for (const [s, e] of map.segs) p += e - s;
    return p;
}

/**
 * walk_segments: a HEARD offset (any integer — folded mod period,
 * negatives included) → the inner-time offset it selects. The caller
 * re-bases into absolute time by adding the received cycle epoch.
 */
export function mapOffset(map, heardOff) {
    const p = mapPeriod(map);
    if (p <= 0) return heardOff;
    let h = ((heardOff % p) + p) % p;
    for (const [s, e] of map.segs) {
        const len = e - s;
        if (h < len) return s + h;
        h -= len;
    }
    return map.segs[0][0]; // unreachable: h < p by construction
}

/**
 * Inverse of mapOffset: the heard offset (within [0, period)) at which
 * the map visits inner position `inner`, or -1 when unvisited.
 */
export function heardOffsetOf(map, inner) {
    if (!mapActive(map)) return -1;
    let heard = 0;
    for (const [s, e] of map.segs) {
        if (inner >= s && inner < e) return heard + (inner - s);
        heard += e - s;
    }
    return -1;
}

/** A PUBLISHED node's window-activity verdict — the engine's
 * `windowActive` when the field is present, else derived exactly the
 * way the engine does (not bypassed, and either a multi-segment map or
 * a forward single window). ONE copy (audit 2026-08-30 §4.3): the
 * composite mixdown, the timeline period math and the VM's member
 * checks all read this instead of restating the fallback. */
export function nodeWindowActive(n) {
    return n.windowActive ?? (!n.loopBypassed &&
        ((Array.isArray(n.segments) && n.segments.length >= 4) ||
         (n.loopEnd || 0) > (n.loopStart || 0)));
}

/**
 * Samples from heardOff for which the map advances CONTINUOUSLY: the
 * distance to the end of the containing segment. Segment boundaries
 * always count as seams. Returns 0 when the map is inactive.
 */
export function seamDistance(map, heardOff) {
    const p = mapPeriod(map);
    if (p <= 0) return 0;
    let h = ((heardOff % p) + p) % p;
    for (const [s, e] of map.segs) {
        const len = e - s;
        if (h < len) return len - h;
        h -= len;
    }
    return 0; // unreachable
}
