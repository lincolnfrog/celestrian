/**
 * What the lane builders share: the lane shapes (the typedefs), the
 * fields read straight off a published node, the take and arm facts, the
 * ↺ and timing fields, and the gates.
 *
 * A lane is assembled with Object.assign from LAYERS, and the ORDER is
 * load-bearing: a later layer overrides an earlier one.
 */

import { posMod, foldShift } from '../math_utils.js';
import { innerAt } from '../time_map.js';
import { EPS } from './tiling.js';
import { topOf } from './published.js';

/**
 * @typedef {Object} Rep  one tile of a lane, Q in the frame:
 *   startQ, endQ
 *   ghost       a repetition, not the take's own tile
 *   wrapped     clipped by a frame edge
 *   srcSegs     the slices of the raw take it draws: fractions of it, in
 *               heard order — [[0, 1]], the whole take, on a raw-framed
 *               lane. Absent only on a tile that IS its whole material
 *               at any width (the trim view's, comp mode's raw lane)
 *   srcTopFrac  where the content's top falls on the tile grid, as a
 *               fraction of the period: a heard lane's rotation, a raw
 *               tile's own start, a one-shot firing's top
 *   silent      a slot's resting tile while a new take of it records
 */

/**
 * @typedef {Object} ClipLane  kind 'clip'; Q unless it says otherwise.
 * LAYERS (pushHeardClipLane): laneCommon → the RAW-FRAMED fields → the
 * heard fields when the lane shows a map's content (its own:
 * heardViewFields; an enclosing group's: `underMap`), which OVERRIDE
 * periodQ, intrinsicQ, reps, takeStartQ, window and the band fields →
 * takeFields → topFields → the ● and parent-map fields.
 *   periodQ        what the lane tiles at; 0 on a live take
 *   intrinsicQ     the extent its chrome is measured over: the raw take;
 *                  on a heard lane, the map period
 *   contentQ       the raw take a rep's srcSegs index
 *   reps           Rep[]
 *   takeStartQ     the take tile's place in the frame: brackets, dims
 *                  and bands are measured from it. A ONE-SHOT's is
 *                  where its shot starts sounding
 *   shotEveryQ     (one-shots that fire) the cycle the shot fires on:
 *                  it sounds from takeStartQ + k·shotEveryQ for its
 *                  length (`periodQ`) and rests between — its tiles,
 *                  grips and seams repeat at that cadence, never at
 *                  the shot's own length
 *   window         mapOf's descriptor on a raw-framed lane (its
 *                  brackets); null on a heard lane
 *   windowChipQ    a heard lane's chip: the map period
 *   windowPhase    a raw-framed lane's own cursor: the FRACTION of its
 *                  window played (the published `playhead`)
 *   bandSegs       the kept set over [0, bandTotalQ); with `bandHeard`
 *                  its cuts are seam handles, not bands
 *   bandEditable, bandLocked   bandGate
 *   underMap       shown through an enclosing group's map: that group
 *                  owns the chrome
 *   parentMapSegs  an enclosing map the lane is NOT shown through: dims
 *                  over parentMapPeriodQ
 * Also armable / armMode (the ●), takeFields, topFields; from pushLane,
 * drifting / driftShown / canDefine / trimSel; from the post-passes,
 * seqDims / health. The recording lane, comp mode's raw lane and the
 * trim view's lane (lane_clip.js) fill this shape their own way.
 */

/**
 * @typedef {Object} GroupLane  kind 'group'; Q unless it says otherwise.
 * LAYERS (pushGroupLane): laneCommon → the group fields → EITHER the
 * heard fields (an authored window's content, tiled at its length) OR
 * the raw-framed fields (the inner cycle, a map drawn over it) →
 * topFields → `seq`. Period, tile, window, band and top fields as
 * ClipLane, plus:
 *   folded, groupArm ({ state, armable, mode })
 *   anchored      it has an origin (Q18): content lives beneath it
 *   mapRecording  a take is recording through its map
 *   mapSuspended  its map is off under a song (S16)
 *   mapSegs, mapBypassed, mapChipQ   a raw-framed lane's multi-segment
 *                 map: dims and one chip, never brackets
 *   seq           seqChipFacts, with `drift` from attachFrameHealth
 */

/**
 * @typedef {Object} LaneContext  one derive's constants, frozen; Q
 * unless it says samples.
 *   lanes           the rows being built, in render order — the one
 *                   thing a builder writes
 *   quantum         island Q, samples (1 = none yet); qEstablished
 *   cycleQ, lcmQ, playheadQ   resolveFrame — beneath a one-shot group,
 *                   its shot's frame (LaneScope.shot)
 *   seat, placerId  samples: the seated zero (null when nothing seats),
 *                   and the loop that placed it
 *   passZero        samples
 *   provisionalDefiner, soleQDefinerId, defSelStartQ, defSelEndQ,
 *   definerIds, trimCompany   resolveProvisionalDefiner
 *   definerIdle     Q exists and nothing is live
 *   mapEditsLocked  THE RECORDING GATE (bandGate)
 *   maxDepth, fxOpen, seqOpen, folded, compMode, retakes   view state
 *                   (deriveViewModel's opts); a Set may be null
 */

/**
 * @typedef {Object} LaneScope  what a lane inherits from the groups
 * above it. A group hands its children a new one; none is mutated.
 *   zero       samples: the zero this subtree is drawn from — the
 *              frame's, the pass zero (laneZeroOf), or, beneath a
 *              one-shot group, the top of its shot
 *   cycleQ     the cycle this scope's lanes hear (scopeCycleQOf): a
 *              one-shot fires once per pass of it
 *   shot       { lenQ } when the subtree is drawn in the SHOT frame of
 *              a one-shot group above (pushGroupChildren), else null:
 *              the builders' frame (ctx.cycleQ) is then that shot, and
 *              the group fires what they build
 *   underWarp  a group above remaps time (canDefineNode)
 *   map        MapScope: the nearest enclosing ACTIVE map, or null
 */

/**
 * @typedef {Object} MapScope  an enclosing group's active map, as its
 * members read it.
 *   periodQ, startQ  its length and its first start
 *   segs, originQ    Q: inner positions from the mapping group's origin,
 *                    and that origin in the lane frame
 *   segsS, originS   the same two in SAMPLES, for the member slice walk
 *   groupCycleQ      the domain the map selects over: the group's song
 *                    when sequenced (S9), else its inner cycle
 */

/**
 * The verb a clip's ● offers (Q7, docs/takes.md §2); the rail and the
 * app's record handler read this one rule:
 *   'stop'    a live take (recording or pending): ● stops / cancels it
 *   'record'  an empty clip: ● records its first take
 *   'retake'  a committed clip: ● arms a NEW TAKE of the slot
 *   null      a committed one-shot: its slot top is never heard through
 *             the context cycle, so the engine refuses
 */
export function armMode(clip) {
    if (clip.isRecording || clip.isPendingStart) return 'stop';
    if (!(clip.duration > 0)) return 'record';
    if (clip.periodSource === 'context') return null;
    return 'retake';
}

/** Whether ● does anything on this clip. */
export function isArmable(clip) {
    return armMode(clip) !== null;
}

/** Does the node's published chain carry an instrument slot
 * (docs/vst3.md §8)? The rail's MIDI-arm affordance and the app's live
 * MIDI target read this one rule. */
export function hasInstrument(node) {
    return !!(node && node.effects && Array.isArray(node.effects.chain) &&
        node.effects.chain.some(s => s.isInstrument));
}

/**
 * A group's aggregate ● (Q7): { state: 'all'|'some'|'none', armable,
 * mode: 'record'|'retake'|'none' }. Arm targets emptiness first: while
 * any EMPTY or live clip sits beneath, ● records the empties and the
 * aggregate spans those. With every track full it is a NEW TAKE of the
 * group's committed DIRECT clips, one performance (docs/takes.md §2).
 * `armable` 0 = nothing to do.
 */
export function groupArmState(node) {
    let armed = 0, armable = 0;
    const visit = n => (n.nodes || []).forEach(c => {
        if (c.type === 'clip') {
            const m = armMode(c);
            if (m === 'stop') { armed++; armable++; }
            else if (m === 'record') armable++;
        } else if (c.type === 'stack') visit(c);
    });
    visit(node);
    if (armable > 0) {
        const state = armed === 0 ? 'none' : armed === armable ? 'all' : 'some';
        return { state, armable, mode: 'record' };
    }
    const retakes = (node.nodes || [])
        .filter(c => c.type === 'clip' && armMode(c) === 'retake').length;
    return { state: 'none', armable: retakes,
             mode: retakes > 0 ? 'retake' : 'none' };
}

/**
 * The take facts of a clip lane (docs/takes.md §5): the list size, the
 * active index, the comp (one take index per cell; −1 = the active take,
 * [] = no comp) and whether the lane is in comp mode (view state). A
 * state without the keys reads as one take, no comp.
 *
 * THE COMP'S TWO GRIDS (comp_model.js). `compCells` is the EDITOR's: one
 * cell per Q of the take, what a click authors. `compCellQ` /
 * `compOffsetQ` are the grid the comp SOUNDS on, as the engine publishes
 * it (`compCellLen`, `compOffset`, samples): cell k covers
 * [compOffsetQ + k·compCellQ, + compCellQ) of the take. With no comp, or
 * in a state that publishes neither, that is the editor's grid: 1 and 0.
 */
export function takeFields(node, quantum, ctx) {
    const duration = node.duration || 0;
    const takes = typeof node.takes === 'number'
        ? node.takes : (duration > 0 ? 1 : 0);
    const comp = Array.isArray(node.comp) ? node.comp.slice() : [];
    const stored = comp.length > 0 && quantum > 0 && node.compCellLen > 0;
    return {
        takes,
        activeTake: node.activeTake || 0,
        comp,
        compCells: quantum > 0 && duration > 0
            ? Math.ceil(duration / quantum - EPS) : 0,
        compCellQ: stored ? node.compCellLen / quantum : 1,
        compOffsetQ: stored ? (node.compOffset || 0) / quantum : 0,
        compMode: !!(ctx.compMode && ctx.compMode.has(node.id)),
    };
}

/** The fields every clip and group lane reads straight off its published
 * node: each lane's first layer. */
export function laneCommon(node) {
    return {
        id: node.id,
        name: node.name || node.id,
        muted: !!node.isMuted,
        soloed: !!node.isSoloed,           // additive, per node (Q16)
        recording: !!node.isRecording,
        awaitingStop: !!node.isAwaitingStop,  // stop requested; pads to the boundary
        armed: !!(node.isPendingStart || node.isRecording),
        effects: node.effects || null,     // the published chain ({chain, scope?})
        fxCount: node.effects && Array.isArray(node.effects.chain)
            ? node.effects.chain.filter(s => s.enabled).length
            : 0,
        hasInstrument: hasInstrument(node),
        midiArmed: !!node.midiArmed,       // THE live MIDI target
        // A MIDI track records notes into its instrument: a note take,
        // or an empty clip whose chain carries an instrument.
        isMidi: node.contentKind === 'midi',
        pan: typeof node.pan === 'number' ? node.pan : 0,     // −1..+1
        gain: typeof node.gain === 'number' ? node.gain : 1,  // 0..1; absent = unity
        oneShot: node.periodSource === 'context',             // Q5
        // A clip's recording input (−1 = the device default). A group
        // has none: its children record from theirs (Q7).
        ...(node.type === 'stack' ? null
            : { inputChannel: node.inputChannel ?? -1 }),
        inputChannelR: node.inputChannelR ?? -1,  // right input of a pair; −1 = mono
        channels: node.channels ?? 1,
        monitor: !!node.monitor,           // software input monitoring (Q20)
    };
}

/** The effects PANEL row of a node whose chain is expanded (opts.fxOpen):
 * a synthetic row; the panel renders from the owner's published chain. */
export function fxRow(node, depth) {
    return {
        kind: 'fx',
        id: 'fx:' + node.id,
        ownerId: node.id,
        name: '',
        depth,
        effects: node.effects || null,
    };
}

/** Push the fx row under the lane of `node` (at `depth`), when open. */
export function pushFxRow(node, depth, ctx) {
    if (ctx.fxOpen && ctx.fxOpen.has(node.id)) {
        ctx.lanes.push(fxRow(node, depth + 1));
    }
}

/** The "+ add track" row at the bottom of an open group. */
export function addRow(group, depth) {
    return { kind: 'add', id: 'add:' + group.id, groupId: group.id,
             name: '', depth };
}

/**
 * THE RECORDING GATE (time_maps.md §7): while any take records or waits
 * to start (ctx.mapEditsLocked) no loop region is editable anywhere —
 * the engine refuses every map edit under a live take, so a grip that
 * grabbed would preview geometry that never lands. `bandEditable` is the
 * one editability fact every map surface reads; `bandLocked` marks a
 * lane whose chrome WOULD be live, so it draws inert instead of
 * vanishing mid-take.
 *
 * @param {boolean} editable  the lane's own editability (Q, extent, …)
 * @param {boolean} locked    ctx.mapEditsLocked
 */
export function bandGate(editable, locked) {
    return { bandEditable: !!editable && !locked,
             bandLocked: !!editable && !!locked };
}

/** Fold is view state (I6b): the app shell's folded set, never a node
 * field. */
export function isFolded(node, ctx) {
    return !!(ctx.folded && ctx.folded.has(node.id));
}

/**
 * THE TOP AND THE TIMING of a clip or group lane (loop_selection.md §9):
 * what the ↺ handle, the panel's start marker and the timing readout
 * read.
 *
 *   topQ           the ↺ AS SHOWN, raw Q of the take. The loop that
 *                  places the frame shows its own top (topOf): it
 *                  defines the song's top. Every OTHER loop shows the
 *                  sample it plays at that top (the render equation at
 *                  the seat) — where it starts when you press play; a
 *                  drag re-times it so the chosen hit lands there.
 *   storedTopQ     the published top itself, whatever the ↺ shows: what
 *                  a region edit reconciles FROM, and what a cancelled
 *                  start-marker drag puts back.
 *   topHeardQ      the ↺'s first heard position from the lane's zero,
 *                  in [0, period).
 *   retimeQ        the user shift AS HEARD: `retime` folded to the
 *                  loop's own period (foldShift). 0 = as played.
 *   retimePeriodQ  that period: the kept set's length.
 *   canRetime      the caller's verdict: a ↺ drag is offered here.
 *   retimeLocked   it would be, but for the recording gate: the ↺ still
 *                  draws, inert.
 *
 * @param {boolean} authored  mapAuthored(node, mapOf(node))
 */
export function topFields(node, authored, ctx, scope, canRetime,
                          retimeLocked = false) {
    const { quantum } = ctx;
    const t = topOf(node, authored, quantum);
    let top = t.top;
    let moment = (node.origin || 0) + t.a0 + t.heard;
    if (t.periodS > 0 && Number.isFinite(ctx.seat) && ctx.placerId != null &&
        node.id !== ctx.placerId) {
        top = innerAt(ctx.seat, node.origin || 0, t.kept, t.periodS).inner;
        moment = ctx.seat;
    }
    return {
        topQ: top / quantum,
        storedTopQ: t.top / quantum,
        topHeardQ: t.periodS > 0
            ? posMod(moment - scope.zero, t.periodS) / quantum
            : 0,
        retimeQ: Number.isFinite(node.retime)
            ? foldShift(node.retime, t.periodS) / quantum : 0,
        retimePeriodQ: t.periodS / quantum,
        canRetime: !!canRetime,
        retimeLocked: !canRetime && !!retimeLocked,
    };
}

/**
 * May the ↺ re-time this clip lane? A committed loop — not recording or
 * armed, not a one-shot (its offset IS its placement, Q5) — with Q
 * established; not the definer or a mic of the definer stack (its origin
 * is the island zero: the engine refuses); not shown through an
 * enclosing map (that group owns the chrome); not in comp mode (it edits
 * takes, not time); and not under the recording gate.
 */
export function retimeable(node, ctx, underMap) {
    return !ctx.mapEditsLocked && !node.isPendingStart &&
        retimeableOnceIdle(node, ctx, underMap);
}

/** retimeable with the recording gate aside (an armed slot's own pending
 * take is the gate too). What the gate alone holds keeps its ↺, drawn
 * inert (`retimeLocked`): `bandLocked` cannot stand in for it, since map
 * chrome needs a ≥ 2Q take and a 1Q loop's ↺ would vanish. */
export function retimeableOnceIdle(node, ctx, underMap) {
    return !!(ctx.qEstablished && !underMap && !node.isRecording &&
        node.duration > 0 && node.periodSource !== 'context' &&
        !(ctx.compMode && ctx.compMode.has(node.id)) &&
        !ctx.definerIds.has(node.id));
}

/**
 * WHERE "BOUNCE SELECTED…" STARTS (docs/bounce.md): a loop's file opens
 * on its ↺ AS SHOWN (topFields) — on every loop but the placer that is
 * the frame's top, so a stem opens on the very sample the song bounce
 * does. The engine's default start is the node's STORED top, which on a
 * loop that slots in is a moment nothing on screen marks; so the app
 * names the start. The ↺ sits `topHeardQ` from the zero DRAWN: their sum
 * is its moment (give or take whole periods — the same file) under a
 * drag's pin or a re-seat tween too.
 *
 * @param {Object} vm  the view model on screen
 * @returns {?number} absolute samples; null where the lane wears no ↺ (a
 *     one-shot, the definer, a lane under a parent's map, a live take):
 *     the engine's default stands
 */
export function bounceStartOf(vm, laneId) {
    if (!vm || !vm.qEstablished || !Number.isFinite(vm.frameZero)) return null;
    const lane = (vm.lanes || []).find(l => l.id === laneId);
    if (!lane || !(lane.canRetime || lane.retimeLocked) ||
        !Number.isFinite(lane.topHeardQ)) return null;
    return Math.round(vm.frameZero + lane.topHeardQ * vm.quantum);
}
