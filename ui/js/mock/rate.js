/**
 * mock/rate.js — the mock's SAMPLE RATE, as one systemic variable.
 *
 * TEST-ONLY. The engine threads the device rate everywhere (tasks.md
 * P0-5); every rate-dependent mock value derives from here, so there
 * is exactly one number to change and nothing can drift from it (the
 * published `perf.sampleRate` and the device panel must agree).
 *
 * Selecting a rate (all before the first scenario load — see below):
 *   - node:    CELESTRIAN_MOCK_RATE=48000 npm test
 *   - browser: index_test.html?rate=48000, /?mock=true&rate=96000
 *   - page:    window.__celestrianMockRate = 48000, set before the app's
 *              modules evaluate (Playwright: page.addInitScript). The
 *              e2e specs use THIS, not ?rate=, because the dev server's
 *              clean-urls redirect drops the query on index_test.html —
 *              which silently left the harness at 44100 during a sweep.
 *   - code:    setSampleRate(96000) — e.g. the mock device panel's
 *              setAudioDevice, which routes its rate argument here.
 *
 * ORDERING: scenario fixtures read the rate when loadScenario() runs
 * (not at module evaluation), so a setSampleRate() call is only fully
 * honored if it precedes the load. mock_backend.js boots a session at
 * import time — hence the env/URL hooks below, which land during this
 * module's own evaluation, ahead of everything.
 */

/** The rate the mock has always assumed, and still does by default. */
const DEFAULT_SAMPLE_RATE = 44100;

let sample_rate = DEFAULT_SAMPLE_RATE;

// --- rate selection at module load (test hooks, both harnesses) ---
{
    const fromEnv = typeof process !== 'undefined' && process.env
        ? Number(process.env.CELESTRIAN_MOCK_RATE) : 0;
    const fromUrl = typeof location !== 'undefined' && location.search
        ? Number(new URLSearchParams(location.search).get('rate')) : 0;
    const fromPage = typeof globalThis !== 'undefined'
        ? Number(globalThis.__celestrianMockRate) : 0;
    const chosen = [fromEnv, fromPage, fromUrl].find(r => r > 0) || 0;
    if (chosen > 0) {
        sample_rate = chosen;
        console.log('[MockBackend] Sample rate:', sample_rate, 'Hz (overridden)');
    }
}

/** The mock's current sample rate, in Hz. */
export function getSampleRate() {
    return sample_rate;
}

/** Set the mock's sample rate (ignores non-positive values, mirroring
 *  the engine's refusal to open a device at a bogus rate). Returns the
 *  rate in force afterwards. */
export function setSampleRate(hz) {
    if (hz > 0) sample_rate = hz;
    return sample_rate;
}

/** Seconds for a sample count, at the current rate. */
export function toSeconds(samples) {
    return samples / sample_rate;
}

/** Whole samples for a duration in seconds, at the current rate. */
export function toSamples(seconds) {
    return Math.round(seconds * sample_rate);
}

/**
 * The fixture quantum: ONE SECOND of audio at the current rate — what
 * every hand-written scenario meant when it said 44100. Scenario clip
 * lengths are multiples of this (1Q, 3Q, 4Q …), so the fixtures keep
 * their musical shape at any rate.
 */
export function quantumSamples() {
    return toSamples(1);
}
