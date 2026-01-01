
/**
 * pure math functions for UI visualization
 */

/**
 * Calculates the visual X-offset for a clip based on its phase and context.
 * 
 * @param {Object} params
 * @param {number} params.anchorPhase - The recorded phase of the clip (global samples)
 * @param {number} params.contextAnchorPhase - The phase of the context clip (global samples). Use 0 for global alignment.
 * @param {number} params.effectiveQ - Quantum size in samples
 * @param {number} params.wrapPeriod - Loop length of the context in samples
 * @param {number} [params.baseWidth=200] - Visual width of 1 Quantum in pixels
 * @param {number} [params.snapTolerance=0.10] - Tolerance for snapping to integer grid (0.0-1.0)
 * @returns {number} The calculated pixel offset
 */
export function calculateVisualOffset({
    anchorPhase,
    contextAnchorPhase = 0,
    effectiveQ,
    wrapPeriod,
    baseWidth = 200,
    snapTolerance = 0.10
}) {
    // If invalid context, return 0
    if (effectiveQ <= 0 || wrapPeriod <= 0) return 0;

    // 1. Relative Phase Calculation
    // Align visual grid to the start of the context clip (Anchor 0)
    const relPhase = anchorPhase - contextAnchorPhase;

    // 2. Wrap Phase to Loop
    // ((a % n) + n) % n handles negative numbers correctly in JS
    const wrappedAnchor = ((relPhase % wrapPeriod) + wrapPeriod) % wrapPeriod;

    // 3. Precise Ratio (float offset)
    let ratio = wrappedAnchor / effectiveQ;

    // 4. Intelligent Snap
    const nearestInt = Math.round(ratio);
    const dist = Math.abs(ratio - nearestInt);

    if (dist < snapTolerance) {
        ratio = nearestInt;

        // 5. Modulo Wrap (Snap Edge Case)
        // If we snapped to the End of the Loop (e.g. 2.0Q in a 2Q loop),
        // wrap it back to 0.0Q (Start)
        const maxQuanta = wrapPeriod / effectiveQ;
        if (Math.abs(ratio - maxQuanta) < 0.001) {
            ratio = 0;
        }
    }

    return ratio * baseWidth;
}
