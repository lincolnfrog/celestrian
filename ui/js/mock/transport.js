/**
 * mock/transport.js — the simulated clock: play/pause, auto-advance on
 * getState polls, deterministic advanceBy stepping for tests, and the
 * published masterPos view (wrapped on the effective cycle at rest,
 * linear from the frozen base while recording).
 */

// --- Transport Simulation ---
// Simulates the C++ audio engine advancing masterPos and recording clip duration.
// Auto-advance mode hooks into getState() polls (~50ms intervals).
// Deterministic mode uses advanceBy() for exact sample-count stepping.

import { posMod } from '../math_utils.js';
import { state, effectiveQuantumForState } from './state.js';
import { effectiveCycle } from './cycles.js';
import { recView, growRecordingClips } from './recording.js';

export const transport = {
    running: false,           // Is transport auto-advancing?
    samplesPerTick: 2205,     // Samples per poll tick (~50ms at 44100Hz)
    speed: 1.0                // Speed multiplier (1.0 = real-time)
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
 * Consumers must NOT re-wrap it (re-wrapping caused the "looping 1Q
 * over and over" field bug, 2026-07-09).
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
