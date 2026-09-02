/**
 * Composite waveform for folded stacks (composite_waveform.js): the
 * group lane's drawn peaks must be the SUM of what its children
 * audibly do — origin offsets are epoch-relative (one-frame rule),
 * looping clips tile the WHOLE cycle including before their offset
 * (FIELD 2026-07-16d: forward-only tiling left a blank head), and an
 * ACTIVE window contributes only its segment. buildCacheKey pins the
 * invalidation contract: any child/loop/width change must miss the
 * cache; an unchanged stack must return the same array reference.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey, generateCompositeWaveform } from '../composite_waveform.js';
import { MOCK_Q as Q } from './helpers.mjs';

// Lengths below are multiples of Q — the mock's quantum, i.e. 1 s of
// audio at its sample rate. They used to be literals derived from
// 44.1 kHz (88200, 132300, 176400). Only the RATIOS matter here, so
// the file re-rates cleanly with the mock.

// --- buildCacheKey tests ---

test('buildCacheKey', async (t) => {
    await t.test('produces deterministic key for same input', () => {
        const stack = {
            loopStart: 0,
            loopEnd: 4 * Q,
            nodes: [
                { id: 'clip-1', type: 'clip', duration: Q, x: 0, loopStart: 0, loopEnd: Q, launchPoint: 0 },
                { id: 'clip-2', type: 'clip', duration: 4 * Q, x: 0, loopStart: 0, loopEnd: 4 * Q, launchPoint: 0 }
            ]
        };
        const key1 = buildCacheKey(stack, 400);
        const key2 = buildCacheKey(stack, 400);
        assert.equal(key1, key2, 'Same input should produce same key');
    });

    await t.test('different targetPeaks → different key', () => {
        const stack = {
            loopStart: 0, loopEnd: 4 * Q,
            nodes: [{ id: 'clip-1', type: 'clip', duration: Q }]
        };
        const key1 = buildCacheKey(stack, 400);
        const key2 = buildCacheKey(stack, 800);
        assert.notEqual(key1, key2);
    });

    // The stack's OWN window is not part of the mixdown (the composite
    // spans the intrinsic extent; the lane's dims/srcSegs apply the
    // window over it) — so it must NOT invalidate: every regeneration
    // is a new array identity, and the lane cross-fades new identities,
    // which read as flicker on each handle release (field video
    // 2026-08-29). Pinned the other way round before that.
    await t.test('the stack\'s own loop points do NOT change the key', () => {
        const stack1 = { loopStart: 0, loopEnd: 4 * Q, nodes: [{ id: 'c', type: 'clip', duration: Q }] };
        const stack2 = { loopStart: Q, loopEnd: 2 * Q, nodes: [{ id: 'c', type: 'clip', duration: Q }] };
        assert.equal(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('epoch and extent are in the key (they place the tiles)', () => {
        const stack = { nodes: [{ id: 'c', type: 'clip', duration: Q, origin: 3 * Q }] };
        assert.notEqual(buildCacheKey(stack, 400, { epochSamples: 0 }),
                        buildCacheKey(stack, 400, { epochSamples: Q }));
        assert.notEqual(buildCacheKey(stack, 400, { stackDuration: 4 * Q }),
                        buildCacheKey(stack, 400, { stackDuration: 8 * Q }));
    });

    await t.test('RAW mode: only material identity is in the key', () => {
        // The definer trim view draws the whole take from 0: a re-trim
        // moves the window, the origin/epoch frame and Q on every
        // release — none of it may regenerate the picture underneath.
        const a = { loopStart: 0, loopEnd: Q, nodes: [{ id: 'c', type: 'clip', duration: 4 * Q,
            origin: 0, loopStart: 0, loopEnd: 2 * Q, windowActive: true }] };
        const b = { loopStart: Q, loopEnd: 3 * Q, nodes: [{ id: 'c', type: 'clip', duration: 4 * Q,
            origin: 5 * Q, loopStart: Q, loopEnd: 3 * Q, windowActive: false }] };
        assert.equal(buildCacheKey(a, 400, { raw: true, stackDuration: 4 * Q, epochSamples: 0 }),
                     buildCacheKey(b, 400, { raw: true, stackDuration: 4 * Q, epochSamples: 7 * Q }));
        // …but a different take is a different picture.
        const c = { nodes: [{ id: 'c', type: 'clip', duration: 5 * Q }] };
        assert.notEqual(buildCacheKey(a, 400, { raw: true }), buildCacheKey(c, 400, { raw: true }));
        // and raw vs heard never share a cache entry
        assert.notEqual(buildCacheKey(a, 400, { raw: true }), buildCacheKey(a, 400, { raw: false }));
    });

    await t.test('different child origin → different key', () => {
        const stack1 = { nodes: [{ id: 'c', type: 'clip', duration: Q, origin: 0 }] };
        const stack2 = { nodes: [{ id: 'c', type: 'clip', duration: Q, origin: 2 * Q }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('different child durations → different key', () => {
        const stack1 = { nodes: [{ id: 'c', type: 'clip', duration: Q }] };
        const stack2 = { nodes: [{ id: 'c', type: 'clip', duration: 2 * Q }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('different child IDs → different key', () => {
        const stack1 = { nodes: [{ id: 'clip-a', type: 'clip', duration: Q }] };
        const stack2 = { nodes: [{ id: 'clip-b', type: 'clip', duration: Q }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('extra child → different key', () => {
        const stack1 = { nodes: [{ id: 'c1', type: 'clip', duration: Q }] };
        const stack2 = { nodes: [{ id: 'c1', type: 'clip', duration: Q }, { id: 'c2', type: 'clip', duration: 2 * Q }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('skips non-clip children', () => {
        const stack1 = { nodes: [{ id: 'c1', type: 'clip', duration: Q }] };
        const stack2 = { nodes: [{ id: 'c1', type: 'clip', duration: Q }, { id: 's1', type: 'stack', duration: 2 * Q }] };
        assert.equal(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400), 'Non-clip children should be ignored');
    });

    await t.test('handles empty nodes array', () => {
        const stack = { nodes: [] };
        const key = buildCacheKey(stack, 400);
        assert.ok(typeof key === 'string');
    });

    await t.test('handles missing nodes', () => {
        const stack = {};
        const key = buildCacheKey(stack, 400);
        assert.ok(typeof key === 'string');
    });

    await t.test('windowActive flip → different key (tri-state incl. undefined)', () => {
        const base = { id: 'c', type: 'clip', duration: Q };
        const on = { nodes: [{ ...base, windowActive: true }] };
        const off = { nodes: [{ ...base, windowActive: false }] };
        const unset = { nodes: [{ ...base }] };
        assert.notEqual(buildCacheKey(on, 400), buildCacheKey(off, 400));
        assert.notEqual(buildCacheKey(off, 400), buildCacheKey(unset, 400));
    });

    await t.test('different child segments → different key', () => {
        const base = { id: 'c', type: 'clip', duration: 3 * Q };
        const a = { nodes: [{ ...base, segments: [0, Q, 2 * Q, 3 * Q] }] };
        const b = { nodes: [{ ...base, segments: [0, 2 * Q] }] };
        assert.notEqual(buildCacheKey(a, 400), buildCacheKey(b, 400));
    });
});

// --- generateCompositeWaveform tests ---

test('generateCompositeWaveform', async (t) => {
    const makeStack = (nodes) => ({
        id: 'stack-1',
        loopStart: 0,
        loopEnd: 4 * Q,
        nodes
    });

    await t.test('returns empty array for stack with no children', () => {
        const stack = { id: 'stack-1' };
        const cache = new Map();
        const result = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks: new Map(), cache
        });
        assert.deepEqual(result, []);
    });

    await t.test('generates peaks from child livePeaks', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 4 * Q, x: 0 }
        ]);
        const livePeaks = new Map([['clip-1', [0.5, 0.8, 0.3]]]);
        const cache = new Map();
        const result = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks, cache
        });
        assert.ok(result.length > 0, 'Should produce peaks');
        assert.ok(result.some(v => v > 0), 'Should have non-zero values');
    });

    await t.test('offsets a clip by the cycle projection of its origin', () => {
        // 2Q clip (loud first half, SILENT second half) with origin 1Q
        // in a 4Q stack: loud content lands at [1,2) and [3,4), silence
        // at [0,1) and [2,3). This pins origin-based AUDIBLE placement —
        // the phase, since a loop covers the whole cycle (the old
        // "[0,2Q) must be silent" expectation pinned the forward-only
        // tiling bug: a looping clip always sounds before its offset too).
        const stack = makeStack([
            { id: 'c', type: 'clip', duration: 2 * Q, origin: Q }
        ]);
        const livePeaks = new Map([['c', [1, 1, 0, 0]]]);
        const result = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 100, livePeaks, cache: new Map(), epochSamples: 0
        });
        const n = result.length;
        assert.equal(result[Math.floor(n / 8)], 0, '[0,1Q) is the silent half');
        assert.ok(result[Math.floor(3 * n / 8)] > 0, '[1,2Q) is loud');
        assert.equal(result[Math.floor(5 * n / 8)], 0, '[2,3Q) silent again');
        assert.ok(result[Math.floor(7 * n / 8)] > 0, '[3,4Q) loud again');
    });

    await t.test('origin offsets are epoch-relative (one-frame rule)', () => {
        // Same loud/silent clip as above, but the island epoch IS its
        // origin: rel = 0, so the loud half sits at the frame TOP.
        const stack = makeStack([
            { id: 'c', type: 'clip', duration: 2 * Q, origin: 2 * Q }
        ]);
        const livePeaks = new Map([['c', [1, 1, 0, 0]]]);
        const result = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 100, livePeaks, cache: new Map(), epochSamples: 2 * Q
        });
        const n = result.length;
        assert.ok(result[Math.floor(n / 8)] > 0, '[0,1Q) loud (rel 0)');
        assert.equal(result[Math.floor(3 * n / 8)], 0, '[1,2Q) silent');
    });

    await t.test('FIELD 2026-07-16d: tiles wrap BEFORE the offset (no blank head)', () => {
        // A 2Q clip whose cycle position is 1Q (rel −1Q) in a 4Q stack:
        // its loop sounds at [1,3) AND wraps to cover [3,4)+[0,1). The
        // old forward-only tiling left [0,1) blank ("the stack is blank
        // for the first 2Q").
        const stack = makeStack([
            { id: 'c', type: 'clip', duration: 2 * Q, origin: 3 * Q,
              loopStart: 0, loopEnd: 0 }
        ]);
        const livePeaks = new Map([['c', [1, 1, 1, 1]]]);
        const result = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 100, livePeaks, cache: new Map(),
            epochSamples: 4 * Q  // rel = −1Q
        });
        assert.ok(result.every(v => v > 0),
            'a looping clip covers the WHOLE cycle, including before its offset');
    });

    await t.test('FIELD 2026-07-16d: an ACTIVE window contributes ONLY its segment', () => {
        // 2Q clip at heard 2Q, peaks: silent first half, loud second
        // half. Window selects the loud second half [1Q,2Q): audibly it
        // loops every 1Q — the composite must be loud EVERYWHERE (and
        // must NOT draw the silent not-in-window half anywhere).
        const clip = {
            id: 'c', type: 'clip', duration: 2 * Q, origin: 2 * Q,
            loopStart: Q, loopEnd: 2 * Q, windowActive: true,
            loopBypassed: false,
        };
        const livePeaks = new Map([['c', [0, 0, 1, 1]]]);
        const active = generateCompositeWaveform({
            stack: makeStack([clip]), stackDuration: 4 * Q,
            effectiveQ: Q, canvasWidth: 100, livePeaks,
            cache: new Map(), epochSamples: 0
        });
        assert.ok(active.every(v => v > 0),
            'window segment (loud) tiles the whole cycle');

        // Bypassed: the full take loops at 2Q — the silent half lands at
        // [0,1) and [2,3), the loud half at [1,2) and [3,4).
        const bypassed = generateCompositeWaveform({
            stack: makeStack([{ ...clip, id: 'c2', windowActive: false,
                loopBypassed: true }]),
            stackDuration: 4 * Q, effectiveQ: Q, canvasWidth: 100,
            livePeaks: new Map([['c2', [0, 0, 1, 1]]]),
            cache: new Map(), epochSamples: 0
        });
        const n = bypassed.length;
        assert.equal(bypassed[Math.floor(n / 8)], 0,
            'bypassed: the silent recorded half shows again');
        assert.ok(bypassed[Math.floor(3 * n / 8)] > 0,
            'bypassed: the loud half at its recorded position');
    });

    await t.test('a MULTI-SEGMENT map contributes its segments concatenated (cut material excluded)', () => {
        // 3Q take, peaks per Q: [0.5, silent, 1]. Map [0,1Q)+[2Q,3Q)
        // cuts the silent middle: audibly the clip loops 0.5-then-1
        // every 2Q. Over a 4Q cycle the composite must alternate
        // 0.5/1 with the cut Q appearing NOWHERE.
        const clip = {
            id: 'c', type: 'clip', duration: 3 * Q, origin: 0,
            loopStart: 0, loopEnd: 3 * Q,
            segments: [0, Q, 2 * Q, 3 * Q],
            windowActive: true, loopBypassed: false,
        };
        const livePeaks = new Map([['c', [0.5, 0.5, 0, 0, 1, 1]]]);
        const wf = generateCompositeWaveform({
            stack: makeStack([clip]), stackDuration: 4 * Q,
            effectiveQ: Q, canvasWidth: 100, livePeaks,
            cache: new Map(), epochSamples: 0
        });
        // Heard period 2Q over a 4Q cycle: [0.5, 1, 0.5, 1] per Q.
        assert.ok(wf.every(v => v > 0), 'the cut (silent) Q never appears');
        assert.equal(wf[20], 0.5, 'Q0: first segment material');
        assert.equal(wf[70], 1, 'Q1: second segment material');
        assert.equal(wf[120], 0.5, 'Q2: pass repeats — first segment');
        assert.equal(wf[170], 1, 'Q3: pass repeats — second segment');
    });

    await t.test('a BYPASSED multi-segment map falls back to the full take', () => {
        const clip = {
            id: 'c', type: 'clip', duration: 3 * Q, origin: 0,
            loopStart: 0, loopEnd: 3 * Q,
            segments: [0, Q, 2 * Q, 3 * Q],
            windowActive: false, loopBypassed: true,
        };
        const livePeaks = new Map([['c', [0.5, 0.5, 0, 0, 1, 1]]]);
        const wf = generateCompositeWaveform({
            stack: makeStack([clip]), stackDuration: 3 * Q,
            effectiveQ: Q, canvasWidth: 100, livePeaks,
            cache: new Map(), epochSamples: 0
        });
        // Full 3Q take at its recorded positions: the silent middle
        // third SHOWS again when the map is bypassed.
        assert.equal(wf[Math.floor(wf.length / 2)], 0,
            'bypassed: the cut-out middle Q is visible');
        assert.equal(wf[20], 0.5, 'first third at its recorded spot');
        assert.equal(wf[wf.length - 20], 1, 'last third at its recorded spot');
    });

    await t.test('a mapped child anchors at origin and wraps before its offset', () => {
        // Same 2Q-heard map, origin 1Q: passes sit at ≡1Q (mod 2Q) in
        // the epoch frame, and the PRE-origin head [0,1Q) must carry
        // the wrapped predecessor's tail (second segment = loud), not
        // blankness — the segment-general twin of field 2026-07-16d.
        const clip = {
            id: 'c', type: 'clip', duration: 3 * Q, origin: Q,
            loopStart: 0, loopEnd: 3 * Q,
            segments: [0, Q, 2 * Q, 3 * Q],
            windowActive: true, loopBypassed: false,
        };
        const livePeaks = new Map([['c', [0.5, 0.5, 0, 0, 1, 1]]]);
        const wf = generateCompositeWaveform({
            stack: makeStack([clip]), stackDuration: 4 * Q,
            effectiveQ: Q, canvasWidth: 100, livePeaks,
            cache: new Map(), epochSamples: 0
        });
        assert.equal(wf[20], 1, 'wrapped tail (segment 2) before the origin');
        assert.equal(wf[70], 0.5, 'pass starts at origin with segment 1');
        assert.equal(wf[120], 1, 'segment 2 follows');
        assert.equal(wf[170], 0.5, 'next pass wraps the cycle');
    });

    await t.test('caches result and returns cached on second call', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 4 * Q, x: 0 }
        ]);
        const livePeaks = new Map([['clip-1', [0.5, 0.8, 0.3]]]);
        const cache = new Map();

        const result1 = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks, cache
        });

        // Cache should have an entry
        assert.ok(cache.has('stack-1'), 'Cache should contain entry');
        const cachedEntry = cache.get('stack-1');
        assert.ok(cachedEntry.key, 'Cache entry should have key');
        assert.ok(cachedEntry.peaks, 'Cache entry should have peaks');

        // Second call should return cached result (same reference)
        const result2 = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks, cache
        });
        assert.equal(result1, result2, 'Should return exact same array reference (cache hit)');
    });

    await t.test('invalidates cache when child duration changes', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 4 * Q, x: 0 }
        ]);
        const livePeaks = new Map([['clip-1', [0.5, 0.8, 0.3]]]);
        const cache = new Map();

        const result1 = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks, cache
        });

        // Change child duration
        stack.nodes[0].duration = 2 * Q;

        const result2 = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks, cache
        });

        assert.notEqual(result1, result2, 'Should be different array (cache miss)');
    });

    await t.test('the stack\'s own loop points do not regenerate (same array)', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 4 * Q, x: 0 }
        ]);
        const livePeaks = new Map([['clip-1', [0.5, 0.8]]]);
        const cache = new Map();

        const result1 = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks, cache
        });

        // A window edit on the GROUP itself: the mixdown underneath is
        // unchanged, so the SAME array comes back (no cross-fade).
        stack.loopEnd = 2 * Q;

        const result2 = generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks, cache
        });

        assert.equal(result1, result2, 'group window edit must not regenerate');
    });

    await t.test('RAW mode: whole takes from 0, windows/epoch ignored, stable across a re-trim', () => {
        // Two mics, one take: 4Q long, with a commit-time sub-window
        // [0, 2Q) on each (a survived Q can leave one) — the definer
        // trim view must still draw the WHOLE take, from 0.
        const peaks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
        const kid = i => ({ id: 'm' + i, type: 'clip', duration: 4 * Q, origin: 9 * Q,
            loopStart: 0, loopEnd: 2 * Q, windowActive: true });
        const stack = makeStack([kid(1), kid(2)]);
        const livePeaks = new Map([['m1', peaks], ['m2', peaks]]);
        const cache = new Map();
        const args = { stack, stackDuration: 4 * Q, effectiveQ: Q, canvasWidth: 8,
                       livePeaks, cache, epochSamples: 3 * Q, raw: true };
        const raw = generateCompositeWaveform(args);
        // 16 slots over 8 px; each peak covers 2 slots, in order, from 0.
        for (let i = 0; i < 8; i++) {
            assert.ok(Math.abs(raw[2 * i] - peaks[i]) < 1e-9, `slot ${2 * i} = peak ${i}`);
            assert.ok(Math.abs(raw[2 * i + 1] - peaks[i]) < 1e-9, `slot ${2 * i + 1} = peak ${i}`);
        }
        // A re-trim moves the window, epoch and (for the heard mixdown)
        // the tiling: the raw picture is the SAME array.
        stack.loopStart = Q; stack.loopEnd = 3 * Q;
        stack.nodes.forEach(c => { c.loopEnd = 3 * Q; c.origin = 11 * Q; });
        const again = generateCompositeWaveform({ ...args, epochSamples: 5 * Q });
        assert.equal(again, raw, 'raw composite stable across a re-trim');
        // Whereas the heard mixdown of the same state is a different picture.
        const heard = generateCompositeWaveform({ ...args, raw: false, cache: new Map() });
        assert.notDeepEqual(Array.from(heard), Array.from(raw));
    });

    await t.test('invalidates cache when child is added', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 4 * Q, x: 0 }
        ]);
        const livePeaks = new Map([
            ['clip-1', [0.5, 0.8]],
            ['clip-2', [0.3, 0.6]]
        ]);
        const cache = new Map();

        generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks, cache
        });
        const key1 = cache.get('stack-1').key;

        // Add a child
        stack.nodes.push({ id: 'clip-2', type: 'clip', duration: 2 * Q, x: 0 });

        generateCompositeWaveform({
            stack, stackDuration: 4 * Q, effectiveQ: Q,
            canvasWidth: 200, livePeaks, cache
        });
        const key2 = cache.get('stack-1').key;

        assert.notEqual(key1, key2, 'Adding child should invalidate cache');
    });
});
