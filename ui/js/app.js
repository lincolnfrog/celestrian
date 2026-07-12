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
                const vm = deriveViewModel(state);
                patchSessionView(vm, {
                    livePeaks,
                    pendingFetch,
                    nodesById: lastNodesById,
                    vmQuantum: vm.quantum,
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
export function initApp() {
    initSessionView({
        onTogglePlay: () => callNative('togglePlayback'),
        onFold: id => callNative('toggleStackExpand', id),
        onMute: id => callNative('toggleMute', id),
        onSolo: id => callNative('toggleSolo', id),
        onAddStack: () => callNative('createNode', 'stack', ''),
        onAddClip: groupId => callNative('createNode', 'clip', groupId),
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
        onArm,
        onRecord,
    });
    wireStatusStrip();

    window.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT') return;
        if (e.code === 'Space') {
            e.preventDefault();
            callNative('togglePlayback');
        }
    });

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
