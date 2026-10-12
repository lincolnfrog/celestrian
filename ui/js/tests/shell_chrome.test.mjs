/**
 * The pure halves of the chrome the poll patches: the Calibrate
 * button's label and a calibration's verdict (preferences.js), and the
 * master monitor's title (vu_meter.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { calibrateLabel, calibrationVerdict } from '../preferences.js';
import { masterMonitorTitle, masterLevelsMissing } from '../vu_meter.js';

test('calibrateLabel: plain until calibrated, then the compensation in force', () => {
    assert.equal(calibrateLabel({ calibrated: false, sampleRate: 48000 }), '🎯 Calibrate');
    assert.equal(calibrateLabel({}), '🎯 Calibrate');
    assert.equal(calibrateLabel({ calibrated: true, sampleRate: 48000,
                                  latencyCompensationSamples: 480 }),
        '🎯 Recalibrate (10.0 ms)');
    assert.equal(calibrateLabel({ calibrated: true, latencyCompensationSamples: 441 }),
        '🎯 Recalibrate (10.0 ms)', 'no published rate: 44.1 kHz');
});

test('calibrationVerdict: the round trip, or why there was none', () => {
    assert.equal(calibrationVerdict({ calibrated: true, roundTripSamples: 512,
                                      roundTripMs: 10.666 }),
        'Latency: 512 samples (10.7 ms)');
    assert.match(calibrationVerdict({ calibrated: false, phase: 'failed' }),
        /^Calibration failed — no loopback signal/);
    assert.match(calibrationVerdict(null), /^Calibration failed/,
        'no answer before the ceiling');
});

test('masterMonitorTitle: the dB readout of both channels', () => {
    const title = masterMonitorTitle({ masterVuL: 1, masterVuR: 0.5 });
    assert.match(title, /^Master output \(post-fader\) — L 0\.0 dB · R -6\.0 dB/);
    assert.match(masterMonitorTitle({ masterVuL: 0, masterVuR: 0 }), /L −∞ dB · R −∞ dB/);
});

test('masterMonitorTitle: an engine that publishes no master levels says so', () => {
    assert.equal(masterLevelsMissing({}), true);
    assert.equal(masterLevelsMissing({ masterVuL: 0 }), false, 'silence is a level');
    assert.match(masterMonitorTitle({}), /^No master levels in engine state/);
});

test('masterMonitorTitle: one reading, one string — the guarded write has nothing to rewrite', () => {
    const state = { masterVuL: 0.25, masterVuR: 0.125 };
    assert.equal(masterMonitorTitle(state), masterMonitorTitle({ ...state }));
    assert.notEqual(masterMonitorTitle(state), masterMonitorTitle({ ...state, masterVuL: 0.26 }));
});
