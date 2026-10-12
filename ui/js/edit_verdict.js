/**
 * THE EDIT VERDICT: did a geometry commit land?
 *
 * The engine may refuse a window, map or re-time edit (coherence, a
 * live take, non-definer bounds, wrapper warps); announcing success
 * regardless would leave the next poll snapping the brackets back with
 * no explanation. A drag streams commits through one verb, and a
 * commit's own answer speaks for that commit alone — one that repeats
 * the last is "not applied" though the drag landed. So each geometry
 * verb here commits, then schedules ONE debounced state read that
 * compares what landed with what was asked and says which on the
 * status line. Debounced per node: only the state a drag ends on
 * deserves a verdict.
 */

import { findNodeInTree } from './view_model.js';
import { publishedMap } from './time_map.js';
import { lastNodesById } from './session_facts.js';

/** How long a node's commits must rest before its verdict is read. */
export const VERDICT_DEBOUNCE_MS = 250;

/** The view asks in the samples it computed, fractions included; the
 * engine stores whole samples. What landed may sit this far from what
 * was asked. */
export const LANDED_TOLERANCE_SAMPLES = 1;

const near = (got, want) => Math.abs(got - want) <= LANDED_TOLERANCE_SAMPLES;

/** Did a single-window request land on node `n`? The engine's clamps
 * count as landing: the start floors at 0, a clip's end at its
 * material. An empty request is a clear, landed when no window is left. */
export function windowLanded(n, startSamples, endSamples) {
    const s = Math.round(n.loopStart || 0);
    const e = Math.round(n.loopEnd || 0);
    if (endSamples <= startSamples) return e <= s;
    const wantS = Math.max(0, startSamples);
    const dur = n.duration || 0;
    const wantE = dur > 0 ? Math.min(endSamples, dur) : endSamples;
    return near(s, wantS) && near(e, wantE);
}

/** Did a map request (flat [s0, e0, s1, e1, …]) land? Two segments or
 * more must be published as asked; one segment is a single window to
 * the engine and is judged as one; none is a clear, landed when no
 * multi-segment map is left. */
export function segmentsLanded(n, flatSegments) {
    if (flatSegments.length >= 4) {
        const got = n.segments || [];
        return got.length === flatSegments.length &&
            got.every((v, i) => near(v, flatSegments[i]));
    }
    if (flatSegments.length < 2) return publishedMap(n).segs.length < 2;
    return windowLanded(n, flatSegments[0], flatSegments[1]);
}

/** Did a re-time land: the cumulative shift, and the loop top when the
 * commits named one? */
export function timingLanded(n, want) {
    return near(n.retime || 0, want.retime) &&
        (want.top === null || near(n.loopTop ?? -1, want.top));
}

/** Source files whose stack frames are the shell's own plumbing. */
const SHELL_FRAMES = new Set(['edit_verdict.js', 'app.js', 'backend.js']);

/** The first frame outside the shell — the module that asked. */
function callerOf(stack) {
    for (const frame of (stack || '').split('\n').slice(1)) {
        const m = frame.match(/([A-Za-z_]+\.js):(\d+)/);
        if (m && !SHELL_FRAMES.has(m[1])) return `${m[1]}:${m[2]}`;
    }
    return '?';
}

/**
 * @param {object} deps
 * @param {object} deps.io  createShellIo's io
 * @param {() => boolean} deps.isGestureLive  a drag is under the hand
 * @param {() => void} deps.clearPendingEdits  drop every gesture preview
 * @param {?(msg: string) => void} [deps.trace]  the commit trace's sink;
 *        null (the default) records nothing
 */
export function createEditVerdict({ io, isGestureLive, clearPendingEdits,
                                    trace = null }) {
    const { callNative, setLogLine, call, readState, takeLiveNow } = io;
    const verifyTimers = new Map();  // node id → its pending verdict
    // Shifts are relative, so the re-time verdict tracks what the
    // commits since the last verdict asked for: node id → {retime, top}.
    const timingAsked = new Map();

    /* THE COMMIT TRACE (debug). The loop region has two writers — the
     * lane's brackets (onSetWindow) and the region panel (onSetSegments,
     * which the engine folds back into a window for one segment). When
     * they disagree the region oscillates and neither writer's own log
     * shows the other; this logs every commit with its caller,
     * interleaved with each window the polls see move. */
    const traceSeen = new Map();     // node id → last observed [start, end]
    const short = id => String(id).slice(0, 6);

    function traceCommit(kind, id, startS, endS, live) {
        if (!trace) return;
        trace(`[trace] ${kind} id=${short(id)} ${startS}..${endS} ` +
            `len=${endS - startS} live=${live ? 1 : 0} ` +
            `from=${callerOf(new Error().stack)}`);
    }

    /** Poll hook: log every window that moved; forget nodes that left. */
    function noteGraph(nodesById) {
        for (const id of traceSeen.keys()) {
            if (!nodesById.has(id)) traceSeen.delete(id);
        }
        if (!trace) return;
        nodesById.forEach((n, id) => {
            if (typeof n.loopStart !== 'number' ||
                typeof n.loopEnd !== 'number') return;
            const prev = traceSeen.get(id);
            if (prev && prev[0] === n.loopStart && prev[1] === n.loopEnd) return;
            if (prev) {
                trace(`[trace] observed id=${short(id)} ` +
                    `${n.loopStart}..${n.loopEnd} len=${n.loopEnd - n.loopStart}`);
            }
            traceSeen.set(id, [n.loopStart, n.loopEnd]);
        });
    }

    function dropVerdict(id) {
        clearTimeout(verifyTimers.get(id));
        verifyTimers.delete(id);
        timingAsked.delete(id);
    }

    /** Replace node `id`'s pending verdict: after the debounce, read
     * the state and say `okMsg` when `check(node, state)` holds, else
     * `refusedMsg`. Silent when the read is lost or the node is gone —
     * a refusal message would lie. */
    function scheduleVerify(id, check, okMsg, refusedMsg) {
        clearTimeout(verifyTimers.get(id));
        verifyTimers.set(id, setTimeout(async () => {
            verifyTimers.delete(id);
            try {
                const state = await readState();
                const n = state && findNodeInTree(state.nodes, id);
                if (n) setLogLine(check(n, state) ? okMsg : refusedMsg);
            } catch (_) { /* the poll will tell the story */ }
        }, VERDICT_DEBOUNCE_MS));
    }

    /**
     * UNDO / REDO REPLACE THE GRAPH under what a just-finished gesture
     * left in flight, so both go with the keystroke: its pending
     * preview is held until a poll matches it, and after an undo none
     * will; its queued verdict would compare the undone graph with what
     * was asked and call the edit refused. A drag still under the hand
     * keeps its preview — its shift is measured from the base the
     * preview holds.
     */
    function dropStale() {
        if (!isGestureLive()) clearPendingEdits();
        for (const t of verifyTimers.values()) clearTimeout(t);
        verifyTimers.clear();
        timingAsked.clear();
    }

    /** A loop window (docs/time_maps.md). `live`: a mid-drag commit,
     * coalesced into the gesture's undo step. */
    async function onSetWindow(id, startSamples, endSamples, live = false) {
        traceCommit('setWindow  ', id, startSamples, endSamples, live);
        const r = await callNative('setLoopPoints', id, startSamples,
                                   endSamples, live);
        scheduleVerify(id, n => windowLanded(n, startSamples, endSamples),
            'Loop window set — ⌘Z to undo',
            'Loop window refused by the engine — geometry unchanged');
        return r;
    }

    /** A multi-segment map, flat [s0, e0, …] in samples. */
    async function onSetSegments(id, flatSegments, live = false) {
        traceCommit('setSegments', id, flatSegments[0],
                    flatSegments[flatSegments.length - 1], live);
        const r = await callNative('setSegments', id, flatSegments, live);
        scheduleVerify(id, n => segmentsLanded(n, flatSegments),
            'Map updated — ⌘Z to undo',
            'Map refused by the engine — unchanged');
        return r;
    }

    /** THE RE-TIME (docs/loop_selection.md §9): shift a clip's origin
     * by `shiftSamples`, and store `topSamples` as its loop top when
     * one is given. The verdict's target is the re-time the last poll
     * showed plus every shift sent since, and the last top sent. */
    async function onSetTiming(id, shiftSamples, topSamples = null, live = false) {
        const prev = timingAsked.get(id);
        const base = prev ? prev.retime
            : ((lastNodesById.get(id) || {}).retime || 0);
        const want = {
            retime: base + Math.round(shiftSamples),
            top: topSamples ?? (prev ? prev.top : null),
        };
        timingAsked.set(id, want);
        const r = await callNative('setTiming', id, shiftSamples,
                                   topSamples, live);
        scheduleVerify(id, n => {
            timingAsked.delete(id);
            return timingLanded(n, want);
        }, 'Timing shifted — ⌘Z to undo',
           'Re-time refused by the engine — timing unchanged');
        return r;
    }

    /** A CANCELLED DRAG (Escape, a lost capture): the engine puts the
     * node back as the gesture found it and drops the gesture's undo
     * step. The verdict its live commits queued goes too — the graph
     * is the gesture's start again, and either message would lie. A
     * cancel the engine refuses leaves what the drag did: undo is then
     * the way back, and the line says so. */
    async function onCancelGesture(id) {
        dropVerdict(id);
        const r = await call('cancelGesture', [id], 'Cancelled — nothing changed',
            async () => ((await takeLiveNow())
                ? 'Not cancelled — a take is live; what the drag did stands (⌘Z after the take)'
                : 'Not cancelled — what the drag did stands (⌘Z undoes it)'));
        // A live commit in flight when the cancel was sent answered
        // first (the bridge is in order) and queued its verdict since.
        dropVerdict(id);
        return r;
    }

    /** HAND Q TO A TRACK (Q22): one call, and the engine's answer is
     * the verdict. */
    function onSetDefiner(id) {
        const name = (lastNodesById.get(id) || {}).name || 'This track';
        return call('setDefiner', [id],
            `"${name}" sets Q now — drag its brackets to trim the ` +
            'tempo; it locks when you record the next track (⌘Z undoes)',
            async () => ((await takeLiveNow())
                ? 'Q not handed over — a take is live'
                : 'Q not handed over — the engine refused'));
    }

    return {
        noteGraph, dropStale,
        onSetWindow, onSetSegments, onSetTiming, onCancelGesture, onSetDefiner,
    };
}
