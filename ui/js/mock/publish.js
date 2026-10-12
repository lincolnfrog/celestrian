/**
 * mock/publish.js — getState(): the mock's getGraphState. Every node,
 * the root included, is published through ONE explicit field list
 * (engine AudioNode / ClipNode / StackNode::getMetadata), so nothing
 * private leaves and nothing published is stored twice. Also the
 * synthesized meters and the two test hooks that poke the clock.
 */

import { fromSamples } from '../qtime.js';
import { mapPeriod, effectiveTop } from '../time_map.js';
import { sequenceProgram } from '../sequence_program.js';
import {
    state, ROOT_ID, storedMap, activeMapOf, windowSuspendedOf, islandDefiner,
    intrinsicOfNode, takeLength, takesOf, isCommittedClip, someNode,
} from './state.js';
import { auditionMapOf } from './seq_query.js';
import { receivedAt, ownInnerAt, effectiveMap } from './heard.js';
import { canUndo, canRedo } from './undo.js';
import { advanceTransport, viewMasterPos } from './transport.js';
import { ensureEffects } from './effects.js';
import { getCalibrationSamples } from './devices.js';
import { getSampleRate, toSeconds } from './rate.js';

function publishedSequence(holder) {
    const seq = holder.sequence;
    const program = sequenceProgram(seq);
    return {
        bypassed: !!holder.sequenceBypassed,
        steps: seq.steps.map(s => ({ ...s, ...(s.next ? { next: s.next.map(n => ({ ...n })) } : {}) })),
        seed: (seq.seed || 0) >>> 0,
        program: program.visits.slice(),
        radio: program.radio,
        gates: Object.fromEntries(Object.entries(seq.gates || {}).map(([k, v]) => [k, [...v]])),
        auditionStep: auditionMapOf(holder) ? holder.auditionStep : -1,
    };
}

/** The rack as published: the chain, and — while a panel watches — a
 * synthesized scope (a spectrum that breathes with the transport, a
 * peak, the compressor's theoretical gain reduction). */
function publishedEffects(node) {
    const chain = ensureEffects(node).chain.map(slot => ({ ...slot }));
    if (!node._scopeOn) return { chain };
    const t = toSeconds(state.masterPos);
    const live = state.isPlaying ? 1 : 0;
    const peak = live * (0.35 + 0.3 * Math.abs(Math.sin(t * 2.1 + 0.4)));
    const comp = chain.find(s => s.type === 'compressor');
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const gr = comp && comp.enabled && peakDb > comp.threshold
        ? (peakDb - comp.threshold) * (1 - 1 / comp.ratio) : 0;
    const spectrum = Array.from({ length: 24 }, (_, i) =>
        Math.max(0, Math.min(1, 0.72 - i * 0.022 + 0.2 * Math.sin(t * 3 + i * 0.7))) * live);
    return { chain, scope: { spectrum, peak, gr } };
}

/** One node as the engine publishes it. A take's state is narrowed
 * here: armed is `isPendingStart` alone, `isRecording` means capturing,
 * and `duration` is then the live captured length (a new take's too). */
function publishNode(node) {
    const isStack = node.type === 'stack';
    const Q = state.islandQ;
    const stored = storedMap(node);
    const audition = isStack ? auditionMapOf(node) : null;
    const windowActive = !!activeMapOf(node);
    const window = audition ? audition.segs[0]
        : (stored.segs.length === 1 ? stored.segs[0] : [0, 0]);
    // The phase of the pass that sounds: 0 while a one-shot rests, and
    // for a stack that plays no map.
    const received = receivedAt(node, state.masterPos);
    const at = ownInnerAt(node, received.clock, received.scope);
    const pass = mapPeriod(effectiveMap(node, received.scope));
    const sounding = pass > 0 && !at.rest && (!isStack || windowActive);
    const capturing = !!node.isRecording && !node.isPendingStart;
    const committed = isStack ? 0 : takeLength(node);
    const out = {
        id: node.id,
        name: node.name || '',
        type: node.type,
        currentPeak: node.currentPeak || 0,
        duration: capturing && node._retake ? node._retake.captured : (node.duration || 0),
        loopStart: window[0],
        loopEnd: window[1],
        loopBypassed: audition ? false : !!node.loopBypassed,
        windowActive,
        periodSource: node.periodSource || 'own',
        ...(stored.segs.length >= 2 && !audition ? { segments: stored.segs.flat() } : {}),
        loopTop: audition ? window[0]
            : effectiveTop(stored, windowActive, intrinsicOfNode(node), node.storedTop ?? null),
        retime: node.retime || 0,
        effects: publishedEffects(node),
        effectiveQuantum: Q,
        playhead: sounding ? at.h / pass : 0,
        isRecording: capturing,
        isMuted: !!node.isMuted,
        midiArmed: !!node.midiArmed,
        isSoloed: !!node.isSoloed,
        pan: typeof node.pan === 'number' ? node.pan : 0,
        gain: typeof node.gain === 'number' ? node.gain : 1,
        origin: node.origin || 0,
        anchored: isStack ? !!node.anchored : true,
        qSamples: Q,
        originQ: fromSamples((node.origin || 0) - (state.islandZero || 0), Q),
        periodQ: fromSamples(committed, Q),
        windowStartQ: fromSamples(node.loopStart || 0, Q),
        windowEndQ: fromSamples(node.loopEnd || 0, Q),
    };
    if (isStack) {
        const isRoot = node === state.root;
        return Object.assign(out, {
            childCount: (node.nodes || []).length,
            quantum: isRoot ? Q : 0,
            zero: isRoot ? (state.islandZero || 0) : 0,
            windowDomain: node.windowDomain === 'sequence' ? 'sequence' : 'intrinsic',
            windowSuspended: windowSuspendedOf(node),
            ...(node.sequence ? { sequence: publishedSequence(node) } : {}),
            nodes: (node.nodes || []).map(publishNode),
        });
    }
    const instrument = out.effects.chain.some(s => s.isInstrument);
    return Object.assign(out, {
        sampleRate: getSampleRate(),
        inputChannel: node.inputChannel ?? 0,
        inputChannelR: node.inputChannelR ?? -1,
        monitor: !!node.monitor,
        channels: node.channels || 1,
        isPendingStart: !!node.isPendingStart,
        isAwaitingStop: !!node.isAwaitingStop,
        contextCycle: node.contextCycle || 0,
        isPlaying: isCommittedClip(node) && !node.isRecording,
        // A MIDI take — or an empty clip whose chain carries an instrument.
        contentKind: node.contentKind === 'midi' ||
            (instrument && !(committed > 0) && !node.isRecording) ? 'midi' : 'audio',
        midiEvents: node.midiEvents || 0,
        takes: takesOf(node).length,
        activeTake: node.activeTake || 0,
        comp: Array.isArray(node.comp) ? [...node.comp] : [],
        compCellLen: node.compCellLen || 0,
        compOffset: node.compOffset || 0,
    });
}

/** A synthesized master level, from the clock (deterministic under
 * advanceBy): silent when stopped or empty, after the master fader. */
function mockMasterVu(phase) {
    if (!state.isPlaying) return 0;
    if (!someNode(n => n.duration > 0 || n.isRecording)) return 0;
    const t = toSeconds(state.masterPos);
    const lv = 0.30 + 0.16 * Math.sin(t * 2.1 + phase) +
        0.10 * Math.sin(t * 5.3 + phase * 2) +
        0.05 * Math.sin(t * 11.7 + phase);
    return Math.max(0, Math.min(1, lv)) * state.root.gain;
}

/** The poll: the mock's audio callback runs (transport.js
 * advanceTransport), then the state is read. */
export function getState() {
    advanceTransport();
    return readState();
}

/** The published state — the root's node record with the island's facts
 * beside it — read without letting time pass. */
export function readState() {
    const definer = islandDefiner();
    const calibration = getCalibrationSamples();
    return {
        ...publishNode(state.root),
        focusedId: ROOT_ID,
        isPlaying: state.isPlaying,
        masterPos: viewMasterPos(),
        masterVuL: mockMasterVu(0),
        masterVuR: mockMasterVu(1.3),
        islandPos: state.masterPos - state.islandZero,
        islandZero: state.islandZero,
        definerId: definer ? definer.id : '',
        canUndo: canUndo(),
        canRedo: canRedo(),
        perf: {
            maxBlockUs: 0,
            avgLoadPct: 0,
            xruns: 0,
            latencyCompensationSamples: calibration >= 0 ? calibration : 0,
            calibrated: calibration >= 0,
            sampleRate: getSampleRate(),
        },
    };
}

/** Test hooks: poke the raw clock and the transport flag. */
export function setMasterPos(pos) {
    state.masterPos = pos;
}

export function setIsPlaying(playing) {
    state.isPlaying = playing;
}
