/**
 * play_start.js — the PLAY START (session_view.md display law 15):
 * Space / ▶ always plays FROM the play start, and
 * stopping returns the playhead TO it. The play start is the top by
 * default — where the loops' tops line up (the seat), which is ruler 0
 * unless a drag's pin or a re-seat tween has another zero on screen; a
 * ruler seek moves it to the seek's target, and a click back at the top
 * restores the default.
 *
 * UI policy composed from the engine's two primitives — togglePlayback
 * (a pure pause/resume, which the engine's own flows and tests rely on)
 * and seekTransport (a whole-island phase advance). The play start is
 * a PHASE: samples into the audible loop as the ruler draws it. Each
 * return turns it into the advance that lands it against the latest
 * poll's frame facts (seek.js; docs/frame.md — the view seats the
 * frame's zero, the engine reads no frame).
 *
 * Per project and not persisted: a gesture of this session, so a
 * project switch (id change) falls back to the top. Pre-Q there is no
 * frame to seek in — the toggle runs alone. A seek the engine refuses
 * (a take live or armed) leaves the playhead where it is.
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
 * is computed against ({rawClock, zero, seat, loopSamples}; null before
 * a frame exists — then no seek is sent). `seat` (optional) is where the
 * loops' tops line up — the default play start's zero (frameFor). */
export function notePlayStartTransport(isPlaying, qEstablished, frame = null) {
    transport.isPlaying = !!isPlaying;
    transport.frame = qEstablished && frame ? frame : null;
    transport.seekable = transport.frame !== null;
}

/**
 * The frame a return is measured in. A ruler-set play start is a spot
 * the user pointed at in the frame AS DRAWN. The default — the top —
 * is where the loops' tops line up: the SEAT (frame.md §1). The two
 * are the same zero unless a drag's pin holds an older one on screen,
 * or a re-seat tween is still on its way (a region swapped past its ↺:
 * the ↺ moves, the picture follows a moment later) — there ruler 0
 * would start the edited loop mid-section.
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
 * (injected for tests). The local isPlaying flips at once so a second
 * press inside one poll interval takes the other branch.
 */
export async function togglePlayFromStart(call, projectId) {
    const wasPlaying = transport.isPlaying;
    if (!wasPlaying) await returnToStart(call, projectId);
    await call('togglePlayback');
    transport.isPlaying = !wasPlaying;
    if (wasPlaying) await returnToStart(call, projectId);
}
