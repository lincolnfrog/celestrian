/**
 * The record and transport verbs: a lane's ●, the R key, Space.
 *
 * There is no global record button: a track's ● is the record verb, a
 * group's ● records every empty track beneath it, and a hot lane's ●
 * stops it. Each is ONE bridge call on the lane's own id — the engine
 * owns the cascade (a group arms in one message-thread pass, so its
 * tracks share one arm target and one committed duration; a per-clip
 * loop here could straddle an audio block), the wait for the Q boundary
 * and arm-targets-emptiness.
 *
 * Every line is read off the engine's answer (shell_io.js `call`): ●
 * says "Recording" only once a take is armed, Space says "paused" only
 * once the transport has paused. The shell decides from the last poll,
 * so the engine can refuse what the poll made look possible — a second
 * arm, a pause — and the line then says that.
 */

import { armMode } from './view_model.js';
import { togglePlayFromStart } from './play_start.js';
import { NO_ANSWER } from './shell_io.js';
import { lastNodesById, lastRootId, isHotClip, anyTakeLive, clipsUnder,
         parentOf, topLevelNodes, noteGraphRead } from './session_facts.js';

/** Engine ClipNode::kMaxTakes: a slot holds no more. */
const MAX_TAKES = 32;

/**
 * What ● does on `node`, and the clips it acts on:
 *   'stop'    anything beneath is armed or capturing — stop it all;
 *   'record'  empty clips beneath — record them (full ones just play);
 *   'newTake' nothing empty: a committed clip, or a group's committed
 *             direct clips, take a NEW TAKE (docs/takes.md §2 — the
 *             engine refuses a plain arm on content);
 *   'none'    nothing ● can do (a committed one-shot, an empty group).
 */
export function armDecision(node) {
    const clips = clipsUnder(node);
    const hot = clips.filter(isHotClip);
    if (hot.length > 0) return { verb: 'stop', clips: hot };
    const empty = clips.filter(c => armMode(c) === 'record');
    if (empty.length > 0) return { verb: 'record', clips: empty };
    const direct = node.type === 'clip' ? [node] : (node.nodes || []);
    const slots = direct.filter(c => c.type === 'clip' && armMode(c) === 'retake');
    return { verb: slots.length > 0 ? 'newTake' : 'none', clips: slots };
}

/** The nearest ancestor of `node` that plays a loop window or a step
 * loop, or null. A take recorded beneath one is placed THROUGH it. */
function windowAbove(node) {
    for (let n = parentOf(node); n; n = parentOf(n)) {
        if (n.windowActive) return n;
    }
    return null;
}

/** Why the engine refused to arm `clips` (by id), as far as the noted
 * graph shows. One take is live at a time; the rest are the arm's own
 * refusals (AudioEngine::startRecordingInNode, newTake). */
export function armRefusal(verb, clips) {
    if (anyTakeLive()) return 'a take is already live (one take at a time)';
    const targets = clips.map(c => lastNodesById.get(c.id)).filter(Boolean);
    const above = targets.map(windowAbove).find(Boolean);
    if (verb === 'newTake') {
        if (above) {
            return `the loop window on "${above.name}" encloses the slot — bypass it first`;
        }
        if (targets.some(c => (c.takes || 0) >= MAX_TAKES)) {
            return 'the slot holds the most takes it can';
        }
    } else if (above) {
        return `a loop window above it cannot place the take (try bypassing the one on "${above.name}")`;
    }
    return 'the engine refused the arm';
}

/**
 * @param {object} deps
 * @param {object} deps.io  createShellIo's io
 * @param {(id: string) => boolean} deps.isRetake  the clip's live take
 *        is a new take of a committed slot (app.js reads it off the
 *        published `periodQ`)
 * @param {() => string} deps.projectId  the play start is per project
 */
export function createRecordVerbs({ io, isRetake, projectId }) {
    const { callNative, setLogLine, call, readState, freshState } = io;

    /** The line for an arm the engine refused: its reason is read from
     * the graph as it is then — a take that went live since the poll
     * that offered the arm is the usual one. */
    const notArmed = (what, verb, clips) => async () => {
        await freshState();
        return `${what} — ${armRefusal(verb, clips)}`;
    };

    /** A lane's ●. */
    async function onArm(lane) {
        const node = lastNodesById.get(lane.id);
        if (!node) return;
        const { verb, clips } = armDecision(node);
        if (verb === 'stop') {
            await call('stopRecordingInNode', [lane.id],
                clips.some(c => isRetake(c.id))
                    ? 'New take cancelled — the previous take sounds again'
                    : 'Stopped recording',
                'Nothing was recording there — the take had already ended');
        } else if (verb === 'record') {
            // The engine MIDI-arms a MIDI track on record: its notes
            // come from the keyboard.
            const midi = clips.every(c => c.contentKind === 'midi');
            await call('startRecordingInNode', [lane.id], clips.length > 1
                ? `Recording ${clips.length} empty tracks (full ones just play)`
                : midi ? 'Recording MIDI — play your keyboard' : 'Recording',
                notArmed('Not recording', verb, clips));
        } else if (verb === 'newTake') {
            await call('newTake', [lane.id], clips.length > 1
                ? `New take of ${clips.length} tracks from the group top (● again cancels)`
                : 'New take — one period from the slot top (● again cancels)',
                notArmed('No new take', verb, clips));
        } else {
            setLogLine('Nothing to record — loop a one-shot (↺) to take it again');
        }
    }

    /** Stop every take: one call on the root. Answers whether a take
     * was asked to stop. */
    async function stopAllTakes(okMsg) {
        if (!lastRootId) return false;
        return call('stopRecordingInNode', [lastRootId], okMsg,
            'Nothing was recording — the take had already ended');
    }

    /**
     * R: the selected lane's ● from the keyboard. Stop is
     * SELECTION-PROOF — with a take live anywhere, R stops everything
     * (one call on the root: the selection may have moved mid-take, and
     * a stop that does nothing while tape rolls is the worst failure).
     * With nothing hot, R records the selected lane; with no selection
     * and one top-level lane, that lane; with no lanes at all it
     * creates the default track and arms it.
     */
    async function onRecordKey(selectedId) {
        if (anyTakeLive()) {
            await stopAllTakes('Stopped recording');
            return;
        }
        if (lastNodesById.size === 0) {
            const made = await call('createNode', ['clip', ''], undefined,
                'No track to record on — the engine made none');
            if (!made) return;
            const st = await readState();
            if (!st) {
                setLogLine(NO_ANSWER);
                return;
            }
            noteGraphRead(st);
            await onArm({ id: made });
            return;
        }
        let id = selectedId && lastNodesById.has(selectedId) ? selectedId : null;
        if (!id) {
            const top = topLevelNodes();
            if (top.length === 1) id = top[0].id;
        }
        if (!id) {
            setLogLine('Select a track to record (R)');
            return;
        }
        await onArm({ id });
    }

    /** ▶ and the idle Space: play from the play start, stop back to it
     * (play_start.js). `okMsg` is said when the toggle itself is
     * answered, `refusedMsg` when the engine refused it — only a pause
     * can be, and only a live take refuses it; the seeks around the
     * toggle are silent. Answers whether the transport toggled. */
    const togglePlay = (okMsg, refusedMsg) => togglePlayFromStart(
        (name, ...args) => name === 'togglePlayback'
            ? call(name, args, okMsg, refusedMsg) : callNative(name, ...args),
        projectId());

    let pauseWhenTakeLands = false;
    let pauseInFlight = false;

    /**
     * SPACE STOPS EVERYTHING. With a take live it asks the take to stop
     * and queues the pause: the take finishes to its next boundary like
     * every stop, and the engine pauses under no live take — pausing
     * the clock first would strand it awaiting a boundary that never
     * comes. A second Space before it lands changes nothing. With no
     * take live, Space is the transport toggle; a take that went live
     * since the poll that said so makes the engine refuse the pause,
     * and the line says what Space does next.
     */
    async function onSpace() {
        if (anyTakeLive()) {
            if (pauseWhenTakeLands) return;
            pauseWhenTakeLands = true;
            const stopping = await stopAllTakes(
                'Stopping recording at the boundary, then pausing');
            // A lost call queues nothing. A take that had already ended
            // leaves the pause queued: it lands at the next poll.
            if (stopping === null) pauseWhenTakeLands = false;
            return;
        }
        pauseWhenTakeLands = false;
        await togglePlay(undefined,
            'Still playing — a take is live (Space again stops it)');
    }

    /** Poll hook: the pause onSpace queued, once nothing is hot. A
     * pause the engine still refuses — it counts the take a moment
     * longer than the poll shows — says so and stays queued for the
     * next poll. */
    function settlePendingPause(state) {
        if (!pauseWhenTakeLands || pauseInFlight || anyTakeLive()) return;
        pauseWhenTakeLands = false;
        if (!state.isPlaying) return;
        pauseInFlight = true;
        togglePlay('Recording stopped — paused',
            'The take is still landing — pausing as soon as it has').then(toggled => {
                pauseInFlight = false;
                if (toggled === false) pauseWhenTakeLands = true;
            });
    }

    return { onArm, onRecordKey, onSpace, settlePendingPause,
             // ▶: the same toggle, from the transport's button.
             togglePlay: () => togglePlay(undefined,
                 'Still playing — a take is live (stop the take first)') };
}
