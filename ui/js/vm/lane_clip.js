/**
 * The clip lanes (ClipLane, lane_common.js): the resting lane — raw
 * framed, heard, or shown through an enclosing map — the recording lane,
 * comp mode's raw lane, and the trim view's lane. Each pushes its row
 * (and its fx row) onto ctx.lanes.
 */

import { posMod } from '../math_utils.js';
import { nodeWindowActive, publishedMap, singleSegment } from '../time_map.js';
import { EPS, MAX_TILES, unrollReps, heardReps, shotOf, fireReps, shotTile,
         takeTileStart, childSrcSegsUnderMap } from './tiling.js';
import { intrinsicPeriodQ, mapOf, mapAuthored, topOf, retakeSlot, isRetaking }
    from './published.js';
import { laneCommon, takeFields, armMode, isArmable, groupArmState, isFolded,
         bandGate, topFields, retimeable, retimeableOnceIdle, pushFxRow }
    from './lane_common.js';

/**
 * THE HEARD VIEW's fields, for clips and groups alike (the law is
 * displayPeriodQ's): an AUTHORED map's CONTENT is the lane's material,
 * tiled at the map period on the frame grid (tiling.heardReps), so the
 * whole lane is audible truth. No brackets — the whole tile IS the
 * window: its chrome is the chip, the edge grips (live trims) and the
 * seam handles (a cut has zero width in heard time).
 *
 * A ONE-SHOT's map is its SHOT (`shot`, tiling.shotOf): the content is
 * drawn once per firing from the shot's top, never rotated, and the
 * lane rests between — `takeStartQ` is that top, where the grips and
 * seams are measured from.
 *
 * @param {Object} o  `win` mapOf's descriptor; `lanePeriodQ` the part's
 *     length; `intrinsicQ` the raw extent win.segs index; `heardTopQ`
 *     where the loop's heard top sits within its own period,
 *     (origin + a0) mod period (time_map.innerAt); `editable` the lane's
 *     own editability, `locked` the recording gate (bandGate); `shot` a
 *     one-shot's firing, or null for a loop
 */
export function heardViewFields({ win, lanePeriodQ, intrinsicQ, heardTopQ, cycleQ,
                                  qEstablished, editable, locked, shot = null }) {
    const srcSegs = win.segs.map(([s, e]) => [s / intrinsicQ, e / intrinsicQ]);
    return Object.assign({
        periodQ: lanePeriodQ,
        intrinsicQ: lanePeriodQ,  // the lane's extent is the window's length
        reps: !qEstablished ? []
            : shot ? fireReps([shotTile(shot, srcSegs)], shot, cycleQ, lanePeriodQ)
            : heardReps(lanePeriodQ, cycleQ, srcSegs, heardTopQ),
        takeStartQ: shot ? shot.startQ : heardTopQ,
        window: null,
        windowChipQ: lanePeriodQ,
        mapMulti: !!win.multi,
        bandSegs: win.segs,
        bandTotalQ: intrinsicQ,
        bandHeard: true,
        bandPeriodQ: win.periodQ,
        windowPhase: 0,
    }, shot ? { shotEveryQ: shot.everyQ } : null, bandGate(editable, locked));
}

/**
 * The cycle position a RAW-FRAMED clip's take tile marks (Q14;
 * unrollReps `takeQ`): the tile at the take's HEARD PHASE — its position
 * mod the cycle it was performed against (`contextCycle`) — on this
 * lane's tile grid. The phase survives frame growth and zero re-bases,
 * which move by whole multiples of every earlier take's heard cycle. A
 * state without `contextCycle` folds a take at or after the lane's zero
 * by the committed cycle. Undefined = the first full tile.
 */
function takePhaseQ(node, offsetQ, periodQ, ctx) {
    const { quantum, cycleQ, lcmQ } = ctx;
    const ctxQ = (node.contextCycle || 0) / quantum;
    if (!(ctxQ > 0 && periodQ > 0)) {
        return offsetQ >= 0 && lcmQ > 0 ? posMod(offsetQ, lcmQ) : undefined;
    }
    // Bounded like unrollReps, which yields no tiles in that regime
    // anyway.
    if (cycleQ / periodQ > MAX_TILES) return undefined;
    const phase = posMod(offsetQ, ctxQ);
    for (let p = posMod(offsetQ, periodQ); p < cycleQ; p += periodQ) {
        const d = posMod(p - phase, ctxQ);
        if (d < EPS || ctxQ - d < EPS) return p;
    }
    return undefined;
}

/**
 * A committed clip's RESTING lane. `offsetQ`: the take's origin from the
 * lane's zero; `periodQ`: displayPeriodQ(node); `intrinsicQ`: the raw
 * take; `win`: mapOf(node).
 *
 * A LOOP tiles the frame. A ONE-SHOT fires (tiling.shotOf / fireReps):
 * its shot — its window's content, else its whole take — is drawn from
 * where it starts sounding, once per scope cycle, with nothing between.
 */
export function pushHeardClipLane(node, depth, offsetQ, periodQ, intrinsicQ,
                                  win, ctx, scope) {
    const { quantum, qEstablished, cycleQ } = ctx;
    const heard = !!(win && win.active);
    const lanePeriodQ = heard ? win.periodQ : periodQ;
    // A map's content starts sounding at origin + a0 (time_map.innerAt).
    const laneOffsetQ = heard ? offsetQ + win.segs[0][0] : offsetQ;
    const rawEditable = qEstablished && intrinsicQ >= 2;
    const shot = qEstablished && node.periodSource === 'context'
        ? shotOf({ map: heard ? publishedMap(node) : { segs: [] },
                   own: node.duration || 0, isStack: false,
                   origin: (node.origin || 0) - scope.zero,
                   scopeQ: scope.cycleQ || 0, quantum, cycleQ })
        : null;
    let heardFields = heard
        ? heardViewFields({
            win, lanePeriodQ, intrinsicQ,
            heardTopQ: lanePeriodQ > 0 ? posMod(laneOffsetQ, lanePeriodQ) : 0,
            cycleQ, qEstablished, editable: rawEditable,
            locked: ctx.mapEditsLocked, shot })
        : null;
    // UNDER AN ENCLOSING ACTIVE MAP the lane shows the slice that map
    // selects of it (childSrcSegsUnderMap), tiled in the group's frame
    // with the group's rotation — (origin + a0) mod the map period — so
    // the members line up under the group's tiles. The group owns the
    // chrome; a member's own window keeps only its chip. A one-shot
    // keeps its own firing display.
    const map = scope.map;
    let underMap = false;
    if (map && qEstablished && node.periodSource !== 'context' && lanePeriodQ > 0) {
        const take = node.duration || 0;
        // The member's origin is taken in the MAP's frame — from the
        // mapping group's origin, not from the zero.
        const src = childSrcSegsUnderMap(map.segsS,
            (node.origin || 0) - scope.zero - (map.originS || 0),
            heard ? publishedMap(node) : singleSegment(0, take), take);
        if (src) {
            const mapPeriodQ = map.periodQ;
            const groupTopQ = posMod((map.originQ || 0) + (map.startQ || 0),
                                     mapPeriodQ);
            heardFields = {
                periodQ: mapPeriodQ, intrinsicQ: mapPeriodQ,
                reps: heardReps(mapPeriodQ, cycleQ, src, groupTopQ),
                takeStartQ: groupTopQ, window: null,
                windowChipQ: heard ? win.periodQ : 0, mapMulti: false,
                bandSegs: null, bandTotalQ: mapPeriodQ, bandHeard: false,
                bandPeriodQ: 0, bandEditable: false, bandLocked: false,
                windowPhase: 0,
                underMap: true,
            };
            underMap = true;
        }
    }
    // RAW-FRAMED: a one-shot's whole take at its firing; a loop's tiles
    // from its origin.
    const reps = heardFields ? heardFields.reps
        : !qEstablished ? []
        : shot ? fireReps([shotTile(shot, [[0, 1]])], shot, cycleQ, lanePeriodQ)
        : unrollReps({ periodQ, offsetQ, cycleQ,
                       takeQ: takePhaseQ(node, offsetQ, periodQ, ctx) });
    ctx.lanes.push(Object.assign(laneCommon(node), {
        kind: 'clip',
        depth,
        periodQ: lanePeriodQ,
        intrinsicQ,
        contentQ: intrinsicQ,
        reps,
        takeStartQ: shot ? shot.startQ : takeTileStart(reps),
        window: win,
        windowChipQ: 0,
        mapMulti: !!(win && win.multi),
        bandSegs: win ? win.segs : null,
        bandTotalQ: intrinsicQ,
        bandHeard: false,
        bandPeriodQ: 0,
        ...bandGate(rawEditable, ctx.mapEditsLocked),
        windowPhase: nodeWindowActive(node) ? (node.playhead || 0) : 0,
    // The heard fields OVERRIDE the raw-framed ones above.
    }, shot ? { shotEveryQ: shot.everyQ } : null,
    heardFields || {}, takeFields(node, quantum, ctx),
    topFields(node, heard, ctx, scope, retimeable(node, ctx, underMap),
              ctx.mapEditsLocked && retimeableOnceIdle(node, ctx, underMap)), {
        // Never `isQDefiner`: the definer comes here only while a take
        // is live or its window is bypassed, and is then an ordinary
        // lane (the engine refuses to move Q under a live take).
        armable: isArmable(node),
        armMode: armMode(node),
        // An enclosing map this lane is NOT shown through: its excluded
        // regions project onto the lane as dims.
        parentMapSegs: map && !underMap ? map.segs : null,
        parentMapPeriodQ: map && !underMap ? map.groupCycleQ : 0,
    }));
    pushFxRow(node, depth, ctx);
}

/**
 * A RECORDING clip's lane. The bar is [playhead − length, playhead]: the
 * playhead IS the take's end, and `duration` grows live. No length yet =
 * pending start (armed, waiting for its boundary).
 *
 * A NEW TAKE of a committed slot (docs/takes.md §2; published.isRetaking)
 * is drawn as the slot it will be (retakeSlot): tiles cut at the
 * live `duration` would be re-cut on every poll. The slot's resting
 * tiles stay, flagged `silent` (the engine plays silence for the slot
 * while the take is live); capture starts at t ≡ origin (mod period) and
 * runs one period, so the bar's length is the distance from the slot's
 * top, and `armAtQ` marks the top a pending take waits for.
 *
 * Under an enclosing map the take records THROUGH it (`throughMap`): the
 * engine commits at most one map period (`mapPeriodQ` from `mapStartQ`).
 *
 * LAYERS: laneCommon → the recording fields → takeFields (a new take
 * only) → topFields (a live take is never re-timed).
 */
export function pushRecordingLane(node, depth, offsetQ, ctx, scope) {
    const { quantum } = ctx;
    const retaking = isRetaking(node, ctx.retakes, quantum);
    const slot = retaking ? retakeSlot(node, quantum) : node;
    const retake = retaking && (slot.duration || 0) > 0;
    let reps = [];
    let recordingLengthQ = (node.duration || 0) / quantum;
    let pendingStart = !(node.duration > 0);
    let armAtQ = 0;
    if (retake) {
        const periodQ = intrinsicPeriodQ(slot, quantum);
        reps = ctx.qEstablished && periodQ > 0
            ? unrollReps({ periodQ, offsetQ, cycleQ: ctx.cycleQ })
                .map(r => Object.assign({}, r, { silent: true }))
            : [];
        pendingStart = !!node.isPendingStart;
        const sinceTopQ = periodQ > 0
            ? posMod(ctx.playheadQ - offsetQ, periodQ) : 0;
        recordingLengthQ = pendingStart ? 0 : sinceTopQ;
        armAtQ = periodQ > 0 ? ctx.playheadQ + (periodQ - sinceTopQ) : 0;
    }
    const map = scope.map;
    ctx.lanes.push(Object.assign(laneCommon(node), {
        kind: 'clip',
        depth,
        periodQ: 0,
        intrinsicQ: retake ? intrinsicPeriodQ(slot, quantum) : 0,
        takeStartQ: takeTileStart(reps),
        reps,
        window: null,
        armable: true,
        armMode: 'stop',
        recordingLengthQ,
        pendingStart,
        retake,
        armAtQ,
        throughMap: !!map,
        mapPeriodQ: map ? map.periodQ : 0,
        mapStartQ: map ? map.startQ : 0,
    }, retake ? takeFields(slot, quantum, ctx) : null,
    topFields(slot, mapAuthored(slot, mapOf(slot, quantum)), ctx, scope, false)));
    pushFxRow(node, depth, ctx);
}

/**
 * THE RAW LANE — comp mode on a windowed clip (docs/takes.md §6). The
 * comp's cells live on the slot's period, which the heard view folds
 * away, so the lane opens to its FULL raw take (`intrinsicQ`) on its OWN
 * horizontal scale (`frameQ`): brackets select over the whole extent,
 * inner cuts are bands, and the lane's own cursor carries heard time
 * (`windowPhase`). The rest of the timeline, and the one white cursor,
 * stay in the audible frame. No ↺ drag: this lane edits takes.
 *
 * LAYERS: laneCommon → the raw fields → takeFields → topFields.
 */
export function windowEditLane(node, depth, win, intrinsicQ, ctx, scope) {
    return Object.assign(laneCommon(node), {
        kind: 'clip',
        depth,
        periodQ: intrinsicQ,
        intrinsicQ,
        frameQ: intrinsicQ,
        reps: [{ startQ: 0, endQ: intrinsicQ, ghost: false }],
        takeStartQ: 0,
        window: win,
        windowPhase: nodeWindowActive(node) ? (node.playhead || 0) : 0,
        windowEditing: true,
        bandSegs: win.segs,
        bandTotalQ: intrinsicQ,
        ...bandGate(intrinsicQ >= 2, ctx.mapEditsLocked),
        armable: false,
        armMode: null,
    }, takeFields(node, ctx.quantum, ctx),
    topFields(node, !!win.active, ctx, scope, false));
}

/**
 * THE TRIM VIEW's lane (Q13): the provisional definer — a sole clip, or
 * the definer stack — and, with `member`, each mic of that stack. The
 * WHOLE take as one tile from 0, in the BUFFER frame (the trim view
 * ignores the zero, which a re-trim moves under it): a raw position IS a
 * lane position, so the ↺ shown is the stored top. The definer's lane
 * wears the loop as a SELECTION (`window`) over that still waveform; it
 * has no lane cursor, the one playhead being mapped into the selection
 * (I8). Never re-timed: the definer's origin is the island zero.
 *
 * ● — a sole clip's is a new take, like any committed clip's; a definer
 * stack's is its group aggregate, so a mic's own is not offered
 * (`armable` false) though its verb still reads (`armMode`).
 *
 * LAYERS: laneCommon → the buffer-frame fields → the definer's or the
 * mic's own → takeFields (clips).
 */
export function pushDefinerLane(node, depth, ctx, { member = false } = {}) {
    const { quantum } = ctx;
    const isStack = node.type === 'stack';
    const fullQ = intrinsicPeriodQ(node, quantum);
    const t = topOf(node, mapAuthored(node, mapOf(node, quantum)), quantum);
    const topQ = t.top / quantum;
    ctx.lanes.push(Object.assign(laneCommon(node), {
        kind: isStack ? 'group' : 'clip',
        depth,
        periodQ: fullQ,
        intrinsicQ: fullQ,
        reps: [{ startQ: 0, endQ: fullQ, ghost: false }],
        takeStartQ: 0,
        windowPhase: 0,
        armMode: isStack ? null : armMode(node),
        topQ,
        storedTopQ: topQ,
        topHeardQ: topQ,
        retimeQ: Number.isFinite(node.retime) ? node.retime / quantum : 0,
        retimePeriodQ: t.periodS / quantum,
        canRetime: false,
    }, member ? {
        window: null,
        armable: false,
        bandEditable: false,
        definerMember: true,
    } : {
        window: { startQ: ctx.defSelStartQ, endQ: ctx.defSelEndQ,
                  active: true, bypassed: false, latent: false },
        armable: !isStack && isArmable(node),
        isQDefiner: true,
        folded: isStack && isFolded(node, ctx),
        groupArm: isStack ? groupArmState(node) : undefined,
    }, isStack ? null : takeFields(node, quantum, ctx)));
    pushFxRow(node, depth, ctx);
}
