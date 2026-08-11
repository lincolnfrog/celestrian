/**
 * Display schema for the built-in effect rack (src/dsp/effects.h).
 *
 * The engine owns the truth (ranges are clamped there too); this is the
 * UI's rendering of the same fixed rack, in the same canonical order
 * EQ → Compressor → Echo → Reverb. Keys match the metadata the engine
 * publishes on every node under `effects`.
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
            // Output trim: makeup convention is raise-only (compression
            // removes level; this restores it) but cutting is useful too
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

/**
 * Enabled-slot count for a node's published effects state.
 * Currently unimported — kept as the canonical helper for any future
 * "N fx on" badge so callers don't re-derive it from EFFECT_SCHEMA.
 */
export function enabledFxCount(effects) {
    if (!effects) return 0;
    return EFFECT_SCHEMA.reduce(
        (n, fx) => n + (effects[fx.type] && effects[fx.type].enabled ? 1 : 0), 0);
}
