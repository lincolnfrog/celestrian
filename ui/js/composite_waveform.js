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
export function generateCompositeWaveform({ stack, stackDuration, effectiveQ, canvasWidth, livePeaks, cache }) {
    // If backend provides waveform data, use it directly
    if (stack.waveform && stack.waveform.length > 0) {
        return stack.waveform;
    }

    if (!stack.nodes) return [];

    const targetPeaks = Math.ceil(canvasWidth * 2);
    const cacheKey = buildCacheKey(stack, targetPeaks);

    // Check cache
    const cached = cache.get(stack.id);
    if (cached && cached.key === cacheKey) {
        return cached.peaks;
    }

    // Cache miss — regenerate composite waveform
    const waveformData = new Array(targetPeaks).fill(0);

    // Each clip contributes peaks at its position within the timeline
    (stack.nodes || []).forEach(child => {
        if (child.type !== 'clip' || !livePeaks.has(child.id)) return;

        const childPeaks = livePeaks.get(child.id);
        if (!childPeaks || childPeaks.length === 0) return;

        // Calculate this clip's position as a fraction of the LCM timeline
        const clipOffsetSamples = child.x || 0;  // x = anchor offset in samples
        const clipDuration = child.duration || effectiveQ;

        // Convert to pixel positions
        const clipStartPx = (clipOffsetSamples / stackDuration) * canvasWidth;
        const clipWidthPx = (clipDuration / stackDuration) * canvasWidth;

        // Map this clip's peaks to the correct position in the composite
        const clipPeakCount = childPeaks.length;
        for (let i = 0; i < clipPeakCount; i++) {
            const peakPctInClip = i / clipPeakCount;
            const pxInComposite = clipStartPx + (peakPctInClip * clipWidthPx);
            const targetIdx = Math.floor((pxInComposite / canvasWidth) * targetPeaks);

            if (targetIdx >= 0 && targetIdx < targetPeaks) {
                waveformData[targetIdx] = Math.max(waveformData[targetIdx], childPeaks[i] || 0);
            }
        }

        // Handle looping: if clip loops within LCM, repeat peaks
        if (clipDuration < stackDuration && clipDuration > 0) {
            const numLoops = Math.ceil(stackDuration / clipDuration);
            for (let loopIdx = 1; loopIdx < numLoops && loopIdx < 10; loopIdx++) {
                const loopStartSamples = clipOffsetSamples + (loopIdx * clipDuration);
                if (loopStartSamples >= stackDuration) break;

                const loopStartPx = (loopStartSamples / stackDuration) * canvasWidth;
                for (let i = 0; i < clipPeakCount; i++) {
                    const peakPctInClip = i / clipPeakCount;
                    const pxInComposite = loopStartPx + (peakPctInClip * clipWidthPx);
                    const targetIdx = Math.floor((pxInComposite / canvasWidth) * targetPeaks);

                    if (targetIdx >= 0 && targetIdx < targetPeaks) {
                        waveformData[targetIdx] = Math.max(waveformData[targetIdx], childPeaks[i] || 0);
                    }
                }
            }
        }
    });

    // Store in cache
    cache.set(stack.id, { key: cacheKey, peaks: waveformData });
    return waveformData;
}
