// Celestrian app shell (docs/ui_overhaul.md): backend poll → pure view
// model → thin DOM patch. Backend selection lives in backend.js (P2-9);
// all timeline math lives in view_model.js / timeline_model.js; all DOM
// lives in session_view.js. This file is glue: polling, waveform peak
// fetching, and the bridge-call callbacks.

import { callNative, log, getState } from './backend.js';
import { deriveViewModel } from './view_model.js';
import { initSessionView, patchSessionView, mapDragPinQ, mapDragPinFoldQ }
    from './session_view.js';
import { appendLivePeak } from './live_peaks.js';
import { initAudioSettings } from './audio_settings.js';
import { updateMasterVU, initMasterFader, updateMasterFader }
    from './vu_meter.js';

const DEBUG = new URLSearchParams(window.location.search).get('debug') === 'true';
const dbg = m => { if (DEBUG) log(m); };

/* ---------- tuning constants ---------- */
const POLL_MS = 50;                 // graph-state poll cadence
const PROJECT_POLL_MS = 2000;       // project birth/rename follow the mirror
const PEAK_COUNT = 800;             // waveform peaks requested per clip
const RECENTS_CAP = 6;              // recent projects shown in the menu
const CALIBRATION_POLL_TRIES = 40;  // latency calibration: poll attempts…
const CALIBRATION_POLL_MS = 250;    // …every this many ms (10 s ceiling)

const livePeaks = new Map();        // clip id → peak array
const peakDurations = new Map();    // clip id → duration the peaks were fetched at
const fxOpen = new Set();           // lane ids with the effects panel expanded (view state)
const windowEdit = new Set();       // lanes expanded into the window editor

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

/* ---------- waveform peaks ---------- */
const peakFetches = new Map(); // clip id → in-flight fetch promise
async function fetchWaveform(id, duration) {
    // Per-id in-flight guard: concurrent fetches for DIFFERENT clips may
    // proceed; a second request for the same clip while one is in flight
    // is dropped (the poll loop retries next tick if the duration moved).
    if (peakFetches.has(id)) return;
    const p = (async () => {
        try {
            const peaks = await callNative('getWaveform', id, PEAK_COUNT);
            if (peaks && peaks.length > 0) {
                livePeaks.set(id, peaks);
                peakDurations.set(id, duration);
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

const LIVE = -1; // peakDurations marker: array holds live recording peaks

/**
 * Fetch peaks for committed clips whose content we don't have yet; for
 * RECORDING clips, accumulate the engine's currentPeak TIME-INDEXED
 * (live_peaks.js): a peak's slot derives from `duration` at capture, so
 * the drawn waveform is anchored to its position regardless of poll
 * cadence (per-poll pushing made content drift sideways — field report).
 */
function refreshPeaks(nodes, sampleRate) {
    (nodes || []).forEach(n => {
        if (n.type === 'stack') return refreshPeaks(n.nodes, sampleRate);
        if (n.type !== 'clip') return;
        if (n.isRecording) {
            let arr = livePeaks.get(n.id);
            if (!arr || peakDurations.get(n.id) !== LIVE) {
                arr = []; // fresh take: drop stale committed peaks
                livePeaks.set(n.id, arr);
                peakDurations.set(n.id, LIVE);
            }
            if (n.duration > 0) {
                appendLivePeak(arr, n.duration, sampleRate, n.currentPeak || 0);
            }
            return;
        }
        if (!(n.duration > 0)) return;
        if (!livePeaks.has(n.id) || peakDurations.get(n.id) !== n.duration) {
            fetchWaveform(n.id, n.duration); // also replaces live arrays on commit
        }
    });
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

/* ---------- record & arm (Q7: arm targets emptiness) ---------- */
function clipsUnder(node, out = []) {
    if (node.type === 'clip') out.push(node);
    (node.nodes || []).forEach(c => clipsUnder(c, out));
    return out;
}
const isArmableClip = c => c.isRecording || c.isPendingStart || !(c.duration > 0);
const isHotClip = c => c.isRecording || c.isPendingStart;

/** Arm = startRecordingInNode: the ENGINE owns the Q-boundary wait (Q11). */
async function armClips(clips) {
    for (const c of clips) await callNative('startRecordingInNode', c.id);
}
async function stopClips(clips) {
    for (const c of clips) await callNative('stopRecordingInNode', c.id);
}

/* PER-TRACK RECORD (owner ruling 2026-07-19h): there is NO global
 * record button — the track's ● is the record verb, which keeps the
 * core journey direct: song looping → ＋ Track → hit its ● → recording
 * at the next Q boundary. A group's ● records all its empty tracks
 * (the drum-mic case); a recording track's ● stops it. */
/**
 * The lane record button: if anything under the lane is hot
 * (recording/pending), stop it all; otherwise arm every armable clip
 * beneath it (empty tracks record, full ones just play).
 */
async function onArm(lane) {
    const node = lastNodesById.get(lane.id);
    if (!node) return;
    const clips = clipsUnder(node);
    const hot = clips.filter(isHotClip);
    if (hot.length > 0) {
        await stopClips(hot);
        setLogLine('Stopped recording');
        return;
    }
    const targets = clips.filter(isArmableClip);
    if (targets.length === 0) return;
    await armClips(targets);
    setLogLine(targets.length > 1
        ? `Recording ${targets.length} empty tracks (full ones just play)`
        : 'Recording');
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

/* Drag-to-group (2026-07-19h/j): clip target → combine into a
 * new group; group target → move inside. A multi-drag (selected
 * rails) applies to every dragged track. */
/**
 * Sequencing: the first drop onto a CLIP target calls combineNodes
 * (which creates the group); every further id is reorderNode'd into
 * that group, appended in drag order. The graph is fetched ONCE, after
 * the group exists, to seed the append cursor — each insert then
 * advances it locally (a per-id refetch was an N+1).
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

// Law 13 amendment: expand/collapse a lane's window editor.
function onWindowEdit(id, open) {
    if (id === null) { windowEdit.clear(); return; }
    if (open) windowEdit.add(id); else windowEdit.delete(id);
}

// Move the OS cursor (viewport CSS px). True when the backend
// actually warped; the mock returns false and the drag keeps
// its eased-capture fallback.
async function onWarpPointer(x, y) {
    try { return (await callNative('warpPointer', x, y)) === true; }
    catch (_) { return false; }
}

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

    // Audio device picker. Calibration is keyed on device|rate|buffer, so
    // it sits right next to the button that changes all three.
    initAudioSettings(callNative, setLogLine);
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
                refreshPeaks(state.nodes, (state.perf && state.perf.sampleRate) || 44100);
                lastNodesById = indexNodes(state.nodes);
                lastRootId = state.id || '';
                // Committed clips whose real waveform hasn't landed yet:
                // composites must not blend their live meter peaks
                const pendingFetch = new Set();
                for (const n of lastNodesById.values()) {
                    if (n.type === 'clip' && !n.isRecording && n.duration > 0 &&
                        peakDurations.get(n.id) !== n.duration) {
                        pendingFetch.add(n.id);
                    }
                }
                const vm = deriveViewModel(state,
                    { fxOpen, windowEdit, pinFrameQ: mapDragPinQ(),
                      pinFoldQ: mapDragPinFoldQ() });
                patchSessionView(vm, {
                    livePeaks,
                    pendingFetch,
                    nodesById: lastNodesById,
                    vmQuantum: vm.quantum,
                    // Composite offsets are cycle projections of origin —
                    // computed in the island-epoch frame (one-frame rule)
                    epochSamples: vm.epochSamples,
                    sampleRate: state.perf ? state.perf.sampleRate : 0,
                });
                patchCalibrateButton(state);
                // Master monitor: engine-side smoothed output RMS →
                // needle sweep (vu_meter.js; CSS transition interpolates
                // between polls). The fader mirrors the root's gain.
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
                        monitor.title = 'Master output — L ' + db(state.masterVuL)
                            + ' dB · R ' + db(state.masterVuR) + ' dB (raw L='
                            + state.masterVuL + ')';
                    }
                }
                updateMasterVU(Number(state.masterVuL) || 0,
                               Number(state.masterVuR) || 0);
                updateMasterFader(state.gain);
            }
        } catch (err) {
            console.error('Polling error:', err);
        }
        await new Promise(r => setTimeout(r, POLL_MS));
    }
}

/* ---------- init ---------- */
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
        const wasBorn = projectInfo.born;
        projectInfo = info;
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

    sep();
    head('Save as template');
    inlineRow('e.g. My Rig', '', 'Save', name =>
        call('saveAsTemplate', [name],
            `Template "${name}" saved — it loads automatically next launch`,
            'Template save failed'));

    callNative('listTemplates').then(raw => {
        const templates = parseMaybeJson(raw);
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
        const recents = parseMaybeJson(raw);
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

/** True when a key event targets a text-entry surface — the global
 *  shortcuts (Space, ⌘Z, ⌘S, …) must not fire while typing. */
function isTypingTarget(t) {
    return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' || t.isContentEditable;
}

function wireKeyboard() {
    window.addEventListener('keydown', e => {
        if (isTypingTarget(e.target)) return;
        if (e.code === 'Space') {
            e.preventDefault();
            callNative('togglePlayback');
            return;
        }
        // Undo / redo (edits-as-events, §2.2 Step 1). Cmd/Ctrl+Z undoes;
        // Cmd/Ctrl+Shift+Z (or Ctrl+Y) redoes. The next poll refreshes
        // the view from the restored graph.
        if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            if (e.shiftKey) {
                callNative('redo');
                setLogLine('Redo');
            } else {
                callNative('undo');
                setLogLine('Undo');
            }
            return;
        }
        if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
            e.preventDefault();
            callNative('redo');
            setLogLine('Redo');
            return;
        }
        // ⌘S = checkpoint the PROJECT (docs/projects.md): the mirror
        // already saves continuously; an explicit save births an unborn
        // project (intent enough) and stamps the folder now.
        if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            callNative('saveProjectNow').then(() => refreshProjectInfo(true));
            return;
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === 'o' || e.key === 'O')) {
            e.preventDefault();
            call('loadSession', [''], 'Session loaded', 'Load cancelled');
        }
    });
}

function initApp() {
    initSessionView({
        onTogglePlay: () => callNative('togglePlayback'),
        onFold: id => callNative('toggleStackExpand', id),
        onMute: id => callNative('toggleMute', id),
        onSolo: id => callNative('toggleSolo', id),
        onAddTrack: () => callNative('createNode', 'clip', ''),
        onWindowEdit,
        onDropLane,
        onGroupSelection,
        onMoveToTop,
        onUngroup,
        onAddClip: groupId => callNative('createNode', 'clip', groupId),
        // No confirm: undo is the safety net (edits-as-events).
        onDelete: id => call('deleteNode', [id], 'Deleted — ⌘Z to undo'),
        onRename: (id, name) =>
            call('renameNode', [id, name], `Renamed to "${name}"`),
        // Loop windows (time_maps.md): the region is data (setLoopPoints),
        // activation is a toggle between active and bypassed
        onSetWindow: (id, startSamples, endSamples) =>
            call('setLoopPoints', [id, startSamples, endSamples], 'Loop window set'),
        onToggleWindow: id => callNative('toggleLoopWindow', id),
        // Multi-segment maps (phase 3, the sequencer): one commit per
        // editor gesture — flat [s0,e0,...] in samples.
        onSetSegments: (id, flatSegments) =>
            call('setSegments', [id, flatSegments], 'Map updated'),
        onWarpPointer,
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
        onSetEffectEnabled: (id, fx, enabled) =>
            call('setEffectEnabled', [id, fx, enabled],
                `${fx} ${enabled ? 'on' : 'off'}`),
        onSetEffectParam: (id, fx, param, value) =>
            callNative('setEffectParam', id, fx, param, value),
        onArm,
    });
    wireStatusStrip();
    // Master fader → the island root's output-stage gain (stacks apply
    // gain·pan at their output, so the root's fader IS the master).
    initMasterFader(v => { if (lastRootId) callNative('setNodeGain', lastRootId, v); });
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
