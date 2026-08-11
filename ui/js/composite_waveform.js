/**
 * Composite Waveform Generator
 *
 * Generates a composite waveform for stack headers by layering each
 * child clip's peaks onto a unified timeline. Results are cached and
 * only regenerated when children change.
 */

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
export function buildCacheKey(stack, targetPeaks) {
    const cacheKeyParts = [];
    (stack.nodes || []).forEach(child => {
        if (child.type === 'clip') {
            cacheKeyParts.push([
                child.id,
                child.duration || 0,
                child.origin || 0,
                child.loopStart || 0,
                child.loopEnd || 0,
                // Window ACTIVATION changes audibility without moving the
                // loop points — it must invalidate the mixdown
                child.loopBypassed ? 1 : 0,
                // Multi-segment map (phase 3): the segment list shapes
                // what sounds — it must invalidate too.
                (child.segments || []).join('.')
            ].join(':'));
        }
    });
    return `${targetPeaks}:${stack.loopStart || 0}:${stack.loopEnd || 0}:` +
        `${(stack.segments || []).join('.')}:${cacheKeyParts.join(',')}`;
}

/**
 * Generate a composite waveform from a stack's children's live peaks.
 *
 * Each clip contributes peaks at its position within the LCM timeline.
 * Clips that loop within the timeline have their peaks repeated.
 *
 * KNOWN LIMITATION (documented, intentionally unfixed here): a child's
 * multi-segment map (`child.segments`, the phase-3 flat override) is
 * included in buildCacheKey — so segment edits DO invalidate the cache —
 * but the slicer below ignores it: only the single [loopStart, loopEnd)
 * window is honored when extracting the audible segment. A multi-cut
 * child therefore contributes its window-shaped (or full-take) peaks,
 * not its true cell-mode mixdown. Do NOT "fix" this unilaterally —
 * there is a matching engine-side story for the composite mixdown of
 * segmented children, and both sides should land together.
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
 * @returns {Array} Peak data array for the composite waveform
 */
export function generateCompositeWaveform({ stack, stackDuration, effectiveQ, canvasWidth, livePeaks, cache, excludeIds, epochSamples = 0 }) {
    // If backend provides waveform data, use it directly
    if (stack.waveform && stack.waveform.length > 0) {
        return stack.waveform;
    }

    if (!stack.nodes) return [];

    const targetPeaks = Math.ceil(canvasWidth * 2);
    // The key must include the children's PEAKS identity: after a commit
    // the live low-res peaks are replaced by the fetched waveform, and a
    // key without them left the composite stale until some unrelated
    // change (e.g. add-track) invalidated it — which then read as the
    // display "changing slightly" for no reason (field 2026-07-10).
    // RECORDING children are excluded entirely (sig + mixing): the
    // composite is COMMITTED material — folding a growing take in
    // regenerated it every poll and read as glitching (owner-confirmed).
    // Children whose REAL waveform hasn't been fetched yet (excludeIds)
    // are excluded too: blending a just-committed clip's live METER
    // peaks (different amplitude scale) re-normalized the composite to
    // near-zero until the fetch landed ("collapses to zero-ish when the
    // largest clip finishes" — field 2026-07-10).
    const skip = c => c.isRecording || (excludeIds && excludeIds.has(c.id));
    const peaksSig = (stack.nodes || [])
        .map(c => skip(c) ? 'r' : (livePeaks.get(c.id) || []).length)
        .join(',');
    const cacheKey = buildCacheKey(stack, targetPeaks) + '|' + peaksSig;

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

        // An ACTIVE window reduces the clip to its window segment looping
        // at the window length (E-C); otherwise the full take loops at
        // its duration. Field 2026-07-16d: the composite drew the whole
        // take — including the not-in-window half — for a windowed clip.
        // (KNOWN LIMITATION: multi-segment maps are NOT honored here —
        // see the function JSDoc before changing this.)
        const winActive = child.windowActive ??
            (!child.loopBypassed &&
                (child.loopEnd || 0) > (child.loopStart || 0));
        const segStart = winActive ? (child.loopStart || 0) : 0;
        const segLen = winActive
            ? (child.loopEnd || 0) - segStart
            : clipDuration;
        if (!(segLen > 0)) return;
        // Degenerate guard (mirrors unrollReps' maxTiles)
        if (stackDuration / segLen > MAX_SEGMENT_TILES) return;

        // Slice the segment's peaks out of the full-take peaks
        const clipPeakCount = childPeaks.length;
        const i0 = Math.max(0,
            Math.floor((segStart / clipDuration) * clipPeakCount));
        const i1 = Math.min(clipPeakCount, Math.max(i0 + 1,
            Math.ceil(((segStart + segLen) / clipDuration) * clipPeakCount)));
        const segPeaks = childPeaks.slice(i0, i1);
        const segCount = segPeaks.length;
        const segWidthPx = (segLen / stackDuration) * canvasWidth;

        // Map segment peaks as RANGES, not point samples: floor-indexed
        // point writes left every other slot empty whenever targetPeaks
        // exceeds the source resolution — a sparse comb whose holes read
        // as density collapse at some canvas widths (field 2026-07-10).
        const mapSegAt = (startPx) => {
            for (let i = 0; i < segCount; i++) {
                const px0 = startPx + (i / segCount) * segWidthPx;
                const px1 = startPx + ((i + 1) / segCount) * segWidthPx;
                const t0 = Math.max(0, Math.floor((px0 / canvasWidth) * targetPeaks));
                const t1 = Math.min(targetPeaks,
                    Math.max(t0 + 1, Math.ceil((px1 / canvasWidth) * targetPeaks)));
                const v = segPeaks[i] || 0;
                for (let t = t0; t < t1; t++) {
                    if (v > waveformData[t]) waveformData[t] = v;
                }
            }
        };

        // The segment sounds at positions ≡ its origin (mod its period),
        // in the epoch frame — tiled across the WHOLE cycle, INCLUDING
        // the wrapped predecessor before its first full repetition. (The
        // old forward-only tiling left everything before the offset
        // blank once origins stopped being ~0 — "the stack is blank for
        // the first 2Q", field 2026-07-16d.)
        const rel = (child.origin || 0) - epochSamples;
        const first = ((rel % segLen) + segLen) % segLen;
        for (let s = first - segLen; s < stackDuration; s += segLen) {
            mapSegAt((s / stackDuration) * canvasWidth);
        }
    });

    // Store in cache
    cache.set(stack.id, { key: cacheKey, peaks: waveformData });
    return waveformData;
}
