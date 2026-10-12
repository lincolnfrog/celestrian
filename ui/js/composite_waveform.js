/**
 * The composite waveform a GROUP LANE draws: the group's AUDIBLE
 * mixdown, built by layering each child clip's peaks onto the group's
 * timeline. A child contributes what it sounds, not what was recorded:
 * an active time map reduces it to the map's content, looping at the
 * map period (time_map.js). Cached per stack, and rebuilt only when
 * something that shapes the picture changes — a rebuilt array is a new
 * identity, and the lane cross-fades every new identity.
 */

import { posMod } from './math_utils.js';
import { nodeWindowActive, publishedMap } from './time_map.js';

// A slice so short against the stack cycle that it would tile more
// than this many times is left out rather than exploding the loop
// (as unrollReps' maxTiles does for lanes).
const MAX_SEGMENT_TILES = 256;

/**
 * THE MIXDOWN'S MEMBERSHIP — one predicate for the cache key, the
 * peaks signature and the mixdown: the composite is COMMITTED material.
 * Out are a hot child (armed or capturing: its duration grows every
 * poll, and a key carrying it would rebuild the composite every poll)
 * and a child whose real waveform has not landed (`excludeIds`: its
 * live METER peaks are on another amplitude scale and would renormalize
 * the mixdown toward nothing).
 */
export function skippedInComposite(child, excludeIds = null) {
    return !!(child.isRecording || child.isPendingStart ||
              (excludeIds && excludeIds.has(child.id)));
}

/**
 * The cache key: everything about the stack's children that shapes the
 * picture, and nothing else.
 *
 * - Positions are RELATIVE: the mixdown places a child at
 *   `origin − frameZero`, so that difference is what the key carries.
 *   A shift of the whole subtree (a re-anchor, a seek) moves both by
 *   the same amount and leaves the key alone.
 * - RAW mode keys on the material's identity only: a re-trim moves Q,
 *   the zero and the window on every release, and must not rebuild.
 * - The stack's OWN window is not in the mixdown (the lane applies it
 *   over the picture), so it is not in the key.
 *
 * @param {Object} stack the stack node
 * @param {number} targetPeaks the composite's peak count
 * @param {Object} [opts] { raw, stackDuration, frameZero, excludeIds }
 * @returns {string}
 */
export function buildCacheKey(stack, targetPeaks, opts = {}) {
    const { raw = false, stackDuration = 0, frameZero = 0, excludeIds = null } = opts;
    const cacheKeyParts = [];
    (stack.nodes || []).forEach(child => {
        if (child.type === 'clip') {
            if (skippedInComposite(child, excludeIds)) {
                cacheKeyParts.push(child.id + ':skip');
                return;
            }
            if (raw) {
                cacheKeyParts.push([child.id, child.duration || 0].join(':'));
                return;
            }
            cacheKeyParts.push([
                child.id,
                child.duration || 0,
                (child.origin || 0) - frameZero,
                child.loopStart || 0,
                child.loopEnd || 0,
                // Activation changes what sounds without moving the
                // loop points. Tri-state: a published windowActive
                // drives the slicer directly; 'u' (unpublished) falls
                // back to the derived check, and the two must not
                // collide in the key.
                child.loopBypassed ? 1 : 0,
                child.windowActive === undefined ? 'u'
                    : (child.windowActive ? 1 : 0),
                (child.segments || []).join('.')
            ].join(':'));
        }
    });
    return `${targetPeaks}:${raw ? 'raw' : 'map'}:${stackDuration}:` +
        `${cacheKeyParts.join(',')}`;
}

/**
 * The composite peaks of `stack`, from the cache or rebuilt.
 *
 * @param {Object} opts
 * @param {Object} opts.stack          the stack node (with .nodes)
 * @param {number} opts.stackDuration  the stack's cycle, samples
 * @param {number} opts.effectiveQ     Q, samples
 * @param {number} opts.canvasWidth    the raster's width in px (the
 *                                     composite holds two peaks per px);
 *                                     the lane stretches it over its tiles
 * @param {Map}    opts.livePeaks      node id → peak array
 * @param {Map}    opts.cache          stack id → { key, peaks }
 * @param {?Set<string>} opts.excludeIds  children left out
 *                                     (skippedInComposite)
 * @param {number} [opts.frameZero=0]  the absolute sample drawn at
 *                                     x = 0: the stack's own origin for
 *                                     an anchored stack, else the frame
 *                                     zero the view seats. Child
 *                                     origins are absolute.
 * @param {boolean} [opts.raw=false]   RAW MATERIAL mode (the Q-definer
 *                                     trim view): every child draws its
 *                                     WHOLE take once, from 0, ignoring
 *                                     windows, origins and the zero —
 *                                     what the member lanes beneath
 *                                     draw.
 * @returns {Array} the composite's peaks
 */
export function generateCompositeWaveform({ stack, stackDuration, effectiveQ, canvasWidth, livePeaks, cache, excludeIds, frameZero = 0, raw = false }) {
    if (!stack.nodes) return [];

    const targetPeaks = Math.ceil(canvasWidth * 2);
    const skip = c => skippedInComposite(c, excludeIds);
    // The key carries the children's PEAKS identity too: at a commit
    // the fetched waveform replaces the live array, and the composite
    // must follow.
    const peaksSig = (stack.nodes || [])
        .map(c => skip(c) ? 'r' : (livePeaks.get(c.id) || []).length)
        .join(',');
    const cacheKey = buildCacheKey(stack, targetPeaks,
        { raw, stackDuration, frameZero, excludeIds }) + '|' + peaksSig;

    const cached = cache.get(stack.id);
    if (cached && cached.key === cacheKey) {
        return cached.peaks;
    }

    const waveformData = new Array(targetPeaks).fill(0);

    (stack.nodes || []).forEach(child => {
        if (child.type !== 'clip' || skip(child) || !livePeaks.has(child.id)) return;

        const childPeaks = livePeaks.get(child.id);
        if (!childPeaks || childPeaks.length === 0) return;
        const clipDuration = child.duration || effectiveQ;
        if (!(clipDuration > 0) || !(stackDuration > 0)) return;

        // The child's audible slices on its inner timeline, in heard
        // order ([innerStart, len], samples): its active map's
        // segments, else the whole take.
        const slices = !raw && nodeWindowActive(child)
            ? publishedMap(child).segs.map(([s, e]) => [s, e - s])
            : [[0, clipDuration]];
        // One pass of the map: its period.
        const heardLen = slices.reduce((n, sl) => n + sl[1], 0);
        if (!(heardLen > 0)) return;
        if (stackDuration / heardLen > MAX_SEGMENT_TILES) return;

        const clipPeakCount = childPeaks.length;
        const sliceData = slices.map(([start, len]) => {
            const i0 = Math.max(0,
                Math.floor((start / clipDuration) * clipPeakCount));
            const i1 = Math.min(clipPeakCount, Math.max(i0 + 1,
                Math.ceil(((start + len) / clipDuration) * clipPeakCount)));
            return { peaks: childPeaks.slice(i0, i1), len };
        });

        // Each slice peak covers a RANGE of the composite, max-pooled:
        // point writes would leave holes wherever the composite is
        // denser than the source.
        const mapSliceAt = (slicePeaks, startPx, widthPx) => {
            const n = slicePeaks.length;
            for (let i = 0; i < n; i++) {
                const px0 = startPx + (i / n) * widthPx;
                const px1 = startPx + ((i + 1) / n) * widthPx;
                // Off-raster peaks (the wrapped tile before 0, or past
                // the end) contribute nothing; clamped in, they would
                // all pool into the edge slot.
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

        // THE ANCHORING LAW (time_map.js innerAt): a map's pass begins
        // where its first slice was performed — at origin + a0, a0 the
        // first slice's inner start — so the passes sit at positions
        // ≡ origin + a0 (mod the period), measured from frameZero.
        // Anchored at the bare origin, a window starting off a whole
        // period would draw the group a0 off its own member lane.
        // The passes tile the WHOLE cycle, the wrapped one before the
        // first full repetition included. In raw mode the take sits at
        // 0, one tile.
        const rel = raw ? 0 : (child.origin || 0) + slices[0][0] - frameZero;
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

    cache.set(stack.id, { key: cacheKey, peaks: waveformData });
    return waveformData;
}
