/**
 * math_utils.js — pure integer/period math shared across the UI.
 *
 * These helpers back the timeline's period arithmetic (LCM cycle folding,
 * phase wrapping). They are dependency-free and safe to import from both
 * browser modules and node unit tests.
 */

/**
 * Greatest common divisor (Euclid).
 *
 * Precondition: both arguments should be non-negative integers. Floats or
 * negatives recurse on `%` and can misbehave — callers working in sample
 * space round first (see timelineLcm in timeline_model.js).
 *
 * @param {number} a  non-negative integer
 * @param {number} b  non-negative integer
 * @returns {number}
 */
export const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);

/**
 * Least common multiple. Returns the larger value if either is zero.
 *
 * Uses the overflow-friendlier `(a / gcd) * b` form. Same integer
 * precondition as {@link gcd}.
 *
 * @param {number} a  non-negative integer
 * @param {number} b  non-negative integer
 * @returns {number}
 */
export const lcm = (a, b) => (a === 0 || b === 0) ? Math.max(a, b) : Math.abs((a / gcd(a, b)) * b);

/**
 * Positive modulo: wraps `x` into [0, m) even when `x` is negative.
 *
 * The `((x % m) + m) % m` idiom previously appeared inline at 20+ call
 * sites across the view model, time-map, and mock backend; this is the
 * single shared home for it.
 *
 * @param {number} x  value to wrap (may be negative)
 * @param {number} m  period, must be > 0
 * @returns {number}  x wrapped into [0, m)
 */
export const posMod = (x, m) => ((x % m) + m) % m;

// (calculateVisualOffset was deleted 2026-07-16: dead since the session
// view — lane x is a projection of `origin` in view_model.js, and the
// stored anchorPhase it consumed no longer exists.)
