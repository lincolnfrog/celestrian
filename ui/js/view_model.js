/**
 * View Model (docs/session_view.md §4): deriveViewModel(state) turns the
 * published graph state into the pure view model the session view
 * patches into the DOM.
 *
 * THE FRAME RULE: everything in the result is in Q (floats) in the
 * island frame, unless a field says samples. There are no pixels in this
 * layer — the one Q→px scale lives in the patch layer — so simultaneity
 * ⇔ same x (I2) holds by construction, and the model carries exactly one
 * playhead (I8).
 *
 * The work is in vm/: published.js (reading one node), tiling.js,
 * definer.js, frame.js, sequence_rows.js, the lanes (lane_common.js,
 * lane_clip.js, lanes.js) and pending_edits.js. This file orchestrates
 * them and is the public surface: importers take their names from here.
 */

import { publishedSequence } from './sequence_program.js';
import { resolveQuantum, collectTreeFacts } from './vm/published.js';
import { applyPendingEdits } from './vm/pending_edits.js';
import { resolveProvisionalDefiner } from './vm/definer.js';
import { resolveFrame, rootSongTop } from './vm/frame.js';
import { buildSeqRow, rootSeqChip, attachSeqDims, attachFrameHealth }
    from './vm/sequence_rows.js';
import { fxRow } from './vm/lane_common.js';
import { pushLane } from './vm/lanes.js';

export { findNodeInTree, committedClip, subtreeHasCommitted }
    from './vm/published.js';
export { armMode, hasInstrument, bounceStartOf } from './vm/lane_common.js';
export { buildRulerTicks } from './vm/frame.js';
export { seqRowFacts, seqHealthAt } from './vm/sequence_rows.js';
export { windowDragTarget } from './map_edit.js';
// No production module imports these; the tests do (oneTakeDuration:
// nothing does).
export { applyPendingEdits };
export { oneTakeDuration } from './vm/published.js';
export { unrollReps } from './vm/tiling.js';
export { isArmable } from './vm/lane_common.js';
export { SEAT_PICKUP_Q, reseatZero, reseatLanding, easeInOut }
    from './vm/frame.js';

/**
 * deriveViewModel(state[, opts]) → the view model.
 *
 * @param {Object} state  getGraphState() as the engine and the mock
 *     publish it — samples, origins absolute, a stack's children on
 *     `nodes`: { id (the root's), nodes, quantum (the stored island Q;
 *     0 = none yet), islandZero, islandPos (the unwrapped clock from
 *     islandZero), masterPos, isPlaying, definerId, sequence with
 *     windowActive / loopStart / loopEnd (the root's song and its
 *     step-audition window), anchored / origin (the root's song top),
 *     gain, effects, perf }
 * @param {Object} [opts]  view state and gesture state:
 *   maxDepth      depth guard (default 8)
 *   folded        Set of stack ids whose children are hidden (I6b)
 *   fxOpen, seqOpen   Sets of ids (lanes', and the root's) whose effects
 *                 row / sequencer grid is open
 *   compMode      Set of clip ids in comp mode (docs/takes.md)
 *   retakes       Set of clip ids whose live take is a NEW TAKE of a
 *                 committed slot, for a state that publishes no
 *                 `periodQ`. The published slot period says the same
 *                 (vm/published.js isRetaking), so the app, whose
 *                 backends both publish it, passes none
 *   pinFrameQ, pinFoldQ, pinZero   a map gesture's frame pin, and
 *   reseat        { fromRel, t }, the re-seat tween (vm/frame.js)
 *   pendingEdits  Map of lane id → { segments?, originShift?, top? }: a
 *                 gesture's preview (vm/pending_edits.js)
 * @returns {Object}  the result literal below names each field; `lanes`
 *     are the rows in render order — ClipLane and GroupLane
 *     (vm/lane_common.js), 'seq' rows (buildSeqRow), 'fx' rows (fxRow)
 *     and 'add' rows (addRow)
 */
export function deriveViewModel(state, opts = {}) {
    // A gesture's PREVIEW lands first: everything below derives from it.
    if (opts.pendingEdits) state = applyPendingEdits(state, opts.pendingEdits);
    const nodes = state.nodes || [];
    const quantum = resolveQuantum(state, nodes);
    const facts = collectTreeFacts(nodes);
    const definer = resolveProvisionalDefiner(
        facts.committedClips, facts.anyTakeActive, quantum, nodes, state.definerId);
    const frame = resolveFrame(state, nodes, opts, { quantum, facts, definer });
    const { qEstablished, frameZero } = frame;

    const lanes = [];
    /** @type {LaneContext} (vm/lane_common.js) */
    const ctx = Object.freeze({
        lanes,
        quantum,
        qEstablished,
        cycleQ: frame.cycleQ,
        lcmQ: frame.lcmQ,
        playheadQ: frame.playheadQ,
        seat: frame.seated,
        placerId: frame.placerId,
        passZero: frame.passZero,
        provisionalDefiner: definer.provisionalDefiner,
        soleQDefinerId: definer.soleQDefinerId,
        defSelStartQ: definer.defSelStartQ,
        defSelEndQ: definer.defSelEndQ,
        definerIds: definer.definerIds,
        trimCompany: definer.trimCompany,
        definerIdle: qEstablished && !facts.anyTakeActive,
        mapEditsLocked: facts.anyTakeActive,
        maxDepth: opts.maxDepth ?? 8,
        fxOpen: opts.fxOpen || null,
        seqOpen: opts.seqOpen || null,
        folded: opts.folded || null,
        compMode: opts.compMode || null,
        retakes: opts.retakes || null,
    });
    /** @type {LaneScope} what the top-level lanes inherit */
    const top = { zero: frameZero, cycleQ: frame.scopeCycleQ, shot: null,
                  underWarp: false, map: null };
    nodes.forEach(n => pushLane(n, 0, ctx, top));

    // THE ROOT'S SONG projects onto the top-level lanes with its top at
    // (origin − zero) (frame.md §4): 0 whenever the root seats first,
    // which is every state a backend produces; a fixture or a drag pin
    // can put the two apart. Exact, not rounded: under a re-seat tween
    // the zero passes between grid lines, and the dims ride it with the
    // lanes.
    const rootId = state.id || '';
    const rootAnchorQ = qEstablished
        ? (rootSongTop(state) - frameZero) / quantum : 0;
    const song = publishedSequence(state);
    if (song && !song.bypassed) {
        attachSeqDims(lanes, 0, lanes.length, nodes, song, quantum, rootAnchorQ);
    }
    // The root has no rail: its grid is the FIRST row, over the
    // top-level tracks, and the master rack's fx row sits above that
    // (the master shapes everything below it).
    if (ctx.seqOpen && rootId && ctx.seqOpen.has(rootId) && nodes.length > 0) {
        lanes.unshift(buildSeqRow({
            holder: state,
            ownerId: rootId,
            children: nodes,
            depth: 0,
            quantum,
            qEstablished,
            innerCycleQ: frame.intrinsicCycleQ,
            editable: !facts.anyRecording,
            anchorQ: rootAnchorQ,
        }));
    }
    if (ctx.fxOpen && rootId && ctx.fxOpen.has(rootId)) {
        lanes.unshift(fxRow(state, 0));
    }
    attachFrameHealth(lanes, state, nodes, quantum, qEstablished);

    const perf = state.perf || {};
    return {
        quantum,                            // island Q, samples (1 = none yet)
        // The frame — vm/frame.js resolveFrame says what each is.
        frameZero,                          // samples: the zero drawn
        seatedZero: frame.seated,           // samples; null with nothing to seat
        frameZeroSource: frame.zeroSource,  // 'pin' | 'tween' | 'seat' | 'root'
        frameTweening: frame.tweening,
        restZero: frame.restZero,           // samples
        rootFrame: frame.rootFrame,         // samples
        cycleQ: frame.cycleQ,
        lcmQ: frame.lcmQ,
        loopCycleQ: frame.loopCycleQ,
        loopStartQ: frame.loopStartQ,
        // The audible loop's RUNS in frame Q when it is not the one span
        // [loopStartQ, loopStartQ + loopCycleQ): the trim view of a
        // definer whose selection has cuts — a heard position walks
        // these, never the cuts between them. Null for one span.
        loopRunsQ: definer.provisionalDefiner && definer.defSelRuns.length > 1
            ? definer.defSelRuns.map(([s, e]) => [s / quantum, e / quantum])
            : null,
        frameExtended: frame.frameExtended,
        playheadQ: frame.playheadQ,
        isPlaying: !!state.isPlaying,
        qEstablished,
        // The definer (Q13, vm/definer.js): who it is, whether its trim
        // view is on, and whether that view shares the screen (Q22).
        soleQDefinerId: definer.soleQDefinerId,
        provisionalDefiner: definer.provisionalDefiner,
        trimCompany: definer.trimCompany,
        passZero: frame.passZero,           // samples
        // THE RECORDING GATE (bandGate): a take is recording or pending,
        // so every loop region is display-only.
        mapEditsLocked: facts.anyTakeActive,
        sampleRate: perf.sampleRate || 44100,
        // Software input monitoring (Q20): the calibrated round trip in
        // ms at the device rate; null until one has been measured.
        monitorLatencyMs: perf.calibrated
            ? (perf.latencyCompensationSamples / (perf.sampleRate || 44100)) * 1000
            : null,
        armAtQ: frame.armAtQ,               // the next Q boundary (Q11)
        ruler: frame.ruler,                 // { cycleQ, ticks } (buildRulerTicks)
        lanes,
        // The root: the target of setSequence / toggleSequence, the
        // master fader (0..1; absent = unity) and its rack's enabled
        // count, the song's chip facts (rootSeqChip) and its audition
        // brackets — the root has no lane to carry them.
        rootId,
        rootGain: typeof state.gain === 'number' ? state.gain : 1,
        rootFxCount: state.effects && Array.isArray(state.effects.chain)
            ? state.effects.chain.filter(s => s.enabled).length : 0,
        rootSeq: rootSeqChip(state, nodes, quantum),
        rootWindow: frame.rootWindow,
    };
}
