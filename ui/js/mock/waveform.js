/**
 * mock/waveform.js — deterministic waveform peak synthesis (no
 * Math.random, so screenshot/e2e assertions are stable poll to poll).
 */

import { findNode } from './state.js';
import { takesOf } from './recording.js';

// Deterministic waveform peaks for a CLIP (no Math.random — stable for
// tests): the ACTIVE take's (docs/takes.md; the take-list view is
// getTakeWaveform). Stacks return nothing: the UI fetches peaks for
// clips only (app.js) and composites a group from its children's peaks
// (composite_waveform.js), the engine's shape.
export function getWaveform(id, numPeaks = 100) {
    const node = findNode(id);
    if (!node || node.type === 'stack') return [];
    // D3 parity: the engine gates getWaveform on the recording state
    // machine — a non-Idle clip returns no peaks (the UI draws live
    // takes from currentPeak, never from the buffer).
    if (node.isRecording || node.isPendingStart) return [];
    if (!node.duration || node.duration <= 0) return [];
    return takePeaks(node, node.activeTake || 0, numPeaks);
}

/** THE PEAK BUCKET (engine twin ClipNode::peakBucket): peak `i` of `n`
 * over `total` samples covers [⌊i·total/n⌋, ⌊(i+1)·total/n⌋) —
 * proportional bounds, so the last bucket reaches the end of the take
 * and no peak drifts early (a floor-divided window dropped the
 * `total mod n` tail and slid every peak up to n samples early). A
 * bucket is never empty: when n > total it holds one sample. */
export function peakBucket(i, total, n) {
    const start = Math.floor((i * total) / n);
    return { start, end: Math.max(start + 1, Math.floor(((i + 1) * total) / n)) };
}

/** The mock take's CONTENT envelope at sample `k` of `total`: a smooth
 * two-cycle swell whose phase is the take's seed (takes draw
 * differently and stably). */
function envelopeAt(k, total, seed) {
    return 0.5 + 0.4 * Math.sin((k / total) * Math.PI * 4 + seed);
}

/** The envelope's MAX over samples [start, end) — exact for the
 * sinusoid: 0.9 when a crest (θ ≡ π/2 mod 2π) falls inside, else the
 * larger end. What the engine's bucket max does over real samples. */
function envelopeMax(start, end, total, seed) {
    const theta = k => (k / total) * Math.PI * 4 + seed;
    const a = theta(start), b = theta(end - 1);
    const crest = Math.PI / 2 +
        2 * Math.PI * Math.ceil((a - Math.PI / 2) / (2 * Math.PI));
    if (crest <= b) return 0.9;
    return Math.max(envelopeAt(start, total, seed), envelopeAt(end - 1, total, seed));
}

/** Deterministic peaks for take `index`: the max-pooled envelope over
 * each proportional bucket of the committed duration (engine parity
 * audioPeaks) — so a denser request is a refinement of the same
 * picture: peak i of n is the max of peaks 2i and 2i+1 of 2n. */
export function takePeaks(node, index, numPeaks = 100) {
    const takes = takesOf(node);
    if (!(index >= 0 && index < takes.length)) return [];
    const seed = takes[index].seed || 0;
    const total = Math.round(node.duration || 0);
    const n = Math.floor(numPeaks);
    if (!(total > 0) || !(n > 0)) return [];
    const peaks = new Array(n);
    for (let i = 0; i < n; i++) {
        const { start, end } = peakBucket(i, total, n);
        peaks[i] = envelopeMax(start, end, total, seed);
    }
    return peaks;
}
