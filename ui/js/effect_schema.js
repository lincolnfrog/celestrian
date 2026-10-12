/**
 * Display schema for the built-in effects: each card's sliders — the
 * param key the engine publishes on a slot, its range, step and
 * readout — in the engine's canonical order. The engine owns the
 * params and clamps to the same ranges (src/dsp/fx_chain.cc);
 * effect_contract.test.mjs holds the two together.
 */

const db = v => (v > 0 ? '+' : '') + Number(v).toFixed(1) + ' dB';
const ms = v => Number(v).toFixed(v < 10 ? 1 : 0) + ' ms';
const sec = v => Number(v).toFixed(2) + ' s';
const pct = v => Math.round(v * 100) + '%';
const ratio = v => Number(v).toFixed(1) + ':1';

export const EFFECT_SCHEMA = [
    {
        type: 'eq', label: 'EQ',
        params: [
            { key: 'low', label: 'low', min: -12, max: 12, step: 0.5, fmt: db },
            { key: 'mid', label: 'mid', min: -12, max: 12, step: 0.5, fmt: db },
            { key: 'high', label: 'high', min: -12, max: 12, step: 0.5, fmt: db },
        ],
    },
    {
        type: 'compressor', label: 'COMP',
        params: [
            { key: 'threshold', label: 'thr', min: -60, max: 0, step: 1, fmt: db },
            { key: 'ratio', label: 'ratio', min: 1, max: 20, step: 0.5, fmt: ratio },
            { key: 'attack', label: 'atk', min: 0.1, max: 100, step: 0.1, fmt: ms },
            { key: 'release', label: 'rel', min: 10, max: 1000, step: 5, fmt: ms },
            // An output trim: it may cut as well as raise.
            { key: 'makeup', label: 'gain', min: -12, max: 24, step: 0.5, fmt: db },
        ],
    },
    {
        type: 'echo', label: 'ECHO',
        params: [
            { key: 'time', label: 'time', min: 0.05, max: 2, step: 0.01, fmt: sec },
            { key: 'feedback', label: 'fdbk', min: 0, max: 0.9, step: 0.01, fmt: pct },
            { key: 'mix', label: 'mix', min: 0, max: 1, step: 0.01, fmt: pct },
        ],
    },
    {
        type: 'reverb', label: 'VERB',
        params: [
            { key: 'size', label: 'size', min: 0, max: 1, step: 0.01, fmt: pct },
            { key: 'damp', label: 'damp', min: 0, max: 1, step: 0.01, fmt: pct },
            { key: 'mix', label: 'mix', min: 0, max: 1, step: 0.01, fmt: pct },
        ],
    },
];
