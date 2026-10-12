/**
 * mock/transport.js — the simulated clock (engine src/engine/
 * transport.cc): play / pause, the per-poll advance, the deterministic
 * advanceBy the tests step with, the seek, and the published cursor. The
 * clock is monotonic and never reset.
 */

import { posMod } from '../math_utils.js';
import {
    state, transport, DEFAULT_SAMPLES_PER_TICK, takeLive, frameOriginOf, shiftIsland,
} from './state.js';
import { effectiveCycle } from './cycles.js';
import { recView, growRecordingClips } from './recording.js';
import { reframeHistory } from './undo.js';

export { transport, DEFAULT_SAMPLES_PER_TICK };

/** The UI polls every ~50 ms, so the mock renders a constant amount of
 * simulated audio per wall-clock second whatever its rate: a real-time
 * spec reads how long a loop takes from this. */
const POLL_INTERVAL_MS = 50;
export const SIMULATED_SAMPLES_PER_SECOND =
    DEFAULT_SAMPLES_PER_TICK * (1000 / POLL_INTERVAL_MS);

export function togglePlayback() {
    state.isPlaying = !state.isPlaying;
    transport.running = state.isPlaying;
    return true;
}

/** One pass of the mock's "audio thread": the clock moves by `samples`
 * and the live takes with it; what the audio thread owes lands — an
 * arm's start, a first take's stop, a capturing new take's cancel —
 * even on a still clock. */
function advance(samples) {
    state.masterPos += samples;
    growRecordingClips(samples);
}

/** A POLL IS THE MOCK'S AUDIO CALLBACK (publish.js getState): one tick
 * of the clock while the transport runs, none while it does not. */
export function advanceTransport() {
    advance(transport.running ? Math.round(transport.samplesPerTick * transport.speed) : 0);
}

export function startTransport(speed = 1.0) {
    transport.running = true;
    transport.speed = speed;
    state.isPlaying = true;
}

export function pauseTransport() {
    transport.running = false;
}

/** Test hook: the test steps the clock (state.js `transport.stepped`). */
export function stepClock(on = true) {
    transport.stepped = !!on;
}

/** Advance by an exact sample count. */
export function advanceBy(samples) {
    advance(samples);
}

/** The ruler scrub (engine seekTransport): a phase advance — the zero
 * and every origin move BACK by it, the clock never. `atClock` is the
 * raw clock the view computed against; the answer says what was applied
 * and when. The history is re-framed with the island. */
export function seekTransport(deltaSamples, atClock) {
    if (recView.active || takeLive()) return false;
    let phase = Math.round(Number(deltaSamples) || 0);
    if (Number.isFinite(atClock)) phase -= state.masterPos - Math.round(atClock);
    if (phase !== 0) {
        shiftIsland(state, -phase);
        reframeHistory(-phase);
    }
    return { advance: phase, clock: state.masterPos };
}

/** The published masterPos (engine getGraphState): folded on the audible
 * cycle from the root's frame top at rest; linear from the frozen base
 * while a take is up. */
export function viewMasterPos() {
    if (recView.active) return recView.base + (state.masterPos - recView.anchor);
    return posMod(state.masterPos - frameOriginOf(state.root), effectiveCycle());
}
