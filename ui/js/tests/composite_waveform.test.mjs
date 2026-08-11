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

// --- buildCacheKey tests ---

test('buildCacheKey', async (t) => {
    await t.test('produces deterministic key for same input', () => {
        const stack = {
            loopStart: 0,
            loopEnd: 176400,
            nodes: [
                { id: 'clip-1', type: 'clip', duration: 44100, x: 0, loopStart: 0, loopEnd: 44100, launchPoint: 0 },
                { id: 'clip-2', type: 'clip', duration: 176400, x: 0, loopStart: 0, loopEnd: 176400, launchPoint: 0 }
            ]
        };
        const key1 = buildCacheKey(stack, 400);
        const key2 = buildCacheKey(stack, 400);
        assert.equal(key1, key2, 'Same input should produce same key');
    });

    await t.test('different targetPeaks → different key', () => {
        const stack = {
            loopStart: 0, loopEnd: 176400,
            nodes: [{ id: 'clip-1', type: 'clip', duration: 44100 }]
        };
        const key1 = buildCacheKey(stack, 400);
        const key2 = buildCacheKey(stack, 800);
        assert.notEqual(key1, key2);
    });

    await t.test('different loopStart → different key', () => {
        const stack1 = { loopStart: 0, loopEnd: 176400, nodes: [{ id: 'c', type: 'clip', duration: 44100 }] };
        const stack2 = { loopStart: 44100, loopEnd: 176400, nodes: [{ id: 'c', type: 'clip', duration: 44100 }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('different loopEnd → different key', () => {
        const stack1 = { loopStart: 0, loopEnd: 176400, nodes: [{ id: 'c', type: 'clip', duration: 44100 }] };
        const stack2 = { loopStart: 0, loopEnd: 88200, nodes: [{ id: 'c', type: 'clip', duration: 44100 }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('different child origin → different key', () => {
        const stack1 = { nodes: [{ id: 'c', type: 'clip', duration: 44100, origin: 0 }] };
        const stack2 = { nodes: [{ id: 'c', type: 'clip', duration: 44100, origin: 88200 }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('different child durations → different key', () => {
        const stack1 = { nodes: [{ id: 'c', type: 'clip', duration: 44100 }] };
        const stack2 = { nodes: [{ id: 'c', type: 'clip', duration: 88200 }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('different child IDs → different key', () => {
        const stack1 = { nodes: [{ id: 'clip-a', type: 'clip', duration: 44100 }] };
        const stack2 = { nodes: [{ id: 'clip-b', type: 'clip', duration: 44100 }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('extra child → different key', () => {
        const stack1 = { nodes: [{ id: 'c1', type: 'clip', duration: 44100 }] };
        const stack2 = { nodes: [{ id: 'c1', type: 'clip', duration: 44100 }, { id: 'c2', type: 'clip', duration: 88200 }] };
        assert.notEqual(buildCacheKey(stack1, 400), buildCacheKey(stack2, 400));
    });

    await t.test('skips non-clip children', () => {
        const stack1 = { nodes: [{ id: 'c1', type: 'clip', duration: 44100 }] };
        const stack2 = { nodes: [{ id: 'c1', type: 'clip', duration: 44100 }, { id: 's1', type: 'stack', duration: 88200 }] };
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
});

// --- generateCompositeWaveform tests ---

test('generateCompositeWaveform', async (t) => {
    const makeStack = (nodes) => ({
        id: 'stack-1',
        loopStart: 0,
        loopEnd: 176400,
        nodes
    });

    await t.test('returns backend waveform when available', () => {
        const stack = { ...makeStack([]), waveform: [0.1, 0.2, 0.3] };
        const cache = new Map();
        const result = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks: new Map(), cache
        });
        assert.deepEqual(result, [0.1, 0.2, 0.3]);
    });

    await t.test('returns empty array for stack with no children', () => {
        const stack = { id: 'stack-1' };
        const cache = new Map();
        const result = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks: new Map(), cache
        });
        assert.deepEqual(result, []);
    });

    await t.test('generates peaks from child livePeaks', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 176400, x: 0 }
        ]);
        const livePeaks = new Map([['clip-1', [0.5, 0.8, 0.3]]]);
        const cache = new Map();
        const result = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
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
            { id: 'c', type: 'clip', duration: 88200, origin: 44100 }
        ]);
        const livePeaks = new Map([['c', [1, 1, 0, 0]]]);
        const result = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
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
            { id: 'c', type: 'clip', duration: 88200, origin: 88200 }
        ]);
        const livePeaks = new Map([['c', [1, 1, 0, 0]]]);
        const result = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 100, livePeaks, cache: new Map(), epochSamples: 88200
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
            { id: 'c', type: 'clip', duration: 88200, origin: 3 * 44100,
              loopStart: 0, loopEnd: 0 }
        ]);
        const livePeaks = new Map([['c', [1, 1, 1, 1]]]);
        const result = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 100, livePeaks, cache: new Map(),
            epochSamples: 4 * 44100  // rel = −1Q
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
            id: 'c', type: 'clip', duration: 88200, origin: 88200,
            loopStart: 44100, loopEnd: 88200, windowActive: true,
            loopBypassed: false,
        };
        const livePeaks = new Map([['c', [0, 0, 1, 1]]]);
        const active = generateCompositeWaveform({
            stack: makeStack([clip]), stackDuration: 176400,
            effectiveQ: 44100, canvasWidth: 100, livePeaks,
            cache: new Map(), epochSamples: 0
        });
        assert.ok(active.every(v => v > 0),
            'window segment (loud) tiles the whole cycle');

        // Bypassed: the full take loops at 2Q — the silent half lands at
        // [0,1) and [2,3), the loud half at [1,2) and [3,4).
        const bypassed = generateCompositeWaveform({
            stack: makeStack([{ ...clip, id: 'c2', windowActive: false,
                loopBypassed: true }]),
            stackDuration: 176400, effectiveQ: 44100, canvasWidth: 100,
            livePeaks: new Map([['c2', [0, 0, 1, 1]]]),
            cache: new Map(), epochSamples: 0
        });
        const n = bypassed.length;
        assert.equal(bypassed[Math.floor(n / 8)], 0,
            'bypassed: the silent recorded half shows again');
        assert.ok(bypassed[Math.floor(3 * n / 8)] > 0,
            'bypassed: the loud half at its recorded position');
    });

    await t.test('caches result and returns cached on second call', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 176400, x: 0 }
        ]);
        const livePeaks = new Map([['clip-1', [0.5, 0.8, 0.3]]]);
        const cache = new Map();

        const result1 = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks, cache
        });

        // Cache should have an entry
        assert.ok(cache.has('stack-1'), 'Cache should contain entry');
        const cachedEntry = cache.get('stack-1');
        assert.ok(cachedEntry.key, 'Cache entry should have key');
        assert.ok(cachedEntry.peaks, 'Cache entry should have peaks');

        // Second call should return cached result (same reference)
        const result2 = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks, cache
        });
        assert.equal(result1, result2, 'Should return exact same array reference (cache hit)');
    });

    await t.test('invalidates cache when child duration changes', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 176400, x: 0 }
        ]);
        const livePeaks = new Map([['clip-1', [0.5, 0.8, 0.3]]]);
        const cache = new Map();

        const result1 = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks, cache
        });

        // Change child duration
        stack.nodes[0].duration = 88200;

        const result2 = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks, cache
        });

        assert.notEqual(result1, result2, 'Should be different array (cache miss)');
    });

    await t.test('invalidates cache when loop points change', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 176400, x: 0 }
        ]);
        const livePeaks = new Map([['clip-1', [0.5, 0.8]]]);
        const cache = new Map();

        const result1 = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks, cache
        });

        // Change loop points
        stack.loopEnd = 88200;

        const result2 = generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks, cache
        });

        assert.notEqual(result1, result2, 'Loop point change should invalidate cache');
    });

    await t.test('invalidates cache when child is added', () => {
        const stack = makeStack([
            { id: 'clip-1', type: 'clip', duration: 176400, x: 0 }
        ]);
        const livePeaks = new Map([
            ['clip-1', [0.5, 0.8]],
            ['clip-2', [0.3, 0.6]]
        ]);
        const cache = new Map();

        generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks, cache
        });
        const key1 = cache.get('stack-1').key;

        // Add a child
        stack.nodes.push({ id: 'clip-2', type: 'clip', duration: 88200, x: 0 });

        generateCompositeWaveform({
            stack, stackDuration: 176400, effectiveQ: 44100,
            canvasWidth: 200, livePeaks, cache
        });
        const key2 = cache.get('stack-1').key;

        assert.notEqual(key1, key2, 'Adding child should invalidate cache');
    });
});
