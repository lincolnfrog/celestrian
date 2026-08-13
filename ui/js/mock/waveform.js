/**
 * mock/waveform.js — deterministic waveform peak synthesis (no
 * Math.random, so screenshot/e2e assertions are stable poll to poll).
 */

import { findNode } from './state.js';

// Deterministic waveform peaks for a node (no Math.random — stable for tests).
export function getWaveform(id, numPeaks = 100) {
    const node = findNode(id);
    if (!node) return [];
    if (node.type === 'stack') return generateStackWaveform(node, numPeaks);
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

// Generate mock waveform data for a stack (aggregates children)
export function generateStackWaveform(node, numPeaks = 100) {
    if (node.type !== 'stack') return [];

    const children = node.nodes || [];
    if (children.length === 0) return [];

    // Simple aggregation: sum of sine-like patterns based on child count
    const peaks = [];
    for (let i = 0; i < numPeaks; i++) {
        let sum = 0;
        children.forEach((child, idx) => {
            // Each child contributes a sine wave at different frequency
            const freq = 2 + idx;
            sum += Math.sin((i / numPeaks) * Math.PI * freq) * 0.3;
        });
        peaks.push(Math.min(1, Math.max(0, 0.5 + sum / children.length)));
    }
    return peaks;
}
