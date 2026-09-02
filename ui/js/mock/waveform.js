/**
 * mock/waveform.js — deterministic waveform peak synthesis (no
 * Math.random, so screenshot/e2e assertions are stable poll to poll).
 */

import { findNode } from './state.js';

// Deterministic waveform peaks for a CLIP (no Math.random — stable for
// tests). Stacks return nothing: the UI fetches peaks for clips only
// (app.js) and composites a group from its children's peaks
// (composite_waveform.js), the engine's shape.
export function getWaveform(id, numPeaks = 100) {
    const node = findNode(id);
    if (!node || node.type === 'stack') return [];
    // D3 parity: the engine gates getWaveform on the recording state
    // machine — a non-Idle clip returns no peaks (the UI draws live
    // takes from currentPeak, never from the buffer).
    if (node.isRecording || node.isPendingStart) return [];
    if (!node.duration || node.duration <= 0) return [];

    const peaks = [];
    for (let i = 0; i < numPeaks; i++) {
        peaks.push(0.5 + 0.4 * Math.sin((i / numPeaks) * Math.PI * 4));
    }
    return peaks;
}
