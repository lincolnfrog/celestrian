/**
 * THE FIELD TABLE: every fact either backend publishes in getGraphState,
 * and what the differential harness does with it. One row per field:
 *
 *   on      — where the fact lives: 'island' (the top level of the
 *             state), 'root' (the root node's own facts, also at the top
 *             level), 'node' (every node), 'clip', 'stack';
 *   read    — (node, state, ctx) → the comparable value, or undefined
 *             when the field is not a fact at this compare point
 *             (`readMany` → { field: value } for a row that stands for
 *             several keys). A row WITHOUT either is not read: excluded,
 *             or derived by the differ — its `note` says which and why;
 *   equal   — optional comparator (default: deep equality);
 *   note    — one line: what is compared, or why nothing is.
 *
 * ctx = { labelOf(id), pathOf(id), point, viewSettled, clockAligned,
 * rate } where `point` is 'block' right after an advance that rendered
 * audio and 'verb' right after a bridge call (see TIME PARITY in
 * session.mjs: the take flags, a live take's length and the window
 * phase are the audio thread's and are read at block points).
 *
 * Absent and zero are one value here (`n.x || 0`): the view reads every
 * field that way. Which keys each side publishes at all is a separate
 * check (key_sets in normalize.mjs).
 */

import { BLOCK } from './engine_process.mjs';

const int = v => Math.round(Number(v) || 0);
const bool = v => !!v;
// Effect parameters are float32 in the engine and doubles in the mock.
const f32 = v => Number(Math.fround(Number(v) || 0).toPrecision(6));
const hot = n => !!(n.isRecording || n.isPendingStart || n.isAwaitingStop);
const committed = n => n.type === 'clip' && (n.duration || 0) > 0 && !hot(n);

const anyHot = node => (node.nodes || []).some(n => hot(n) || anyHot(n));
/** The island has a zero to measure from (see the islandPos row). */
const hasZero = (st, ctx) => st.quantum > 0 || (ctx.point === 'block' && anyHot(st));

/** A clock position as the view reads it: from the island zero. */
const fromZero = (v, st) => int(v) - int(st.islandZero);

/** The published map's period in samples (0: no map). */
function mapPeriod(n) {
    if (Array.isArray(n.segments) && n.segments.length >= 4) {
        let p = 0;
        for (let i = 0; i + 1 < n.segments.length; i += 2) p += n.segments[i + 1] - n.segments[i];
        return p;
    }
    return Math.max(0, int(n.loopEnd) - int(n.loopStart));
}

/** A sequence's facts, one row each (a song one side lacks is the one
 * `sequence` row; the differ then leaves its parts out). `on` is 'root'
 * or 'stack'. */
function sequenceRows(on) {
    const part = (name, read, note) => ({
        field: `sequence.${name}`, on,
        read: (n, _st, ctx) => (n.sequence ? read(n.sequence, ctx) : undefined),
        note,
    });
    return [
        { field: 'sequence', on, read: n => (n.sequence ? 'a song' : 'none'),
          note: on === 'root' ? 'the root carries a song' : 'the group carries a song' },
        part('steps', seq => (seq.steps || []).map(s => {
            const next = Array.isArray(s.next) && s.next.length
                ? ' → ' + s.next.map(x => `${int(x.to)}×${int(x.w === undefined ? 1 : x.w)}`).join(',') : '';
            const fades = int(s.fadeIn) || int(s.fadeOut) ? ` fade ${int(s.fadeIn)}/${int(s.fadeOut)}` : '';
            return `${s.name || ''}:${int(s.len)}${s.cue ? ' cue' : ''}${next}${fades}`;
        }), 'the steps: name, length, cue, successors (to×weight), fades'),
        part('gates', (seq, ctx) => {
            const rows = Object.entries(seq.gates || {})
                .map(([id, row]) => [ctx.labelOf(id) || `?${id}`, (row || []).map(g => (g ? 1 : 0)).join('')]);
            return Object.fromEntries(rows.sort(([a], [b]) => (a < b ? -1 : 1)));
        }, 'the gates: a row of 0/1 per step, keyed by node label'),
        part('bypassed', seq => bool(seq.bypassed), 'the song is stored but not playing'),
        part('seed', seq => int(seq.seed), 'the successor graph\'s seed'),
        part('program', seq => (seq.program || []).map(int), 'the derived program: a step index per visit'),
        part('radio', seq => bool(seq.radio), 'the program has no period'),
        part('auditionStep', seq => (seq.auditionStep === undefined ? -1 : int(seq.auditionStep)),
            'the step being auditioned (−1: none)'),
    ];
}

/** The chain's shape, two rows: the slot kinds in order, and each
 * slot's switch and parameter values — everything but the slot uuids.
 * `on` is 'root' or 'node'. */
function chainRows(on) {
    const chainOf = n => (n.effects && n.effects.chain) || [];
    return [
        { field: 'effects', on, read: n => chainOf(n).map(slot => slot.type).join(' '),
          note: 'the chain: its slot kinds, in order' },
        { field: 'effects.<kind>', on,
          readMany: n => {
              const out = {};
              const seen = {};
              for (const slot of chainOf(n)) {
                  const nth = (seen[slot.type] = (seen[slot.type] || 0) + 1);
                  const facts = Object.entries(slot)
                      .filter(([k]) => k !== 'slot' && k !== 'type' && k !== 'enabled')
                      .map(([k, v]) => `${k}=${typeof v === 'number' ? f32(v) : v}`);
                  out[`effects.${slot.type}${nth > 1 ? `#${nth}` : ''}`] =
                      [slot.enabled ? 'on' : 'off', ...facts].join(' ');
              }
              return out;
          },
          note: 'each slot: its switch and every parameter (float32); slot uuids left out' },
    ];
}

/** A window phase is the audio thread's last block: equal within one
 * block on the map's period. */
function phaseEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || a.period !== b.period) return false;
    if (!(a.period > 0)) return true;
    const d = Math.abs(a.at - b.at) % a.period;
    return Math.min(d, a.period - d) <= BLOCK;
}

export const FIELDS = [
    // ---- the island (top level of the state) ----
    { field: 'isPlaying', on: 'island', read: st => bool(st.isPlaying),
      note: 'the transport runs' },
    { field: 'quantum', on: 'island', read: st => int(st.quantum),
      note: 'the stored island Q, samples' },
    { field: 'islandPos', on: 'island',
      read: (st, _s, ctx) => (hasZero(st, ctx) ? int(st.islandPos) : undefined),
      note: 'the raw clock since the island zero — this IS the zero, clock-free. Read once the island has a zero: with a Q, or at block points while a first take is up (before that the reading is the absolute clock, and the two clocks start at different absolutes)' },
    { field: 'masterPos', on: 'island',
      read: (st, _s, ctx) => (st.quantum > 0 && (ctx.point === 'block' || ctx.viewSettled)
          ? int(st.masterPos) : undefined),
      note: 'the published cursor: folded on the audible cycle at rest, linear from the frozen base under a take. The audio thread switches between the two views, so at a verb point it is read only when no take verb came since the last block and no take was up there' },
    { field: 'firstTakeCursor', on: 'island',
      read: (st, _s, ctx) => (!(st.quantum > 0) && ctx.point === 'block' && anyHot(st)
          ? (int(st.masterPos) === int(st.islandPos) ? 'the take\'s length' : 'the take\'s length plus an offset') : undefined),
      note: 'masterPos while the island\'s FIRST take grows (vm/frame.js draws the cursor from it then): whether it is the captured length. The offset itself is the absolute clock\'s, so only its presence is compared' },
    { field: 'preQFold', on: 'island',
      read: (st, _s, ctx) => (ctx.clockAligned && !(st.quantum > 0) && !anyHot(st) && int(st.islandPos) >= ctx.rate
          ? (int(st.masterPos) < ctx.rate ? 'folded on one second' : 'unfolded') : undefined),
      note: 'before Q exists: whether the cursor folds on one second. Read while the two absolute clocks still agree (from the reset to the first arm) and stand past one second' },
    { field: 'definerId', on: 'island', read: (st, _s, ctx) => (st.definerId ? ctx.labelOf(st.definerId) || `?${st.definerId}` : ''),
      note: 'the Q-definer, as a node label' },
    { field: 'canUndo', on: 'island', read: st => bool(st.canUndo), note: 'the undo log holds a step' },
    { field: 'canRedo', on: 'island', read: st => bool(st.canRedo), note: 'the redo log holds a step' },
    { field: 'islandZero', on: 'island',
      note: 'excluded: an absolute clock reading (the engine never resets its clock, the mock starts each session at 0); compared as islandPos and through every origin' },
    { field: 'id', on: 'island', note: 'excluded: ids differ by construction (uuids vs mock ids); nodes are paired by creation order' },
    { field: 'focusedId', on: 'island', note: 'excluded: the root uuid again; no reader in ui/js' },
    { field: 'masterVuL', on: 'island', note: 'excluded: meter telemetry' },
    { field: 'masterVuR', on: 'island', note: 'excluded: meter telemetry' },
    { field: 'perf', on: 'island', note: 'excluded: callback telemetry; perf.sampleRate is equal by construction (the harness sets the mock to the engine\'s rate)' },

    // ---- the root's own facts ----
    { field: 'gain', on: 'root', read: st => f32(st.gain === undefined ? 1 : st.gain),
      note: 'the master fader' },
    { field: 'anchored', on: 'root', read: st => bool(st.anchored),
      note: 'the root carries a song\'s anchor' },
    { field: 'origin', on: 'root', read: st => (st.anchored ? fromZero(st.origin, st) : undefined),
      note: 'the root\'s frame top from the island zero, while anchored' },
    { field: 'window', on: 'root', read: st => (st.windowActive ? [int(st.loopStart), int(st.loopEnd)] : null),
      note: 'the root\'s derived audition window (windowActive, loopStart, loopEnd)' },
    ...sequenceRows('root'),
    ...chainRows('root'),
    { field: 'name / pan / isMuted / isSoloed / midiArmed / periodSource / loopTop / retime / loopBypassed / segments / duration / playhead / effectiveQuantum / windowDomain / windowSuspended / zero / childCount / originQ / periodQ / windowStartQ / windowEndQ / qSamples / currentPeak', on: 'root',
      note: 'excluded: the engine\'s root is a StackNode and publishes a full node record; the mock\'s root is not a node and publishes only the rows above. No control in the UI reaches any of these on the root' },

    // ---- every node ----
    { field: 'exists', on: 'node',
      note: 'derived by the differ: a node only one side has is reported once, as this, and none of its fields' },
    { field: 'type', on: 'node', read: n => n.type, note: 'clip or stack' },
    { field: 'name', on: 'node', read: n => String(n.name || ''), note: 'the track name' },
    { field: 'path', on: 'node', read: (n, _st, ctx) => ctx.pathOf(n.id),
      note: 'tree position: the parent\'s label and the index under it' },
    { field: 'duration', on: 'node',
      read: (n, _st, ctx) => (hot(n) && ctx.point !== 'block' ? undefined : int(n.duration)),
      note: 'the committed length; a capturing take\'s live length, read at block points only' },
    { field: 'origin', on: 'node',
      read: (n, st) => {
          if (n.type === 'stack') return n.anchored ? fromZero(n.origin, st) : undefined;
          return committed(n) ? fromZero(n.origin, st) : undefined;
      },
      note: 'the capture boundary from the island zero — a committed clip\'s, an anchored stack\'s (an empty clip and an unanchored stack have no origin)' },
    { field: 'loopStart', on: 'node', read: n => int(n.loopStart), note: 'the stored single window (0 under a multi-segment map)' },
    { field: 'loopEnd', on: 'node', read: n => int(n.loopEnd), note: 'the stored single window' },
    { field: 'segments', on: 'node',
      read: n => (Array.isArray(n.segments) && n.segments.length ? n.segments.map(int) : null),
      note: 'a multi-segment map, flat samples; null without one' },
    { field: 'loopBypassed', on: 'node', read: n => bool(n.loopBypassed), note: 'the map is stored but not playing' },
    { field: 'windowActive', on: 'node', read: n => bool(n.windowActive), note: 'a map plays' },
    { field: 'loopTop', on: 'node', read: n => int(n.loopTop), note: 'the effective top (stored top while its map plays it, else the region start)' },
    { field: 'retime', on: 'node', read: n => int(n.retime), note: 'the cumulative user shift' },
    { field: 'playhead', on: 'node',
      read: (n, st, ctx) => {
          if (ctx.point !== 'block' || !n.windowActive || hot(n) || ctx.settling(n.id)) return undefined;
          if (!(st.quantum > 0)) return undefined;
          const period = mapPeriod(n);
          return { at: Math.round((Number(n.playhead) || 0) * period), period };
      },
      equal: phaseEqual,
      note: 'the window phase the view draws a mapped cursor from: at block points, while a map plays and the island has a Q (before it the phase reads the absolute clock), within one block. Not under a take nor in the block it settles in: the slot is silent, the engine does not advance its phase, and the lane draws the growing take' },
    { field: 'periodSource', on: 'node', read: n => n.periodSource || 'own', note: 'loop or one-shot' },
    { field: 'hot', on: 'node',
      read: (n, _st, ctx) => (ctx.point === 'block' ? undefined : hot(n)),
      note: 'at verb points: a take is up on the node (armed, capturing or awaiting its stop) — the three flags below folded, because an arm is published as pending until the audio thread\'s next block picks it up' },
    { field: 'isRecording', on: 'node', read: (n, _st, ctx) => (ctx.point === 'block' ? bool(n.isRecording) : undefined),
      note: 'capturing; read at block points' },
    { field: 'isPendingStart', on: 'node', read: (n, _st, ctx) => (ctx.point === 'block' ? bool(n.isPendingStart) : undefined),
      note: 'armed, waiting for its boundary; read at block points' },
    { field: 'isAwaitingStop', on: 'node', read: (n, _st, ctx) => (ctx.point === 'block' ? bool(n.isAwaitingStop) : undefined),
      note: 'stop requested, padding to its boundary; read at block points' },
    { field: 'isMuted', on: 'node', read: n => bool(n.isMuted), note: 'mute' },
    { field: 'isSoloed', on: 'node', read: n => bool(n.isSoloed), note: 'solo' },
    { field: 'gain', on: 'node', read: n => f32(n.gain === undefined ? 1 : n.gain), note: 'the fader' },
    { field: 'pan', on: 'node', read: n => f32(n.pan), note: 'the pan dial' },
    { field: 'midiArmed', on: 'node', read: n => bool(n.midiArmed), note: 'live MIDI is routed here' },
    { field: 'effectiveQuantum', on: 'node', read: n => int(n.effectiveQuantum),
      note: 'the island Q as each node reports it (lane_body.js and vm/published.js read it)' },
    ...chainRows('node'),
    { field: 'effects.scope', on: 'node', note: 'excluded: scope telemetry, present only while a panel watches' },
    { field: 'currentPeak', on: 'node', note: 'excluded: meter telemetry' },
    { field: 'id', on: 'node', note: 'excluded: ids differ by construction; compared as labels (path, definerId, gate keys)' },
    { field: 'isPlaying', on: 'node', note: 'excluded: the per-node content gate; no reader in ui/js (the transport\'s isPlaying is the island row)' },
    { field: 'qSamples / originQ / windowStartQ / windowEndQ', on: 'node',
      note: 'excluded: the save format\'s Q-rational twins of origin and the window, engine-only; no reader in ui/js. The sample facts they restate are compared above' },
    { field: 'launchPoint', on: 'node', note: 'excluded: mock-only, no reader; the owner ruled it dropped' },

    // ---- clips ----
    { field: 'periodQ', on: 'clip',
      read: n => `${int(n.periodQ && n.periodQ.num)}/${int(n.periodQ && n.periodQ.den) || 1}`,
      note: 'the committed length in Q, {num, den} — a new take\'s slot; 0 for a first take (stacks: engine-only, no reader)' },
    { field: 'contextCycle', on: 'clip', read: n => int(n.contextCycle),
      note: 'the cycle the take was performed against (vm/lane_clip.js folds a take on it)' },
    { field: 'takes', on: 'clip', read: n => int(n.takes), note: 'the take count' },
    { field: 'activeTake', on: 'clip', read: n => int(n.activeTake), note: 'the selected take' },
    { field: 'comp', on: 'clip', read: n => (Array.isArray(n.comp) ? n.comp.map(int) : []), note: 'the comp: a take index per cell' },
    { field: 'inputChannel', on: 'clip', read: n => (n.inputChannel === undefined ? -1 : int(n.inputChannel)), note: 'the recorded input' },
    { field: 'inputChannelR', on: 'clip', read: n => (n.inputChannelR === undefined ? -1 : int(n.inputChannelR)), note: 'the right input (−1: mono)' },
    { field: 'channels', on: 'clip', read: n => int(n.channels === undefined ? 1 : n.channels), note: 'mono or stereo content' },
    { field: 'monitor', on: 'clip', read: n => bool(n.monitor), note: 'software input monitoring' },
    { field: 'contentKind', on: 'clip', read: n => n.contentKind || 'audio', note: 'audio or MIDI' },
    { field: 'midiEvents', on: 'clip', read: n => int(n.midiEvents), note: 'the MIDI take\'s event count' },
    { field: 'sampleRate', on: 'clip', note: 'excluded: the device rate again, engine-only; equal by construction' },
    { field: 'compCellLen', on: 'clip', read: n => int(n.compCellLen), note: 'the comp\'s cell length: the Q it was authored at (0 with no comp)' },
    { field: 'compOffset', on: 'clip', read: n => int(n.compOffset), note: 'the take position of the comp\'s first cell: it slides with a lock-collapse' },
    { field: 'anchored', on: 'clip', note: 'excluded on clips: the engine publishes true on every clip (a clip always owns its origin); the view reads it on stacks' },

    // ---- stacks ----
    { field: 'anchored', on: 'stack', read: n => bool(n.anchored), note: 'the stack\'s origin is a stored fact' },
    { field: 'windowDomain', on: 'stack', read: n => (n.windowDomain === 'sequence' ? 'sequence' : 'intrinsic'), note: 'what the stack\'s window addresses' },
    { field: 'windowSuspended', on: 'stack', read: n => bool(n.windowSuspended), note: 'the window is parked under a song' },
    ...sequenceRows('stack'),
    { field: 'childCount / quantum / zero', on: 'stack', note: 'excluded: engine-only restatements (the tree, the island Q, the island zero); no reader in ui/js' },

    // ---- answers ----
    { field: 'returns', on: 'call', note: 'compared only for the verbs protocol.js gives a return contract the two sides share (see RETURNS in session.mjs); every other verb\'s answer is excluded: the engine\'s void verbs answer `true` for "the call arrived", the mock answers ids, undefined or a refusal bool' },
];

const BY = {};
for (const row of FIELDS) (BY[row.on] = BY[row.on] || []).push(row);

/** The compared rows for a scope ('island' | 'root' | 'node' | 'clip' | 'stack'). */
export function comparedRows(on) {
    return (BY[on] || []).filter(r => typeof r.read === 'function' || typeof r.readMany === 'function');
}

/** The comparator for a field name (deep equality by default). */
export function comparatorOf(field) {
    const row = FIELDS.find(r => r.field === field && r.equal);
    return row ? row.equal : null;
}
