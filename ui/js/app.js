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

const DEBUG = new URLSearchParams(window.location.search).get('debug') === 'true';
const dbg = m => { if (DEBUG) log(m); };

const livePeaks = new Map();        // clip id → peak array
const peakDurations = new Map();    // clip id → duration the peaks were fetched at
const fxOpen = new Set();           // lane ids with the effects panel expanded (view state)
const windowEdit = new Set();       // lanes expanded into the window editor

/* ---------- waveform peaks ---------- */
let fetchInFlight = null;
async function fetchWaveform(id, duration) {
    if (fetchInFlight === id) return;
    fetchInFlight = id;
    try {
        const peaks = await callNative('getWaveform', id, 800);
        if (peaks && peaks.length > 0) {
            livePeaks.set(id, peaks);
            peakDurations.set(id, duration);
            dbg(`Fetched ${peaks.length} peaks for ${id}`);
        }
    } catch (err) {
        console.error('Waveform fetch failed:', err);
    } finally {
        fetchInFlight = null;
    }
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

/* ---------- status strip ---------- */
function setLogLine(msg) {
    const line = document.getElementById('log-line');
    if (line) line.textContent = msg;
}

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
            for (let i = 0; i < 40; i++) {
                await new Promise(r => setTimeout(r, 250));
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
            }
        } catch (err) {
            console.error('Polling error:', err);
        }
        await new Promise(r => setTimeout(r, 50));
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

function refreshProjectInfo(announceSave = false) {
    return callNative('getProjectInfo').then(raw => {
        const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
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
            callNative('renameProject', name).then(() => {
                setLogLine('Project renamed (folder unchanged)');
                refreshProjectInfo();
            }));
    }
    item('Duplicate project (next serial)', () =>
        callNative('duplicateProject').then(id => {
            setLogLine(id ? `Forked to ${id} — the original stays as a checkpoint`
                          : 'Nothing to duplicate yet');
            refreshProjectInfo();
        }), !born);
    item('Open project folder…', () =>
        callNative('loadSession', '').then(ok => {
            setLogLine(ok ? 'Project opened' : 'Open cancelled');
            refreshProjectInfo();
        }));

    sep();
    head('Save as template');
    inlineRow('e.g. My Rig', '', 'Save', name =>
        callNative('saveAsTemplate', name).then(ok =>
            setLogLine(ok ? `Template "${name}" saved — it loads automatically next launch`
                          : 'Template save failed')));

    callNative('listTemplates').then(raw => {
        const templates = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!templates.length) return;
        sep();
        head('New from template');
        templates.forEach(t => item(t.name, () =>
            callNative('newProjectFromTemplate', t.id).then(ok => {
                setLogLine(ok ? `Template "${t.name}" loaded — play the seed`
                              : 'Template failed to load');
                refreshProjectInfo();
            })));
    });
    callNative('listRecentProjects').then(raw => {
        const recents = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!recents.length) return;
        sep();
        head('Recent projects');
        recents.slice(0, 6).forEach(r => item(
            r.name === r.id ? r.id : `${r.name} · ${r.id}`, () =>
            callNative('openProjectPath', r.path).then(ok => {
                setLogLine(ok ? `Opened ${r.name}` : 'Open failed');
                refreshProjectInfo();
            })));
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
    setInterval(refreshProjectInfo, 2000);  // birth/rename follow the mirror
}

export function initApp() {
    initSessionView({
        onTogglePlay: () => callNative('togglePlayback'),
        onFold: id => callNative('toggleStackExpand', id),
        onMute: id => callNative('toggleMute', id),
        onSolo: id => callNative('toggleSolo', id),
        onAddTrack: () => callNative('createNode', 'clip', ''),
        // Law 13 amendment: expand/collapse a lane's window editor.
        onWindowEdit: (id, open) => {
            if (id === null) { windowEdit.clear(); return; }
            if (open) windowEdit.add(id); else windowEdit.delete(id);
        },
        // Drag-to-group (2026-07-19h/j): clip target → combine into a
        // new group; group target → move inside. A multi-drag (selected
        // rails) applies to every dragged track.
        onDropLane: async (ids, target) => {
            const tNode = lastNodesById.get(target.id);
            if (!tNode) return;
            let stackId = tNode.type === 'stack' ? target.id : '';
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
                const parent = await callNative('getGraphState').then(st =>
                    (findStackIn(st.nodes, stackId) || {}));
                await callNative('reorderNode', id, stackId,
                    ((parent.nodes || []).length) || 99);
                grouped++;
            }
            const tName = tNode.name || 'group';
            setLogLine(grouped > 1
                ? `Grouped ${grouped} tracks with "${tName}"`
                : tNode.type === 'stack'
                    ? `Moved into "${tName}"`
                    : `Grouped with "${tName}" — rename the group on its rail`);
        },
        // Floating bar: group the SELECTION in place (no outside target).
        onGroupSelection: async ids => {
            if (ids.length < 2) return;
            // combine(dragged, target): the new stack lands at the
            // TARGET's slot — use the first-selected as the anchor.
            const stackId = await callNative('combineNodes', ids[1], ids[0]);
            for (let i = 2; i < ids.length; i++) {
                await callNative('reorderNode', ids[i], stackId, 99);
            }
            setLogLine(`Grouped ${ids.length} tracks — rename the group on its rail`);
        },
        // Drag-out: back to the top level (the island root).
        onMoveToTop: async ids => {
            if (!lastRootId) return;
            for (const id of ids) {
                await callNative('reorderNode', id, lastRootId, 99);
            }
            setLogLine(ids.length > 1
                ? `Moved ${ids.length} tracks to the top level`
                : 'Moved to the top level');
        },
        // Ungroup: children move up to the group's slot; the shell goes.
        onUngroup: async groupId => {
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
        },
        onAddClip: groupId => callNative('createNode', 'clip', groupId),
        onDelete: async id => {
            // No confirm: undo is the safety net (edits-as-events).
            await callNative('deleteNode', id);
            setLogLine('Deleted — ⌘Z to undo');
        },
        onRename: async (id, name) => {
            await callNative('renameNode', id, name);
            setLogLine(`Renamed to "${name}"`);
        },
        // Loop windows (time_maps.md): the region is data (setLoopPoints),
        // activation is a toggle between active and bypassed
        onSetWindow: async (id, startSamples, endSamples) => {
            await callNative('setLoopPoints', id, startSamples, endSamples);
            setLogLine('Loop window set');
        },
        onToggleWindow: id => callNative('toggleLoopWindow', id),
        // Multi-segment maps (phase 3, the sequencer): one commit per
        // editor gesture — flat [s0,e0,...] in samples.
        onSetSegments: async (id, flatSegments) => {
            await callNative('setSegments', id, flatSegments);
            setLogLine('Map updated');
        },
        // Move the OS cursor (viewport CSS px). True when the backend
        // actually warped; the mock returns false and the drag keeps
        // its eased-capture fallback.
        onWarpPointer: async (x, y) => {
            try { return (await callNative('warpPointer', x, y)) === true; }
            catch (_) { return false; }
        },
        // Recording input (clips only — Q7: each child records from its
        // own input). The list is fetched per menu-open: hot-plugged
        // devices appear without a reload.
        getInputs: async () => {
            try {
                const r = await callNative('getInputList');
                return (r && r.inputs) || [];
            } catch (err) {
                console.error('getInputList failed:', err);
                return [];
            }
        },
        onSetInput: async (id, channelIndex) => {
            await callNative('setNodeInput', id, channelIndex);
            setLogLine(`Input set to channel ${channelIndex + 1}`);
        },
        // Right input of a stereo pair; −1 reverts the clip to mono.
        // The channel count of a take is fixed at arm (engine rule).
        onSetInputRight: async (id, channelIndex) => {
            await callNative('setNodeInputRight', id, channelIndex);
            setLogLine(channelIndex >= 0
                ? `Stereo pair: right = channel ${channelIndex + 1}`
                : 'Track set to mono');
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
        // Built-in effects: panel-open is pure view state; enable and
        // params go straight to the engine's fixed rack
        onToggleFx: id => {
            const open = !fxOpen.has(id);
            if (open) fxOpen.add(id);
            else fxOpen.delete(id);
            // Gate the engine's scope capture: no watcher, no copying
            callNative('setEffectScope', id, open);
        },
        onSetEffectEnabled: async (id, fx, enabled) => {
            await callNative('setEffectEnabled', id, fx, enabled);
            setLogLine(`${fx} ${enabled ? 'on' : 'off'}`);
        },
        onSetEffectParam: (id, fx, param, value) =>
            callNative('setEffectParam', id, fx, param, value),
        onArm,
    });
    wireStatusStrip();

    window.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT') return;
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
            callNative('loadSession', '').then(ok =>
                setLogLine(ok ? 'Session loaded' : 'Load cancelled'));
        }
    });

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
