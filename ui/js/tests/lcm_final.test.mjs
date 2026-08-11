/**
 * timelineLcm jitter-rounding: committed durations can arrive with
 * float residue (a 3Q take publishing 132300.00001 samples); the LCM
 * must round each duration to whole samples FIRST or the cycle explodes
 * (the raw float LCM of the 2026-07 field bug). The clean integer
 * vectors live in shared/timing_golden.json (timeline_model_golden
 * .test.mjs) — this file pins only the jitter property, against the
 * real production function (the old copy here tested a local lcm).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { timelineLcm } from '../timeline_model.js';
import { MOCK_Q as Q } from './helpers.mjs';

test('timelineLcm rounds float jitter before LCM-ing (no cycle explosion)', () => {
    // 1Q + 4Q + (3Q + ε): the ε must be ignored — 12Q, not astronomical
    assert.equal(timelineLcm([Q, 4 * Q, 3 * Q + 0.00001], Q), 12 * Q);
    // …and jitter below the integer too
    assert.equal(timelineLcm([Q, 4 * Q, 3 * Q - 0.00001], Q), 12 * Q);
    // A jittered QUANTUM is rounded the same way
    assert.equal(timelineLcm([Q, 3 * Q], Q + 0.4), 3 * Q);
});
