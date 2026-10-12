/**
 * The PREFERENCES panel (session_view.md §2): the one surface for the
 * persisted, per-machine choices —
 *   - the audio device (audio_settings.js renders its pickers into
 *     #audio-device-host);
 *   - latency calibration (docs/performance.md §7), keyed on
 *     device | rate | buffer, so it sits beside what changes all three;
 *   - the projects root (docs/projects.md): the base folder of the
 *     projects and the track-template library.
 *
 * The panel is static markup toggled by the transport's gear, a popover
 * (popover.js). Everything DOM-bound happens inside initPreferences and
 * the poll hook, so the pure helpers import under node.
 */

import { wirePopover } from './popover.js';
import { initAudioSettings, renderAudioDevice } from './audio_settings.js';
import { FALLBACK_SAMPLE_RATE } from './sample_rate.js';
import { setText } from './session_view/sv_util.js';

// After a calibration starts, its result is asked for this many times,
// this far apart (a 10 s ceiling).
const CALIBRATION_POLL_TRIES = 40;
const CALIBRATION_POLL_MS = 250;

/** The Calibrate button's label for the engine's published `perf`:
 * the compensation in force once calibrated. */
export function calibrateLabel(perf) {
    if (!perf.calibrated) return '🎯 Calibrate';
    const sr = perf.sampleRate || FALLBACK_SAMPLE_RATE;
    const ms = (perf.latencyCompensationSamples / sr) * 1000;
    return `🎯 Recalibrate (${ms.toFixed(1)} ms)`;
}

/** The status line for a finished calibration (getLatencyCalibration's
 * last answer; null when none came). */
export function calibrationVerdict(result) {
    return result && result.calibrated
        ? `Latency: ${result.roundTripSamples} samples (${result.roundTripMs.toFixed(1)} ms)`
        : 'Calibration failed — no loopback signal. Route output to input and retry.';
}

/** What the status under Calibrate says while a measurement runs, by
 * startLatencyCalibration's answer: started, refused (a run is already
 * capturing — it is left to finish, and its result is waited for), or
 * lost (null: nothing runs). */
export function calibrationStartLine(started) {
    if (started === null) return null;
    return started ? 'Calibrating… (keep quiet, click incoming)'
                   : 'A calibration is already running — waiting for its result';
}

/** The projects-root line: the path getProjectInfo's record publishes,
 * or the placeholder when the read was lost. */
export function rootDisplay(info) {
    const root = info && typeof info.projectsRoot === 'string'
        ? info.projectsRoot.trim() : '';
    return root || '— not set —';
}

let panel = null;
let callNative = null;
let onLog = () => { };

const isOpen = () => !!panel && panel.classList.contains('open');

/** Wires the gear, the panel and its controls. `log` writes the status
 * line. */
export function initPreferences(callNativeFn, log) {
    callNative = callNativeFn;
    if (log) onLog = log;
    const button = document.getElementById('prefs-btn');
    panel = document.getElementById('prefs-panel');
    if (!button || !panel) return;

    initAudioSettings(callNative, onLog);
    wireCalibration();
    wirePopover({
        button, isOpen, open,
        close: () => panel.classList.remove('open'),
        holds: target => panel.contains(target),
    });

    const change = document.getElementById('projects-root-change');
    if (change) {
        change.addEventListener('click', async () => {
            // The chooser answers when the user closes it: the chosen
            // path, "" when cancelled, null when the call was lost.
            change.disabled = true;
            const chosen = await callNative('chooseProjectsRoot');
            change.disabled = false;
            onLog(chosen ? `Projects folder → ${chosen}`
                         : 'Projects folder unchanged');
            await refreshProjectsRoot();
        });
    }
}

/** The Calibrate button: start the measurement, wait for its result,
 * say how it went. Disabled while it runs. */
function wireCalibration() {
    const button = document.getElementById('calibrate-btn');
    const status = document.getElementById('calibration-status');
    if (!button || !status) return;
    button.addEventListener('click', async () => {
        try {
            button.disabled = true;
            status.textContent = 'Starting…';
            const line = calibrationStartLine(
                await callNative('startLatencyCalibration'));
            if (line === null) {
                status.textContent = 'Calibration not started — the engine did not answer';
                return;
            }
            status.textContent = line;
            let result = null;
            for (let i = 0; i < CALIBRATION_POLL_TRIES; i++) {
                await new Promise(r => setTimeout(r, CALIBRATION_POLL_MS));
                result = await callNative('getLatencyCalibration');
                if (result && result.phase !== 'capturing') break;
            }
            status.textContent = calibrationVerdict(result);
        } catch (err) {
            status.textContent = 'Calibration error: ' + err.message;
        } finally {
            button.disabled = false;
        }
    });
}

/** Poll hook: the Calibrate button's label follows the engine's
 * calibration (`state.perf`). A guarded write — the button is
 * clickable, and a label rewritten under a press loses the click
 * (session_view.md, the patch law). Left alone while a measurement
 * runs. */
export function patchCalibrateButton(perf) {
    const button = document.getElementById('calibrate-btn');
    if (button && !button.disabled && perf) setText(button, calibrateLabel(perf));
}

/** Open the panel: the projects root and the device pickers are read
 * fresh every time (nothing is patched locally). */
function open() {
    panel.classList.add('open');
    refreshProjectsRoot();
    const host = document.getElementById('audio-device-host');
    if (host) renderAudioDevice(host);
}

/** Read getProjectInfo and paint the projects-root line (the
 * placeholder when the info is lost or unreadable). */
async function refreshProjectsRoot() {
    const line = document.getElementById('projects-root');
    if (!line) return;
    const info = await callNative('getProjectInfo');
    line.textContent = rootDisplay(info);
    line.title = info && info.trackTemplatesRoot
        ? `Track templates: ${info.trackTemplatesRoot}` : '';
}
