/**
 * THE JOURNEYS: deterministic verb sequences, each driven against the
 * engine and the mock from an empty session (session.mjs). Together
 * they call every undoable verb in ui/js/mock/undo.js's UNDOABLE list,
 * the refusals each verb makes, and the non-undoable gestures beside
 * them (seek, audition, knobs, a cancelled drag). Most sequences are
 * docs/scenarios.md's (the S-numbers in the comments); the rest probe a
 * law at its edge, or pin a sequence the random walk reached.
 *
 * Each journey runs twice: plain, and with an undo and a redo after
 * every call (run.mjs). The engine's reset between them clears what a
 * journey leaves — the template library, the master rack and an opened
 * project too.
 *
 * Q is 10 000 samples — not a multiple of the 512-sample block, so grid
 * boundaries fall inside blocks, as they do on a device.
 */

import { BLOCK } from './engine_process.mjs';

export const Q = 10000;

const journeys = [];
const journey = (name, run) => journeys.push({ name, run });

/** 1Q then 4Q: the island most journeys start from (cycle 4Q). */
async function oneAndFour(s) {
    await s.take('@A', Q);
    await s.advance(3000);
    await s.take('@B', 4 * Q);
}

/** A sole 4Q take: the island's Q-definer (Q is 4 of this file's Q). */
async function soleFour(s) {
    await s.take('@A', 4 * Q);
}

const steps = (...lens) => lens.map((len, i) => ({ name: String.fromCharCode(65 + i), len }));

// ------------------------------------------------------------------ takes

// S1: the first take defines Q; the second arms mid-cycle and pads.
journey('take/first-then-second', async s => {
    await s.take('@A', Q);
    await s.advance(3000);
    await s.take('@B', 3 * Q);
    await s.advance(Q + 700);
});

// S2: a longer take armed at phase 2Q of the 4Q cycle.
journey('take/third-at-phase', async s => {
    await oneAndFour(s);
    await s.toPhase(2 * Q - 900, 4 * Q);
    await s.take('@C', 8 * Q);
    await s.advance(2 * Q);
});

// S4: 1Q, 4Q, 3Q, 2Q — the cycle grows by lcm and never shrinks.
journey('take/lcm-growth', async s => {
    await oneAndFour(s);
    await s.take('@C', 3 * Q);
    await s.take('@D', 2 * Q);
    await s.advance(Q);
});

// The transport is stopped: the arm starts it.
journey('take/arm-from-stopped', async s => {
    await s.call('togglePlayback');
    await s.advance(4 * BLOCK);
    await s.create('@A');
    await s.call('startRecordingInNode', '@A');
    await s.advance(BLOCK);
    await s.advance(Q - BLOCK);
    await s.call('stopRecordingInNode', '@A');
    await s.advance(BLOCK);
});

// An arm exactly on a grid line, and one a sample past it.
journey('take/arm-on-the-line', async s => {
    await s.take('@A', Q);
    await s.toPhase(0, Q);
    await s.create('@B');
    await s.call('startRecordingInNode', '@B');
    await s.advance(BLOCK);
    await s.advance(Q);
    await s.call('stopRecordingInNode', '@B');
    await s.advance(Q);
    await s.toPhase(1, Q);
    await s.create('@C');
    await s.call('startRecordingInNode', '@C');
    await s.advance(BLOCK);
    await s.advance(Q);
    await s.call('stopRecordingInNode', '@C');
    await s.advance(2 * Q);
});

// A stop exactly on the grid, a stop a block after the arm, a stop
// while still armed (a cancel).
journey('take/stops', async s => {
    await s.take('@A', Q);
    await s.toPhase(Q - 2000, Q);
    await s.create('@B');
    await s.call('startRecordingInNode', '@B');
    await s.advance(2000 + 2 * Q);            // exactly 2Q captured
    await s.call('stopRecordingInNode', '@B');
    await s.advance(BLOCK);
    await s.advance(Q);
    await s.toPhase(2000, Q);
    await s.create('@C');
    await s.call('startRecordingInNode', '@C');
    await s.advance(BLOCK);
    await s.call('stopRecordingInNode', '@C');  // armed, not capturing
    await s.advance(BLOCK);
    await s.advance(Q);
    await s.call('startRecordingInNode', '@C');
    await s.call('stopRecordingInNode', '@C');  // cancelled before a block
    await s.advance(BLOCK);
});

// The very first take cancelled, then recorded.
journey('take/first-cancelled', async s => {
    await s.create('@A');
    await s.call('startRecordingInNode', '@A');
    await s.call('stopRecordingInNode', '@A');
    await s.advance(BLOCK);
    await s.call('startRecordingInNode', '@A');
    await s.advance(700);
    await s.call('stopRecordingInNode', '@A');
    await s.advance(BLOCK);
});

// The island's first take: its stop is a request the next block takes
// up. Until then the take is live — it refuses what a live take
// refuses, and a second stop is asked of the same take — and it ends at
// the length it had, however short the block that lands it.
journey('take/first-stop-lands-at-the-next-block', async s => {
    await s.create('@A');
    await s.call('startRecordingInNode', '@A');
    await s.advance(BLOCK);
    await s.advance(700);
    await s.call('stopRecordingInNode', '@A');
    await s.call('setLoopPoints', '@A', 0, 300);
    await s.call('togglePlayback');
    await s.call('stopRecordingInNode', '@A');
    await s.advance(1);
    await s.call('setLoopPoints', '@A', 0, 300);
    await s.advance(BLOCK);
});

// A first-take GROUP is asked as one and ends as one, at one length.
journey('take/first-group-stop', async s => {
    await s.create('@G', 'stack');
    await s.create('@A', 'clip', '@G');
    await s.create('@B', 'clip', '@G');
    await s.create('@C', 'clip', '@G');
    await s.call('startRecordingInNode', '@G');
    await s.advance(BLOCK);
    await s.advance(900);
    await s.call('stopRecordingInNode', '@G');
    await s.call('deleteNode', '@B');
    await s.advance(1);
    await s.call('setLoopPoints', '@G', 0, 400);
    await s.advance(BLOCK);
});

// Arm refusals: a committed clip, an unknown node, a stack with no
// empty clip, the root with nothing empty.
journey('take/arm-refusals', async s => {
    await oneAndFour(s);
    await s.call('startRecordingInNode', '@A');
    await s.advance(BLOCK);
    await s.call('startRecordingInNode', 'no-such-node');
    await s.create('@G', 'stack');
    await s.call('startRecordingInNode', '@G');
    await s.call('startRecordingInNode', '@ROOT');
    await s.advance(BLOCK);
    await s.call('stopRecordingInNode', 'no-such-node');
    await s.call('stopRecordingInNode', '@A');
    await s.advance(BLOCK);
});

// S27: one take at a time.
journey('take/one-at-a-time', async s => {
    await oneAndFour(s);
    await s.create('@C');
    await s.create('@D');
    await s.call('startRecordingInNode', '@C');
    await s.advance(BLOCK);
    await s.call('startRecordingInNode', '@D');
    await s.call('newTake', '@B');
    await s.advance(BLOCK);
    await s.until('@C capturing', s.capturingIn('@C'));
    await s.advance(Q / 2);
    await s.call('stopRecordingInNode', '@C');
    await s.until('@C settled', st => !s.hotIn('@C')(st));
    await s.advance(BLOCK);
    await s.record('@D', Q);
});

// S26: the live-take gate — which verbs a live take refuses, which
// stay live, and that everything works again after the commit.
journey('take/live-gate', async s => {
    await oneAndFour(s);
    await s.create('@C');
    await s.call('startRecordingInNode', '@C');
    await s.advance(BLOCK);
    await s.until('@C capturing', s.capturingIn('@C'));
    await s.call('setLoopPoints', '@B', Q, 3 * Q);
    await s.call('setSegments', '@B', [0, Q, 2 * Q, 3 * Q]);
    await s.call('toggleLoopWindow', '@B');
    await s.call('setTiming', '@B', Q);
    await s.call('deleteNode', '@A');
    await s.call('reorderNode', '@A', '@ROOT', 1);
    await s.combine('@X', '@A', '@B');
    await s.call('setSequence', '@ROOT', { steps: steps(4 * Q, 4 * Q), gates: {} });
    await s.call('toggleSequence', '@ROOT');
    await s.call('auditionStep', '@ROOT', 0);
    await s.call('setPeriodSource', '@A', 'context');
    await s.call('setDefiner', '@B');
    await s.call('selectTake', '@B', 0);
    await s.call('setComp', '@B', [0, 0, 0, 0]);
    await s.call('importAudio', '@A', s.wav(Q), s.fromZero(0));
    await s.call('undo');
    await s.call('redo');
    await s.call('togglePlayback');
    await s.call('seekTransport', Q);
    await s.call('toggleMute', '@A');
    await s.call('renameNode', '@A', 'keys');
    await s.call('setNodeInput', '@A', 1);
    await s.call('setNodeGain', '@A', 0.5);
    await s.create('@D');
    await s.advance(Q / 2);
    await s.call('stopRecordingInNode', '@C');
    await s.until('@C settled', st => !s.hotIn('@C')(st));
    await s.advance(BLOCK);
    await s.call('setLoopPoints', '@B', Q, 3 * Q);
});

// Edits made DURING a take, then the take's undo.
journey('take/edits-during-then-undo', async s => {
    await s.take('@A', Q);
    await s.create('@B');
    await s.call('startRecordingInNode', '@B');
    await s.advance(BLOCK);
    await s.until('@B capturing', s.capturingIn('@B'));
    await s.callLive('renameNode', '@A', 'renamed mid-take');
    await s.callLive('toggleMute', '@A');
    await s.callLive('createNode', 'clip', '');
    await s.advance(Q / 2);
    await s.callLive('stopRecordingInNode', '@B');
    await s.until('@B settled', st => !s.hotIn('@B')(st));
    await s.advance(BLOCK);
    await s.callLive('undo');
    await s.callLive('undo');
    await s.callLive('undo');
    await s.callLive('redo');
    await s.callLive('redo');
    await s.callLive('redo');
});

// Q7: a group take — the group's first, and the island's.
journey('take/group-first', async s => {
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.create('@M2', 'clip', '@G');
    await s.record('@G', 2 * Q, { watch: '@M1' });
    await s.advance(Q);
});

// S38: a three-mic group take beside 1Q + 4Q; delete a mic; undo.
journey('take/group-beside-content', async s => {
    await oneAndFour(s);
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.create('@M2', 'clip', '@G');
    await s.create('@M3', 'clip', '@G');
    await s.toPhase(2 * Q - 800, 4 * Q);
    await s.record('@G', 4 * Q, { watch: '@M1' });
    await s.call('setLoopPoints', '@G', Q, 3 * Q);
    await s.advance(Q);
    await s.call('deleteNode', '@M2');
    await s.call('undo');
    await s.advance(Q);
});

// A group with one committed and one empty member: the arm records
// only the empty one.
journey('take/group-partly-empty', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.take('@M1', 2 * Q, '@G');
    await s.create('@M2', 'clip', '@G');
    await s.record('@G', 2 * Q, { watch: '@M2' });
    await s.advance(Q);
});

// S29: record INTO a windowed group — one map pass, auto-finished.
journey('take/through-a-group-window', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.take('@M', 4 * Q, '@G');
    await s.call('setLoopPoints', '@G', Q, 3 * Q);
    await s.advance(700);
    await s.create('@N', 'clip', '@G');
    await s.call('startRecordingInNode', '@N');
    await s.advance(BLOCK);
    await s.until('@N capturing', s.capturingIn('@N'));
    await s.advance(Q);
    await s.until('@N settled', st => !s.hotIn('@N')(st));
    await s.advance(Q);
    await s.call('toggleLoopWindow', '@G');
    await s.advance(Q);
});

/** A group G (window [0,1Q)) holding a group H (window [1Q,3Q)) with a
 * 4Q take, and a 2Q take K beside H: an arm under H would record
 * through two maps. */
async function nestedMaps(s) {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.create('@H', 'stack', '@G');
    await s.take('@M', 4 * Q, '@H');
    await s.take('@K', 2 * Q, '@G');
    await s.callLive('setLoopPoints', '@H', Q, 3 * Q);
    await s.callLive('setLoopPoints', '@G', 0, Q);
}

// Maps on both an outer and an inner group: the arm beneath is
// refused, and nothing is left behind.
journey('take/refused-under-nested-maps', async s => {
    await nestedMaps(s);
    await s.create('@N', 'clip', '@H');
    await s.callLive('startRecordingInNode', '@N');
    await s.advance(BLOCK);
    await s.advance(3 * Q);
    await s.callLive('seekTransport', Q);
    await s.advance(BLOCK);
});

// …and a group arm with one refused member arms nobody.
journey('take/group-arm-with-a-refused-member', async s => {
    await nestedMaps(s);
    await s.create('@N', 'clip', '@H');
    await s.create('@P', 'clip', '@G');
    await s.callLive('startRecordingInNode', '@G');
    await s.advance(BLOCK);
});

// ---------------------------------------------------------------- windows

// S7: a window changes the period; bypass; re-activate; clear.
journey('window/trim-bypass-clear', async s => {
    await oneAndFour(s);
    await s.call('setLoopPoints', '@B', Q, 3 * Q);
    await s.advance(Q + 300);
    await s.call('toggleLoopWindow', '@B');
    await s.advance(Q + 300);
    await s.call('toggleLoopWindow', '@B');
    await s.advance(Q + 300);
    await s.call('setLoopPoints', '@B', 0, 0);
    await s.advance(Q + 300);
});

// S24: Q coherence — 1.5Q refused; 2Q, Q/2 and a whole-span accepted.
journey('window/coherence', async s => {
    await oneAndFour(s);
    await s.call('setLoopPoints', '@B', 0, 1.5 * Q);
    await s.call('setLoopPoints', '@B', 0, 2 * Q);
    await s.call('setLoopPoints', '@B', Q, 1.5 * Q);
    await s.call('setLoopPoints', '@B', 0, 4 * Q);
    await s.call('setLoopPoints', '@B', 0, 3 * Q);
    await s.advance(Q);
});

// Windows that cannot be: reversed, negative, past the take, empty
// clip, unknown node, the same window twice.
journey('window/refusals', async s => {
    await oneAndFour(s);
    await s.create('@E');
    await s.call('setLoopPoints', '@B', 3 * Q, Q);
    await s.call('setLoopPoints', '@B', -Q, Q);
    await s.call('setLoopPoints', '@B', 3 * Q, 5 * Q);
    await s.call('setLoopPoints', '@E', 0, Q);
    await s.call('setLoopPoints', 'no-such-node', 0, Q);
    await s.call('setLoopPoints', '@B', Q, 2 * Q);
    await s.call('setLoopPoints', '@B', Q, 2 * Q);
    await s.call('toggleLoopWindow', '@E');
    await s.call('toggleLoopWindow', 'no-such-node');
    await s.call('toggleLoopWindow', '@A');
});

// A zero-length window: on a clip with none, and over an existing one.
journey('window/zero-length', async s => {
    await oneAndFour(s);
    await s.call('setLoopPoints', '@B', Q, Q);
    await s.call('setLoopPoints', '@B', 3 * Q, 5 * Q);
    await s.call('setLoopPoints', '@B', Q, Q);
    await s.advance(600);
});

// S34: edits on B never move A — windows from three phases.
journey('window/from-three-phases', async s => {
    await oneAndFour(s);
    await s.toPhase(500, 4 * Q);
    await s.call('setLoopPoints', '@B', Q, 2 * Q);
    await s.toPhase(2 * Q + 4100, 4 * Q);
    await s.call('setLoopPoints', '@B', 2 * Q, 4 * Q);
    await s.toPhase(3 * Q + 9000, 4 * Q);
    await s.call('setLoopPoints', '@B', 0, Q);
    await s.advance(700);
    await s.call('setLoopPoints', '@B', 0, 0);
    await s.advance(Q);
});

// A sole take re-trimmed while it plays: Q := the window, the zero
// follows, the position sounding now keeps sounding.
journey('window/sole-definer-retrim', async s => {
    await soleFour(s);
    await s.toPhase(2.6 * Q, 4 * Q);
    await s.call('setLoopPoints', '@A', Q, 3 * Q);
    await s.advance(700);
    await s.call('setLoopPoints', '@A', Q, 2 * Q);
    await s.advance(Q + 300);
    await s.call('toggleLoopWindow', '@A');
    await s.advance(Q);
    await s.call('toggleLoopWindow', '@A');
    await s.advance(300);
    await s.call('setLoopPoints', '@A', 0, 0);
    await s.advance(Q);
});

// S9: the definer's trim, the lock-collapse at the second arm, the
// re-open on delete, and its undo.
journey('window/definer-collapse-reopen', async s => {
    await soleFour(s);
    await s.toTakePosition('@A', Q);
    await s.call('setLoopPoints', '@A', Q, 2 * Q);
    await s.advance(Q + 2300);
    await s.take('@B', Q);
    await s.advance(700);
    await s.call('deleteNode', '@B');
    await s.advance(700);
    await s.call('undo');
    await s.advance(700);
});

// A collapsed definer, the second take undone, then an EMPTY track
// deleted beside it.
journey('window/delete-empty-beside-collapsed', async s => {
    await soleFour(s);
    await s.toTakePosition('@A', 0);
    await s.call('setLoopPoints', '@A', 0, Q);
    await s.advance(700);
    await s.take('@B', Q);
    await s.callLive('undo');
    await s.advance(700);
    await s.call('deleteNode', '@B');
    await s.advance(700);
});

// A refused arm (a committed member of a trimmed definer group).
journey('window/refused-arm-on-trimmed-definer-group', async s => {
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.create('@M2', 'clip', '@G');
    await s.record('@G', 4 * Q, { watch: '@M1' });
    await s.call('setLoopPoints', '@G', Q, 2 * Q);
    await s.advance(700);
    await s.call('startRecordingInNode', '@M1');
    await s.advance(BLOCK);
    await s.advance(Q);
});

// S10: Q13 for groups — a 2-mic 4Q group, trimmed, then a 1Q take.
journey('window/definer-group', async s => {
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.create('@M2', 'clip', '@G');
    await s.record('@G', 4 * Q, { watch: '@M1' });
    await s.advance(1300);
    await s.call('setLoopPoints', '@G', Q, 2 * Q);
    await s.advance(Q + 400);
    await s.take('@B', Q);
    await s.advance(600);
    await s.call('deleteNode', '@B');
    await s.advance(600);
});

// Arming THROUGH the definer group (a new empty member).
journey('window/arm-inside-definer-group', async s => {
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.record('@G', 4 * Q, { watch: '@M1' });
    await s.call('setLoopPoints', '@G', Q, 3 * Q);
    await s.advance(900);
    await s.create('@M2', 'clip', '@G');
    await s.call('startRecordingInNode', '@G');
    await s.advance(BLOCK);
    await s.advance(3 * Q);
    await s.call('stopRecordingInNode', '@G');
    await s.advance(3 * Q);
});

// S8: a nested composite; a window on the group.
journey('window/on-a-group', async s => {
    await oneAndFour(s);
    await s.create('@G', 'stack');
    await s.take('@M1', 2 * Q, '@G');
    await s.take('@M2', 3 * Q, '@G');
    await s.call('setLoopPoints', '@G', 2 * Q, 4 * Q);
    await s.advance(Q + 300);
    await s.call('toggleLoopWindow', '@G');
    await s.advance(700);
    await s.call('setLoopPoints', '@G', 0, 7 * Q);
    await s.call('setLoopPoints', '@G', 0, 0);
});

// S35: nested maps.
journey('window/nested', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.take('@M1', 4 * Q, '@G');
    await s.take('@M2', 2 * Q, '@G');
    await s.call('setLoopPoints', '@M1', Q, 3 * Q);
    await s.advance(500);
    await s.call('setLoopPoints', '@G', 0, Q);
    await s.advance(Q + 500);
    await s.advance(Q);                            // the inner phase, two passes apart
    await s.call('setLoopPoints', '@M1', 2 * Q, 4 * Q);
    await s.advance(500);
    await s.advance(Q);
    await s.call('toggleLoopWindow', '@G');
    await s.advance(Q);
});

// A live drag: one non-live commit, then live ones — one undo step.
journey('window/live-drag', async s => {
    await oneAndFour(s);
    await s.callLive('setLoopPoints', '@B', 0, 4 * Q);
    await s.callLive('setLoopPoints', '@B', 0, 3 * Q, true);
    await s.advance(700);
    await s.callLive('setLoopPoints', '@B', 0, 2 * Q, true);
    await s.callLive('setLoopPoints', '@B', 0, 2 * Q, true);
    await s.callLive('setLoopPoints', '@B', Q, 3 * Q, true);
    await s.callLive('undo');
    await s.callLive('redo');
    await s.callLive('setLoopPoints', '@B', Q, 2 * Q, true);   // a stray live commit
    await s.callLive('undo');
    await s.callLive('undo');
    await s.callLive('undo');
});

// A cancelled live drag leaves no undo step, and the redo branch the
// drag would have dropped returns.
journey('window/cancelled-drag', async s => {
    await oneAndFour(s);
    await s.callLive('toggleMute', '@A');
    await s.callLive('undo');
    await s.callLive('setLoopPoints', '@B', 0, 4 * Q);
    await s.callLive('setLoopPoints', '@B', 0, 2 * Q, true);
    await s.advance(600);
    await s.callLive('setLoopPoints', '@B', Q, 3 * Q, true);
    await s.callLive('cancelGesture', '@B');
    await s.advance(600);
    await s.callLive('redo');
    await s.callLive('cancelGesture', '@B');
    await s.callLive('cancelGesture', 'no-such-node');
    await s.callLive('setLoopPoints', '@B', 0, 2 * Q);
    await s.callLive('cancelGesture', '@A');
    await s.callLive('cancelGesture', '@B');
    await s.callLive('undo');
});

// ------------------------------------------------------------------- cuts

// S33: cut bands — the map, a slide, bypass, clear.
journey('cuts/bands', async s => {
    await oneAndFour(s);
    await s.call('setSegments', '@B', [0, Q, 2 * Q, 3 * Q]);
    await s.advance(Q + 300);
    await s.call('setSegments', '@B', [Q, 2 * Q, 3 * Q, 4 * Q]);
    await s.advance(Q + 300);
    await s.call('toggleLoopWindow', '@B');
    await s.advance(700);
    await s.call('toggleLoopWindow', '@B');
    await s.call('setSegments', '@B', []);
    await s.advance(700);
    await s.call('setSegments', '@B', [Q, 3 * Q]);
    await s.call('setSegments', '@B', [0, Q, Q, 2 * Q]);
    await s.advance(700);
});

// A live cut drag, and a drag that switches verb mid-gesture.
journey('cuts/live-drag', async s => {
    await oneAndFour(s);
    await s.callLive('setSegments', '@B', [0, Q, 2 * Q, 3 * Q]);
    await s.callLive('setSegments', '@B', [0, Q, 2.5 * Q, 3.5 * Q], true);
    await s.callLive('setSegments', '@B', [0, Q, 3 * Q, 4 * Q], true);
    await s.callLive('setLoopPoints', '@B', 0, 2 * Q, true);
    await s.callLive('undo');
    await s.callLive('redo');
    await s.callLive('setSegments', '@B', [0, Q, 2 * Q, 3 * Q]);
    await s.callLive('setSegments', '@B', [0, Q, 3 * Q, 4 * Q], true);
    await s.callLive('cancelGesture', '@B');
    await s.callLive('undo');
    await s.callLive('undo');
});

// Cuts that cannot be: reversed, overlapping, past the take, an
// incoherent period, an odd count, an empty clip, an unknown node.
journey('cuts/refusals', async s => {
    await oneAndFour(s);
    await s.create('@E');
    await s.call('setSegments', '@B', [Q, 0, 2 * Q, 3 * Q]);
    await s.call('setSegments', '@B', [0, 2 * Q, Q, 3 * Q]);
    await s.call('setSegments', '@B', [0, Q, 3 * Q, 5 * Q]);
    await s.call('setSegments', '@B', [0, Q, 2 * Q, 2.5 * Q]);
    await s.call('setSegments', '@B', [0, Q, 2 * Q]);
    await s.call('setSegments', '@B', [-Q, 0, Q, 2 * Q]);
    await s.call('setSegments', '@E', [0, Q, 2 * Q, 3 * Q]);
    await s.call('setSegments', 'no-such-node', [0, Q, 2 * Q, 3 * Q]);
    await s.call('setSegments', '@B', [0, Q, 2 * Q, 3 * Q]);
    await s.call('setSegments', '@B', [0, Q, 2 * Q, 3 * Q]);
});

// The definer carrying a multi-segment map when the second take arms.
journey('cuts/definer-with-cells-then-arm', async s => {
    await soleFour(s);
    await s.toTakePosition('@A', 0);
    await s.call('setLoopPoints', '@A', 0, 2 * Q);
    await s.advance(700);
    await s.call('setSegments', '@A', [0, Q, 2 * Q, 3 * Q]);
    await s.advance(700);
    await s.create('@B');
    await s.call('startRecordingInNode', '@B');
    await s.advance(BLOCK);
    await s.advance(3 * Q);
    await s.call('stopRecordingInNode', '@B');
    await s.advance(3 * Q);
});

// A BYPASSED multi-segment map elsewhere, and who the definer is.
journey('cuts/bypassed-cells-and-the-definer', async s => {
    await s.take('@A', Q);
    await s.take('@B', 4 * Q);
    await s.call('setSegments', '@B', [0, Q, 2 * Q, 3 * Q]);
    await s.call('toggleLoopWindow', '@B');
    await s.call('deleteNode', '@A');
    await s.toTakePosition('@B', 0);
    await s.call('setLoopPoints', '@B', 0, 2 * Q);
    await s.advance(600);
});

// A group's cells.
journey('cuts/on-a-group', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.take('@M1', 4 * Q, '@G');
    await s.take('@M2', 2 * Q, '@G');
    await s.call('setSegments', '@G', [0, Q, 2 * Q, 3 * Q]);
    await s.advance(Q + 500);
    await s.call('setSegments', '@G', []);
    await s.advance(500);
});

// ----------------------------------------------------------------- timing

// S41: a re-time moves a take by any amount; a swap keeps it; "as
// played" returns it.
journey('timing/shift', async s => {
    await oneAndFour(s);
    await s.call('setTiming', '@B', Q);
    await s.advance(700);
    await s.call('setTiming', '@B', 0.3 * Q);
    await s.advance(700);
    await s.call('setLoopPoints', '@B', 0, 2 * Q);
    await s.call('setLoopPoints', '@B', Q, 3 * Q);
    await s.advance(700);
    await s.call('setTiming', '@B', -1.3 * Q);
    await s.advance(700);
});

// The top: stored inside the kept set, refused outside it.
journey('timing/top', async s => {
    await oneAndFour(s);
    await s.call('setLoopPoints', '@B', Q, 3 * Q);
    await s.call('setTiming', '@B', 0, 2 * Q);
    await s.advance(700);
    await s.call('setTiming', '@B', 0, 3.5 * Q);
    await s.call('setTiming', '@B', Q / 2, 1.5 * Q);
    await s.call('setLoopPoints', '@B', 2 * Q, 4 * Q);
    await s.advance(700);
    await s.call('toggleLoopWindow', '@B');
    await s.call('toggleLoopWindow', '@B');
    await s.call('setLoopPoints', '@B', 0, 0);
    await s.call('setTiming', '@B', 0, Q);
});

// A live re-time drag is one step; a cancelled one is none.
journey('timing/live-drag', async s => {
    await oneAndFour(s);
    await s.callLive('setTiming', '@B', 0);
    await s.callLive('setTiming', '@B', 1000, null, true);
    await s.callLive('setTiming', '@B', 1000, null, true);
    await s.advance(600);
    await s.callLive('setTiming', '@B', 500, null, true);
    await s.callLive('undo');
    await s.callLive('redo');
    await s.callLive('setTiming', '@B', 0);
    await s.callLive('setTiming', '@B', 2000, null, true);
    await s.callLive('cancelGesture', '@B');
    await s.callLive('undo');
});

// Re-times that cannot be, and the nodes that take none.
journey('timing/refusals', async s => {
    await oneAndFour(s);
    await s.create('@E');
    await s.combine('@G', '@A', '@E');
    await s.call('setTiming', '@E', Q);
    await s.call('setTiming', 'no-such-node', Q);
    await s.call('setTiming', '@G', Q);
    await s.call('setTiming', '@B', 0);
    await s.call('setTiming', '@B', 0, -1);
    await s.call('setTiming', '@B', 0, 9 * Q);
    await s.advance(600);
});

// A sole take re-timed: the definer's origin and the zero.
journey('timing/sole-definer', async s => {
    await soleFour(s);
    await s.call('setTiming', '@A', Q);
    await s.advance(600);
    await s.toTakePosition('@A', Q);
    await s.call('setLoopPoints', '@A', Q, 2 * Q);
    await s.call('setTiming', '@A', 0, 1.5 * Q);
    await s.advance(600);
});

// ------------------------------------------------------------------ takes list

// S15: a new take of the 4Q slot, select, comp, delete.
journey('takes/new-select-comp-delete', async s => {
    await oneAndFour(s);
    await s.call('newTake', '@B');
    await s.advance(BLOCK);
    await s.until('@B capturing', s.capturingIn('@B'));
    await s.advance(Q);
    await s.until('@B settled', st => !s.hotIn('@B')(st));
    await s.advance(BLOCK);
    await s.call('selectTake', '@B', 0);
    await s.call('selectTake', '@B', 0);
    await s.call('selectTake', '@B', 7);
    await s.call('setComp', '@B', [0, 1, 0, 1]);
    await s.call('setComp', '@B', [0, 1, 0, 1]);
    await s.call('setComp', '@B', [0, 1]);
    await s.call('setComp', '@B', [0, 5, 0, 1]);
    await s.call('selectTake', '@B', 1);
    await s.call('deleteTake', '@B', 1);
    await s.call('deleteTake', '@B', 0);
    await s.call('setComp', '@B', []);
});

// The comp under a delete: cells renumber, and fall back.
journey('takes/comp-under-delete', async s => {
    await oneAndFour(s);
    for (let i = 0; i < 2; i++) {
        await s.call('newTake', '@B');
        await s.advance(BLOCK);
        await s.until('@B capturing', s.capturingIn('@B'));
        await s.until('@B settled', st => !s.hotIn('@B')(st));
        await s.advance(BLOCK);
    }
    await s.call('setComp', '@B', [0, 1, 2, -1]);
    await s.call('deleteTake', '@B', 1);
    await s.call('deleteTake', '@B', 1);
    await s.call('setComp', '@B', []);
    await s.call('deleteTake', '@B', 0);
});

// S16: a new take stopped early is cancelled.
journey('takes/new-take-cancelled', async s => {
    await oneAndFour(s);
    await s.call('newTake', '@B');
    await s.advance(BLOCK);
    await s.until('@B capturing', s.capturingIn('@B'));
    await s.advance(Q);
    await s.call('stopRecordingInNode', '@B');
    await s.advance(BLOCK);
    await s.advance(Q);
    await s.call('newTake', '@B');
    await s.call('stopRecordingInNode', '@B');
    await s.advance(BLOCK);
});

// New-take refusals: an empty clip, a one-shot, under an active group
// map, an unknown node; the take-list verbs on the wrong nodes.
journey('takes/refusals', async s => {
    await oneAndFour(s);
    await s.create('@E');
    await s.create('@G', 'stack');
    await s.take('@M', 2 * Q, '@G');
    await s.call('newTake', '@E');
    await s.call('newTake', 'no-such-node');
    await s.call('setPeriodSource', '@B', 'context');
    await s.call('newTake', '@B');
    await s.call('setPeriodSource', '@B', 'own');
    await s.call('setLoopPoints', '@G', 0, Q);
    await s.call('newTake', '@M');
    await s.advance(BLOCK);
    await s.call('selectTake', '@E', 0);
    await s.call('selectTake', '@G', 0);
    await s.call('selectTake', 'no-such-node', 0);
    await s.call('deleteTake', '@E', 0);
    await s.call('deleteTake', '@B', 0);
    await s.call('setComp', '@E', [0]);
    await s.call('setComp', '@G', [0, 0]);
    await s.call('setComp', '@B', [0, 0, 0, 0]);
});

// A track made while a new take is armed; the take cancelled; undo.
journey('takes/new-take-cancelled-then-undo', async s => {
    await s.take('@A', Q);
    await s.take('@B', Q / 2);
    await s.callLive('deleteNode', '@A');
    await s.callLive('newTake', '@B');
    await s.advance(BLOCK);
    await s.callLive('createNode', 'clip', '');
    await s.callLive('stopRecordingInNode', '@B');
    await s.advance(BLOCK);
    await s.callLive('undo');
    await s.callLive('undo');
});

// A new take after a backward seek (origins ahead of the clock).
journey('takes/new-take-after-a-backward-seek', async s => {
    await s.take('@A', Q);
    await s.take('@B', 2 * Q);
    await s.callLive('seekTransport', -5 * Q);
    await s.call('newTake', '@B');
    await s.advance(BLOCK);
    await s.until('@B capturing', s.capturingIn('@B'));
    await s.until('@B settled', st => !s.hotIn('@B')(st));
    await s.advance(BLOCK);
});

// A group's new take: its committed direct clips, one performance.
journey('takes/group-new-take', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.create('@M2', 'clip', '@G');
    await s.record('@G', 2 * Q, { watch: '@M1' });
    await s.call('newTake', '@G');
    await s.advance(BLOCK);
    await s.until('@M1 capturing', s.capturingIn('@M1'));
    await s.until('@M1 settled', st => !s.hotIn('@M1')(st));
    await s.advance(BLOCK);
    await s.call('selectTake', '@M1', 0);
});

// A new take on a trimmed slot, and on a sole definer.
journey('takes/new-take-on-a-windowed-slot', async s => {
    await oneAndFour(s);
    await s.call('setLoopPoints', '@B', Q, 3 * Q);
    await s.advance(600);
    await s.call('newTake', '@B');
    await s.advance(BLOCK);
    await s.until('@B capturing', s.capturingIn('@B'));
    await s.until('@B settled', st => !s.hotIn('@B')(st));
    await s.advance(BLOCK);
});

/** A second take of the sole 4Q slot @A. */
async function soleFourTwice(s) {
    await soleFour(s);
    await s.call('newTake', '@A');
    await s.advance(BLOCK);
    await s.until('@A capturing', s.capturingIn('@A'));
    await s.until('@A settled', st => !s.hotIn('@A')(st));
    await s.advance(BLOCK);
}

// The comp's geometry: its cells keep the Q they were authored at when a
// definer trim moves Q; the lock-collapse slides them with the content,
// and the re-opening delete brings them back.
journey('takes/comp-rides-the-collapse', async s => {
    await soleFourTwice(s);
    await s.call('setLoopPoints', '@A', Q, 3 * Q);          // Q := 2 of this file's Q
    await s.call('setComp', '@A', [1, 0]);
    await s.call('setLoopPoints', '@A', Q, 2 * Q);          // Q moves under the comp
    await s.advance(700);
    await s.create('@B');
    await s.call('startRecordingInNode', '@B');            // @A collapses to its window
    await s.advance(BLOCK);
    await s.until('@B capturing', s.capturingIn('@B'));
    await s.advance(Q);
    await s.call('stopRecordingInNode', '@B');
    await s.until('@B settled', st => !s.hotIn('@B')(st));
    await s.advance(BLOCK);
    await s.call('deleteNode', '@B');                       // @A re-opens
    await s.call('setComp', '@A', []);
});

// A splice at the lock consumes the comp.
journey('takes/comp-under-a-splice', async s => {
    await soleFourTwice(s);
    await s.call('setSegments', '@A', [0, Q, 2 * Q, 3 * Q]);   // Q := 2 of this file's Q
    await s.call('setComp', '@A', [1, 0]);
    await s.create('@B');
    await s.call('startRecordingInNode', '@B');
    await s.advance(BLOCK);
    await s.call('stopRecordingInNode', '@B');
    await s.advance(BLOCK);
});

journey('takes/new-take-on-the-sole-definer', async s => {
    await soleFour(s);
    await s.toTakePosition('@A', Q);
    await s.call('setLoopPoints', '@A', Q, 2 * Q);
    await s.advance(600);
    await s.call('newTake', '@A');
    await s.advance(BLOCK);
    await s.until('@A capturing', s.capturingIn('@A'));
    await s.until('@A settled', st => !s.hotIn('@A')(st));
    await s.advance(BLOCK);
});

// ------------------------------------------------------------------ graph

journey('graph/create-rename-delete', async s => {
    await s.create('@A');
    await s.create('@G', 'stack');
    await s.create('@M', 'clip', '@G');
    await s.create('@H', 'stack', '@G');
    await s.create('@X', 'clip', '@A');            // a clip is no parent
    await s.create('@Y', 'clip', 'no-such-node');
    await s.call('renameNode', '@A', 'bass');
    await s.call('renameNode', '@A', 'bass');
    await s.call('renameNode', '@G', '');
    await s.call('renameNode', 'no-such-node', 'x');
    await s.call('deleteNode', '@M');
    await s.call('deleteNode', '@M');
    await s.call('deleteNode', 'no-such-node');
    await s.call('deleteNode', '@G');
    await s.call('deleteNode', '@ROOT');
    await s.call('deleteNode', '@A');
});

// A type that is neither 'clip' nor 'stack'.
journey('graph/create-unknown-type', async s => {
    await s.create('@Z', 'reverb', '');
});

journey('graph/reorder', async s => {
    await s.create('@A');
    await s.create('@B');
    await s.create('@G', 'stack');
    await s.create('@H', 'stack', '@G');
    await s.create('@C');
    await s.call('reorderNode', '@A', '@G', 0);
    await s.call('reorderNode', '@B', '@G', 5);
    await s.call('reorderNode', '@B', '@G', 0);
    await s.call('reorderNode', '@B', '@G', -3);
    await s.call('reorderNode', '@A', '@ROOT', 0);
    await s.call('reorderNode', '@G', '@H', 0);    // into its own descendant
    await s.call('reorderNode', '@G', '@G', 0);
    await s.call('reorderNode', '@C', '@A', 0);    // a clip is no parent
    await s.call('reorderNode', '@C', 'no-such-node', 0);
    await s.call('reorderNode', 'no-such-node', '@G', 0);
    await s.call('reorderNode', '@C', '@ROOT', 2);
    await s.call('reorderNode', '@C', '@ROOT', 2);
});

// A move whose parent is the empty string (createNode reads '' as the
// top level).
journey('graph/reorder-to-an-empty-parent', async s => {
    await s.create('@A');
    await s.create('@B');
    await s.call('reorderNode', '@A', '', 1);
});

// S21: combine and explode — the group anchors at the earliest member.
journey('graph/combine-explode', async s => {
    await oneAndFour(s);
    await s.toPhase(2 * Q - 700, 4 * Q);
    await s.take('@C', 4 * Q);
    await s.combine('@G', '@C', '@B');
    await s.advance(600);
    await s.combine('@H', '@A', '@G');
    await s.call('reorderNode', '@B', '@ROOT', 0);
    await s.call('reorderNode', '@C', '@ROOT', 1);
    await s.call('deleteNode', '@G');
    await s.advance(600);
});

journey('graph/combine-refusals', async s => {
    await s.create('@A');
    await s.create('@B');
    await s.combine('@G', '@A', '@B');
    await s.combine('@X', '@A', '@A');
    await s.combine('@X', '@A', 'no-such-node');
    await s.combine('@X', 'no-such-node', '@A');
    await s.combine('@X', '@G', '@A');             // a group with its own member
    await s.combine('@X', '@A', '@G');
    await s.combine('@X', '@G', '@ROOT');
    await s.create('@C');
    await s.combine('@H', '@C', '@G');
});

// Moves and the anchor: committed content entering and leaving groups.
journey('graph/moves-and-anchors', async s => {
    await oneAndFour(s);
    await s.create('@G', 'stack');
    await s.call('reorderNode', '@B', '@G', 0);
    await s.advance(600);
    await s.call('setLoopPoints', '@G', 0, 2 * Q);
    await s.call('reorderNode', '@A', '@G', 1);
    await s.advance(600);
    await s.call('reorderNode', '@B', '@ROOT', 0);
    await s.call('reorderNode', '@A', '@ROOT', 0);
    await s.advance(600);
});

// S11: Q survives its creator; an empty island has no Q; undo brings
// it back.
journey('graph/delete-content', async s => {
    await oneAndFour(s);
    await s.call('deleteNode', '@A');
    await s.advance(700);
    await s.take('@C', 3 * Q);
    await s.call('deleteNode', '@B');
    await s.call('deleteNode', '@C');
    await s.advance(700);
    await s.call('undo');
    await s.advance(700);
    await s.call('undo');
    await s.call('undo');
    await s.advance(700);
});

// S22 and the knobs: mute and input are undoable; solo, gain, pan,
// monitor and MIDI arm are not — and an undo must not touch them.
journey('graph/knobs', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.create('@M', 'clip', '@G');
    await s.call('toggleMute', '@A');
    await s.call('toggleMute', '@G');
    await s.call('toggleMute', 'no-such-node');
    await s.call('setNodeInput', '@M', 1);
    await s.call('setNodeInput', '@M', 1);
    await s.call('setNodeInput', '@G', 1);
    await s.call('setNodeInput', 'no-such-node', 1);
    await s.call('setNodeInput', '@M', 7);
    await s.call('setNodeInputRight', '@M', 1);
    await s.call('setNodeInputRight', '@M', -1);
    await s.call('setNodeInputRight', 'no-such-node', 0);
    await s.callLive('renameNode', '@A', 'keys');
    await s.callLive('setNodeGain', '@A', 0.5);
    await s.callLive('setNodePan', '@A', -1);
    await s.callLive('toggleSolo', '@A');
    await s.callLive('setMonitor', '@A', true);
    await s.callLive('setMidiArmed', '@M', true);
    await s.callLive('setMidiArmed', '@A', true);
    await s.callLive('setNodeGain', '@A', 4);
    await s.callLive('setNodePan', '@G', 3);
    await s.callLive('setMonitor', '@G', true);
    await s.callLive('toggleSolo', '@G');
    await s.callLive('setNodeGain', '@ROOT', 0.25);
    await s.callLive('setNodeGain', 'no-such-node', 0.25);
    await s.callLive('undo');                      // the rename — and no knob
    await s.callLive('redo');
    await s.callLive('setNodeGain', '@ROOT', 1);
});

// S6, S25, S28: one-shots — a clip, a group, and the refusals.
journey('graph/one-shots', async s => {
    await soleFour(s);
    await s.call('setPeriodSource', '@A', 'context');     // the only content
    await s.toPhase(3 * Q - 800, 4 * Q);
    await s.take('@B', Q);
    await s.call('setPeriodSource', '@B', 'context');
    await s.advance(4 * Q + 300);
    await s.call('setPeriodSource', '@B', 'context');
    await s.call('setPeriodSource', '@B', 'own');
    await s.call('setPeriodSource', 'no-such-node', 'context');
    await s.combine('@G', '@B', '@A');
    await s.call('setPeriodSource', '@G', 'context');     // holds every take
    await s.create('@K', 'stack');
    await s.create('@K1', 'clip', '@K');
    await s.create('@K2', 'clip', '@K');
    await s.toPhase(2 * Q - 800, 4 * Q);
    await s.record('@K', 2 * Q, { watch: '@K1' });
    await s.call('setPeriodSource', '@K', 'context');
    await s.advance(4 * Q + 300);
    await s.call('setLoopPoints', '@K', 0, Q);
    await s.advance(4 * Q + 300);
    await s.call('setPeriodSource', '@K1', 'context');
    await s.call('setLoopPoints', '@K1', 0, Q);
});

// --------------------------------------------------------------- sequences

// S17: a root song over 1Q + 4Q; a gate; bypass; clear.
journey('seq/root-song', async s => {
    await oneAndFour(s);
    await s.call('setSequence', '@ROOT', { steps: steps(4 * Q, 4 * Q), gates: { '@B': [1, 0] } });
    await s.advance(5 * Q);
    await s.call('toggleSequence', '@ROOT');
    await s.advance(Q);
    await s.call('toggleSequence', '@ROOT');
    await s.call('setSequence', '@ROOT', { steps: steps(4 * Q, 4 * Q, 2 * Q), gates: { '@B': [1, 0, 1], '@A': [0, 1, 1] } });
    await s.advance(Q);
    await s.call('setSequence', '@ROOT', null);
    await s.advance(Q);
});

// S39: the root's anchor rides its song — a seated zero off the grid.
journey('seq/root-anchor', async s => {
    await oneAndFour(s);
    await s.call('setSequence', '@ROOT', { steps: steps(2 * Q, 2 * Q), gates: { '@B': [1, 0] } },
        s.fromZero(Q + 3333));
    await s.advance(Q + 400);
    await s.callLive('seekTransport', Q);
    await s.advance(400);
    await s.call('setSequence', '@ROOT', { steps: steps(2 * Q, 2 * Q), gates: {} }, s.fromZero(3 * Q));
    await s.call('setSequence', '@ROOT', null);
    await s.call('deleteNode', '@A');
    await s.call('deleteNode', '@B');
    await s.call('undo');
    await s.call('undo');
});

// S18, S20: a cue step; successors; a seed.
journey('seq/cue-and-successors', async s => {
    await oneAndFour(s);
    await s.call('setSequence', '@ROOT', {
        steps: [{ name: 'A', len: 4 * Q }, { name: 'B', len: 4 * Q, cue: true }], gates: {} });
    await s.advance(5 * Q);
    await s.call('setSequence', '@ROOT', {
        steps: [{ name: 'A', len: 2 * Q, next: [{ to: 1 }] },
                { name: 'B', len: 2 * Q, next: [{ to: 0 }] }], gates: {} });
    await s.advance(Q);
    await s.call('setSequence', '@ROOT', {
        steps: [{ name: 'A', len: 2 * Q, next: [{ to: 0 }] }, { name: 'B', len: 2 * Q }], gates: {} });
    await s.advance(Q);
    await s.call('setSequence', '@ROOT', {
        steps: [{ name: 'A', len: 2 * Q, next: [{ to: 0, w: 1 }, { to: 1, w: 3 }] },
                { name: 'B', len: 2 * Q, fadeIn: 441, fadeOut: 882 }],
        gates: {}, seed: 7 });
    await s.advance(Q);
});

// S31: a group song folds from the group's origin.
journey('seq/group-song', async s => {
    await oneAndFour(s);
    await s.create('@G', 'stack');
    await s.toPhase(2 * Q - 700, 4 * Q);
    await s.take('@M', 4 * Q, '@G');
    await s.call('setSequence', '@G', { steps: steps(4 * Q, 4 * Q), gates: { '@M': [1, 0] } });
    await s.advance(5 * Q);
    await s.call('toggleSequence', '@G');
    await s.call('toggleSequence', '@G');
    await s.call('setLoopPoints', '@G', 0, 4 * Q);
    await s.advance(Q);
    await s.call('setSequence', '@G', null);
    await s.advance(Q);
});

// The step audition, on the root and on a group.
journey('seq/audition', async s => {
    await oneAndFour(s);
    await s.call('setSequence', '@ROOT', { steps: steps(4 * Q, 4 * Q), gates: { '@B': [1, 0] } });
    await s.call('auditionStep', '@ROOT', 1);
    await s.advance(5 * Q);
    await s.call('toggleMute', '@A');
    await s.call('auditionStep', '@ROOT', 0);
    await s.advance(Q);
    await s.call('auditionStep', '@ROOT', 9);
    await s.call('auditionStep', '@ROOT', -1);
    await s.call('auditionStep', '@A', 0);
    await s.create('@G', 'stack');
    await s.take('@M', 2 * Q, '@G');
    await s.call('setSequence', '@G', { steps: steps(2 * Q, 2 * Q), gates: {} });
    await s.call('auditionStep', '@G', 1);
    await s.advance(Q);
    await s.call('toggleSequence', '@G');
    await s.advance(Q);
});

// Sequences that cannot be.
journey('seq/refusals', async s => {
    await oneAndFour(s);
    await s.call('setSequence', '@A', { steps: steps(Q), gates: {} });
    await s.call('setSequence', 'no-such-node', { steps: steps(Q), gates: {} });
    await s.call('setSequence', '@ROOT', { steps: [{ name: 'A', len: 0 }], gates: {} });
    await s.call('setSequence', '@ROOT', { steps: [{ name: 'A', len: Q, next: [{ to: 4 }] }], gates: {} });
    await s.call('setSequence', '@ROOT', { steps: [], gates: {} });
    await s.call('toggleSequence', '@ROOT');
    await s.call('toggleSequence', '@A');
    await s.call('toggleSequence', 'no-such-node');
    await s.call('setSequence', '@ROOT', { steps: steps(1.5 * Q, Q), gates: { 'no-such-node': [1, 0] } });
    await s.create('@G', 'stack');
    await s.take('@M', 2 * Q, '@G');
    await s.call('setSequence', '@G', {
        steps: [{ name: 'A', len: 2 * Q, next: [{ to: 0, w: 1 }, { to: 1, w: 1 }] },
                { name: 'B', len: 2 * Q }], gates: {} });   // a radio below the root
});

// A song authored on an empty island, then the first take, its undo
// and its redo.
journey('seq/song-before-the-first-take', async s => {
    await s.callLive('setSequence', '@ROOT', { steps: steps(4 * Q, 4 * Q), gates: {} });
    await s.advance(700);
    await s.create('@A');
    await s.callLive('startRecordingInNode', '@A');
    await s.advance(BLOCK);
    await s.advance(Q - BLOCK);
    await s.callLive('stopRecordingInNode', '@A');
    await s.advance(BLOCK);
    await s.callLive('undo');
    await s.callLive('redo');
    await s.advance(BLOCK);
});

// Arms under a root song longer than the content: an arm whose
// boundary is inside a step, then one whose boundary is the step's end
// — where the song gates another track off.
journey('seq/arm-grid-under-a-long-song', async s => {
    await s.take('@A', 2 * Q);
    await s.take('@B', Q);
    await s.callLive('setSequence', '@ROOT', { steps: steps(8 * Q, 8 * Q), gates: { '@A': [1, 0] } });
    await s.take('@C', Q);
    await s.create('@D');
    await s.callLive('startRecordingInNode', '@D');
    await s.advance(BLOCK);
    await s.until('@D capturing', s.capturingIn('@D'));
    await s.advance(BLOCK);
});

// S19: record over a song; and under an audition the take is gated.
journey('seq/record-over-a-song', async s => {
    await s.take('@A', Q);
    await s.call('setSequence', '@ROOT', { steps: steps(3 * Q, 2 * Q), gates: {} });
    await s.advance(700);
    await s.take('@B', 3 * Q);
    await s.advance(Q);
    await s.call('auditionStep', '@ROOT', 1);
    await s.advance(700);
    await s.create('@C');
    await s.call('startRecordingInNode', '@C');
    await s.advance(BLOCK);
    await s.until('@C capturing', s.capturingIn('@C'));
    await s.until('@C settled', st => !s.hotIn('@C')(st), 8 * Q);
    await s.advance(Q);
});

// S21 (sequencer): an arm inside a cued step auto-targets it — on the
// root, and on a group whose song is longer than its parts.
journey('seq/arm-inside-a-cued-step', async s => {
    await s.take('@A', Q);
    await s.call('setSequence', '@ROOT', {
        steps: [{ name: 'A', len: 2 * Q, cue: true }, { name: 'B', len: 2 * Q, cue: true }], gates: {} });
    await s.toPhase(2 * Q + 2500, 4 * Q);
    await s.create('@C');
    await s.call('startRecordingInNode', '@C');
    await s.advance(BLOCK);
    await s.until('@C capturing', s.capturingIn('@C'), 8 * Q);
    await s.until('@C settled', st => !s.hotIn('@C')(st), 8 * Q);
    await s.advance(Q);
    await s.call('auditionStep', '@ROOT', -1);
    await s.advance(Q);
});

// A root song seated 2Q past the island zero, its first step cued: an
// arm 1Q past the island zero is 7Q into the song — the second step.
journey('seq/arm-under-a-seated-root-song', async s => {
    await oneAndFour(s);
    await s.callLive('setSequence', '@ROOT', {
        steps: [{ name: 'A', len: 4 * Q, cue: true }, { name: 'B', len: 4 * Q }], gates: {} },
        s.fromZero(2 * Q));
    await s.toPhase(Q, 8 * Q);
    await s.create('@C');
    await s.callLive('startRecordingInNode', '@C');
    await s.advance(BLOCK);
    await s.until('@C capturing', s.capturingIn('@C'), 16 * Q);
    await s.advance(Q / 2);
    await s.callLive('stopRecordingInNode', '@C');
    await s.until('@C settled', st => !s.hotIn('@C')(st), 16 * Q);
    await s.advance(BLOCK);
});

journey('seq/arm-inside-a-group-cue', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.take('@M', Q, '@G');
    await s.call('setSequence', '@G', {
        steps: [{ name: 'A', len: 2 * Q }, { name: 'B', len: 2 * Q, cue: true }], gates: {} });
    await s.until('group song at 2.5Q', st => {
        const g = s.engineNode('@G', st);
        const rel = (((st.islandPos + st.islandZero - g.origin) % (4 * Q)) + 4 * Q) % (4 * Q);
        return rel >= 2.5 * Q && rel < 2.5 * Q + BLOCK;
    }, 8 * Q);
    await s.create('@N', 'clip', '@G');
    await s.call('startRecordingInNode', '@N');
    await s.advance(BLOCK);
    await s.until('@N capturing', s.capturingIn('@N'), 8 * Q);
    await s.until('@N settled', st => !s.hotIn('@N')(st), 8 * Q);
    await s.advance(Q);
});

// ------------------------------------------------------------- the definer

// Q22: hand Q to a longer track; trim it; hand it back; the refusals.
journey('definer/hand-off', async s => {
    await s.take('@A', Q);
    await s.take('@B', 5 * Q);
    await s.create('@E');
    await s.call('setDefiner', '@B');
    await s.advance(700);
    await s.call('setDefiner', '@B');
    await s.call('setLoopPoints', '@B', Q, 4 * Q);
    await s.advance(700);
    await s.call('setDefiner', '@A');
    await s.advance(700);
    await s.call('setDefiner', '@E');
    await s.call('setDefiner', 'no-such-node');
    await s.call('setDefiner', '@ROOT');
});

// A hand-off ends at the next take that records new content.
journey('definer/hand-off-then-a-take', async s => {
    await s.take('@A', Q);
    await s.take('@B', 5 * Q);
    await s.call('setDefiner', '@B');
    await s.advance(700);
    await s.take('@C', 5 * Q);
    await s.advance(700);
    await s.call('undo');
    await s.advance(700);
});

// Q handed to ONE mic of a group take. Its lock at the next arm moves
// the mic and leaves the group on the mics it still holds; with the mic
// deleted the group is the one take again, on its mics, and its own
// trim names a stretch of what they hold. Then Q handed back to a
// collapsed mic: it re-opens, and the group stays.
journey('definer/handed-mic-of-a-group', async s => {
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.create('@M2', 'clip', '@G');
    await s.create('@M3', 'clip', '@G');
    await s.record('@G', 5 * Q, { watch: '@M1' });
    await s.call('setDefiner', '@M1');
    await s.call('setLoopPoints', '@M1', 497, 1460);
    await s.advance(700);
    await s.create('@E');
    await s.call('startRecordingInNode', '@E');
    await s.call('stopRecordingInNode', '@E');
    await s.advance(BLOCK);
    await s.call('setDefiner', '@M1');
    await s.advance(700);
    await s.call('startRecordingInNode', '@E');
    await s.call('stopRecordingInNode', '@E');
    await s.advance(BLOCK);
    await s.call('deleteNode', '@M1');
    await s.call('setLoopPoints', '@G', Q, 3 * Q);
    await s.advance(Q);
});

// The same lock under a group that holds nothing but the handed track:
// the group is anchored on it and follows — at the lock, and at the
// re-open when Q is handed back.
journey('definer/handed-track-alone-in-a-group', async s => {
    await s.take('@A', Q);
    await s.create('@W', 'stack');
    await s.take('@B', 5 * Q, '@W');
    await s.call('setDefiner', '@B');
    await s.call('setLoopPoints', '@B', 700, 3100);
    await s.advance(700);
    await s.take('@C', 2400);
    await s.advance(700);
    await s.call('setDefiner', '@B');
    await s.advance(700);
});

// A delete that re-opens the locked definer inside a group that then
// holds it alone: the group follows the re-open, and the delete's undo
// puts both back.
journey('window/delete-reopens-inside-a-group', async s => {
    await s.create('@W', 'stack');
    await s.take('@A', 13000, '@W');
    await s.call('setLoopPoints', '@A', 3000, 13000);
    await s.advance(700);
    await s.take('@B', Q, '@W');
    await s.advance(700);
    await s.call('deleteNode', '@B');
    await s.advance(Q);
});

// One take sits at its group's origin. A mic re-timed off it, then an
// overdub through the group's window that lands where the mic now
// stands: the two agree with each other, not with the group — no
// definer stack, and an off-grid window on the group is refused.
journey('definer/takes-that-only-agree-with-each-other', async s => {
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.create('@M2', 'clip', '@G');
    await s.create('@M3', 'clip', '@G');
    await s.record('@G', 4 * Q, { watch: '@M1' });
    await s.call('deleteNode', '@M1');
    await s.call('setLoopPoints', '@G', Q, 2 * Q);
    await s.advance(700);
    await s.create('@L', 'clip', '@G');
    await s.call('deleteNode', '@M3');
    await s.call('setTiming', '@M2', Q, 0);
    await s.call('startRecordingInNode', '@G');
    await s.advance(BLOCK);
    await s.until('@L capturing', s.capturingIn('@L'));
    await s.until('@L settled', st => !s.hotIn('@L')(st));
    await s.advance(BLOCK);
    await s.call('setLoopPoints', '@G', Q, 2 * Q + 500);
    await s.advance(Q);
});

// A group takes Q only when its tracks are one take; a one-shot never.
journey('definer/targets', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.create('@M2', 'clip', '@G');
    await s.record('@G', 3 * Q, { watch: '@M1' });
    await s.call('setDefiner', '@G');
    await s.advance(600);
    await s.call('setDefiner', '@M1');
    await s.take('@K', 2 * Q, '@G');
    await s.call('setDefiner', '@G');
    await s.call('setPeriodSource', '@K', 'context');
    await s.call('setDefiner', '@K');
    await s.advance(600);
});

// ------------------------------------------------------------------ import

// A file as the island's first take; a file beside content; a new take
// of a slot; onto a group (one undo step, or two?).
journey('import/first-take', async s => {
    await s.create('@A');
    await s.advance(3000);
    await s.call('importAudio', '@A', s.wav(2 * Q), s.clock());
    await s.advance(700);
    await s.create('@B');
    await s.call('importAudio', '@B', s.wav(3 * Q + 900, 'long'), s.fromZero(2 * Q + 4000));
    await s.advance(700);
});

journey('import/beside-content', async s => {
    await oneAndFour(s);
    await s.create('@C');
    await s.call('importAudio', '@C', s.wav(2 * Q), s.fromZero(Q + 4100));
    await s.advance(700);
    await s.call('importAudio', '@B', s.wav(2 * Q), s.fromZero(0));
    await s.advance(700);
    await s.call('selectTake', '@B', 0);
    await s.create('@D');
    await s.call('importAudio', '@D', s.wav(2.4 * Q, 'ragged'), s.fromZero(-3 * Q));
    await s.advance(700);
});

journey('import/onto-a-group', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.callBinding(['@I'], 'importAudio', '@G', s.wav(2 * Q), s.fromZero(Q));
    await s.advance(700);
    await s.callLive('undo');
    await s.callLive('undo');
    await s.callLive('redo');
    await s.callLive('redo');
    await s.callBinding(['@J'], 'importAudio', '@ROOT', s.wav(2 * Q, 'second'), s.fromZero(0));
    await s.advance(700);
});

journey('import/refusals', async s => {
    await s.take('@A', Q);
    await s.create('@B');
    await s.call('importAudio', '@B', s.scratch('nothing-here.missing'), s.fromZero(0));
    await s.call('importAudio', 'no-such-node', s.wav(2 * Q), s.fromZero(0));
    await s.call('importAudio', '@B', s.wav(2 * Q), s.fromZero(0));
    await s.call('importAudio', '@B', s.wav(2 * Q), s.fromZero(0));
    await s.advance(700);
});

// A bounce changes nothing; it answers whether it wrote.
journey('bounce/answers', async s => {
    await oneAndFour(s);
    await s.call('bounce', '@ROOT', s.scratch('root.wav'));
    await s.call('bounce', '@B', s.scratch('b.wav'), s.fromZero(Q));
    await s.call('bounce', 'no-such-node', s.scratch('none.wav'));
    await s.create('@E');
    await s.call('bounce', '@E', s.scratch('empty.wav'));
    await s.call('startRecordingInNode', '@E');
    await s.advance(BLOCK);
    await s.call('bounce', '@ROOT', s.scratch('live.wav'));
    await s.call('stopRecordingInNode', '@E');
    await s.advance(BLOCK);
});

// -------------------------------------------------------------------- seek

// S12, S36: a seek moves the phase, every origin rides, and the
// history is re-framed with it.
journey('seek/phase-and-history', async s => {
    await oneAndFour(s);
    await s.call('setLoopPoints', '@B', Q, 3 * Q);
    await s.callLive('toggleMute', '@A');
    await s.callLive('seekTransport', Q / 2);
    await s.advance(600);
    await s.callLive('undo');
    await s.advance(600);
    await s.callLive('seekTransport', -5 * Q);
    await s.advance(600);
    await s.callLive('seekTransport', 3 * Q, s.clock(-2000));
    await s.callLive('seekTransport', 0);
    await s.callLive('undo');
    await s.callLive('undo');
    await s.callLive('redo');
    await s.advance(600);
});

// A seek with nothing recorded, with the transport stopped, and under
// an armed take.
journey('seek/edges', async s => {
    await s.call('seekTransport', Q);
    await s.take('@A', Q);
    await s.call('togglePlayback');
    await s.advance(4 * BLOCK);
    await s.call('seekTransport', Q / 4);
    await s.call('togglePlayback');
    await s.advance(600);
    await s.create('@B');
    await s.call('startRecordingInNode', '@B');
    await s.call('seekTransport', Q / 4);
    await s.advance(BLOCK);
    await s.call('seekTransport', Q / 4);
    await s.call('stopRecordingInNode', '@B');
    await s.advance(BLOCK);
});

// A seek over a root song and an anchored group.
journey('seek/over-a-song', async s => {
    await oneAndFour(s);
    await s.call('setSequence', '@ROOT', { steps: steps(4 * Q, 4 * Q), gates: { '@B': [1, 0] } });
    await s.combine('@G', '@A', '@B');
    await s.callLive('seekTransport', 5 * Q + 300);
    await s.advance(600);
    await s.callLive('undo');
    await s.callLive('undo');
    await s.advance(600);
});

// --------------------------------------------------------------- transport

journey('transport/pause-resume', async s => {
    await s.take('@A', Q);
    await s.call('togglePlayback');
    await s.advance(3 * BLOCK);
    await s.advance(Q);
    await s.call('togglePlayback');
    await s.advance(700);
    await s.call('togglePlayback');
    await s.call('togglePlayback');
    await s.advance(700);
});

// Before Q exists: the cursor's fold.
journey('transport/before-q', async s => {
    await s.advance(s.rate + 5000);
    await s.create('@A');
    await s.advance(s.rate);
});

// ----------------------------------------------------------------- effects

// The chain: the switches and parameters are knobs; a move is an
// undoable structure edit; only plugin slots can be removed.
journey('fx/chain', async s => {
    await s.take('@A', Q);
    await s.call('moveChainSlot', '@A', s.slot('@A', 'reverb'), 0);
    await s.call('moveChainSlot', '@A', s.slot('@A', 'reverb'), 0);
    await s.call('moveChainSlot', '@A', s.slot('@A', 'eq'), 99);
    await s.call('moveChainSlot', '@A', s.slot('@A', 'echo'), -4);
    await s.callLive('setSlotEnabled', '@A', s.slot('@A', 'eq'), true);
    await s.callLive('setSlotParam', '@A', s.slot('@A', 'eq'), 'low', 3);
    await s.callLive('setSlotParam', '@A', s.slot('@A', 'eq'), 'no-such-param', 1);
    await s.callLive('setSlotEnabled', '@A', 'no-such-slot', true);
    await s.callLive('setEffectScope', '@A', true);
    await s.callLive('setEffectScope', '@A', false);
    await s.callLive('undo');                      // the move — and no knob
    await s.callLive('redo');
});

// A parameter set past its range.
journey('fx/parameter-range', async s => {
    await s.create('@A');
    await s.callLive('setSlotParam', '@A', s.slot('@A', 'eq'), 'low', 300);
    await s.callLive('setSlotParam', '@A', s.slot('@A', 'compressor'), 'ratio', 0);
    await s.callLive('setSlotParam', '@A', s.slot('@A', 'echo'), 'time', 9);
    await s.callLive('setSlotParam', '@A', s.slot('@A', 'reverb'), 'mix', -1);
});

// The master rack and a group's.
journey('fx/root-and-group', async s => {
    await s.create('@G', 'stack');
    await s.call('moveChainSlot', '@ROOT', s.slot('@ROOT', 'echo'), 0);
    await s.call('moveChainSlot', '@G', s.slot('@G', 'reverb'), 1);
    await s.callLive('setSlotEnabled', '@ROOT', s.slot('@ROOT', 'compressor'), true);
    await s.callLive('setSlotParam', '@ROOT', s.slot('@ROOT', 'compressor'), 'threshold', -30);
    await s.callLive('setSlotEnabled', '@G', s.slot('@G', 'reverb'), true);
});

// ------------------------------------------------------- refusals and undo

// A refused edit records nothing. From an empty history every undoable
// verb is refused once (an unknown node, or the root where the root is
// no target); `canUndo` must stay false. The undo after each call takes
// back a step a side recorded by mistake, so each call is judged alone.
journey('undo/refusals-on-an-empty-history', async s => {
    const refused = async (verb, ...args) => {
        await s.callLive(verb, ...args);
        await s.callLive('undo');
    };
    const song = { steps: steps(Q), gates: {} };
    await refused('createNode', 'clip', 'no-such-node');
    await refused('deleteNode', 'no-such-node');
    await refused('deleteNode', '@ROOT');
    await refused('renameNode', 'no-such-node', 'x');
    await refused('reorderNode', 'no-such-node', '@ROOT', 0);
    await refused('combineNodes', 'no-such-node', 'no-other-node');
    await refused('toggleMute', 'no-such-node');
    await refused('setLoopPoints', 'no-such-node', 0, Q);
    await refused('toggleLoopWindow', 'no-such-node');
    await refused('setSegments', 'no-such-node', [0, Q, 2 * Q, 3 * Q]);
    await refused('setTiming', 'no-such-node', Q);
    await refused('setNodeInput', 'no-such-node', 1);
    await refused('setNodeInputRight', 'no-such-node', 1);
    await refused('setPeriodSource', 'no-such-node', 'context');
    await refused('setDefiner', 'no-such-node');
    await refused('moveChainSlot', '@ROOT', 'no-such-slot', 0);
    await refused('moveChainSlot', 'no-such-node', s.slot('@ROOT', 'eq'), 0);
    await refused('moveChainSlot', '@ROOT', s.slot('@ROOT', 'eq'), 0);        // where it is
    await refused('removeChainSlot', '@ROOT', s.slot('@ROOT', 'eq'));         // a built-in slot
    await refused('removeChainSlot', '@ROOT', 'no-such-slot');
    await refused('addPluginToChain', '@ROOT', 'no-such-plugin');
    await refused('addPluginToChain', 'no-such-node', 'no-such-plugin');
    await refused('createFromTrackTemplate', 'no-such-template', '');
    await refused('setSequence', 'no-such-node', song);
    await refused('setSequence', '@ROOT', null);                              // nothing to clear
    await refused('toggleSequence', 'no-such-node');
    await refused('selectTake', 'no-such-node', 0);
    await refused('deleteTake', 'no-such-node', 0);
    await refused('setComp', 'no-such-node', [0]);
    await refused('importAudio', 'no-such-node', s.wav(Q), s.clock());
    await refused('importAudio', '@ROOT', s.scratch('nothing-here.missing'), s.clock());
    await refused('cancelGesture', 'no-such-node');
});

// The same on a clip and a group that exist: identities and
// out-of-range arguments, each followed by the undo/redo probe (a step
// recorded by mistake shows there: the undo takes back nothing).
journey('undo/identities-on-nodes', async s => {
    await s.create('@A');
    await s.create('@G', 'stack');
    await s.call('renameNode', '@A', 'bass');
    await s.call('renameNode', '@A', 'bass');
    await s.call('setNodeInputRight', '@A', -1);
    await s.call('setPeriodSource', '@A', 'own');
    await s.call('setNodeInput', '@G', 1);
    await s.call('setNodeInputRight', '@G', 1);
    await s.call('setLoopPoints', '@A', 0, Q);
    await s.call('setSegments', '@A', [0, Q, 2 * Q, 3 * Q]);
    await s.call('setTiming', '@A', Q);
    await s.call('selectTake', '@A', 0);
    await s.call('deleteTake', '@A', 0);
    await s.call('setComp', '@A', [0]);
    await s.call('setDefiner', '@A');
    await s.call('setSequence', '@G', null);
    await s.call('reorderNode', '@A', '@ROOT', 0);
});

// A window on the root, and its bypass (the root has no lane: the view
// never asks).
journey('window/on-the-root', async s => {
    await s.callLive('setLoopPoints', '@ROOT', 0, Q);
    await s.callLive('undo');
    await s.callLive('toggleLoopWindow', '@ROOT');
    await s.callLive('undo');
});

// With content the root is a stack like any other: a window over the
// island's cycle, its bypass, cells, the refusals, the clear.
journey('window/on-the-root-with-content', async s => {
    await oneAndFour(s);
    await s.call('setLoopPoints', '@ROOT', Q, 3 * Q);
    await s.advance(Q + 300);
    await s.call('toggleLoopWindow', '@ROOT');
    await s.advance(700);
    await s.call('toggleLoopWindow', '@ROOT');
    await s.call('setLoopPoints', '@ROOT', 0, 5 * Q);         // past the inner cycle
    await s.call('setLoopPoints', '@ROOT', 0, 3 * Q + 17);    // off the grid
    await s.call('setSegments', '@ROOT', [0, Q, 2 * Q, 3 * Q]);
    await s.advance(Q + 300);
    await s.call('setLoopPoints', '@ROOT', 0, 0);
    await s.advance(700);
});

// Toggles with nothing to toggle: a window's bypass on an empty clip,
// a song's bypass on a group with no song.
journey('undo/toggles-with-nothing-stored', async s => {
    await s.create('@A');
    await s.create('@G', 'stack');
    await s.callLive('toggleLoopWindow', '@A');
    await s.callLive('undo');
    await s.callLive('toggleSequence', '@G');
    await s.callLive('undo');
    await s.callLive('toggleSequence', '@ROOT');
    await s.callLive('undo');
});

// --------------------------------------------------------------- templates

// Q17: save a track and a group as templates; insert; the refusals;
// an insert under a live take.
journey('templates/save-and-insert', async s => {
    await s.take('@A', Q);
    await s.create('@G', 'stack');
    await s.create('@M1', 'clip', '@G');
    await s.create('@M2', 'clip', '@G');
    await s.call('renameNode', '@G', 'kit');
    await s.call('renameNode', '@M1', 'kick');
    await s.call('setNodeInput', '@M2', 1);
    await s.call('saveTrackTemplate', '@G', 'diff-kit');
    await s.call('saveTrackTemplate', '@A', 'diff-track');
    await s.call('saveTrackTemplate', 'no-such-node', 'diff-none');
    await s.call('saveTrackTemplate', '@A', '');
    await s.callLive('listTrackTemplates');        // the two saved, row for row
    await s.callBinding(['@T', '@T1', '@T2'], 'createFromTrackTemplate', 'diff-kit', '');
    await s.callBinding(['@U'], 'createFromTrackTemplate', 'diff-track', '@G');
    await s.call('createFromTrackTemplate', 'no-such-template', '');
    await s.call('createFromTrackTemplate', 'diff-track', '@A');
});

// An insert while a take is live.
journey('templates/insert-under-a-take', async s => {
    await s.take('@A', Q);
    await s.callLive('saveTrackTemplate', '@A', 'diff-live');
    await s.create('@R');
    await s.callLive('startRecordingInNode', '@R');
    await s.advance(BLOCK);
    s.bindNext(['@V']);
    await s.callLive('createFromTrackTemplate', 'diff-live', '');
    await s.callLive('stopRecordingInNode', '@R');
    await s.advance(BLOCK);
});

// ------------------------------------------------------------- the project

// The project model answers values — a record, lists of records — and
// its verbs answer whether they applied. (No project is born here: the
// engine has no verb that closes one.)
journey('project/answers', async s => {
    await s.callLive('getProjectInfo');
    await s.callLive('listTemplates');
    await s.callLive('saveAsTemplate', 'diff-rig');
    await s.callLive('saveAsTemplate', '///');     // names no folder
    await s.callLive('listTemplates');
    await s.callLive('listRecentProjects');
    await s.callLive('listTrackTemplates');        // empty on both sides
    await s.callLive('newProjectFromTemplate', 'no-such-template');
    await s.callLive('openProjectPath', s.scratch('no-such-project'));
    await s.callLive('renameProject', 'a name');
});

// ------------------------------------------------------------- the session

// Save and load: the facts survive a round trip.
journey('session/save-load', async s => {
    await oneAndFour(s);
    await s.call('setLoopPoints', '@B', Q, 3 * Q);
    await s.call('setTiming', '@B', 500, 2 * Q);
    await s.call('setSequence', '@ROOT', { steps: steps(4 * Q, 4 * Q), gates: { '@B': [1, 0] } });
    await s.call('toggleMute', '@A');
    await s.callLive('setNodeGain', '@A', 0.5);
    await s.callLive('saveSession', s.scratch('round-trip'));
    await s.callLive('deleteNode', '@A');
    await s.callLive('loadSession', s.scratch('round-trip'));
    await s.advance(700);
    await s.callLive('loadSession', s.scratch('no-such-session'));
});

export const JOURNEYS = journeys;
