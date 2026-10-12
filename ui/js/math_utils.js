/**
 * Pure integer / period math shared across the UI. No imports: safe
 * from browser modules and node tests alike.
 */

/** Greatest common divisor (Euclid) of two non-negative INTEGERS. Floats
 * and negatives misbehave under `%`: callers in sample space round
 * first. */
export const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);

/** Least common multiple of two non-negative integers; the larger one
 * when either is zero. */
export const lcm = (a, b) => (a === 0 || b === 0) ? Math.max(a, b) : Math.abs((a / gcd(a, b)) * b);

/**
 * Positive modulo: `x` folded into [0, m), negatives included — the one
 * home of the fold (never hand-roll `((x % m) + m) % m`). Mirrors
 * timing::posMod in src/qtime.h and is TOTAL like it: a period that is
 * not positive folds nothing, and `x` comes back. A negative residue
 * smaller than `m`'s float spacing would lift to `m` itself; it folds
 * to 0.
 */
export const posMod = (x, m) => {
    if (!(m > 0)) return x;
    const r = x % m;
    if (!(r < 0)) return r + 0;  // `+ 0` normalizes −0 to 0
    const lifted = r + m;
    return lifted < m ? lifted : 0;
};

/**
 * A SHIFT AS HEARD: `x` folded to a loop's `period`, into
 * (−period/2, period/2] — `x` and `period` in one unit. A loop sounds
 * the same moved by any whole period, so this is the only part of a
 * re-time anyone can hear (a 2Q loop moved 13Q reads "1Q"). A
 * non-positive period leaves `x` as it is.
 */
export function foldShift(x, period) {
    if (!(period > 0) || !Number.isFinite(x)) return x;
    const r = posMod(x, period);
    return r > period / 2 + 1e-9 ? r - period : r;
}
