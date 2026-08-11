/**
 * mock/devices.js — audio device, input list, and latency-calibration
 * mocks. Pure fixtures + a little phase state; nothing here touches the
 * graph. publish.js reads the calibration result through
 * getCalibrationSamples() rather than the raw state.
 *
 * The device's sample rate is NOT stored here — it lives in mock/rate.js
 * (the mock's single rate variable), so the panel and the published
 * `perf.sampleRate` can never disagree again. They used to: this file
 * reported 48000 while publish.js published a hardcoded 44100.
 */

import { getSampleRate, setSampleRate, toSeconds } from './rate.js';

/* ---------- audio devices ----------
 *
 * Models the real Windows shape so the picker can be exercised in the
 * browser: a WASAPI type whose multi-channel interface is split into
 * stereo endpoints, and an ASIO type where the same box appears whole.
 * Switching type is what unlocks the extra inputs — that is the whole
 * point of the panel.
 */
const mockDevices = {
    'Windows Audio': [
        { name: 'MOTU Analog 1-2', inputs: 2 },
        { name: 'MOTU Analog 3-4', inputs: 2 },
        { name: 'MOTU Mic/Instrument 1-2', inputs: 2 },
        { name: 'Microphone (USB Audio Device)', inputs: 2 },
    ],
    'ASIO': [
        { name: 'MOTU Audio ASIO', inputs: 10 },
        { name: 'ASIO4ALL v2', inputs: 2 },
    ],
};

const mockAudio = {
    type: 'Windows Audio',
    device: 'Microphone (USB Audio Device)',
    // sampleRate lives in mock/rate.js — read through getSampleRate().
    bufferSize: 256,
    error: '',
};

/** Rates this fake interface advertises. The rate actually in force is
 *  always offered, however it was selected (?rate=, env, setAudioDevice). */
const OFFERED_SAMPLE_RATES = [44100, 48000, 88200, 96000];

function currentMockDevice() {
    return (mockDevices[mockAudio.type] || []).find(d => d.name === mockAudio.device);
}

export function getAudioDeviceState() {
    const dev = currentMockDevice();
    const list = mockDevices[mockAudio.type] || [];
    return {
        types: Object.keys(mockDevices),
        currentType: mockAudio.type,
        devices: list.map(d => d.name),
        currentDevice: dev ? dev.name : '',
        sampleRates: [...new Set([...OFFERED_SAMPLE_RATES, getSampleRate()])]
            .sort((a, b) => a - b),
        currentSampleRate: getSampleRate(),
        bufferSizes: [64, 128, 256, 512, 1024],
        currentBufferSize: mockAudio.bufferSize,
        inputChannels: dev ? dev.inputs : 0,
        outputChannels: 2,
        availableInputChannels: dev ? dev.inputs : 0,
        asioAvailable: true,
        error: mockAudio.error,
    };
}

export function setAudioDevice(type, device, sampleRate, bufferSize) {
    if (type && mockDevices[type]) mockAudio.type = type;
    const list = mockDevices[mockAudio.type] || [];
    // A type switch invalidates the device name — fall to that type's first.
    if (device && list.some(d => d.name === device)) mockAudio.device = device;
    else if (!list.some(d => d.name === mockAudio.device)) {
        mockAudio.device = list.length ? list[0].name : '';
    }
    // The rate is systemic: switching it here re-rates the whole mock
    // (published perf.sampleRate, seconds conversions, tick size).
    // Already-loaded scenario fixtures keep the lengths they were built
    // with — reload a scenario after switching for a coherent session.
    if (sampleRate > 0) setSampleRate(sampleRate);
    if (bufferSize > 0) mockAudio.bufferSize = bufferSize;
    mockAudio.error = '';
    console.log('[MockBackend] Audio device:', mockAudio,
        'rate:', getSampleRate());
    return '';
}

export function getInputList() {
    // Shape matches AudioEngine::getInputList: { inputs: [...] } — ACTIVE
    // channels only, so the index IS the audio callback's channel index.
    const dev = currentMockDevice();
    const n = dev ? dev.inputs : 0;
    return {
        inputs: Array.from({ length: n },
            (_, i) => `${mockAudio.device} ${i + 1}`),
    };
}

// Latency calibration (docs/performance.md §7). The mock simulates a 2 s
// capture window and reports a plausible fixed round trip.
let calibration = { phase: 'idle', startedAt: 0, roundTripSamples: -1 };
const MOCK_ROUND_TRIP_SAMPLES = 1024;

export function startLatencyCalibration() {
    calibration = { phase: 'capturing', startedAt: Date.now(), roundTripSamples: -1 };
    console.log('[MockBackend] Latency calibration started');
    return true;
}

export function getLatencyCalibration() {
    if (calibration.phase === 'capturing' && Date.now() - calibration.startedAt >= 2000) {
        calibration.phase = 'done';
        calibration.roundTripSamples = MOCK_ROUND_TRIP_SAMPLES;
    }
    const calibrated = calibration.roundTripSamples >= 0;
    return {
        phase: calibration.phase,
        roundTripSamples: calibration.roundTripSamples,
        roundTripMs: calibrated ? toSeconds(calibration.roundTripSamples) * 1000 : -1,
        calibrated,
    };
}

/** The calibration result for state publication (−1 = uncalibrated) —
 * publish.js reads this instead of the raw calibration object. */
export function getCalibrationSamples() {
    return calibration.roundTripSamples;
}
