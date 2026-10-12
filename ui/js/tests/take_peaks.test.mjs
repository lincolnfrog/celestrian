/**
 * take_peaks.js — the per-take peak cache: one read per (clip, take),
 * the seed a retake starts from, no reads against a hot clip, and the
 * two ways an entry leaves (the clip's take list changes; the clip
 * leaves the graph).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTakePeakCache } from '../take_peaks.js';

/** A cache over a fake backend: `answers` maps `id:k` to the peaks it
 * holds (anything else answers []), `hot` holds the ids that are armed
 * or capturing, `asked` records every read. */
function harness(answers = {}) {
    const asked = [];
    const hot = new Set();
    const cache = createTakePeakCache({
        fetchPeaks: async (id, k) => {
            asked.push(`${id}:${k}`);
            return answers[`${id}:${k}`] || [];
        },
        isHot: id => hot.has(id),
    });
    return { cache, asked, hot, answers };
}

/** A published graph index: [id, takes] per clip. */
const graph = (...clips) => new Map(clips.map(([id, takes]) =>
    [id, { id, type: 'clip', takes }]));

test('a miss reads the take once; the answer serves every later ask', async () => {
    const { cache, asked } = harness({ 'a:1': [0.1, 0.2] });
    cache.noteNodes(graph(['a', 2]));
    assert.equal(cache.now('a', 1), null, 'nothing cached yet');
    assert.equal(cache.now('a', 1), null, 'the read is still out');
    assert.deepEqual(asked, ['a:1'], 'one read while it is out');
    assert.deepEqual(await cache.fetch('a', 1), [0.1, 0.2]);
    assert.deepEqual(cache.now('a', 1), [0.1, 0.2]);
    assert.deepEqual(await cache.fetch('a', 1), [0.1, 0.2]);
    assert.deepEqual(asked, ['a:1']);
});

test('a refused read answers [] and is not remembered', async () => {
    const { cache, asked, answers } = harness();
    cache.noteNodes(graph(['a', 1]));
    assert.deepEqual(await cache.fetch('a', 0), []);
    answers['a:0'] = [0.5];
    assert.deepEqual(await cache.fetch('a', 0), [0.5]);
    assert.deepEqual(asked, ['a:0', 'a:0']);
});

test('a retake: the seeded take draws at once and the hot clip is never read', async () => {
    const { cache, asked, hot } = harness();
    const committed = [0.3, 0.6, 0.9];
    cache.noteNodes(graph(['a', 1]));
    hot.add('a');
    cache.seed('a', 0, committed);
    for (let patch = 0; patch < 40; patch++) {
        assert.equal(cache.now('a', 0), committed);
    }
    assert.deepEqual(asked, []);
});

test('a hot clip with nothing seeded is not read on every patch', async () => {
    const { cache, asked, hot, answers } = harness();
    cache.noteNodes(graph(['a', 1]));
    hot.add('a');
    for (let patch = 0; patch < 40; patch++) {
        assert.equal(cache.now('a', 0), null);
    }
    assert.deepEqual(asked, [], 'the backend answers a hot clip nothing');
    hot.delete('a');
    answers['a:0'] = [0.4];
    assert.equal(cache.now('a', 0), null);
    assert.deepEqual(asked, ['a:0'], 'idle again: the miss reads it');
});

test('an empty seed is no seed', () => {
    const { cache, hot } = harness();
    cache.noteNodes(graph(['a', 1]));
    hot.add('a');
    cache.seed('a', 0, []);
    cache.seed('a', 0, undefined);
    assert.equal(cache.now('a', 0), null);
});

test('a take-list change drops the clip\'s takes — seeds and reads still out included', async () => {
    const release = {};
    const asked = [];
    const cache = createTakePeakCache({
        fetchPeaks: (id, k) => {
            asked.push(`${id}:${k}`);
            return new Promise(resolve => { release[`${id}:${k}`] = resolve; });
        },
        isHot: () => false,
    });
    cache.noteNodes(graph(['a', 2], ['b', 1]));
    cache.seed('a', 0, [0.1]);
    cache.seed('b', 0, [0.7]);
    const stale = cache.fetch('a', 1);

    cache.noteNodes(graph(['a', 1], ['b', 1]));  // take 1 of `a` deleted
    release['a:1']([0.9]);
    assert.deepEqual(await stale, [0.9], 'the asker still gets its answer');
    assert.deepEqual(cache.now('b', 0), [0.7], 'another clip keeps its takes');
    assert.equal(cache.now('a', 0), null, 'the seed went with the old list');
    assert.equal(cache.now('a', 1), null, 'the late answer was not cached');
    assert.deepEqual(asked, ['a:1', 'a:0', 'a:1'], 'both are read afresh');
});

test('a clip that left the graph leaves the cache', () => {
    const { cache, asked } = harness();
    cache.noteNodes(graph(['a', 1], ['b', 1]));
    cache.seed('a', 0, [0.1]);
    cache.seed('b', 0, [0.2]);
    assert.equal(cache.clipCount(), 2);
    cache.noteNodes(graph(['a', 1]));
    assert.equal(cache.clipCount(), 1);
    assert.deepEqual(cache.now('a', 0), [0.1]);
    cache.noteNodes(graph(['a', 1], ['b', 1]));  // restored (an undo)
    assert.equal(cache.now('b', 0), null, 'a restored clip is read again');
    assert.deepEqual(asked, ['b:0']);
});
