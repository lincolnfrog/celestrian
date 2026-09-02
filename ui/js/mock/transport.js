/**
 * mock/transport.js — the simulated clock: play/pause, auto-advance on
 * getState polls, deterministic advanceBy stepping for tests, and the
 * published masterPos view (wrapped on the effective cycle at rest,
 * linear from the frozen base while recording).
 */

// --- Transport Simulation ---
// Simulates the C++ audio engine advancing masterPos and recording clip duration.
// Auto-advance mode hooks into getState() polls (a fixed sample step).
// Deterministic mode uses advanceBy() for exact sample-count stepping.

import { posMod } from '../math_utils.js';
import { state, effectiveQuantumForState, shiftOrigins } from './state.js';
import { effectiveCycle } from './cycles.js';
import { recView, growRecordingClips } from './recording.js';

/**
 * The simulation STEP: how far the clock moves per getState() poll.
 * Deliberately a fixed SAMPLE COUNT, NOT derived from the mock's sample
 * rate (mock/rate.js) — even though 2205 was originally chosen as
 * ~50 ms at 44.1 kHz.
 *
 * Why not derive it: a test that plays and then polls reads the clock
 * at multiples of this step, so a rate-derived step would move those
 * positions under a rate sweep and flip outcomes that fold on them
 * (map_anchor's cut then lands in a different Q). A mock tick is a
 * simulation step, not a wall-clock duration — keeping it in samples is
 * what lets the rest of the rate generalization sweep cleanly.
 */
export const DEFAULT_SAMPLES_PER_TICK = 2205;

/**
 * The UI polls every ~50 ms, so a fixed step means the mock renders a
 * CONSTANT amount of simulated audio per wall-clock second, whatever
 * the device rate is. Real-time specs (the dead-reckoning playhead
 * sweep) need this to know how long a loop takes on the wall clock:
 * `loopSeconds = loopSamples / SIMULATED_SAMPLES_PER_SECOND`.
 */
const POLL_INTERVAL_MS = 50;
export const SIMULATED_SAMPLES_PER_SECOND =
    DEFAULT_SAMPLES_PER_TICK * (1000 / POLL_INTERVAL_MS);

export const transport = {
    running: false,                            // Is transport auto-advancing?
    samplesPerTick: DEFAULT_SAMPLES_PER_TICK,  // simulation step, in samples
    speed: 1.0                                 // Speed multiplier (1.0 = real-time)
};

// Mirrors AudioEngine::togglePlayback — pause/resume: the clock is
// never reset (kernel.md); stopping freezes the view where it is.
export function togglePlayback() {
    state.isPlaying = !state.isPlaying;
    transport.running = state.isPlaying;
    console.log('[MockBackend] togglePlayback →', state.isPlaying);
    return true;
}

// Called on every getState() poll when transport is running
export function advanceTransport() {
    if (!transport.running) return;

    const advance = Math.round(transport.samplesPerTick * transport.speed);
    state.masterPos = state.masterPos + advance;
    growRecordingClips(state.nodes, advance);
}

// Start auto-advancing transport (hooks into getState polls)
export function startTransport(speed = 1.0) {
    transport.running = true;
    transport.speed = speed;
    state.isPlaying = true;
    console.log(`[MockBackend] Transport started (speed=${speed})`);
}

// Pause auto-advancing transport
export function pauseTransport() {
    transport.running = false;
    console.log('[MockBackend] Transport paused');
}

/**
 * Ruler scrub (engine parity: AudioEngine::seekTransport). The target
 * arrives in the published-masterPos domain — epoch-relative samples,
 * folded on the audible cycle. The mock's clock is monotonic like the
 * engine's (kernel.md), so a seek RE-BASES islandEpoch rather than
 * touching masterPos: epoch := raw − pos, and viewMasterPos then reads
 * exactly the requested phase. Refused (false) while any take is live
 * or armed — takes place audio by the clock. NOT undoable (a
 * monitoring gesture — keep it out of mock/undo.js's intercept set).
 */
export function seekTransport(posSamples) {
    if (recView.active || anyClipHot(state.nodes)) return false;
    const Q = effectiveQuantumForState();
    const cycle = effectiveCycle(Q);
    let pos = Math.round(Number(posSamples) || 0);
    if (cycle > 0) pos = posMod(pos, cycle);
    else if (pos < 0) pos = 0;
    const epochOld = state.islandEpoch || 0;
    state.islandEpoch = state.masterPos - pos;
    // A seek is a phase jump of the whole island (composition.md §5,
    // engine parity AudioEngine::seekTransport): every origin — clips
    // AND stacks (Q18) — rides the epoch delta, so placement on the
    // grid (origin − epoch) is unchanged and playback lands at the
    // requested phase. shiftOrigins(root, delta) is the one primitive.
    const delta = state.islandEpoch - epochOld;
    if (delta !== 0) state.nodes.forEach(n => shiftOrigins(n, delta));
    console.log(`[MockBackend] seekTransport → rel=${pos} (epoch=${state.islandEpoch})`);
    return true;
}

/** Any clip live or armed anywhere in the graph (the engine's
 * hasActiveTake ∨ isArmedOrRecording twin). */
function anyClipHot(nodes) {
    return (nodes || []).some(n =>
        n.isRecording || n.isPendingStart || anyClipHot(n.nodes));
}

// Deterministic advance by exact sample count (for reliable test assertions)
export function advanceBy(samples) {
    state.masterPos = state.masterPos + samples;
    growRecordingClips(state.nodes, samples);
    console.log(`[MockBackend] Advanced by ${samples} samples → masterPos=${state.masterPos}`);
}

/**
 * masterPos CONTRACT (mirrors AudioEngine::getGraphState — kernel.md
 * step 3): the engine's clock is monotonic and never exposed raw. The
 * published masterPos is a DERIVED VIEW — wrapped to the cycle when
 * idle/playing, but during recording it grows linearly from a base
 * frozen at record start, so the cursor extends past the committed LCM.
 * Consumers must NOT re-wrap it (re-wrapping makes a growing take loop
 * 1Q over and over).
 */
export function viewMasterPos() {
    const raw = state.masterPos;
    if (recView.active) return recView.base + (raw - recView.anchor);
    const Q = effectiveQuantumForState();
    // E-C (engine parity): the view wraps on the EFFECTIVE cycle — the
    // playhead loops with what is heard, never past an active window.
    const cycle = effectiveCycle(Q);
    const rel = raw - state.islandEpoch; // engine: rel = t − islandEpoch()
    return cycle > 0 ? posMod(rel, cycle) : rel;
}
