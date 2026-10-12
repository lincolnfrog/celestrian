/**
 * THE PLAY START (session_view.md display law 15): Space / ▶ plays
 * FROM the play start, and stopping returns the playhead TO it. It is
 * the top by default — where the loops' tops line up (the seat); a
 * ruler seek moves it to the seek's target, and a seek back to the top
 * restores the default.
 *
 * UI policy over the engine's two primitives: togglePlayback (a pure
 * pause / resume) and seekTransport. The play start is a PHASE —
 * samples into the audible loop as the ruler draws it — turned into an
 * advance against the latest frame facts on each return (seek.js).
 *
 * Per project and not persisted: a project switch falls back to the
 * top. Before Q there is no frame to seek in, and the toggle runs
 * alone. A seek the engine refuses (a take live or armed) leaves the
 * playhead where it is; a pause it refuses — the same take — leaves
 * the transport playing, and nothing here pretends otherwise.
 */

import { seekDelta, seekApplied } from './seek.js';

const start = { projectId: '', samples: 0 };
const transport = { isPlaying: false, seekable: false, frame: null };

/** A ruler seek landed: its target phase becomes the play start. */
export function notePlayStart(projectId, samples) {
    start.projectId = projectId;
    start.samples = samples;
}

/** The play start for `projectId` — the top unless this project's
 * ruler moved it. */
export function playStartFor(projectId) {
    return start.projectId === projectId ? start.samples : 0;
}

/** Poll feed: whether the transport runs, and the frame facts a seek
 * is computed against (session_facts.js lastFrame; null before a frame
 * exists — then no seek is sent). */
export function notePlayStartTransport(isPlaying, qEstablished, frame = null) {
    transport.isPlaying = !!isPlaying;
    transport.frame = qEstablished && frame ? frame : null;
    transport.seekable = transport.frame !== null;
}

/**
 * The frame a return is measured in. A ruler-set play start is a spot
 * the user pointed at in the frame AS DRAWN; the default is the SEAT
 * (frame.md §1). The two are one zero unless a drag's pin or a re-seat
 * tween has another on screen — and there, ruler 0 would start the
 * edited loop mid-section.
 */
function frameFor(projectId) {
    const f = transport.frame;
    const custom = start.projectId === projectId && start.samples !== 0;
    return !custom && Number.isFinite(f.seat) ? { ...f, zero: f.seat } : f;
}

async function returnToStart(call, projectId) {
    if (!transport.seekable) return;
    const delta = seekDelta(playStartFor(projectId), frameFor(projectId));
    if (delta === null) return;
    const result = await call('seekTransport', delta, transport.frame.rawClock);
    // Fold the applied seek into the frame facts (the next poll will
    // replace them; until then a second seek must not double-apply).
    transport.frame = seekApplied(transport.frame, result);
}

/**
 * The transport toggle with the play start: play seeks there first;
 * stop pauses, then returns the playhead there. `call` is callNative
 * (injected for tests). Once the engine has answered that it toggled,
 * the local isPlaying flips — at once, so a second press inside one
 * poll interval takes the other branch. A toggle it refused (false) or
 * that was lost (null) changes nothing here: the transport is as it
 * was. Returns the engine's answer.
 */
export async function togglePlayFromStart(call, projectId) {
    const wasPlaying = transport.isPlaying;
    if (!wasPlaying) await returnToStart(call, projectId);
    const toggled = await call('togglePlayback');
    if (!toggled) return toggled;
    transport.isPlaying = !wasPlaying;
    if (wasPlaying) await returnToStart(call, projectId);
    return toggled;
}
