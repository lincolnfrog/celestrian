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
 *   - loop windows NEVER reframe the display: periods and the cycle are
 *     intrinsic; an active window is a visual subset (brackets + dims).
 *     E-C stays an engine-side audio fact (owner ruling 2026-07-11)
 *   - the arm target is the next Q boundary in the epoch frame (Q11)
 *   - arming a group arms every child (Q7 group-arm ruling)
 */

import {
    lcm, calculateStackLCM, computeEffectiveQuantum, nextStopBoundary,
} from './timeline_model.js';

/** A node's intrinsic period in samples (stack = children LCM). */
function intrinsicPeriod(node, quantum) {
    return node.type === 'stack'
        ? calculateStackLCM(node.nodes, quantum)
        : (node.duration || 0);
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
    };
}

/**
 * A lane's DISPLAY period in Q: always the intrinsic period. E-C ("a
 * windowed composite behaves as a 2Q clip in its parent's LCM") is an
 * AUDIO fact owned by the engine — the display frame must NOT follow it
 * (owner ruling 2026-07-11): windowing a lone 2Q stack to 1Q once
 * compressed the whole timeline to 1Q and hid the content, and the
 * frame breathed with every active/bypass toggle. The engine's
 * published masterPos wraps on clip durations (never on windows), so
 * the intrinsic frame is also the one the playhead actually sweeps.
 * The window renders as a visual SUBSET (brackets + dimmed outside).
 * Recording lanes have no settled period yet and return 0 (excluded
 * from the cycle, matching calculateStackLCM which skips them).
 */
function displayPeriodQ(node, quantum) {
    if (node.isRecording) return 0;
    return intrinsicPeriod(node, quantum) / quantum;
}

/**
 * Unroll a lane across the cycle: tiles at q ≡ offsetQ (mod periodQ),
 * clipped to [0, cycleQ). Exactly one unclipped tile is the take
 * (ghost: false); clipped pieces are marked wrapped. Q-unit exact —
 * no pixel tolerances (computeGhostTiles is the px-space equivalent).
 */
export function unrollReps({ periodQ, offsetQ, cycleQ, maxTiles = 256 }) {
    if (periodQ <= 0 || cycleQ <= 0) return [];
    // Safety net: a degenerate frame (e.g. Q not yet established) must
    // never explode into thousands of tiles (mirrors computeGhostTiles)
    if (cycleQ / periodQ > maxTiles) return [];
    const reps = [];
    // The tiling grid runs at q ≡ offsetQ (mod periodQ) — NEVER derived
    // through the frame: an extended recording frame is not a multiple
    // of every period, and routing the phase through mod-frame breaks
    // tile alignment (found by the take-anchored frame tests).
    const first = ((offsetQ % periodQ) + periodQ) % periodQ;
    // The MAIN (non-ghost) tile is the first full repetition in the
    // frame. Owner ruling 2026-07-10: a looping clip has no privileged
    // historical rep — "which cycle it was recorded in" is not a
    // musical fact ("it doesn't matter how many times I let clip 1 loop
    // before recording clip 2"), so origin-modular take marking drew
    // the bright tile in arbitrary mid-frame positions.
    const takeStart = first;
    // Walk tile starts from the (possibly negative) wrapped predecessor
    for (let s = first - periodQ; s < cycleQ; s += periodQ) {
        const startQ = Math.max(0, s);
        const endQ = Math.min(cycleQ, s + periodQ);
        if (endQ <= startQ) continue;
        reps.push({
            startQ,
            endQ,
            ghost: s !== takeStart,
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

function laneCommon(node, state) {
    return {
        id: node.id,
        name: node.name || node.id,
        muted: !!node.isMuted,
        soloed: state.soloedId === node.id,
        recording: !!node.isRecording,
        // Stop requested; the engine records on to the next boundary
        // (owner ruling 2026-07-10: stops always pad forward)
        awaitingStop: !!node.isAwaitingStop,
        armed: !!(node.isPendingStart || node.isRecording),
        // Built-in effect rack state (published on every node) + the
        // enabled count for the rail's fx chip
        effects: node.effects || null,
        fxCount: node.effects
            ? ['eq', 'compressor', 'echo', 'reverb']
                .filter(k => node.effects[k] && node.effects[k].enabled).length
            : 0,
    };
}

/**
 * The effects PANEL row for a lane whose rack is expanded (view state:
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
    const nodes = state.nodes || [];
    const quantum = computeEffectiveQuantum(nodes);
    // The island epoch is published explicitly (getGraphState
    // "islandEpoch"): commit RE-BASES it on simple extensions, and the
    // root node's `origin` metadata does NOT follow — reading origin as
    // the epoch mis-marked take tiles ("first 3Q strangely ghosted",
    // field screenshot 2026-07-09). origin remains the legacy fallback.
    const epochSamples = state.islandEpoch ?? state.origin ?? 0;

    // Island cycle: LCM over top-level INTRINSIC periods — windows never
    // reframe the timeline (law 13; see displayPeriodQ).
    let cycleSamples = quantum;
    nodes.forEach(n => {
        const pQ = displayPeriodQ(n, quantum);
        if (pQ > 0) cycleSamples = lcm(Math.round(cycleSamples), Math.round(pQ * quantum));
    });

    // The AUDIBLE cycle (E-C, mirrors calculateEffectiveCycleLength):
    // active windows shorten it, and the engine wraps masterPos on it —
    // the playhead loops early inside an intrinsic frame. Surfaced as
    // loopCycleQ so the readout can say why.
    const effPeriod = node => {
        if (node.isRecording) return 0;
        if (node.windowActive && node.loopEnd > node.loopStart) {
            return node.loopEnd - node.loopStart;
        }
        if (node.type !== 'stack') return node.duration || 0;
        let composite = 0;
        (node.nodes || []).forEach(c => {
            const p = effPeriod(c);
            if (p > 0) composite = composite > 0 ? lcm(Math.round(composite), Math.round(p)) : p;
        });
        return composite;
    };
    let loopSamples = quantum;
    nodes.forEach(n => {
        const p = effPeriod(n);
        if (p > 0) loopSamples = lcm(Math.round(loopSamples), Math.round(p));
    });

    // First-take frame: before any Q exists there is no cycle — the only
    // meaningful timeline is the growing take itself. Track it (+1 so the
    // playhead never wraps at the take's own edge) and suppress the Q
    // grid; the first commit establishes Q and snaps to the real frame.
    const qEstablished = quantum > 1;
    if (!qEstablished) {
        let maxRec = 0;
        const visit = ns => (ns || []).forEach(n => {
            if (n.isRecording && n.duration > maxRec) maxRec = n.duration;
            if (n.nodes) visit(n.nodes);
        });
        visit(nodes);
        if (maxRec > 0) {
            // Grow in WHOLE-SECOND steps (4s minimum): a continuously
            // growing frame rescales the waveform every poll — the
            // "stuttery" first take (field 2026-07-10). Between steps the
            // px-per-second scale is constant, so content stays pinned.
            const sr = (state.perf && state.perf.sampleRate) || 44100;
            cycleSamples = Math.max(4, Math.floor(maxRec / sr) + 1) * sr;
        }
    }
    const lcmQ = cycleSamples / quantum;

    // masterPos CONTRACT (AudioEngine::getGraphState, kernel.md step 3):
    // the published masterPos is already the DERIVED DISPLAY POSITION —
    // wrapped to the cycle when idle/playing, and during recording it
    // grows linearly past the committed LCM from a base frozen at record
    // start. The VM must NOT re-wrap it: re-deriving with mod caused the
    // "looping 1Q over and over" field bug (2026-07-09). The mock mirrors
    // this contract (mock_backend.viewMasterPos).
    const anyRecording = (function visit(ns) {
        return (ns || []).some(n => n.isRecording || (n.nodes && visit(n.nodes)));
    })(nodes);
    let playheadQ = Math.max(0, (state.masterPos || 0) / quantum);

    // GROWING FRAME, PHASE-PRESERVING: while recording, the frame shifts
    // by WHOLE CYCLES to the cycle the take started in, and extends one
    // whole Q at a time to hold the growing cursor. Whole-cycle shifts
    // keep every committed lane's phase fixed (a raw-Q shift rotated the
    // whole timeline for mid-cycle takes — "the timeline seems to
    // restart", field 2026-07-10) and agree exactly with the engine's
    // commit epoch re-base when a take starts a new cycle top. The take
    // anchor is snapped to a whole Q (Q11), cancelling the pre-record
    // latency wobble baked into live duration (E-E).
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
                frameQ = Math.max(lcmQ, Math.ceil(playheadQ - 1e-9));
            }
        } else {
            // Pure pending (armed, no audio yet): stay in the settled
            // frame — the unwrapped view crossing the arm boundary must
            // not stretch it (stretch-then-squish at record start)
            playheadQ = playheadQ % frameQ;
        }
    }
    const frameExtended = frameQ > lcmQ;
    const cycleQ = frameQ; // the frame every consumer tiles and fits

    // Defensive wrap when idle: the contract says idle masterPos arrives
    // pre-wrapped; if a backend ever violates that, fold rather than
    // draw the playhead off the timeline. Never wrap while recording.
    if (!anyRecording && frameQ > 0) playheadQ = playheadQ % frameQ;

    // Q11: the arm target is always the next Q boundary in the epoch
    // frame (the cycle top is just the next boundary in the final Q).
    // The engine's own pending-start target is authoritative once a clip
    // is armed; this is the display value for "if you arm now".
    const armAtQ = Math.ceil(playheadQ) === playheadQ ? playheadQ + 1 : Math.ceil(playheadQ);

    const lanes = [];
    const pushLane = (node, depth) => {
        if (depth > maxDepth) return;
        // Tile offsets are epoch-relative (origins are ABSOLUTE; the
        // frame's x axis is the engine's epoch-phase view), rotated by
        // the take anchor while recording (shiftQ is whole Qs, so tiles
        // stay Q-grid-true; mod-period tiling handles the wrap)
        const offsetQ = ((node.origin || 0) - epochSamples) / quantum - shiftQ;

        if (node.type === 'stack') {
            const periodQ = displayPeriodQ(node, quantum);
            const lane = Object.assign(laneCommon(node, state), {
                kind: 'group',
                depth,
                periodQ,
                // The window EDIT range: [0, intrinsic period] (equals
                // periodQ now that display periods are intrinsic; kept
                // as the brackets' explicit clamp bound)
                intrinsicQ: intrinsicPeriod(node, quantum) / quantum,
                // Before Q exists there is nothing meaningful to tile.
                // Groups anchor at frame 0: a composite is derived
                // machinery, not a performance — origin-based take
                // marking would draw meaningless wrap slivers (its first
                // full period reads solid, repeats read as ghosts).
                reps: qEstablished
                    ? unrollReps({ periodQ, offsetQ: 0, cycleQ })
                    : [],
                window: windowOf(node, quantum),
                // Heard-time cursor inside an active window (engine
                // publishes the window phase on `playhead`). Kept OUT of
                // the window object: it changes every poll and must not
                // churn the overlay's reconcile key.
                windowPhase: node.windowActive ? (node.playhead || 0) : 0,
                folded: node.isExpanded === false,
                groupArm: groupArmState(node),
            });
            lanes.push(lane);
            if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
            // TODO(phase 3): children of a group with an ACTIVE window
            // live in the window's re-based inner frame (time_maps.md §2
            // — the window re-bases the epoch for its children). Phase 1
            // unrolls them against the island cycle; revisit when the
            // shell renders windowed groups interactively.
            if (!lane.folded) {
                (node.nodes || []).forEach(c => pushLane(c, depth + 1));
                // Synthetic affordance row: "+ add track" at the bottom of
                // the open group (field-preferred placement, 2026-07-09)
                lanes.push({
                    kind: 'add', id: 'add:' + node.id, groupId: node.id,
                    name: '', depth: depth + 1,
                });
            }
            return;
        }

        if (node.isRecording) {
            // The bar is [playhead − length, playhead]: under the
            // masterPos contract the playhead IS the take's end, and the
            // engine grows `duration` live while writing. Zero length =
            // pending start (armed, waiting for the Q boundary).
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
            }));
            if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
            return;
        }

        const periodQ = displayPeriodQ(node, quantum);
        lanes.push(Object.assign(laneCommon(node, state), {
            kind: 'clip',
            depth,
            periodQ,
            intrinsicQ: intrinsicPeriod(node, quantum) / quantum,
            reps: qEstablished ? unrollReps({ periodQ, offsetQ, cycleQ }) : [],
            window: windowOf(node, quantum),
            windowPhase: node.windowActive ? (node.playhead || 0) : 0,
            armable: isArmable(node),
            // Recording input (hardware channel index; −1 = device default)
            inputChannel: node.inputChannel ?? -1,
        }));
        if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
    };
    nodes.forEach(n => pushLane(n, 0));

    // Q grid only when Q exists and stays drawable (a first take's frame
    // is cycleQ ≈ its sample count — no grid, and no DOM explosion)
    const ticks = [];
    if (qEstablished && Number.isInteger(cycleQ) && cycleQ <= 64) {
        for (let q = 0; q <= cycleQ; q++) ticks.push({ q, major: q % 4 === 0 });
    }

    return {
        quantum,
        epochSamples,
        cycleQ,          // the DISPLAY FRAME: what lanes tile and views fit
        lcmQ,            // the committed cycle (≤ cycleQ; equal unless recording extends)
        loopCycleQ: loopSamples / quantum, // the AUDIBLE cycle (E-C): < lcmQ when windows shorten it
        frameExtended,   // true while a take has grown the frame past the LCM
        playheadQ,
        isPlaying: !!state.isPlaying,
        qEstablished,
        armAtQ,
        ruler: { cycleQ, ticks },
        lanes,
    };
}
