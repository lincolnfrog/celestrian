/**
 * display_boost.js — the one normalization rule, and its three users
 * agreeing on it: a committed take (peaksBoost), a canvas normalizing
 * its own columns (envelopeBoost) and the live bar's target (liveBoost).
 * The live ratchet is seamless at commit only while they agree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { boostForMax, NORM_TARGET, NORM_MAX_BOOST } from '../display_boost.js';
import { peaksBoost, envelopeBoost, poolColumns } from '../canvas_renderer.js';
import { liveBoost } from '../live_peaks.js';
import { makeLcg } from './helpers.mjs';

test('boostForMax: the loudest peak is drawn at the target height', () => {
    for (const max of [0.2, 0.5, 0.95, 1]) {
        assert.ok(Math.abs(boostForMax(max) * max - NORM_TARGET) < 1e-12, `max ${max}`);
    }
    assert.ok(boostForMax(1) < 1, 'a full-scale take is drawn just short of full height');
});

test('boostForMax: quiet content is boosted no further than the cap; silence not at all', () => {
    const knee = NORM_TARGET / NORM_MAX_BOOST;
    assert.equal(boostForMax(knee / 2), NORM_MAX_BOOST);
    assert.equal(boostForMax(1e-9), NORM_MAX_BOOST);
    assert.ok(boostForMax(knee * 1.01) < NORM_MAX_BOOST);
    assert.equal(boostForMax(0), 1);
});

test('a committed take, a self-normalizing canvas and a live bar pick the same boost', () => {
    for (const peaks of [[0.1, 0.4, 0.25], [0.01, 0.02], [0, 0, 0], [1, 0.3]]) {
        const want = boostForMax(Math.max(...peaks));
        assert.equal(peaksBoost(peaks), want, `peaksBoost of [${peaks}]`);
        assert.equal(envelopeBoost(Float32Array.from(peaks)),
            boostForMax(Math.max(...Float32Array.from(peaks))), `envelopeBoost of [${peaks}]`);
        assert.equal(liveBoost(undefined, peaks), want, `liveBoost's target for [${peaks}]`);
    }
});

test('the live bar settles on the boost its committed take is drawn at', () => {
    const peaks = [0.05, 0.3, 0.62, 0.2];
    let boost;
    for (let poll = 0; poll < 80; poll++) boost = liveBoost(boost, peaks);
    assert.ok(Math.abs(boost - peaksBoost(peaks)) < 1e-9,
        `live ${boost} vs committed ${peaksBoost(peaks)}`);
});

test('envelopeBoost: a boost the caller fixes wins; normalize:false draws raw', () => {
    const cols = Float32Array.from([0.1, 0.2]);
    assert.equal(envelopeBoost(cols, { fixedBoost: 3 }), 3);
    assert.equal(envelopeBoost(cols, { normalize: false }), 1);
});

test('peaksBoost: strings from JSON read as numbers; no peaks is no boost', () => {
    assert.equal(peaksBoost(['0.1', '0.5']), boostForMax(0.5));
    assert.equal(peaksBoost([]), 1);
    assert.equal(peaksBoost(null), 1);
});

test('peaksBoost: cached per array identity; a canvas showing the whole array pooled picks it too', () => {
    const p = [0.1, 0.5, 0.25];
    assert.equal(peaksBoost(p), 0.95 / 0.5);
    p[1] = 0.9;  // same identity → the cached value (arrays are replaced on refetch)
    assert.equal(peaksBoost(p), 0.95 / 0.5);
    const rnd = makeLcg(3);
    const q = Array.from({ length: 1000 }, () => 0.05 + 0.85 * rnd());
    assert.ok(Math.abs(envelopeBoost(poolColumns(q, 300)) - peaksBoost(q)) < 1e-6);
});
