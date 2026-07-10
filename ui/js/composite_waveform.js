/**
 * Composite Waveform Generator
 *
 * Generates a composite waveform for stack headers by layering each
 * child clip's peaks onto a unified timeline. Results are cached and
 * only regenerated when children change.
 */

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
                child.x || 0,
                child.loopStart || 0,
                child.loopEnd || 0,
                child.launchPoint || 0
            ].join(':'));
        }
    });
    return `${targetPeaks}:${stack.loopStart || 0}:${stack.loopEnd || 0}:${cacheKeyParts.join(',')}`;
}

/**
 * Generate a composite waveform from a stack's children's live peaks.
 *
 * Each clip contributes peaks at its position within the LCM timeline.
 * Clips that loop within the timeline have their peaks repeated.
 *
 * @param {Object} opts
 * @param {Object} opts.stack          - Stack node data (with .nodes children)
 * @param {number} opts.stackDuration  - LCM-based duration of the stack (samples)
 * @param {number} opts.effectiveQ     - Global quantum (samples)
 * @param {number} opts.canvasWidth    - Width of the canvas in pixels
 * @param {Map}    opts.livePeaks      - Map of nodeId → peak arrays
 * @param {Map}    opts.cache          - compositeWaveformCache Map (stackId → { key, peaks })
 * @returns {Array} Peak data array for the composite waveform
 */
export function generateCompositeWaveform({ stack, stackDuration, effectiveQ, canvasWidth, livePeaks, cache, excludeIds }) {
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

    // Each SETTLED clip contributes peaks at its position within the
    // timeline (recording and fetch-pending children are excluded — see
    // peaksSig above)
    (stack.nodes || []).forEach(child => {
        if (child.type !== 'clip' || skip(child) || !livePeaks.has(child.id)) return;

        const childPeaks = livePeaks.get(child.id);
        if (!childPeaks || childPeaks.length === 0) return;

        // Calculate this clip's position as a fraction of the LCM timeline
        const clipOffsetSamples = child.x || 0;  // x = anchor offset in samples
        const clipDuration = child.duration || effectiveQ;

        // Convert to pixel positions
        const clipStartPx = (clipOffsetSamples / stackDuration) * canvasWidth;
        const clipWidthPx = (clipDuration / stackDuration) * canvasWidth;

        // Map this clip's peaks into the composite as RANGES, not point
        // samples: floor-indexed point writes left every other slot
        // empty whenever targetPeaks exceeds the source resolution — a
        // sparse comb whose holes surfaced as density collapse at some
        // canvas widths (field 2026-07-10).
        const clipPeakCount = childPeaks.length;
        const mapClipAt = (startPx) => {
            for (let i = 0; i < clipPeakCount; i++) {
                const px0 = startPx + (i / clipPeakCount) * clipWidthPx;
                const px1 = startPx + ((i + 1) / clipPeakCount) * clipWidthPx;
                const t0 = Math.max(0, Math.floor((px0 / canvasWidth) * targetPeaks));
                const t1 = Math.min(targetPeaks,
                    Math.max(t0 + 1, Math.ceil((px1 / canvasWidth) * targetPeaks)));
                const v = childPeaks[i] || 0;
                for (let t = t0; t < t1; t++) {
                    if (v > waveformData[t]) waveformData[t] = v;
                }
            }
        };
        const clipStartPxBase = (clipOffsetSamples / stackDuration) * canvasWidth;
        mapClipAt(clipStartPxBase);

        // Handle looping: if clip loops within LCM, repeat peaks
        if (clipDuration < stackDuration && clipDuration > 0) {
            const numLoops = Math.ceil(stackDuration / clipDuration);
            for (let loopIdx = 1; loopIdx < numLoops && loopIdx < 10; loopIdx++) {
                const loopStartSamples = clipOffsetSamples + (loopIdx * clipDuration);
                if (loopStartSamples >= stackDuration) break;
                mapClipAt((loopStartSamples / stackDuration) * canvasWidth);
            }
        }
    });

    // Store in cache
    cache.set(stack.id, { key: cacheKey, peaks: waveformData });
    return waveformData;
}
