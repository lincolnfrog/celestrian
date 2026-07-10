/**
 * Waveform append-stability (field 2026-07-10: "the waveform vibrates
 * left and right while recording").
 *
 * THE LAW: while recording, previously drawn content never moves.
 * Formally — with a fixed px-per-peak scale p, the first W₁ columns of
 * poolColumns(peaks + more, W₂, p) are IDENTICAL to poolColumns(peaks,
 * W₁, p). Fit-to-width mapping violates this: W = round(n·p) makes W/n
 * wobble as n grows, shifting every column sub-pixel per poll.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { poolColumns } from '../canvas_renderer.js';

// Deterministic pseudo-audio
function makePeaks(n, seed = 7) {
    const out = [];
    let s = seed;
    for (let i = 0; i < n; i++) {
        s = (s * 48271) % 2147483647;
        out.push(0.1 + 0.85 * Math.abs(Math.sin(i * 0.37 + (s % 100) / 300)));
    }
    return out;
}

test('fixed scale: appending peaks never changes existing columns', () => {
    const p = 6.371; // deliberately fractional px per peak
    const grown = makePeaks(500);

    let prevCols = null;
    let prevW = 0;
    // Simulate 20 polls of growth: 100 → 500 peaks in uneven steps
    for (let n = 100; n <= 500; n += 17 + (n % 5)) {
        const peaks = grown.slice(0, n);
        const W = Math.max(2, Math.ceil(n * p));
        const cols = poolColumns(peaks, W, p);
        if (prevCols) {
            for (let x = 0; x < prevW; x++) {
                assert.equal(cols[x], prevCols[x],
                    `column ${x} moved between polls (n=${n})`);
            }
        }
        prevCols = cols;
        prevW = W;
    }
});

test('fit mode (committed clips) still fills its width exactly', () => {
    const peaks = makePeaks(300);
    const cols = poolColumns(peaks, 200, undefined);
    assert.equal(cols.length, 200);
    // Downsampling max-pool: every column carries signal
    assert.ok([...cols].every(v => v > 0));
});
