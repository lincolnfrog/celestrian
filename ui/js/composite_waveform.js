/**
 * Composite Waveform Generator
 *
 * Generates the composite waveform a GROUP LANE draws (the session
 * view's group row tiles, lane_body.js) by layering each child clip's
 * peaks onto a unified timeline. Results are cached and only
 * regenerated when children change.
 *
 * The composite is the group's AUDIBLE mixdown: each child contributes
 * what it sounds, not what was recorded. A child's active time-map
 * (single loop window or phase-3 multi-segment override) reduces it to
 * the map's content — the segments' material concatenated in heard
 * order, looping at the map period (Σ segment lengths), mirroring
 * time_map.js mapOffset's walk.
 */

import { posMod } from './math_utils.js';
import { nodeWindowActive } from './time_map.js';

// Degenerate-frame guard (mirrors unrollReps' maxTiles): a segment so
// short relative to the stack cycle that it would tile more than this
// many times is skipped rather than exploding the mixdown loop.
const MAX_SEGMENT_TILES = 256;

/**
 * Build a cache key from the stack's child state. The key invalidates
 * whenever any child property that affects the composite appearance changes.
 *
 * @param {Object} stack - The stack node data
 * @param {number} targetPeaks - Number of target peaks for the composite
 * @returns {string} A cache key string
 */
export function buildCacheKey(stack, targetPeaks, opts = {}) {
    const { raw = false, stackDuration = 0, epochSamples = 0 } = opts;
    const cacheKeyParts = [];
    (stack.nodes || []).forEach(child => {
        if (child.type === 'clip') {
            // RAW mode (the definer trim view): only the material's
            // identity matters — windows, origins and the epoch are
            // deliberately NOT in the key, so a re-trim (which moves
            // Q, the epoch and the window every release) never
            // regenerates the composite. A regenerated array is a new
            // identity, and drawRepCanvas cross-fades every new
            // identity — the definer's waveform would flicker on each
            // handle release.
            if (raw) {
                cacheKeyParts.push([child.id, child.duration || 0].join(':'));
                return;
            }
            cacheKeyParts.push([
                child.id,
                child.duration || 0,
                child.origin || 0,
                child.loopStart || 0,
                child.loopEnd || 0,
                // Window ACTIVATION changes audibility without moving the
                // loop points — it must invalidate the mixdown. Tri-state:
                // an engine that publishes windowActive drives the slicer
                // directly; 'u' (undefined) falls back to the derived
                // bypass check, and the two must not collide in the key.
                child.loopBypassed ? 1 : 0,
                child.windowActive === undefined ? 'u'
                    : (child.windowActive ? 1 : 0),
                // Multi-segment map (phase 3): the segment list shapes
                // what sounds — it must invalidate too.
                (child.segments || []).join('.')
            ].join(':'));
        }
    });
    // The stack's OWN window is not part of the mixdown (the composite
    // spans the stack's intrinsic extent; the lane's srcSegs/dims apply
    // the window over it) — it is not in the key either, so a window
    // edit on the group never regenerates the picture underneath. The
    // tiling inputs that DO shape the picture (extent, epoch frame) are.
    return `${targetPeaks}:${raw ? 'raw' : 'map'}:${stackDuration}:` +
        `${raw ? 0 : epochSamples}:${cacheKeyParts.join(',')}`;
}

/**
 * Generate a composite waveform from a stack's children's live peaks.
 *
 * Each clip contributes peaks at its position within the LCM timeline.
 * Clips that loop within the timeline have their peaks repeated.
 *
 * Time-map honoring: an active multi-segment map contributes its
 * segments' material concatenated in heard order, looping at the map
 * period — the visual twin of mapOffset's walk in time_map.js, and of
 * the per-lane heard view's `srcSegs` rendering. Cut-out material
 * never appears in the mixdown (the engine PLAYS segments this way).
 *
 * @param {Object} opts
 * @param {Object} opts.stack          - Stack node data (with .nodes children)
 * @param {number} opts.stackDuration  - LCM-based duration of the stack (samples)
 * @param {number} opts.effectiveQ     - Global quantum (samples)
 * @param {number} opts.canvasWidth    - Width of the canvas in pixels
 * @param {Map}    opts.livePeaks      - Map of nodeId → peak arrays
 * @param {Map}    opts.cache          - compositeWaveformCache Map (stackId → { key, peaks })
 * @param {?Set<string>} opts.excludeIds - Child ids whose REAL waveform fetch
 *                                       hasn't landed yet; excluded from the
 *                                       mixdown AND the cache signature (their
 *                                       live meter peaks use a different
 *                                       amplitude scale — see peaksSig note).
 * @param {number} [opts.epochSamples=0] - Island epoch (samples): origins are
 *                                       ABSOLUTE, and segments tile at
 *                                       positions ≡ origin (mod period) in
 *                                       the EPOCH frame.
 * @param {boolean} [opts.raw=false]   - RAW MATERIAL mode (the Q-definer
 *                                       trim view): every child draws its
 *                                       WHOLE take once, from 0, ignoring
 *                                       windows, origins and the epoch —
 *                                       the mixdown of the buffer the
 *                                       selection brackets select over,
 *                                       exactly what the member lanes
 *                                       beneath draw (a heard mixdown
 *                                       under the raw selection would
 *                                       disagree with the children and
 *                                       re-shape on every trim).
 * @returns {Array} Peak data array for the composite waveform
 */
export function generateCompositeWaveform({ stack, stackDuration, effectiveQ, canvasWidth, livePeaks, cache, excludeIds, epochSamples = 0, raw = false }) {
    // No published shortcut exists: neither the engine nor the mock
    // publishes a `waveform` on stacks — the mixdown is always built
    // here from the children's peaks.
    if (!stack.nodes) return [];

    const targetPeaks = Math.ceil(canvasWidth * 2);
    // The key must include the children's PEAKS identity: after a commit
    // the live low-res peaks are replaced by the fetched waveform, and a
    // key without them would leave the composite stale until some
    // unrelated change invalidated it.
    // RECORDING children are excluded entirely (sig + mixing): the
    // composite is COMMITTED material — folding a growing take in would
    // regenerate it every poll (visible glitching).
    // Children whose REAL waveform hasn't been fetched yet (excludeIds)
    // are excluded too: blending a just-committed clip's live METER
    // peaks (different amplitude scale) would re-normalize the
    // composite to near-zero until the fetch lands.
    const skip = c => c.isRecording || (excludeIds && excludeIds.has(c.id));
    const peaksSig = (stack.nodes || [])
        .map(c => skip(c) ? 'r' : (livePeaks.get(c.id) || []).length)
        .join(',');
    const cacheKey = buildCacheKey(stack, targetPeaks,
        { raw, stackDuration, epochSamples }) + '|' + peaksSig;

    // Check cache
    const cached = cache.get(stack.id);
    if (cached && cached.key === cacheKey) {
        return cached.peaks;
    }

    // Cache miss — regenerate composite waveform
    const waveformData = new Array(targetPeaks).fill(0);

    // Each SETTLED clip contributes its AUDIBLE content — the composite
    // is the group's mixdown, so it shows what SOUNDS, not what was
    // recorded. (Recording and fetch-pending children are excluded —
    // see peaksSig above.)
    (stack.nodes || []).forEach(child => {
        if (child.type !== 'clip' || skip(child) || !livePeaks.has(child.id)) return;

        const childPeaks = livePeaks.get(child.id);
        if (!childPeaks || childPeaks.length === 0) return;
        const clipDuration = child.duration || effectiveQ;
        if (!(clipDuration > 0) || !(stackDuration > 0)) return;

        // The child's AUDIBLE slices on its inner timeline, in heard
        // order. An ACTIVE multi-segment map (phase 3) contributes its
        // segments concatenated; an active single window reduces to its
        // [loopStart, loopEnd) slice (never the not-in-window half);
        // otherwise the full take loops at its duration. `windowActive`
        // is the engine's published verdict; nodeWindowActive derives
        // it for states without the field.
        const hasMultiSeg = !raw && Array.isArray(child.segments) &&
            child.segments.length >= 4;
        // One activity verdict (time_map.nodeWindowActive) — the
        // engine's published field, else its exact derivation.
        const mapOn = !raw && nodeWindowActive(child);
        const slices = []; // [innerStart, len] samples, heard order
        if (mapOn && hasMultiSeg) {
            for (let i = 0; i + 1 < child.segments.length; i += 2) {
                const s = child.segments[i];
                const e = child.segments[i + 1];
                if (e > s) slices.push([s, e - s]);
            }
        } else if (mapOn) {
            const s = child.loopStart || 0;
            slices.push([s, (child.loopEnd || 0) - s]);
        } else {
            slices.push([0, clipDuration]);
        }
        // Heard-time period of one pass: Σ slice lengths (the map
        // period — mirrors time_map.js flatSegPeriod/mapPeriod).
        const heardLen = slices.reduce((n, sl) => n + sl[1], 0);
        if (!(heardLen > 0)) return;
        // Degenerate guard (mirrors unrollReps' maxTiles)
        if (stackDuration / heardLen > MAX_SEGMENT_TILES) return;

        // Slice each segment's peaks out of the full-take peaks
        const clipPeakCount = childPeaks.length;
        const sliceData = slices.map(([start, len]) => {
            const i0 = Math.max(0,
                Math.floor((start / clipDuration) * clipPeakCount));
            const i1 = Math.min(clipPeakCount, Math.max(i0 + 1,
                Math.ceil(((start + len) / clipDuration) * clipPeakCount)));
            return { peaks: childPeaks.slice(i0, i1), len };
        });

        // Map slice peaks as RANGES, not point samples: floor-indexed
        // point writes leave every other slot empty whenever targetPeaks
        // exceeds the source resolution — a sparse comb whose holes read
        // as density collapse at some canvas widths.
        const mapSliceAt = (slicePeaks, startPx, widthPx) => {
            const n = slicePeaks.length;
            for (let i = 0; i < n; i++) {
                const px0 = startPx + (i / n) * widthPx;
                const px1 = startPx + ((i + 1) / n) * widthPx;
                // Off-canvas peaks (the wrapped predecessor tile before
                // 0, or past the end) contribute nothing — without this
                // every peak left of 0 max-pooled into slot 0.
                if (px1 <= 0 || px0 >= canvasWidth) continue;
                const t0 = Math.max(0, Math.floor((px0 / canvasWidth) * targetPeaks));
                const t1 = Math.min(targetPeaks,
                    Math.max(t0 + 1, Math.ceil((px1 / canvasWidth) * targetPeaks)));
                const v = slicePeaks[i] || 0;
                for (let t = t0; t < t1; t++) {
                    if (v > waveformData[t]) waveformData[t] = v;
                }
            }
        };

        // The map sounds at positions ≡ its origin (mod its heard
        // period), in the epoch frame — tiled across the WHOLE cycle,
        // INCLUDING the wrapped predecessor before its first full
        // repetition (forward-only tiling would leave everything before
        // the offset blank for a non-zero origin). Within each pass the
        // slices land back-to-back at their heard
        // offsets, each keeping its true sample proportion — exactly
        // mapOffset's segment walk, drawn.
        // RAW mode: the buffer sits at 0 — one tile, the trim view's
        // frame (the member lanes tile the same way: "one full tile
        // from 0 — the trim view ignores the epoch").
        const rel = raw ? 0 : (child.origin || 0) - epochSamples;
        const first = posMod(rel, heardLen);
        for (let s = first - heardLen; s < stackDuration; s += heardLen) {
            let heardOff = 0;
            for (const sl of sliceData) {
                mapSliceAt(sl.peaks,
                    ((s + heardOff) / stackDuration) * canvasWidth,
                    (sl.len / stackDuration) * canvasWidth);
                heardOff += sl.len;
            }
        }
    });

    // Store in cache
    cache.set(stack.id, { key: cacheKey, peaks: waveformData });
    return waveformData;
}
