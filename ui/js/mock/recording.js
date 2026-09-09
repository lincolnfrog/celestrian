/**
 * mock/recording.js — the take lifecycle: arm (with Q11 pending starts,
 * the Q13 lock-collapse, and through-map arms), the awaiting-stop pad,
 * commit (Q establishment, heard-frame origin fold, epoch re-base), and
 * the per-tick growth of live takes. Also owns `recView`, the frozen
 * view base the transport publishes against while any take records.
 */

import { posMod, lcm } from '../math_utils.js';
import { launchPointFor, nextStopBoundary, armTarget } from '../timeline_model.js';
import { mapPeriod, mapOffset, mapActive } from '../time_map.js';
import { activeGeometryOutside,
    state, findNode, findParent, nodeMap, intrinsicOfNode, activeMapOf,
    rootActiveMap, auditionMapOf, serializeGraph,
    committedClipCount, findSoleCommittedClip, anyNodeRecording,
    effectiveQuantumForState, definerStackNode,
    shiftOrigins, settleAnchors, frameOriginOf, nodeInner,
} from './state.js';
import { pushUndo, pushUndoSnapshot, onHistoryCleared } from './undo.js';
import { committedCycle, effectiveCycle } from './cycles.js';
import { setMidiArmed } from './effects.js';
import { activeSeqLen, stepCued, stepIndexAt, firstVisitSpan } from './sequence.js';

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

/**
 * TAKES ARE UNDOABLE (engine parity, AudioEngine::PendingTake — docs/
 * sequencer.md §11.5): a performance registers here at arm with the
 * graph snapshot the take will undo TO; reconcileTakes() pushes it onto
 * the undo stack once every member has settled (committed or cancelled).
 * One entry per startRecordingInNode call = one undo step for a Q7
 * group take. The snapshot is taken AFTER the Q13 collapse (the engine
 * logs CollapseTake, then Take), BEFORE any member is marked recording.
 */
const pendingTakes = [];
onHistoryCleared(() => { pendingTakes.length = 0; });

export function startRecordingInNode(id) {
    const node = recTarget(id);
    if (!node) return;

    // Q7 GROUP ARM (engine parity, AudioEngine::startRecordingInNode):
    // record is fractal — a stack target arms every EMPTY clip beneath
    // it in this ONE call, so the group shares one arm target and one
    // committed duration (one performance, N microphones). Arm targets
    // EMPTINESS: committed members just play; re-recording is the
    // *takes* feature.
    let targets;
    if (node.type === 'stack') {
        targets = clipsUnder(node)
            .filter(c => !c.isRecording && !((c.duration || 0) > 0));
        if (!targets.length) {
            console.log('[MockBackend] record refused — no empty clip under', id);
            return;
        }
    } else {
        // Arm targets emptiness (Q7): a committed clip is never re-armed.
        if (!node.isRecording && (node.duration || 0) > 0) {
            console.log('[MockBackend] record refused — clip has content (Q7):', id);
            return;
        }
        // Idempotent like the engine (ClipNode::startRecording gates on
        // Idle): re-arming a live take must not reset its capture state.
        if (node.isRecording) return;
        targets = [node];
    }

    lockCollapseAtArm(targets.map(t => t.id));

    // The pending performance: its undo snapshot + the step auto-gate
    // target (the auditioning DIRECT parent, §11.5 — root included).
    const pending = { ids: targets.map(t => t.id), snap: serializeGraph(),
                      gateStack: null, gateStep: -1 };
    for (const t of targets) {
        const parent = findParent(t.id);
        if (parent) {
            if (auditionMapOf(parent)) {
                pending.gateStack = parent.id;
                pending.gateStep = parent.auditionStep;
                break;
            }
        } else if (rootActiveMap()) {
            pending.gateStack = 'mock-root';
            pending.gateStep = state.rootAuditionStep;
            break;
        }
    }
    targets.forEach(armClip);
    pendingTakes.push(pending);
}

/**
 * Q13 LOCK-COLLAPSE at an arm (engine parity, AudioEngine::
 * startRecordingInNode / newTake → Edit::CollapseTake, CollapseGroup):
 * arming against a provisionally trimmed island finalizes the trim —
 * the sole committed clip's window BECOMES the take (duration = window
 * len, origin moves to the window top, window consumed), or a definer
 * stack's window becomes its members' take. `excludeIds` are the arm
 * targets a plain arm never collapses (they are empty); a new take
 * passes none — its own slot is what collapses. Undo (snapshot)
 * restores.
 */
function lockCollapseAtArm(excludeIds) {
    if (committedClipCount() === 1) {
        const definer = findSoleCommittedClip();
        if (definer && !excludeIds.includes(definer.id) &&
            !definer.loopBypassed && !activeGeometryOutside(definer)) {
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
                definer.loopEnd = 0;  // consumed: the take IS the window
                console.log('[MockBackend] Q13 lock-collapse:', definer.id,
                    '→ duration =', len);
            }
        }
    }

    // The GROUP twin (engine parity collapseGroupNow, Q18 — composition
    // .md §5 "lock-collapse at the second arm, clip or stack definer"):
    // a trimmed definer STACK collapses to its window before any arm —
    // members' duration := len, content base shifts by the window
    // start, and the ORIGIN of the whole subtree (stack AND members)
    // shifts by the window start too — exactly the sole-clip law
    // (window top → origin), since the stack's window anchors at the
    // stack's own origin. Audio-neutral: inner s + ((t − O − s) mod
    // len) before == base s + ((t − (O + s)) mod len) after. Stack
    // window consumed.
    {
        const ds = definerStackNode();
        if (ds && !activeGeometryOutside(ds) &&
            !anyNodeRecording() && !ds.loopBypassed &&
            !(Array.isArray(ds.segments) && ds.segments.length >= 2)) {
            const members = (ds.nodes || []).filter(c =>
                c.type === 'clip' && (c.duration || 0) > 0 && !c.isRecording);
            const D = members.length ? members[0].duration : 0;
            const ls = Math.max(0, ds.loopStart || 0);
            const le = Math.min(ds.loopEnd || 0, D);
            const len = le - ls;
            if (D > 0 && len > 0 && !(ls === 0 && le >= D) &&
                members.every(m => m.duration === D)) {
                pushUndo();
                members.forEach(m => {
                    m._precollapse = { dur: D, ls: 0, le: 0, group: true };
                    m.duration = len;
                    m.loopStart = 0;
                    m.loopEnd = 0;  // members whole (no window)
                });
                shiftOrigins(ds, ls);
                ds._precollapse = { ls, le, shift: ls };
                ds.loopStart = 0;
                ds.loopEnd = 0;
                console.log('[MockBackend] Q13 group lock-collapse:', ds.id,
                    '→ members duration =', len, '(origins +', ls + ')');
            }
        }
    }
}

/**
 * NEW TAKE (docs/takes.md; engine parity AudioEngine::newTake): arm a
 * further take of a COMMITTED clip — or of every committed direct clip
 * child of a stack, one performance — without emptying it. The slot
 * keeps origin, duration, loop points and comp; the previous takes
 * stay in the list; the clip is silent while the take is live. Arm
 * target: the next t ≡ origin (mod duration); capture runs exactly one
 * period and auto-finishes (growRecordingClips); a stop before that
 * cancels (stopClipRecording). Logged at settle like any take (the
 * snapshot taken here is what undo restores: the previous list).
 * Refused with no committed target, on a one-shot, or under an active
 * ancestor map (the slot top may never be heard through it).
 */
export function newTake(id) {
    const node = recTarget(id);
    if (!node) return;
    const committedIdle = c => c.type === 'clip' && !c.isRecording && (c.duration || 0) > 0;
    const targets = node.type === 'stack'
        ? (node.nodes || []).filter(committedIdle)
        : (committedIdle(node) ? [node] : []);
    if (!targets.length) {
        console.log('[MockBackend] new take refused — no committed idle clip under', id);
        return;
    }
    for (const t of targets) {
        if (t.periodSource === 'context') {
            console.log('[MockBackend] new take refused — one-shot:', t.id);
            return;
        }
        for (let p = findParent(t.id); p; p = findParent(p.id)) {
            if (activeMapOf(p)) {
                console.log('[MockBackend] new take refused — an active map encloses', t.id);
                return;
            }
        }
        if (rootActiveMap()) {
            console.log('[MockBackend] new take refused — the root audition encloses', t.id);
            return;
        }
    }
    lockCollapseAtArm([]);
    const pending = { ids: targets.map(t => t.id), snap: serializeGraph(),
                      gateStack: null, gateStep: -1, retake: true };
    targets.forEach(armRetake);
    pendingTakes.push(pending);
}

/** Arm one slot for a new take: silent, pending its own next top. */
function armRetake(node) {
    console.log('[MockBackend] newTake', node.id);
    if (!recView.active) {
        const raw = state.masterPos;
        const Q = effectiveQuantumForState();
        const viewCycle = effectiveCycle(Q);
        const rel = raw - state.islandEpoch;
        recView.base = viewCycle > 0 ? posMod(rel, viewCycle) : rel;
        recView.anchor = raw;
        recView.lcmBefore = committedCycle(Q);
        recView.heardAtArm = viewCycle;
        recView.active = true;
    }
    const period = node.duration;
    const origin = node.origin || 0;
    const raw = state.masterPos;
    const rel = Math.max(0, raw - origin);
    const at = origin + Math.ceil(rel / period) * period;
    node._retake = { period, captured: 0 };
    node.isRecording = true;
    node.isPlaying = false;
    if (at > raw) {
        node.isPendingStart = true;
        node.pendingStartAt = at;
        console.log('[MockBackend] New take pending at the slot top', at);
    } else {
        node.recordingStartPos = at;
    }
}

/** A new take reached its period: it joins the list and becomes the
 * active take; the slot's facts and comp stand. */
function commitRetake(node) {
    const takes = takesOf(node).slice();
    takes.push({ seed: nextTakeSeed(node) });
    node.takes = takes;
    node.activeTake = takes.length - 1;
    node.isRecording = false;
    node.isPendingStart = false;
    delete node.pendingStartAt;
    delete node._retake;
    node.isPlaying = true;
    node._retakeDone = 'committed';
    if (!anyNodeRecording()) recView.active = false;
    console.log(`[MockBackend] New take committed on ${node.id}: take ${node.activeTake}`);
    reconcileTakes();
}

/** The take list of a clip: `takes` when materialized, else the one
 * implicit take a committed clip holds (engine parity takeCount). */
export function takesOf(node) {
    if (Array.isArray(node.takes) && node.takes.length) return node.takes;
    return (node.duration || 0) > 0 ? [{ seed: 0 }] : [];
}

/** A fresh waveform seed for a new take (distinct peaks per take). */
function nextTakeSeed(node) {
    const takes = takesOf(node);
    return takes.reduce((m, t) => Math.max(m, t.seed || 0), 0) + 1;
}

/** Settle pending performances (engine parity: reconcileTakes). A new
 * take logs only when it committed (a cancel leaves the slot as it was
 * and records nothing). */
function reconcileTakes() {
    for (let i = 0; i < pendingTakes.length;) {
        const p = pendingTakes[i];
        const members = p.ids.map(id => findNode(id)).filter(Boolean);
        if (members.some(m => m.isRecording)) { i++; continue; }
        pendingTakes.splice(i, 1);
        const committed = p.retake
            ? members.filter(m => m._retakeDone === 'committed')
            : members.filter(m => (m.duration || 0) > 0);
        members.forEach(m => { delete m._retakeDone; });
        if (!committed.length) continue;  // the whole performance cancelled
        pushUndoSnapshot(p.snap);
        console.log('[MockBackend] take logged (undoable) -', committed.length, 'clip(s)');
        if (p.gateStack != null && p.gateStep >= 0) applyAutoGate(p, committed);
    }
}

/** S19 auto-gate (engine parity, AudioEngine::applyAutoGate): each
 * committed DIRECT child of the looping stack gates ON in that step,
 * OFF elsewhere — part of the take's one undo step (the snapshot
 * precedes both). */
function applyAutoGate(p, committed) {
    const holder = p.gateStack === 'mock-root'
        ? { get sequence() { return state.rootSequence; },
            set sequence(v) { state.rootSequence = v; } }
        : findNode(p.gateStack);
    if (!holder || !holder.sequence) return;
    const n = holder.sequence.steps.length;
    if (p.gateStep >= n) return;
    const gates = { ...(holder.sequence.gates || {}) };
    let changed = false;
    for (const c of committed) {
        const parent = findParent(c.id);
        const direct = p.gateStack === 'mock-root' ? !parent : (parent && parent.id === p.gateStack);
        if (!direct) continue;
        gates[c.id] = holder.sequence.steps.map((_, k) => k === p.gateStep);
        changed = true;
    }
    if (!changed) {
        console.log('[MockBackend] step-take landed ungated (not a direct child)');
        return;
    }
    holder.sequence = { ...holder.sequence, gates };
}

function armClip(node) {
    const id = node.id;
    console.log('[MockBackend] startRecordingInNode', id);

    // STALE GEOMETRY DIES AT ARM (engine parity: exchangeMapOverride at
    // arm): a map override surviving a take strip on the now-empty
    // clip would warp the NEW take.
    delete node.segments;

    // FIRST CLIP: with no committed content anywhere in the island the
    // global transport resets to 0. committedClipCount walks the FULL
    // tree — a shallower scan would miss deeply nested clips and reset
    // the transport under them.
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

    // S21 AUTO-TARGET (engine parity): arming while the playhead is
    // inside a CUED step becomes Mode-2
    // record-into-that-step — the nearest sequenced ancestor's
    // audition engages so the take lands where cue playback reads it
    // (the song top). An audition already active means the performer
    // aimed explicitly and wins.
    {
        const rootSeqHolder = {
            sequence: state.rootSequence,
            sequenceBypassed: state.rootSequenceBypassed,
        };
        let aimed = false;
        for (let p = findParent(id); p && !aimed; p = findParent(p.id)) {
            if (p.type !== 'stack') continue;
            if (auditionMapOf(p)) { aimed = true; break; }
            if (activeSeqLen(p) > 0) {
                // The song position is inner(t) from the STACK's own
                // frame (Q18, engine StackNode::childContext cue lookup).
                const rel = nodeInner(p, state.masterPos);
                const i = stepIndexAt(p.sequence, rel);
                if (stepCued(p.sequence, i)) {
                    p.auditionStep = i;
                    console.log('[MockBackend] arm inside cued step', i,
                        '- auto-targeting it (S21)');
                }
                aimed = true;  // nearest sequenced ancestor answers
            }
        }
        if (!aimed && !rootActiveMap() && activeSeqLen(rootSeqHolder) > 0) {
            const rel = state.masterPos - state.islandEpoch;
            const i = stepIndexAt(state.rootSequence, rel);
            if (stepCued(state.rootSequence, i)) {
                state.rootAuditionStep = i;
                console.log('[MockBackend] arm inside cued ROOT step', i,
                    '- auto-targeting it (S21)');
            }
        }
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
            if (activeMapOf(p)) activeAncestors.push(p);  // audition-aware
        }
        // The ROOT's step audition (§11.2) maps every top-level track.
        const rootMap = rootActiveMap();
        if (rootMap) activeAncestors.push({ _root: true, _map: rootMap });
        if (activeAncestors.length > 1) {
            console.log('[MockBackend] record refused — nested active loop windows');
            return;
        }
        const Qnow = effectiveQuantumForState();
        if (activeAncestors.length === 1 && Qnow > 0) {
            const g = activeAncestors[0];
            const map = g._root ? g._map : activeMapOf(g);  // segment-general (phase 3)
            const period = mapPeriod(map);
            // S18: under an ACTIVE SEQUENCE the take is a step-sized
            // PART — C = the map period, no silence inserted. Without
            // a sequence, the phase-2 rule (the mapping node's full
            // inner cycle) stands.
            const gseq = g._root ? state.rootSequence : g.sequence;
            const gAudStep = g._root
                ? (state.rootAuditionStep ?? -1)
                : (auditionMapOf(g) ? g.auditionStep : -1);
            const sequenced = g._root
                ? activeSeqLen({ sequence: state.rootSequence,
                                 sequenceBypassed: state.rootSequenceBypassed }) > 0
                : activeSeqLen(g) > 0;
            // CUE x AUTHORED WINDOW (engine parity): an authored window
            // over a sequence with cued steps is a multi-step
            // composition outside the ratified scope.
            const anyCue = sequenced && gseq &&
                gseq.steps.some(st => !!st.cue);
            const isAudition = g._root ? true : !!auditionMapOf(g);
            if (anyCue && !isAudition) {
                console.log('[MockBackend] record refused — an authored ' +
                    'window over a sequence with cued steps');
                return;
            }
            const C = sequenced ? period : Math.max(intrinsicOfNode(g), period);
            // Mode-2 into a CUED step composes the cue (engine parity,
            // StackNode::childContext): the take lands at the SONG TOP
            // [0, stepLen) — cue playback reads it there.
            // The audition loops the step's FIRST visit (§14).
            const cueBase = sequenced && gAudStep >= 0 &&
                stepCued(gseq, gAudStep)
                ? (firstVisitSpan(gseq, gAudStep) || [0])[0] : 0;
            // Q18 (engine parity StackNode::childContext →
            // map_origin / map_heard_epoch): the map's inner positions
            // are offsets from the mapping node's ORIGIN (an anchored
            // stack's own; the received cycle top otherwise — and the
            // synthetic root's frame is the epoch), and the heard grid
            // anchor the arm math runs against is origin + mapOffset(0).
            const mapOrigin = g._root ? (state.islandEpoch || 0)
                                      : frameOriginOf(g);
            mapArm = { map, period, C, mapOrigin,
                       heardEpoch: mapOrigin + mapOffset(map, 0), cueBase };
        }
    }

    // MIDI takes (phase 5, engine parity ClipNode::startRecording): an
    // instrument slot on the clip makes the take notes, not audio —
    // and record MIDI-arms it (AudioEngine::startRecordingInNode).
    const chain = (node.effects && node.effects.chain) || [];
    node.contentKind = chain.some(s => s.isInstrument) ? 'midi' : 'audio';
    if (node.contentKind === 'midi' && !node.midiArmed) setMidiArmed(node.id, true);

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
            // The anchor's inner position, absolute (engine parity
            // clip_node.cc through-map arm): map_origin + mapOffset(t_rel).
            // The cue composition subtracts the step base: the audition
            // map selects [stepStart, stepEnd) of the song, the cue
            // re-bases that span to the song top (engine parity).
            innerOrigin: mapArm.mapOrigin +
                mapOffset(mapArm.map, tRel) - (mapArm.cueBase || 0),
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
    // origins always land ON boundaries (a mid-Q origin would make the
    // commit re-base shift every lane's grid by a fraction).
    // Exactly-on-boundary starts immediately.
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
    } else {
        // FIRST-CLIP ARM ESTABLISHES THE PROVISIONAL EPOCH (engine
        // parity: establishIsland(0, epoch) — q == 0 sets a provisional
        // epoch only). A stale epoch standing until commit would run
        // the pre-commit projections (recording view, ghost tiles) in
        // the wrong frame.
        state.islandEpoch = raw;
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

    // A NEW TAKE stopped before its period CANCELS (docs/takes.md):
    // nothing shorter can be a take of the slot; the previous take
    // sounds again and nothing is logged.
    if (node._retake) {
        node.isRecording = false;
        node.isPendingStart = false;
        delete node.pendingStartAt;
        delete node._retake;
        node.isPlaying = true;
        node._retakeDone = 'cancelled';
        if (!anyNodeRecording()) recView.active = false;
        console.log('[MockBackend] New take cancelled before its period:', id);
        reconcileTakes();
        return;
    }

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
        reconcileTakes();
        return;
    }

    const Q = effectiveQuantumForState();
    // Length authority: live duration (grown by the transport) and the
    // masterPos delta must agree; setMasterPos-driven tests only move
    // the latter, so reconcile here
    const rawLen = Math.max(node.duration || 0,
        state.masterPos - (node.recordingStartPos || 0));
    node.duration = rawLen;

    // ENGINE PARITY (ClipNode::stopRecording; stops always pad
    // FORWARD): with Q established, a stop request
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

/** Q ESTABLISHMENT SCRUB (engine parity
 * AudioEngine::scrubIncoherentGeometry): pre-Q authored windows/maps
 * whose period cannot live on the just-established grid are cleared.
 * Committed clips' full-span windows are commit furniture, untouched. */
function scrubIncoherentGeometry(q) {
    if (!(q > 0)) return;
    const coherent = p => p > 0 && (p % q === 0 || q % p === 0);
    const visit = nodes => (nodes || []).forEach(n => {
        if (Array.isArray(n.segments) && n.segments.length >= 2) {
            // Internal form: an array of [start, end] PAIRS.
            const p = n.segments.reduce((acc, sg) => acc + (sg[1] - sg[0]), 0);
            if (!coherent(p)) {
                delete n.segments;
                n.loopStart = 0;
                n.loopEnd = 0;
                console.log('[MockBackend] cleared pre-Q map on', n.id);
            }
        } else {
            const ls = n.loopStart || 0, le = n.loopEnd || 0;
            const fullSpanClip = n.type === 'clip' && ls <= 0 &&
                (n.duration || 0) > 0 && le >= n.duration;
            if (le > ls && !fullSpanClip && !coherent(le - ls)) {
                n.loopStart = 0;
                n.loopEnd = 0;
                console.log('[MockBackend] cleared pre-Q window on', n.id);
            }
        }
        if (n.type === 'stack') visit(n.nodes);
    });
    visit(state.nodes);
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

    // Commit resets geometry whole: no stale multi-segment map may
    // outlive the material it selected. COMMIT STORES (origin, duration)
    // ONLY (engine parity, audit D4-7): no window is authored on a take
    // — a take is its whole content unless trimmed.
    delete node.segments;
    node.duration = duration;
    node.isPlaying = true;
    node.loopStart = 0;
    node.loopEnd = 0;

    // First committed take ESTABLISHES Q (design_language.md Q1: the DNA
    // of the scratch track) — STORED island state, plus the per-node
    // effectiveQuantum declaration (computeEffectiveQuantum's fallback
    // derivation reads it).
    const establishing = Q <= 0 && duration > 0;
    if (establishing) {
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

    // Commit epoch re-base (mirrors StackNode::takeCommitted): when
    // the cycle GREW, the epoch moves to the HEARD
    // top the take was performed against — its (folded) origin floored
    // to whole pre-take INTRINSIC cycles. Phase-neutral for every
    // committed lane; the frame the user watched while recording
    // persists at commit.
    // THE SONG RIDES THE EPOCH (engine parity, StackNode::takeCommitted):
    // an active root sequence joins both sides of the growth comparison,
    // so re-bases happen in whole songs or not at all.
    let newCycle = committedCycle(effectiveQuantumForState());
    let before = recView.lcmBefore;
    {
        const seqLen = activeSeqLen({ sequence: state.rootSequence,
                                      sequenceBypassed: state.rootSequenceBypassed });
        if (seqLen > 0 && before > 0) {
            before = lcm(before, seqLen);
            newCycle = lcm(newCycle, seqLen);
        }
    }
    if (before > 0 && newCycle > before && duration > 0) {
        const rel = Math.max(0, foldedOrigin - state.islandEpoch);
        state.islandEpoch = state.islandEpoch +
            Math.floor(rel / before) * before;
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
    // First commit: (Q, epoch) establish TOGETHER (engine parity
    // establishIsland(d, origin)) — the epoch is the first take's
    // origin, not whatever the arm left behind.
    if (establishing) {
        state.islandEpoch = foldedOrigin;
        scrubIncoherentGeometry(state.islandQ);
    }
    // Q18 (engine parity reconcileTakes → settleAnchors): the first
    // content under a stack anchors it — a group take anchors its group
    // at the take's origin, and every unanchored ancestor up to the
    // root. Rides the take's undo entry (the pending snapshot predates
    // it, so Untake un-anchors).
    settleAnchors();

    console.log(`[MockBackend] Committed ${node.id}: Dur=${duration} (Q=${Q})`);
    reconcileTakes();
}

// Grow recording clips by a given sample count. An AWAITING-STOP clip
// commits the moment its length reaches the boundary (engine parity:
// ClipNode's awaiting_stop_at crossing check).
export function growRecordingClips(nodes, samples) {
    (nodes || []).forEach(node => {
        if (node.isRecording && node._retake) {
            // A NEW TAKE: the slot's duration stands; the capture count
            // runs from the slot top to exactly one period (the cap).
            if (node.isPendingStart) {
                if (state.masterPos >= node.pendingStartAt) {
                    node.isPendingStart = false;
                    node.recordingStartPos = node.pendingStartAt;
                    node._retake.captured = state.masterPos - node.pendingStartAt;
                    node.currentPeak = 0.3 + Math.random() * 0.4;
                }
            } else {
                node._retake.captured += samples;
                node.currentPeak = 0.3 + Math.random() * 0.4;
            }
            if (!node.isPendingStart && node._retake &&
                node._retake.captured >= node._retake.period) {
                commitRetake(node);
            }
        } else if (node.isRecording) {
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
