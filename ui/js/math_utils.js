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
 * The single shared home for the fold across the view model, time-map,
 * and mock backend — never hand-roll `((x % m) + m) % m`. Mirrors
 * `timing::posMod` in src/qtime.h (the C++ form is overflow-safe: the
 * residue is lifted once, never re-folded).
 *
 * @param {number} x  value to wrap (may be negative)
 * @param {number} m  period, must be > 0
 * @returns {number}  x wrapped into [0, m)
 */
export const posMod = (x, m) => {
    const r = x % m;
    return r < 0 ? r + m : r + 0;  // `+ 0` normalizes −0 to 0
};

/**
 * A SHIFT AS HEARD: `x` folded to a loop's `period`, into (−period/2,
 * period/2]. A loop sounds the same moved by any whole period, so this
 * is the only part of a re-time anyone can hear (owner 2026-09-29: a
 * 2Q loop moved 13Q must read "1Q", never "13Q"). A non-positive
 * period leaves `x` as it is.
 *
 * @param {number} x       the shift (any unit, the period's)
 * @param {number} period  the loop's length in the same unit
 * @returns {number}
 */
export function foldShift(x, period) {
    if (!(period > 0) || !Number.isFinite(x)) return x;
    const r = posMod(x, period);
    return r > period / 2 + 1e-9 ? r - period : r;
}
