/**
 * mock/recording.js — the take lifecycle: arm (with Q11 pending starts,
 * the Q13 lock-collapse, and through-map arms), the awaiting-stop pad,
 * commit (Q establishment, heard-frame origin fold, epoch re-base), and
 * the per-tick growth of live takes. Also owns `recView`, the frozen
 * view base the transport publishes against while any take records.
 */

import { posMod } from '../math_utils.js';
import { launchPointFor, nextStopBoundary, armTarget } from '../timeline_model.js';
import { mapPeriod, mapOffset, mapActive } from '../time_map.js';
import {
    state, findNode, findParent, nodeMap, intrinsicOfNode,
    committedClipCount, findSoleCommittedClip, anyNodeRecording,
    effectiveQuantumForState,
} from './state.js';
import { pushUndo } from './undo.js';
import { committedCycle, effectiveCycle } from './cycles.js';

export const recView = { active: false, base: 0, anchor: 0, lcmBefore: 0 };

/**
 * Arm a take in `id` (mirrors AudioEngine::startRecordingInNode).
 *
 * Contract, in evaluation order:
 *  - Q13 LOCK-COLLAPSE: arming against a provisionally trimmed island
 *    finalizes the trim (window BECOMES the take; snapshot pushed so
 *    undo restores).
 *  - FIRST CLIP: no committed content anywhere → transport resets to 0.
 *  - The view base freezes (recView) so the published masterPos grows
 *    linearly past the cycle while recording.
 *  - THROUGH-MAP ARM: one ACTIVE ancestor map shapes the take (heard
 *    arm on the period grid, one-period cap, dense [0, C) commit);
 *    nested active maps refuse the arm outright.
 *  - Q11: with Q established, arming PENDS to the next Q boundary in
 *    the epoch frame; exactly-on-boundary starts immediately.
 */
/** All clips in a subtree (document order). */
function clipsUnder(node, out = []) {
    if (node.type === 'clip') out.push(node);
    (node.nodes || []).forEach(c => clipsUnder(c, out));
    return out;
}

/** Resolve an arm/stop target: the root id acts as a stack over the
 * whole graph (the engine's root_node IS a StackNode; the mock's root
 * is synthetic — see publish.js `mock-root`). */
function recTarget(id) {
    if (id === 'mock-root') return { type: 'stack', nodes: state.nodes };
    return findNode(id);
}

export function startRecordingInNode(id) {
    const node = recTarget(id);
    if (!node) return;

    // Q7 GROUP ARM (engine parity, AudioEngine::startRecordingInNode):
    // record is fractal — a stack target arms every EMPTY clip beneath
    // it in this ONE call, so the group shares one arm target and one
    // committed duration (one performance, N microphones). Arm targets
    // EMPTINESS: committed members just play; re-recording is the
    // *takes* feature.
    if (node.type === 'stack') {
        const targets = clipsUnder(node)
            .filter(c => !c.isRecording && !((c.duration || 0) > 0));
        if (!targets.length) {
            console.log('[MockBackend] record refused — no empty clip under', id);
            return;
        }
        targets.forEach(c => startRecordingInNode(c.id));
        return;
    }
    // Arm targets emptiness (Q7): a committed clip is never re-armed.
    if (!node.isRecording && (node.duration || 0) > 0) {
        console.log('[MockBackend] record refused — clip has content (Q7):', id);
        return;
    }
    // Idempotent like the engine (ClipNode::startRecording gates on
    // Idle): re-arming a live take must not reset its capture state.
    if (node.isRecording) return;

    console.log('[MockBackend] startRecordingInNode', id);

    // Q13 LOCK-COLLAPSE (engine parity, AudioEngine::startRecordingInNode
    // → Edit::CollapseTake): arming a take against a provisionally
    // trimmed island finalizes the trim — the sole committed clip's
    // window BECOMES the take (duration = window len, origin moves to
    // the window top, window consumed). Undo (snapshot) restores.
    if (committedClipCount() === 1) {
        const definer = findSoleCommittedClip();
        if (definer && definer.id !== id && !definer.loopBypassed) {
            const ls = definer.loopStart || 0;
            const le = Math.min(definer.loopEnd || 0, definer.duration);
            const len = le - ls;
            if (len > 0 && !(ls === 0 && le >= definer.duration)) {
                pushUndo();
                // The engine keeps the cut material behind content_base_;
                // the mock (no buffers) remembers the pre-collapse facts
                // so a re-opening delete can uncollapse (see deleteNode).
                definer._precollapse = { dur: definer.duration, ls, le,
                                         origin: definer.origin || 0 };
                definer.origin = (definer.origin || 0) + ls;
                definer.duration = len;
                definer.loopStart = 0;
                definer.loopEnd = len;
                console.log('[MockBackend] Q13 lock-collapse:', definer.id,
                    '→ duration =', len);
            }
        }
    }

    // FIRST CLIP SNAP LOGIC (Simulation)
    // If this is the "first clip" (no effective quantum established globally yet),
    // we reset the global transport to 0.
    // Committed content ANYWHERE in the island counts (committedClipCount
    // walks the full tree — the old two-level scan missed clips nested
    // two stacks deep and reset the transport under them).
    const hasExistingAudio = committedClipCount() > 0;

    if (!hasExistingAudio) {
        state.masterPos = 0;
        console.log('[MockBackend] First Clip Detected -> Reset Global Transport to 0');
    }

    // Freeze the view base (mirrors AudioEngine view_base_/view_anchor_t_):
    // from here the published masterPos grows linearly past the cycle.
    // Base = the EFFECTIVE (window-aware) view the user was watching;
    // lcmBefore = INTRINSIC (commit/re-base compares committed material).
    if (!recView.active) {
        const raw = state.masterPos;
        const Q = effectiveQuantumForState();
        const viewCycle = effectiveCycle(Q);
        const rel = raw - state.islandEpoch;
        recView.base = viewCycle > 0 ? posMod(rel, viewCycle) : rel;
        recView.anchor = raw;
        recView.lcmBefore = committedCycle(Q); // engine's lcm_before_take_
        recView.heardAtArm = viewCycle;        // engine's heard_cycle_at_arm_
        recView.active = true;
    }

    // THROUGH-MAP ARM (time_maps.md phase 2, engine parity with
    // AudioEngine::startRecordingInNode): an ACTIVE map on an ancestor
    // group shapes this take — heard arm math on the map period's
    // grid, one-period cap, dense [0, C) commit. Nested active maps
    // refuse (composed maps are phase-3+ territory).
    let mapArm = null;
    {
        const activeAncestors = [];
        for (let p = findParent(id); p; p = findParent(p.id)) {
            if (!p.loopBypassed && mapActive(nodeMap(p))) {
                activeAncestors.push(p);
            }
        }
        if (activeAncestors.length > 1) {
            console.log('[MockBackend] record refused — nested active loop windows');
            return;
        }
        const Qnow = effectiveQuantumForState();
        if (activeAncestors.length === 1 && Qnow > 0) {
            const g = activeAncestors[0];
            const map = nodeMap(g);  // segment-general (phase 3)
            const period = mapPeriod(map);
            const C = Math.max(intrinsicOfNode(g), period);
            // Single-level mock: the mapping group's received frame is
            // the island frame, so its heard grid anchor is the epoch.
            mapArm = { map, period, C, heardEpoch: state.islandEpoch };
        }
    }

    node.isRecording = true;

    if (mapArm) {
        const Qm = effectiveQuantumForState();
        const raw = state.masterPos;
        const relH = Math.max(0, raw - mapArm.heardEpoch);
        const tRel = armTarget(relH, Qm, mapArm.period);
        const at = mapArm.heardEpoch + tRel;
        node._mapArm = {
            C: mapArm.C,
            period: mapArm.period,
            innerOrigin: mapArm.heardEpoch + mapOffset(mapArm.map, tRel),
        };
        node.duration = 0;
        if (at > raw) {
            node.isPendingStart = true;
            node.pendingStartAt = at;
            console.log('[MockBackend] Through-map pending start at', at,
                '(inner origin', node._mapArm.innerOrigin + ')');
        } else {
            node.recordingStartPos = at;
        }
        return;
    }

    // Q11 (engine parity): with Q established, arming PENDS until the
    // next Q boundary in the epoch frame — recording begins there, so
    // origins always land ON boundaries. (The mock once started
    // instantly: a mid-Q origin made the commit re-base shift every
    // lane's grid by a fraction — the "squash/stretch" repro was
    // mock-tainted until this.) Exactly-on-boundary starts immediately.
    const Q = effectiveQuantumForState();
    const raw = state.masterPos;
    if (Q > 0) {
        const rel = posMod(raw - state.islandEpoch, Q);
        const toNext = rel === 0 ? 0 : Q - rel;
        if (toNext > 0) {
            node.isPendingStart = true;
            node.pendingStartAt = raw + toNext;
            node.duration = 0;
            console.log('[MockBackend] Pending start at raw', node.pendingStartAt);
            return;
        }
    }
    node.recordingStartPos = raw;
}

export function stopRecordingInNode(id) {
    const node = recTarget(id);
    if (!node) return;

    // Q7: stop is fractal like arm — a stack target stops every live
    // take beneath it in ONE call. Snapshot the island-Q fact BEFORE
    // any stop runs (engine parity, AudioEngine::stopRecordingInNode):
    // a first-take group stop's first commit ESTABLISHES Q, which would
    // flip the siblings onto the awaiting-stop path and run them a full
    // extra Q (one performance, one committed duration).
    if (node.type === 'stack') {
        const hot = clipsUnder(node).filter(c => c.isRecording);
        const hadQ = effectiveQuantumForState() > 0;
        hot.forEach(c => stopClipRecording(c, hadQ));
        return;
    }
    if (!node.isRecording) return;
    stopClipRecording(node, effectiveQuantumForState() > 0);
}

function stopClipRecording(node, islandHasQuantum) {
    const id = node.id;
    console.log('[MockBackend] stopRecordingInNode', id);

    // Engine parity (ClipNode::stopRecording, Armed → CANCEL): stopping
    // a clip that never reached its arm boundary un-arms it — no
    // content, no phantom awaiting-stop.
    if (node.isPendingStart) {
        node.isRecording = false;
        node.isPendingStart = false;
        delete node.pendingStartAt;
        delete node._mapArm;
        node.duration = 0;
        if (!anyNodeRecording()) recView.active = false;
        console.log('[MockBackend] Arm cancelled before capture:', id);
        return;
    }

    const Q = effectiveQuantumForState();
    // Length authority: live duration (grown by the transport) and the
    // masterPos delta must agree; setMasterPos-driven tests only move
    // the latter, so reconcile here
    const rawLen = Math.max(node.duration || 0,
        state.masterPos - (node.recordingStartPos || 0));
    node.duration = rawLen;

    // ENGINE PARITY (ClipNode::stopRecording + owner ruling 2026-07-10:
    // stops always pad FORWARD): with Q established, a stop request
    // enters AWAITING-STOP — recording continues to nextStopBoundary and
    // commits there (growRecordingClips). Only the first clip (no Q at
    // the moment the stop SET was resolved — the group-stop snapshot)
    // commits immediately at its raw length.
    if (islandHasQuantum) {
        node.isAwaitingStop = true;
        node.awaitingStopAt = nextStopBoundary(rawLen, Q);
        // Through-map: one map pass is the hard ceiling (engine parity).
        if (node._mapArm) {
            node.awaitingStopAt = Math.min(node.awaitingStopAt, node._mapArm.period);
        }
        console.log('[MockBackend] Awaiting stop at len', node.awaitingStopAt,
            '(current', rawLen + ')');
        return;
    }
    commitClip(node, rawLen);
}

/** Commit a recording at exactly `duration` (mirrors commitRecording). */
export function commitClip(node, duration) {
    // Q BEFORE committing, so the stopping clip cannot define its own
    // quantum (mirrors C++ commit order)
    const Q = effectiveQuantumForState();

    // THROUGH-MAP COMMIT (engine parity, ClipNode::commitRecording):
    // the take commits at the mapping node's full inner cycle C —
    // heard snapping chose WHEN, C is WHAT commits.
    const mapArm = node._mapArm || null;
    if (mapArm) {
        duration = mapArm.C;
        delete node._mapArm;
        console.log('[MockBackend] Through-map commit — C =', duration);
    }

    node.isRecording = false;
    node.isAwaitingStop = false;
    const loopEnd = duration;

    node.duration = duration;
    node.isPlaying = true;
    node.loopStart = 0;
    node.loopEnd = loopEnd;

    // First committed take ESTABLISHES Q (design_language.md Q1: the DNA
    // of the scratch track) — STORED island state (P0-3), plus the
    // per-node declaration legacy consumers still read.
    if (Q <= 0 && duration > 0) {
        state.islandQ = duration;
        node.effectiveQuantum = duration;
        console.log('[MockBackend] First take establishes Q =', duration);
    }

    // HEARD-FRAME ORIGIN FOLD (Q15, mirrors ClipNode::armEvaluate):
    // when active windows made the audible cycle shorter than the
    // intrinsic one at arm, every heard boundary is audibly identical —
    // store the representative in the FIRST heard window of the frame.
    let foldedOrigin = node.recordingStartPos || 0;
    const heardAtArm = recView.heardAtArm || 0;
    if (mapArm) {
        // Through-map origin: the anchor's INNER position (Q15 fold
        // subsumed — the origin is already an inner-time fact).
        foldedOrigin = mapArm.innerOrigin;
    } else if (heardAtArm > 0 && recView.lcmBefore > heardAtArm) {
        const relT = posMod(foldedOrigin - state.islandEpoch, recView.lcmBefore);
        foldedOrigin -= Math.floor(relT / heardAtArm) * heardAtArm;
    }

    // The take's HEARD FRAME (Q14/Q15): the EFFECTIVE cycle it was
    // performed against — display take-marking folds by this.
    node.contextCycle = heardAtArm > 0 ? heardAtArm
        : (recView.lcmBefore > 0 ? recView.lcmBefore : 0);

    // Commit epoch re-base (mirrors StackNode::takeCommitted,
    // 2026-07-16): when the cycle GREW, the epoch moves to the HEARD
    // top the take was performed against — its (folded) origin floored
    // to whole pre-take INTRINSIC cycles. Phase-neutral for every
    // committed lane; the frame the user watched while recording
    // persists at commit.
    const newCycle = committedCycle(effectiveQuantumForState());
    if (recView.lcmBefore > 0 && newCycle > recView.lcmBefore && duration > 0) {
        const rel = Math.max(0, foldedOrigin - state.islandEpoch);
        state.islandEpoch = state.islandEpoch +
            Math.floor(rel / recView.lcmBefore) * recView.lcmBefore;
        console.log('[MockBackend] Cycle grew: epoch re-based to heard top',
            state.islandEpoch);
    }

    // Release the frozen view base when the LAST recording stops
    // (mirrors the engine's was_any_node_recording_ edge)
    if (!anyNodeRecording()) recView.active = false;

    // Origin is THE canonical timing fact (docs/kernel.md): the cycle
    // moment content[0] belongs to — heard-frame FOLDED (Q15, above).
    // Launch point is its projection, kept for UI compatibility.
    node.origin = foldedOrigin;
    node.launchPoint = launchPointFor(node.origin, duration);

    console.log(`[MockBackend] Committed ${node.id}: Dur=${duration} (Q=${Q})`);
}

// Grow recording clips by a given sample count. An AWAITING-STOP clip
// commits the moment its length reaches the boundary (engine parity:
// ClipNode's awaiting_stop_at crossing check).
export function growRecordingClips(nodes, samples) {
    (nodes || []).forEach(node => {
        if (node.isRecording) {
            if (node.isPendingStart) {
                // Q11 trigger: recording begins AT the boundary
                if (state.masterPos >= node.pendingStartAt) {
                    node.isPendingStart = false;
                    node.recordingStartPos = node.pendingStartAt;
                    node.duration = state.masterPos - node.pendingStartAt;
                    node.currentPeak = 0.3 + Math.random() * 0.4;
                }
            } else {
                node.duration = (node.duration || 0) + samples;
                // Simulate live peak data (oscillating value)
                node.currentPeak = 0.3 + Math.random() * 0.4;
                if (node.isAwaitingStop && node.duration >= node.awaitingStopAt) {
                    commitClip(node, node.awaitingStopAt);
                } else if (node._mapArm && node.duration >= node._mapArm.period) {
                    // One-period cap (engine parity): a full map pass
                    // auto-finishes cleanly.
                    commitClip(node, node._mapArm.period);
                }
            }
        }
        if (node.nodes) growRecordingClips(node.nodes, samples);
    });
}
