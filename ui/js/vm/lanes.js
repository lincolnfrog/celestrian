/**
 * The lane walk: one row per node, a group's subtree beneath it. The
 * group lane lives here with the dispatcher because the two recurse
 * into each other; the clip lanes are lane_clip.js, the shapes and the
 * shared layers lane_common.js.
 */

import { posMod } from '../math_utils.js';
import { driftsByRoundingOnly } from '../timeline_model.js';
import { nodeDrifts, ownPeriod } from '../period_law.js';
import { nodeWindowActive, publishedMap } from '../time_map.js';
import { publishedSequence, activeSequenceSamples, isAuditionWindow }
    from '../sequence_program.js';
import { unrollReps, shotOf, fireReps, shotTile, takeTileStart }
    from './tiling.js';
import { publishedLaw, frameLaw, committedClip, subtreeRec, settledForFrame,
         intrinsicPeriodQ, mapDomain, mapOf, mapAuthored, displayPeriodQ,
         scopeCycleQOf } from './published.js';
import { canDefineNode } from './definer.js';
import { seqRow, seqChipFacts, attachSeqDims } from './sequence_rows.js';
import { laneCommon, groupArmState, isFolded, bandGate, topFields,
         pushFxRow, addRow } from './lane_common.js';
import { heardViewFields, pushHeardClipLane, pushRecordingLane,
         windowEditLane, pushDefinerLane } from './lane_clip.js';

/**
 * Append the row(s) of one node — for a group, its whole subtree — to
 * ctx.lanes, then set the facts every clip and group lane carries
 * whatever built it:
 *   drifting     Q22: its own period fits no whole number of Qs, so
 *                each pass lines up differently
 *   driftShown   …and the rail says so (↯) — unless the mismatch is only
 *                a subdivision's sample rounding (driftsByRoundingOnly)
 *   canDefine    the Q lamp's offer (canDefineNode)
 *   trimSel      in the trim view with company, the definer's selection:
 *                outside it this lane does not play against the definer's
 *                buffer this pass
 *
 * @param {LaneContext} ctx
 * @param {LaneScope} scope  what the node inherits from the groups above
 */
export function pushLane(node, depth, ctx, scope) {
    if (depth > ctx.maxDepth) return;
    const at = ctx.lanes.length;
    const drifting = ctx.qEstablished &&
        nodeDrifts(node, publishedLaw(ctx.quantum));
    const zero = laneZeroOf(node, ctx, scope, drifting);
    pushLaneFrom(node, depth, ctx,
                 zero === scope.zero ? scope : { ...scope, zero });
    const lane = ctx.lanes[at];
    if (!lane || lane.id !== node.id) return;
    lane.drifting = drifting;
    lane.driftShown = drifting && !driftsByRoundingOnly(node, ctx.quantum);
    lane.canDefine = canDefineNode(node, ctx, scope.underWarp);
    if (ctx.trimCompany && node.id !== ctx.soleQDefinerId) {
        lane.trimSel = { startQ: ctx.defSelStartQ, endQ: ctx.defSelEndQ };
    }
}

/**
 * THE LANE'S ZERO (Q22), samples: a drifting loop — and, in the trim
 * view with company, every lane but the definer's — is drawn from the
 * PASS zero, so it shows the pass that sounds under the cursor.
 * Everything else is drawn from the zero it inherits, and hands it on: a
 * group's members tile in the frame their group was drawn in. Inside a
 * one-shot's frame nothing drifts pass to pass: the clock restarts with
 * every firing.
 */
function laneZeroOf(node, ctx, scope, drifting) {
    if (ctx.trimCompany && node.id !== ctx.soleQDefinerId) return ctx.passZero;
    return drifting && !scope.shot ? ctx.passZero : scope.zero;
}

/** pushLane's dispatch, drawn from scope.zero. */
function pushLaneFrom(node, depth, ctx, scope) {
    if (node.type === 'stack') {
        pushGroupLane(node, depth, ctx, scope);
        return;
    }
    if (ctx.provisionalDefiner && node.id === ctx.soleQDefinerId) {
        pushDefinerLane(node, depth, ctx);
        return;
    }
    // Origins are absolute; tiles are measured from the lane's zero.
    const offsetQ = ((node.origin || 0) - scope.zero) / ctx.quantum;
    if (node.isRecording) {
        pushRecordingLane(node, depth, offsetQ, ctx, scope);
        return;
    }
    const intrinsicQ = intrinsicPeriodQ(node, ctx.quantum);
    const win = mapOf(node, ctx.quantum);
    if (win && ctx.compMode && ctx.compMode.has(node.id)) {
        ctx.lanes.push(windowEditLane(node, depth, win, intrinsicQ, ctx, scope));
        pushFxRow(node, depth, ctx);
        return;
    }
    pushHeardClipLane(node, depth, offsetQ, displayPeriodQ(node, ctx.quantum),
                      intrinsicQ, win, ctx, scope);
}

/** A group's lane, then — unless folded — its subtree. */
function pushGroupLane(node, depth, ctx, scope) {
    if (ctx.provisionalDefiner && node.id === ctx.soleQDefinerId) {
        pushDefinerStack(node, depth, ctx, scope);
        return;
    }
    const group = readGroup(node, ctx, scope);
    const lane = groupLane(node, depth, group, ctx, scope);
    ctx.lanes.push(lane);
    if (ctx.seqOpen && ctx.seqOpen.has(node.id)) {
        ctx.lanes.push(seqRow(node, depth + 1, ctx.quantum, ctx.qEstablished,
                              group.originQ));
    }
    pushFxRow(node, depth, ctx);
    if (!lane.folded) pushGroupChildren(node, depth, group, ctx, scope);
}

/**
 * The trim view of a definer STACK (Q13 for groups): its lane, and
 * beneath it each mic's whole take in the same buffer frame — tiled on
 * the zero grid, the mics would sit off the composite above them by the
 * fold offset. Its members get no map scope: the selection is Q being
 * defined, not a part.
 */
function pushDefinerStack(node, depth, ctx, scope) {
    pushDefinerLane(node, depth, ctx);
    if (isFolded(node, ctx)) return;
    (node.nodes || []).forEach(c => {
        if (committedClip(c)) pushDefinerLane(c, depth + 1, ctx, { member: true });
        else pushLane(c, depth + 1, ctx, { ...scope, map: null });
    });
    ctx.lanes.push(addRow(node, depth + 1));
}

/**
 * What a group's lane and its children's scope are built from.
 *
 * THE GROUP AS THE FRAME READS IT (`slot`, settledForFrame): its period,
 * map and ↺ are those of the loop it will be again once its members' new
 * takes commit. The arm state, the recording gate and the member lanes
 * read the node as published.
 *
 * THE ANCHOR (Q18, composition.md §9): a stack with committed content
 * has an origin, a published fact the view never derives. Its lane is
 * drawn from it exactly as a clip's: `originQ` (`originS` in samples) is
 * that origin in the lane frame, and the brackets, dims, bands and the
 * song on the lane are inner positions from it. An unanchored stack
 * measures from its cycle top: 0.
 *
 * THE SHOT (`shot`, tiling.shotOf) of a one-shot group: where it fires.
 * Its shot is its authored window, else its own period by the period
 * law. Null for a loop — and for a one-shot that folds nothing (nothing
 * in it loops, or its cycle is no longer than its own period): the
 * engine passes the clock through such a stack, so it is drawn as the
 * loop it plays.
 */
function readGroup(node, ctx, scope) {
    const { quantum } = ctx;
    const slot = settledForFrame([node], ctx.retakes, quantum)[0];
    const gwin = mapOf(slot, quantum);
    const authored = mapAuthored(slot, gwin);
    const anchored = !!node.anchored;
    const originS = anchored ? (node.origin || 0) - scope.zero : 0;
    const oneShot = node.periodSource === 'context';
    return {
        slot,
        periodQ: displayPeriodQ(slot, quantum),
        gwin,
        authored,
        intrinsicQ: intrinsicPeriodQ(slot, quantum),
        domainQ: mapDomain(slot, quantum) / quantum,
        live: subtreeRec(node),
        anchored,
        originS,
        originQ: originS / quantum,
        oneShot,
        shot: oneShot && ctx.qEstablished ? shotOf({
            map: authored ? publishedMap(slot) : { segs: [] },
            own: ownPeriod(slot, frameLaw(quantum)), isStack: true,
            origin: originS, scopeQ: scope.cycleQ || 0, quantum,
            cycleQ: ctx.cycleQ }) : null,
        song: publishedSequence(node),
    };
}

/** A group's lane (GroupLane, lane_common.js) from readGroup's facts. */
function groupLane(node, depth, group, ctx, scope) {
    const { quantum, qEstablished, cycleQ, lcmQ } = ctx;
    const { slot, periodQ, gwin, authored, intrinsicQ, live, anchored,
            originQ, oneShot, shot, song } = group;
    const editable = qEstablished && intrinsicQ >= 2 && !live;
    const groupFields = {
        kind: 'group',
        depth,
        folded: isFolded(node, ctx),
        groupArm: groupArmState(node),
        mapRecording: !!(gwin && gwin.active && live),
        mapSuspended: !!(gwin && gwin.suspended),
        anchored,
    };
    let lane;
    if (authored) {
        // THE HEARD VIEW (displayPeriodQ), anchored as a windowed clip's:
        // the content's start sounds at origin + a0.
        const heardTopQ = periodQ > 0
            ? posMod(originQ + gwin.segs[0][0], periodQ) : 0;
        // The map is drawn over the DOMAIN it selects from (mapDomain),
        // which a child's own window leaves longer than the inner cycle.
        lane = Object.assign(laneCommon(node), groupFields,
            heardViewFields({ win: gwin, lanePeriodQ: periodQ,
                              intrinsicQ: Math.max(group.domainQ, gwin.endQ),
                              heardTopQ, cycleQ, qEstablished,
                              editable, locked: ctx.mapEditsLocked, shot }));
    } else {
        // RAW-FRAMED: the inner cycle tiled from the group's origin. The
        // take tile is at its performed cycle position when the origin
        // is at or after the lane's zero, else the first full tile. A
        // ONE-SHOT's is its shot alone, at its firing: the leading
        // `shot.lenQ` of the inner cycle.
        const takeQ = anchored && originQ >= 0 && lcmQ > 0
            ? posMod(originQ, lcmQ) : undefined;
        const lanePeriodQ = shot ? shot.lenQ : periodQ;
        const reps = !qEstablished ? []
            : shot ? fireReps([shotTile(shot, [[0, intrinsicQ > shot.lenQ
                ? shot.lenQ / intrinsicQ : 1]])], shot, cycleQ, lanePeriodQ)
            : unrollReps({ periodQ, offsetQ: originQ, cycleQ, takeQ });
        const audition = !!gwin && isAuditionWindow(node);
        lane = Object.assign(laneCommon(node), groupFields, {
            periodQ: lanePeriodQ,
            intrinsicQ,
            reps,
            takeStartQ: shot ? shot.startQ : takeTileStart(reps),
            ...(shot ? { shotEveryQ: shot.everyQ } : null),
            // A map that does not set the lane's length — bypassed,
            // suspended, or a STEP AUDITION's derived window — lies over
            // the raw inner cycle: one window keeps its brackets, a
            // multi-segment map draws dims and one chip. An audition's
            // window is in SONG coordinates (§11.2) and is flagged: it
            // is drawn, never dragged — a drag would write it back as
            // the authored window.
            window: gwin && gwin.multi ? null
                : (audition ? Object.assign({}, gwin, { audition: true }) : gwin),
            mapSegs: gwin && gwin.multi ? gwin.segs : null,
            mapBypassed: !!(gwin && gwin.bypassed),
            mapChipQ: gwin && gwin.multi ? gwin.periodQ : 0,
            // The window that sounds on a raw-framed group lane is a step
            // audition's: its cursor reads the stack's published phase,
            // as a clip's does.
            windowPhase: nodeWindowActive(node) ? (node.playhead || 0) : 0,
            bandSegs: gwin ? gwin.segs : null,
            bandTotalQ: intrinsicQ,
        }, bandGate(editable, ctx.mapEditsLocked));
    }
    // THE ↺ AND THE TIMING (topFields): a group is a loop like a clip.
    // Offered on a committed group that is no one-shot, not the definer,
    // not shown through an enclosing map (that group owns the chrome),
    // with nothing recording inside; held inert by the recording gate.
    const underParentMap = !!scope.map && !(gwin && gwin.active);
    const onceIdle = qEstablished && anchored && !oneShot && !underParentMap &&
        !live && !ctx.definerIds.has(node.id);
    Object.assign(lane, anchored
        ? topFields(slot, authored, ctx, scope,
                    onceIdle && !ctx.mapEditsLocked,
                    onceIdle && ctx.mapEditsLocked)
        : { topQ: 0, topHeardQ: 0, retimeQ: 0, canRetime: false });
    lane.seq = song ? seqChipFacts(song, quantum) : null;
    return lane;
}

/**
 * An open group's children, the dims its song projects onto them, and
 * its "+" row. The children inherit a new LaneScope: the nearest
 * enclosing ACTIVE map wins (engine parity) — this group's own, else the
 * one above.
 *
 * A ONE-SHOT group's subtree is drawn in its SHOT's frame — the zero at
 * the shot's top (the clock its children hear restarts there with every
 * firing), the frame the shot's length — and then FIRED with it
 * (fireLanes): every lane beneath sounds inside the group's firings and
 * rests with it, at any depth.
 */
function pushGroupChildren(node, depth, group, ctx, scope) {
    const { quantum, lanes } = ctx;
    const { slot, gwin, intrinsicQ, originS, originQ, oneShot, shot, song } = group;
    const songLength = activeSequenceSamples(node);
    const zero = shot ? scope.zero + originS + shot.segs[0][0] : scope.zero;
    const moved = zero - scope.zero;
    const within = shot
        ? Object.freeze({ ...ctx, cycleQ: shot.lenQ, lcmQ: shot.lenQ,
                          playheadQ: ctx.playheadQ - shot.startQ })
        : ctx;
    const childScope = {
        zero,
        cycleQ: scopeCycleQOf(node, quantum, scope.cycleQ),
        shot: shot ? { lenQ: shot.lenQ } : scope.shot,
        underWarp: scope.underWarp || nodeWindowActive(node) ||
            songLength > 0 || oneShot,
        map: gwin && gwin.active ? {
            periodQ: gwin.periodQ,
            startQ: gwin.segs[0][0],
            segs: gwin.segs,
            originQ: (originS - moved) / quantum,
            segsS: publishedMap(slot).segs,
            originS: originS - moved,
            groupCycleQ: songLength > 0 ? songLength / quantum : intrinsicQ,
        } : scope.map && moved ? {
            ...scope.map,
            originQ: scope.map.originQ - moved / quantum,
            originS: scope.map.originS - moved,
        } : scope.map,
    };
    const from = lanes.length;
    (node.nodes || []).forEach(c => pushLane(c, depth + 1, within, childScope));
    if (shot) fireLanes(lanes, from, lanes.length, shot, ctx.cycleQ);
    // An ACTIVE song projects its gates onto the lanes beneath it,
    // anchored at the group's origin (attachSeqDims).
    if (song && !song.bypassed) {
        attachSeqDims(lanes, from, lanes.length, node.nodes, song, quantum, originQ);
    }
    lanes.push(addRow(node, depth + 1));
}

/**
 * FIRE the lanes [from, to), built in a one-shot's SHOT frame, onto the
 * frame it fires in: their tiles at every firing (tiling.fireReps), and
 * each position they carry from the frame's zero moved to the take's
 * firing. A lane on its own scale (comp mode's raw lane) is in no frame.
 */
function fireLanes(lanes, from, to, shot, cycleQ) {
    const at = shot.startQ;
    for (let i = from; i < to; i++) {
        const lane = lanes[i];
        if ((lane.kind !== 'clip' && lane.kind !== 'group') || lane.frameQ) continue;
        lane.reps = fireReps(lane.reps || [], shot, cycleQ, lane.periodQ);
        lane.takeStartQ = (lane.takeStartQ || 0) + at;
        if (lane.retimePeriodQ > 0) {
            lane.topHeardQ = posMod(lane.topHeardQ + at, lane.retimePeriodQ);
        }
        if (lane.armAtQ) lane.armAtQ += at;
        if (lane.seqDims) {
            lane.seqDims = lane.seqDims.map(d => {
                const { phaseQ = 0, ...rest } = d;
                const moved = posMod(phaseQ + at, d.periodQ);
                return moved ? { ...rest, phaseQ: moved } : rest;
            });
        }
    }
}
