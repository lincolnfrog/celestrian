/**
 * The PREFERENCES panel (tasks.md B8): the ONE surface for the
 * persisted, per-machine choices —
 *   - the audio device (audio_settings.js renders its dependency-
 *     chained pickers into #audio-device-host);
 *   - latency calibration (#calibrate-btn / #calibration-status live
 *     in the panel's markup; app.js wires the measurement);
 *   - the projects root (docs/projects.md): the base folder the
 *     projects and the track-template library live under, read from
 *     getProjectInfo (`projectsRoot`); "Change…" picks it natively
 *     (chooseProjectsRoot answers the new path, "" when cancelled).
 *
 * The panel is static markup in index.html / index_test.html (kept in
 * lockstep) toggled by the transport's gear (#prefs-btn), a dropdown
 * like #project-menu. PANEL-scope Escape (keys.js) and an outside
 * click close it. Everything DOM-bound happens inside initPreferences,
 * so the pure helpers import cleanly under node.
 */

import { registerKey, SCOPE, ANY_MODIFIERS } from './keys.js';
import { initAudioSettings, renderAudioDevice } from './audio_settings.js';

/** The projects-root line: the path the info publishes, or the
 * pre-engine placeholder. */
export function rootDisplay(info) {
    const root = info && typeof info.projectsRoot === 'string'
        ? info.projectsRoot.trim() : '';
    return root || '— not set —';
}

/** getProjectInfo answers JSON text (the bridge) or an object (a
 * harness); either way an object, null when unreadable. */
export function parseProjectInfo(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string' || !raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

let panel = null;
let btn = null;
let callNative = null;
let onLog = () => { };

/** Whether the panel is open (the Escape binding's `when`). */
export function isPreferencesOpen() {
    return !!panel && panel.classList.contains('open');
}

/** Wires the gear and the panel. `log` writes to the status line. */
export function initPreferences(callNativeFn, log) {
    callNative = callNativeFn;
    if (log) onLog = log;
    btn = document.getElementById('prefs-btn');
    panel = document.getElementById('prefs-panel');
    if (!btn || !panel) return;

    initAudioSettings(callNative, onLog);

    btn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (isPreferencesOpen()) closePreferences();
        else openPreferences();
    });
    // Close on outside click / Escape, like the project menu. The
    // panel scope wins Escape while open (keys.js), so the session
    // view's Escape does not also clear the selection.
    document.addEventListener('click', e => {
        if (!isPreferencesOpen()) return;
        if (panel.contains(e.target) || e.target === btn) return;
        closePreferences();
    });
    registerKey({ key: 'Escape', scope: SCOPE.PANEL, ignore: ANY_MODIFIERS,
                  whileTyping: true, when: isPreferencesOpen,
                  handler: closePreferences });

    const change = document.getElementById('projects-root-change');
    if (change) {
        change.addEventListener('click', async () => {
            change.disabled = true;
            try {
                const chosen = await callNative('chooseProjectsRoot');
                if (chosen) {
                    onLog(`Projects folder → ${chosen}`);
                } else {
                    onLog('Projects folder unchanged');
                }
            } catch (err) {
                onLog('Projects folder error: ' + err.message);
            } finally {
                change.disabled = false;
            }
            await refreshProjectsRoot();
        });
    }
}

export function closePreferences() {
    if (panel) panel.classList.remove('open');
}

/** Open the panel: the projects root and the device pickers read
 * fresh from the bridge every time (nothing is patched locally). */
export function openPreferences() {
    if (!panel) return;
    panel.classList.add('open');
    refreshProjectsRoot();
    const host = document.getElementById('audio-device-host');
    if (host) renderAudioDevice(host);
}

/** Read getProjectInfo and paint the projects-root line. */
async function refreshProjectsRoot() {
    const line = document.getElementById('projects-root');
    if (!line) return;
    try {
        const info = parseProjectInfo(await callNative('getProjectInfo'));
        line.textContent = rootDisplay(info);
        line.title = info && info.trackTemplatesRoot
            ? `Track templates: ${info.trackTemplatesRoot}` : '';
    } catch (_) {
        line.textContent = rootDisplay(null);
    }
}
