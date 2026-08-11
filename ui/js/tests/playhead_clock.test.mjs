/**
 * Playhead dead-reckoning clock (docs/ui_overhaul.md law 10 coda).
 *
 * The property that motivated the module (field 2026-07-11): the drawn
 * sweep must TOUCH the loop end and restart near zero — the CSS-glide
 * renderer lagged its target and visually wrapped early.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    forwardDelta, estimateVelocity, advancePosition, correctPosition,
} from '../playhead_clock.js';
import { near } from './helpers.mjs';

test('forwardDelta: wrap-aware forward movement', () => {
    near(forwardDelta(0.05, 1.95, 2), 0.1);   // playback across the wrap
    near(forwardDelta(1.5, 1.4, 2), 0.1);     // plain forward motion
    // A backwards seek reads as a huge forward delta (→ teleport)
    assert.ok(forwardDelta(0.5, 1.5, 2) > 0.9);
    // No loop: plain difference
    assert.equal(forwardDelta(3, 1, 0), 2);
});

test('estimateVelocity: observes, never assumes', () => {
    const nominal = 0.001; // 1Q/s in Q-per-ms
    // Static target → velocity decays toward zero
    let v = nominal;
    for (let i = 0; i < 10; i++) v = estimateVelocity(v, 0, 50, nominal).vel;
    assert.ok(v < nominal * 0.01);
    // Steady playback → converges to nominal
    v = 0;
    for (let i = 0; i < 20; i++) v = estimateVelocity(v, 0.05, 50, nominal).vel;
    assert.ok(Math.abs(v - nominal) < nominal * 0.01);
    // A seek (2Q in one 50ms poll) is a teleport, not a speed burst
    const t = estimateVelocity(nominal, 2, 50, nominal);
    assert.equal(t.teleport, true);
    assert.equal(t.vel, 0);
});

test('advancePosition wraps exactly at the loop boundary', () => {
    // Crossing the boundary lands at (pos + v·dt) − loop, never clamps
    near(advancePosition(1.99, 0.001, 20, 2), 0.01);
    // Reaching it exactly wraps to 0
    near(advancePosition(1.98, 0.001, 20, 2), 0);
    // No loop: unbounded
    near(advancePosition(1.99, 0.001, 20, 0), 2.01);
});

test('correctPosition: eases small errors, snaps teleports, wrap-aware', () => {
    // Small error eases 30% toward the target
    near(correctPosition(1.0, 1.1, 2), 1.03);
    // Error across the wrap takes the short path (1.95 → target 0.05)
    const p = correctPosition(1.95, 0.05, 2);
    assert.ok(p > 1.95 || p < 0.1, `wrapped correction, got ${p}`);
    // Large error snaps outright
    assert.equal(correctPosition(0.2, 1.2, 2), 1.2);
});

test('THE BUG PROPERTY: the rendered sweep touches the loop end and restarts near zero', () => {
    // Simulate the real pipeline: target advances at 1Q/s published
    // every 50ms; frames render every 16ms with dead-reckoning.
    const nominal = 0.001, loop = 2;
    let vel = 0, pos = 0, target = 0, lastTarget = 0;
    const rendered = [];
    for (let ms = 0; ms <= 4200; ms += 16) {
        if (ms % 48 === 0) { // ~poll cadence
            target = (ms * nominal) % loop;
            const { vel: v, teleport } = estimateVelocity(
                vel, forwardDelta(target, lastTarget, loop), 48, nominal);
            vel = v;
            pos = teleport ? target : correctPosition(pos, target, loop);
            lastTarget = target;
        }
        pos = advancePosition(pos, vel, 16, loop);
        rendered.push(pos);
    }
    const max = Math.max(...rendered);
    assert.ok(max > loop - 0.04, `sweep reaches the end (max=${max})`);
    // Find the wrap; the frame after it must be near zero
    for (let i = 1; i < rendered.length; i++) {
        if (rendered[i] < rendered[i - 1] - loop / 2) {
            assert.ok(rendered[i - 1] > loop - 0.04,
                `wrapped FROM the end (${rendered[i - 1]})`);
            assert.ok(rendered[i] < 0.06,
                `restarted NEAR zero (${rendered[i]})`);
            return;
        }
    }
    assert.fail('no wrap observed in 4.2s of a 2s loop');
});
