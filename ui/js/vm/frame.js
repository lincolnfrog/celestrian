/**
 * THE FRAME (docs/frame.md): where the shared timeline's left edge sits
 * (the seat, the zero drawn), how long it is (the island cycle, growing
 * under a take, pinned under a gesture), where the one cursor and the
 * arm marker fall in it, and its ruler. resolveFrame is the whole of it.
 */

import { lcm, posMod } from '../math_utils.js';
import { nextStopBoundary } from '../timeline_model.js';
import { ownPeriod, nodeDrifts, islandCycle, scopeCycle } from '../period_law.js';
import { nodeWindowActive, publishedMap, publishedMapPeriod } from '../time_map.js';
import { publishedSequence, activeSequenceSamples, isAuditionWindow,
         auditionStepOf } from '../sequence_program.js';
import { EPS } from './tiling.js';
import { publishedLaw, frameLaw, mapOf, mapAuthored, topOf, intrinsicPeriod,
         settledForFrame } from './published.js';
import { definerPlaceQ } from './definer.js';

/** THE PICKUP (frame.md §1, loop_selection.md §9.4): a top up to this
 * much of a Q EARLY seats on the grid line after it — a take pulled
 * slightly early reads as a pickup into the bar, never as a whole Q of
 * wrap tail at the left edge. Exported for the tests. */
export const SEAT_PICKUP_Q = 0.25;

/**
 * THE SEAT (frame.md §1; pinned by ui/js/tests/frame_seat.test.mjs): the
 * frame's left edge is no published fact — it is seated from the lanes,
 * in the order shown. ONE loop places it: the first loop LONGER than Q
 * (a 1Q loop's top is every bar line, so it places nothing; a take being
 * recorded counts; with none longer, the first loop). Every other loop
 * slots in where its ↺ falls, and editing it never moves the frame.
 *
 *   Z = [top of the placer]grid       top = the ↺'s moment (topOf)
 *   [x]grid = gridPhase + ⌊(x − gridPhase)/Q + ¼⌋·Q
 *
 * The zero is therefore always on the Q grid — the bar line at or before
 * the placer's ↺, a top up to ¼Q early being a PICKUP to the next line —
 * so the arm marker and every tile stay grid-true whatever a free slide
 * or a sub-Q re-time does.
 *
 * Seats: the root first, when it carries a song; a group with an
 * authored window or a song, as ONE lane from its own ↺; the members of
 * a plain anchored group, in order; a clip with content — a recording
 * take by its top alone (its period is unknown until stop and must not
 * move the lanes after it). Never: a one-shot (its offset IS its
 * placement, Q5), a drifting loop (Q22: each pass lands its top
 * elsewhere), an unanchored stack (no content, no top).
 *
 * @param {Array} nodes  the top-level nodes as the frame reads them
 *     (settledForFrame): a new take of a slot seats as the loop it is
 * @param {number} gridPhase  the Q grid's phase, samples
 * @returns {?{zero: number, placerId: string}}  samples; null with
 *     nothing to seat
 */
function seatFrameZero(state, nodes, quantum, gridPhase) {
    const seats = [];
    const rootSeq = activeSequenceSamples(state);
    if (rootSeq > 0) {
        seats.push({ id: state.id, top: rootSongTop(state),
                     period: lcm(quantum, Math.round(rootSeq)) });
    }
    const law = frameLaw(quantum);
    const moment = (n, t) => (n.origin || 0) + t.a0 + t.heard;
    const visit = ns => (ns || []).forEach(n => {
        if (n.periodSource === 'context') return;
        if (nodeDrifts(n, law)) return;
        const authored = mapAuthored(n, mapOf(n, quantum));
        if (n.type === 'stack') {
            if (!n.anchored) return;
            if (authored || activeSequenceSamples(n) > 0) {
                seats.push({ id: n.id, top: moment(n, topOf(n, authored, quantum)),
                             period: ownPeriod(n, law) });
            } else {
                visit(n.nodes);
            }
        } else {
            if (!(n.duration > 0)) return;
            seats.push({ id: n.id, top: moment(n, topOf(n, authored, quantum)),
                         period: n.isRecording ? 0 : ownPeriod(n, law),
                         recording: !!n.isRecording });
        }
    });
    visit(nodes);
    if (!seats.length) return null;
    const grid = x => gridPhase +
        Math.floor((x - gridPhase) / quantum + SEAT_PICKUP_Q + EPS) * quantum;
    const placer = seats.find(s => s.recording ||
        Math.round(s.period || 0) > quantum) || seats[0];
    return { zero: grid(placer.top), placerId: placer.id };
}

/**
 * THE ROOT'S SONG TOP (frame.md §4), samples: while it carries a song
 * the root is anchored — at the zero the view had seated when the song
 * was authored (Q18 at depth 0) — and the song folds from that origin.
 * Unanchored, the root's frame is the island zero.
 */
export function rootSongTop(state) {
    if (state.anchored && Number.isFinite(state.origin)) return state.origin;
    return state.islandZero ?? state.origin ?? 0;
}

/**
 * THE RE-SEAT TWEEN's path (frame.md §1): the zero at linear progress
 * `t` ∈ [0, 1] of a move from `from` (the zero last drawn) to the seat
 * `target`, eased, by the shortest way round the frame (reseatLanding).
 * At t = 1 it is the seat itself, exactly. Samples. Exported for the
 * tests.
 */
export function reseatZero(from, target, frameSamples, t) {
    if (!(t < 1)) return target;
    const via = reseatLanding(from, target, frameSamples);
    return from + (via - from) * easeInOut(Math.max(0, t));
}

/** Where a re-seat from `from` lands: the representative of the seat
 * `target` (mod the frame length) nearest `from`. Every lane's period
 * divides the frame, so all representatives draw the same picture, and
 * no re-seat sweeps more than half a frame. Exported for the tests. */
export function reseatLanding(from, target, frameSamples) {
    return frameSamples > 0
        ? from + posMod(target - from + frameSamples / 2, frameSamples) - frameSamples / 2
        : target;
}

/** The tween's curve: a sine ease-in-out. Over ~200 ms a cubic travels
 * only in its middle third and reads as the jump the tween exists to
 * avoid. Exported for the tests. */
export function easeInOut(p) {
    return 0.5 - 0.5 * Math.cos(Math.PI * p);
}

/**
 * THE ZERO DRAWN (frame.md §1), by precedence:
 *
 *   drag pin ?? re-seat tween ?? seat ?? the root's frame
 *
 * - DRAG PIN (opts.pinZero with opts.pinFrameQ; session_view/drag_pin.js):
 *   the frame a gesture engaged on, held until its last commit settles —
 *   a live commit re-anchors the edited lane, and the seat would follow
 *   it under the pointer. Not while a take records.
 * - RE-SEAT TWEEN (opts.reseat = { fromRel, t }; session_view/
 *   reseat_tween.js decides when one runs): the frame drawn moving onto
 *   a seat that has moved, from the zero it last showed. `fromRel` is
 *   measured from the root frame, so a seek — which moves the island
 *   zero and every origin together — carries it along. Not while a take
 *   is live or armed (the frame is the take's), nor in the trim view
 *   (its frame is the definer's buffer).
 *
 * @returns {{zero: number, source: 'pin'|'tween'|'seat'|'root',
 *     tweening: boolean, landing?: number}}  samples; `landing` is the
 *     tween's own end
 */
function resolveFrameZero({ opts, seated, rootFrame, qEstablished, anyRecording,
                            anyTakeActive, frameSamples, provisionalDefiner }) {
    if (opts.pinFrameQ > 0 && qEstablished && !anyRecording &&
        Number.isFinite(opts.pinZero)) {
        return { zero: opts.pinZero, source: 'pin', tweening: false };
    }
    const r = opts.reseat;
    if (r && seated !== null && !anyTakeActive && !provisionalDefiner &&
        Number.isFinite(r.fromRel) && Number.isFinite(r.t)) {
        const from = rootFrame + r.fromRel;
        return { zero: reseatZero(from, seated, frameSamples, r.t),
                 landing: reseatLanding(from, seated, frameSamples),
                 source: 'tween', tweening: r.t < 1 };
    }
    return seated !== null
        ? { zero: seated, source: 'seat', tweening: false }
        : { zero: rootFrame, source: 'root', tweening: false };
}

/**
 * The cursor while a take grows, in Q from `zero`: the raw clock folded
 * back by WHOLE committed cycles, so the take's start sits in the cycle
 * it started in and the bar runs on past the committed cycle
 * (computeRecordingFrame extends the frame to hold it). The take's start
 * — clock minus captured length — is snapped to a whole Q before the
 * fold (Q11): the latency compensation baked into the live duration must
 * not tip the fold, while the cursor keeps it, so the bar trails the
 * cursor by exactly the monitoring delay. Null when no take has captured
 * audio.
 *
 * @param {Array} nodes  as the frame reads them (settledForFrame): a new
 *     take of a committed slot is no growing take
 */
function recordingHeadQ(nodes, rawClock, zero, quantum, lcmQ) {
    let head = null;
    const posQ = (rawClock - zero) / quantum;
    const visit = ns => (ns || []).forEach(n => {
        if (n.type === 'stack') { visit(n.nodes); return; }
        if (!n.isRecording || !(n.duration > 0)) return;
        const anchorQ = Math.round(posQ - n.duration / quantum);
        const foldQ = lcmQ > 0 ? Math.floor(anchorQ / lcmQ) * lcmQ : 0;
        const q = Math.max(0, posQ - foldQ);
        head = head === null ? q : Math.max(head, q);
    });
    visit(nodes);
    return head;
}

/**
 * THE GROWING FRAME: while a take records, the frame extends one whole Q
 * at a time to hold the cursor, and settles to its final size the moment
 * the commit boundary is known. `nodes` as the frame reads them.
 *
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
                    // Known the moment stop is requested (the engine's
                    // own math).
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
                // FINISHING: settle now. Extending to ceil(playhead)
                // while the cursor runs past the known boundary would
                // make room for a Q the take never uses, then snap back
                // at commit. The cursor clamps at the frame edge for the
                // poll before the engine wraps it.
                const settleQ = lcm(Math.round(lcmQ * quantum),
                    Math.round(settleSamples)) / quantum;
                frameQ = Math.max(lcmQ, settleQ);
                playheadQ = Math.min(playheadQ, frameQ);
            } else {
                // Extend exactly AT the boundary: the take never runs
                // off-screen.
                frameQ = Math.max(lcmQ, Math.ceil(playheadQ - EPS));
            }
        } else {
            // Armed, no audio yet: the unwrapped clock crossing the arm
            // boundary must not stretch the settled frame, only to
            // squish it back when the take starts.
            playheadQ = playheadQ % frameQ;
        }
    }
    return { frameQ, playheadQ };
}

/**
 * THE FRAME PIN: while a map gesture is live (opts.pinFrameQ) the frame
 * holds at its drag-start length — live commits change the audible
 * cycle, and a frame that followed would rescale the timeline under the
 * pointer. The cursor holds with it: the raw clock is folded on the
 * cycle pinned at drag start (opts.pinFoldQ), so it jumps neither at the
 * grab nor at a commit, and `loopSamples` — what the 60 fps animator
 * wraps on — is pinned to the same fold. Not while a take records.
 *
 * @returns {{framePinned: boolean, frameQ: number, loopSamples: number,
 *     playheadQ: number}}
 */
function applyFramePin({ opts, rawClock, zero, quantum, qEstablished,
                         anyRecording, frameQ, loopSamples, playheadQ }) {
    const framePinned = opts.pinFrameQ > 0 && qEstablished && !anyRecording;
    if (framePinned) {
        frameQ = opts.pinFrameQ;
        const foldQ = opts.pinFoldQ > 0
            ? Math.min(opts.pinFoldQ, frameQ) : frameQ;
        if (rawClock !== null) {
            playheadQ = posMod((rawClock - zero) / quantum, foldQ);
        }
        loopSamples = foldQ * quantum;
    }
    return { framePinned, frameQ, loopSamples, playheadQ };
}

/**
 * The ONE playhead (I8) in display coordinates, and where the audible
 * loop begins in the frame (`loopStartQ`: the animator wraps from it).
 *
 * - Idle, it is folded on the frame: an idle masterPos should arrive
 *   wrapped, and one that did not would draw the cursor off the
 *   timeline. Never while recording.
 * - TRIM VIEW: the frame shows the definer's BUFFER while the transport
 *   publishes island time wrapped on Q, phase 0 at the selection's top.
 *   The cursor is that phase walked through the selection's runs
 *   (definerPlaceQ): it never visits the dead air or a cut.
 * - STEP AUDITION (sequencer.md §11.2) — of the sole top-level group
 *   whose derived window is the audible loop, or of the root
 *   (`rootWin`): the transport sweeps [0, step) while the lanes keep the
 *   whole song, so the cursor is shown at the step's place in it. An
 *   AUTHORED window needs no mapping: its lane shows heard material from
 *   the frame's top.
 *
 * @returns {{playheadQ: number, loopStartQ: number, heardQ: number}}
 *     `heardQ`: the playhead folded into the frame, before any mapping —
 *     in the trim view, its position in the definer's loop
 */
function mapPlayheadToDisplay({ playheadQ, frameQ, anyRecording,
                                provisionalDefiner, defSelStartQ, defSelRuns,
                                qEstablished, nodes, quantum, loopSamples,
                                rootWin }) {
    if (!anyRecording && frameQ > 0) playheadQ = playheadQ % frameQ;
    let loopStartQ = 0;
    const heardQ = playheadQ;
    if (provisionalDefiner) {
        loopStartQ = defSelStartQ;
        playheadQ = definerPlaceQ(defSelRuns, quantum, heardQ);
    } else if (!anyRecording && qEstablished) {
        const intoStep = (start, length) => {
            loopStartQ = start / quantum;
            playheadQ = loopStartQ + posMod(playheadQ, length / quantum);
        };
        const auds = nodes.filter(n => n.type === 'stack' &&
            isAuditionWindow(n) && publishedMapPeriod(n) > 0);
        if (auds.length === 1) {
            // An audition's derived map is one window: the step.
            const [start, end] = publishedMap(auds[0]).segs[0];
            if (Math.round(end - start) === Math.round(loopSamples)) {
                intoStep(start, end - start);
            }
        }
        if (rootWin) intoStep(rootWin.start, rootWin.end - rootWin.start);
    }
    return { playheadQ, loopStartQ, heardQ };
}

/**
 * The ruler's ticks, which are every lane's gridlines too: the island's
 * Q lines across the frame drawn. None before Q exists, on a frame that
 * is no whole number of Qs, or past 64Q (a first take's frame is its
 * sample count: no grid, and no DOM explosion).
 *
 * THE GRID RIDES THE ZERO (frame.md §1): `offQ` is how far past a grid
 * line the zero drawn sits — 0 at rest, a fraction while a re-seat tween
 * moves the frame — so the lines scroll with the tiles. Each line is
 * NAMED where it comes to rest: `toZeroQ` is the landing zero minus the
 * zero drawn, so a number rides its line through the move.
 *
 * @param {number} cycleQ     the frame drawn, Q
 * @param {number} [offQ]     Q in [0, 1)
 * @param {number} [toZeroQ]  Q; 0 at rest
 * @returns {Array<{q: number, major: boolean, at: number, end: boolean}>}
 *     `q` where the line is drawn; `at` the Q it names once the frame
 *     lands (a major every 4Q); `end` it is the landing frame's wrap
 */
export function buildRulerTicks(qEstablished, cycleQ, offQ = 0, toZeroQ = 0) {
    const ticks = [];
    if (qEstablished && Number.isInteger(cycleQ) && cycleQ > 0 && cycleQ <= 64) {
        for (let k = offQ > 0 ? 1 : 0; k - offQ <= cycleQ + EPS; k++) {
            const q = k - offQ;
            // Lines and landing zeros are whole Qs, up to float noise.
            const L = posMod(Math.round(q - toZeroQ), cycleQ);
            const end = L === 0 && q > EPS;
            const at = end ? cycleQ : L;
            ticks.push({ q, major: at % 4 === 0, at, end });
        }
    }
    return ticks;
}

/**
 * THE FRAME of one derive.
 *
 * @param {Object} state  the published state (after pending edits)
 * @param {Array} nodes   its top-level nodes
 * @param {Object} opts   deriveViewModel's options
 * @param {Object} given  { quantum, facts (collectTreeFacts), definer
 *     (resolveProvisionalDefiner) }
 * @returns {Object}  the literal at the end says what each field is; Q
 *     unless it says samples
 */
export function resolveFrame(state, nodes, opts, { quantum, facts, definer }) {
    const { anyRecording, anyTakeActive, maxRecordingDuration } = facts;
    const { provisionalDefiner, definerNode, defSelStartQ, defSelRuns } = definer;
    const qEstablished = quantum > 1;
    // The state supplies two things only: the root's own frame and,
    // through islandPos (the unwrapped clock measured from it), the raw
    // transport sample. The zero is seated from the lanes, never read.
    const rootFrame = state.islandZero ?? state.origin ?? 0;
    const gridPhase = qEstablished ? posMod(rootFrame, quantum) : 0;
    const frameNodes = settledForFrame(nodes, opts.retakes || null, quantum);
    const seat = qEstablished
        ? seatFrameZero(state, frameNodes, quantum, gridPhase) : null;
    const seated = seat ? seat.zero : null;
    const rawClock = Number.isFinite(state.islandPos)
        ? state.islandPos + rootFrame : null;

    // THE FRAME is the island cycle under the period law as the frame
    // reads it (frameLaw): lcm(Q, the root's own period) — its song when
    // it carries one (sequencer.md §2), else what its members hand it.
    // It must be the cycle the engine wraps the transport on, or the
    // cursor lies.
    const members = { type: 'stack', nodes: frameNodes };
    const root = { ...members, sequence: state.sequence };
    let cycleSamples = islandCycle(root, frameLaw(quantum), quantum, 0);
    // THE AUDIBLE LOOP is that cycle as HEARD (publishedLaw). It parts
    // from the frame only under a step audition — a group's here, the
    // root's below: the frame stays the song, the cursor loops the step.
    let loopSamples = islandCycle(root, publishedLaw(quantum), quantum, 0);
    // The cycle over the MEMBERS alone is the root grid's one-cycle
    // unit: the song's own length there would make every "+ step" add
    // one current song length.
    const intrinsicCycleQ =
        islandCycle(members, frameLaw(quantum), quantum, 0) / quantum;
    const rootSeqSamples = activeSequenceSamples(state);
    const zeroOf = resolveFrameZero({
        opts, seated, rootFrame, qEstablished, anyRecording,
        anyTakeActive, frameSamples: cycleSamples, provisionalDefiner,
    });
    const frameZero = zeroOf.zero;
    // THE ROOT'S STEP AUDITION (sequencer.md §11.2) is published as its
    // derived window: windowActive / loopStart / loopEnd.
    const rootWin = rootSeqSamples > 0 && nodeWindowActive(state) &&
        (state.loopEnd || 0) > (state.loopStart || 0)
        ? { start: state.loopStart, end: state.loopEnd } : null;
    if (rootWin) loopSamples = rootWin.end - rootWin.start;
    if (provisionalDefiner) {
        // THE TRIM VIEW frames the definer's whole take, not the Q
        // cycle, so nothing rescales as a drag changes Q. Its cursor
        // sweeps the selection, which IS Q — even with company (Q22),
        // where the island may cycle longer.
        const take = intrinsicPeriod(definerNode, quantum);
        if (take > 0) cycleSamples = take;
        loopSamples = quantum;
    }
    if (!qEstablished && maxRecordingDuration > 0) {
        // THE FIRST TAKE: before Q there is no cycle; the timeline is
        // the growing take. It grows in whole-second steps (4 s at
        // least) — a frame growing on every poll would rescale the
        // waveform continuously.
        const sr = (state.perf && state.perf.sampleRate) || 44100;
        cycleSamples = Math.max(4, Math.floor(maxRecordingDuration / sr) + 1) * sr;
    }
    const lcmQ = cycleSamples / quantum;

    // THE CURSOR is the raw clock folded on the audible cycle from the
    // zero drawn. While a take grows it is the take's end instead
    // (recordingHeadQ), never re-wrapped — a growing take would loop its
    // first Q over and over. Without a raw clock (fixtures) the
    // published masterPos stands in.
    let playheadQ;
    const growing = rawClock !== null && qEstablished
        ? recordingHeadQ(frameNodes, rawClock, frameZero, quantum, lcmQ)
        : null;
    if (growing !== null) {
        playheadQ = growing;
    } else if (rawClock !== null && seated !== null && loopSamples > 0) {
        playheadQ = posMod(rawClock - frameZero, loopSamples) / quantum;
    } else {
        playheadQ = Math.max(0, (state.masterPos || 0) / quantum);
    }
    const rec = computeRecordingFrame({
        nodes: frameNodes, quantum, qEstablished, anyRecording, lcmQ, playheadQ,
    });
    const pin = applyFramePin({
        opts, rawClock, zero: frameZero, quantum, qEstablished, anyRecording,
        frameQ: rec.frameQ, loopSamples, playheadQ: rec.playheadQ,
    });
    loopSamples = pin.loopSamples;
    const cycleQ = pin.frameQ;
    const mapped = mapPlayheadToDisplay({
        playheadQ: pin.playheadQ, frameQ: cycleQ, anyRecording,
        provisionalDefiner, defSelStartQ, defSelRuns, qEstablished, nodes,
        quantum, loopSamples, rootWin,
    });
    playheadQ = mapped.playheadQ;
    const loopStartQ = mapped.loopStartQ;

    // THE ARM MARKER (Q11): the next Q boundary of the ISLAND's grid —
    // "if you arm now"; the engine's own target rules once a clip is
    // armed. Island boundaries sit at loopStartQ + k. While a re-seat
    // tween moves the frame its zero sits `phiQ` of a Q past a grid
    // line, and the marker says where a take will start, not where the
    // moving frame's integers fall. In the trim view the boundary is
    // counted in HEARD time and placed through the selection: for a 1Q
    // selection it is the selection's end, whatever cuts lie inside.
    const phiQ = qEstablished && !provisionalDefiner
        ? (f => (f < EPS || f > 1 - EPS ? 0 : f))(
            posMod((frameZero - gridPhase) / quantum, 1))
        : 0;
    const relPosQ = (provisionalDefiner ? mapped.heardQ
                                        : playheadQ - loopStartQ) + phiQ;
    const nextQ = Math.ceil(relPosQ) === relPosQ
        ? relPosQ + 1 : Math.ceil(relPosQ);
    const armAtQ = provisionalDefiner
        ? definerPlaceQ(defSelRuns, quantum, nextQ)
        : loopStartQ - phiQ + nextQ;

    // THE PASS ZERO (Q22): the raw clock minus the cursor's own
    // position, so it holds for every fold the cursor takes. Whole
    // samples; without a raw clock the frame's zero stands in.
    const passZero = rawClock !== null && qEstablished
        ? Math.round(rawClock - playheadQ * quantum) : frameZero;

    const ticks = buildRulerTicks(qEstablished, cycleQ, phiQ,
        zeroOf.tweening && Number.isFinite(zeroOf.landing)
            ? (zeroOf.landing - frameZero) / quantum : 0);
    return {
        qEstablished,
        // Samples — the root's own frame (islandZero): the Q grid's
        // phase, and what a seek moves together with every origin.
        rootFrame,
        seated,             // samples — the seat; null with nothing to seat
        placerId: seat ? seat.placerId : null,  // the loop that placed it
        frameZero,          // samples — the zero DRAWN
        zeroSource: zeroOf.source,
        tweening: zeroOf.tweening,  // the zero is mid-move, off the Q grid
        // Samples — where the frame RESTS: the zero drawn or, mid-move,
        // the seat it is moving to. Always on the Q grid.
        restZero: zeroOf.tweening && seated !== null ? seated : frameZero,
        cycleQ,             // the frame drawn: what lanes tile and views fit
        lcmQ,               // the committed cycle (≤ cycleQ while a take grows)
        loopCycleQ: loopSamples / quantum,  // the AUDIBLE cycle
        loopStartQ,         // where that loop begins in the frame
        // A take has grown the frame past the committed cycle. A pinned
        // frame is settled, not provisional, even when live commits
        // have shrunk the committed cycle under it.
        frameExtended: !pin.framePinned && cycleQ > lcmQ,
        playheadQ,
        armAtQ,
        passZero,           // samples
        // The cycle the top-level lanes hear (LaneScope.cycleQ) — the
        // root's scope cycle: its step audition's pass, else its song,
        // else the audible loop as resolved above.
        scopeCycleQ: scopeCycle(
            rootWin ? rootWin.end - rootWin.start : rootSeqSamples,
            true, quantum, loopSamples) / quantum,
        intrinsicCycleQ,
        // The root's step audition, in frame Q (ruler brackets).
        rootWindow: rootWin ? {
            startQ: rootWin.start / quantum,
            endQ: rootWin.end / quantum,
            step: auditionStepOf(publishedSequence(state)),
        } : null,
        ruler: { cycleQ, ticks },
    };
}
