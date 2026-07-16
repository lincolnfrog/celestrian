
/**
 * pure math functions for UI visualization
 */

/**
 * Greatest common divisor.
 */
export const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);

/**
 * Least common multiple. Returns the larger value if either is zero.
 */
export const lcm = (a, b) => (a === 0 || b === 0) ? Math.max(a, b) : Math.abs((a / gcd(a, b)) * b);

// (calculateVisualOffset was deleted 2026-07-16: dead since the session
// view — lane x is a projection of `origin` in view_model.js, and the
// stored anchorPhase it consumed no longer exists.)
