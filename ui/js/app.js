// Celestrian app shell (docs/ui_overhaul.md): backend poll → pure view
// model → thin DOM patch. Backend selection lives in backend.js (P2-9);
// all timeline math lives in view_model.js / timeline_model.js; all DOM
// lives in session_view.js. This file is glue: polling, waveform peak
// fetching, and the bridge-call callbacks.

import { callNative, log, getState } from './backend.js';
import { deriveViewModel } from './view_model.js';
import { initSessionView, patchSessionView } from './session_view.js';
import { appendLivePeak } from './live_peaks.js';

const DEBUG = new URLSearchParams(window.location.search).get('debug') === 'true';
const dbg = m => { if (DEBUG) log(m); };

const livePeaks = new Map();        // clip id → peak array
const peakDurations = new Map();    // clip id → duration the peaks were fetched at
const fxOpen = new Set();           // lane ids with the effects panel expanded (view state)

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

async function onArm(lane) {
    const node = lastNodesById.get(lane.id);
    if (!node) return;
    const clips = clipsUnder(node);
    const hot = clips.filter(isHotClip);
    if (hot.length > 0) {
        await stopClips(hot);
        setLogLine('Stopped recording');
    } else {
        const targets = clips.filter(isArmableClip);
        if (targets.length === 0) return;
        await armClips(targets);
        setLogLine(targets.length > 1
            ? `Recording ${targets.length} empty tracks (full ones just play)`
            : 'Recording');
    }
}

/** Global ●: island-wide group record; creates a track when none is empty. */
async function onRecord() {
    const roots = [...lastNodesById.values()].filter(n => !findParentIn(n));
    const clips = [];
    roots.forEach(r => clipsUnder(r, clips));

    const hot = clips.filter(isHotClip);
    if (hot.length > 0) {
        await stopClips(hot);
        setLogLine('Stopped recording');
        return;
    }
    const targets = clips.filter(isArmableClip);
    if (targets.length > 0) {
        await armClips(targets);
        setLogLine(targets.length > 1
            ? `Recording ${targets.length} empty tracks (full ones just play)`
            : 'Recording');
        return;
    }
    // Nothing armable anywhere: record into a fresh track
    let parentId = roots.find(n => n.type === 'stack')?.id;
    if (!parentId) parentId = await callNative('createNode', 'stack', '');
    const clipId = await callNative('createNode', 'clip', parentId || '');
    if (clipId) {
        await callNative('startRecordingInNode', clipId);
        setLogLine('Recording into a new track');
    } else {
        // Bridge returned no id (older backend): the track exists, arm it
        // from its rail — surface that instead of failing silently.
        setLogLine('New track created — hit its ● to record');
    }
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
                // Committed clips whose real waveform hasn't landed yet:
                // composites must not blend their live meter peaks
                const pendingFetch = new Set();
                for (const n of lastNodesById.values()) {
                    if (n.type === 'clip' && !n.isRecording && n.duration > 0 &&
                        peakDurations.get(n.id) !== n.duration) {
                        pendingFetch.add(n.id);
                    }
                }
                const vm = deriveViewModel(state, { fxOpen });
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
        const el = document.getElementById('project-name');
        if (el && !el._editing) {
            el.textContent = info.born ? info.name : '';
            el.title = info.born
                ? `${info.id} — click to rename (the folder never moves)`
                : '';
        }
        if (!wasBorn && info.born) {
            setLogLine(`Project ${info.id} created — mirroring to disk`);
            renderEmptyProjects();  // a born project joins the recents
        } else if (announceSave && info.born) {
            setLogLine(`Saved ${info.name}`);
        }
    }).catch(() => {});
}

function renameProjectInline() {
    const el = document.getElementById('project-name');
    if (!el || !projectInfo.born || el._editing) return;
    el._editing = true;
    const input = document.createElement('input');
    input.value = projectInfo.name;
    input.className = 'mono';
    input.style.cssText =
        'background:none;border:1px solid var(--line);border-radius:6px;' +
        'color:var(--text);font-size:0.8rem;padding:2px 6px;width:14ch;';
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
    const done = commit => {
        el._editing = false;
        input.remove();
        if (commit && input.value.trim()) {
            callNative('renameProject', input.value.trim())
                .then(() => refreshProjectInfo())
                .then(() => setLogLine('Project renamed (folder unchanged)'));
        } else {
            refreshProjectInfo();
        }
    };
    input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') done(true);
        if (ev.key === 'Escape') done(false);
        ev.stopPropagation();
    });
    input.addEventListener('blur', () => done(true));
}

function renderEmptyProjects() {
    const host = document.getElementById('empty-projects');
    if (!host) return;
    Promise.all([
        callNative('listTemplates'),
        callNative('listRecentProjects'),
    ]).then(([tRaw, rRaw]) => {
        const templates = typeof tRaw === 'string' ? JSON.parse(tRaw) : tRaw;
        const recents = typeof rRaw === 'string' ? JSON.parse(rRaw) : rRaw;
        host.textContent = '';
        const row = (label, items, onPick) => {
            if (!items || !items.length) return;
            const div = document.createElement('div');
            div.className = 'proj-row';
            const span = document.createElement('span');
            span.className = 'proj-label';
            span.textContent = label;
            div.appendChild(span);
            items.forEach(item => {
                const b = document.createElement('button');
                b.textContent = item.name;
                if (item.id !== item.name) b.title = item.id;
                b.addEventListener('click', () => onPick(item));
                div.appendChild(b);
            });
            host.appendChild(div);
        };
        row('Start from template', templates, t =>
            callNative('newProjectFromTemplate', t.id).then(ok => {
                setLogLine(ok ? `Template "${t.name}" loaded — play the seed`
                              : 'Template failed to load');
                refreshProjectInfo();
            }));
        row('Recent projects', recents.slice(0, 6), r =>
            callNative('openProjectPath', r.path).then(ok => {
                setLogLine(ok ? `Opened ${r.name}` : 'Open failed');
                refreshProjectInfo();
            }));
        if (!templates.length) {
            // First run: point at the ritual — build the rig once, save
            // it as a template, and every session after starts wired.
            const hint = document.createElement('div');
            hint.className = 'proj-row';
            hint.style.opacity = '0.6';
            hint.textContent =
                'First time? Build your rig (+ New Stack, name tracks, set ' +
                'inputs), then Project ▾ → Save as template.';
            host.appendChild(hint);
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

    const born = projectInfo.born;
    item(born ? `Save now (${projectInfo.name})` : 'Save now — creates today’s project',
        () => callNative('saveProjectNow').then(() => refreshProjectInfo(true)));
    item('Rename project…', renameProjectInline, !born);
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
    const row = document.createElement('div');
    row.className = 'pm-inline';
    const input = document.createElement('input');
    input.placeholder = 'e.g. My Rig';
    const go = document.createElement('button');
    go.textContent = 'Save';
    go.addEventListener('click', () => {
        const name = input.value.trim();
        if (!name) return;
        callNative('saveAsTemplate', name).then(ok => {
            setLogLine(ok ? `Template "${name}" saved (structure + inputs, no audio)`
                          : 'Template save failed');
            close();
            renderEmptyProjects();
        });
    });
    input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') go.click();
        ev.stopPropagation();
    });
    row.append(input, go);
    menu.appendChild(row);

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
    const el = document.getElementById('project-name');
    if (el) el.addEventListener('click', renameProjectInline);
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
    renderEmptyProjects();
    refreshProjectInfo();
    setInterval(refreshProjectInfo, 2000);  // birth/rename follow the mirror
}

export function initApp() {
    initSessionView({
        onTogglePlay: () => callNative('togglePlayback'),
        onFold: id => callNative('toggleStackExpand', id),
        onMute: id => callNative('toggleMute', id),
        onSolo: id => callNative('toggleSolo', id),
        onAddStack: () => callNative('createNode', 'stack', ''),
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
        onRecord,
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
