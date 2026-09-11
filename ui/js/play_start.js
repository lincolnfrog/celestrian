/**
 * play_start.js — the PLAY START (docs/tasks.md open question 5, owner
 * ruling 2026-09-10): Space / ▶ always plays FROM the play start, and
 * stopping returns the playhead TO it. The play start is the top (0)
 * by default; a ruler seek moves it to the seek's target, and a click
 * back at the top restores the default.
 *
 * UI policy composed from the engine's two primitives — togglePlayback
 * (a pure pause/resume, which the engine's own flows and tests rely on)
 * and seekTransport (a whole-island phase jump). Positions are
 * seekTransport targets: published-masterPos samples.
 *
 * Per project and not persisted: a gesture of this session, so a
 * project switch (id change) falls back to the top. Pre-Q there is no
 * frame to seek in — the toggle runs alone. A seek the engine refuses
 * (a take live or armed) leaves the playhead where it is.
 */

const start = { projectId: '', samples: 0 };
const transport = { isPlaying: false, seekable: false };

/** A ruler seek landed: its target becomes the play start. */
export function notePlayStart(projectId, samples) {
    start.projectId = projectId;
    start.samples = samples;
}

/** The play start for `projectId` — the top unless this project's
 * ruler moved it. */
export function playStartFor(projectId) {
    return start.projectId === projectId ? start.samples : 0;
}

/** Poll feed: whether the transport runs and a frame exists to seek in. */
export function notePlayStartTransport(isPlaying, qEstablished) {
    transport.isPlaying = !!isPlaying;
    transport.seekable = !!qEstablished;
}

async function returnToStart(call, projectId) {
    if (transport.seekable) await call('seekTransport', playStartFor(projectId));
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
