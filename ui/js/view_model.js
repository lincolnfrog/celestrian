/**
 * View Model (docs/ui_overhaul.md §4 — P2-10)
 *
 * deriveViewModel(state) : backend graph state → pure view model.
 *
 * THE FRAME RULE: everything here is in Q units (floats), in the island
 * epoch frame. There are no pixels in this file — the single Q→px scale
 * lives in the patch layer, which makes I2 (simultaneity ⇔ same x) a
 * property of the architecture instead of a property to test per-feature,
 * and I8 (one clock) literal: the model carries exactly one playheadQ.
 *
 * Uses timeline_model.js for all timing math (LCM/quantum); anything
 * cyclic here mirrors design_language.md canon:
 *   - reps tile the cycle at  q ≡ originQ (mod periodQ)   (kernel origins)
 *   - A WINDOW SETS THE PART'S LENGTH (owner ruling 2026-08-21, groups
 *     exactly as clips — I5): a lane's default material is what is
 *     HEARD (the window's content, tiled at the window length), its
 *     chip and its contribution to every cycle (frame, transport,
 *     "+ step") are the effective period — the engine's
 *     getEffectivePeriod, mirrored. The raw take is one grab away (the
 *     edit view). This reverses the 2026-07-11 "windows never reframe"
 *     ruling, whose real concern (hidden content) the edit view answers.
 *   - the arm target is the next Q boundary in the epoch frame (Q11)
 *   - arming a group arms every child (Q7 group-arm ruling)
 */

import {
    lcm, calculateStackLCM, commensuratePeriod, computeEffectiveQuantum,
    nextStopBoundary, timelineLcm, stackEffectivePeriod, isAuditionWindow,
} from './timeline_model.js';
import { posMod } from './math_utils.js';
import { assessBlowup, assessDrift, lcmAll } from './frame_health.js';
import { flatSegPeriod } from './time_map.js';

// Q-space float tolerance for exact-position comparisons (tile identity,
// boundary snaps). Q values are small integers/rationals, so 1e-9 sits
// far below any real musical distinction and far above accumulated fp
// noise from the divisions in this file.
const EPS = 1e-9;

// Degenerate-frame guard: a frame where cycle/period exceeds this must
// never explode into thousands of tiles (e.g. Q not yet established).
// Shared by unrollReps (mirrored by computeGhostTiles in px space) and
// the take-phase scan in the heard-clip lane builder.
const MAX_TILES = 256;

/**
 * A node's INTRINSIC period in samples — the extent of its raw
 * material, the domain its own window selects over: a clip's buffer; a
 * stack's INNER cycle (the LCM of its children's EFFECTIVE periods —
 * a windowed or sequenced child counts as its part, sequencer.md §11.7).
 */
function intrinsicPeriod(node, quantum) {
    if (node.type !== 'stack') return node.duration || 0;
    // ONE TAKE (the group-recorded kit, the Q13 definer stack): the
    // children share one raw duration, so the inner cycle IS that
    // duration — exactly, never commensurate-rounded. The rounding in
    // calculateStackLCM protects a locked frame from an incommensurate
    // buffer; applied to the definer's own extent it grew the trim view
    // by ceil(D/Q)·Q on every sub-Q drag ("it suddenly zooms way in…
    // moving both ends chaotically", field 2026-08-21).
    const take = oneTakeDuration(node);
    if (take > 0) return take;
    return calculateStackLCM(node.nodes, quantum);
}

/** The shared raw duration of a stack's committed clip children when
 * they are ONE take (same duration, no nested content); 0 otherwise. */
export function oneTakeDuration(stack) {
    let d = 0;
    for (const c of stack.nodes || []) {
        if (c.type === 'stack') {
            if (subtreeHasCommitted(c)) return 0;
            continue;
        }
        if (c.type !== 'clip' || c.isRecording || !(c.duration > 0)) continue;
        if (c.periodSource === 'context') return 0;
        if (d === 0) d = c.duration;
        else if (c.duration !== d) return 0;
    }
    return d;
}

/** A node's intrinsic period in Q units (intrinsicPeriod ÷ quantum). */
function intrinsicPeriodQ(node, quantum) {
    return intrinsicPeriod(node, quantum) / quantum;
}

/**
 * Loop window descriptor for a node, or null if there is no window
 * WORTH SHOWING: an invalid window, or the default full-span window
 * ([0, period)) which restricts nothing — commit sets loopEnd=duration
 * on every clip, and drawing brackets on that default is pure noise
 * (and reads as a misalignment at the lane's left edge).
 */
function windowOf(node, quantum) {
    const len = (node.loopEnd || 0) - (node.loopStart || 0);
    if (len <= 0) return null;
    const period = intrinsicPeriod(node, quantum);
    if ((node.loopStart || 0) <= 0 && node.loopEnd >= period) return null;
    return {
        startQ: node.loopStart / quantum,
        endQ: node.loopEnd / quantum,
        bypassed: !!node.loopBypassed,
        active: !!node.windowActive,
        // S16 (docs/sequencer.md §11.8): authored over a sequence that
        // is now off — drawn dimmed with a chip saying why.
        suspended: !!node.windowSuspended,
    };
}

/**
 * The node's MAP descriptor (phase 3) — a superset of windowOf's shape:
 * a multi-segment override (metadata `segments`, flat samples) yields
 * { segs: [[sQ,eQ],...], periodQ, multi: true, startQ/endQ = outer
 * bounds }; else the single window with segs/periodQ derived. Null when
 * nothing worth showing.
 */
function mapOf(node, quantum) {
    if (node.segments && node.segments.length >= 4) {
        const segs = [];
        for (let i = 0; i + 1 < node.segments.length; i += 2) {
            segs.push([node.segments[i] / quantum, node.segments[i + 1] / quantum]);
        }
        return {
            segs,
            // ONE division of the SAMPLE sum — summing per-segment Q
            // fractions leaked fp noise into labels ("0.9999…Q" for an
            // exactly-1Q map; field 2026-07-25).
            periodQ: flatSegPeriod(node.segments) / quantum,
            multi: true,
            startQ: segs[0][0],
            endQ: segs[segs.length - 1][1],
            bypassed: !!node.loopBypassed,
            active: !!node.windowActive,
            suspended: !!node.windowSuspended,
        };
    }
    const win = windowOf(node, quantum);
    return win
        ? Object.assign({ segs: [[win.startQ, win.endQ]],
                          periodQ: win.endQ - win.startQ, multi: false }, win)
        : null;
}

/**
 * A lane's DISPLAY period in Q — its EFFECTIVE period, the same value
 * the engine's getEffectivePeriod hands the parent (the 2026-08-21
 * ruling: a window sets the part's length, for groups as for clips):
 * an active window's length; else a stack's active sequence (the
 * period law, sequencer.md §2); else the intrinsic period. The lane's
 * material tiles at this period and its chip reads it — the one white
 * cursor is honest on every lane because the frame IS the audible
 * cycle. Recording lanes have no settled period yet and return 0
 * (excluded from the cycle, matching calculateStackLCM).
 */
function displayPeriodQ(node, quantum) {
    if (node.isRecording) return 0;
    if (node.windowActive && !isAuditionWindow(node)) {
        const p = nodeMapPeriod(node);
        if (p > 0 && (node.type === 'stack' || p < (node.duration || 0))) {
            return p / quantum;
        }
    }
    if (node.type === 'stack') {
        const seqLen = activeSeqSamples(node);
        if (seqLen > 0) return seqLen / quantum;
    }
    return intrinsicPeriodQ(node, quantum);
}

/**
 * Unroll a lane across the cycle: tiles at q ≡ offsetQ (mod periodQ),
 * clipped to [0, cycleQ). Exactly one unclipped tile is the take
 * (ghost: false); clipped pieces are marked wrapped. Q-unit exact —
 * no pixel tolerances (computeGhostTiles is the px-space equivalent).
 *
 * @param {Object} opts
 * @param {number} opts.periodQ   tile period in Q
 * @param {number} opts.offsetQ   tiling-grid phase in Q (epoch-relative)
 * @param {number} opts.cycleQ    display frame length in Q
 * @param {number} [opts.takeQ]   performed cycle position of the take
 * @param {number} [opts.maxTiles=MAX_TILES] degenerate-frame guard
 * @returns {Array<{startQ: number, endQ: number, ghost: boolean, wrapped: boolean}>}
 */
export function unrollReps({ periodQ, offsetQ, cycleQ, takeQ, maxTiles = MAX_TILES }) {
    if (periodQ <= 0 || cycleQ <= 0) return [];
    // Safety net: a degenerate frame (e.g. Q not yet established) must
    // never explode into thousands of tiles (mirrors computeGhostTiles)
    if (cycleQ / periodQ > maxTiles) return [];
    const reps = [];
    // The tiling grid runs at q ≡ offsetQ (mod periodQ) — NEVER derived
    // through the frame: an extended recording frame is not a multiple
    // of every period, and routing the phase through mod-frame breaks
    // tile alignment (found by the take-anchored frame tests).
    const first = posMod(offsetQ, periodQ);
    // Take marking (owner ruling 2026-07-10 + refinement 2026-07-16):
    // whole CYCLES never matter ("it doesn't matter how many times I
    // let clip 1 loop before recording clip 2"), but the performed
    // PHASE within the cycle does ("clip 3 recorded at 2Q must anchor
    // 2Q→4Q, not jump to 0Q" — folding by the clip's own period erased
    // it, since a 2Q loop at 2Q sounds identical to one at 0Q). Callers
    // pass takeQ = the performed cycle position for takes made in the
    // current epoch era; without it (pre-epoch takes, groups) the take
    // is the first full repetition.
    let takeStart = first;
    if (takeQ !== undefined && takeQ >= 0 && takeQ < cycleQ) {
        // Snap onto this lane's tile grid — exact when the committed
        // cycle is a multiple of the period (it always is); the round
        // guards float drift for fractional-Q periods.
        const snapped = first + Math.round((takeQ - first) / periodQ) * periodQ;
        if (snapped >= 0 && snapped < cycleQ) takeStart = snapped;
    }
    // Walk tile starts from the (possibly negative) wrapped predecessor
    for (let s = first - periodQ; s < cycleQ; s += periodQ) {
        const startQ = Math.max(0, s);
        const endQ = Math.min(cycleQ, s + periodQ);
        if (endQ <= startQ) continue;
        reps.push({
            startQ,
            endQ,
            ghost: Math.abs(s - takeStart) > EPS,
            wrapped: startQ !== s || endQ !== s + periodQ,
        });
    }
    return reps;
}

/**
 * Bracket-drag edit math (docs/ui_overhaul.md §2 "loop windows live on
 * the lane"): pure Q-space snap/clamp for one window edge. The pointer's
 * raw Q snaps to the NEAREST whole Q (grid honesty: windows are Q-snapped
 * by the editor, per the time_maps.md cell-mode UX ruling), then clamps
 * so the window keeps at least 1Q and stays inside the lane's intrinsic
 * period [0, maxQ]. Returns the full { startQ, endQ } after the edit.
 */
export function windowDragTarget({ edge, rawQ, startQ, endQ, maxQ }) {
    const q = Math.round(rawQ);
    if (edge === 'start') {
        return { startQ: Math.min(Math.max(0, q), endQ - 1), endQ };
    }
    return { startQ, endQ: Math.max(Math.min(maxQ, q), startQ + 1) };
}

/**
 * Arm targets emptiness (Q7 refinement): a clip with content cannot be
 * re-recorded (no overdub by design) — group record captures the empty
 * clips and just plays the full ones.
 */
function isArmable(clip) {
    return clip.isRecording || clip.isPendingStart || !(clip.duration > 0);
}

/**
 * Aggregate arm state over a group's ARMABLE clip descendants:
 * { state: 'all'|'some'|'none', armable: count }. armable === 0 means
 * the rail's group-arm control has nothing to do (disable it).
 */
function groupArmState(node) {
    let armed = 0, armable = 0;
    const visit = n => (n.nodes || []).forEach(c => {
        if (c.type === 'clip') {
            if (!isArmable(c)) return;
            armable++;
            if (c.isPendingStart || c.isRecording) armed++;
        } else if (c.type === 'stack') visit(c);
    });
    visit(node);
    const state = armed === 0 ? 'none' : armed === armable ? 'all' : 'some';
    return { state, armable };
}

/**
 * The fields shared by every rendered lane row, read straight off the
 * published node. Every lane builder spreads this into its row.
 *
 * @param {Object} node   engine-published node (clip or stack)
 * @param {Object} state  full graph state (unused here since Q16)
 * @returns {{
 *   id: string,            //  node id
 *   name: string,          //  display name (falls back to id)
 *   muted: boolean,
 *   soloed: boolean,       //  per-node isSoloed (Q16: additive flags)
 *   recording: boolean,
 *   awaitingStop: boolean, //  stop requested; engine pads to boundary
 *   armed: boolean,        //  pending start or already recording
 *   effects: ?Object,      //  built-in fx rack state (null if absent)
 *   fxCount: number,       //  enabled fx, for the rail chip
 *   pan: number,           //  −1..+1 (0 = center)
 *   gain: number,          //  fader 0..1 (1 = unity)
 *   oneShot: boolean,      //  Q5 period-source knob (context = one-shot)
 *   inputChannelR: number, //  right input of a stereo pair (−1 = mono)
 *   channels: number,      //  content channel count for the lane badge
 *   hasInstrument: boolean, // chain carries an instrument slot (♪ toggle)
 *   midiArmed: boolean,    //  THE live MIDI target (single-armed)
 *   isMidi: boolean,       //  MIDI track: records notes, no audio input
 * }}
 */
function laneCommon(node, state) {
    return {
        id: node.id,
        name: node.name || node.id,
        muted: !!node.isMuted,
        // Solo canon (Q16): island-wide, ADDITIVE, fractal — the engine
        // publishes a per-node flag (multiple lanes may be lit at once;
        // the old single top-level soloedId is gone).
        soloed: !!node.isSoloed,
        recording: !!node.isRecording,
        // Stop requested; the engine records on to the next boundary
        // (owner ruling 2026-07-10: stops always pad forward)
        awaitingStop: !!node.isAwaitingStop,
        armed: !!(node.isPendingStart || node.isRecording),
        // Effect chain state (published on every node as {chain,
        // scope?} — docs/vst3.md phase 2) + the enabled count for the
        // rail's fx chip
        effects: node.effects || null,
        fxCount: node.effects && Array.isArray(node.effects.chain)
            ? node.effects.chain.filter(s => s.enabled).length
            : 0,
        // MIDI (docs/vst3.md §8): the rail's arm affordance appears
        // only when the chain carries an instrument slot.
        hasInstrument: !!(node.effects && Array.isArray(node.effects.chain) &&
            node.effects.chain.some(s => s.isInstrument)),
        midiArmed: !!node.midiArmed,
        // Content kind (phase 5): a MIDI track records notes from the
        // keyboard into its instrument — the audio-input picker is
        // meaningless on it. Published by the backend as contentKind:
        // 'midi' for a note take, or an empty clip whose chain carries
        // an instrument (its next take records notes).
        isMidi: node.contentKind === 'midi',
        // Mixer facts (published on every node): pan/balance −1..+1 and
        // the volume fader 0..1 (absent = unity — pre-gain states);
        // clips also carry their stereo wiring (right input of a pair,
        // −1 = mono) and content channel count for the lane badge.
        pan: typeof node.pan === 'number' ? node.pan : 0,
        gain: typeof node.gain === 'number' ? node.gain : 1,
        // The Q5 period-source knob: true = one-shot (sounds once per
        // context cycle; dashed tile, no ghost repetitions).
        oneShot: node.periodSource === 'context',
        inputChannelR: node.inputChannelR ?? -1,
        channels: node.channels ?? 1,
    };
}

/**
 * The effects PANEL row for a lane whose chain is expanded (view state:
 * opts.fxOpen). A synthetic row like the 'add' affordance — the panel
 * itself renders from the owner lane's published effects.
 */
function fxRow(node, depth) {
    return {
        kind: 'fx',
        id: 'fx:' + node.id,
        ownerId: node.id,
        name: '',
        depth,
        effects: node.effects || null,
    };
}

/**
 * The SEQUENCER GRID row for a stack whose sequence panel is expanded
 * (view state: opts.seqOpen — the fx-row pattern; docs/sequencer.md
 * §9 S15: the pad grid is the ONE control, at every depth). Rows =
 * the stack's direct children, columns = steps, pads = gates.
 */
function buildSeqRow({ holder, ownerId, children, depth, quantum,
                       qEstablished, innerCycleQ, editable }) {
    const s = seqOf(holder);
    const steps = s ? s.steps.map(st => ({
        name: st.name || '',
        lenQ: (st.len > 0 ? Math.round(st.len) : 0) / quantum,
    })) : [];
    return {
        kind: 'seq',
        id: 'seq:' + ownerId,
        ownerId,
        name: '',
        depth,
        bypassed: !!(s && s.bypassed),
        steps,
        totalQ: steps.reduce((t, x) => t + x.lenQ, 0),
        // The step audition (§11.2): which step loops, −1 = none.
        auditionStep: auditionStepOf(s),
        // The append/creation default: one inner cycle (S2 —
        // cycle-multiple snapping is the default concept).
        innerCycleQ: Math.max(1, Math.round(innerCycleQ)),
        qEstablished,
        // The mid-take gate, surfaced so the grid disables itself while
        // a take records in this subtree (the engine refuses anyway).
        editable,
        children: (children || []).map(c => ({
            id: c.id,
            name: c.name || '',
            kind: c.type === 'stack' ? 'group' : 'clip',
            // Absent uuid = inherit ON (engine parity).
            gates: steps.map((_, i) => {
                const row = s && s.gates && s.gates[c.id];
                return row ? !!row[i] : true;
            }),
        })),
    };
}

function seqRow(node, depth, quantum, qEstablished) {
    return buildSeqRow({
        holder: node,
        ownerId: node.id,
        children: node.nodes,
        depth,
        quantum,
        qEstablished,
        innerCycleQ: intrinsicPeriodQ(node, quantum),
        editable: !subtreeRec(node),
    });
}

/**
 * Post-pass: project a stack's ACTIVE sequence onto the lanes of its
 * children (docs/sequencer.md §9 — the lanes are the DISPLAY, the grid
 * is the editor): each direct child's gated-OFF spans become dim
 * overlays (`seqDims`), applied to the child's whole subtree span
 * (gates are fractal). Lanes tile the spans every seq period.
 */
function attachSeqDims(lanes, from, to, children, seq, quantum) {
    const stepsQ = seq.steps.map(
        st => (st.len > 0 ? Math.round(st.len) : 0) / quantum);
    const totalQ = stepsQ.reduce((a, b) => a + b, 0);
    if (!(totalQ > 0)) return;
    const childIds = new Set((children || []).map(c => c.id));
    let offSegs = null;  // the CURRENT direct child's off spans
    for (let i = from; i < to; i++) {
        const lane = lanes[i];
        if (childIds.has(lane.id)) {
            const bits = seq.gates ? seq.gates[lane.id] : null;
            offSegs = [];
            let pos = 0, runStart = null;
            stepsQ.forEach((lenQ, k) => {
                const on = bits ? !!bits[k] : true;
                if (!on && runStart === null) runStart = pos;
                if (on && runStart !== null) {
                    offSegs.push([runStart, pos]);
                    runStart = null;
                }
                pos += lenQ;
            });
            if (runStart !== null) offSegs.push([runStart, totalQ]);
            if (!offSegs.length) offSegs = null;
        }
        if (offSegs && (lane.kind === 'clip' || lane.kind === 'group')) {
            // LAYERS compose (§12.2): inner scopes attach first (during
            // the recursion), outer scopes after — prepend so the list
            // reads outermost first. A lane is silent where ANY
            // enclosing sequence silences it (the fractal gate).
            lane.seqDims = [{ periodQ: totalQ, offSegsQ: offSegs },
                            ...(lane.seqDims || [])];
        }
    }
}

/**
 * THE FRAME-HEALTH BADGE (docs/sequencer.md §11.6) — post-pass, VM-pure
 * projection over the built lanes. For every scope (root + each group):
 * the BLOWUP face marks the RESPONSIBLE child's lane (`lane.health`) and,
 * when that child is a sequenced stack, its grid row (`row.health.blowup`
 * with the snap offer); the DRIFT face marks sequenced stacks' rows and
 * chips (`row.health.drift`, `lane.seq.drift`). Grid rows also learn
 * their parent-scope facts (`parentOthersQ` / `parentLargestQ`) so the
 * grip can warn LIVE while a step is dragged.
 */
function scopeMembers(children, quantum) {
    return (children || []).map(c => ({
        id: c.id,
        periodQ: effectivePeriod(c) / quantum,
        knob: c.type === 'stack' && activeSeqSamples(c) > 0 ? 'sequence'
            : (c.windowActive ? 'window' : null),
    })).filter(m => m.periodQ > 0);
}

function attachFrameHealth(lanes, state, nodes, quantum, qEstablished) {
    if (!qEstablished) return;
    const byId = new Map();
    lanes.forEach(l => { if (l.kind === 'clip' || l.kind === 'group') byId.set(l.id, l); });
    const rowOf = new Map();
    lanes.forEach(l => { if (l.kind === 'seq') rowOf.set(l.ownerId, l); });

    const visitScope = (ownerId, holder, children) => {
        const members = scopeMembers(children, quantum);
        const blow = assessBlowup(members, 1);
        if (blow) {
            const lane = byId.get(blow.responsibleId);
            if (lane) lane.health = { ...blow, scopeId: ownerId };
            const row = rowOf.get(blow.responsibleId);
            if (row) row.health = { ...(row.health || {}), blowup: { ...blow, scopeId: ownerId } };
        }
        // Every sequenced child row learns its parent-scope facts.
        members.forEach(m => {
            const row = rowOf.get(m.id);
            if (!row) return;
            row.parentOthersQ = lcmAll(members.filter(x => x !== m).map(x => x.periodQ), 1);
            row.parentLargestQ = Math.max(0, ...members.filter(x => x !== m).map(x => x.periodQ));
        });
        // The DRIFT face for THIS scope's own sequence.
        const s = seqOf(holder);
        if (s && !s.bypassed) {
            const innerQ = lcmAll(members.map(m => m.periodQ), 1);
            const drift = assessDrift(seqTotalSamples(s) / quantum, innerQ);
            if (drift) {
                const row = rowOf.get(ownerId);
                if (row) row.health = { ...(row.health || {}), drift };
                const lane = byId.get(ownerId);
                if (lane && lane.seq) lane.seq.drift = drift;
            }
        }
        (children || []).forEach(c => {
            if (c.type === 'stack') visitScope(c.id, c, c.nodes);
        });
    };
    visitScope(state.id || '', state, nodes);
}

/**
 * The cycle a scope's children HEAR (engine parity, StackNode::
 * childContext context_cycle): the song when the scope is sequenced;
 * else the lcm of its looping members' effective periods; else the
 * enclosing scope's cycle (an all-one-shot group fires once per the
 * outer cycle). In Q.
 */
function scopeCycleQOf(holder, quantum, inheritedQ) {
    const seqLen = activeSeqSamples(holder);
    if (seqLen > 0) return seqLen / quantum;
    const members = scopeMembers(holder.nodes, quantum)
        .filter(m => m.periodQ > 0);
    const inner = lcmAll(members.map(m => m.periodQ), 1);
    return inner > 0 ? inner : (inheritedQ || 0);
}

/** A live take anywhere below (drives the group lane's map cue). */
function subtreeRec(n) {
    return (n.nodes || []).some(c => c.isRecording || subtreeRec(c));
}

/**
 * The island quantum for a state.
 *
 * The island quantum is a STORED fact published top-level by the
 * engine (P0-3 — the root stack's `quantum` metadata; the mock
 * mirrors it). Prefer it; min-over-nodes derivation survives only
 * as a fallback for states that predate the field (old fixtures).
 *
 * @param {Object} state  graph state (state.quantum preferred)
 * @param {Array} nodes   top-level nodes (fallback derivation)
 * @returns {number} quantum in samples (1 = not established)
 */
function resolveQuantum(state, nodes) {
    return state.quantum > 1
        ? state.quantum : computeEffectiveQuantum(nodes);
}

/**
 * ONE depth-first pass over the tree collecting every whole-tree fact
 * deriveViewModel needs (previously four separate recursive walkers).
 *
 * @param {Array} nodes  top-level nodes
 * @returns {{
 *   committedClips: Array<Object>,  // clips, not recording, with content
 *   anyRecording: boolean,          // a live take exists anywhere
 *   anyTakeActive: boolean,         // recording OR armed (isPendingStart)
 *   maxRecordingDuration: number,   // longest live take (samples)
 * }}
 */
function collectTreeFacts(nodes) {
    const committedClips = [];
    let anyRecording = false;
    let anyPending = false;
    let maxRecordingDuration = 0;
    const visit = ns => (ns || []).forEach(n => {
        if (n.type === 'clip' && !n.isRecording && (n.duration || 0) > 0) {
            committedClips.push(n);
        }
        if (n.isRecording) {
            anyRecording = true;
            if (n.duration > maxRecordingDuration) maxRecordingDuration = n.duration;
        }
        if (n.isPendingStart) anyPending = true;
        if (n.nodes) visit(n.nodes);
    });
    visit(nodes);
    return {
        committedClips,
        anyRecording,
        anyTakeActive: anyRecording || anyPending,
        maxRecordingDuration,
    };
}

/**
 * Q13 provisional mutability: Q is re-establishable while the island's
 * only committed content is ONE clip (the Q-definer). Its loop handles
 * re-establish (Q, epoch); once a 2nd take commits, Q locks. Surface
 * the sole definer so the rail can render draggable "sets tempo"
 * handles even at full span (which windowOf normally suppresses).
 *
 * While the Q-definer is provisional AND idle (nothing armed or
 * recording), it renders its FULL recorded buffer with the loop
 * region drawn as a SELECTION overlay (dead air dimmed but visible)
 * — so dragging the handles moves the selection over a stable
 * waveform while Q/epoch update live underneath, rather than
 * reframing to the selection and dropping the rest of the clip. The
 * moment a second take ARMS, the engine LOCK-COLLAPSES the definer
 * (its window becomes the take — owner ruling 2026-07-19), so the
 * trim view ends at arm, not at commit: the armed gate here matches
 * the engine's hasActiveTake re-trim refusal.
 *
 * @param {Array<Object>} committedClips  from collectTreeFacts
 * @param {boolean} anyTakeActive         from collectTreeFacts
 * @param {number} quantum                island quantum (samples)
 * @returns {{
 *   soleQDefinerId: ?string,      // the sole committed clip, or null
 *   provisionalDefiner: boolean,  // trim view is live
 *   definerNode: ?Object,         // the definer node when provisional
 *   defSelStartQ: number,         // selection start (Q)
 *   defSelEndQ: number,           // selection end (Q)
 * }}
 */
function resolveProvisionalDefiner(committedClips, anyTakeActive, quantum,
                                   nodes) {
    // The sole clip, or — Q13 FOR GROUPS (owner ruling 2026-08-21,
    // the fractal twin) — the DEFINER STACK: the stack whose direct
    // clip children are the island's only committed content, recorded
    // as one take (N mics). Engine parity: AudioEngine definerStack.
    const definer = committedClips.length === 1 ? committedClips[0]
        : committedClips.length >= 2 ? definerStackOf(nodes) : null;
    const soleQDefinerId = definer ? definer.id : null;
    // The window must not be BYPASSED for the trim view: a bypassed
    // window plays the full take, so the selection isn't the audible
    // loop and the mapping below would lie. (The definer chip offers no
    // bypass toggle, so this only guards imported/odd states.)
    const provisionalDefiner = !!definer && !anyTakeActive &&
        !definer.loopBypassed;
    const definerNode = provisionalDefiner ? definer : null;
    // The definer's selection in Q units (Q = selection length, so the
    // selection is exactly 1Q wide and starts at loopStart/quantum).
    // The engine commits every clip with loop [0, duration); a fixture
    // without loop points means the same thing — the whole buffer (a
    // stack's: its inner cycle).
    const defHasSel = !!definerNode && definerNode.loopEnd > definerNode.loopStart;
    const defSelStartQ = defHasSel ? definerNode.loopStart / quantum : 0;
    const defSelEndQ = !definerNode ? 0
        : defHasSel ? definerNode.loopEnd / quantum
            : intrinsicPeriodQ(definerNode, quantum);
    return { soleQDefinerId, provisionalDefiner, definerNode,
             defSelStartQ, defSelEndQ };
}

/** The island's definer stack (see resolveProvisionalDefiner), walking
 * from the top-level list: the one stack holding every committed clip
 * as a direct child, all one take (same origin + duration), ≥ 2 of
 * them. Null otherwise. */
function definerStackOf(nodes, owner = null) {
    let direct = 0, origin = 0, duration = 0, nested = null;
    for (const n of nodes || []) {
        if (n.type === 'clip') {
            if (n.isRecording || !(n.duration > 0)) continue;
            if (direct === 0) { origin = n.origin || 0; duration = n.duration; }
            else if ((n.origin || 0) !== origin || n.duration !== duration) return null;
            direct++;
        } else if (n.type === 'stack' && subtreeHasCommitted(n)) {
            if (nested || direct > 0) return null;
            nested = n;
        }
    }
    if (nested) return direct === 0 ? definerStackOf(nested.nodes, nested) : null;
    return direct >= 2 ? owner : null;
}

function subtreeHasCommitted(n) {
    return (n.nodes || []).some(c =>
        (c.type === 'clip' && !c.isRecording && c.duration > 0) ||
        (c.type === 'stack' && subtreeHasCommitted(c)));
}

/**
 * A node's ACTIVE map period in SAMPLES (segments override first,
 * then the single window; 0 = no map). The frame/audible math must
 * read THIS, not the raw loop atomics — a multi-segment override
 * leaves the atomics stale (field 2026-07-23: the frame stayed 4Q
 * while the engine wrapped at the 3Q cell period, so the cursor
 * swept 3Q of a 4Q ruler and the next rep leaked into the phantom
 * quarter).
 */
function nodeMapPeriod(n) {
    if (n.loopBypassed) return 0;
    if (n.segments && n.segments.length >= 4) {
        return flatSegPeriod(n.segments);
    }
    const d = n.duration || 0;
    const ls = n.loopStart || 0;
    const le = n.type === 'stack' ? (n.loopEnd || 0)
                                  : Math.min(n.loopEnd || 0, d);
    return le > ls ? le - ls : 0;
}

/**
 * A top-level clip's contribution (samples) to the island cycle.
 *
 * LAW 13 AMENDED (2026-07-19k): a clip's ACTIVE map IS its
 * displayed material (heard view), so it contributes the map
 * period — the display frame equals the audible loop and the
 * one cursor is honest everywhere. (Law 13's original concern —
 * hidden content — is answered by the expand-to-edit view.)
 */
function clipCycleContribution(n, quantum) {
    const d = n.duration || 0;
    const p = nodeMapPeriod(n);
    if (p > 0 && p < d) return Math.round(p);
    return commensuratePeriod(n, quantum);
}

/**
 * Island cycle in samples: LCM over the top-level EFFECTIVE periods —
 * the JS twin of the engine's calculateEffectiveCycleLength, so the
 * display frame IS the audible cycle (the 2026-08-21 ruling; before it
 * the frame was intrinsic and the cursor swept material the island
 * never played). A stack contributes stackEffectivePeriod (window,
 * else sequence — the period law, steps concatenate, never LCM — else
 * its inner LCM); a clip its map period or commensurate duration.
 * Clip contributions are COMMENSURATE (timeline_model.commensuratePeriod):
 * a Q13-trimmed definer's raw buffer length is a multiple of the OLD Q
 * — LCM-ing it exploded the frame to ~142336Q the moment take 2 armed
 * (waveforms vanished behind the maxTiles guards; field 2026-07-19b).
 * The lane still RENDERS its true fractional extent (intrinsicQ) —
 * only the shared frame math sees the whole-Q contribution.
 *
 * @param {Array} nodes    top-level nodes
 * @param {number} quantum island quantum (samples)
 * @returns {number} cycle length in samples (≥ quantum)
 */
function computeCycleSamples(nodes, quantum, { audible = false } = {}) {
    const periods = [];
    nodes.forEach(n => {
        if (n.isRecording) return;
        if (n.periodSource === 'context') return;  // Q5: one-shots excluded
        periods.push(n.type === 'stack'
            ? stackEffectivePeriod(n, quantum, { audible })
            : clipCycleContribution(n, quantum));
    });
    return timelineLcm(periods, quantum);
}

/** The published sequence of a holder (a stack node, or the state for
 * the island root), normalized; null when absent/empty. */
function seqOf(holder) {
    const s = holder && holder.sequence;
    if (!s || !Array.isArray(s.steps) || !s.steps.length) return null;
    return s;
}

/** The published step audition index of a sequence (−1 = none). */
function auditionStepOf(s) {
    const i = s && Number.isInteger(s.auditionStep) ? s.auditionStep : -1;
    return i >= 0 && s && i < s.steps.length ? i : -1;
}

/** Total sequence length in samples (steps CONCATENATE — S10). */
function seqTotalSamples(s) {
    return s.steps.reduce((t, x) => t + (x.len > 0 ? Math.round(x.len) : 0), 0);
}

/** The ACTIVE sequence length in samples (0 = none/bypassed). */
function activeSeqSamples(holder) {
    const s = seqOf(holder);
    return s && !s.bypassed ? seqTotalSamples(s) : 0;
}

/**
 * A node's EFFECTIVE period in samples for the frame-health scan
 * (recursive; mirrors the engine's effective-cycle walk): an active
 * map shortens it, an active SEQUENCE sets a stack's period to the
 * song (the period law, docs/sequencer.md §2), one-shots and recording
 * lanes contribute nothing, and a stack composites its children's
 * effective periods by LCM. Raw (un-commensurate) durations on
 * purpose: the health faces reason about true ratios.
 */
function effectivePeriod(node) {
    if (node.isRecording) return 0;
    if (node.periodSource === 'context') return 0;  // Q5 exclusion
    const p = node.windowActive ? nodeMapPeriod(node) : 0;
    if (p > 0) return p;
    const seqLen = activeSeqSamples(node);
    if (seqLen > 0) return seqLen;
    if (node.type !== 'stack') return node.duration || 0;
    let composite = 0;
    (node.nodes || []).forEach(c => {
        const cp = effectivePeriod(c);
        if (cp > 0) composite = composite > 0 ? lcm(Math.round(composite), Math.round(cp)) : cp;
    });
    return composite;
}

/**
 * GROWING FRAME, PHASE-PRESERVING: while recording, the frame shifts
 * by WHOLE CYCLES to the cycle the take started in, and extends one
 * whole Q at a time to hold the growing cursor. Whole-cycle shifts
 * keep every committed lane's phase fixed (a raw-Q shift rotated the
 * whole timeline for mid-cycle takes — "the timeline seems to
 * restart", field 2026-07-10) and agree exactly with the engine's
 * commit epoch re-base when a take starts a new cycle top. The take
 * anchor is snapped to a whole Q (Q11), cancelling the pre-record
 * latency wobble baked into live duration (E-E).
 *
 * @param {Object} args { nodes, quantum, qEstablished, anyRecording,
 *                        lcmQ, playheadQ }
 * @returns {{frameQ: number, shiftQ: number, playheadQ: number}}
 */
function computeRecordingFrame({ nodes, quantum, qEstablished, anyRecording,
                                 lcmQ, playheadQ }) {
    let frameQ = lcmQ;
    let shiftQ = 0;
    if (qEstablished && anyRecording && lcmQ > 0) {
        let maxLenQ = 0;
        let allAwaiting = true;
        let settleSamples = 0;
        const scan = ns => (ns || []).forEach(n => {
            if (n.isRecording && n.duration > 0) {
                maxLenQ = Math.max(maxLenQ, n.duration / quantum);
                if (n.isAwaitingStop) {
                    // The commit boundary is KNOWN the moment stop is
                    // requested (same golden math as the engine)
                    settleSamples = Math.max(settleSamples,
                        nextStopBoundary(n.duration, quantum));
                } else {
                    allAwaiting = false;
                }
            }
            if (n.nodes) scan(n.nodes);
        });
        scan(nodes);
        if (maxLenQ > 0) {
            const anchorQ = Math.max(0, Math.round(playheadQ - maxLenQ));
            shiftQ = Math.floor(anchorQ / lcmQ) * lcmQ;
            playheadQ = Math.max(0, playheadQ - shiftQ);
            if (allAwaiting && settleSamples > 0) {
                // FINISHING: the frame settles to its FINAL size NOW —
                // extending to ceil(playhead) while the cursor ran past
                // the known commit boundary made room for a Q the take
                // never uses, then snapped back at commit (the layout
                // stretch/squish, field before/after 2026-07-10). The
                // playhead clamps at the frame edge for the ≤1 poll
                // before the engine wraps it.
                const settleQ = lcm(Math.round(lcmQ * quantum),
                    Math.round(settleSamples)) / quantum;
                frameQ = Math.max(lcmQ, settleQ);
                playheadQ = Math.min(playheadQ, frameQ);
            } else {
                // Actively recording: extend exactly AT the boundary —
                // the take must never run off-screen
                frameQ = Math.max(lcmQ, Math.ceil(playheadQ - EPS));
            }
        } else {
            // Pure pending (armed, no audio yet): stay in the settled
            // frame — the unwrapped view crossing the arm boundary must
            // not stretch it (stretch-then-squish at record start)
            playheadQ = playheadQ % frameQ;
        }
    }
    return { frameQ, shiftQ, playheadQ };
}

/**
 * FRAME PIN (field 2026-07-23g): while a map gesture is live, the
 * shared frame holds at its drag-start value — live commits change
 * the audible cycle, and letting the frame follow re-scaled the
 * whole timeline under the pointer. Settles on release.
 *
 * @param {Object} args { opts, state, quantum, qEstablished,
 *                        anyRecording, frameQ, loopSamples, playheadQ }
 * @returns {{framePinned: boolean, frameQ: number, loopSamples: number,
 *            playheadQ: number}}
 */
function applyFramePin({ opts, state, quantum, qEstablished, anyRecording,
                         frameQ, loopSamples, playheadQ }) {
    const framePinned = opts.pinFrameQ > 0 && qEstablished && !anyRecording;
    if (framePinned) {
        frameQ = opts.pinFrameQ;
        // CURSOR CONTINUITY THROUGH LIVE COMMITS (field 2026-07-25c):
        // the published masterPos is folded on the CURRENT audible
        // cycle, and every live map commit moves that fold point — the
        // white cursor jumped at each commit. The raw island clock is
        // the invariant; fold it on the fold cycle PINNED at drag start
        // (the audible cycle of that moment — matching the cursor's
        // pre-grab sweep exactly, jumpless at the grab too).
        const foldQ = opts.pinFoldQ > 0
            ? Math.min(opts.pinFoldQ, frameQ) : frameQ;
        if (Number.isFinite(state.islandPos)) {
            const posQ = state.islandPos / quantum;
            playheadQ = posMod(posQ, foldQ);
        }
        // The ANIMATOR wraps on loopCycleQ — pin it with the frame or
        // the 60fps line still folds at every live commit (the readout
        // was continuous while the LINE jumped; owner video
        // 2026-07-25d).
        loopSamples = foldQ * quantum;
    }
    return { framePinned, frameQ, loopSamples, playheadQ };
}

/**
 * Map the ONE playhead (I8) into display coordinates and find the frame
 * origin of the audible loop (loopStartQ).
 *
 * @param {Object} args { playheadQ, frameQ, anyRecording,
 *                        provisionalDefiner, defSelStartQ, qEstablished,
 *                        nodes, quantum, loopSamples }
 * @returns {{playheadQ: number, loopStartQ: number}}
 */
function mapPlayheadToDisplay({ playheadQ, frameQ, anyRecording,
                                provisionalDefiner, defSelStartQ,
                                qEstablished, nodes, quantum, loopSamples }) {
    // Defensive wrap when idle: the contract says idle masterPos arrives
    // pre-wrapped; if a backend ever violates that, fold rather than
    // draw the playhead off the timeline. Never wrap while recording.
    if (!anyRecording && frameQ > 0) playheadQ = playheadQ % frameQ;

    // Q13 provisional frame: the timeline shows BUFFER time but the
    // transport publishes ISLAND time, wrapped on the trimmed loop —
    // [0, 1Q), where island phase 0 is the selection's top (epoch =
    // origin + loopStart, and clip playback anchors there). Map the ONE
    // playhead (I8) into the buffer frame: heard position = selection
    // start + island phase. The cursor sweeps exactly the selection —
    // the dead air on either side is never audible time, so the cursor
    // never visits it. loopStartQ tells the animator where the loop
    // region begins so its wrap math stays in loop coordinates.
    let loopStartQ = 0;
    if (provisionalDefiner) {
        loopStartQ = defSelStartQ;
        playheadQ = defSelStartQ + playheadQ;
    }

    // STEP-AUDITION CURSOR HONESTY: when the audible cycle IS a sole
    // top-level group's step audition (a derived window over its song,
    // sequencer.md §11.2), the transport sweeps [0, stepLen) but the
    // lane keeps the whole song with brackets at the step — map the
    // ONE playhead into the step (heard position = step start + island
    // phase), the root audition's pattern. (Authored windows no longer
    // need this since the 2026-08-21 ruling: a windowed group lane
    // shows its HEARD material from frame 0, like a windowed clip, so
    // island phase IS lane position.)
    if (!provisionalDefiner && !anyRecording && qEstablished) {
        const auds = nodes.filter(n => n.type === 'stack' &&
            n.windowActive && isAuditionWindow(n) &&
            (n.loopEnd || 0) > (n.loopStart || 0));
        if (auds.length === 1) {
            const g = auds[0];
            const winLen = g.loopEnd - g.loopStart;
            if (Math.round(winLen) === Math.round(loopSamples)) {
                const wsQ = g.loopStart / quantum;
                const lenQ = winLen / quantum;
                loopStartQ = wsQ;
                playheadQ = wsQ + (playheadQ % lenQ);
            }
        }
    }
    return { playheadQ, loopStartQ };
}

/**
 * Ruler tick marks: the Q grid, only when Q exists and stays drawable
 * (a first take's frame is cycleQ ≈ its sample count — no grid, and no
 * DOM explosion).
 *
 * @param {boolean} qEstablished
 * @param {number} cycleQ  display frame length in Q
 * @returns {Array<{q: number, major: boolean}>}
 */
function buildRulerTicks(qEstablished, cycleQ) {
    const ticks = [];
    if (qEstablished && Number.isInteger(cycleQ) && cycleQ <= 64) {
        for (let q = 0; q <= cycleQ; q++) ticks.push({ q, major: q % 4 === 0 });
    }
    return ticks;
}

/**
 * Group (stack) lane + its children (recursive via pushLane).
 */
function pushGroupLane(node, depth, mapCtx, ctx) {
    const { quantum, cycleQ, qEstablished, fxOpen, lanes, state } = ctx;
    if (ctx.provisionalDefiner && node.id === ctx.soleQDefinerId) {
        // Q13 FOR GROUPS: the definer stack renders the same trim view
        // a sole clip does — the whole take with the selection over it
        // — and its children show their whole takes beneath (no map
        // context: the selection is Q being defined, not a part).
        pushDefinerLane(node, depth, ctx);
        if (!(node.isExpanded === false)) {
            // The mics draw in the same BUFFER frame as the definer
            // lane above them (one full tile from 0 — the trim view
            // ignores the epoch, which the re-trim moves under them);
            // tiling them on the epoch grid drew the take shifted by
            // the fold offset, half a Q off the composite over it.
            (node.nodes || []).forEach(c => {
                if (c.type === 'clip' && !c.isRecording && c.duration > 0) {
                    const fullQ = intrinsicPeriodQ(c, quantum);
                    lanes.push(Object.assign(laneCommon(c, state), {
                        kind: 'clip', depth: depth + 1,
                        periodQ: fullQ, intrinsicQ: fullQ,
                        reps: [{ startQ: 0, endQ: fullQ, ghost: false }],
                        takeStartQ: 0, window: null, windowPhase: 0,
                        armable: false, bandEditable: false,
                        inputChannel: c.inputChannel ?? -1,
                        definerMember: true,
                    }));
                    if (fxOpen && fxOpen.has(c.id)) lanes.push(fxRow(c, depth + 2));
                } else {
                    pushLane(c, depth + 1, null, ctx);
                }
            });
            lanes.push({ kind: 'add', id: 'add:' + node.id, groupId: node.id,
                         name: '', depth: depth + 1 });
        }
        return;
    }
    const periodQ = displayPeriodQ(node, quantum);
    // A STEP AUDITION on this group (§11.2) publishes a DERIVED window
    // in SONG coordinates; group lanes tile at their intrinsic period,
    // so those brackets/dims would land in the wrong frame. The grid's
    // looping header + the lane chip carry the state instead; the
    // authored window (if any) is hidden underneath for the duration.
    // (Step 3, §12.2: a sequenced group lane now tiles in SONG
    // coordinates, so a nested audition's derived brackets land where
    // they mean — the step-2 carve-out is gone.)
    const gwin = mapOf(node, quantum);
    const intrinsicQ = intrinsicPeriodQ(node, quantum);
    const editable = qEstablished && intrinsicQ >= 2 && !subtreeRec(node);
    const groupFields = {
        kind: 'group',
        depth,
        folded: node.isExpanded === false,
        groupArm: groupArmState(node),
        // The map cue on the MAPPING group itself: a take is
        // recording through this window right now.
        mapRecording: !!(gwin && gwin.active && subtreeRec(node)),
        mapSuspended: !!(gwin && gwin.suspended),  // S16
    };
    let lane;
    if (ctx.windowEdit && ctx.windowEdit.has(node.id) &&
        (gwin || intrinsicQ >= 2)) {
        // THE EDIT VIEW — the same inspector a clip opens (I5): the
        // full inner cycle on its own scale, brackets over it.
        lane = Object.assign(windowEditLane(node, gwin, intrinsicQ, ctx),
            groupFields);
    } else if (gwin && gwin.active && !gwin.suspended &&
               !isAuditionWindow(node)) {
        // THE HEARD VIEW — the same default a windowed clip has (I5,
        // the 2026-08-21 ruling): the lane's material IS the window's
        // content, tiled at the window length from frame 0 (groups
        // anchor at 0: a composite is derived machinery, not a
        // performance). Chip + edge grips + seams are the chrome; the
        // raw inner cycle is one grab away.
        lane = Object.assign(laneCommon(node, state), groupFields,
            heardViewFields({ win: gwin, lanePeriodQ: periodQ, intrinsicQ,
                              heardTopQ: 0, cycleQ, qEstablished,
                              editable }));
    } else {
        lane = Object.assign(laneCommon(node, state), groupFields, {
            periodQ,
            // The window EDIT range: [0, inner cycle] — the brackets'
            // clamp bound.
            intrinsicQ,
            // Before Q exists there is nothing meaningful to tile.
            // Groups anchor at frame 0 (origin-based take marking
            // would draw meaningless wrap slivers).
            reps: qEstablished
                ? unrollReps({ periodQ, offsetQ: 0, cycleQ })
                : [],
            // A bypassed/suspended map over the raw inner cycle:
            // multi-segment maps draw dims + one chip, never
            // brackets (geometry edits live in the editor); single
            // windows keep the bracket overlay (dimmed, says why).
            window: gwin && gwin.multi ? null : gwin,
            mapSegs: gwin && gwin.multi ? gwin.segs : null,
            mapBypassed: !!(gwin && gwin.bypassed),
            mapChipQ: gwin && gwin.multi ? gwin.periodQ : 0,
            windowPhase: 0,
            // CUT BANDS (phase 3, owner-chosen design A) over the raw
            // inner cycle: bypassed maps keep their bands visible
            // (geometry survives bypass; the chip says so).
            bandSegs: gwin ? gwin.segs : null,
            bandTotalQ: intrinsicQ,
            bandEditable: editable,
        });
    }
    // The SEQUENCER (docs/sequencer.md): the rail chip's facts, and the
    // grid row when expanded (view state, the fx-row pattern).
    {
        const s = seqOf(node);
        lane.seq = s ? {
            bypassed: !!s.bypassed,
            totalQ: seqTotalSamples(s) / quantum,
            stepCount: s.steps.length,
            auditionStep: auditionStepOf(s),
        } : null;

        lane.seqRecording = !!subtreeRec(node);
    }
    lanes.push(lane);
    if (ctx.seqOpen && ctx.seqOpen.has(node.id)) {
        lanes.push(seqRow(node, depth + 1, quantum, qEstablished));
    }
    if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
    // The nearest enclosing active map wins (engine parity).
    // segs + the group's cycle ride along so child lanes can
    // project the excluded regions as dims (phase-3 conservative
    // step toward the heard-frame child unroll).
    const ownMap = gwin && gwin.active
        ? { periodQ: gwin.periodQ, startQ: gwin.segs[0][0],
            segs: gwin.segs,
            // The map's coordinates: the group's SONG when sequenced
            // (S9 — the map selects song positions), else its inner
            // cycle (never the window itself — the map selects OVER
            // this domain).
            groupCycleQ: activeSeqSamples(node) > 0
                ? activeSeqSamples(node) / quantum : intrinsicQ }
        : null;
    // TODO(phase 3): children of a group with an ACTIVE window
    // live in the window's re-based inner frame (time_maps.md §2
    // — the window re-bases the epoch for its children). Phase 1
    // unrolls them against the island cycle; revisit when the
    // shell renders windowed groups interactively.
    if (!lane.folded) {
        const childFrom = lanes.length;
        // The SCOPE CYCLE the children hear (engine: context_cycle —
        // the song when sequenced, else the lcm of the looping
        // members, else inherited). One-shot lanes echo at it (§12.2).
        const prevScope = ctx.scopeCycleQ;
        ctx.scopeCycleQ = scopeCycleQOf(node, quantum, prevScope);
        (node.nodes || []).forEach(c =>
            pushLane(c, depth + 1, ownMap || mapCtx, ctx));
        ctx.scopeCycleQ = prevScope;
        // An ACTIVE sequence projects its gates onto the child lanes as
        // dims (the display side of the period law — sequencer.md §9:
        // you READ the song on the lanes, you EDIT it in the grid).
        {
            const s = seqOf(node);
            if (s && !s.bypassed) {
                attachSeqDims(lanes, childFrom, lanes.length,
                    node.nodes, s, quantum);
            }
        }
        // Synthetic affordance row: "+ add track" at the bottom of
        // the open group (field-preferred placement, 2026-07-09)
        lanes.push({
            kind: 'add', id: 'add:' + node.id, groupId: node.id,
            name: '', depth: depth + 1,
        });
    }
}

/**
 * Provisional Q-definer lane (idle, sole committed clip): render the
 * FULL recorded buffer as ONE tile with the loop region as a
 * SELECTION overlay — brackets + dimmed (but visible) dead air.
 * No windowed reframe, no echo tiles: dragging the handles moves
 * the selection over a stable waveform. Q/epoch update live
 * underneath (the engine); this view just doesn't collapse until a
 * second take locks it.
 */
function pushDefinerLane(node, depth, ctx) {
    const { quantum, fxOpen, lanes, state, defSelStartQ, defSelEndQ } = ctx;
    // A clip's buffer, or — Q13 for groups — the definer stack's inner
    // cycle (the composite of its one take).
    const fullQ = intrinsicPeriodQ(node, quantum);
    lanes.push(Object.assign(laneCommon(node, state), {
        kind: node.type === 'stack' ? 'group' : 'clip',
        depth,
        periodQ: fullQ,
        intrinsicQ: fullQ,          // drag/dim extent = the whole buffer
        reps: [{ startQ: 0, endQ: fullQ, ghost: false }],  // one full tile
        takeStartQ: 0,              // buffer starts at frame 0 (ignore epoch)
        window: { startQ: defSelStartQ, endQ: defSelEndQ,
                  active: true, bypassed: false, latent: false },
        // No per-lane heard-time cursor: the MAIN playhead is
        // mapped into the selection (one playhead, I8) — a
        // second amber cursor sweeping the same span was the
        // "two cursors" field bug (2026-07-19).
        windowPhase: 0,
        armable: false,
        inputChannel: node.inputChannel ?? -1,
        isQDefiner: true,
        folded: node.type === 'stack' && node.isExpanded === false,
        groupArm: node.type === 'stack' ? groupArmState(node) : undefined,
    }));
    if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
}

/**
 * Recording clip lane. The bar is [playhead − length, playhead]: under
 * the masterPos contract the playhead IS the take's end, and the
 * engine grows `duration` live while writing. Zero length = pending
 * start (armed, waiting for the Q boundary).
 */
function pushRecordingLane(node, depth, mapCtx, ctx) {
    const { quantum, fxOpen, lanes, state } = ctx;
    lanes.push(Object.assign(laneCommon(node, state), {
        kind: 'clip',
        depth,
        periodQ: 0,
        reps: [],
        window: null,
        armable: true,
        inputChannel: node.inputChannel ?? -1,
        recordingLengthQ: (node.duration || 0) / quantum,
        pendingStart: !(node.duration > 0),
        // Recording THROUGH an enclosing map (phase 2): the cue
        // hooks + the bar's cap (the engine commits ≤ one map
        // period).
        throughMap: !!mapCtx,
        mapPeriodQ: mapCtx ? mapCtx.periodQ : 0,
        mapStartQ: mapCtx ? mapCtx.startQ : 0,
    }));
    if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
}

/**
 * THE WINDOW EDIT VIEW — ONE function for clips and groups (I5): the
 * lane expands to its FULL raw extent (a clip's take, a group's inner
 * cycle) on its OWN horizontal scale — the seed track's trim view, per
 * lane. Brackets select over the whole extent; the amber cursor
 * carries heard time; the rest of the timeline (and the white cursor)
 * stay in the audible frame. Returns the lane's view fields; the
 * caller adds kind/depth.
 */
function windowEditLane(node, win, intrinsicQ, ctx) {
    return Object.assign(laneCommon(node, ctx.state), {
        periodQ: intrinsicQ,
        intrinsicQ,
        frameQ: intrinsicQ,  // per-lane scale: an inspector
        reps: [{ startQ: 0, endQ: intrinsicQ, ghost: false }],
        takeStartQ: 0,
        window: win,
        windowPhase: node.windowActive ? (node.playhead || 0) : 0,
        windowEditing: true,
        // Cut bands over the raw extent (fully fractal): inner
        // cuts are draggable bands; the trim brackets keep the
        // leading/trailing exclusions.
        bandSegs: win ? win.segs : null,
        bandTotalQ: intrinsicQ,
        bandEditable: intrinsicQ >= 2,
        armable: false,
        inputChannel: node.inputChannel ?? -1,
    });
}


/**
 * THE CHILD HEARD UNROLL under an enclosing ACTIVE map (the phase-3
 * item the 2026-08-21 ruling forces: once a windowed group's lane and
 * the frame are the window, its children must show the same slice).
 * The parent's segments live in the parent's INNER-cycle coordinates;
 * a child tiles there at its own period from its own offset, so each
 * parent segment is walked across the child's period boundaries and
 * mapped into the child's CONTENT coordinates ((t − off) mod P). The
 * result is the child's heard material in heard order — the same
 * `srcSegs` shape a self-windowed lane carries, summing to the
 * parent's map period — or null when it cannot be built (no Q, a
 * degenerate ratio). Mirrors the engine's composition: the child sees
 * the parent-mapped clock, and its own clip tiling applies to that.
 *
 * @param {Array<[number,number]>} segsQ  parent segments (inner-cycle Q)
 * @param {number} offsetQ   the child's tiling-grid phase in the parent
 * @param {number} periodQ   the child's own period (Q)
 * @param {number} intrinsicQ the child's raw extent (Q) the srcs index
 * @returns {?Array<[number,number]>} src fractions of intrinsicQ
 */
function childSrcSegsUnderMap(segsQ, offsetQ, periodQ, intrinsicQ) {
    if (!(periodQ > 0) || !(intrinsicQ > 0) || !segsQ || !segsQ.length) {
        return null;
    }
    const out = [];
    let pieces = 0;
    for (const [s0, e0] of segsQ) {
        let t = s0;
        while (t < e0 - EPS) {
            const rel = posMod(t - offsetQ, periodQ);
            const step = Math.min(e0 - t, periodQ - rel);
            if (step <= EPS) break;
            // The child's content is its raw extent (intrinsicQ); the
            // period may be the commensurate whole-Q — clamp inside.
            const a = Math.min(rel, intrinsicQ);
            const b = Math.min(rel + step, intrinsicQ);
            if (b > a + EPS) out.push([a / intrinsicQ, b / intrinsicQ]);
            t += step;
            if (++pieces > MAX_TILES) return null;
        }
    }
    return out.length ? out : null;
}

/**
 * THE HEARD VIEW — ONE function for clips and groups (I5; the
 * 2026-08-21 ruling "a window sets the part's length"): an ACTIVE
 * map's CONTENT is the lane's material, tiled at the map period on the
 * frame grid. Every rep carries the segment src so the renderer draws
 * window content in every tile — the whole lane is audible truth, and
 * the one white cursor is honest on it. Brackets are gone (the whole
 * tile IS the window); the chip + edge grips + seams are the chrome,
 * and the raw extent lives one grab away (windowEditLane).
 *
 * @param {Object} o
 * @param {Object} o.win          mapOf() descriptor (active)
 * @param {number} o.lanePeriodQ  the map period in Q (the part length)
 * @param {number} o.intrinsicQ   the raw extent the segs index into
 * @param {number} o.heardTopQ    where the loop's heard TOP sits within
 *                                its own period (content rotation — a
 *                                clip's origin phase; 0 for a group)
 * @param {number} o.cycleQ       the display frame
 * @param {boolean} o.qEstablished
 * @param {boolean} o.editable    whether the cut/trim chrome is live
 */
function heardViewFields({ win, lanePeriodQ, intrinsicQ, heardTopQ, cycleQ,
                           qEstablished, editable }) {
    let reps = qEstablished
        ? unrollReps({ periodQ: lanePeriodQ, offsetQ: 0, cycleQ, takeQ: 0 })
        : [];
    // HEARD tiles sit on the FRAME grid with the loop's phase BAKED IN
    // as content ROTATION (field 2026-07-23c): a loop resting mid-phase
    // used to tile from its anchor, splitting into a bright tile + a
    // "wrap sliver" that drew squeezed and dimmed as if it were a
    // repeat — but when the loop fills the frame every pixel is UNIQUE
    // audible content. Rotation keeps each sample at its true island
    // phase (cross-lane alignment, I2) with no sliver. Every rep
    // carries the map's content slices (`srcSegs`) plus `srcTopFrac`.
    const srcSegs = win.segs.map(([s, e]) => [s / intrinsicQ, e / intrinsicQ]);
    const extra = { srcSegs, srcTopFrac: lanePeriodQ > 0 ? heardTopQ / lanePeriodQ : 0 };
    reps = reps.map(r => Object.assign({}, r, extra));
    // A loop that FILLS the frame has no repeats: everything is
    // material, nothing dims. (True repeats — period < frame — keep
    // the echo treatment per "ghosts show what sounds".)
    if (lanePeriodQ >= cycleQ - EPS) {
        reps = reps.map(r => Object.assign({}, r, { ghost: false }));
    }
    return {
        periodQ: lanePeriodQ,
        // The lane's material IS the window content, so its extent is
        // the window length (drag/dim math included).
        intrinsicQ: lanePeriodQ,
        reps,
        takeStartQ: heardTopQ,
        window: null,
        windowChipQ: lanePeriodQ,
        mapMulti: !!win.multi,
        // Cut geometry, editable IN PLACE (field 2026-07-23: no modes):
        // heard-view lanes render cuts as SEAM HANDLES (a cut has zero
        // width in heard time — it IS the splice), with the edge grips
        // as live trim handles.
        bandSegs: win.segs,
        bandTotalQ: intrinsicQ,
        bandHeard: true,
        bandPeriodQ: win.periodQ,
        bandEditable: !!editable,
        windowPhase: 0,
    };
}

/**
 * HEARD VIEW (law 13 amendment) — the default committed-clip lane: an
 * ACTIVE window's CONTENT is the lane's material, tiled where it
 * audibly sounds (anchored at origin + start, period = window length).
 * Every rep carries the segment src so the renderer draws window
 * content in every tile — the whole lane is audible truth, and the one
 * white cursor is honest on it. The raw take lives one grab away.
 */
function pushHeardClipLane(node, depth, mapCtx, offsetQ, periodQ,
                           intrinsicQ, win, ctx) {
    const { quantum, epochSamples, qEstablished, cycleQ, lcmQ,
            fxOpen, lanes, state } = ctx;
    const heard = !!(win && win.active);
    const lanePeriodQ = heard ? win.periodQ : periodQ;
    // The ANCHORING LAW (phase 3): map playback anchors at
    // origin + mapOffset(0) — the first segment's start (its
    // single-segment case is the 2026-07-19 origin + loopStart).
    const laneOffsetQ = heard ? offsetQ + win.segs[0][0] : offsetQ;
    // The loop's heard TOP within its own period — the lane anchor
    // for heard chrome (seams, trim grips) and the rotation.
    const heardTopQ = heard && lanePeriodQ > 0
        ? posMod(laneOffsetQ, lanePeriodQ)
        : 0;
    // Take marking (Q14): the bright tile is the one at the take's
    // HEARD PHASE — its position mod the cycle it was performed
    // against (`contextCycle`, the engine's per-take heard frame),
    // on this lane's tile grid (mod period). Whole heard-cycles
    // fold away; the phase survives later frame growth AND epoch
    // re-bases (both move by whole multiples of every earlier
    // take's heard cycle). Fallback for states without
    // contextCycle (mock scenarios, first takes): era takes fold by
    // the committed cycle; pre-epoch takes mark the first full rep.
    const relQ = ((node.origin || 0) - epochSamples) / quantum;
    const ctxQ = (node.contextCycle || 0) / quantum;
    let takeQ;
    if (ctxQ > 0 && lanePeriodQ > 0) {
        const phase = posMod(laneOffsetQ, ctxQ);
        const firstTile = posMod(laneOffsetQ, lanePeriodQ);
        // First tile position ≡ the heard phase (mod ctx): exists
        // within lcm(ctx, period) ≤ the committed cycle. Guarded like
        // unrollReps' maxTiles: a degenerate frame (tiny period vs. a
        // huge cycle) must never turn this scan into thousands of
        // iterations — unrollReps yields no tiles in that regime
        // anyway, so an unmarked take costs nothing.
        if (cycleQ / lanePeriodQ <= MAX_TILES) {
            for (let p = firstTile; p < cycleQ; p += lanePeriodQ) {
                const d = posMod(p - phase, ctxQ);
                if (d < EPS || ctxQ - d < EPS) { takeQ = p; break; }
            }
        }
    } else if (relQ >= 0 && lcmQ > 0) {
        takeQ = posMod(laneOffsetQ, lcmQ);
    }
    let heardFields = heard
        ? heardViewFields({ win, lanePeriodQ, intrinsicQ, heardTopQ, cycleQ,
                            qEstablished,
                            editable: qEstablished && intrinsicQ >= 2 &&
                                !node.isRecording })
        : null;
    // UNDER AN ENCLOSING ACTIVE MAP (no map of its own): the lane shows
    // the slice the parent's map selects of it — the child heard
    // unroll (childSrcSegsUnderMap). One-shots keep their own firing
    // display; the parent owns the chrome (no chip/grips here).
    let underMap = false;
    if (!heard && mapCtx && mapCtx.segs && qEstablished &&
        node.periodSource !== 'context' && lanePeriodQ > 0) {
        const src = childSrcSegsUnderMap(mapCtx.segs, laneOffsetQ,
            lanePeriodQ, intrinsicQ);
        if (src) {
            const mapPeriodQ = mapCtx.periodQ;
            let reps = unrollReps({ periodQ: mapPeriodQ, offsetQ: 0, cycleQ,
                                    takeQ: 0 });
            reps = reps.map(r => Object.assign({}, r,
                { srcSegs: src, srcTopFrac: 0 }));
            if (mapPeriodQ >= cycleQ - EPS) {
                reps = reps.map(r => Object.assign({}, r, { ghost: false }));
            }
            heardFields = {
                periodQ: mapPeriodQ, intrinsicQ: mapPeriodQ, reps,
                takeStartQ: 0, window: null, windowChipQ: 0, mapMulti: false,
                bandSegs: null, bandTotalQ: mapPeriodQ, bandHeard: false,
                bandPeriodQ: 0, bandEditable: false, windowPhase: 0,
                underMap: true,
            };
            underMap = true;
        }
    }
    let reps = heardFields ? heardFields.reps
        : qEstablished
            ? unrollReps({ periodQ: lanePeriodQ, offsetQ: laneOffsetQ,
                           cycleQ, takeQ })
            : [];
    // ONE-SHOT display (Q5 / recording.md Example 3): NO ghost
    // repetitions — the take tile alone marks the one firing per
    // cycle; the rest of the lane is honest silence. The dashed
    // styling rides lane.oneShot in the patch layer.
    if (node.periodSource === 'context') {
        reps = reps.filter(r => !r.ghost);
        // …except under a SEQUENCED (or otherwise shorter) scope cycle
        // (§12.2): the hit fires once per pass of that cycle, so its
        // echoes tile at the scope period — what sounds, shown.
        const scopeQ = ctx.scopeCycleQ || 0;
        const take = reps[0];
        if (take && scopeQ > 0 && scopeQ < cycleQ - EPS &&
            cycleQ / scopeQ <= MAX_TILES) {
            const lenQ = Math.min(lanePeriodQ, scopeQ);
            const first = posMod(take.startQ, scopeQ);
            for (let s = first; s < cycleQ; s += scopeQ) {
                if (Math.abs(s - take.startQ) < EPS) continue;
                const endQ = Math.min(cycleQ, s + lenQ);
                if (endQ - s <= EPS) continue;
                reps.push({ startQ: s, endQ, ghost: true,
                            wrapped: endQ !== s + lenQ });
            }
            reps.sort((a, b) => a.startQ - b.startQ);
        }
    }
    if (heardFields) heardFields.reps = reps;  // one-shot filter applied
    lanes.push(Object.assign(laneCommon(node, state), {
        kind: 'clip',
        depth,
        periodQ: lanePeriodQ,
        intrinsicQ,
        reps,
        // The take tile's frame position: the CONTENT-frame origin of
        // this lane. Window brackets/dims/cursor (content-relative
        // [loopStart, loopEnd)) anchor here — anchoring at frame 0
        // drew them a whole phase off for takes not at the top
        // (field 2026-07-16c). The take rep's startQ is the unclipped
        // tile start by construction (only tile ENDS get clipped).
        takeStartQ: (reps.find(r => !r.ghost) || { startQ: 0 }).startQ,
        window: win,
        windowChipQ: 0,
        mapMulti: !!(win && win.multi),
        // Cut geometry, editable IN PLACE on every resting lane
        // (field 2026-07-23: no modes). Raw-framed lanes render
        // cuts as BANDS.
        bandSegs: win ? win.segs : null,
        bandTotalQ: intrinsicQ,
        bandHeard: false,
        bandPeriodQ: 0,
        bandEditable: qEstablished && intrinsicQ >= 2 &&
            !node.isRecording,
        windowPhase: node.windowActive ? (node.playhead || 0) : 0,
    // HEARD VIEW (the shared function, I5): overrides the raw-framed
    // fields above — period, extent, reps, chip, seams.
    }, heardFields || {}, {
        armable: isArmable(node),
        // Under an enclosing ACTIVE map: the map's excluded regions
        // project onto this lane as dims — what the group's map
        // silences, the child shows silenced (the full heard-frame
        // child unroll stays a phase-3+ item; it would break the
        // shared vertical time grid and needs its own ruling).
        parentMapSegs: mapCtx && !underMap ? mapCtx.segs : null,
        parentMapPeriodQ: mapCtx && !underMap ? mapCtx.groupCycleQ : 0,
        // NOT isQDefiner here: the definer renders through the
        // provisional branch above. This branch gets the sole clip
        // only while a take is in flight — and then a bracket drag
        // is an ordinary window edit (the engine's hasActiveTake
        // gate refuses to move Q under a performing take).
        // Recording input (hardware channel index; −1 = device default)
        inputChannel: node.inputChannel ?? -1,
    }));
    if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
}

/**
 * Append the lane row(s) for one node — and, for groups, its whole
 * subtree — onto ctx.lanes, dispatching to the per-kind builders above.
 *
 * mapCtx: the nearest enclosing ACTIVE map, threaded down the group
 * recursion (time_maps.md phase 2) — recording lanes under one gain
 * throughMap/mapPeriodQ/mapStartQ (the ruling-5 visual-cue hooks;
 * the engine caps the take at one map period).
 *
 * ctx: the per-derivation context (everything the old inline closure
 * captured): { state, lanes, maxDepth, fxOpen, windowEdit, quantum,
 * epochSamples, shiftQ, qEstablished, cycleQ, lcmQ, provisionalDefiner,
 * soleQDefinerId, defSelStartQ, defSelEndQ }.
 */
function pushLane(node, depth, mapCtx, ctx) {
    if (depth > ctx.maxDepth) return;
    // Tile offsets are epoch-relative (origins are ABSOLUTE; the
    // frame's x axis is the engine's epoch-phase view), rotated by
    // the take anchor while recording (shiftQ is whole Qs, so tiles
    // stay Q-grid-true; mod-period tiling handles the wrap)
    const offsetQ = ((node.origin || 0) - ctx.epochSamples) / ctx.quantum
        - ctx.shiftQ;

    if (node.type === 'stack') {
        pushGroupLane(node, depth, mapCtx, ctx);
        return;
    }
    if (ctx.provisionalDefiner && node.id === ctx.soleQDefinerId) {
        pushDefinerLane(node, depth, ctx);
        return;
    }
    if (node.isRecording) {
        pushRecordingLane(node, depth, mapCtx, ctx);
        return;
    }
    const periodQ = displayPeriodQ(node, ctx.quantum);
    const intrinsicQ = intrinsicPeriodQ(node, ctx.quantum);
    const win = mapOf(node, ctx.quantum);
    if (ctx.windowEdit && ctx.windowEdit.has(node.id) &&
        (win || intrinsicQ >= 2)) {
        ctx.lanes.push(Object.assign(windowEditLane(node, win, intrinsicQ, ctx),
            { kind: 'clip', depth }));
        if (ctx.fxOpen && ctx.fxOpen.has(node.id)) {
            ctx.lanes.push(fxRow(node, depth + 1));
        }
        return;
    }
    pushHeardClipLane(node, depth, mapCtx, offsetQ, periodQ,
        intrinsicQ, win, ctx);
}

/**
 * deriveViewModel(state[, opts])
 *
 * state: the getGraphState() shape — { masterPos, isPlaying, origin,
 *        soloedId, nodes: [...] } with clip/stack nodes as published by
 *        the engine (origins ABSOLUTE, samples everywhere).
 * opts.maxDepth: fold depth guard (default 8).
 *
 * Returns Q-unit view model:
 * {
 *   quantum, epochSamples, cycleQ, playheadQ, isPlaying,
 *   armAtQ,                       // next Q boundary (Q11); cycleQ ≡ 0 (↺)
 *   ruler: { cycleQ, ticks: [{ q, major }] },
 *   lanes: [{
 *     id, name, kind: 'clip'|'group', depth,
 *     periodQ,                    // effective period (window-aware, E-C)
 *     reps: [{ startQ, endQ, ghost, wrapped }],
 *     window: { startQ, endQ, active, bypassed } | null,
 *     muted, soloed, recording, armed,
 *     armable,                    // clips: arm targets emptiness (Q7)
 *     recordingLengthQ,           // recording lanes only
 *     folded,                     // group lanes only
 *     groupArm: { state: 'all'|'some'|'none', armable: count },
 *   }]
 * }
 */
export function deriveViewModel(state, opts = {}) {
    const maxDepth = opts.maxDepth ?? 8;
    // Lanes whose effects panel is expanded (pure view state, owned by
    // the app shell — like fold, but client-side only)
    const fxOpen = opts.fxOpen || null;
    // Lanes whose window is being EDITED (view state, app shell): they
    // expand to their full raw duration on their own scale (law 13
    // amendment, 2026-07-19k).
    const windowEdit = opts.windowEdit || null;
    const nodes = state.nodes || [];
    const quantum = resolveQuantum(state, nodes);

    // One DFS for the whole-tree facts (anyRecording also gates the
    // provisional-definer display and the masterPos handling below).
    const { committedClips, anyRecording, anyTakeActive,
            maxRecordingDuration } = collectTreeFacts(nodes);
    const { soleQDefinerId, provisionalDefiner, definerNode,
            defSelStartQ, defSelEndQ } =
        resolveProvisionalDefiner(committedClips, anyTakeActive, quantum,
                                  nodes);

    // The island epoch is published explicitly (getGraphState
    // "islandEpoch"): commit RE-BASES it on simple extensions, and the
    // root node's `origin` metadata does NOT follow — reading origin as
    // the epoch mis-marked take tiles ("first 3Q strangely ghosted",
    // field screenshot 2026-07-09). origin remains the legacy fallback.
    const epochSamples = state.islandEpoch ?? state.origin ?? 0;

    let cycleSamples = computeCycleSamples(nodes, quantum);
    // The AUDIBLE loop — what the engine wraps masterPos on — IS the
    // frame since the 2026-08-21 ruling (every window is a part
    // length, so the effective LCM is the cycle). It diverges only
    // under a STEP AUDITION (a derived window over a song: the frame
    // stays the song, the cursor loops the step) — a nested group's
    // here, the root's below. Surfaced as loopCycleQ.
    let loopSamples = computeCycleSamples(nodes, quantum, { audible: true });
    // The island's INTRINSIC cycle in Q, captured BEFORE the sequence
    // reframes anything: the root grid's one-cycle unit (append/create
    // defaults). Reading the post-override lcmQ here made every "+"
    // add one CURRENT SONG length — steps doubled 2, 4, 8, 16 (owner
    // field report 2026-08-20b).
    const intrinsicCycleQ = cycleSamples / quantum;

    // THE PERIOD LAW at the island ROOT (docs/sequencer.md §2): an
    // active root sequence IS the frame — the song. The engine wraps
    // masterPos on it (snapEffectiveCycle short-circuits at the root);
    // the display frame must agree or the cursor lies.
    const rootSeqSamples = activeSeqSamples(state);
    if (rootSeqSamples > 0) {
        cycleSamples = quantum > 1
            ? lcm(quantum, rootSeqSamples) : rootSeqSamples;
        loopSamples = cycleSamples;
    }
    // THE ROOT'S STEP AUDITION (docs/sequencer.md §11.2): the root
    // publishes its DERIVED window (windowActive/loopStart/loopEnd) —
    // the heard cycle is the step (map over sequence, S9). The FRAME
    // stays the song (lanes keep showing the whole arrangement); the
    // cursor is mapped into the step below, the sole-top-level-window
    // pattern.
    const rootWin = rootSeqSamples > 0 && state.windowActive &&
        (state.loopEnd || 0) > (state.loopStart || 0)
        ? { start: state.loopStart, end: state.loopEnd } : null;
    if (rootWin) loopSamples = rootWin.end - rootWin.start;

    // Provisional Q-definer: frame the FULL recorded buffer (not the Q
    // cycle). cycleQ = duration/quantum and the selection brackets are
    // both ÷quantum, so as the drag changes Q nothing rescales — the
    // waveform fills the frame and the selection moves within it.
    if (provisionalDefiner && intrinsicPeriod(definerNode, quantum) > 0) {
        cycleSamples = intrinsicPeriod(definerNode, quantum);
    }

    // First-take frame: before any Q exists there is no cycle — the only
    // meaningful timeline is the growing take itself. Track it (+1 so the
    // playhead never wraps at the take's own edge) and suppress the Q
    // grid; the first commit establishes Q and snaps to the real frame.
    const qEstablished = quantum > 1;
    if (!qEstablished && maxRecordingDuration > 0) {
        // Grow in WHOLE-SECOND steps (4s minimum): a continuously
        // growing frame rescales the waveform every poll — the
        // "stuttery" first take (field 2026-07-10). Between steps the
        // px-per-second scale is constant, so content stays pinned.
        const sr = (state.perf && state.perf.sampleRate) || 44100;
        cycleSamples = Math.max(4, Math.floor(maxRecordingDuration / sr) + 1) * sr;
    }
    const lcmQ = cycleSamples / quantum;

    // masterPos CONTRACT (AudioEngine::getGraphState, kernel.md step 3):
    // the published masterPos is already the DERIVED DISPLAY POSITION —
    // wrapped to the cycle when idle/playing, and during recording it
    // grows linearly past the committed LCM from a base frozen at record
    // start. The VM must NOT re-wrap it: re-deriving with mod caused the
    // "looping 1Q over and over" field bug (2026-07-09). The mock mirrors
    // this contract (mock_backend.viewMasterPos).
    let playheadQ = Math.max(0, (state.masterPos || 0) / quantum);

    const rec = computeRecordingFrame({
        nodes, quantum, qEstablished, anyRecording, lcmQ, playheadQ,
    });
    const shiftQ = rec.shiftQ;
    let frameQ = rec.frameQ;
    playheadQ = rec.playheadQ;

    const pin = applyFramePin({
        opts, state, quantum, qEstablished, anyRecording,
        frameQ, loopSamples, playheadQ,
    });
    const framePinned = pin.framePinned;
    frameQ = pin.frameQ;
    loopSamples = pin.loopSamples;
    playheadQ = pin.playheadQ;

    // A pinned frame is settled, not provisional — no "…" cue just
    // because live commits shrank the lcm under it.
    const frameExtended = !framePinned && frameQ > lcmQ;
    const cycleQ = frameQ; // the frame every consumer tiles and fits

    const mapped = mapPlayheadToDisplay({
        playheadQ, frameQ, anyRecording, provisionalDefiner,
        defSelStartQ, qEstablished, nodes, quantum, loopSamples,
    });
    playheadQ = mapped.playheadQ;
    let loopStartQ = mapped.loopStartQ;
    if (rootWin && !anyRecording && qEstablished && !provisionalDefiner) {
        // Root audition cursor honesty: the transport sweeps [0, step)
        // (the engine wraps masterPos on the heard cycle); show it at
        // the step's place in the song.
        const wsQ = rootWin.start / quantum;
        const lenQ = (rootWin.end - rootWin.start) / quantum;
        loopStartQ = wsQ;
        playheadQ = wsQ + (((playheadQ % lenQ) + lenQ) % lenQ);
    }

    // Q11: the arm target is always the next Q boundary in the epoch
    // frame (the cycle top is just the next boundary in the final Q).
    // The engine's own pending-start target is authoritative once a clip
    // is armed; this is the display value for "if you arm now". Island Q
    // boundaries sit at loopStartQ + k (loopStartQ = 0 outside the
    // provisional trim view, where this reduces to plain ceil) — for a
    // genuine 1Q selection the next boundary IS the selection end.
    const relPosQ = playheadQ - loopStartQ;
    const armAtQ = loopStartQ +
        (Math.ceil(relPosQ) === relPosQ ? relPosQ + 1 : Math.ceil(relPosQ));

    const lanes = [];
    const ctx = {
        state, lanes, maxDepth, fxOpen, windowEdit, quantum,
        epochSamples, shiftQ, qEstablished, cycleQ, lcmQ,
        provisionalDefiner, soleQDefinerId, defSelStartQ, defSelEndQ,
        // Stacks whose sequencer grid is expanded (view state, the
        // fxOpen pattern — docs/sequencer.md §9 S15).
        seqOpen: opts.seqOpen || null,
        // The cycle top-level lanes hear (§12.2): the root song when
        // sequenced, else the audible loop.
        scopeCycleQ: rootSeqSamples > 0 ? rootSeqSamples / quantum
                                        : loopSamples / quantum,
    };
    nodes.forEach(n => pushLane(n, 0, null, ctx));
    // The ROOT's active sequence projects onto the top-level lanes
    // (engine root = the song when tracks live loose at the top).
    {
        const s = seqOf(state);
        if (s && !s.bypassed) {
            attachSeqDims(lanes, 0, lanes.length, nodes, s, quantum);
        }
    }
    // THE ROOT SEQUENCER GRID (the session's own song — the root has
    // no rail, so its chip lives in the transport bar and the grid
    // renders as the FIRST row, over the top-level tracks).
    const rootId = state.id || '';
    if (ctx.seqOpen && rootId && ctx.seqOpen.has(rootId) &&
        nodes.length > 0) {
        lanes.unshift(buildSeqRow({
            holder: state,
            ownerId: rootId,
            children: nodes,
            depth: 0,
            quantum,
            qEstablished,
            // The INTRINSIC island cycle — never the sequence-inflated
            // frame (the "+ step doubles" field bug, 2026-08-20b).
            innerCycleQ: intrinsicCycleQ,
            editable: !anyRecording,
        }));
    }

    attachFrameHealth(lanes, state, nodes, quantum, qEstablished);

    const ticks = buildRulerTicks(qEstablished, cycleQ);

    return {
        quantum,
        epochSamples,
        cycleQ,          // the DISPLAY FRAME: what lanes tile and views fit
        lcmQ,            // the committed cycle (≤ cycleQ; equal unless recording extends)
        loopCycleQ: loopSamples / quantum, // the AUDIBLE cycle (E-C): < lcmQ when windows shorten it
        loopStartQ,      // frame origin of the audible loop (Q13 trim view; else 0)
        frameExtended,   // true while a take has grown the frame past the LCM
        playheadQ,
        isPlaying: !!state.isPlaying,
        qEstablished,
        soleQDefinerId,  // Q13: the sole committed clip (provisional Q), or null
        provisionalDefiner,  // Q13: framing the full buffer to trim the loop
        sampleRate: (state.perf && state.perf.sampleRate) || 44100,
        armAtQ,
        ruler: { cycleQ, ticks },
        lanes,
        // The root sequencer's transport-chip facts (docs/sequencer.md):
        // rootId targets setSequence/toggleSequence at the session root.
        rootId,
        rootSeq: (() => {
            const s = seqOf(state);
            if (!s) return null;
            const members = scopeMembers(nodes, quantum);
            return {
                bypassed: !!s.bypassed,
                totalQ: seqTotalSamples(s) / quantum,
                stepCount: s.steps.length,
                auditionStep: auditionStepOf(s),
                drift: s.bypassed ? null : assessDrift(
                    seqTotalSamples(s) / quantum, lcmAll(members.map(m => m.periodQ), 1)),
            };
        })(),
        // The root's audition window in frame Q (ruler brackets; the
        // root has no lane to carry them) — null when not looping.
        rootWindow: rootWin ? {
            startQ: rootWin.start / quantum,
            endQ: rootWin.end / quantum,
            step: auditionStepOf(seqOf(state)),
        } : null,
    };
}
