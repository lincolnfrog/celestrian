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
    lcm, calculateStackLCM, commensuratePeriod, computeEffectiveQuantum,
    nextStopBoundary,
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
export function unrollReps({ periodQ, offsetQ, cycleQ, takeQ, maxTiles = 256 }) {
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
            ghost: Math.abs(s - takeStart) > 1e-9,
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
 * "Ghosts show what SOUNDS" (owner-ratified 2026-07-16, open question
 * 10): for a clip with an ACTIVE window, ghost tiles become ECHOES of
 * the window segment at its audible repetitions — positions ≡ the
 * clip's offset + the window start (mod the window length; the engine's
 * clip-window playback anchors at origin + loopStart since 2026-07-19,
 * so the segment sounds at ITS OWN performed moment, not the buffer
 * top's) — instead of repetitions of raw take material that never
 * sounds. The take tile stays whole: it is the ONE
 * place that renders recorded truth (the original material, dimmed
 * outside the brackets by the overlay) — everywhere else shows audible
 * truth. Echo reps carry `echo: true` and a `src` content range
 * (fractions of the take's peaks) so the renderer draws the segment's
 * waveform in a visibly different tone. Clips only for now: a group's
 * composite already draws audible truth into one canvas.
 */
export function echoReps({ reps, win, offsetQ, cycleQ, intrinsicQ }) {
    const winLen = win.endQ - win.startQ;
    if (!(winLen > 0) || !(intrinsicQ > 0)) return reps;
    if (cycleQ / winLen > 64) return reps; // degenerate guard
    const take = reps.find(r => !r.ghost);
    if (!take) return reps;
    const src = [win.startQ / intrinsicQ, win.endQ / intrinsicQ];

    const out = [take];
    const push = (s, e) => {
        const startQ = Math.max(0, s);
        const endQ = Math.min(cycleQ, e);
        if (endQ - startQ <= 1e-9) return;
        out.push({
            startQ, endQ, ghost: true, echo: true, src,
            wrapped: endQ - startQ < winLen - 1e-9,
        });
    };
    const first = (((offsetQ + win.startQ) % winLen) + winLen) % winLen;
    for (let s = first - winLen; s < cycleQ; s += winLen) {
        const e = s + winLen;
        // The take tile's span belongs to recorded truth — trim echoes
        // around it rather than overdrawing the original material.
        if (e <= take.startQ || s >= take.endQ) { push(s, e); continue; }
        if (s < take.startQ) push(s, take.startQ);
        if (e > take.endQ) push(take.endQ, e);
    }
    out.sort((a, b) => a.startQ - b.startQ);
    return out;
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
    // Lanes whose window is being EDITED (view state, app shell): they
    // expand to their full raw duration on their own scale (law 13
    // amendment, 2026-07-19k).
    const windowEdit = opts.windowEdit || null;
    const nodes = state.nodes || [];
    // The island quantum is a STORED fact published top-level by the
    // engine (P0-3 — the root stack's `quantum` metadata; the mock
    // mirrors it). Prefer it; min-over-nodes derivation survives only
    // as a fallback for states that predate the field (old fixtures).
    const quantum = state.quantum > 1
        ? state.quantum : computeEffectiveQuantum(nodes);

    // Q13 provisional mutability: Q is re-establishable while the island's
    // only committed content is ONE clip (the Q-definer). Its loop handles
    // re-establish (Q, epoch); once a 2nd take commits, Q locks. Surface
    // the sole definer so the rail can render draggable "sets tempo"
    // handles even at full span (which windowOf normally suppresses).
    const committedClips = [];
    (function visit(ns) {
        (ns || []).forEach(n => {
            if (n.type === 'clip' && !n.isRecording && (n.duration || 0) > 0) {
                committedClips.push(n);
            }
            if (n.nodes) visit(n.nodes);
        });
    })(nodes);
    const soleQDefinerId = committedClips.length === 1 ? committedClips[0].id : null;

    // While the Q-definer is provisional AND idle (nothing armed or
    // recording), it renders its FULL recorded buffer with the loop
    // region drawn as a SELECTION overlay (dead air dimmed but visible)
    // — so dragging the handles moves the selection over a stable
    // waveform while Q/epoch update live underneath, rather than
    // reframing to the selection and dropping the rest of the clip. The
    // moment a second take ARMS, the engine LOCK-COLLAPSES the definer
    // (its window becomes the take — owner ruling 2026-07-19), so the
    // trim view ends at arm, not at commit: the armed gate here matches
    // the engine's hasActiveTake re-trim refusal.
    const anyRecording = (function visit(ns) {
        return (ns || []).some(n => n.isRecording || (n.nodes && visit(n.nodes)));
    })(nodes);
    const anyTakeActive = anyRecording || (function visit(ns) {
        return (ns || []).some(n => n.isPendingStart || (n.nodes && visit(n.nodes)));
    })(nodes);
    // The window must not be BYPASSED for the trim view: a bypassed
    // window plays the full take, so the selection isn't the audible
    // loop and the mapping below would lie. (The definer chip offers no
    // bypass toggle, so this only guards imported/odd states.)
    const provisionalDefiner = !!soleQDefinerId && !anyTakeActive &&
        !committedClips[0].loopBypassed;
    const definerNode = provisionalDefiner ? committedClips[0] : null;
    // The definer's selection in Q units (Q = selection length, so the
    // selection is exactly 1Q wide and starts at loopStart/quantum).
    // The engine commits every clip with loop [0, duration); a fixture
    // without loop points means the same thing — the whole buffer.
    const defHasSel = !!definerNode && definerNode.loopEnd > definerNode.loopStart;
    const defSelStartQ = defHasSel ? definerNode.loopStart / quantum : 0;
    const defSelEndQ = !definerNode ? 0
        : defHasSel ? definerNode.loopEnd / quantum
            : (definerNode.duration || 0) / quantum;
    // The island epoch is published explicitly (getGraphState
    // "islandEpoch"): commit RE-BASES it on simple extensions, and the
    // root node's `origin` metadata does NOT follow — reading origin as
    // the epoch mis-marked take tiles ("first 3Q strangely ghosted",
    // field screenshot 2026-07-09). origin remains the legacy fallback.
    const epochSamples = state.islandEpoch ?? state.origin ?? 0;

    // Island cycle: LCM over top-level INTRINSIC periods — windows never
    // reframe the timeline (law 13; see displayPeriodQ). Clip
    // contributions are COMMENSURATE (timeline_model.commensuratePeriod):
    // law 13 assumes whole-Q material, and a Q13-trimmed definer's raw
    // buffer length is a multiple of the OLD Q — LCM-ing it exploded the
    // frame to ~142336Q the moment take 2 armed (waveforms vanished
    // behind the maxTiles guards; field 2026-07-19b). The lane still
    // RENDERS its true fractional extent (intrinsicQ) — only the shared
    // frame math sees the whole-Q contribution.
    let cycleSamples = quantum;
    const clipCycleContribution = n => {
        // LAW 13 AMENDED (2026-07-19k): a clip's ACTIVE window IS its
        // displayed material (heard view), so it contributes the window
        // length — the display frame equals the audible loop and the
        // one cursor is honest everywhere. (Law 13's original concern —
        // hidden content — is answered by the expand-to-edit view.)
        const d = n.duration || 0;
        const ls = n.loopStart || 0, le = Math.min(n.loopEnd || 0, d);
        if (!n.loopBypassed && le > ls && !(ls <= 0 && le >= d)) {
            return Math.round(le - ls);
        }
        return commensuratePeriod(n, quantum);
    };
    nodes.forEach(n => {
        if (n.isRecording) return;
        const p = n.type === 'stack'
            ? calculateStackLCM(n.nodes, quantum)  // commensurate inside
            : clipCycleContribution(n);
        if (p > 0) cycleSamples = lcm(Math.round(cycleSamples), Math.round(p));
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

    // Provisional Q-definer: frame the FULL recorded buffer (not the Q
    // cycle). cycleQ = duration/quantum and the selection brackets are
    // both ÷quantum, so as the drag changes Q nothing rescales — the
    // waveform fills the frame and the selection moves within it.
    if (provisionalDefiner && (definerNode.duration || 0) > 0) {
        cycleSamples = definerNode.duration;
    }

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
    // this contract (mock_backend.viewMasterPos). anyRecording is computed
    // up top (it also gates the provisional-definer display).
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

    // STACK-WINDOW CURSOR HONESTY (time_maps.md extension-2, resolved
    // with phase 2): when the audible cycle IS a sole top-level stack
    // window's pass, the transport sweeps [0, winLen) but the brackets
    // sit at [ws, ws+winLen) in the intrinsic frame — the cursor swept
    // dead air while the sounding material sat where it never went.
    // Mirror the Q13 resolution: map the ONE playhead into the window
    // (heard position = window start + island phase). Display-only;
    // recording keeps the growing-frame math above.
    if (!provisionalDefiner && !anyRecording && qEstablished) {
        const winGroups = nodes.filter(n => n.type === 'stack' &&
            n.windowActive && (n.loopEnd || 0) > (n.loopStart || 0));
        if (winGroups.length === 1) {
            const g = winGroups[0];
            const winLen = g.loopEnd - g.loopStart;
            if (Math.round(winLen) === Math.round(loopSamples)) {
                const wsQ = g.loopStart / quantum;
                const lenQ = winLen / quantum;
                loopStartQ = wsQ;
                playheadQ = wsQ + (playheadQ % lenQ);
            }
        }
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
    // A live take anywhere below (drives the group lane's map cue).
    const subtreeRec = n =>
        (n.nodes || []).some(c => c.isRecording || subtreeRec(c));
    // mapCtx: the nearest enclosing ACTIVE map, threaded down the group
    // recursion (time_maps.md phase 2) — recording lanes under one gain
    // throughMap/mapPeriodQ/mapStartQ (the ruling-5 visual-cue hooks;
    // the engine caps the take at one map period).
    const pushLane = (node, depth, mapCtx = null) => {
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
                // The map cue on the MAPPING group itself: a take is
                // recording through this window right now.
                mapRecording: !!(node.windowActive &&
                    (node.loopEnd || 0) > (node.loopStart || 0) &&
                    subtreeRec(node)),
            });
            lanes.push(lane);
            if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
            // The nearest enclosing active map wins (engine parity).
            const ownMap = node.windowActive &&
                (node.loopEnd || 0) > (node.loopStart || 0)
                ? { periodQ: (node.loopEnd - node.loopStart) / quantum,
                    startQ: (node.loopStart || 0) / quantum }
                : null;
            // TODO(phase 3): children of a group with an ACTIVE window
            // live in the window's re-based inner frame (time_maps.md §2
            // — the window re-bases the epoch for its children). Phase 1
            // unrolls them against the island cycle; revisit when the
            // shell renders windowed groups interactively.
            if (!lane.folded) {
                (node.nodes || []).forEach(c =>
                    pushLane(c, depth + 1, ownMap || mapCtx));
                // Synthetic affordance row: "+ add track" at the bottom of
                // the open group (field-preferred placement, 2026-07-09)
                lanes.push({
                    kind: 'add', id: 'add:' + node.id, groupId: node.id,
                    name: '', depth: depth + 1,
                });
            }
            return;
        }

        // Provisional Q-definer (idle, sole committed clip): render the
        // FULL recorded buffer as ONE tile with the loop region as a
        // SELECTION overlay — brackets + dimmed (but visible) dead air.
        // No windowed reframe, no echo tiles: dragging the handles moves
        // the selection over a stable waveform. Q/epoch update live
        // underneath (the engine); this view just doesn't collapse until a
        // second take locks it.
        if (provisionalDefiner && node.id === soleQDefinerId) {
            const fullQ = (node.duration || 0) / quantum;
            lanes.push(Object.assign(laneCommon(node, state), {
                kind: 'clip',
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
            }));
            if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
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
                // Recording THROUGH an enclosing map (phase 2): the cue
                // hooks + the bar's cap (the engine commits ≤ one map
                // period).
                throughMap: !!mapCtx,
                mapPeriodQ: mapCtx ? mapCtx.periodQ : 0,
                mapStartQ: mapCtx ? mapCtx.startQ : 0,
            }));
            if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
            return;
        }

        const periodQ = displayPeriodQ(node, quantum);
        const intrinsicQ = intrinsicPeriod(node, quantum) / quantum;
        const win = windowOf(node, quantum);

        // WINDOW EDIT VIEW (law 13 amendment): the lane expands to its
        // FULL raw duration on its OWN horizontal scale — the seed
        // track's trim view, per lane. Brackets select over the whole
        // take; the amber cursor carries heard time; the rest of the
        // timeline (and the white cursor) stay in the audible frame.
        if (win && windowEdit && windowEdit.has(node.id)) {
            lanes.push(Object.assign(laneCommon(node, state), {
                kind: 'clip',
                depth,
                periodQ: intrinsicQ,
                intrinsicQ,
                frameQ: intrinsicQ,  // per-lane scale: an inspector
                reps: [{ startQ: 0, endQ: intrinsicQ, ghost: false }],
                takeStartQ: 0,
                window: win,
                windowPhase: node.windowActive ? (node.playhead || 0) : 0,
                windowEditing: true,
                armable: false,
                inputChannel: node.inputChannel ?? -1,
            }));
            if (fxOpen && fxOpen.has(node.id)) lanes.push(fxRow(node, depth + 1));
            return;
        }

        // HEARD VIEW (law 13 amendment): an ACTIVE window's CONTENT is
        // the lane's material, tiled where it audibly sounds (anchored
        // at origin + start, period = window length). Every rep carries
        // the segment src so the renderer draws window content in every
        // tile — the whole lane is audible truth, and the one white
        // cursor is honest on it. The raw take lives one grab away.
        const heard = !!(win && win.active);
        const lanePeriodQ = heard ? win.endQ - win.startQ : periodQ;
        const laneOffsetQ = heard ? offsetQ + win.startQ : offsetQ;
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
            const phase = ((laneOffsetQ % ctxQ) + ctxQ) % ctxQ;
            const firstTile = ((laneOffsetQ % lanePeriodQ) + lanePeriodQ) % lanePeriodQ;
            // First tile position ≡ the heard phase (mod ctx): exists
            // within lcm(ctx, period) ≤ the committed cycle.
            for (let p = firstTile; p < cycleQ; p += lanePeriodQ) {
                const d = ((p - phase) % ctxQ + ctxQ) % ctxQ;
                if (d < 1e-9 || ctxQ - d < 1e-9) { takeQ = p; break; }
            }
        } else if (relQ >= 0 && lcmQ > 0) {
            takeQ = ((laneOffsetQ % lcmQ) + lcmQ) % lcmQ;
        }
        let reps = qEstablished
            ? unrollReps({ periodQ: lanePeriodQ, offsetQ: laneOffsetQ,
                           cycleQ, takeQ })
            : [];
        if (heard) {
            const src = [win.startQ / intrinsicQ, win.endQ / intrinsicQ];
            reps = reps.map(r => Object.assign({}, r, { src }));
        }
        lanes.push(Object.assign(laneCommon(node, state), {
            kind: 'clip',
            depth,
            periodQ: lanePeriodQ,
            // Heard view: the lane's material IS the window content, so
            // its extent is the window length (drag/dim math included).
            intrinsicQ: heard ? lanePeriodQ : intrinsicQ,
            reps,
            // The take tile's frame position: the CONTENT-frame origin of
            // this lane. Window brackets/dims/cursor (content-relative
            // [loopStart, loopEnd)) anchor here — anchoring at frame 0
            // drew them a whole phase off for takes not at the top
            // (field 2026-07-16c). The take rep's startQ is the unclipped
            // tile start by construction (only tile ENDS get clipped).
            takeStartQ: (reps.find(r => !r.ghost) || { startQ: 0 }).startQ,
            // Heard view: no brackets on the lane (the whole tile IS the
            // window); the chip + latent edge grips open the edit view.
            window: heard ? null : win,
            windowChipQ: heard ? lanePeriodQ : 0,
            windowPhase: heard ? 0
                : node.windowActive ? (node.playhead || 0) : 0,
            armable: isArmable(node),
            // NOT isQDefiner here: the definer renders through the
            // provisional branch above. This branch gets the sole clip
            // only while a take is in flight — and then a bracket drag
            // is an ordinary window edit (the engine's hasActiveTake
            // gate refuses to move Q under a performing take).
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
    };
}
