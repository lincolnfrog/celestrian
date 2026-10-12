/**
 * mock/rate.js — the mock's sample rate: the one number every
 * rate-dependent mock value derives from (fixture lengths, the
 * published `perf.sampleRate`, the device panel).
 *
 * Choose it BEFORE the first scenario load — fixtures read it at load:
 *   node     CELESTRIAN_MOCK_RATE=48000 npm test
 *   browser  ?rate=48000 (not on index_test.html: the dev server's
 *            clean-urls redirect drops the query)
 *   page     window.__celestrianMockRate = 48000 before the app's
 *            modules evaluate (Playwright: page.addInitScript)
 *   code     setSampleRate(96000) — the device panel's setAudioDevice
 */

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

/** The fixture quantum: one second of audio at the current rate. */
export function quantumSamples() {
    return toSamples(1);
}
