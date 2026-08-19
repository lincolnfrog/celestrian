/**
 * mock/publish.js — the state publication boundary: getState() (the
 * mock's getGraphState mirror, polled by the UI), node enrichment to the
 * engine's metadata shape, the synthesized master VU, and the two test
 * hooks that poke the underlying clock (setMasterPos / setIsPlaying).
 */

import { posMod } from '../math_utils.js';
import { mapPeriod, mapActive, mapOffset } from '../time_map.js';
import { state, nodeMap, someNode } from './state.js';
import { canUndo, canRedo } from './undo.js';
import { advanceTransport, viewMasterPos } from './transport.js';
import { ensureEffects } from './effects.js';
import { getCalibrationSamples } from './devices.js';
import { getSampleRate, toSeconds } from './rate.js';

/**
 * Recursively project raw graph nodes into the ENGINE's published
 * metadata shape: normalized mixer/period facts, effect racks on every
 * node, loop-window state (windowActive + playhead phase), flat
 * multi-segment publication, and scope telemetry while a panel watches.
 * Returns NEW objects — the raw state tree is never handed out.
 */
export function enrichNodes(nodes) {
    return nodes.map(node => {
        // NO synthetic `waveform` on stacks: the ENGINE's state metadata
        // carries no waveform field, so the UI composites stacks from
        // child peaks (composite_waveform.js). The mock once attached
        // count-normalized sines, which short-circuited that path AND
        // dimmed when a silent track was added (mock/engine drift —
        // test_harness.md gotcha 10, field 2026-07-10).
        const updatedNode = node.type === 'stack'
            ? { ...node, nodes: node.nodes ? enrichNodes(node.nodes) : [] }
            : { ...node };

        // Loop window state — FRACTAL, engine parity (AudioNode base):
        // active iff valid and not bypassed, published for clips and
        // stacks alike; `playhead` carries the window phase while
        // active: (masterPos − epoch) mod len.
        const bypassed = !!node.loopBypassed;
        const windowActive = !bypassed && mapActive(nodeMap(node));
        // Multi-segment map publish (engine parity: flat samples array,
        // present only with an override).
        if (node.segments && node.segments.length >= 2) {
            updatedNode.segments = node.segments.flat();
        }
        updatedNode.loopBypassed = bypassed;
        updatedNode.windowActive = windowActive;
        // Effect chain state publishes on EVERY node (engine parity:
        // AudioNode::getMetadata always carries `effects` = {chain,
        // scope?}). ensureEffects INSTALLS the default chain on the
        // node — slot uuids must be STABLE across polls (a fresh chain
        // per publish would orphan every slot-keyed edit in flight).
        updatedNode.effects = ensureEffects(node);
        // Mixer + period-source facts publish on EVERY node (engine
        // parity: metadata always carries them; hand-written scenario
        // fixtures predate the fields, so normalize at the boundary).
        updatedNode.midiArmed = !!node.midiArmed;
        if (typeof updatedNode.gain !== 'number') updatedNode.gain = 1;
        if (typeof updatedNode.pan !== 'number') updatedNode.pan = 0;
        if (!updatedNode.periodSource) updatedNode.periodSource = 'own';
        // Scope telemetry (engine parity: published only while a panel
        // WATCHES — setEffectScope). Synthesized: a pink-ish spectrum
        // that breathes with the transport, a peak, and the
        // compressor's theoretical GR.
        const fxs = updatedNode.effects;
        const comp = (fxs.chain || []).find(s => s.type === 'compressor');
        if (node._scopeOn) {
            const t = toSeconds(state.masterPos);
            const peak = state.isPlaying
                ? 0.35 + 0.3 * Math.abs(Math.sin(t * 2.1 + 0.4)) : 0;
            let gr = 0;
            if (comp && comp.enabled && peak > 0) {
                const peakDb = 20 * Math.log10(peak);
                if (peakDb > comp.threshold) {
                    gr = (peakDb - comp.threshold) * (1 - 1 / comp.ratio);
                }
            }
            // Engine parity: a stopped transport is SILENCE — bins near
            // zero (this is what the durable line's slow fall exists for)
            const live = state.isPlaying ? 1 : 0;
            updatedNode.effects = {
                ...fxs,
                scope: {
                    spectrum: Array.from({ length: 24 }, (_, i) =>
                        Math.max(0, Math.min(1,
                            0.72 - i * 0.022 + 0.2 * Math.sin(t * 3 + i * 0.7))) * live),
                    peak,
                    gr,
                },
            };
        }
        if (windowActive) {
            const m = nodeMap(node);
            const loopLen = mapPeriod(m);
            // Engine parity: a STACK's map phase is island-aligned
            // ((t − epoch) mod period); a CLIP's anchors at
            // origin + mapOffset(0) — the ANCHORING LAW (phase 3),
            // whose single-segment case is origin + loopStart
            // (clip_node.cc, 2026-07-19).
            const anchor = node.type === 'clip'
                ? (node.origin || 0) + mapOffset(m, 0)
                : state.islandEpoch;
            const rel = state.masterPos - anchor;
            updatedNode.playhead = posMod(rel, loopLen) / loopLen;
        }

        return updatedNode;
    });
}

/** Synthesized master level for mock mode (see getState). Derived from
 * masterPos (not wall-clock) so deterministic advanceBy() tests get
 * deterministic levels, and silence when transport is stopped. */
function mockMasterVu(phase) {
    if (!state.isPlaying) return 0;
    const anyAudio = someNode(n => n.duration > 0 || n.isRecording);
    if (!anyAudio) return 0;
    const t = toSeconds(state.masterPos);
    const lv = 0.30 + 0.16 * Math.sin(t * 2.1 + phase) +
        0.10 * Math.sin(t * 5.3 + phase * 2) +
        0.05 * Math.sin(t * 11.7 + phase);
    // The master fader attenuates what reaches the meters (engine
    // parity: the VU taps the summed output AFTER the root's gain).
    return Math.max(0, Math.min(1, lv)) * state.masterGain;
}

export function getState() {
    // Auto-advance transport if running (simulates real-time playback/recording)
    advanceTransport();

    const calibrationSamples = getCalibrationSamples();
    return {
        // Root identity (engine parity: the focused root's uuid) — the
        // move-to-top target for drag-out.
        id: 'mock-root',
        isPlaying: state.isPlaying,
        masterPos: viewMasterPos(),
        // Master monitor (engine parity: smoothed output RMS, linear
        // 0..1). Synthesized from the transport so the VU needles sweep
        // believably in mock mode: silent when stopped, a slow musical
        // undulation with slight L/R decorrelation while playing.
        masterVuL: mockMasterVu(0),
        masterVuR: mockMasterVu(1.3),
        // Root output-stage gain (engine parity: the root stack
        // publishes `gain` like every node) — the master fader's value.
        gain: state.masterGain,
        // The raw island clock (engine parity): epoch-relative,
        // unwrapped — the UI folds it on its own pinned frame during
        // map gestures for a continuous cursor.
        islandPos: state.masterPos - state.islandEpoch,
        // Island epoch (mirrors getGraphState): the UI's frame origin.
        // Commit re-bases it to the newest origin on simple extensions.
        islandEpoch: state.islandEpoch,
        // The STORED island quantum (mirrors the root stack's `quantum`
        // metadata). 0 for scenario fixtures that predate the field —
        // the VM then falls back to its min-over-nodes derivation.
        quantum: state.islandQ,
        canUndo: canUndo(),
        canRedo: canRedo(),
        nodes: enrichNodes(state.nodes),
        // Mirrors AudioEngine::makePerfState so calibration-aware UI
        // (e.g. the calibrate button label) behaves in mock mode.
        perf: {
            maxBlockUs: 0,
            avgLoadPct: 0,
            xruns: 0,
            latencyCompensationSamples:
                calibrationSamples >= 0 ? calibrationSamples : 0,
            calibrated: calibrationSamples >= 0,
            // The DEVICE rate (engine parity: makePerfState publishes
            // the rate the callback is running at) — mock/rate.js.
            sampleRate: getSampleRate(),
        },
    };
}

// Allow tests to set master position on underlying state
export function setMasterPos(pos) {
    state.masterPos = pos;
}

// Allow tests to set isPlaying on underlying state
export function setIsPlaying(playing) {
    state.isPlaying = playing;
}
