// Celestrian app shell (docs/session_view.md): backend poll → pure view
// model → thin DOM patch. Backend selection lives in backend.js (P2-9);
// all timeline math lives in view_model.js / timeline_model.js; the
// session grid's DOM lives in session_view.js (the preferences panel
// in preferences.js, the plugin popover in plugin_panel.js). This file
// is glue: polling, waveform peak and MIDI note fetching, the
// bridge-call callbacks, the global keyboard verbs, and the small
// chrome it owns directly — the log line, the master fader/VU wiring,
// and the Project menu.

import { callNative, log, getState } from './backend.js';
import { deriveViewModel, findNodeInTree, armMode, hasInstrument }
    from './view_model.js';
import { initSessionView, patchSessionView, mapDragPinQ, mapDragPinFoldQ,
         mapDragPinZero, activeSelectedId, selection, selectWhenPresent }
    from './session_view.js';
import { appendLivePeak } from './live_peaks.js';
import { peakCountFor } from './peak_density.js';
import { initPreferences } from './preferences.js';
import { initPluginPanel } from './plugin_panel.js';
import { notesFromRows, fitPitchRange, rescaleNotes } from './midi_notes.js';
import { filePathOf } from './import_drop.js';
import { updateMasterVU, initMasterMeters, initMasterFader,
         updateMasterFader }
    from './vu_meter.js';
import { registerKey, SCOPE, ANY_MODIFIERS } from './keys.js';
import { foldedStacks, toggleFolded, migrateFolds } from './view_prefs.js';
import { DEBUG } from './debug_flags.js';
import { notePlayStart, notePlayStartTransport, togglePlayFromStart }
    from './play_start.js';
import { seekDelta, seekApplied } from './seek.js';

const dbg = m => { if (DEBUG) log(m); };

/* ---------- tuning constants ---------- */
const POLL_MS = 50;                 // graph-state poll cadence
const PROJECT_POLL_MS = 2000;       // project birth/rename follow the mirror
const RECENTS_CAP = 6;              // recent projects shown in the menu
const CALIBRATION_POLL_TRIES = 40;  // latency calibration: poll attempts…
const CALIBRATION_POLL_MS = 250;    // …every this many ms (10 s ceiling)

const livePeaks = new Map();        // clip id → peak array
const peakKeys = new Map();         // clip id → peakKey the peaks were fetched at (LIVE while recording)
const fxOpen = new Set();           // lane ids with the effects panel expanded (view state)
const seqOpen = new Set();          // stacks with the sequencer grid expanded (view state)
const compMode = new Set();         // clips in COMP MODE (view state, docs/takes.md)
// Clips whose live take is a NEW TAKE of a committed slot. Published
// state cannot say so (the slot keeps its duration), and it is not
// needed: a committed clip that goes hot can only be retaking — the
// engine refuses a plain arm on content — so the poll infers it from
// the transition (trackRetakes).
const retakes = new Set();

/* ---------- small helpers ---------- */

/** Bridge results arrive as JSON strings from the native side but as
 *  objects from the mock — accept either. */
function parseMaybeJson(raw) {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** Write to the status strip's one-line log. */
function setLogLine(msg) {
    const line = document.getElementById('log-line');
    if (line) line.textContent = msg;
}

/* ---------- loop-region commit trace (--debug-ui) ----------
 * The loop region has TWO writers: the lane's brackets (window_edit.js
 * → onSetWindow → setLoopPoints) and the overview panel
 * (region_panel/map_core → onSetSegments → setSegments, which the
 * engine folds back into setLoopPoints for a single window). When they
 * disagree the region oscillates, and neither writer's own log shows
 * the other. This records every commit WITH ITS CALLER, interleaved
 * with what the engine reports back on the next poll, into
 * celestrian_debug.log. Silent unless --debug-ui. */
const traceSeen = new Map();  // node id → last observed [start, end]

/** The first non-app.js frame above the callback — names the writer. */
function traceCaller() {
    const frames = (new Error().stack || '').split('\n').slice(2);
    for (const f of frames) {
        const m = f.match(/([A-Za-z_]+\.js):(\d+)/);
        if (m && m[1] !== 'app.js' && m[1] !== 'backend.js')
            return `${m[1]}:${m[2]}`;
    }
    return '?';
}

function traceCommit(kind, id, startS, endS, live) {
    if (!DEBUG) return;
    log(`[trace] ${kind} id=${String(id).slice(0, 6)} ` +
        `${startS}..${endS} len=${endS - startS} live=${live ? 1 : 0} ` +
        `from=${traceCaller()}`);
}

/** Log the engine's answer whenever a node's window actually moves, so
 * the trace reads commit → answer → commit and the fight is visible. */
function traceObserved(nodesById) {
    if (!DEBUG) return;
    nodesById.forEach((n, id) => {
        if (typeof n.loopStart !== 'number' ||
            typeof n.loopEnd !== 'number') return;
        const prev = traceSeen.get(id);
        if (prev && prev[0] === n.loopStart && prev[1] === n.loopEnd) return;
        if (prev) {
            log(`[trace] observed id=${String(id).slice(0, 6)} ` +
                `${n.loopStart}..${n.loopEnd} len=${n.loopEnd - n.loopStart}`);
        }
        traceSeen.set(id, [n.loopStart, n.loopEnd]);
    });
}

/* ---------- landed-state verification --------
 * The engine refuses window/map edits silently behind several guards
 * (coherence, mid-take, non-definer bounds, wrapper warps); announcing
 * success regardless would leave the next poll snapping the brackets
 * back with no explanation. After a geometry commit settles, ONE
 * debounced state read compares what landed to what was asked — an
 * honest refusal message, or the success + its undo hint. Debounced
 * per node: live splices stream through the same callback (~11/s) and
 * only the final state deserves a verdict. */
const verifyTimers = new Map();  // node id → pending verification timer
function scheduleVerify(id, check, okMsg, refusedMsg) {
    clearTimeout(verifyTimers.get(id));
    verifyTimers.set(id, setTimeout(async () => {
        verifyTimers.delete(id);
        try {
            const state = getState !== null
                ? getState() : await callNative('getGraphState');
            if (!state) return;
            // Children ride `nodes` in the published tree, never
            // `children` (findNodeInTree walks the right key).
            const n = findNodeInTree(state.nodes, id);
            if (!n) return;  // node gone: a refusal message would lie
            setLogLine(check(n) ? okMsg : refusedMsg);
        } catch (_) { /* the poll will tell the story */ }
    }, 250));
}

/** Did a single-window request land on this node (engine clamps
 * honored: start floors at 0, a clip's end at its material)? */
function windowLanded(n, startSamples, endSamples) {
    const s = Math.round(n.loopStart || 0);
    const e = Math.round(n.loopEnd || 0);
    if (endSamples <= startSamples) return e <= s;  // a clear, landed cleared
    const wantS = Math.max(0, startSamples);
    const dur = n.duration || 0;
    const wantE = dur > 0 ? Math.min(endSamples, dur) : endSamples;
    return Math.abs(s - wantS) <= 1 && Math.abs(e - wantE) <= 1;
}

/**
 * callNative + status line in one step: awaits `method(...args)`, then
 * logs `okMsg` — or `failMsg`, when provided and the result is falsy.
 * Either message may be a string or a function of the result (for
 * messages that embed the returned value). Returns the bridge result.
 */
async function call(method, args = [], okMsg, failMsg) {
    const result = await callNative(method, ...args);
    const pick = (failMsg !== undefined && !result) ? failMsg : okMsg;
    if (pick !== undefined) {
        setLogLine(typeof pick === 'function' ? pick(result) : pick);
    }
    return result;
}

/** The first node (depth-first, so a created group before its
 * members) in `nodes` whose id `before` doesn't hold. */
function firstNewNodeId(nodes, before) {
    for (const n of nodes || []) {
        if (!before.has(n.id)) return n.id;
        const inner = firstNewNodeId(n.nodes, before);
        if (inner) return inner;
    }
    return null;
}

/**
 * Run a creation verb and SELECT what it made: a new track is selected
 * by default (it's the one you're about to arm, play or name). The
 * bridge's createNode answers no id, so the new node is found by
 * diffing the tree around the call. Returns the verb's result.
 */
async function createAndSelect(create) {
    const beforeState = await callNative('getGraphState');
    const before = indexNodes(beforeState && beforeState.nodes);
    const result = await create();
    const after = await callNative('getGraphState');
    selectWhenPresent(firstNewNodeId(after && after.nodes, before));
    return result;
}

/* ---------- waveform peaks ---------- */
/** The identity of a clip's ACTIVE content: getWaveform answers for
 * the active take, so a selection or a renumbering delete (docs/
 * takes.md §3) must refetch even though the duration stands. */
const peakKey = n =>
    (n.duration || 0) + ':' + (n.activeTake || 0) + ':' + (n.takes || 0);

/** How many peaks to ask for clip `id` — by its take's LENGTH, not a
 * flat count (peak_density.js; navigation N7). Every take of a slot
 * shares the slot's duration, so one count serves getWaveform and
 * getTakeWaveform. The rate is the last poll's (refreshPeaks). */
let peakSampleRate = 44100;
function peakCountOf(id) {
    const n = lastNodesById.get(id);
    return peakCountFor(n ? n.duration : 0, peakSampleRate);
}

const peakFetches = new Map(); // clip id → in-flight fetch promise
async function fetchWaveform(id, key) {
    // Per-id in-flight guard: concurrent fetches for DIFFERENT clips may
    // proceed; a second request for the same clip while one is in flight
    // is dropped (the poll loop retries next tick if the key moved).
    if (peakFetches.has(id)) return;
    const p = (async () => {
        try {
            const peaks = await callNative('getWaveform', id, peakCountOf(id));
            if (peaks && peaks.length > 0) {
                livePeaks.set(id, peaks);
                peakKeys.set(id, key);
                dbg(`Fetched ${peaks.length} peaks for ${id}`);
            }
        } catch (err) {
            console.error('Waveform fetch failed:', err);
        } finally {
            peakFetches.delete(id);
        }
    })();
    peakFetches.set(id, p);
}

const LIVE = 'live'; // peakKeys marker: array holds live recording peaks

/**
 * Fetch peaks for committed clips whose content we don't have yet; for
 * RECORDING clips, accumulate the engine's currentPeak TIME-INDEXED
 * (live_peaks.js): a peak's slot derives from `duration` at capture, so
 * the drawn waveform is anchored to its position regardless of poll
 * cadence (per-poll pushing would drift content sideways). A NEW TAKE
 * keeps the slot's duration, so its slot derives from the captured
 * length the view model computes (lane.recordingLengthQ).
 */
function refreshPeaks(nodes, sampleRate, lanesById) {
    if (sampleRate > 0) peakSampleRate = sampleRate;
    (nodes || []).forEach(n => {
        if (n.type === 'stack') return refreshPeaks(n.nodes, sampleRate, lanesById);
        if (n.type !== 'clip') return;
        if (n.isRecording) {
            let arr = livePeaks.get(n.id);
            if (!arr || peakKeys.get(n.id) !== LIVE) {
                arr = []; // fresh take: drop stale committed peaks
                livePeaks.set(n.id, arr);
                peakKeys.set(n.id, LIVE);
            }
            const lane = lanesById.get(n.id);
            const captured = lane && lane.retake
                ? (lane.pendingStart ? 0 : lane.recordingLengthQ * lane.quantum)
                : n.duration;
            if (captured > 0) {
                appendLivePeak(arr, captured, sampleRate, n.currentPeak || 0);
            }
            return;
        }
        if (!(n.duration > 0)) return;
        if (!livePeaks.has(n.id) || peakKeys.get(n.id) !== peakKey(n)) {
            fetchWaveform(n.id, peakKey(n)); // also replaces live arrays on commit
        }
    });
}

/* ---------- per-take peaks (docs/takes.md) ----------
 * getTakeWaveform for the take list rows, the comp cells and the
 * silent tile of a retaking lane. Cached per (clip, take): takes are
 * immutable, so an entry is good until the clip's LIST changes (a
 * commit appends, a delete renumbers — both move `takes`), when the
 * clip's entries drop. */
const takePeakCache = new Map();   // `${id}:${k}` → peaks
const takePeakFetches = new Map(); // `${id}:${k}` → in-flight promise
const takeListSizes = new Map();   // clip id → `takes` the cache was built at

/** Peaks of take k, fetching on a miss; resolves [] on a refusal. */
function fetchTakePeaks(id, k) {
    const key = id + ':' + k;
    if (takePeakCache.has(key)) return Promise.resolve(takePeakCache.get(key));
    if (takePeakFetches.has(key)) return takePeakFetches.get(key);
    const p = (async () => {
        try {
            const peaks = await callNative('getTakeWaveform', id, k, peakCountOf(id));
            if (peaks && peaks.length > 0) takePeakCache.set(key, peaks);
            return peaks || [];
        } catch (err) {
            console.error('Take waveform fetch failed:', err);
            return [];
        } finally {
            takePeakFetches.delete(key);
        }
    })();
    takePeakFetches.set(key, p);
    return p;
}

/** The cached peaks of take k, or null (a fetch is kicked off; the
 * next patch draws it). The synchronous face for the patch layer. */
function takePeaksNow(id, k) {
    const cached = takePeakCache.get(id + ':' + k);
    if (cached) return cached;
    fetchTakePeaks(id, k);
    return null;
}

/** Drop a clip's cached takes when its list changes (poll hook). */
function invalidateTakePeaks(nodesById) {
    for (const n of nodesById.values()) {
        if (n.type !== 'clip') continue;
        const size = n.takes || 0;
        if (takeListSizes.get(n.id) === size) continue;
        takeListSizes.set(n.id, size);
        for (const key of [...takePeakCache.keys()]) {
            if (key.startsWith(n.id + ':')) takePeakCache.delete(key);
        }
    }
}

/** The retake inference (see `retakes`): a clip that was committed and
 * idle on the previous poll and is hot now is taking a NEW TAKE; a
 * clip that is no longer hot leaves the set. */
function trackRetakes(prev, next) {
    for (const n of next.values()) {
        if (n.type !== 'clip') continue;
        if (!isHotClip(n)) { retakes.delete(n.id); continue; }
        const was = prev.get(n.id);
        if (was && !isHotClip(was) && (was.duration || 0) > 0) retakes.add(n.id);
    }
}

/* ---------- MIDI notes (docs/vst3.md §11) ----------
 * getMidiNotes for a MIDI lane's tiles, fetched on demand like
 * waveform peaks and cached by the clip's `midiEvents` count + active
 * take + take count (a new take, a selection or a renumbering delete
 * all change what the readout answers) + the quantum (the rows are Q
 * units — trimming the tempo-setting take moves Q under them). The
 * patch layer reads `midiNotes` (id → {notes, range}) through aux. */
const midiNotes = new Map();      // clip id → {notes (Q units), range, quantum}
const midiKeys = new Map();       // clip id → midiKey the notes were fetched at
const midiFetches = new Map();    // clip id → in-flight fetch promise
const midiKey = (n, quantum) =>
    (n.midiEvents || 0) + ':' + (n.activeTake || 0) + ':' + (n.takes || 0) +
    ':' + quantum;

function fetchMidiNotes(id, key, quantum) {
    if (midiFetches.has(id)) return;
    const p = (async () => {
        try {
            const rows = await callNative('getMidiNotes', id);
            const notes = notesFromRows(rows);
            midiNotes.set(id, { notes, range: fitPitchRange(notes), quantum });
            midiKeys.set(id, key);
            dbg(`Fetched ${notes.length} MIDI notes for ${id}`);
        } catch (err) {
            console.error('MIDI note fetch failed:', err);
        } finally {
            midiFetches.delete(id);
        }
    })();
    midiFetches.set(id, p);
}

/** Refetch the notes of every committed, idle MIDI clip whose key
 * moved; a hot clip's stale notes stay until its take commits. Cached
 * notes read at another Q are rescaled NOW, so a live trim of the
 * tempo-setting take never draws them at the stale scale while the
 * refetch is in flight. */
function refreshMidiNotes(nodesById, quantum) {
    for (const [id, m] of midiNotes) {
        if (m.quantum !== quantum) {
            midiNotes.set(id, { notes: rescaleNotes(m.notes, m.quantum, quantum),
                                range: m.range, quantum });
        }
    }
    for (const n of nodesById.values()) {
        if (n.type !== 'clip' || n.contentKind !== 'midi') continue;
        if (isHotClip(n) || !(n.duration > 0)) continue;
        const key = midiKey(n, quantum);
        if (midiKeys.get(n.id) !== key) fetchMidiNotes(n.id, key, quantum);
    }
}

/* ---------- aux data for the patch layer ---------- */
function indexNodes(nodes, map = new Map()) {
    (nodes || []).forEach(n => {
        map.set(n.id, n);
        if (n.nodes) indexNodes(n.nodes, map);
    });
    return map;
}

let lastNodesById = new Map(); // refreshed every poll, used by arm handlers
let lastRootId = '';           // island root uuid (move-to-top target)
// The frame facts the view last SEATED (docs/frame.md), all absolute
// samples: `zero` (a song authored on the root anchors the root there;
// an import lands whole Qs from it; the song bounces from it), the raw
// transport it was polled with (`rawClock`), the audible loop's length
// and Q — what every seek and placement is computed against, since the
// engine reads no frame. Null before a frame exists.
let lastFrame = null;
let auditionOwner = null;      // the stack whose step is looping (Esc target)

/* ---------- record & arm (Q7: arm targets emptiness) ---------- */
function clipsUnder(node, out = []) {
    if (node.type === 'clip') out.push(node);
    (node.nodes || []).forEach(c => clipsUnder(c, out));
    return out;
}
const isHotClip = c => c.isRecording || c.isPendingStart;
/** Committed material in a node's subtree: a clip with a duration
 * that is not recording, or a group holding one. */
const hasCommittedClip = n => n.type === 'clip'
    ? !n.isRecording && (n.duration || 0) > 0
    : (n.nodes || []).some(hasCommittedClip);

/* PER-TRACK RECORD (owner-ruled): there is NO global record button —
 * the track's ● is the record verb, which keeps the core journey
 * direct: song looping → ＋ Track → hit its ● → recording at the next
 * Q boundary. A group's ● records all its empty tracks (the drum-mic
 * case); a recording track's ● stops it. */
/**
 * The lane record button: if anything under the lane is hot
 * (recording/pending), stop it all; otherwise record the lane. Both
 * verbs are ONE bridge call on the lane's own id — the ENGINE owns the
 * cascade (Q7 group arm: a stack arms every empty clip beneath it in
 * one message-thread pass, so the group shares one arm target and one
 * committed duration; a per-clip loop here could straddle an audio
 * block and split the group across two boundaries). The engine also
 * owns the Q-boundary wait (Q11) and arm-targets-emptiness (Q7).
 *
 * NEW TAKE (docs/takes.md §2, "new take on the record button"): with
 * nothing empty beneath, ● on a committed clip — or on a group whose
 * committed direct clips exist — calls `newTake` (the engine refuses a
 * plain arm on content). The take captures one period from the slot's
 * next top; ● again before that cancels it.
 */
async function onArm(lane) {
    const node = lastNodesById.get(lane.id);
    if (!node) return;
    const clips = clipsUnder(node);
    const hot = clips.filter(isHotClip);
    if (hot.length > 0) {
        await callNative('stopRecordingInNode', lane.id);
        setLogLine(hot.some(c => retakes.has(c.id))
            ? 'New take cancelled — the previous take sounds again'
            : 'Stopped recording');
        return;
    }
    const targets = clips.filter(c => armMode(c) === 'record');
    if (targets.length === 0) {
        const slots = node.type === 'clip'
            ? (armMode(node) === 'retake' ? [node] : [])
            : (node.nodes || []).filter(c => c.type === 'clip' &&
                                             armMode(c) === 'retake');
        if (slots.length === 0) {
            setLogLine('Nothing to record — loop a one-shot (↺) to take it again');
            return;
        }
        await callNative('newTake', lane.id);
        setLogLine(slots.length > 1
            ? `New take of ${slots.length} tracks from the group top (● again cancels)`
            : 'New take — one period from the slot top (● again cancels)');
        return;
    }
    await callNative('startRecordingInNode', lane.id);
    // A MIDI track (phase 5) records notes from the keyboard into its
    // instrument (the engine MIDI-arms it on record) — say so.
    const midi = targets.every(c => c.contentKind === 'midi');
    setLogLine(targets.length > 1
        ? `Recording ${targets.length} empty tracks (full ones just play)`
        : midi ? 'Recording MIDI — play your keyboard' : 'Recording');
}

/* R = the record key: press the selected track's (or group's) ● from
 * the keyboard. Stop is SELECTION-PROOF — if anything is recording
 * anywhere, R stops it all (one engine call on the root: the selection
 * may have changed mid-take, and a stop that silently no-ops while tape
 * rolls is the worst failure mode). With nothing hot, R records the
 * selected lane; with no selection and exactly one top-level lane, that
 * lane. With ZERO lanes (Q17: the app boots empty), R CREATES + ARMS
 * the default track — the scratch spark is literally one key: launch →
 * R → recording. */
async function onRecordKey(selectedId) {
    const anyHot = [...lastNodesById.values()].some(isHotClip);
    if (anyHot) {
        if (lastRootId) await callNative('stopRecordingInNode', lastRootId);
        setLogLine('Stopped recording');
        return;
    }
    // Q17 spark path: empty project → create the default track and arm
    // it in one gesture (the R canon's no-selection case extended down
    // to zero lanes).
    if (lastNodesById.size === 0) {
        await callNative('createNode', 'clip', '');
        const st = await callNative('getGraphState');
        const first = (st && st.nodes && st.nodes[0]) || null;
        if (first) {
            lastNodesById = indexNodes(st.nodes);
            lastRootId = st.id || lastRootId;
            await onArm({ id: first.id });
        }
        return;
    }
    let id = selectedId && lastNodesById.has(selectedId) ? selectedId : null;
    if (!id) {
        const top = [...lastNodesById.values()].filter(n => !findParentIn(n));
        if (top.length === 1) id = top[0].id;
    }
    if (!id) {
        setLogLine('Select a track to record (R)');
        return;
    }
    await onArm({ id });
}

function findStackIn(nodes, id) {
    for (const n of nodes || []) {
        if (n.id === id) return n;
        const hit = findStackIn(n.nodes, id);
        if (hit) return hit;
    }
    return null;
}

// A node is a root iff nothing in the index has it as a child
function findParentIn(node) {
    for (const n of lastNodesById.values()) {
        if (n.nodes && n.nodes.includes(node)) return n;
    }
    return null;
}

/* ---------- session-view callbacks (structure) ---------- */

/* Drag-to-group: clip target → combine into a new group; group target
 * → move inside. A multi-drag (selected rails) applies to every
 * dragged track. */
/**
 * Sequencing: the first drop onto a CLIP target calls combineNodes
 * (which creates the group); every further id is reorderNode'd into
 * that group, appended in drag order. The graph is fetched ONCE, after
 * the group exists, to seed the append cursor — each insert then
 * advances it locally (no per-id refetch).
 */
async function onDropLane(ids, target) {
    const tNode = lastNodesById.get(target.id);
    if (!tNode) return;
    let stackId = tNode.type === 'stack' ? target.id : '';
    let appendIndex = -1;  // resolved lazily once the group exists
    let grouped = 0;
    for (const id of ids) {
        const node = lastNodesById.get(id);
        if (!node) continue;
        if (!stackId) {
            // First drop onto a clip: combine forms the group.
            stackId = await callNative('combineNodes', id, target.id);
            grouped++;
            continue;
        }
        if (appendIndex < 0) {
            const st = await callNative('getGraphState');
            const stack = findStackIn(st.nodes, stackId) || {};
            // Append = current child count. 0 is a valid index (empty
            // group) — no sentinel.
            appendIndex = (stack.nodes || []).length;
        }
        await callNative('reorderNode', id, stackId, appendIndex++);
        grouped++;
    }
    const tName = tNode.name || 'group';
    setLogLine(grouped > 1
        ? `Grouped ${grouped} tracks with "${tName}"`
        : tNode.type === 'stack'
            ? `Moved into "${tName}"`
            : `Grouped with "${tName}" — rename the group on its rail`);
}

// Floating bar: group the SELECTION in place (no outside target).
/**
 * Sequencing: combineNodes(ids[1], ids[0]) forms the group with the
 * first-selected as the anchor (the new stack lands at the TARGET's
 * slot), holding exactly 2 children; each remaining id is appended at
 * index i — the child count when it arrives.
 */
async function onGroupSelection(ids) {
    if (ids.length < 2) return;
    // combine(dragged, target): the new stack lands at the
    // TARGET's slot — use the first-selected as the anchor.
    const stackId = await callNative('combineNodes', ids[1], ids[0]);
    for (let i = 2; i < ids.length; i++) {
        // After combine the stack holds 2 children, so ids[2] appends at
        // index 2, ids[3] at 3, … — i IS the append index (no sentinel).
        await callNative('reorderNode', ids[i], stackId, i);
    }
    setLogLine(`Grouped ${ids.length} tracks — rename the group on its rail`);
}

// Drag-out: back to the top level (the island root).
async function onMoveToTop(ids) {
    if (!lastRootId) return;
    // Append after the current top-level lanes: one fetch seeds the
    // cursor, each move advances it locally (no sentinel index).
    const st = await callNative('getGraphState');
    let idx = (st.nodes || []).length;
    for (const id of ids) {
        await callNative('reorderNode', id, lastRootId, idx++);
    }
    setLogLine(ids.length > 1
        ? `Moved ${ids.length} tracks to the top level`
        : 'Moved to the top level');
}

// Ungroup: children move up to the group's slot; the shell goes.
/**
 * Sequencing: each child is reorderNode'd into the group's PARENT at
 * consecutive indices starting from the group's own slot, then the
 * (now empty) group shell is deleted. Order matters — deleting first
 * would orphan the children.
 */
async function onUngroup(groupId) {
    const group = lastNodesById.get(groupId);
    if (!group) return;
    const parentNode = findParentIn(group);
    const parentId = parentNode ? parentNode.id : lastRootId;
    const siblings = parentNode
        ? (parentNode.nodes || [])
        : [...lastNodesById.values()].filter(n => !findParentIn(n));
    let idx = Math.max(0, siblings.indexOf(group));
    for (const child of [...(group.nodes || [])]) {
        await callNative('reorderNode', child.id, parentId, idx++);
    }
    await callNative('deleteNode', groupId);
    setLogLine(`Ungrouped "${group.name}" — tracks moved up (⌘Z steps back through it)`);
}

/* ---------- session-view callbacks (per-lane state) ---------- */

// Comp mode (docs/takes.md): pure view state — null closes every
// lane's (Escape).
function onCompMode(id, open) {
    if (id === null) { compMode.clear(); return; }
    if (open) compMode.add(id); else compMode.delete(id);
    setLogLine(open
        ? 'Comp: click a Q cell to cycle which take sounds there (⌘Z undoes each)'
        : 'Comp closed — the comp stays');
}

// (The `warpPointer` bridge verb — the expanded map drag's cursor
// teleport — has no JS caller since the same-scale reveal, 2026-09-11.
// The native verb stays registered for protocol parity.)

// Recording input (clips only — Q7: each child records from its
// own input). The list is fetched per menu-open: hot-plugged
// devices appear without a reload.
async function getInputs() {
    try {
        const r = await callNative('getInputList');
        return (r && r.inputs) || [];
    } catch (err) {
        console.error('getInputList failed:', err);
        return [];
    }
}

// Built-in effects: panel-open is pure view state; enable and
// params go straight to the engine's fixed rack
function onToggleFx(id) {
    const open = !fxOpen.has(id);
    if (open) fxOpen.add(id);
    else fxOpen.delete(id);
    // Gate the engine's scope capture: no watcher, no copying
    callNative('setEffectScope', id, open);
}

/* ---------- status strip ---------- */
function wireStatusStrip() {
    const dumpBtn = document.getElementById('dump-state-btn');
    dumpBtn.addEventListener('click', async () => {
        try {
            const state = await callNative('getGraphState');
            await callNative('dumpStateToFile', JSON.stringify(state, null, 2));
            setLogLine('State dumped to celestrian_state.json');
        } catch (err) {
            setLogLine('Error dumping state: ' + err.message);
        }
    });

    // Latency calibration (docs/performance.md §7)
    const calibrateBtn = document.getElementById('calibrate-btn');
    const calibrationStatus = document.getElementById('calibration-status');
    calibrateBtn.addEventListener('click', async () => {
        try {
            calibrateBtn.disabled = true;
            calibrationStatus.textContent = 'Calibrating… (keep quiet, click incoming)';
            await callNative('startLatencyCalibration');
            let result = null;
            for (let i = 0; i < CALIBRATION_POLL_TRIES; i++) {
                await new Promise(r => setTimeout(r, CALIBRATION_POLL_MS));
                result = await callNative('getLatencyCalibration');
                if (result && result.phase !== 'capturing') break;
            }
            if (result && result.calibrated) {
                calibrationStatus.textContent =
                    `Latency: ${result.roundTripSamples} samples (${result.roundTripMs.toFixed(1)} ms)`;
            } else {
                calibrationStatus.textContent =
                    'Calibration failed — no loopback signal. Route output to input and retry.';
            }
        } catch (err) {
            calibrationStatus.textContent = 'Calibration error: ' + err.message;
        } finally {
            calibrateBtn.disabled = false;
        }
    });

    // The preferences panel (preferences.js) hosts the device pickers
    // beside the calibration button above: calibration is keyed on
    // device|rate|buffer, so it sits next to what changes all three.
    initPreferences(callNative, setLogLine);

    // Plugin registry panel (docs/vst3.md phase 1) — same popover
    // pattern; chain integration arrives with phases 2-3.
    initPluginPanel(callNative, setLogLine);
}

function patchCalibrateButton(state) {
    const calBtn = document.getElementById('calibrate-btn');
    if (calBtn && !calBtn.disabled && state.perf) {
        if (state.perf.calibrated) {
            const sr = state.perf.sampleRate || 44100;
            const ms = (state.perf.latencyCompensationSamples / sr) * 1000;
            calBtn.textContent = `🎯 Recalibrate (${ms.toFixed(1)} ms)`;
        } else {
            calBtn.textContent = '🎯 Calibrate';
        }
    }
}

/* ---------- MIDI target follows selection ---------- */
/**
 * The keyboard plays the SELECTED instrument track (owner-ruled: a
 * selected instrument track is always monitoring; there is no separate
 * toggle). Reconciled every poll: the desired target is a
 * MIDI take in progress if there is one (record MIDI-arms its clip in
 * the engine; the performer is playing INTO it), else the most recently
 * selected lane whose chain carries an instrument. Nothing selected /
 * an audio lane selected keeps the last target, so tweaking another
 * track never silences the keys. One bridge call per change, and only
 * when the published state disagrees (no re-sends while a call is in
 * flight).
 */
let midiTargetPending = null;
function syncMidiTarget() {
    let desired = null;
    for (const n of lastNodesById.values()) {
        if (n.contentKind === 'midi' && (n.isRecording || n.isPendingStart)) {
            desired = n.id;
            break;
        }
    }
    if (!desired) {
        const sel = lastNodesById.get(activeSelectedId());
        if (hasInstrument(sel)) desired = sel.id;
    }
    if (!desired) { midiTargetPending = null; return; }
    const node = lastNodesById.get(desired);
    if (node.midiArmed) { midiTargetPending = null; return; }
    if (midiTargetPending === desired) return;  // call in flight
    midiTargetPending = desired;
    callNative('setMidiArmed', desired, true).catch(() => {
        midiTargetPending = null;
    });
}

/* ---------- polling ---------- */
/**
 * The render loop: poll graph state every POLL_MS, derive the view
 * model, patch the DOM. Never returns.
 *
 * - Mock fast path: when backend.js exposes a `getState` (mock/harness
 *   modes) it is called synchronously; production polls the bridge via
 *   callNative('getGraphState').
 * - Stale-engine handling: a binary built before the master VU publishes
 *   no masterVuL — the monitor dims (`.stale`) with an explanatory
 *   tooltip instead of showing dead needles.
 * - Errors are logged and the loop keeps polling (one bad poll must not
 *   kill the UI).
 */
async function startPolling() {
    const isMock = getState !== null;
    console.log(`Starting state polling loop (${isMock ? 'MOCK BACKEND' : 'JUCE BRIDGE'})...`);
    while (true) {
        try {
            const state = isMock ? getState() : await callNative('getGraphState');
            if (state) {
                const nodesById = indexNodes(state.nodes);
                traceObserved(nodesById);
                trackRetakes(lastNodesById, nodesById);
                lastNodesById = nodesById;
                lastRootId = state.id || '';
                invalidateTakePeaks(lastNodesById);
                const vm = deriveViewModel(state,
                    { folded: foldedStacks(projectInfo.id),
                      fxOpen, seqOpen, compMode, retakes,
                      pinFrameQ: mapDragPinQ(),
                      pinFoldQ: mapDragPinFoldQ(),
                      pinZero: mapDragPinZero() });
                refreshMidiNotes(lastNodesById, vm.quantum);
                lastFrame = vm.qEstablished && Number.isFinite(vm.frameZero) &&
                    Number.isFinite(state.islandPos)
                    ? { zero: vm.frameZero,
                        rawClock: state.islandPos + (state.islandZero ?? 0),
                        loopSamples: (vm.loopCycleQ > 0 ? vm.loopCycleQ : vm.cycleQ) * vm.quantum,
                        quantum: vm.quantum }
                    : null;
                const lanesById = new Map(vm.lanes.map(l =>
                    [l.id, Object.assign({ quantum: vm.quantum }, l)]));
                refreshPeaks(state.nodes,
                    (state.perf && state.perf.sampleRate) || 44100, lanesById);
                notePlayStartTransport(state.isPlaying, vm.qEstablished, lastFrame);
                settlePendingPause(state);
                // Committed clips whose real waveform hasn't landed yet:
                // composites must not blend their live meter peaks
                const pendingFetch = new Set();
                for (const n of lastNodesById.values()) {
                    if (n.type === 'clip' && !n.isRecording && n.duration > 0 &&
                        peakKeys.get(n.id) !== peakKey(n)) {
                        pendingFetch.add(n.id);
                    }
                }
                patchSessionView(vm, {
                    livePeaks,
                    pendingFetch,
                    // Per-take peaks for the comp cells and a retaking
                    // lane's silent tile (cached; null until fetched)
                    takePeaks: takePeaksNow,
                    // A MIDI lane's notes for its tiles (cached above)
                    midiNotes,
                    nodesById: lastNodesById,
                    vmQuantum: vm.quantum,
                    // Composite offsets are cycle projections of origin —
                    // computed in the island frame (one-frame rule)
                    frameZero: vm.frameZero,
                    sampleRate: state.perf ? state.perf.sampleRate : 0,
                });
                patchCalibrateButton(state);
                syncMidiTarget();
                // Master monitor (B5): the engine meters the device
                // buffers AFTER root_node->process — the reading is
                // post-fader, post-rack — and vu_meter.js sweeps the
                // needles (CSS transition interpolates between polls),
                // holds the peak tick and latches the clip lamp. The
                // fader mirrors the root's gain (vm.rootGain).
                // STALE-ENGINE TELL: a binary built before the master VU
                // publishes no masterVuL at all — dim the meters and say
                // why, instead of showing dead needles that look broken.
                const monitor = document.getElementById('master-monitor');
                if (monitor) {
                    const stale = typeof state.masterVuL === 'undefined';
                    monitor.classList.toggle('stale', stale);
                    if (stale) {
                        monitor.title = 'No master levels in engine state — '
                            + 'rebuild the app (the C++ engine predates the '
                            + 'master VU)';
                    } else {
                        // Live dB readout on hover — doubles as the
                        // diagnostic surface for the meter path.
                        const db = v => {
                            const n = Number(v) || 0;
                            return n <= 0 ? '−∞'
                                : (20 * Math.log10(n)).toFixed(1);
                        };
                        monitor.title = 'Master output (post-fader) — L '
                            + db(state.masterVuL) + ' dB · R '
                            + db(state.masterVuR) + ' dB (raw L='
                            + state.masterVuL
                            + ') · click a face to release its clip lamp';
                    }
                }
                updateMasterVU(Number(state.masterVuL) || 0,
                               Number(state.masterVuR) || 0);
                updateMasterFader(vm.rootGain);
            }
        } catch (err) {
            console.error('Polling error:', err);
        }
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

/* ---------- init ---------- */
/* ---------- Audio file import (docs/import.md) ----------
 * A WAV/AIFF/FLAC becomes a committed take at an absolute origin the
 * view computes — whole Qs from the frame zero it seated (docs/frame.md;
 * the engine snaps it to the Q grid). Two entry points:
 * the native chooser (the + menu, the project menu, a drop the page
 * cannot name — see import_drop.js on the WebView path limit) and the
 * direct verb for a drop whose File exposes a filesystem path. Both
 * are undoable engine-side; both refuse under a live take. */

/** The status line for an import result. */
function importVerdict(result, what) {
    if (result) return `Imported${what ? ' ' + what : ''} — ⌘Z to undo`;
    if ([...lastNodesById.values()].some(isHotClip)) {
        return 'Import refused — a take is live';
    }
    return 'Import cancelled — or refused: audio files land on audio ' +
        'tracks (WAV, AIFF, FLAC)';
}

/** The absolute origin for a placement `q` whole Qs into the frame the
 * view seats (docs/frame.md); 0 before a frame exists, when the engine
 * takes the clock instead (the first-take rule). */
function importOriginAt(q) {
    return lastFrame ? lastFrame.zero + q * lastFrame.quantum : 0;
}

/** The native chooser, placed at `q` (whole Q of the frame). */
function importWithDialog(targetId, q) {
    const id = targetId || lastRootId;
    if (!id) return Promise.resolve(false);
    return createAndSelect(() => call('importAudioWithDialog', [id, importOriginAt(q)],
        r => importVerdict(r, q > 0 ? `at Q${q}` : '')));
}

/**
 * An OS file dropped on a lane (lane_build.js): the first file lands
 * at the drop's Q. A File that carries a path imports directly; one
 * that carries only its name (every sandboxed WebView) falls back to
 * the chooser, placed at the same Q.
 */
function onImportDrop(laneId, q, files) {
    const file = files && files[0];
    const path = filePathOf(file);
    if (!path) return importWithDialog(laneId, q);
    return createAndSelect(() => call('importAudio', [laneId, path, importOriginAt(q)],
        r => importVerdict(r, `${file.name} at Q${q}`)));
}

/* ---------- The project model (docs/projects.md) ----------
 * A project is a dated folder BORN at the first committed take and
 * continuously mirrored after. The UI's jobs: show the display name
 * (click to rename — the folder never moves), announce the birth, and
 * offer templates/recents on the empty state.
 */
let projectInfo = { id: '', name: '', born: false };

/**
 * Poll the bridge for project identity and mirror it into the chrome:
 * the menu button shows the display name once the project is born, and
 * the birth itself is announced on the status line the first poll that
 * sees it. `announceSave` additionally logs "Saved …" (⌘S / Save now).
 * Errors are swallowed — the next PROJECT_POLL_MS tick retries.
 */
function refreshProjectInfo(announceSave = false) {
    return callNative('getProjectInfo').then(raw => {
        const info = parseMaybeJson(raw);
        // A lost bridge call resolves null (bridge.js contract: never
        // rejects). Keep the last good state — assigning null would
        // poison projectInfo permanently, and every later click on the
        // button would throw on `projectInfo.born` BEFORE the menu
        // opened (a dead "Project ▾" button).
        if (!info || typeof info !== 'object') return;
        const wasBorn = projectInfo.born;
        projectInfo = info;
        // Folds are UI-local, scoped by project id (view_prefs.js):
        // birth carries the pre-birth session's folds onto the project.
        if (!wasBorn && info.born) migrateFolds('', info.id);
        // The menu button IS the project's identity in the chrome: quiet
        // "Project ▾" pre-birth, the display name once it exists.
        const btn = document.getElementById('project-menu-btn');
        if (btn) {
            btn.textContent = info.born ? `${info.name} ▾` : 'Project ▾';
            btn.title = info.born
                ? `${info.id} — save, rename, templates`
                : 'Project — save, rename, templates';
        }
        if (!wasBorn && info.born) {
            setLogLine(`Project ${info.id} created — mirroring to disk`);
        } else if (announceSave && info.born) {
            setLogLine(`Saved ${info.name}`);
        }
    }).catch(() => {});
}


/* The project menu — the compact "file menu": everything the bridge
 * offers, one popover. Rebuilt on every open so templates/recents are
 * always fresh. */
/**
 * Build the popover's DOM into `menu`. Static items render
 * synchronously; the template and recents sections append when their
 * bridge fetches resolve. Local helpers: item() = action row, head() =
 * section header, sep() = divider, inlineRow() = input + one action
 * (rename, save-as-template).
 */
function buildProjectMenu(menu) {
    menu.textContent = '';
    const close = () => menu.classList.remove('open');
    const item = (label, fn, disabled = false) => {
        const b = document.createElement('button');
        b.className = 'pm-item';
        b.textContent = label;
        b.disabled = disabled;
        b.addEventListener('click', () => { close(); fn(); });
        menu.appendChild(b);
        return b;
    };
    const head = label => {
        const d = document.createElement('div');
        d.className = 'pm-head';
        d.textContent = label;
        menu.appendChild(d);
    };
    const sep = () => {
        const d = document.createElement('div');
        d.className = 'pm-sep';
        menu.appendChild(d);
    };

    // Inline text row (rename, save-as-template): input + one action.
    const inlineRow = (placeholder, initial, actionLabel, onCommit) => {
        const row = document.createElement('div');
        row.className = 'pm-inline';
        const input = document.createElement('input');
        input.placeholder = placeholder;
        input.value = initial || '';
        const go = document.createElement('button');
        go.textContent = actionLabel;
        go.addEventListener('click', () => {
            const v = input.value.trim();
            if (v) { close(); onCommit(v); }
        });
        input.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') go.click();
            if (ev.key === 'Escape') close();
            ev.stopPropagation();
        });
        row.append(input, go);
        menu.appendChild(row);
    };

    const born = projectInfo.born;
    item(born ? `Save now (${projectInfo.name})` : 'Save now — creates today’s project',
        () => callNative('saveProjectNow').then(() => refreshProjectInfo(true)));
    if (born) {
        head('Rename (the folder never moves)');
        inlineRow('project name', projectInfo.name, 'Rename', name =>
            call('renameProject', [name], 'Project renamed (folder unchanged)')
                .then(() => refreshProjectInfo()));
    }
    item('Duplicate project (next serial)', () =>
        call('duplicateProject', [],
            id => `Forked to ${id} — the original stays as a checkpoint`,
            'Nothing to duplicate yet')
            .then(() => refreshProjectInfo()), !born);
    item('Open project folder…', () =>
        call('loadSession', [''], 'Project opened', 'Open cancelled')
            .then(() => refreshProjectInfo()));

    // Bounce (Q19, docs/bounce.md): the song is the island root for one
    // effective cycle; a single selected lane bounces for one effective
    // period. Both open the native save dialog. The engine refuses
    // under a live take; a cancelled dialog also answers false.
    sep();
    const bounceVerdict = result => result ? 'Bounced'
        : [...lastNodesById.values()].some(isHotClip)
            ? 'Bounce refused — a take is live'
            : 'Bounce cancelled';
    // The song bounces from the frame zero the view has SEATED, so the
    // file starts where the picture starts (docs/frame.md); a single
    // lane bounces from its own top (the engine's default).
    const bounceTo = (id, start = null) =>
        call('bounceWithDialog', start === null ? [id] : [id, start], bounceVerdict);
    const songHasContent = lastRootId &&
        [...lastNodesById.values()].some(hasCommittedClip);
    item('Bounce song…',
         () => bounceTo(lastRootId, lastFrame ? lastFrame.zero : null),
         !songHasContent);
    if (selection.size === 1) {
        const sel = lastNodesById.get(activeSelectedId());
        if (sel) item('Bounce selected…', () => bounceTo(sel.id),
                      !hasCommittedClip(sel));
    }

    // Audio file import (docs/import.md): a new track from a file,
    // picked natively, at the frame top. Refused under a live take.
    item('Import audio…', () => importWithDialog(lastRootId, 0),
         !lastRootId || [...lastNodesById.values()].some(isHotClip));

    sep();
    head('Save as template');
    inlineRow('e.g. My Rig', '', 'Save', name =>
        call('saveAsTemplate', [name],
            `Template "${name}" saved — it loads automatically next launch`,
            'Template save failed'));

    callNative('listTemplates').then(raw => {
        // `|| []`: a lost bridge call resolves null — the menu simply
        // shows no template section rather than dying mid-build.
        const templates = parseMaybeJson(raw) || [];
        if (!templates.length) return;
        sep();
        head('New from template');
        templates.forEach(t => item(t.name, () =>
            call('newProjectFromTemplate', [t.id],
                `Template "${t.name}" loaded — play the seed`,
                'Template failed to load')
                .then(() => refreshProjectInfo())));
    });
    callNative('listRecentProjects').then(raw => {
        const recents = parseMaybeJson(raw) || [];
        if (!recents.length) return;
        sep();
        head('Recent projects');
        recents.slice(0, RECENTS_CAP).forEach(r => item(
            r.name === r.id ? r.id : `${r.name} · ${r.id}`, () =>
            call('openProjectPath', [r.path], `Opened ${r.name}`, 'Open failed')
                .then(() => refreshProjectInfo())));
    });
}

function initProjectUI() {
    const btn = document.getElementById('project-menu-btn');
    const menu = document.getElementById('project-menu');
    if (btn && menu) {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            if (menu.classList.contains('open')) {
                menu.classList.remove('open');
            } else {
                buildProjectMenu(menu);
                menu.classList.add('open');
            }
        });
        document.addEventListener('click', ev => {
            if (!menu.contains(ev.target)) menu.classList.remove('open');
        });
    }
    refreshProjectInfo();
    setInterval(refreshProjectInfo, PROJECT_POLL_MS);  // birth/rename follow the mirror
}

/* SPACE = STOP EVERYTHING (playback AND recording; R stays the record
 * key). With a take rolling, Space requests the stop — the take
 * finishes to its next boundary like every stop (stops always pad
 * forward) — and the transport PAUSES the moment it lands
 * (pausing the clock first would strand the take awaiting a boundary
 * that never comes). An armed-not-yet-capturing take is cancelled and
 * the pause follows on the next poll. A second Space before the take
 * lands pauses at once (the user insists; the take resumes with play).
 * Without a hot take, Space is the transport toggle: play from the
 * play start, stop back to it (play_start.js). */
let pauseWhenTakeLands = false;

async function onSpace() {
    const anyHot = [...lastNodesById.values()].some(isHotClip);
    if (anyHot && !pauseWhenTakeLands) {
        pauseWhenTakeLands = true;
        if (lastRootId) await callNative('stopRecordingInNode', lastRootId);
        setLogLine('Stopping recording at the boundary, then pausing');
        return;
    }
    pauseWhenTakeLands = false;
    togglePlayFromStart(callNative, projectInfo.id);
}

/** Poll hook: the deferred pause from onSpace, once nothing is hot. */
function settlePendingPause(state) {
    if (!pauseWhenTakeLands) return;
    const anyHot = [...lastNodesById.values()].some(isHotClip);
    if (anyHot) return;
    pauseWhenTakeLands = false;
    if (state.isPlaying) {
        togglePlayFromStart(callNative, projectInfo.id);
        setLogLine('Recording stopped — paused');
    }
}

/** The app-scope hotkeys (keys.js): transport, undo/redo, project
 * save/open. Typing targets never reach them (the dispatcher's guard). */
function wireKeyboard() {
    const app = spec => registerKey({ scope: SCOPE.APP, ...spec });
    app({ code: 'Space', ignore: ANY_MODIFIERS, handler: e => {
        e.preventDefault();
        onSpace();
    } });
    // Undo / redo (edits-as-events, §2.2 Step 1). Cmd/Ctrl+Z undoes;
    // Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes. The next poll refreshes
    // the view from the restored graph.
    const undo = e => { e.preventDefault(); callNative('undo'); setLogLine('Undo'); };
    const redo = e => { e.preventDefault(); callNative('redo'); setLogLine('Redo'); };
    app({ key: 'z', modifiers: ['primary'], handler: undo });
    app({ key: 'z', modifiers: ['primary', 'shift'], handler: redo });
    app({ key: 'y', modifiers: ['ctrl'], handler: redo });
    // ⌘S = checkpoint the PROJECT (docs/projects.md): the mirror
    // already saves continuously; an explicit save births an unborn
    // project (intent enough) and stamps the folder now.
    app({ key: 's', modifiers: ['primary'], handler: e => {
        e.preventDefault();
        callNative('saveProjectNow').then(() => refreshProjectInfo(true));
    } });
    app({ key: 'o', modifiers: ['primary'], handler: e => {
        e.preventDefault();
        call('loadSession', [''], 'Session loaded', 'Load cancelled');
    } });
}

function initApp() {
    initSessionView({
        onTogglePlay: () => togglePlayFromStart(callNative, projectInfo.id),
        // Ruler scrub: target in the published-masterPos domain,
        // samples. Streams while dragging
        // (the engine shifts every origin with its zero); NOT undoable — a
        // monitoring gesture, like auditionStep. The engine refuses
        // mid-take (the UI locks the gesture too). A landed seek is
        // also the new play start (play_start.js).
        onSeek: async samples => {
            // The ruler names a target PHASE; the engine takes a phase
            // ADVANCE computed against the latest poll's frame facts
            // (seek.js) — the view seats the frame's zero, the engine
            // reads no frame (docs/frame.md).
            const delta = seekDelta(samples, lastFrame);
            if (delta === null) return;
            const result = await callNative('seekTransport', delta, lastFrame.rawClock);
            if (!result) return;
            // A scrub streams seeks faster than the poll: fold the applied
            // seek into the frame facts so the next one is computed
            // against the truth, not the pre-seek picture.
            lastFrame = seekApplied(lastFrame, result);
            notePlayStart(projectInfo.id, samples);
        },
        // Fold is UI-local (I6b): never a bridge call. The next poll
        // re-derives the view from the folded set.
        onFold: id => toggleFolded(projectInfo.id, id),
        onMute: id => callNative('toggleMute', id),
        onSolo: id => callNative('toggleSolo', id),
        onAddTrack: () => createAndSelect(() => callNative('createNode', 'clip', '')),
        onDropLane,
        onGroupSelection,
        onMoveToTop,
        onUngroup,
        onAddClip: groupId =>
            createAndSelect(() => callNative('createNode', 'clip', groupId)),
        // Track templates (Q17): the creation menu's data + verbs. The
        // list is fetched per menu-open (the input-menu pattern — a
        // fresh save appears without a reload).
        getTrackTemplates: async () =>
            parseMaybeJson(await callNative('listTrackTemplates')) || [],
        // The fx row's "+" picker data (docs/vst3.md phase 3): fetched
        // per open, like the templates — session_view never touches
        // the backend itself.
        getKnownPlugins: async () => await callNative('getKnownPlugins') || [],
        onCreateFromTemplate: (name, groupId) => createAndSelect(() =>
            call('createFromTrackTemplate', [name, groupId || ''],
                `"${name}" added — named and routed (⌘Z undoes it whole)`,
                `Template "${name}" failed to load`)),
        onSaveTemplate: (id, name) =>
            call('saveTrackTemplate', [id, name],
                `Template "${name}" saved — it's on every + menu now`,
                'Template save failed'),
        // No confirm: undo is the safety net (edits-as-events).
        onDelete: id => call('deleteNode', [id], 'Deleted — ⌘Z to undo'),
        onRename: (id, name) =>
            call('renameNode', [id, name], `Renamed to "${name}"`),
        // Loop windows (time_maps.md): the region is data (setLoopPoints),
        // activation is a toggle between active and bypassed
        onSetWindow: async (id, startSamples, endSamples, live = false) => {
            traceCommit('setWindow  ', id, startSamples, endSamples, live);
            const r = await callNative('setLoopPoints', id, startSamples,
                                       endSamples, live);
            scheduleVerify(id, n => windowLanded(n, startSamples, endSamples),
                'Loop window set — ⌘Z to undo',
                'Loop window refused by the engine — geometry unchanged');
            return r;
        },
        onToggleWindow: id => callNative('toggleLoopWindow', id),
        // Multi-segment maps (phase 3, the sequencer): one commit per
        // editor gesture — flat [s0,e0,...] in samples.
        // `live`: a mid-gesture commit (coalesces into the gesture's
        // undo entry, owner ruling 2026-09-10).
        onSetSegments: async (id, flatSegments, live = false) => {
            traceCommit('setSegments', id, flatSegments[0],
                        flatSegments[flatSegments.length - 1], live);
            const r = await callNative('setSegments', id, flatSegments, live);
            scheduleVerify(id, n => {
                if (flatSegments.length >= 4) {
                    const got = n.segments || [];
                    return got.length === flatSegments.length &&
                        got.every((v, i) =>
                            Math.abs(v - flatSegments[i]) <= 1);
                }
                // n ≤ 1 delegates to the single-window path inside the
                // engine; judge it by the same law.
                if (flatSegments.length < 2) {
                    return !(n.segments && n.segments.length >= 4);
                }
                return windowLanded(n, flatSegments[0], flatSegments[1]);
            }, 'Map updated — ⌘Z to undo',
               'Map refused by the engine — unchanged');
            return r;
        },
        getInputs,
        onSetInput: (id, channelIndex) =>
            call('setNodeInput', [id, channelIndex],
                `Input set to channel ${channelIndex + 1}`),
        // Right input of a stereo pair; −1 reverts the clip to mono.
        // The channel count of a take is fixed at arm (engine rule).
        onSetInputRight: (id, channelIndex) =>
            call('setNodeInputRight', [id, channelIndex], channelIndex >= 0
                ? `Stereo pair: right = channel ${channelIndex + 1}`
                : 'Track set to mono'),
        // Software input monitoring (Q20): a monitoring gesture like
        // solo — not undoable, straight to the bridge.
        onMonitor: (id, on) => {
            callNative('setMonitor', id, on);
            setLogLine(on ? 'Monitoring input through the track'
                          : 'Input monitoring off');
        },
        // Pan/balance dial, −1..+1. Streams while dragging (cheap atomic
        // store engine-side; not undoable — the effect-param ruling).
        onSetPan: (id, pan) => callNative('setNodePan', id, pan),
        // Volume fader dial, 0..1 (unity default). Same streaming/
        // non-undoable contract as pan.
        onSetGain: (id, gain) => callNative('setNodeGain', id, gain),
        // Period-source knob (Q5): 'own' = loop, 'context' = one-shot.
        onSetPeriodSource: (id, source) => {
            callNative('setPeriodSource', id, source);
            setLogLine(source === 'context'
                ? 'One-shot: sounds once per cycle (⌘Z to undo)'
                : 'Looping again (⌘Z to undo)');
        },
        onToggleFx,
        // THE SEQUENCER (docs/sequencer.md §9): grid-open is pure view
        // state (the fxOpen pattern); the sequence itself is a musical
        // fact — one setSequence per finished gesture, undoable.
        onToggleSeqGrid: id => {
            if (seqOpen.has(id)) seqOpen.delete(id);
            else seqOpen.add(id);
        },
        // A song on the ROOT carries the seated frame zero: the root
        // anchors there (docs/frame.md §4), so authoring moves nothing.
        onSetSequence: (id, payload) =>
            call('setSequence',
                payload && id === lastRootId && lastFrame
                    ? [id, payload, lastFrame.zero] : [id, payload],
                payload ? 'sequence updated (⌘Z to undo)'
                        : 'sequence cleared (⌘Z to undo)'),
        onToggleSequenceBypass: id =>
            call('toggleSequence', [id],
                'sequence toggled (⌘Z to undo)'),
        // THE STEP AUDITION (docs/sequencer.md §11.2): loop one step
        // (−1 = stop). A monitoring gesture — not undoable, so it goes
        // straight to the bridge. Remember the looping owner so Esc
        // can drop it without a VM lookup.
        onAuditionStep: (id, step) => {
            auditionOwner = step >= 0 ? id : null;
            callNative('auditionStep', id, step);
            setLogLine(step >= 0
                ? 'looping step ' + (step + 1) + ' — R records into it · Esc stops'
                : 'loop released — the song resumes whole');
        },
        onEscapeAudition: () => {
            if (auditionOwner == null) return;
            const id = auditionOwner;
            auditionOwner = null;
            callNative('auditionStep', id, -1);
            setLogLine('loop released — the song resumes whole');
        },
        onSetSlotEnabled: (id, slotUuid, enabled, label) =>
            call('setSlotEnabled', [id, slotUuid, enabled],
                `${label || 'fx'} ${enabled ? 'on' : 'off'}`),
        onSetSlotParam: (id, slotUuid, key, value) =>
            callNative('setSlotParam', id, slotUuid, key, value),
        // VST3 slots (docs/vst3.md phase 3). Add is async on the
        // backend — the chip appears when the chain publishes it.
        onAddPlugin: (id, pluginUid, name) =>
            call('addPluginToChain', [id, pluginUid, -1],
                `adding ${name}…`),
        onRemoveChainSlot: (id, slotUuid, name) =>
            call('removeChainSlot', [id, slotUuid],
                `${name || 'plugin'} removed (⌘Z to undo)`),
        onOpenPluginEditor: (id, slotUuid) =>
            callNative('openPluginEditor', id, slotUuid),
        // Takes (docs/takes.md §3): selection, deletion and the comp
        // are musical facts — undoable engine-side, refused mid-take.
        // The take list's rows draw from the per-take peak cache.
        getTakePeaks: fetchTakePeaks,
        onSelectTake: (id, index) =>
            call('selectTake', [id, index],
                `Take ${index + 1} sounds (⌘Z to undo)`),
        onDeleteTake: (id, index) =>
            call('deleteTake', [id, index],
                `Take ${index + 1} removed (⌘Z to undo)`),
        onSetComp: (id, cells) =>
            call('setComp', [id, cells],
                cells.length ? 'Comp updated (⌘Z to undo)'
                             : 'Comp cleared — the active take throughout (⌘Z to undo)'),
        onCompMode,
        // Audio file import (docs/import.md): the + menu's chooser
        // (into a group, or the root) and the lane drop.
        onImportAudio: (groupId, q) => importWithDialog(groupId, q),
        onImportDrop,
        onArm,
        onRecordKey,
    });
    wireStatusStrip();
    // The ROOT sequencer chip (docs/sequencer.md): the session's song.
    // The root has no rail, so its grid toggles from the transport.
    {
        const rsb = document.getElementById('root-seq-btn');
        if (rsb) {
            rsb.addEventListener('click', () => {
                if (!lastRootId) return;
                if (seqOpen.has(lastRootId)) seqOpen.delete(lastRootId);
                else seqOpen.add(lastRootId);
            });
        }
    }
    // Master fader → the island root's output-stage gain (stacks apply
    // gain·pan at their output, so the root's fader IS the master).
    initMasterFader(v => { if (lastRootId) callNative('setNodeGain', lastRootId, v); });
    initMasterMeters();  // a click on a meter face releases its clip latch
    // The MASTER FX chip (B5): the root's rack opens as the same fx row
    // a group rail's chip opens — one click to a master reverb/limiter.
    {
        const mfx = document.getElementById('master-fx-btn');
        if (mfx) {
            mfx.addEventListener('click', () => {
                if (lastRootId) onToggleFx(lastRootId);
            });
        }
    }
    wireKeyboard();
    initProjectUI();
    startPolling();
}

try {
    console.log('Calling initApp()...');
    initApp();
    console.log('App Initialized. Hiding overlay.');
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
} catch (err) {
    console.error('Critical Init Error:', err);
    const status = document.getElementById('loading-status');
    if (status) status.innerHTML = `<span style="color:#ef4444">Init Failed: ${err.message}</span>`;
}
