/**
 * View Model (docs/session_view.md §4 — P2-10)
 *
 * deriveViewModel(state) : backend graph state → pure view model.
 *
 * THE FRAME RULE: everything here is in Q units (floats), in the island
 * island frame. There are no pixels in this file — the single Q→px scale
 * lives in the patch layer, which makes I2 (simultaneity ⇔ same x) a
 * property of the architecture instead of a property to test per-feature,
 * and I8 (one clock) literal: the model carries exactly one playheadQ.
 *
 * Uses timeline_model.js for all timing math (LCM/quantum); anything
 * cyclic here mirrors design_language.md canon:
 *   - reps tile the cycle at  q ≡ originQ (mod periodQ)   (kernel origins)
 *   - A WINDOW SETS THE PART'S LENGTH (groups exactly as clips — I5):
 *     a lane's default material is what is HEARD (the window's
 *     content, tiled at the window length), its chip and its
 *     contribution to every cycle (frame, transport, "+ step") are the
 *     effective period — the engine's getEffectivePeriod, mirrored.
 *     The raw take is one grab away (the edit view), which answers the
 *     hidden-content concern.
 *   - the arm target is the next Q boundary in the island frame (Q11)
 *   - arming a group arms every child (Q7 group-arm ruling)
 */

import {
    lcm, calculateStackLCM, commensuratePeriod, computeEffectiveQuantum,
    nextStopBoundary, timelineLcm, stackEffectivePeriod, isAuditionWindow,
    activeSequenceSamples, sequenceProgram, sequenceTotalSamples,
    periodContribution, publishedNodeDrifts, driftsByRoundingOnly,
} from './timeline_model.js';
import { posMod } from './math_utils.js';
import { assessBlowup, assessDrift, lcmAll } from './frame_health.js';
import { flatSegPeriod, nodeWindowActive, mapOffset, seamDistance,
         heardOffsetOf } from './time_map.js';

// Q-space float tolerance for exact-position comparisons (tile identity,
// boundary snaps). Q values are small integers/rationals, so 1e-9 sits
// far below any real musical distinction and far above accumulated fp
// noise from the divisions in this file.
const EPS = 1e-9;

// THE PICKUP (docs/frame.md §1, loop_selection.md §9.4): a top up to
// this much of a Q EARLY seats on the grid line after it — a take
// pulled slightly early reads as a pickup into the bar, never as a
// whole Q of wrap tail at the left edge.
export const SEAT_PICKUP_Q = 0.25;

// Degenerate-frame guard: a frame where cycle/period exceeds this must
// never explode into thousands of tiles (e.g. Q not yet established).
// Shared by unrollReps and the take-phase scan in the heard-clip lane
// builder.
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
    // buffer; applied to the definer's own extent it would grow the
    // trim view by ceil(D/Q)·Q on every sub-Q drag.
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
 * WORTH SHOWING: an invalid window, or a full-span window
 * ([0, period)) which restricts nothing — commit writes NO window
 * (audit D4-7); a legacy bundle or a latent full-span drag may still
 * present one, and it reads as none. (Historically commit set loopEnd=duration
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
            // fractions leaks fp noise into labels ("0.9999…Q" for an
            // exactly-1Q map).
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
 * the engine's getEffectivePeriod hands the parent (a window sets the
 * part's length, for groups as for clips):
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
 * no pixel tolerances.
 *
 * @param {Object} opts
 * @param {number} opts.periodQ   tile period in Q
 * @param {number} opts.offsetQ   tiling-grid phase in Q (zero-relative)
 * @param {number} opts.cycleQ    display frame length in Q
 * @param {number} [opts.takeQ]   performed cycle position of the take
 * @param {number} [opts.maxTiles=MAX_TILES] degenerate-frame guard
 * @returns {Array<{startQ: number, endQ: number, ghost: boolean, wrapped: boolean}>}
 */
export function unrollReps({ periodQ, offsetQ, cycleQ, takeQ, maxTiles = MAX_TILES }) {
    if (periodQ <= 0 || cycleQ <= 0) return [];
    // Safety net: a degenerate frame (e.g. Q not yet established) must
    // never explode into thousands of tiles
    if (cycleQ / periodQ > maxTiles) return [];
    const reps = [];
    // The tiling grid runs at q ≡ offsetQ (mod periodQ) — NEVER derived
    // through the frame: an extended recording frame is not a multiple
    // of every period, and routing the phase through mod-frame breaks
    // tile alignment (found by the take-anchored frame tests).
    const first = posMod(offsetQ, periodQ);
    // Take marking: whole CYCLES never matter (how many times clip 1
    // looped before clip 2 was recorded), but the performed PHASE
    // within the cycle does (a clip recorded at 2Q anchors 2Q→4Q, not
    // 0Q — folding by the clip's own period would erase it, since a 2Q
    // loop at 2Q sounds identical to one at 0Q). Callers pass takeQ =
    // the performed cycle position for takes made in the current zero
    // era; without it (pre-zero takes, groups) the take is the first
    // full repetition.
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
 * Bracket-drag edit math (docs/session_view.md §2 "loop windows live on
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
 * The verb a clip's ● offers (Q7 + docs/takes.md §2), shared with
 * app.js's record handler (one rule, one copy):
 *   'stop'   — a live take (recording or pending): ● stops/cancels it;
 *   'record' — an empty clip: ● records its first take;
 *   'retake' — a committed clip: ● arms a NEW TAKE of the slot
 *              (`newTake`; a plain arm on content stays refused);
 *   null     — a committed one-shot: its slot top is never heard
 *              through the context cycle, so the engine refuses.
 */
export function armMode(clip) {
    if (clip.isRecording || clip.isPendingStart) return 'stop';
    if (!(clip.duration > 0)) return 'record';
    if (clip.periodSource === 'context') return null;
    return 'retake';
}

/** True when ● does anything on this clip (a committed clip is armable
 * as a retake). */
export function isArmable(clip) {
    return armMode(clip) !== null;
}

/** Does the node's published chain carry an instrument slot (docs/
 * vst3.md §8)? The rail's MIDI-arm affordance and app.js's live MIDI
 * target selection read the same rule. */
export function hasInstrument(node) {
    return !!(node && node.effects && Array.isArray(node.effects.chain) &&
        node.effects.chain.some(s => s.isInstrument));
}

/**
 * Aggregate arm state over a group: { state: 'all'|'some'|'none',
 * armable: count, mode: 'record'|'retake'|'none' }. Arm targets
 * emptiness first (Q7): while any EMPTY or live clip sits beneath, the
 * ● records the empties (full ones just play) and the aggregate spans
 * those. With every track full, the ● is a NEW TAKE of the group's
 * committed DIRECT clips — one performance (docs/takes.md §2) — and
 * armable counts them. armable === 0 means the control has nothing to
 * do (disable it).
 */
function groupArmState(node) {
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
 * The take facts a clip lane carries (docs/takes.md §5): the list
 * size, the active index, the comp (one take index per Q cell, −1 =
 * active, [] = none), the cell count the comp editor draws
 * (ceil(period / Q)), and whether the lane is in COMP MODE (view state,
 * opts.compMode). States without the keys (hand-built scenes) read as
 * one take, no comp.
 */
function takeFields(node, quantum, ctx) {
    const duration = node.duration || 0;
    const takes = typeof node.takes === 'number'
        ? node.takes : (duration > 0 ? 1 : 0);
    return {
        takes,
        activeTake: node.activeTake || 0,
        comp: Array.isArray(node.comp) ? node.comp.slice() : [],
        compCells: quantum > 0 && duration > 0
            ? Math.ceil(duration / quantum - EPS) : 0,
        compMode: !!(ctx.compMode && ctx.compMode.has(node.id)),
    };
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
 *   monitor: boolean,      //  Q20 software input monitoring (clips; off by default)
 * }}
 */
function laneCommon(node, state) {
    return {
        id: node.id,
        name: node.name || node.id,
        muted: !!node.isMuted,
        // Solo canon (Q16): island-wide, ADDITIVE, fractal — the engine
        // publishes a per-node flag (multiple lanes may be lit at once).
        soloed: !!node.isSoloed,
        recording: !!node.isRecording,
        // Stop requested; the engine records on to the next boundary
        // (stops always pad forward)
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
        hasInstrument: hasInstrument(node),
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
        // Software input monitoring (Q20): the rail's "mon" chip —
        // published per clip, off unless toggled on.
        monitor: !!node.monitor,
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
                       qEstablished, innerCycleQ, editable, anchorQ = 0 }) {
    const s = seqOf(holder);
    const steps = s ? s.steps.map(st => ({
        name: st.name || '',
        lenQ: (st.len > 0 ? Math.round(st.len) : 0) / quantum,
        // CUE (docs/sequencer.md ss3, S22): the step re-bases the
        // subtree to the song top - the header pip is the control.
        cue: !!st.cue,
        // The successor graph (§14): [{to, w}]; empty = the loop
        // successor. The header's → pip edits it.
        next: Array.isArray(st.next)
            ? st.next.map(n => ({ to: n.to, w: n.w })) : [],
        // Per-step fades (S13, §15) in Q; 0 = the anti-pop micro-fade.
        fadeInQ: (st.fadeIn > 0 ? Math.round(st.fadeIn) : 0) / quantum,
        fadeOutQ: (st.fadeOut > 0 ? Math.round(st.fadeOut) : 0) / quantum,
    })) : [];
    // THE PROGRAM (§14): the grid's COLUMNS are the visits — a step
    // the walk plays twice has two columns, both editing the one step
    // — so step boundaries stay on the shared time axis.
    const prog = sequenceProgram(s);
    const visits = [];
    let totalQ = 0;
    prog.visits.forEach(i => {
        visits.push({ step: i, startQ: totalQ, lenQ: steps[i].lenQ });
        totalQ += steps[i].lenQ;
    });
    return {
        kind: 'seq',
        id: 'seq:' + ownerId,
        ownerId,
        name: '',
        depth,
        bypassed: !!(s && s.bypassed),
        steps,
        visits,
        totalQ,
        // The song's anchor in the lane frame (the owner's origin — a
        // group's Q18 origin; the root's, a whole song from the seated
        // zero, so 0 — frame.md §4): the playing column is the
        // playhead folded FROM here (engine parity; seq_grid.js).
        phaseQ: totalQ > 0 ? (((anchorQ % totalQ) + totalQ) % totalQ) || 0 : 0,
        // The radio (§6): period-less — the seed is its performance.
        radio: !!prog.radio,
        seed: s ? ((s.seed || 0) >>> 0) : 0,
        reachable: steps.map((_, i) => !!prog.reachable[i]),
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

function seqRow(node, depth, quantum, qEstablished, anchorQ = 0) {
    return buildSeqRow({
        holder: node,
        ownerId: node.id,
        children: node.nodes,
        depth,
        quantum,
        qEstablished,
        innerCycleQ: intrinsicPeriodQ(node, quantum),
        editable: !subtreeRec(node),
        anchorQ,
    });
}

/**
 * Post-pass: project a stack's ACTIVE sequence onto the lanes of its
 * children (docs/sequencer.md §9 — the lanes are the DISPLAY, the grid
 * is the editor): each direct child's gated-OFF spans become dim
 * overlays (`seqDims`), applied to the child's whole subtree span
 * (gates are fractal). Lanes tile the spans every seq period.
 */
function attachSeqDims(lanes, from, to, children, seq, quantum, anchorQ = 0) {
    const stepsQ = seq.steps.map(
        st => (st.len > 0 ? Math.round(st.len) : 0) / quantum);
    // THE PROGRAM is the timeline (§14): spans tile over the visits.
    const visits = sequenceProgram(seq).visits;
    const totalQ = visits.reduce((t, k) => t + stepsQ[k], 0);
    if (!(totalQ > 0)) return;
    // THE SONG'S ANCHOR (engine parity, StackNode::renderChildren —
    // owner ruling 2026-09-09 "the grid you see is the grid you hear"):
    // the step lookup folds from the OWNER's frame origin — a group's
    // Q18 origin (`anchorQ`, its offset from the zero in Q), the zero
    // itself for the root — so the layer carries that phase and the
    // lane tiles the spans from it, never from the lane's frame zero.
    const phaseQ = (((anchorQ % totalQ) + totalQ) % totalQ) || 0;
    // CUED spans (ss3): every child under the scope replays the song
    // top during a cued step - the lanes mark those spans so the
    // display stays honest about what is heard (pure projection).
    const cueSegsQ = [];
    {
        let pos = 0;
        visits.forEach(k => {
            if (seq.steps[k].cue) cueSegsQ.push([pos, pos + stepsQ[k]]);
            pos += stepsQ[k];
        });
    }
    const childIds = new Set((children || []).map(c => c.id));
    const startsQ = [];
    {
        let pos = 0;
        visits.forEach(k => { startsQ.push(pos); pos += stepsQ[k]; });
    }
    const cued = k => !!seq.steps[k].cue;
    let offSegs = null;   // the CURRENT direct child's off spans
    let fadeSegs = null;  // …and its fade ramps (S13)
    for (let i = from; i < to; i++) {
        const lane = lanes[i];
        if (childIds.has(lane.id)) {
            const bits = seq.gates ? seq.gates[lane.id] : null;
            offSegs = [];
            let pos = 0, runStart = null;
            visits.forEach(k => {
                const lenQ = stepsQ[k];
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
            fadeSegs = fadeSegsOf(visits, stepsQ, startsQ, totalQ, bits,
                                  cued, seq.steps, quantum);
            if (!fadeSegs.length) fadeSegs = null;
        }
        // A layer attaches when the child has OFF spans OR the scope
        // has cued spans (cue re-bases everyone, gated or not).
        if ((offSegs || cueSegsQ.length) &&
            (lane.kind === 'clip' || lane.kind === 'group')) {
            // LAYERS compose (§12.2): inner scopes attach first (during
            // the recursion), outer scopes after — prepend so the list
            // reads outermost first. A lane is silent where ANY
            // enclosing sequence silences it (the fractal gate).
            lane.seqDims = [{ periodQ: totalQ, offSegsQ: offSegs || [],
                              cueSegsQ: cueSegsQ.length ? cueSegsQ : null,
                              ...(fadeSegs ? { fadeSegsQ: fadeSegs } : {}),
                              ...(phaseQ ? { phaseQ } : {}) },
                            ...(lane.seqDims || [])];
        }
    }
}

/**
 * The ON-runs of a child's gates over the program's visits — engine
 * parity Sequence::runAround: contiguous on-visits merge, INCLUDING
 * across the wrap, and break at cue seams (S20). Returns [{first,
 * last}] visit indices; a run that is the whole program with no seam
 * is `whole` (constant gain — no ramps anywhere).
 */
function onRunsOf(visits, bits, cued) {
    const n = visits.length;
    if (!n) return [];
    const on = k => (bits ? !!bits[visits[k]] : true);
    const cut = (a, b) => cued(visits[a]) || cued(visits[b]);
    let start = -1;
    for (let i = 0; i < n; i++) {
        const p = (i + n - 1) % n;
        if (on(i) && (!on(p) || cut(p, i))) { start = i; break; }
    }
    if (start < 0) return on(0) ? [{ first: 0, last: n - 1, whole: true }] : [];
    const runs = [];
    let i = start, seen = 0;
    while (seen < n) {
        if (!on(i)) { i = (i + 1) % n; seen++; continue; }
        let last = i, len = 1;
        while (len < n && on((last + 1) % n) && !cut(last, (last + 1) % n)) {
            last = (last + 1) % n;
            len++;
        }
        runs.push({ first: i, last });
        seen += len;
        i = (last + 1) % n;
    }
    return runs;
}

/**
 * PER-STEP FADE ramps (S13, §15) as display segments over the program:
 * [[fromQ, toQ, 'in'|'out'], …]. A run ramps in over its FIRST step's
 * fadeInQ and out over its LAST step's fadeOutQ; ramps that do not fit
 * the run shrink proportionally so they meet (engine parity
 * Sequence::rampsOf). Segments crossing the wrap are split.
 */
function fadeSegsOf(visits, stepsQ, startsQ, totalQ, bits, cued, steps,
                    quantum) {
    const q = v => (v > 0 ? Math.round(v) : 0);
    const segs = [];
    const push = (from, len, kind) => {
        if (!(len > 1e-9)) return;
        const a = posMod(from, totalQ);
        if (a + len <= totalQ + 1e-9) segs.push([a, a + len, kind]);
        else { segs.push([a, totalQ, kind]); segs.push([0, a + len - totalQ, kind]); }
    };
    for (const r of onRunsOf(visits, bits, cued)) {
        if (r.whole) continue;
        const n = visits.length;
        let runLen = 0;
        for (let k = r.first;; k = (k + 1) % n) {
            runLen += stepsQ[k];
            if (k === r.last) break;
        }
        let fIn = q(steps[visits[r.first]].fadeIn) / quantum;
        let fOut = q(steps[visits[r.last]].fadeOut) / quantum;
        if (fIn + fOut > runLen && fIn + fOut > 0) {
            fIn = fIn * runLen / (fIn + fOut);
            fOut = runLen - fIn;
        }
        push(startsQ[r.first], fIn, 'in');
        push(startsQ[r.first] + runLen - fOut, fOut, 'out');
    }
    return segs;
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
        periodQ: effectivePeriod(c, quantum) / quantum,
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
 * THE RECORDING GATE (time_maps.md §7 "Gates and refusals"): while any
 * take records or waits to start (anyTakeActive), no loop region is
 * editable anywhere — the engine refuses every map edit under a live
 * take, so a grip that grabbed would preview geometry that never
 * lands. `bandEditable` is the one editability fact every map surface
 * reads (grips, seams, bands, the region panel, dblclick cuts, ←/→
 * nudges); `bandLocked` marks a lane whose chrome WOULD be live, so it
 * draws inert instead of vanishing mid-take.
 *
 * @param {boolean} editable  the lane's own editability (Q, extent, …)
 * @param {boolean} locked    ctx.mapEditsLocked
 * @returns {{bandEditable: boolean, bandLocked: boolean}}
 */
function bandGate(editable, locked) {
    return { bandEditable: !!editable && !locked,
             bandLocked: !!editable && !!locked };
}

/**
 * The island quantum for a state.
 *
 * The island quantum is a STORED fact published top-level by the
 * engine (the root stack's `quantum` metadata; the mock mirrors it).
 * Prefer it; min-over-nodes derivation is the fallback for states
 * that lack the field (fixtures).
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
 * deriveViewModel needs.
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
 * re-establish (Q, zero); once a 2nd take commits, Q locks. Surface
 * the sole definer so the rail can render draggable "sets tempo"
 * handles even at full span (which windowOf normally suppresses).
 *
 * While the Q-definer is provisional AND idle (nothing armed or
 * recording), it renders its FULL recorded buffer with the loop
 * region drawn as a SELECTION overlay (dead air dimmed but visible)
 * — so dragging the handles moves the selection over a stable
 * waveform while Q/zero update live underneath, rather than
 * reframing to the selection and dropping the rest of the clip. The
 * moment a second take ARMS, the engine LOCK-COLLAPSES the definer
 * (its window becomes the take), so the trim view ends at arm, not at
 * commit: the armed gate here matches the engine's hasActiveTake
 * re-trim refusal.
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
                                   nodes, publishedDefinerId) {
    // THE DEFINER IS PUBLISHED: the engine states `definerId` — the
    // sole committed clip or the definer stack — and the VM reads it
    // rather than re-deriving with its own definition (two definitions
    // can disagree by a sample and flip the lane between the trim view
    // and the heard view). The derivation is the fallback for states
    // that lack the field (fixtures, dumps).
    let definer = null;
    if (typeof publishedDefinerId === 'string') {
        definer = publishedDefinerId
            ? findNodeInTree(nodes, publishedDefinerId) : null;
        // PAST ITS OWN GATES: the trim-view math below leans on
        // oneTakeDuration for a stack definer (the intrinsic-period
        // exactness rule) — a published id whose stack does not read
        // as one take here (a member became a one-shot, durations
        // drifted mid-poll) must not open a trim view whose geometry
        // the VM cannot compute.
        if (definer && definer.type === 'stack' &&
            !(oneTakeDuration(definer) > 0)) {
            definer = null;
        }
    } else {
        // Q13 FOR GROUPS (the fractal twin): the DEFINER STACK is the
        // stack whose direct clip children
        // are the island's only committed content, one take (N mics).
        definer = committedClips.length === 1 ? committedClips[0]
            : committedClips.length >= 2 ? definerStackOf(nodes) : null;
    }
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
    // A DEFINER STACK whose window lives on its members instead (a
    // group take committed against a survived Q carries its
    // commit-time loop region on each clip — states written without
    // the engine's group-window lift, reconcileTakes): the selection
    // the ear hears is the members' common window. Without this the
    // trim view would draw the full take selected while the members
    // loop a half of it.
    const memberSel = definerNode && definerNode.type === 'stack' &&
        !(definerNode.loopEnd > definerNode.loopStart)
        ? memberCommonWindow(definerNode) : null;
    const defHasSel = !!definerNode &&
        (definerNode.loopEnd > definerNode.loopStart || !!memberSel);
    const selStart = memberSel ? memberSel[0] : (definerNode ? definerNode.loopStart : 0);
    const selEnd = memberSel ? memberSel[1] : (definerNode ? definerNode.loopEnd : 0);
    const defSelStartQ = defHasSel ? selStart / quantum : 0;
    const defSelEndQ = !definerNode ? 0
        : defHasSel ? selEnd / quantum
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
            // A one-shot member reads its period from CONTEXT — the
            // stack is not "one take looping as one part" (matches
            // oneTakeDuration and the engine's definerStack).
            if (n.periodSource === 'context') return null;
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

/** The one ACTIVE sub-window every committed direct clip child of
 * `stack` shares ([start, end] samples), or null when they are whole,
 * differ, or any is bypassed. */
function memberCommonWindow(stack) {
    let win = null;
    for (const c of stack.nodes || []) {
        if (c.type !== 'clip' || c.isRecording || !(c.duration > 0)) continue;
        const ls = c.loopStart || 0;
        const le = Math.min(c.loopEnd || 0, c.duration);
        if (!nodeWindowActive(c) || c.loopBypassed || !(le > ls)) return null;
        if (ls === 0 && le >= c.duration) return null;  // whole
        if (!win) win = [ls, le];
        else if (win[0] !== ls || win[1] !== le) return null;
    }
    return win;
}

/** A node by id anywhere in the published tree (children ride
 * `nodes`, engine and mock alike — never `children`). Used for the
 * published definerId here and by app.js's post-commit verification. */
export function findNodeInTree(nodes, id) {
    for (const n of nodes || []) {
        if (n.id === id) return n;
        if (n.type === 'stack') {
            const hit = findNodeInTree(n.nodes, id);
            if (hit) return hit;
        }
    }
    return null;
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
 * leaves the atomics stale (the frame would stay 4Q while the engine
 * wraps at a 3Q cell period: the cursor sweeps 3Q of a 4Q ruler and
 * the next rep leaks into the phantom quarter).
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
 * LAW 13 AMENDED (session_view.md): a clip's ACTIVE map IS its
 * displayed material (heard view), so it contributes the map period —
 * the display frame equals the audible loop and the one cursor is
 * honest everywhere. (Law 13's hidden-content concern is answered by
 * the expand-to-edit view.)
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
 * display frame IS the audible cycle (an intrinsic frame would sweep
 * the cursor over material the island never plays). A stack
 * contributes stackEffectivePeriod (window, else sequence — the period
 * law, steps concatenate, never LCM — else its inner LCM); a clip its
 * map period or commensurate duration. Clip contributions are
 * COMMENSURATE (timeline_model.commensuratePeriod): a Q13-trimmed
 * definer's raw buffer length is a multiple of the PRE-TRIM Q, and
 * LCM-ing it would explode the frame the moment take 2 arms (waveforms
 * vanish behind the maxTiles guards). The lane still RENDERS its true
 * fractional extent (intrinsicQ) — only the shared frame math sees the
 * whole-Q contribution.
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
        if (publishedNodeDrifts(n, quantum)) return;  // Q22: drifting excluded
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

/** Total PROGRAM length in samples (visits CONCATENATE — S10, §14). */
function seqTotalSamples(s) {
    return sequenceTotalSamples(s);
}

/** The ACTIVE sequence length in samples (0 = none/bypassed) — the
 * timeline_model rule, applied to a holder (node or the root state). */
function activeSeqSamples(holder) {
    return activeSequenceSamples(holder);
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
const vmPeriodProviders = {
    mapPeriod: n => (n.windowActive ? nodeMapPeriod(n) : 0),
    seqLen: activeSeqSamples,
    children: n => n.nodes || [],
};
function effectivePeriod(node, quantum) {
    // THE PERIOD LAW (timeline_model.periodContribution) over the
    // published node shape, with the island Q for the drift clause.
    return periodContribution(node, { ...vmPeriodProviders, quantum });
}

/**
 * Is `n`'s map AUTHORED — active, not suspended by a sequence (S16),
 * not a step audition's derived window (a monitoring loop, not a
 * part)? The heard view, the seat and the top all read this one
 * verdict. `m` is mapOf(n).
 */
function mapAuthored(n, m) {
    return !!(m && m.active && !m.suspended && !isAuditionWindow(n));
}

/**
 * The kept set a node PLAYS, as sample pairs: its authored map (the
 * segments override, else the single window), else the whole take.
 */
function keptSegs(n, authored) {
    if (!authored) return [[0, n.duration || 0]];
    if (n.segments && n.segments.length >= 4) {
        const segs = [];
        for (let i = 0; i + 1 < n.segments.length; i += 2) {
            segs.push([n.segments[i], n.segments[i + 1]]);
        }
        return segs;
    }
    return [[n.loopStart || 0, n.loopEnd || 0]];
}

/**
 * THE TOP (loop_selection.md §9.3): the loop's one, a raw sample `T`
 * of the take, which sounds at its MOMENT
 *
 *   origin + a0 + heardOffset(segs, T)        a0 = segs[0][0]
 *
 * `T` is the published EFFECTIVE top (`loopTop`, engine and mock):
 * the stored top while the kept set still plays it, else the region
 * start. An old engine publishes none, and a top outside the kept set
 * (a preview the reconcile has not seen yet) cannot sound — both read
 * as the region start, a0, which is where every top sat before
 * Phase 2, so such a state derives exactly as it always did. Stacks
 * store no top in Phase 2: theirs is the region start. In samples:
 * { a0, top: T as read, heard: its heard offset, periodS: Σ segs }.
 */
function topOf(n, authored) {
    const segs = keptSegs(n, authored);
    const a0 = segs.length ? segs[0][0] : 0;
    const periodS = segs.reduce((p, [s, e]) => p + (e - s), 0);
    const T = n.type === 'stack' ? NaN : n.loopTop;
    const heard = Number.isFinite(T) ? heardOffsetOf({ segs }, T) : -1;
    return heard >= 0 ? { a0, top: T, heard, periodS }
                      : { a0, top: a0, heard: 0, periodS };
}

/**
 * THE FRAME ZERO (docs/frame.md): the shared frame's left edge is not
 * a published fact — it is SEATED from the lanes in the order they are
 * shown. The first lane's top is the top; each next lane pulls the zero
 * forward by whole cycles-so-far until its own top lies inside the
 * current cycle, so it lands at the left edge whenever a whole
 * cycle-so-far reaches it and otherwise at its offset, wrap ghosted.
 *
 *   Z₁ = [top₁]grid      Zₖ = Zₖ₋₁ + Cₖ₋₁·⌊([topₖ]grid − Zₖ₋₁) / Cₖ₋₁⌋
 *   Cₖ = lcm(Cₖ₋₁, periodₖ)
 *   top = origin + a0 + heardOffset(segs, T)   (the ↺'s MOMENT, topOf)
 *   [x]grid = gridPhase + ⌊(x − gridPhase)/Q + ¼⌋·Q
 *
 * So the zero lands on the first lane's bar lines (every Q for a 1Q
 * scratch loop, every 4Q under a 4-bar bass) at or just before the ↺:
 * the line AT OR BEFORE a top, with a top up to ¼Q early a PICKUP to
 * the next line (SEAT_PICKUP_Q). A take pulled a hair early does not
 * throw the picture back a whole Q, and a take a little late shows its
 * top just after the left edge — never wrapped to the right end.
 *
 * This replaced Phase 1's NEAREST line (2026-09-24). Nearest existed
 * so a map drag's release showed the picture the drag pin showed; the
 * EDIT HOLD now guarantees that for every edit (session_view/
 * frame_hold.js — while a lane is selected the zero never re-seats),
 * so the seat takes over only when the frame SETTLES — at deselect, at
 * arm, on a selection change, animated — or with nothing selected. A
 * seat that reads ½–1Q late as a pickup at the RIGHT end, as nearest
 * did, is the wrong picture to settle on. Pinned by
 * ui/js/tests/frame_seat.test.mjs.
 *
 * The root seats first when it carries a song — the song owns the
 * frame, and its length is the first cycle-so-far. A group with a
 * window or a song seats as ONE lane (its pass is what its members are
 * heard through) from its region start — stacks store no top; a plain
 * group is transparent — its members seat in the order shown, exactly
 * as top-level lanes do, so a take recorded into a group starts at the
 * left edge just as one recorded loose would. One-shots do not seat
 * (their offset IS their placement, Q5), nor do drifting loops (Q22:
 * every pass lands their top somewhere else). A recording take seats by its
 * top alone: its period is unknown until stop and must not move the
 * lanes after it as it grows. An unanchored stack has no content and
 * no top. The zero is always on the Q grid, so the arm marker and
 * every tile stay grid-true whatever a ⌥-slid window start or a free
 * re-time (a sub-Q origin) does.
 *
 * The growth re-base, the cycle-top rule and the free-move law are
 * this seating, read off the lanes; the mock and the engine share it
 * here and store no frame zero of their own.
 *
 * @returns {number|null} the frame zero in samples, or null with nothing to seat
 */
function seatFrameZero(state, nodes, quantum, gridPhase) {
    const seats = [];
    const rootSeq = activeSeqSamples(state);
    if (rootSeq > 0) {
        seats.push({ top: rootSongTop(state), period: lcm(quantum, Math.round(rootSeq)) });
    }
    const visit = ns => (ns || []).forEach(n => {
        if (n.periodSource === 'context') return;
        // A DRIFTING loop (Q22) has no top that stays put in the frame —
        // each pass lands it elsewhere — so it never seats.
        if (publishedNodeDrifts(n, quantum)) return;
        const authored = mapAuthored(n, mapOf(n, quantum));
        if (n.type === 'stack') {
            if (!n.anchored) return;
            if (authored || activeSeqSamples(n) > 0) {
                seats.push({ top: (n.origin || 0) + topOf(n, authored).a0,
                             period: stackEffectivePeriod(n, quantum) });
            } else {
                visit(n.nodes);
            }
        } else {
            if (!(n.duration > 0)) return;
            const t = topOf(n, authored);
            seats.push({ top: (n.origin || 0) + t.a0 + t.heard,
                         period: n.isRecording ? 0 : clipCycleContribution(n, quantum) });
        }
    });
    visit(nodes);
    if (!seats.length) return null;
    const grid = x => gridPhase +
        Math.floor((x - gridPhase) / quantum + SEAT_PICKUP_Q + EPS) * quantum;
    let zero = grid(seats[0].top);
    let cycle = quantum;
    seats.forEach((s, i) => {
        // The zero and every cycle-so-far are on the Q grid, so pulling
        // by the lane's grid top keeps the zero there too.
        if (i > 0) zero += cycle * Math.floor((grid(s.top) - zero) / cycle);
        const p = Math.round(s.period || 0);
        if (p > 0) cycle = lcm(cycle, p);
    });
    return zero;
}

/**
 * THE SETTLE's path (docs/frame.md §1): the frame zero at linear
 * progress `t` ∈ [0, 1] of a glide from `from` to the seat `target`.
 * The glide runs the SHORTEST WAY round the frame: to the
 * representative of the target (mod the frame length `frameSamples`)
 * nearest `from` — every lane's period divides the frame, so all
 * representatives draw the same picture, and a settle never sweeps
 * more than half a frame. easeInOut (cubic), and at t = 1 the zero is
 * the seat itself, exactly. Exported for the tests.
 */
export function settleZero(from, target, frameSamples, t) {
    if (!(t < 1)) return target;
    const via = settleLanding(from, target, frameSamples);
    return from + (via - from) * easeInOut(Math.max(0, t));
}

/** Where a settle from `from` lands: the representative of the seat
 * `target` (mod the frame) nearest `from` — the glide's own end, whose
 * picture is the seat's. The ruler names its lines from it. */
export function settleLanding(from, target, frameSamples) {
    return frameSamples > 0
        ? from + posMod(target - from + frameSamples / 2, frameSamples) - frameSamples / 2
        : target;
}

/** Cubic ease-in-out (the prototype's settle curve). */
export function easeInOut(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

/**
 * THE ROOT'S SONG TOP (docs/frame.md §4): the root is anchored while
 * it carries a song — at the zero the view had seated when the song
 * was authored (Q18 at depth 0; the engine's setSequence and the mock
 * twin) — and its song folds from that origin, the same place the
 * root seats first from. Unanchored (no song; a state from before the
 * rule), the root's frame is the island zero.
 */
function rootSongTop(state) {
    if (state.anchored && Number.isFinite(state.origin)) return state.origin;
    return state.islandZero ?? state.origin ?? 0;
}

/**
 * The cursor while a take grows: the transport, unwrapped, folded back
 * by WHOLE committed cycles so the take's start sits in the cycle it
 * started in — the bar then runs past the committed cycle and the frame
 * extends to hold it (computeRecordingFrame). The start (clock minus
 * captured length) is snapped to a whole Q before the fold (Q11): the
 * pre-record latency compensation baked into live duration must not
 * tip the fold, while the cursor itself keeps it, so the bar trails
 * the cursor by exactly that compensation — truthful monitoring delay
 * (E-E). One rule for plain takes, takes through a map, takes inside a
 * group and new takes of a slot. Null when no take has captured audio.
 *
 * The fold is read against `restZero` — the zero the frame rests on,
 * always on the Q grid — and the position against the zero drawn:
 * they differ only while the frame SETTLES (a take arming releases the
 * edit hold, frame.md §1), and a glide's fractional zero must slide the
 * bar with the lanes, never tip it into another cycle.
 */
function recordingHeadQ(nodes, rawClock, zero, quantum, lcmQ, restZero = zero) {
    let head = null;
    const posQ = (rawClock - zero) / quantum;
    const restQ = (rawClock - restZero) / quantum;
    const visit = ns => (ns || []).forEach(n => {
        if (n.type === 'stack') { visit(n.nodes); return; }
        if (!n.isRecording || !(n.duration > 0)) return;
        const anchorQ = Math.round(restQ - n.duration / quantum);
        const foldQ = lcmQ > 0 ? Math.floor(anchorQ / lcmQ) * lcmQ : 0;
        const q = Math.max(0, posQ - foldQ);
        head = head === null ? q : Math.max(head, q);
    });
    visit(nodes);
    return head;
}

/**
 * GROWING FRAME: while recording, the frame extends one whole Q at a
 * time to hold the growing cursor, and settles to its final size the
 * moment the commit boundary is known. The take's place in the frame
 * is the seating's (seatFrameZero): it starts in the cycle it started
 * in, and nothing else moves.
 *
 * @param {Object} args { nodes, quantum, qEstablished, anyRecording,
 *                        lcmQ, playheadQ }
 * @returns {{frameQ: number, playheadQ: number}}
 */
function computeRecordingFrame({ nodes, quantum, qEstablished, anyRecording,
                                 lcmQ, playheadQ }) {
    let frameQ = lcmQ;
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
            if (allAwaiting && settleSamples > 0) {
                // FINISHING: the frame settles to its FINAL size NOW —
                // extending to ceil(playhead) while the cursor runs past
                // the known commit boundary would make room for a Q the
                // take never uses, then snap back at commit (a layout
                // stretch/squish). The playhead clamps at the frame edge
                // for the ≤1 poll before the engine wraps it.
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
    return { frameQ, playheadQ };
}

/**
 * FRAME PIN: while a map gesture is live, the shared frame holds at
 * its drag-start value — live commits change the audible cycle, and
 * letting the frame follow would re-scale the whole timeline under the
 * pointer. Settles on release. (The frame ZERO is pinned by the caller
 * the same way: opts.pinZero replaces the seating for the gesture.)
 *
 * @param {Object} args { opts, rawClock, zero, quantum, qEstablished,
 *                        anyRecording, frameQ, loopSamples, playheadQ }
 * @returns {{framePinned: boolean, frameQ: number, loopSamples: number,
 *            playheadQ: number}}
 */
function applyFramePin({ opts, rawClock, zero, quantum, qEstablished,
                         anyRecording, frameQ, loopSamples, playheadQ }) {
    const framePinned = opts.pinFrameQ > 0 && qEstablished && !anyRecording;
    if (framePinned) {
        frameQ = opts.pinFrameQ;
        // CURSOR CONTINUITY THROUGH LIVE COMMITS: every live map commit
        // can change the audible cycle the cursor folds on — the white
        // cursor would jump at each commit. The raw clock is the
        // invariant; fold it on the fold cycle PINNED at drag start
        // (the audible cycle of that moment — matching the cursor's
        // pre-grab sweep exactly, jumpless at the grab too).
        const foldQ = opts.pinFoldQ > 0
            ? Math.min(opts.pinFoldQ, frameQ) : frameQ;
        if (rawClock !== null) {
            playheadQ = posMod((rawClock - zero) / quantum, foldQ);
        }
        // The ANIMATOR wraps on loopCycleQ — pin it with the frame or
        // the 60fps line still folds at every live commit (a continuous
        // readout with a jumping LINE).
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
    // [0, 1Q), where island phase 0 is the selection's top (the trim
    // re-establishes the zero at the performance moment of the window
    // top, and the origins ride with it — the content-frame law,
    // docs/time_maps.md; the "zero = origin + loopStart" identity
    // holds only at the moment of the trim). Map the ONE playhead
    // (I8) into the buffer frame: heard position = selection
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
    // phase), the root audition's pattern. (Authored windows need no
    // such mapping: a windowed group lane shows its HEARD material
    // from frame 0, like a windowed clip, so island phase IS lane
    // position.)
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
 * Ruler tick marks — the ruler's and every lane's gridlines: the
 * island's Q lines across the frame drawn, only when Q exists and stays
 * drawable (a first take's frame is cycleQ ≈ its sample count — no
 * grid, and no DOM explosion).
 *
 * THE GRID RIDES THE ZERO (loop_selection.md §9.4, 2026-09-24): a line
 * sits at (line − zero) / Q, so while the frame SETTLES — its zero
 * gliding between grid lines for 560 ms — the ruler and the gridlines
 * scroll with the tiles, the cursor and the arm marker, and the whole
 * picture moves as one (the prototype's drawFrameGrid). `offQ` is how
 * far past a line the zero drawn sits (phiQ): 0 at rest, where the
 * lines fall on whole Qs from the left edge as they always have.
 *
 * Each line is NAMED in the frame it lands in, the way the prototype's
 * drawRuler labels from the settle's target: `toZeroQ` is the landing
 * zero minus the zero drawn (0 at rest). `at` is where the line rests
 * once the frame lands — its label and whether it is a major, every
 * 4Q — and `end` marks the landing frame's wrap (the cycle-end label).
 * A line keeps its name all the way through the glide: the numbers
 * ride their lines instead of swapping under them.
 *
 * @param {boolean} qEstablished
 * @param {number} cycleQ   display frame length in Q
 * @param {number} [offQ]   the zero drawn past its grid line, Q in [0, 1)
 * @param {number} [toZeroQ] the landing zero minus the zero drawn, Q
 * @returns {Array<{q: number, major: boolean, at: number, end: boolean}>}
 */
export function buildRulerTicks(qEstablished, cycleQ, offQ = 0, toZeroQ = 0) {
    const ticks = [];
    if (qEstablished && Number.isInteger(cycleQ) && cycleQ > 0 && cycleQ <= 64) {
        for (let k = offQ > 0 ? 1 : 0; k - offQ <= cycleQ + EPS; k++) {
            const q = k - offQ;
            // Lines and landing zeros are on the grid: a whole Q, up to
            // fp noise.
            const L = posMod(Math.round(q - toZeroQ), cycleQ);
            const end = L === 0 && q > EPS;
            const at = end ? cycleQ : L;
            ticks.push({ q, major: at % 4 === 0, at, end });
        }
    }
    return ticks;
}

/**
 * ONE-SHOT display (Q5 / recording.md Example 3; groups too since Q18,
 * composition.md §9): NO ghost repetitions — the take tile alone marks
 * the one firing per cycle; the rest of the lane is honest silence.
 * …except under a SEQUENCED (or otherwise shorter) scope cycle (§12.2):
 * the hit fires once per pass of that cycle, so its echoes tile at the
 * scope period — what sounds, shown. Shared by clip and group lanes.
 */
function oneShotReps(reps, lanePeriodQ, scopeQ, cycleQ) {
    reps = reps.filter(r => !r.ghost);
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
    return reps;
}

/**
 * MEMBERS OF A ONE-SHOT GROUP draw whole beneath it (composition.md
 * §9, G-2): the group's children render only while the group's phase
 * is inside its shot — so a member's tiles outside the shot span
 * [startQ, startQ + lenQ) (wrapped in the frame) are silence and are
 * dropped. A one-take member keeps exactly its take tile.
 */
function withinShot(reps, shot, cycleQ) {
    if (!shot || !(shot.lenQ > 0)) return reps;
    const spans = [[shot.startQ, Math.min(cycleQ, shot.startQ + shot.lenQ)]];
    if (shot.startQ + shot.lenQ > cycleQ + EPS) {
        spans.push([0, shot.startQ + shot.lenQ - cycleQ]);
    }
    return reps.filter(r => spans.some(([a, b]) =>
        Math.min(r.endQ, b) - Math.max(r.startQ, a) > EPS));
}

/**
 * Group (stack) lane + its children (recursive via pushLane).
 *
 * offsetQ: the stack's tiling-grid phase in the frame — (origin − zero)
 * in Q, rotated by the recording shift (pushLane computes it exactly
 * as for a clip). GROUP LANES GET A TAKE MARK (Q18, composition.md
 * §9): an ANCHORED stack's lane x is that phase, exactly a clip's
 * takeStartQ; brackets, dims, cut bands and the heard-time cursor on
 * the lane are INNER positions offset by it. An unanchored stack (no
 * committed content yet) measures from its received cycle top — its
 * mark is 0, the empty case.
 */
/** Fold is UI-local view state (I6b): the app shell's folded set
 * (view_prefs.js), never a node field the engine publishes. */
function isFolded(node, ctx) {
    return !!(ctx.folded && ctx.folded.has(node.id));
}

function pushGroupLane(node, depth, mapCtx, ctx, offsetQ = 0) {
    const { quantum, cycleQ, qEstablished, fxOpen, lanes, state, lcmQ } = ctx;
    if (ctx.provisionalDefiner && node.id === ctx.soleQDefinerId) {
        // Q13 FOR GROUPS: the definer stack renders the same trim view
        // a sole clip does — the whole take with the selection over it
        // — and its children show their whole takes beneath (no map
        // context: the selection is Q being defined, not a part).
        pushDefinerLane(node, depth, ctx);
        if (!isFolded(node, ctx)) {
            // The mics draw in the same BUFFER frame as the definer
            // lane above them (one full tile from 0 — the trim view
            // ignores the zero, which the re-trim moves under them);
            // tiling them on the zero grid would draw the take shifted
            // by the fold offset, half a Q off the composite over it.
            (node.nodes || []).forEach(c => {
                if (c.type === 'clip' && !c.isRecording && c.duration > 0) {
                    const fullQ = intrinsicPeriodQ(c, quantum);
                    // Whole takes in the buffer frame, like the definer
                    // lane: a raw position IS the lane position.
                    const topQ = topOf(c, mapAuthored(c, mapOf(c, quantum))).top / quantum;
                    lanes.push(Object.assign(laneCommon(c, state), {
                        kind: 'clip', depth: depth + 1,
                        periodQ: fullQ, intrinsicQ: fullQ,
                        reps: [{ startQ: 0, endQ: fullQ, ghost: false }],
                        takeStartQ: 0, window: null, windowPhase: 0,
                        armable: false, bandEditable: false,
                        inputChannel: c.inputChannel ?? -1,
                        topQ, topHeardQ: topQ,
                        retimeQ: Number.isFinite(c.retime) ? c.retime / quantum : 0,
                        canRetime: false,
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
    // (§12.2: a sequenced group lane tiles in SONG coordinates, so a
    // nested audition's derived brackets land where they mean.)
    const gwin = mapOf(node, quantum);
    const intrinsicQ = intrinsicPeriodQ(node, quantum);
    const editable = qEstablished && intrinsicQ >= 2 && !subtreeRec(node);
    // THE ANCHOR (Q18): an anchored stack's origin is a stored fact the
    // engine publishes; the VM reads it and never derives it.
    const anchored = !!node.anchored;
    const gOffsetQ = anchored ? offsetQ : 0;
    const relQ = anchored
        ? ((node.origin || 0) - ctx.frameZero) / quantum : 0;
    const oneShot = node.periodSource === 'context';
    const groupFields = {
        kind: 'group',
        depth,
        folded: isFolded(node, ctx),
        groupArm: groupArmState(node),
        // The map cue on the MAPPING group itself: a take is
        // recording through this window right now.
        mapRecording: !!(gwin && gwin.active && subtreeRec(node)),
        mapSuspended: !!(gwin && gwin.suspended),  // S16
        anchored,
    };
    let lane;
    if (gwin && gwin.active && !gwin.suspended &&
        !isAuditionWindow(node)) {
        // THE HEARD VIEW — the same default a windowed clip has (I5):
        // the lane's material IS the window's
        // content, tiled at the window length where it audibly
        // sounds. ONE ANCHORING LAW (Q18, composition.md §2): the
        // window content's start sounds at origin + a0 — the heard top
        // within the period is posMod(offset + a0, period), exactly a
        // windowed clip's (pushHeardClipLane). Chip + edge grips +
        // seams are the chrome; the raw inner cycle is one grab away.
        const heardTopQ = periodQ > 0
            ? posMod(gOffsetQ + gwin.segs[0][0], periodQ) : 0;
        lane = Object.assign(laneCommon(node, state), groupFields,
            heardViewFields({ win: gwin, lanePeriodQ: periodQ, intrinsicQ,
                              heardTopQ, cycleQ, qEstablished,
                              editable, locked: ctx.mapEditsLocked }));
        if (oneShot) {
            lane.reps = oneShotReps(lane.reps, periodQ, ctx.scopeCycleQ || 0,
                                    cycleQ);
        }
    } else {
        // Take marking for the group (Q14's rule, as for a clip without
        // a contextCycle): an era stack (origin ≥ zero) marks its
        // performed cycle position; a pre-zero one marks the first
        // full repetition.
        const takeQ = anchored && relQ >= 0 && lcmQ > 0
            ? posMod(gOffsetQ, lcmQ) : undefined;
        let reps = qEstablished
            ? unrollReps({ periodQ, offsetQ: gOffsetQ, cycleQ, takeQ })
            : [];
        // A ONE-SHOT GROUP renders like a one-shot clip (composition.md
        // §9): the dashed composite tile at its take mark, no ghosts.
        if (oneShot) reps = oneShotReps(reps, periodQ, ctx.scopeCycleQ || 0, cycleQ);
        lane = Object.assign(laneCommon(node, state), groupFields, {
            periodQ,
            // The window EDIT range: [0, inner cycle] — the brackets'
            // clamp bound.
            intrinsicQ,
            // Before Q exists there is nothing meaningful to tile.
            reps,
            // The take tile's frame position: the CONTENT-frame origin
            // of this lane (Q18 — a group's take mark, like a clip's).
            // Window brackets/dims/bands anchor here.
            takeStartQ: (reps.find(r => !r.ghost) || { startQ: 0 }).startQ,
            // A bypassed/suspended map over the raw inner cycle:
            // multi-segment maps draw dims + one chip, never
            // brackets (geometry edits live in the editor); single
            // windows keep the bracket overlay (dimmed, says why).
            // Under a STEP AUDITION the published window is DERIVED
            // (song coordinates, §11.2): drawn, never draggable — a
            // drag would write it back as the AUTHORED window, which
            // returns unchanged (and surprising) when the audition
            // ends. wireWindow skips `audition` windows.
            window: gwin && gwin.multi ? null
                : (gwin && isAuditionWindow(node)
                    ? Object.assign({}, gwin, { audition: true }) : gwin),
            mapSegs: gwin && gwin.multi ? gwin.segs : null,
            mapBypassed: !!(gwin && gwin.bypassed),
            mapChipQ: gwin && gwin.multi ? gwin.periodQ : 0,
            windowPhase: 0,
            // CUT BANDS (phase 3, owner-chosen design A) over the raw
            // inner cycle: bypassed maps keep their bands visible
            // (geometry survives bypass; the chip says so).
            bandSegs: gwin ? gwin.segs : null,
            bandTotalQ: intrinsicQ,
        }, bandGate(editable, ctx.mapEditsLocked));
    }
    // THE TOP (topFields' group twin): a stack stores none in Phase 2 —
    // its top is the region start, first heard at the lane's heard top
    // (0 for an unanchored stack) — and a group is never re-timed.
    {
        const a0Q = mapAuthored(node, gwin) ? gwin.segs[0][0] : 0;
        Object.assign(lane, {
            topQ: a0Q,
            topHeardQ: periodQ > 0 ? posMod(gOffsetQ + a0Q, periodQ) : 0,
            retimeQ: 0,
            canRetime: false,
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
        lanes.push(seqRow(node, depth + 1, quantum, qEstablished, relQ));
    }
    if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
    // The nearest enclosing active map wins (engine parity).
    // segs + the group's cycle ride along so child lanes can
    // project the excluded regions as dims (phase-3 conservative
    // step toward the heard-frame child unroll).
    const ownMap = gwin && gwin.active
        ? { periodQ: gwin.periodQ, startQ: gwin.segs[0][0],
            segs: gwin.segs,
            // THE MAP'S FRAME ORIGIN (Q18): the segments are inner
            // positions from THIS group's origin, not from the zero.
            // A member's slice is measured from here (found by the
            // engine e2e harness, 2026-09-09: a group anchored 1Q past
            // the zero drew its members' tiles one Q off).
            originQ: relQ,
            // The map's coordinates: the group's SONG when sequenced
            // (S9 — the map selects song positions), else its inner
            // cycle (never the window itself — the map selects OVER
            // this domain).
            groupCycleQ: activeSeqSamples(node) > 0
                ? activeSeqSamples(node) / quantum : intrinsicQ }
        : null;
    // Children of a group with an ACTIVE window live in the window's
    // re-based inner frame (time_maps.md §2): pushLane hands them the
    // map context and they unroll the parent's slice
    // (childSrcSegsUnderMap, `lane.underMap`).
    if (!lane.folded) {
        const childFrom = lanes.length;
        // The SCOPE CYCLE the children hear (engine: context_cycle —
        // the song when sequenced, else the lcm of the looping
        // members, else inherited). One-shot lanes echo at it (§12.2).
        const prevScope = ctx.scopeCycleQ;
        ctx.scopeCycleQ = scopeCycleQOf(node, quantum, prevScope);
        // A ONE-SHOT GROUP's children sound only inside its shot
        // (composition.md §2 rest region): member lanes keep the tiles
        // within it — drawn whole beneath the dashed group tile.
        const prevShot = ctx.oneShotShot;
        ctx.oneShotShot = oneShot && !lane.windowEditing
            ? { startQ: lane.takeStartQ || 0, lenQ: lane.periodQ || 0 }
            : null;
        // THE WARP GUARD (canDefineNode): beneath an active map, a song
        // or a one-shot's fold, time is remapped — no member can take Q.
        const prevWarp = ctx.underWarp;
        ctx.underWarp = prevWarp || nodeWindowActive(node) ||
            activeSeqSamples(node) > 0 || oneShot;
        (node.nodes || []).forEach(c =>
            pushLane(c, depth + 1, ownMap || mapCtx, ctx));
        ctx.underWarp = prevWarp;
        ctx.oneShotShot = prevShot;
        ctx.scopeCycleQ = prevScope;
        // An ACTIVE sequence projects its gates onto the child lanes as
        // dims (the display side of the period law — sequencer.md §9:
        // you READ the song on the lanes, you EDIT it in the grid).
        {
            const s = seqOf(node);
            if (s && !s.bypassed) {
                // Anchored at the group's origin (Q18) — `relQ` is that
                // origin in the lane frame (0 while unanchored).
                attachSeqDims(lanes, childFrom, lanes.length,
                    node.nodes, s, quantum, relQ);
            }
        }
        // Synthetic affordance row: "+ add track" at the bottom of
        // the open group.
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
 * the selection over a stable waveform. Q/zero update live
 * underneath (the engine); this view just doesn't collapse until a
 * second take locks it.
 */
function pushDefinerLane(node, depth, ctx) {
    const { quantum, fxOpen, lanes, state, defSelStartQ, defSelEndQ } = ctx;
    // A clip's buffer, or — Q13 for groups — the definer stack's inner
    // cycle (the composite of its one take).
    const fullQ = intrinsicPeriodQ(node, quantum);
    // The top sits in the BUFFER frame this lane draws from 0, so its
    // raw position IS its lane position. Never re-timed: the definer's
    // origin is the island zero.
    const topQ = topOf(node, mapAuthored(node, mapOf(node, quantum))).top / quantum;
    lanes.push(Object.assign(laneCommon(node, state), {
        kind: node.type === 'stack' ? 'group' : 'clip',
        depth,
        periodQ: fullQ,
        intrinsicQ: fullQ,          // drag/dim extent = the whole buffer
        reps: [{ startQ: 0, endQ: fullQ, ghost: false }],  // one full tile
        takeStartQ: 0,              // buffer starts at frame 0 (ignore zero)
        window: { startQ: defSelStartQ, endQ: defSelEndQ,
                  active: true, bypassed: false, latent: false },
        // No per-lane heard-time cursor: the MAIN playhead is
        // mapped into the selection (one playhead, I8) — a
        // second amber cursor sweeping the same span would read
        // as two cursors.
        windowPhase: 0,
        // The sole clip's ● is a NEW TAKE like any committed clip's
        // (the take keeps the provisional Q); a definer stack's ● is
        // its group aggregate.
        armable: node.type === 'clip' ? isArmable(node) : false,
        armMode: node.type === 'clip' ? armMode(node) : null,
        inputChannel: node.inputChannel ?? -1,
        topQ,
        topHeardQ: topQ,
        retimeQ: Number.isFinite(node.retime) ? node.retime / quantum : 0,
        canRetime: false,
        isQDefiner: true,
        folded: node.type === 'stack' && isFolded(node, ctx),
        groupArm: node.type === 'stack' ? groupArmState(node) : undefined,
    }, node.type === 'stack' ? {} : takeFields(node, quantum, ctx)));
    if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
}

/**
 * Recording clip lane. The bar is [playhead − length, playhead]: under
 * the masterPos contract the playhead IS the take's end, and the
 * engine grows `duration` live while writing. Zero length = pending
 * start (armed, waiting for the Q boundary).
 *
 * A NEW TAKE of a committed slot (docs/takes.md §2; opts.retakes names
 * the lane) keeps the slot's `duration`, so the bar's length is the
 * distance from the slot's top instead: capture starts at t ≡ origin
 * (mod period) and runs exactly one period. The resting tiles stay,
 * flagged `silent` — the engine renders silence for the slot while
 * the take is live — and `armAtQ` marks the slot top a pending take
 * waits for.
 */
function pushRecordingLane(node, depth, mapCtx, ctx, offsetQ) {
    const { quantum, fxOpen, lanes, state } = ctx;
    const retake = !!(ctx.retakes && ctx.retakes.has(node.id)) &&
        (node.duration || 0) > 0;
    let reps = [];
    let recordingLengthQ = (node.duration || 0) / quantum;
    let pendingStart = !(node.duration > 0);
    let armAtQ = 0;
    if (retake) {
        const periodQ = intrinsicPeriodQ(node, quantum);
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
    lanes.push(Object.assign(laneCommon(node, state), {
        kind: 'clip',
        depth,
        periodQ: 0,
        intrinsicQ: retake ? intrinsicPeriodQ(node, quantum) : 0,
        takeStartQ: (reps.find(r => !r.ghost) || { startQ: 0 }).startQ,
        reps,
        window: null,
        armable: true,
        armMode: 'stop',
        inputChannel: node.inputChannel ?? -1,
        recordingLengthQ,
        pendingStart,
        retake,
        armAtQ,
        // Recording THROUGH an enclosing map (phase 2): the cue
        // hooks + the bar's cap (the engine commits ≤ one map
        // period).
        throughMap: !!mapCtx,
        mapPeriodQ: mapCtx ? mapCtx.periodQ : 0,
        mapStartQ: mapCtx ? mapCtx.startQ : 0,
    }, retake ? takeFields(node, quantum, ctx) : {},
    // A live take is never re-timed (the recording gate).
    topFields(node, mapAuthored(node, mapOf(node, quantum)), ctx, false)));
    if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
}

/**
 * THE RAW LANE — comp mode's view (docs/takes.md §6): the lane expands
 * to its FULL raw take on its OWN horizontal scale so the comp cells
 * cover the slot's period. Brackets select over the whole extent; the
 * amber cursor carries heard time; the rest of the timeline (and the
 * white cursor) stay in the audible frame. Returns the lane's view
 * fields; the caller adds kind/depth. (Until 2026-09-13 this was also
 * the chip-click "window edit" inspector for clips and groups; the
 * region panel replaced that — time_maps.md.)
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
        ...bandGate(intrinsicQ >= 2, ctx.mapEditsLocked),
        armable: false,
        armMode: null,
        inputChannel: node.inputChannel ?? -1,
    }, node.type === 'stack' ? {} : takeFields(node, ctx.quantum, ctx),
    // The raw lane is comp mode's editor: no ↺ drag on it.
    node.type === 'stack' ? {}
        : topFields(node, !!(win && win.active), ctx, false));
}


/**
 * THE CHILD HEARD UNROLL under an enclosing ACTIVE map: once a
 * windowed group's lane and the frame are the window, its children
 * must show the same slice.
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
function childSrcSegsUnderMap(segsQ, offsetQ, periodQ, intrinsicQ, childMap = null) {
    if (!(periodQ > 0) || !(intrinsicQ > 0) || !segsQ || !segsQ.length) {
        return null;
    }
    const out = [];
    let pieces = 0;
    for (const [s0, e0] of segsQ) {
        let t = s0;
        while (t < e0 - EPS) {
            // The child's HEARD offset at this inner position; with a
            // map of its own (nested maps — a windowed member inside a
            // windowed group) the heard offset selects through it:
            // content = mapOffset(childMap, rel), continuous until the
            // child's next seam (engine parity: the member folds the
            // clock the group hands it on its own map). THE ANCHORING
            // LAW: a clip's map plays from origin + mapOffset(0) — the
            // first segment's start — so the heard offset subtracts it
            // (timing::innerAt; the JS twin in time_map.js).
            const a0 = childMap ? mapOffset(childMap, 0) : 0;
            const rel = posMod(t - offsetQ - a0, periodQ);
            const run = childMap ? seamDistance(childMap, rel) : periodQ - rel;
            const step = Math.min(e0 - t, run);
            if (step <= EPS) break;
            const inner = childMap ? mapOffset(childMap, rel) : rel;
            // The child's content is its raw extent (intrinsicQ); the
            // period may be the commensurate whole-Q — clamp inside.
            const a = Math.min(inner, intrinsicQ);
            const b = Math.min(inner + step, intrinsicQ);
            if (b > a + EPS) out.push([a / intrinsicQ, b / intrinsicQ]);
            t += step;
            if (++pieces > MAX_TILES) return null;
        }
    }
    return out.length ? out : null;
}

/**
 * THE HEARD VIEW — ONE function for clips and groups (I5; a window
 * sets the part's length): an ACTIVE
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
 *                                its own period (content rotation — the
 *                                node's origin + a0 phase; 0 for an
 *                                unanchored group, Q18)
 * @param {number} o.cycleQ       the display frame
 * @param {boolean} o.qEstablished
 * @param {boolean} o.editable    whether the cut/trim chrome is live
 * @param {boolean} o.locked      the recording gate (bandGate)
 */
function heardViewFields({ win, lanePeriodQ, intrinsicQ, heardTopQ, cycleQ,
                           qEstablished, editable, locked }) {
    let reps = qEstablished
        ? unrollReps({ periodQ: lanePeriodQ, offsetQ: 0, cycleQ, takeQ: 0 })
        : [];
    // HEARD tiles sit on the FRAME grid with the loop's phase BAKED IN
    // as content ROTATION: tiling a mid-phase loop from its anchor
    // would split it into a bright tile + a "wrap sliver" drawn dimmed
    // as if it were a repeat — but when the loop fills the frame every
    // pixel is UNIQUE audible content. Rotation keeps each sample at
    // its true island phase (cross-lane alignment, I2) with no sliver.
    // Every rep carries the map's content slices (`srcSegs`) plus
    // `srcTopFrac`.
    const srcSegs = win.segs.map(([s, e]) => [s / intrinsicQ, e / intrinsicQ]);
    const extra = { srcSegs, srcTopFrac: lanePeriodQ > 0 ? heardTopQ / lanePeriodQ : 0 };
    reps = reps.map(r => Object.assign({}, r, extra));
    // A loop that FILLS the frame has no repeats: everything is
    // material, nothing dims. (True repeats — period < frame — keep
    // the echo treatment per "ghosts show what sounds".)
    if (lanePeriodQ >= cycleQ - EPS) {
        reps = reps.map(r => Object.assign({}, r, { ghost: false }));
    }
    return Object.assign({
        periodQ: lanePeriodQ,
        // The lane's material IS the window content, so its extent is
        // the window length (drag/dim math included).
        intrinsicQ: lanePeriodQ,
        reps,
        takeStartQ: heardTopQ,
        window: null,
        windowChipQ: lanePeriodQ,
        mapMulti: !!win.multi,
        // Cut geometry, editable IN PLACE (no modes): heard-view lanes
        // render cuts as SEAM HANDLES (a cut has zero
        // width in heard time — it IS the splice), with the edge grips
        // as live trim handles.
        bandSegs: win.segs,
        bandTotalQ: intrinsicQ,
        bandHeard: true,
        bandPeriodQ: win.periodQ,
        windowPhase: 0,
    }, bandGate(editable, locked));
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
    const { quantum, frameZero, qEstablished, cycleQ, lcmQ,
            fxOpen, lanes, state } = ctx;
    const heard = !!(win && win.active);
    const lanePeriodQ = heard ? win.periodQ : periodQ;
    // The ANCHORING LAW (phase 3): map playback anchors at
    // origin + mapOffset(0) — the first segment's start (its
    // single-segment case is origin + loopStart).
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
    // fold away; the phase survives later frame growth AND zero
    // re-bases (both move by whole multiples of every earlier
    // take's heard cycle). Fallback for states without
    // contextCycle (mock scenarios, first takes): era takes fold by
    // the committed cycle; pre-zero takes mark the first full rep.
    const relQ = ((node.origin || 0) - frameZero) / quantum;
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
    // The lane's own editability, before the recording gate (bandGate).
    const rawEditable = qEstablished && intrinsicQ >= 2 && !node.isRecording;
    let heardFields = heard
        ? heardViewFields({ win, lanePeriodQ, intrinsicQ, heardTopQ, cycleQ,
                            qEstablished, editable: rawEditable,
                            locked: ctx.mapEditsLocked })
        : null;
    // UNDER AN ENCLOSING ACTIVE MAP (no map of its own): the lane shows
    // the slice the parent's map selects of it — the child heard
    // unroll (childSrcSegsUnderMap). One-shots keep their own firing
    // display; the parent owns the chrome (no chip/grips here).
    let underMap = false;
    if (mapCtx && mapCtx.segs && qEstablished &&
        node.periodSource !== 'context' &&
        (heard ? win.periodQ : lanePeriodQ) > 0) {
        // The member's offset INSIDE the map's frame: its origin
        // relative to the mapping group's origin (mapCtx.originQ, Q18),
        // not to the zero — the map's segments are group-inner
        // positions. (Engine parity: StackNode::childContext hands the
        // member t' = O + inner; its content index is t' − origin.) A
        // member with a window of ITS OWN folds that clock through it
        // (nested maps): the slice composes both. Both found by the
        // engine e2e harness, 2026-09-09.
        const childMap = heard ? { segs: win.segs } : null;
        const src = childSrcSegsUnderMap(mapCtx.segs,
            (heard ? offsetQ : laneOffsetQ) - (mapCtx.originQ || 0),
            heard ? win.periodQ : lanePeriodQ, intrinsicQ, childMap);
        if (src) {
            const mapPeriodQ = mapCtx.periodQ;
            // THE GROUP'S ROTATION: the parent's map content sounds
            // from its heard top — origin + a0 within the map period —
            // and the group lane bakes that in as srcTopFrac
            // (heardViewFields). Its members tile the SAME frame, so
            // they carry the same rotation; without it a group whose
            // heard top is off the frame top drew every member a
            // whole (heardTop) early.
            const heardTopQ = posMod((mapCtx.originQ || 0) + (mapCtx.startQ || 0),
                                     mapPeriodQ);
            let reps = unrollReps({ periodQ: mapPeriodQ, offsetQ: 0, cycleQ,
                                    takeQ: 0 });
            reps = reps.map(r => Object.assign({}, r,
                { srcSegs: src, srcTopFrac: mapPeriodQ > 0 ? heardTopQ / mapPeriodQ : 0 }));
            if (mapPeriodQ >= cycleQ - EPS) {
                reps = reps.map(r => Object.assign({}, r, { ghost: false }));
            }
            heardFields = {
                periodQ: mapPeriodQ, intrinsicQ: mapPeriodQ, reps,
                takeStartQ: heardTopQ, window: null,
                // A member's OWN window keeps its chip (the raw editor
                // is frame-independent); the parent owns the rest.
                windowChipQ: heard ? win.periodQ : 0, mapMulti: false,
                bandSegs: null, bandTotalQ: mapPeriodQ, bandHeard: false,
                bandPeriodQ: 0, bandEditable: false, bandLocked: false,
                windowPhase: 0,
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
    // cycle (oneShotReps). The dashed styling rides lane.oneShot in
    // the patch layer.
    if (node.periodSource === 'context') {
        reps = oneShotReps(reps, lanePeriodQ, ctx.scopeCycleQ || 0, cycleQ);
    }
    // Under a ONE-SHOT GROUP: only the tiles inside the group's shot
    // sound (members drawn whole beneath, composition.md §9).
    if (ctx.oneShotShot) reps = withinShot(reps, ctx.oneShotShot, cycleQ);
    if (heardFields) heardFields.reps = reps;  // one-shot filter applied
    lanes.push(Object.assign(laneCommon(node, state), {
        kind: 'clip',
        depth,
        periodQ: lanePeriodQ,
        intrinsicQ,
        // The raw take the srcSegs index — heardFields replaces
        // intrinsicQ with the heard period but never this.
        contentQ: intrinsicQ,
        reps,
        // The take tile's frame position: the CONTENT-frame origin of
        // this lane. Window brackets/dims/cursor (content-relative
        // [loopStart, loopEnd)) anchor here — anchoring at frame 0
        // would draw them a whole phase off for takes not at the top.
        // The take rep's startQ is the unclipped tile start by
        // construction (only tile ENDS get clipped).
        takeStartQ: (reps.find(r => !r.ghost) || { startQ: 0 }).startQ,
        window: win,
        windowChipQ: 0,
        mapMulti: !!(win && win.multi),
        // Cut geometry, editable IN PLACE on every resting lane (no
        // modes). Raw-framed lanes render cuts as BANDS.
        bandSegs: win ? win.segs : null,
        bandTotalQ: intrinsicQ,
        bandHeard: false,
        bandPeriodQ: 0,
        ...bandGate(rawEditable, ctx.mapEditsLocked),
        windowPhase: node.windowActive ? (node.playhead || 0) : 0,
    // HEARD VIEW (the shared function, I5): overrides the raw-framed
    // fields above — period, extent, reps, chip, seams.
    }, heardFields || {}, takeFields(node, quantum, ctx),
    // The ↺ and the timing (topFields): where the top sounds, and
    // whether a ↺ drag may re-time it — or would, but for the
    // recording gate (the ↺ draws inert).
    topFields(node, heard, ctx, retimeable(node, ctx, underMap),
              ctx.mapEditsLocked && retimeableOnceIdle(node, ctx, underMap)), {
        armable: isArmable(node),
        armMode: armMode(node),
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
 * ctx: the per-derivation context: { state, lanes, maxDepth, fxOpen,
 * quantum,
 * frameZero, shiftQ, qEstablished, cycleQ, lcmQ, provisionalDefiner,
 * soleQDefinerId, defSelStartQ, defSelEndQ }.
 */
function pushLane(node, depth, mapCtx, ctx) {
    if (depth > ctx.maxDepth) return;
    const at = ctx.lanes.length;
    const drifting = ctx.qEstablished && publishedNodeDrifts(node, ctx.quantum);
    // THE LANE'S ZERO (Q22): a drifting loop — and, in the trim view
    // with company, every lane but the definer — is drawn from the pass
    // zero, so it shows the pass that sounds; everything else from the
    // frame zero. The subtree inherits it (a group's members tile in the
    // frame their group was drawn in).
    const zero = laneZeroOf(node, ctx, drifting);
    const outer = ctx.frameZero;
    ctx.frameZero = zero;
    try {
        pushLaneFrom(node, depth, mapCtx, ctx);
    } finally {
        ctx.frameZero = outer;
    }
    const lane = ctx.lanes[at];
    if (lane && lane.id === node.id) {
        // ↯ DRIFTING (Q22): its own period fits no whole number of Qs,
        // so each pass lines up differently; the rail says so — unless
        // the only mismatch is a subdivision's sample rounding.
        lane.drifting = drifting;
        lane.driftShown = drifting && !driftsByRoundingOnly(node, ctx.quantum);
        // THE Q LAMP'S OFFER (Q22, setDefiner): this lane could take Q.
        lane.canDefine = canDefineNode(node, ctx);
        // The trim view with company: outside the definer's selection
        // this lane does not play against the definer's buffer this
        // pass (lane_body dims it).
        if (ctx.trimCompany && node.id !== ctx.soleQDefinerId) {
            lane.trimSel = { startQ: ctx.defSelStartQ, endQ: ctx.defSelEndQ };
        }
    }
}

/** The zero a lane is drawn from (pushLane): the pass zero for a
 * drifting loop and for every non-definer lane of the trim view with
 * company, else the frame zero. */
function laneZeroOf(node, ctx, drifting) {
    if (ctx.trimCompany && node.id !== ctx.soleQDefinerId) return ctx.passZero;
    return drifting ? ctx.passZero : ctx.frameZero;
}

/**
 * May Q be handed to `node` (setDefiner, Q22)? The engine's target rules
 * (engine_internal::definer), read off the published shape: Q exists and
 * nothing is live; the node is not the definer already; a committed
 * looping clip, or a group whose committed direct clips are ONE take
 * (two or more, same origin and length, no nested content, no song);
 * and no group above it remaps time (the warp guard).
 */
function canDefineNode(node, ctx) {
    if (!ctx.definerIdle || ctx.underWarp) return false;
    if (node.id === ctx.soleQDefinerId) return false;
    if (node.periodSource === 'context' || node.isRecording || node.isPendingStart) {
        return false;
    }
    if (node.type === 'clip') return (node.duration || 0) > 0;
    if (node.type !== 'stack' || activeSeqSamples(node) > 0) return false;
    if (!(oneTakeDuration(node) > 0)) return false;
    let members = 0;
    let origin = null;
    for (const c of node.nodes || []) {
        if (c.type !== 'clip' || c.isRecording || !(c.duration > 0)) continue;
        if (origin === null) origin = c.origin || 0;
        else if ((c.origin || 0) !== origin) return false;
        members++;
    }
    return members >= 2;
}

/** Whether a committed clip lies outside the definer's subtree — the
 * trim view then shares the screen (Q22: Q was handed to the definer). */
function hasCompany(definer, committedClips) {
    if (!definer) return false;
    const inside = new Set();
    (function visit(n) {
        inside.add(n.id);
        (n.nodes || []).forEach(visit);
    })(definer);
    return committedClips.some(c => !inside.has(c.id));
}

/** pushLane's body: the per-kind dispatch, drawn from ctx.frameZero. */
function pushLaneFrom(node, depth, mapCtx, ctx) {
    // Tile offsets are measured from the seated frame zero (origins are
    // ABSOLUTE; seatFrameZero puts the zero on the Q grid, so tiles stay
    // Q-grid-true; mod-period tiling handles the wrap)
    const offsetQ = ((node.origin || 0) - ctx.frameZero) / ctx.quantum;

    if (node.type === 'stack') {
        pushGroupLane(node, depth, mapCtx, ctx, offsetQ);
        return;
    }
    if (ctx.provisionalDefiner && node.id === ctx.soleQDefinerId) {
        pushDefinerLane(node, depth, ctx);
        return;
    }
    if (node.isRecording) {
        pushRecordingLane(node, depth, mapCtx, ctx, offsetQ);
        return;
    }
    const periodQ = displayPeriodQ(node, ctx.quantum);
    const intrinsicQ = intrinsicPeriodQ(node, ctx.quantum);
    const win = mapOf(node, ctx.quantum);
    // COMP MODE on a windowed lane opens the raw lane (windowEditLane):
    // the comp's cells live on the slot's period, which the heard view
    // folds away. (The only remaining raw-lane view — the chip-click
    // inspector retired 2026-09-13 in favour of the region panel.)
    const compOpen = !!(ctx.compMode && ctx.compMode.has(node.id) && win);
    if (compOpen) {
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
 * PENDING EDITS (session_view/pending_edits.js): a gesture's preview,
 * applied to SHALLOW CLONES of the edited nodes before anything is
 * derived, so tiles, seams, the seat and the lane fields follow the
 * pointer on every move with no bridge round trip (app.js
 * requestRender). Each override takes the shape the engine PUBLISHES
 * once the edit lands (AudioNode::getMetadata; the mock's
 * enrichNodes), so the preview and the landed state derive alike:
 *
 *   - `segments` (flat samples): two or more pairs publish `segments`
 *     with the single-window fields at 0; one pair publishes loopStart
 *     / loopEnd and no `segments`; none clears the map. windowActive
 *     follows (a map, not bypassed — a stack's, not suspended either);
 *   - `originShift` (samples) moves `origin` and `retime` together —
 *     setTiming's effect;
 *   - `top` (raw samples) sets `loopTop`.
 *
 * `edits` is a Map (or plain object) of lane id → override. The state
 * and each node on an edited node's path are cloned; nothing else is
 * touched, and with nothing to apply the state comes back as is.
 * Exported for the app and the tests.
 */
export function applyPendingEdits(state, edits) {
    const byId = edits instanceof Map ? edits
        : new Map(Object.entries(edits || {}));
    if (!byId.size) return state;
    const walk = ns => {
        let changed = false;
        const out = (ns || []).map(n => {
            let c = n;
            if (n.type === 'stack' && Array.isArray(n.nodes)) {
                const kids = walk(n.nodes);
                if (kids !== n.nodes) c = { ...n, nodes: kids };
            }
            const e = byId.get(n.id);
            if (e) c = withPendingEdit(c === n ? { ...n } : c, e);
            if (c !== n) changed = true;
            return c;
        });
        return changed ? out : ns;
    };
    const nodes = walk(state.nodes);
    return nodes === state.nodes ? state : { ...state, nodes };
}

/** One override onto a node clone `c` (mutated and returned). */
function withPendingEdit(c, e) {
    if (Array.isArray(e.segments)) {
        const n = Math.floor(e.segments.length / 2);
        if (n >= 2) {
            c.segments = e.segments.slice(0, 2 * n);
            c.loopStart = 0;
            c.loopEnd = 0;
        } else {
            delete c.segments;
            c.loopStart = n === 1 ? e.segments[0] : 0;
            c.loopEnd = n === 1 ? e.segments[1] : 0;
        }
        c.windowActive = n > 0 && !c.loopBypassed &&
            !(c.type === 'stack' && c.windowSuspended);
    }
    if (Number.isFinite(e.originShift) && e.originShift !== 0) {
        c.origin = (c.origin || 0) + e.originShift;
        c.retime = (Number.isFinite(c.retime) ? c.retime : 0) + e.originShift;
    }
    if (Number.isFinite(e.top)) c.loopTop = e.top;
    return c;
}

/**
 * THE ZERO DRAWN (docs/frame.md §1), by precedence:
 *
 *   drag pin ?? settle ?? edit hold ?? seat ?? the root's frame
 *
 * - The DRAG PIN (drag_pin.js) holds the frame a gesture engaged on,
 *   past its release until the final commit settles: a live commit
 *   re-anchors the edited lane's origin, and the seating would follow
 *   it under the pointer. Ignored while a take records (the frame
 *   grows with it).
 * - The SETTLE (opts.settle = { fromRel, t }): the frame gliding from
 *   the zero it showed, `fromRel` samples past the root frame, to the
 *   seat — t is the linear progress; settleZero eases it and takes the
 *   shortest way round `frameSamples` (the island cycle).
 * - The EDIT HOLD (opts.hold = { zeroRel, quantum }): while a lane is
 *   selected, the zero shown when the hold began. Both it and the
 *   settle's start are kept RELATIVE to the root frame (islandZero), so
 *   a seek — which moves the island zero and every origin together —
 *   moves them too. Suspended while any take is live or armed; void
 *   across a Q change (the grid it sat on is gone).
 *
 * The Q13 TRIM VIEW takes neither a settle nor a hold: its frame is the
 * definer's buffer, and the cursor it maps into the selection needs the
 * island zero the re-trim sets (mapPlayheadToDisplay) — a zero held
 * across a re-trim would sit on the old Q's grid.
 *
 * session_view/frame_hold.js decides when each applies; this only
 * resolves them. Returns { zero, source: 'pin'|'settle'|'hold'|'seat'|
 * 'root', settling }.
 */
function resolveFrameZero({ opts, seated, rootFrame, quantum, qEstablished,
                            anyRecording, anyTakeActive, frameSamples,
                            provisionalDefiner }) {
    if (opts.pinFrameQ > 0 && qEstablished && !anyRecording &&
        Number.isFinite(opts.pinZero)) {
        return { zero: opts.pinZero, source: 'pin', settling: false };
    }
    const s = opts.settle;
    if (s && seated !== null && !provisionalDefiner &&
        Number.isFinite(s.fromRel) && Number.isFinite(s.t)) {
        const from = rootFrame + s.fromRel;
        return { zero: settleZero(from, seated, frameSamples, s.t),
                 landing: settleLanding(from, seated, frameSamples),
                 source: 'settle', settling: s.t < 1 };
    }
    const h = opts.hold;
    if (h && qEstablished && !anyTakeActive && !provisionalDefiner &&
        Number.isFinite(h.zeroRel) &&
        (!(h.quantum > 0) || h.quantum === quantum)) {
        return { zero: rootFrame + h.zeroRel, source: 'hold', settling: false };
    }
    return seated !== null
        ? { zero: seated, source: 'seat', settling: false }
        : { zero: rootFrame, source: 'root', settling: false };
}

/**
 * THE TOP AND THE TIMING on a clip lane (loop_selection.md §9; the
 * Phase 2 VM contract) — what the ↺ handle, the panel's start marker
 * and the timing readout read:
 *
 *   topQ       the effective top T (topOf), raw Q of the take;
 *   topHeardQ  the ↺'s first heard position from the frame zero, in
 *              [0, S): posMod(origin + a0 + heardOffset(T) − zero, S)
 *              with S the loop period (the kept set's length);
 *   retimeQ    the cumulative user shift (`retime` ÷ Q): 0 = as played,
 *              and on an engine that publishes none;
 *   canRetime  the caller's verdict: a ↺ drag is offered here;
 *   retimeLocked  it would be, but for the recording gate: the ↺ still
 *              draws, INERT (splice_handles wantsTopHandle).
 */
function topFields(node, authored, ctx, canRetime, retimeLocked = false) {
    const { quantum, frameZero } = ctx;
    const t = topOf(node, authored);
    return {
        topQ: t.top / quantum,
        topHeardQ: t.periodS > 0
            ? posMod((node.origin || 0) + t.a0 + t.heard - frameZero, t.periodS) / quantum
            : 0,
        retimeQ: Number.isFinite(node.retime) ? node.retime / quantum : 0,
        canRetime: !!canRetime,
        retimeLocked: !canRetime && !!retimeLocked,
    };
}

/**
 * May the ↺ re-time this clip lane? A committed loop (not recording
 * or armed, not a one-shot — its offset IS its placement, Q5), with Q
 * established, not the Q-definer or a member of the definer stack (its
 * origin is the island zero: the engine refuses), not shown through an
 * enclosing map (the parent owns that lane's chrome, session_view.md
 * law 13), not in comp mode (it edits takes, not time), and not under
 * the recording gate (bandGate).
 */
function retimeable(node, ctx, underMap) {
    return !ctx.mapEditsLocked && !node.isPendingStart &&
        retimeableOnceIdle(node, ctx, underMap);
}

/** retimeable with the recording gate aside — an armed slot's own
 * pending take is the gate too. What the gate alone holds keeps its ↺,
 * drawn inert (retimeLocked): the gate's own proxy for map chrome,
 * bandLocked, needs a ≥ 2Q take, and a 1Q loop's ↺ would vanish. */
function retimeableOnceIdle(node, ctx, underMap) {
    return !!(ctx.qEstablished && !underMap && !node.isRecording &&
        node.duration > 0 && node.periodSource !== 'context' &&
        !(ctx.compMode && ctx.compMode.has(node.id)) &&
        !(ctx.definerIds && ctx.definerIds.has(node.id)));
}

/**
 * deriveViewModel(state[, opts])
 *
 * state: the getGraphState() shape as published by the engine (and the
 *        mock's publish.js) — samples everywhere, origins ABSOLUTE:
 *        { id (root uuid), masterPos, islandPos, isPlaying,
 *          quantum (STORED island Q; 0 = unestablished), islandZero
 *          (origin = fallback when absent), definerId (Q13), perf.sampleRate,
 *          sequence / windowActive / loopStart / loopEnd (the root's
 *          song + its step-audition window), nodes: [...] } with
 *        clip/stack nodes; a stack's children ride `nodes`.
 * opts.maxDepth:   fold depth guard (default 8).
 * opts.folded:     Set of stack ids folded (children hidden — I6b view
 *                  state, view_prefs.js).
 * opts.fxOpen:     Set of lane ids whose effects row is expanded.
 * opts.seqOpen:    Set of stack ids whose sequencer grid is expanded.
 * opts.compMode:   Set of clip ids in COMP MODE (docs/takes.md; a
 *                  windowed lane opens its raw lane for it —
 *                  windowEditLane).
 * opts.retakes:    Set of clip ids whose live take is a NEW TAKE of a
 *                  committed slot. Published state does not say so (a
 *                  retake keeps the slot's `duration`); app.js infers
 *                  it — a committed clip that goes hot can only be
 *                  retaking, since the engine refuses a plain arm on
 *                  content.
 * opts.pinFrameQ / opts.pinFoldQ / opts.pinZero: the map-gesture frame
 *                  pin (drag_pin).
 * opts.hold:       the EDIT HOLD, { zeroRel, quantum } — the held zero
 *                  relative to the root frame (session_view/
 *                  frame_hold.js; resolveFrameZero).
 * opts.settle:     the SETTLE, { fromRel, t } — a glide from the zero
 *                  shown to the seat at linear progress t (ditto).
 * opts.pendingEdits: Map lane id → { segments?, originShift?, top? } —
 *                  a gesture's preview (applyPendingEdits).
 *
 * Returns the Q-unit view model:
 * {
 *   quantum, frameZero, sampleRate, isPlaying, qEstablished,
 *   seatedZero,      // the SEAT (samples) — the unpinned, unheld zero the
 *                    // frame settles to; null with nothing to seat
 *   frameZeroSource, // which rule drew frameZero: 'pin' | 'settle' |
 *                    // 'hold' | 'seat' | 'root'
 *   frameSettling,   // the zero is mid-glide (off the Q grid)
 *   rootFrame,       // the island zero (the Q grid's phase), samples
 *   monitorLatencyMs, // Q20: the calibrated round trip (ms) or null
 *   cycleQ,          // the DISPLAY FRAME lanes tile
 *   lcmQ,            // the committed cycle (≤ cycleQ while a take grows)
 *   loopCycleQ,      // the AUDIBLE cycle (a step audition shortens it)
 *   loopStartQ,      // frame origin of the audible loop (Q13 trim view)
 *   frameExtended, playheadQ,
 *   armAtQ,          // next Q boundary (Q11); cycleQ ≡ 0 (↺)
 *   soleQDefinerId, provisionalDefiner,   // Q13
 *   mapEditsLocked,  // the recording gate: every loop region display-only
 *   ruler: { cycleQ, ticks: [{ q, major, at, end }] },  // the island's Q
 *                    // lines in the frame drawn, named where they land
 *                    // (buildRulerTicks)
 *   rootId,          // setSequence/toggleSequence target
 *   rootGain,        // the master fader (root output stage), 0..1
 *   rootFxCount,     // enabled slots in the root's rack (master fx chip)
 *   rootSeq: { bypassed, totalQ, stepCount, auditionStep, drift } | null,
 *   rootWindow: { startQ, endQ, step } | null,  // root audition brackets
 *   lanes: [ rows in render order — kind decides the shape:
 *     'clip' | 'group': laneCommon fields (id, name, muted, soloed,
 *        recording, awaitingStop, armed, effects, fxCount, hasInstrument,
 *        midiArmed, isMidi, pan, gain, oneShot, inputChannelR, channels)
 *        + depth, periodQ, intrinsicQ, contentQ (clips: the raw take
 *        extent a rep's srcSegs fractions index — intrinsicQ is the
 *        window/map period on heard lanes), reps: [{ startQ, endQ,
 *        ghost, wrapped, srcSegs?, srcTopFrac? }], window | null, windowChipQ,
 *        mapMulti, mapSegs, mapBypassed, mapSuspended, bandSegs,
 *        bandTotalQ, bandHeard, bandEditable, bandLocked (bandGate),
 *        throughMap, underMap,
 *        armable + armMode (clips: 'stop'|'record'|'retake'|null),
 *        topQ / topHeardQ / retimeQ / canRetime / retimeLocked (the ↺
 *        and the timing — topFields; a group's top is its region start,
 *        never retimed),
 *        takes / activeTake / comp / compCells / compMode (clips —
 *        docs/takes.md), recordingLengthQ + retake + armAtQ (recording
 *        lanes; a retake's reps are `silent`), folded /
 *        groupArm { state, armable, mode } / groupCycleQ / seqDims
 *        (groups), health (frame_health
 *        blowup/drift verdicts), definer/edit-view fields per builder;
 *     'fx':  { id: 'fx:'+ownerId, ownerId, depth, effects } (effects row);
 *     'seq': { id: 'seq:'+ownerId, ownerId, depth, bypassed, steps,
 *              totalQ, auditionStep, innerCycleQ, editable, children };
 *     'add': { id: 'add:'+groupId, groupId, depth } (the group's ＋ row)
 *   ]
 * }
 */
export function deriveViewModel(state, opts = {}) {
    const maxDepth = opts.maxDepth ?? 8;
    // Lanes whose effects panel is expanded (pure view state, owned by
    // the app shell — like fold, but client-side only)
    const fxOpen = opts.fxOpen || null;
    // A gesture's PREVIEW lands on clones of the edited nodes first:
    // everything below — seat, tiles, lane fields — derives from it.
    if (opts.pendingEdits) state = applyPendingEdits(state, opts.pendingEdits);
    const nodes = state.nodes || [];
    const quantum = resolveQuantum(state, nodes);

    // One DFS for the whole-tree facts (anyRecording also gates the
    // provisional-definer display and the masterPos handling below).
    const { committedClips, anyRecording, anyTakeActive,
            maxRecordingDuration } = collectTreeFacts(nodes);
    const { soleQDefinerId, provisionalDefiner, definerNode,
            defSelStartQ, defSelEndQ } =
        resolveProvisionalDefiner(committedClips, anyTakeActive, quantum,
                                  nodes, state.definerId);
    // The definer's ids — the sole clip, or the definer stack and its
    // mics: their origins are the island zero, so none is re-timed.
    const definerIds = new Set();
    if (soleQDefinerId) {
        definerIds.add(soleQDefinerId);
        const d = findNodeInTree(nodes, soleQDefinerId);
        if (d && d.type === 'stack') {
            (d.nodes || []).forEach(c => { if (c.type === 'clip') definerIds.add(c.id); });
        }
    }

    // THE FRAME ZERO is seated from the lanes (seatFrameZero, docs/frame.md)
    // — never read from the state. The state supplies two things only:
    // the root's own frame (islandZero — the song's top when the root
    // carries a song, and the Q grid's phase always: every committed
    // origin the plain arm lands is on it) and, through islandPos, the
    // raw clock. Pre-Q there is nothing to seat: the first take's own
    // frame is the root's. The zero DRAWN may be another — the drag pin,
    // the settle, the edit hold (resolveFrameZero, below, once the
    // island cycle it settles round is known).
    const rootFrame = state.islandZero ?? state.origin ?? 0;
    const qEstablished = quantum > 1;
    const gridPhase = qEstablished ? posMod(rootFrame, quantum) : 0;
    const seated = qEstablished
        ? seatFrameZero(state, nodes, quantum, gridPhase)
        : null;
    // THE RAW CLOCK: islandPos is the unwrapped clock measured from the
    // root's frame; adding that frame back recovers the transport
    // sample itself. Absent (hand-built fixtures), the published
    // masterPos stands in below.
    const rawClock = Number.isFinite(state.islandPos)
        ? state.islandPos + rootFrame : null;

    let cycleSamples = computeCycleSamples(nodes, quantum);
    // The AUDIBLE loop — what the engine wraps masterPos on — IS the
    // frame (every window is a part length, so the effective LCM is
    // the cycle). It diverges only
    // under a STEP AUDITION (a derived window over a song: the frame
    // stays the song, the cursor loops the step) — a nested group's
    // here, the root's below. Surfaced as loopCycleQ.
    let loopSamples = computeCycleSamples(nodes, quantum, { audible: true });
    // The island's INTRINSIC cycle in Q, captured BEFORE the sequence
    // reframes anything: the root grid's one-cycle unit (append/create
    // defaults). Reading the post-override lcmQ here would make every
    // "+" add one CURRENT SONG length — steps doubling 2, 4, 8, 16.
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
    // THE ZERO DRAWN: the drag pin, else the settle — gliding the
    // shortest way round the island cycle just known — else the edit
    // hold, else the seat (resolveFrameZero, frame.md §1).
    const zeroOf = resolveFrameZero({
        opts, seated, rootFrame, quantum, qEstablished, anyRecording,
        anyTakeActive, frameSamples: cycleSamples, provisionalDefiner,
    });
    const frameZero = zeroOf.zero;
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
    // THE TRIM VIEW'S CURSOR sweeps exactly the selection — the
    // definer's loop, which IS Q. With company (Q handed to a track
    // beside others, Q22) the island may cycle longer than Q, but the
    // trim view is framed by the definer's buffer and shows one pass of
    // its loop at a time.
    if (provisionalDefiner) loopSamples = quantum;
    const trimCompany = provisionalDefiner &&
        hasCompany(definerNode, committedClips);

    // First-take frame: before any Q exists there is no cycle — the only
    // meaningful timeline is the growing take itself. Track it (+1 so the
    // playhead never wraps at the take's own edge) and suppress the Q
    // grid; the first commit establishes Q and snaps to the real frame.
    if (!qEstablished && maxRecordingDuration > 0) {
        // Grow in WHOLE-SECOND steps (4s minimum): a continuously
        // growing frame would rescale the waveform every poll (a
        // stuttery first take). Between steps the px-per-second scale
        // is constant, so content stays pinned.
        const sr = (state.perf && state.perf.sampleRate) || 44100;
        cycleSamples = Math.max(4, Math.floor(maxRecordingDuration / sr) + 1) * sr;
    }
    const lcmQ = cycleSamples / quantum;

    // THE CURSOR is the raw clock folded on the audible cycle from the
    // seated zero. While a take grows it is the take's end instead
    // (recordingHeadQ), running past the committed cycle so the frame
    // extends to hold it — never re-wrapped, or a growing take would
    // loop 1Q over and over. Without a raw clock (hand-built fixtures)
    // the published masterPos stands in: the frame it is folded on is
    // then the root's, which the seating reproduces wherever both apply.
    let playheadQ;
    const growing = rawClock !== null && qEstablished
        ? recordingHeadQ(nodes, rawClock, frameZero, quantum, lcmQ,
                         // The rest zero is where the glide LANDS — the
                         // seat ± whole frames when it takes the short
                         // way round — never the seat itself: folded on
                         // the seat, a wrapping glide put the growing
                         // take a whole frame off (the frame grew, every
                         // lane rescaled, then snapped back).
                         zeroOf.settling && Number.isFinite(zeroOf.landing)
                             ? zeroOf.landing : frameZero)
        : null;
    if (growing !== null) {
        playheadQ = growing;
    } else if (rawClock !== null && seated !== null && loopSamples > 0) {
        playheadQ = posMod(rawClock - frameZero, loopSamples) / quantum;
    } else {
        playheadQ = Math.max(0, (state.masterPos || 0) / quantum);
    }

    const rec = computeRecordingFrame({
        nodes, quantum, qEstablished, anyRecording, lcmQ, playheadQ,
    });
    let frameQ = rec.frameQ;
    playheadQ = rec.playheadQ;

    const pin = applyFramePin({
        opts, rawClock, zero: frameZero, quantum, qEstablished,
        anyRecording, frameQ, loopSamples, playheadQ,
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
        playheadQ = wsQ + posMod(playheadQ, lenQ);
    }

    // Q11: the arm target is always the next Q boundary in the zero
    // frame (the cycle top is just the next boundary in the final Q).
    // The engine's own pending-start target is authoritative once a clip
    // is armed; this is the display value for "if you arm now". Island Q
    // boundaries sit at loopStartQ + k (loopStartQ = 0 outside the
    // provisional trim view, where this reduces to plain ceil) — for a
    // genuine 1Q selection the next boundary IS the selection end. The
    // boundaries are the ISLAND's: while the frame settles its zero sits
    // a fraction `phiQ` of a Q off the grid, and the marker says where a
    // take will start, not where the gliding frame's integers fall.
    const phiQ = qEstablished && !provisionalDefiner
        ? (f => (f < EPS || f > 1 - EPS ? 0 : f))(
            posMod((frameZero - gridPhase) / quantum, 1))
        : 0;
    const relPosQ = playheadQ - loopStartQ + phiQ;
    const armAtQ = loopStartQ - phiQ +
        (Math.ceil(relPosQ) === relPosQ ? relPosQ + 1 : Math.ceil(relPosQ));

    // THE PASS ZERO: the island time at the frame's left edge in the pass
    // the cursor is in — the raw clock minus the cursor's own position,
    // so it holds for every fold the cursor takes (the island cycle, the
    // pin, a take growing, the trim view's one loop). A DRIFTING loop
    // (Q22) lines up differently each pass, so its lane is drawn from
    // here: what sounds under the cursor is what the lane shows under
    // it. Whole samples (the fold is whole); without a raw clock the
    // frame's own zero stands in.
    const passZero = rawClock !== null && qEstablished
        ? Math.round(rawClock - playheadQ * quantum) : frameZero;

    const lanes = [];
    const ctx = {
        state, lanes, maxDepth, fxOpen, quantum,
        frameZero, qEstablished, cycleQ, lcmQ,
        provisionalDefiner, soleQDefinerId, defSelStartQ, defSelEndQ,
        definerIds,
        // Q22: drifting lanes draw from the pass zero; in the trim view
        // WITH COMPANY every other lane does (laneZeroOf) — the lanes
        // under the definer's buffer show what sounds with it this pass.
        passZero,
        trimCompany,
        // May a lane take Q (canDefineNode): nothing live, Q exists.
        definerIdle: qEstablished && !anyTakeActive,
        // A group above remaps time (an active map or song): the warp
        // guard — nothing beneath it can take Q.
        underWarp: false,
        // THE RECORDING GATE (bandGate): a live or pending take locks
        // every loop region.
        mapEditsLocked: anyTakeActive,
        // Stacks whose sequencer grid is expanded (view state, the
        // fxOpen pattern — docs/sequencer.md §9 S15).
        seqOpen: opts.seqOpen || null,
        // Folded stacks (I6b view state — the app shell's set).
        folded: opts.folded || null,
        // Takes (docs/takes.md): lanes in comp mode; lanes whose live
        // take is a new take of a committed slot; the display playhead
        // (a retake's bar runs from the slot top to now).
        compMode: opts.compMode || null,
        retakes: opts.retakes || null,
        playheadQ,
        // The cycle top-level lanes hear (§12.2): the root song when
        // sequenced, else the audible loop.
        scopeCycleQ: rootSeqSamples > 0 ? rootSeqSamples / quantum
                                        : loopSamples / quantum,
    };
    nodes.forEach(n => pushLane(n, 0, null, ctx));
    // THE ROOT SONG'S PHASE in the frame (docs/frame.md §4): the song
    // folds from the root's origin — the zero it was authored on — and
    // the frame is seated from the lanes, so the song's top sits at
    // (origin − zero) in Q. Zero whenever the root seats first (it
    // carries the song), which is every state the engine produces;
    // a fixture may put the two apart, and a hold keeps it whole Qs off.
    // Exact, not rounded: while the frame SETTLES its zero glides off
    // the grid, and the song's dims must ride the glide with the lanes.
    const rootAnchorQ = qEstablished
        ? (rootSongTop(state) - frameZero) / quantum : 0;
    // The ROOT's active sequence projects onto the top-level lanes
    // (engine root = the song when tracks live loose at the top).
    {
        const s = seqOf(state);
        if (s && !s.bypassed) {
            attachSeqDims(lanes, 0, lanes.length, nodes, s, quantum, rootAnchorQ);
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
            // frame (or each "+ step" doubles).
            innerCycleQ: intrinsicCycleQ,
            editable: !anyRecording,
            anchorQ: rootAnchorQ,
        }));
    }
    // THE MASTER RACK (B5): the root stack's fx row — the same synthetic
    // row a group's fx chip opens, keyed on the root's id — renders
    // ABOVE the root grid (the master shapes everything below it).
    if (fxOpen && rootId && fxOpen.has(rootId)) {
        lanes.unshift(fxRow(state, 0));
    }

    attachFrameHealth(lanes, state, nodes, quantum, qEstablished);

    // The grid rides the zero drawn (a settle's glide included), each
    // line named where it lands (buildRulerTicks).
    const ticks = buildRulerTicks(qEstablished, cycleQ, phiQ,
        zeroOf.settling && Number.isFinite(zeroOf.landing)
            ? (zeroOf.landing - frameZero) / quantum : 0);

    return {
        quantum,
        frameZero,
        // THE SEAT — the unpinned, unheld zero the frame rests on when
        // nothing holds it (frame.md §1); what a settle glides to.
        seatedZero: seated,
        frameZeroSource: zeroOf.source,
        frameSettling: zeroOf.settling,
        // The root's own frame (islandZero): the Q grid's phase, and
        // what a seek moves together with every origin — a zero moving
        // RELATIVE to it is the frame moving, not the transport.
        rootFrame,
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
        // Q22: the trim view holds the definer BESIDE other tracks (Q
        // was handed to it); they are drawn for the pass that sounds.
        trimCompany,
        // Q22: the island time at the frame's left edge this pass.
        passZero,
        // THE RECORDING GATE (bandGate, time_maps.md §7): a take is
        // recording or pending, so every loop region is display-only.
        mapEditsLocked: anyTakeActive,
        sampleRate: (state.perf && state.perf.sampleRate) || 44100,
        // Software input monitoring (Q20): the calibrated round trip
        // the monitored signal carries, in ms at the device rate —
        // null until a calibration has been measured (the mon chip's
        // tooltip says so instead of guessing).
        monitorLatencyMs: state.perf && state.perf.calibrated
            ? (state.perf.latencyCompensationSamples /
               (state.perf.sampleRate || 44100)) * 1000
            : null,
        armAtQ,
        ruler: { cycleQ, ticks },
        lanes,
        // The root sequencer's transport-chip facts (docs/sequencer.md):
        // rootId targets setSequence/toggleSequence at the session root.
        rootId,
        // THE MASTER STRIP (B5): the root stack's output-stage fader
        // (absent = unity — pre-gain states must not read as silent)
        // and its rack's enabled count for the master fx chip.
        rootGain: typeof state.gain === 'number' ? state.gain : 1,
        rootFxCount: state.effects && Array.isArray(state.effects.chain)
            ? state.effects.chain.filter(s => s.enabled).length : 0,
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
