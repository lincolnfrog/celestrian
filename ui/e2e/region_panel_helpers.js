/**
 * The loop-region fixtures live in helpers.js with the rest of the
 * shared e2e fixtures; this name re-exports them for the specs that
 * import it.
 *
 * Not a spec (no `.spec.` in the name): Playwright never runs it.
 */

export * from './helpers.js';
