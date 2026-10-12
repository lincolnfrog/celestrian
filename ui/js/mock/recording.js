/**
 * mock/recording.js — the take lifecycle (engine src/engine/
 * take_service.cc and the arm / stop / commit paths of clip_node.cc):
 * arm, the arm's own edits, the pending start, the awaited stop, the
 * commit, the settle that logs a performance, and the per-block growth
 * of live takes. Also `recView`, the cursor's frozen base while a take
 * is up.
 *
 * What the mock leaves out: latency compensation, the reservation and
 * storage upkeep, and MIDI capture (a MIDI take is a flag).
 */

import { posMod } from '../math_utils.js';
import { nextStopBoundary, armTarget } from '../timeline_model.js';
import { periodDrifts } from '../period_law.js';
import { mapPeriod, mapOffset } from '../time_map.js';
import {
    state, transport, nodeOrRoot, findNode, findParent, ancestorsOf, eachNode,
    activeMapOf, storedMap, setStoredMap, storesGeometry, intrinsicOfNode,
    takeLive, takeLength, takesOf, isCommittedClip, islandDefiner,
    settleAnchors, frameOriginOf, serializeGraph, restoreGraph,
} from './state.js';
import { pushUndoSnapshot, pushTakeStep, onHistoryCleared } from './undo.js';
import { effectiveCycle, audibleCycle } from './cycles.js';
import { setMidiArmed } from './effects.js';
import {
    activeSeqLen, anyCue, stepCued, stepIndexAt, firstVisitSpan, auditionMapOf,
} from './seq_query.js';
import { receivedAt, songPositionAt } from './heard.js';
import { lockCollapse } from './definer.js';
import { MAX_TAKES } from './takes.js';

/** The cursor view under a take (engine view_base_ / view_anchor_t_):
 * frozen at the arm, the published masterPos then grows linearly. */
export const recView = { active: false, base: 0, anchor: 0, heardAtArm: 0 };

/** Performances armed and not yet logged: { ids, snap, retake,
 * gateStack, gateStep } — `snap` is the graph at the arm, what the
 * take's undo returns to. */
const pendingTakes = [];
onHistoryCleared(() => { pendingTakes.length = 0; });

const clipsUnder = (node, out = []) => {
    eachNode(n => { if (n.type === 'clip') out.push(n); }, node);
    return out;
};
const hasInstrument = clip =>
    ((clip.effects && clip.effects.chain) || []).some(s => s.isInstrument);

// ---- the arm ------------------------------------------------------------

/** Engine applyArmEdits: the definer's trim locks (unless the arm is
 * through the definer itself) and a hand-off ends when new content is
 * recorded. Applied unlogged; answers the snapshot each one undoes to. */
function applyArmEdits(exclude, retakes) {
    const steps = [];
    const definer = islandDefiner();
    if (definer && definer !== exclude) {
        const snap = serializeGraph();
        if (lockCollapse(definer)) steps.push(snap);
    }
    const handed = state.definerDesignation ? findNode(state.definerDesignation) : null;
    const within = clip => clip === handed || ancestorsOf(clip).includes(handed);
    if (handed && !(retakes && retakes.length && retakes.every(within))) {
        steps.push(serializeGraph());
        state.definerDesignation = '';
    }
    return steps;
}

/** Engine autoTargetCuedStep: an arm while the playhead is inside a cued
 * step of the nearest sequenced ancestor aims at that step. Null when
 * there is none, or the ancestor already auditions. */
function autoTargetCuedStep(target) {
    const stack = ancestorsOf(target).find(a => activeSeqLen(a) > 0);
    if (!stack || auditionMapOf(stack) || !anyCue(stack.sequence)) return null;
    const step = stepIndexAt(stack.sequence,
        songPositionAt(stack, receivedAt(stack, state.masterPos)));
    if (!stepCued(stack.sequence, step)) return null;
    const span = firstVisitSpan(stack.sequence, step);
    return { stack, step, span: span ? { segs: [span] } : null };
}

/** Engine throughMapOf: how one target records through the maps above
 * it — { cycle } (0 = a plain take) or { refusal }. */
function throughMapOf(target, aim) {
    const aimed = a => !!aim && a === aim.stack && !!aim.span;
    const mapOf = a => (aimed(a) ? aim.span : activeMapOf(a));
    const above = ancestorsOf(target);
    const at = above.findIndex(a => mapOf(a));
    if (at < 0) return { cycle: 0 };
    const mapping = above[at];
    if (above.slice(at + 1).some(a => mapOf(a))) return { refusal: 'nested active maps' };
    if (!(state.islandQ > 0)) return { cycle: 0 };
    const sequenced = activeSeqLen(mapping) > 0;
    if (sequenced && anyCue(mapping.sequence) && !aimed(mapping) && !auditionMapOf(mapping)) {
        return { refusal: 'an authored window over cued steps' };
    }
    const period = mapPeriod(mapOf(mapping));
    return { cycle: sequenced ? period : Math.max(intrinsicOfNode(mapping), period) };
}

/** Freeze the cursor view for the performance being armed. */
function freezeRecView() {
    if (recView.active) return;
    recView.base = state.islandQ > 0
        ? posMod(state.masterPos - frameOriginOf(state.root), effectiveCycle()) : 0;
    recView.anchor = state.masterPos;
    recView.heardAtArm = audibleCycle();
    recView.active = true;
}

/** Engine armPerformance: a stopped transport starts, and the view
 * freezes. (Under a stepped clock the test moves time: state.js
 * `transport`.) */
function beginPerformance() {
    if (!state.isPlaying) {
        state.isPlaying = true;
        transport.running = !transport.stepped;
    }
    freezeRecView();
}

/** Arm `node` at absolute clock `at`: pending until an audio callback
 * finds the clock there (growRecordingClips) — the next one, when it
 * already is. Until then a stop is a cancel. */
function armAt(node, at) {
    node.isRecording = true;
    node.isPendingStart = true;
    node.pendingStartAt = at;
}

function beginCapture(node, at) {
    node.isPendingStart = false;
    delete node.pendingStartAt;
    node.recordingStartPos = at;
    if (node._retake) node._retake.captured = state.masterPos - at;
    else node.duration = state.masterPos - at;
}

/** Place a first take (engine clip_node.cc, the Armed block). */
function armFirstTake(node, cycle) {
    if (storedMap(node).segs.length >= 2) setStoredMap(node, []);  // stale cells die
    node.contentKind = hasInstrument(node) ? 'midi' : 'audio';
    node.duration = 0;
    const Q = state.islandQ;
    const raw = state.masterPos;
    const mapping = cycle > 0 ? ancestorsOf(node).find(a => activeMapOf(a)) : null;
    if (!(Q > 0)) {
        // The first take starts now; its arm moment is the provisional zero.
        state.islandZero = raw;
        armAt(node, raw);
    } else if (mapping) {
        // Through a map: the arm runs on the map period's grid from the
        // map's heard top; the take's origin is an inner position, re-based
        // to the song top under a cued step's audition.
        const map = activeMapOf(mapping);
        const mapOrigin = frameOriginOf(mapping);
        const heardTop = mapOrigin + mapOffset(map, 0);
        const tRel = armTarget(raw - heardTop, Q, mapPeriod(map));
        const cued = auditionMapOf(mapping) && stepCued(mapping.sequence, mapping.auditionStep);
        const cueBase = cued ? firstVisitSpan(mapping.sequence, mapping.auditionStep)[0] : 0;
        node._mapArm = { C: cycle, period: mapPeriod(map),
                         innerOrigin: mapOrigin + mapOffset(map, tRel) - cueBase };
        armAt(node, heardTop + tRel);
    } else {
        // The next Q boundary on the grid of the cycle the clip's scope
        // hands it, from the island zero.
        const zero = state.islandZero || 0;
        const contextLoop = Math.max(Q, receivedAt(node, raw).scope.contextCycle);
        armAt(node, zero + armTarget(raw - zero, Q, contextLoop));
    }
}

/** Arm a first take on every empty clip at or under `id`. True when the
 * take is armed; false, nothing changed, when it is refused. */
export function startRecordingInNode(id) {
    const node = nodeOrRoot(id);
    if (!node) return false;
    const targets = clipsUnder(node).filter(c => !c.isRecording && !(takeLength(c) > 0));
    if (!targets.length) return false;

    // The arm's own edits go in first: the checks judge the graph the
    // take will record against. Any member's refusal refuses the group
    // and puts them back.
    const before = serializeGraph();
    const armEdits = applyArmEdits(node, null);
    const aim = autoTargetCuedStep(targets[0]);
    const through = targets.map(t => throughMapOf(t, aim));
    if (through.some(t => t.refusal)) {
        if (armEdits.length) restoreGraph(before);
        return false;
    }

    armEdits.forEach(pushUndoSnapshot);
    if (aim) aim.stack.auditionStep = aim.step;
    const snap = serializeGraph();
    beginPerformance();
    targets.forEach((t, i) => armFirstTake(t, through[i].cycle));
    const midi = targets.find(t => t.contentKind === 'midi');
    if (midi && !midi.midiArmed) setMidiArmed(midi.id, true);

    // Aimed at a looping step: the auditioning direct parent of a member
    // names the auto-gate.
    const gated = targets.map(t => findParent(t.id)).find(p => auditionMapOf(p));
    pendingTakes.push({ ids: targets.map(t => t.id), snap, retake: false,
                        gateStack: gated ? gated.id : null,
                        gateStep: gated ? gated.auditionStep : -1 });
    return true;
}

/** A further take of a committed clip — or of a stack's committed direct
 * clips, one performance: each arms at its own slot's next top and runs
 * one period. True when the take is armed; false when it is refused. */
export function newTake(id) {
    const node = nodeOrRoot(id);
    if (!node) return false;
    const idle = c => isCommittedClip(c) && !c.isRecording;
    const targets = node.type === 'stack' ? (node.nodes || []).filter(idle)
                                          : (idle(node) ? [node] : []);
    if (!targets.length) return false;
    for (const t of targets) {
        if (t.periodSource === 'context') return false;
        if (ancestorsOf(t).some(a => activeMapOf(a))) return false;
        if (takesOf(t).length >= MAX_TAKES) return false;
        if (hasInstrument(t) !== (t.contentKind === 'midi')) return false;
    }
    applyArmEdits(null, targets).forEach(pushUndoSnapshot);
    const snap = serializeGraph();
    beginPerformance();
    for (const t of targets) {
        const raw = state.masterPos;
        t._retake = { period: t.duration, captured: 0 };
        armAt(t, raw + posMod((t.origin || 0) - raw, t.duration));
    }
    pendingTakes.push({ ids: targets.map(t => t.id), snap, retake: true,
                        gateStack: null, gateStep: -1 });
    return true;
}

// ---- the stop and the commit ---------------------------------------------

/** Ask every live take at or under `id` to stop: an armed one cancels
 * here, a capturing one ends at an audio callback (stopClip). False when
 * there was none. */
export function stopRecordingInNode(id) {
    const node = nodeOrRoot(id);
    if (!node) return false;
    const hadQ = state.islandQ > 0;
    const live = clipsUnder(node).filter(c => c.isRecording);
    live.forEach(c => stopClip(c, hadQ));
    reconcileTakes();
    return live.length > 0;
}

function endLiveTake(node) {
    node.isRecording = false;
    node.isPendingStart = false;
    node.isAwaitingStop = false;
    for (const k of ['pendingStartAt', 'recordingStartPos', 'awaitingStopAt',
                     '_mapArm', '_retake']) delete node[k];
    if (!takeLive()) recView.active = false;
}

function cancelRetake(node) {
    endLiveTake(node);
    node._retakeDone = 'cancelled';
}

/** Engine ClipNode::stopRecording. */
function stopClip(node, hadQ) {
    if (node._retake) {
        // A new take stopped short of its period cancels: at once while
        // armed, at the next block once it captures.
        if (node.isPendingStart) cancelRetake(node);
        else node._retake.cancel = true;
        return;
    }
    if (node.isPendingStart) {
        endLiveTake(node);  // never reached its boundary: un-armed, empty
        node.duration = 0;
        return;
    }
    // (A test that moves the clock with setMasterPos grows no take: the
    // clock's own reading stands in.)
    const length = Math.max(node.duration || 0,
        state.masterPos - (node.recordingStartPos || 0));
    node.duration = length;
    // A REQUEST: the take ends at an audio callback (growRecordingClips).
    // With Q it pads forward to its boundary — a through-map take's
    // ceiling is one map pass; an island's first take has no boundary and
    // ends at the next callback, at the length it has now.
    node.isAwaitingStop = true;
    node.awaitingStopAt = hadQ ? nextStopBoundary(length, state.islandQ) : length;
    if (node._mapArm) node.awaitingStopAt = Math.min(node.awaitingStopAt, node._mapArm.period);
}

/** The island's first content establishes (Q, zero) together; geometry
 * authored before Q that the new grid cannot carry is cleared (engine
 * scrubIncoherentGeometry). */
export function establishIsland(q, zero) {
    state.islandQ = q;
    state.islandZero = zero;
    eachNode(n => {
        if (storesGeometry(n) && periodDrifts(mapPeriod(storedMap(n)), q)) setStoredMap(n, []);
    });
}

/** Commit a first take at exactly `duration` (engine commitRecording): a
 * commit stores origin and duration and authors no map; the island's
 * first one establishes (Q, zero). */
function commitClip(node, duration) {
    const mapArm = node._mapArm || null;
    const origin = mapArm ? mapArm.innerOrigin : (node.recordingStartPos || 0);
    endLiveTake(node);
    node.duration = mapArm ? mapArm.C : duration;
    node.origin = origin;
    setStoredMap(node, []);
    if (!(state.islandQ > 0) && node.duration > 0) establishIsland(node.duration, origin);
    settleAnchors();
    reconcileTakes();
}

function commitRetake(node) {
    const takes = takesOf(node).slice();
    takes.push({ seed: takes.reduce((m, t) => Math.max(m, t.seed || 0), 0) + 1 });
    node.takes = takes;
    node.activeTake = takes.length - 1;
    endLiveTake(node);
    node._retakeDone = 'committed';
    reconcileTakes();
}

/** Engine reconcileTakes: a performance whose members have all settled
 * is logged — unless every member cancelled. A new take plays as
 * performed: its slot's re-time resets. */
function reconcileTakes() {
    if (takeLive()) return;
    for (const p of pendingTakes.splice(0)) {
        const members = p.ids.map(id => findNode(id)).filter(Boolean);
        const committed = members.filter(m => (p.retake ? m._retakeDone === 'committed'
                                                        : takeLength(m) > 0));
        members.forEach(m => { delete m._retakeDone; });
        if (!committed.length) continue;
        if (p.retake) committed.forEach(m => { m.retime = 0; });
        if (p.gateStack !== null && p.gateStep >= 0) applyAutoGate(p, committed);
        pushTakeStep(p.snap);
    }
}

/** Engine applyAutoGate (S19): each committed direct child of the
 * auditioning stack gates on in that step and off elsewhere. */
function applyAutoGate(p, committed) {
    const holder = nodeOrRoot(p.gateStack);
    if (!holder || !holder.sequence || p.gateStep >= holder.sequence.steps.length) return;
    const gates = { ...(holder.sequence.gates || {}) };
    for (const c of committed) {
        if (findParent(c.id) !== holder) continue;
        gates[c.id] = holder.sequence.steps.map((_, k) => k === p.gateStep);
    }
    holder.sequence = { ...holder.sequence, gates };
}

// ---- the clock ------------------------------------------------------------

/** Advance every live take by `samples` (the clock has already moved):
 * a pending one starts at its boundary; an awaited stop, a through-map
 * pass or a new take's period commits when reached. */
export function growRecordingClips(samples) {
    for (const node of clipsUnder(state.root)) {
        if (!node.isRecording) continue;
        if (node.isPendingStart) {
            if (state.masterPos >= node.pendingStartAt) beginCapture(node, node.pendingStartAt);
        } else if (node._retake) {
            node._retake.captured += samples;
        } else {
            node.duration = (node.duration || 0) + samples;
        }
        if (node.isPendingStart) continue;
        // A first take stores the cycle it is performed against once the
        // audio thread captures (engine ClipNode::beginCapture).
        if (!node._retake) node.contextCycle = recView.heardAtArm;
        node.currentPeak = 0.3 + Math.random() * 0.4;
        if (node._retake) {
            if (node._retake.cancel) cancelRetake(node);
            else if (node._retake.captured >= node._retake.period) commitRetake(node);
        } else if (node.isAwaitingStop && node.duration >= node.awaitingStopAt) {
            commitClip(node, node.awaitingStopAt);
        } else if (node._mapArm && node.duration >= node._mapArm.period) {
            commitClip(node, node._mapArm.period);
        }
    }
    reconcileTakes();
}
