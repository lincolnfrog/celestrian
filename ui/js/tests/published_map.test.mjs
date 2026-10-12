/**
 * THE PUBLISHED NODE'S MAP (ui/js/time_map.js publishedMap /
 * publishedMapPeriod / nodeWindowActive) — the one reading of
 * `segments` / `loopStart` / `loopEnd` / `windowActive` off node
 * metadata that the view model and the period law's providers share.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { publishedMap, publishedMapPeriod, nodeWindowActive } from '../time_map.js';

const clip = extra => ({ id: 'c', type: 'clip', duration: 8000, loopStart: 0,
                         loopEnd: 0, loopBypassed: false, windowActive: false,
                         ...extra });

test('one window, many segments, or no map at all', () => {
    assert.deepEqual(publishedMap(clip({})).segs, [], 'no map');
    assert.deepEqual(publishedMap(clip({ loopStart: 2000, loopEnd: 5000 })).segs,
        [[2000, 5000]], 'the single window');
    // A multi-segment map publishes loopStart = loopEnd = 0 beside
    // `segments`: the geometry is the segments.
    assert.deepEqual(
        publishedMap(clip({ segments: [2000, 4000, 5000, 6000] })).segs,
        [[2000, 4000], [5000, 6000]], 'the segments');
    assert.deepEqual(publishedMap(clip({ loopStart: 3000, loopEnd: 3000 })).segs,
        [], 'an empty window is no map');
});

test('the period is the map a node PLAYS: 0 unless the window is active', () => {
    const multi = { segments: [2000, 4000, 5000, 6000] };
    assert.equal(publishedMapPeriod(clip({ ...multi, windowActive: true })), 3000);
    assert.equal(publishedMapPeriod(clip({ loopStart: 2000, loopEnd: 5000,
                                           windowActive: true })), 3000);
    // Bypassed: the geometry survives, and nothing of it plays.
    const bypassed = clip({ ...multi, loopBypassed: true, windowActive: false });
    assert.deepEqual(publishedMap(bypassed).segs, [[2000, 4000], [5000, 6000]]);
    assert.equal(publishedMapPeriod(bypassed), 0);
    // Suspended (S16): the engine's verdict folds it in.
    assert.equal(publishedMapPeriod({ type: 'stack', loopStart: 0, loopEnd: 4000,
        windowSuspended: true, windowActive: false }), 0);
});

test('a state without `windowActive` reads active from its geometry and bypass', () => {
    const bare = extra => ({ type: 'clip', duration: 8000, ...extra });
    assert.equal(nodeWindowActive(bare({ loopStart: 0, loopEnd: 2000 })), true);
    assert.equal(nodeWindowActive(bare({ segments: [0, 1000, 2000, 3000] })), true);
    assert.equal(nodeWindowActive(bare({})), false);
    assert.equal(nodeWindowActive(bare({ loopStart: 0, loopEnd: 2000,
                                         loopBypassed: true })), false);
    assert.equal(publishedMapPeriod(bare({ loopStart: 1000, loopEnd: 3000 })), 2000);
    // The published verdict wins over the geometry.
    assert.equal(publishedMapPeriod(bare({ loopStart: 1000, loopEnd: 3000,
                                           windowActive: false })), 0);
});

test('one clamp: a committed clip\'s span ends where its take does', () => {
    assert.deepEqual(publishedMap(clip({ loopStart: 6000, loopEnd: 9000 })).segs,
        [[6000, 8000]], 'a window past the take');
    assert.deepEqual(
        publishedMap(clip({ segments: [1000, 2000, 7000, 9000, 9500, 9900] })).segs,
        [[1000, 2000], [7000, 8000]], 'segments past the take');
    assert.equal(publishedMapPeriod(clip({ loopStart: 6000, loopEnd: 9000,
                                           windowActive: true })), 2000);
    // A live take publishes what it has captured so far as `duration`:
    // the slot's region is not cut to it.
    assert.deepEqual(publishedMap(clip({ loopStart: 2000, loopEnd: 6000,
        isRecording: true, duration: 500 })).segs, [[2000, 6000]]);
    // A stack publishes no take of its own.
    assert.deepEqual(publishedMap({ type: 'stack', loopStart: 2000,
                                    loopEnd: 6000 }).segs, [[2000, 6000]]);
    // An empty clip has nothing to clamp to.
    assert.deepEqual(publishedMap(clip({ duration: 0, loopStart: 2000,
                                         loopEnd: 6000 })).segs, [[2000, 6000]]);
});
