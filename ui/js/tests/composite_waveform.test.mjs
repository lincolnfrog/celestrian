/**
 * Composite waveform for folded stacks (composite_waveform.js): the
 * group lane's drawn peaks must be the SUM of what its children
 * audibly do — origin offsets are zero-relative (one-frame rule),
 * looping clips tile the WHOLE cycle including before their offset, and
 * an ACTIVE window contributes only its segment. buildCacheKey pins the
 * invalidation contract: any child/loop/width change must miss the
 * cache; an unchanged stack must return the same array reference (the
 * lane cross-fades a new array identity, so a needless regeneration
 * reads as flicker).
 *
 * Lengths are multiples of Q (the mock's quantum); only the RATIOS
 * matter here, so the file re-rates with the mock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCacheKey, generateCompositeWaveform, skippedInComposite }
    from '../composite_waveform.js';
import { innerAt } from '../time_map.js';
import { MOCK_Q as Q } from './helpers.mjs';

const kid = (extra = {}) => ({ id: 'c', type: 'clip', duration: Q, ...extra });
const of = (...nodes) => ({ nodes });

/* [what, 'same' | 'differs', [stack, opts, targetPeaks] × 2]. The
 * stack's OWN window is not part of the mixdown (the composite spans the
 * intrinsic extent; the lane's dims/srcSegs apply the window over it),
 * so it must not invalidate. RAW mode (the definer trim view draws the
 * whole take from 0) keys on material identity alone: a re-trim moves
 * the window, the origin, the frame and Q on every release, and none of
 * it may regenerate the picture underneath. */
const rawA = { loopStart: 0, loopEnd: Q, nodes: [kid({ duration: 4 * Q, origin: 0,
    loopStart: 0, loopEnd: 2 * Q, windowActive: true })] };
const rawB = { loopStart: Q, loopEnd: 3 * Q, nodes: [kid({ duration: 4 * Q, origin: 5 * Q,
    loopStart: Q, loopEnd: 3 * Q, windowActive: false })] };
const twoClips = { loopStart: 0, loopEnd: 4 * Q, nodes: [
    { id: 'clip-1', type: 'clip', duration: Q, x: 0, loopStart: 0, loopEnd: Q, launchPoint: 0 },
    { id: 'clip-2', type: 'clip', duration: 4 * Q, x: 0, loopStart: 0, loopEnd: 4 * Q, launchPoint: 0 },
] };
const windowed = { loopStart: 0, loopEnd: 4 * Q, nodes: [kid({ id: 'clip-1' })] };
const KEYS = [
    ['the same input: a deterministic key', 'same', [twoClips], [twoClips]],
    ['targetPeaks', 'differs', [windowed, undefined, 400], [windowed, undefined, 800]],
    ['the stack\'s own loop points do NOT change the key', 'same',
     [{ loopStart: 0, loopEnd: 4 * Q, nodes: [kid()] }], [{ loopStart: Q, loopEnd: 2 * Q, nodes: [kid()] }]],
    ['the frame zero (it places the tiles)', 'differs',
     [of(kid({ origin: 3 * Q })), { frameZero: 0 }], [of(kid({ origin: 3 * Q })), { frameZero: Q }]],
    ['the extent (it places the tiles)', 'differs',
     [of(kid({ origin: 3 * Q })), { stackDuration: 4 * Q }],
     [of(kid({ origin: 3 * Q })), { stackDuration: 8 * Q }]],
    ['RAW mode: window, origin and frame zero are not in the key', 'same',
     [rawA, { raw: true, stackDuration: 4 * Q, frameZero: 0 }],
     [rawB, { raw: true, stackDuration: 4 * Q, frameZero: 7 * Q }]],
    ['RAW mode: a different take is a different picture', 'differs',
     [rawA, { raw: true }], [of(kid({ duration: 5 * Q })), { raw: true }]],
    ['raw and heard never share a cache entry', 'differs', [rawA, { raw: true }], [rawA, { raw: false }]],
    ['a child\'s origin', 'differs', [of(kid({ origin: 0 }))], [of(kid({ origin: 2 * Q }))]],
    ['a child\'s duration', 'differs', [of(kid())], [of(kid({ duration: 2 * Q }))]],
    ['a child\'s id', 'differs', [of(kid({ id: 'clip-a' }))], [of(kid({ id: 'clip-b' }))]],
    ['an extra child', 'differs',
     [of(kid({ id: 'c1' }))], [of(kid({ id: 'c1' }), kid({ id: 'c2', duration: 2 * Q }))]],
    ['a non-clip child is ignored', 'same',
     [of(kid({ id: 'c1' }))], [of(kid({ id: 'c1' }), { id: 's1', type: 'stack', duration: 2 * Q })]],
    ['an empty nodes array, or none', 'same', [{ nodes: [] }], [{}]],
    ['windowActive on / off', 'differs',
     [of(kid({ windowActive: true }))], [of(kid({ windowActive: false }))]],
    ['windowActive off / unset (tri-state)', 'differs', [of(kid({ windowActive: false }))], [of(kid())]],
    ['a child\'s segments', 'differs',
     [of(kid({ duration: 3 * Q, segments: [0, Q, 2 * Q, 3 * Q] }))],
     [of(kid({ duration: 3 * Q, segments: [0, 2 * Q] }))]],
];

test('buildCacheKey', async (t) => {
    for (const [what, verdict, a, b] of KEYS) {
        await t.test(`${what}: ${verdict}`, () => {
            const [keyA, keyB] = [a, b].map(([stack, opts, peaks = 400]) =>
                buildCacheKey(stack, peaks, opts));
            assert.equal(typeof keyA, 'string');
            assert.equal(typeof keyB, 'string');
            (verdict === 'same' ? assert.equal : assert.notEqual)(keyA, keyB);
        });
    }
});

/** The composite of `stack` over a 4Q extent at 100 px, `peaks` =
 * {child id: its peaks}; `over` overrides any argument. */
const gen = (stack, peaks, over = {}) => generateCompositeWaveform({
    stack, stackDuration: 4 * Q, effectiveQ: Q, canvasWidth: 100,
    livePeaks: new Map(Object.entries(peaks)), cache: new Map(), ...over,
});
const makeStack = nodes => ({ id: 'stack-1', loopStart: 0, loopEnd: 4 * Q, nodes });
/** One 4Q clip in a stack, the fixture of the cache tests. */
const oneClip = () => makeStack([{ id: 'clip-1', type: 'clip', duration: 4 * Q, x: 0 }]);
/** A 3Q take, peaks per Q: [0.5, silent, 1], under a map that cuts the
 * silent middle out. */
const cutTake = extra => ({
    id: 'c', type: 'clip', duration: 3 * Q, origin: 0, loopStart: 0, loopEnd: 3 * Q,
    segments: [0, Q, 2 * Q, 3 * Q], windowActive: true, loopBypassed: false, ...extra,
});
const CUT_PEAKS = { c: [0.5, 0.5, 0, 0, 1, 1] };

test('generateCompositeWaveform', async (t) => {
    await t.test('returns empty array for stack with no children', () => {
        assert.deepEqual(gen({ id: 'stack-1' }, {}, { canvasWidth: 200 }), []);
    });

    await t.test('generates peaks from child livePeaks', () => {
        const result = gen(oneClip(), { 'clip-1': [0.5, 0.8, 0.3] }, { canvasWidth: 200 });
        assert.ok(result.length > 0, 'Should produce peaks');
        assert.ok(result.some(v => v > 0), 'Should have non-zero values');
    });

    await t.test('offsets a clip by the cycle projection of its origin', () => {
        // 2Q clip (loud first half, SILENT second half) with origin 1Q
        // in a 4Q stack: loud content lands at [1,2) and [3,4), silence
        // at [0,1) and [2,3) — the phase, since a loop covers the whole
        // cycle and so sounds before its offset too.
        const result = gen(makeStack([{ id: 'c', type: 'clip', duration: 2 * Q, origin: Q }]),
            { c: [1, 1, 0, 0] }, { frameZero: 0 });
        const n = result.length;
        assert.equal(result[Math.floor(n / 8)], 0, '[0,1Q) is the silent half');
        assert.ok(result[Math.floor(3 * n / 8)] > 0, '[1,2Q) is loud');
        assert.equal(result[Math.floor(5 * n / 8)], 0, '[2,3Q) silent again');
        assert.ok(result[Math.floor(7 * n / 8)] > 0, '[3,4Q) loud again');
    });

    await t.test('origin offsets are zero-relative (one-frame rule)', () => {
        // Same loud/silent clip as above, but the island zero IS its
        // origin: rel = 0, so the loud half sits at the frame TOP.
        const result = gen(makeStack([{ id: 'c', type: 'clip', duration: 2 * Q, origin: 2 * Q }]),
            { c: [1, 1, 0, 0] }, { frameZero: 2 * Q });
        const n = result.length;
        assert.ok(result[Math.floor(n / 8)] > 0, '[0,1Q) loud (rel 0)');
        assert.equal(result[Math.floor(3 * n / 8)], 0, '[1,2Q) silent');
    });

    await t.test('tiles wrap BEFORE the offset (no blank head)', () => {
        // A 2Q clip whose cycle position is 1Q (rel −1Q) in a 4Q stack:
        // its loop sounds at [1,3) AND wraps to cover [3,4)+[0,1).
        const result = gen(makeStack([{ id: 'c', type: 'clip', duration: 2 * Q,
            origin: 3 * Q, loopStart: 0, loopEnd: 0 }]),
            { c: [1, 1, 1, 1] }, { frameZero: 4 * Q });  // rel = −1Q
        assert.ok(result.every(v => v > 0),
            'a looping clip covers the WHOLE cycle, including before its offset');
    });

    await t.test('an ACTIVE window contributes ONLY its segment', () => {
        // 2Q clip at heard 2Q, peaks: silent first half, loud second
        // half. Window selects the loud second half [1Q,2Q): audibly it
        // loops every 1Q — the composite must be loud EVERYWHERE (and
        // must NOT draw the silent not-in-window half anywhere).
        const clip = {
            id: 'c', type: 'clip', duration: 2 * Q, origin: 2 * Q,
            loopStart: Q, loopEnd: 2 * Q, windowActive: true, loopBypassed: false,
        };
        const active = gen(makeStack([clip]), { c: [0, 0, 1, 1] }, { frameZero: 0 });
        assert.ok(active.every(v => v > 0),
            'window segment (loud) tiles the whole cycle');

        // Bypassed: the full take loops at 2Q — the silent half lands at
        // [0,1) and [2,3), the loud half at [1,2) and [3,4).
        const bypassed = gen(
            makeStack([{ ...clip, id: 'c2', windowActive: false, loopBypassed: true }]),
            { c2: [0, 0, 1, 1] }, { frameZero: 0 });
        const n = bypassed.length;
        assert.equal(bypassed[Math.floor(n / 8)], 0,
            'bypassed: the silent recorded half shows again');
        assert.ok(bypassed[Math.floor(3 * n / 8)] > 0,
            'bypassed: the loud half at its recorded position');
    });

    await t.test('a MULTI-SEGMENT map contributes its segments concatenated (cut material excluded)', () => {
        // Audibly the clip loops 0.5-then-1 every 2Q: over a 4Q cycle
        // the composite alternates 0.5/1, the cut Q appearing NOWHERE.
        const wf = gen(makeStack([cutTake()]), CUT_PEAKS, { frameZero: 0 });
        assert.ok(wf.every(v => v > 0), 'the cut (silent) Q never appears');
        assert.equal(wf[20], 0.5, 'Q0: first segment material');
        assert.equal(wf[70], 1, 'Q1: second segment material');
        assert.equal(wf[120], 0.5, 'Q2: pass repeats — first segment');
        assert.equal(wf[170], 1, 'Q3: pass repeats — second segment');
    });

    await t.test('a BYPASSED multi-segment map falls back to the full take', () => {
        const wf = gen(makeStack([cutTake({ windowActive: false, loopBypassed: true })]),
            CUT_PEAKS, { stackDuration: 3 * Q, frameZero: 0 });
        // Full 3Q take at its recorded positions: the silent middle
        // third SHOWS again when the map is bypassed.
        assert.equal(wf[Math.floor(wf.length / 2)], 0,
            'bypassed: the cut-out middle Q is visible');
        assert.equal(wf[20], 0.5, 'first third at its recorded spot');
        assert.equal(wf[wf.length - 20], 1, 'last third at its recorded spot');
    });

    await t.test('a mapped child anchors at origin and wraps before its offset', () => {
        // Same 2Q-heard map, origin 1Q: passes sit at ≡1Q (mod 2Q) in
        // the island frame, and the PRE-origin head [0,1Q) must carry
        // the wrapped predecessor's tail (second segment = loud), not
        // blankness.
        const wf = gen(makeStack([cutTake({ origin: Q })]), CUT_PEAKS, { frameZero: 0 });
        assert.equal(wf[20], 1, 'wrapped tail (segment 2) before the origin');
        assert.equal(wf[70], 0.5, 'pass starts at origin with segment 1');
        assert.equal(wf[120], 1, 'segment 2 follows');
        assert.equal(wf[170], 0.5, 'next pass wraps the cycle');
    });

    await t.test('THE ANCHORING LAW: a window\'s pass begins at origin + a0', () => {
        // A 4Q take, raw Q0..Q3 = 0.1..0.4, windowed to [1Q, 3Q): the
        // heard period is 2Q and raw 1Q sounds at origin + 1Q
        // (time_map innerAt) — so the pass starts 1Q in and the head
        // carries raw 2Q, as on the group's own member lane.
        const clip = {
            id: 'c', type: 'clip', duration: 4 * Q, origin: 0,
            loopStart: Q, loopEnd: 3 * Q, windowActive: true, loopBypassed: false,
        };
        const wf = gen(makeStack([clip]), { c: [0.1, 0.2, 0.3, 0.4] }, { frameZero: 0 });
        const at = q => wf[Math.floor((q + 0.5) * wf.length / 4)];
        assert.deepEqual([0, 1, 2, 3].map(at), [0.3, 0.2, 0.3, 0.2]);
        // …exactly the render equation, sample for sample.
        [0, 1, 2, 3].forEach(q => {
            const r = innerAt(q * Q + Q / 2, 0, { segs: [[Q, 3 * Q]] }, 2 * Q);
            assert.equal(at(q), [0.1, 0.2, 0.3, 0.4][Math.floor(r.inner / Q)],
                `Q${q}: what the law sounds there`);
        });
    });

    await t.test('caches result and returns cached on second call', () => {
        const stack = oneClip();
        const args = [stack, { 'clip-1': [0.5, 0.8, 0.3] }, { canvasWidth: 200, cache: new Map() }];
        const result1 = gen(...args);
        const cachedEntry = args[2].cache.get('stack-1');
        assert.ok(cachedEntry, 'Cache should contain entry');
        assert.ok(cachedEntry.key, 'Cache entry should have key');
        assert.ok(cachedEntry.peaks, 'Cache entry should have peaks');
        assert.equal(gen(...args), result1,
            'Should return exact same array reference (cache hit)');
    });

    await t.test('invalidates cache when child duration changes', () => {
        const stack = oneClip();
        const args = [stack, { 'clip-1': [0.5, 0.8, 0.3] }, { canvasWidth: 200, cache: new Map() }];
        const result1 = gen(...args);
        stack.nodes[0].duration = 2 * Q;
        assert.notEqual(gen(...args), result1, 'Should be different array (cache miss)');
    });

    await t.test('the stack\'s own loop points do not regenerate (same array)', () => {
        const stack = oneClip();
        const args = [stack, { 'clip-1': [0.5, 0.8] }, { canvasWidth: 200, cache: new Map() }];
        const result1 = gen(...args);
        // A window edit on the GROUP itself: the mixdown underneath is
        // unchanged, so the SAME array comes back (no cross-fade).
        stack.loopEnd = 2 * Q;
        assert.equal(gen(...args), result1, 'group window edit must not regenerate');
    });

    await t.test('RAW mode: whole takes from 0, windows/zero ignored, stable across a re-trim', () => {
        // Two mics, one take: 4Q long, with a commit-time sub-window
        // [0, 2Q) on each — the definer trim view must still draw the
        // WHOLE take, from 0.
        const peaks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
        const mic = i => ({ id: 'm' + i, type: 'clip', duration: 4 * Q, origin: 9 * Q,
            loopStart: 0, loopEnd: 2 * Q, windowActive: true });
        const stack = makeStack([mic(1), mic(2)]);
        const over = { canvasWidth: 8, cache: new Map(), frameZero: 3 * Q, raw: true };
        const raw = gen(stack, { m1: peaks, m2: peaks }, over);
        // 16 slots over 8 px; each peak covers 2 slots, in order, from 0.
        for (let i = 0; i < 8; i++) {
            assert.ok(Math.abs(raw[2 * i] - peaks[i]) < 1e-9, `slot ${2 * i} = peak ${i}`);
            assert.ok(Math.abs(raw[2 * i + 1] - peaks[i]) < 1e-9, `slot ${2 * i + 1} = peak ${i}`);
        }
        // A re-trim moves the window, zero and (for the heard mixdown)
        // the tiling: the raw picture is the SAME array.
        stack.loopStart = Q; stack.loopEnd = 3 * Q;
        stack.nodes.forEach(c => { c.loopEnd = 3 * Q; c.origin = 11 * Q; });
        const again = gen(stack, { m1: peaks, m2: peaks }, { ...over, frameZero: 5 * Q });
        assert.equal(again, raw, 'raw composite stable across a re-trim');
        // Whereas the heard mixdown of the same state is a different picture.
        const heard = gen(stack, { m1: peaks, m2: peaks }, { ...over, raw: false, cache: new Map() });
        assert.notDeepEqual(Array.from(heard), Array.from(raw));
    });

    await t.test('invalidates cache when child is added', () => {
        const stack = oneClip();
        const cache = new Map();
        const args = [stack, { 'clip-1': [0.5, 0.8], 'clip-2': [0.3, 0.6] }, { canvasWidth: 200, cache }];
        gen(...args);
        const key1 = cache.get('stack-1').key;
        stack.nodes.push({ id: 'clip-2', type: 'clip', duration: 2 * Q, x: 0 });
        gen(...args);
        assert.notEqual(key1, cache.get('stack-1').key, 'Adding child should invalidate cache');
    });

    // The continuity re-anchor moves a playing group's WHOLE subtree
    // (the stack origin, which lanePeaks passes as frameZero, and every
    // member by the same delta): nothing moves relative to the frame, so
    // the key holds origin − frameZero and the array is the same one.
    await t.test('a whole-subtree origin shift keeps the key and the array', () => {
        const kids = [
            { id: 'm1', type: 'clip', duration: 4 * Q, origin: 7 * Q },
            { id: 'm2', type: 'clip', duration: 2 * Q, origin: 8 * Q,
              loopStart: 0, loopEnd: Q, windowActive: true },
        ];
        const stack = makeStack(kids);
        const peaks = { m1: [0.2, 0.9, 0.4, 0.6], m2: [0.7, 0.3] };
        const cache = new Map();
        const over = { canvasWidth: 64, cache, frameZero: 7 * Q };
        const before = gen(stack, peaks, over);
        const keyBefore = cache.get('stack-1').key;
        // The re-anchor: +23Q on the stack and its subtree alike.
        kids.forEach(k => { k.origin += 23 * Q; });
        const after = gen(stack, peaks, { ...over, frameZero: 30 * Q });
        assert.equal(cache.get('stack-1').key, keyBefore, 'same key');
        assert.equal(after, before, 'same array identity (no cross-fade)');
        // …whereas a member moving against the frame IS a new picture.
        kids[1].origin += Q;
        assert.notEqual(gen(stack, peaks, { ...over, frameZero: 30 * Q }), before,
            'a relative move regenerates');
    });

    // A recording child is out of the mixdown — and out of the key, or
    // its GROWING duration would re-key the composite on every poll.
    await t.test('a growing recording (or armed) child does not re-key', () => {
        const done = { id: 'c1', type: 'clip', duration: 4 * Q, origin: 0 };
        const live = { id: 'c2', type: 'clip', duration: Q / 3, origin: Q,
                       isRecording: true };
        const stack = makeStack([done, live]);
        const livePeaks = new Map([['c1', [0.5, 0.8, 0.3, 0.9]], ['c2', [0.4]]]);
        const again = () => gen(stack, {}, { canvasWidth: 64, livePeaks, cache, frameZero: 0 });
        const cache = new Map();
        const first = again();
        for (const grown of [Q / 2, Q, 5 * Q / 2]) {
            live.duration = grown;
            livePeaks.set('c2', new Array(Math.round(grown / Q * 50)).fill(0.4));
            assert.equal(again(), first, `still the same array at ${grown / Q}Q captured`);
        }
        // Armed (pending start) is hot too: out of key and mixdown alike.
        live.isRecording = false;
        live.isPendingStart = true;
        live.duration = 0;
        assert.equal(again(), first, 'armed: same array');
        // The commit brings it in: a new picture.
        live.isPendingStart = false;
        live.duration = 4 * Q;
        livePeaks.set('c2', [0.1, 0.2, 0.3, 0.4]);
        assert.notEqual(again(), first, 'committed: regenerates');
    });

    await t.test('skippedInComposite: one membership rule for key, sig and mixdown', () => {
        assert.equal(skippedInComposite({ id: 'a' }), false);
        assert.equal(skippedInComposite({ id: 'a', isRecording: true }), true);
        assert.equal(skippedInComposite({ id: 'a', isPendingStart: true }), true);
        assert.equal(skippedInComposite({ id: 'a' }, new Set(['a'])), true);
        assert.equal(skippedInComposite({ id: 'b' }, new Set(['a'])), false);
        // Keyed as skipped: a skipped child's own facts never reach the key.
        const s1 = of(kid({ id: 'r', origin: 0, isRecording: true }));
        const s2 = of(kid({ id: 'r', duration: 3 * Q, origin: 5 * Q, isRecording: true }));
        assert.equal(buildCacheKey(s1, 400), buildCacheKey(s2, 400));
    });
});
