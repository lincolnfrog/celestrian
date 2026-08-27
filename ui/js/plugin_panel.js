/**
 * Plugin registry panel (docs/vst3.md phase 1).
 *
 * A status-strip popover, structurally the audio_settings.js twin (it
 * reuses the .audio-panel styles): lists the known VST3 plugins and
 * drives a rescan. Scanning runs on a backend background thread; while
 * it runs this panel polls getPluginScanStatus and re-fetches the list
 * on completion. Chain integration (adding a plugin to a node) arrives
 * in phases 2-3 — this panel is the registry view only.
 */

let panel = null;
let callNative = null;
let onLog = () => { };
let pollTimer = null;

/** Wires the status-strip button. `log` writes to the status line. */
export function initPluginPanel(callNativeFn, log) {
    callNative = callNativeFn;
    if (log) onLog = log;

    const btn = document.getElementById('plugins-btn');
    if (!btn) return;
    btn.addEventListener('click', () => togglePanel());

    // Close on outside click / Escape, like the device panel.
    document.addEventListener('click', (e) => {
        if (!panel) return;
        if (panel.contains(e.target) || e.target === btn) return;
        closePanel();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel) closePanel();
    });
}

function closePanel() {
    stopPolling();
    if (panel) { panel.remove(); panel = null; }
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function togglePanel() {
    if (panel) { closePanel(); return; }
    panel = document.createElement('div');
    panel.className = 'audio-panel open';
    panel.innerHTML = '<div class="ap-head">Plugins</div>' +
        '<div class="ap-note">loading…</div>';
    document.getElementById('status-strip').appendChild(panel);
    await render();
}

async function fetchPlugins() {
    try {
        return await callNative('getKnownPlugins') || [];
    } catch (err) {
        onLog('plugin list failed: ' + err.message);
        return [];
    }
}

async function render() {
    if (!panel) return;
    const plugins = await fetchPlugins();
    if (!panel) return;  // closed while awaiting

    const rows = plugins.map(p =>
        `<div class="ap-row plugin-row" title="${escapeHtml(p.file)}">` +
        `<span>${p.isInstrument ? '🎹' : '🎚'}</span>` +
        `<b>${escapeHtml(p.name)}</b>` +
        `<span>${escapeHtml(p.maker)} · ${escapeHtml(p.version)}</span>` +
        '</div>').join('');

    panel.innerHTML =
        '<div class="ap-head">Plugins</div>' +
        (plugins.length
            ? rows
            : '<div class="ap-note">No plugins known yet — scan to find ' +
              'the VST3 plugins installed on this machine.</div>') +
        '<div class="ap-row">' +
        '<button id="plugin-scan-btn" class="bar-btn">🔍 Scan</button>' +
        '<span id="plugin-scan-status"></span>' +
        '</div>';

    panel.querySelector('#plugin-scan-btn')
        .addEventListener('click', () => startScan());
}

async function startScan() {
    try {
        await callNative('scanPlugins');
    } catch (err) {
        onLog('plugin scan failed to start: ' + err.message);
        return;
    }
    const btn = panel && panel.querySelector('#plugin-scan-btn');
    if (btn) btn.disabled = true;
    stopPolling();
    pollTimer = setInterval(pollScan, 250);
}

async function pollScan() {
    if (!panel) { stopPolling(); return; }
    let status;
    try {
        status = await callNative('getPluginScanStatus');
    } catch (err) {
        stopPolling();
        onLog('plugin scan poll failed: ' + err.message);
        return;
    }
    const line = panel && panel.querySelector('#plugin-scan-status');
    if (status.scanning) {
        if (line) {
            const pct = Math.round((status.progress || 0) * 100);
            line.textContent = pct + '% ' + shortName(status.current || '');
        }
        return;
    }
    stopPolling();
    // The scan probes plugins out of process (docs/vst3.md §4): a
    // plugin that crashed or hung took down only its worker and was
    // excluded. Say WHICH, so the user knows why it is not in the list.
    const crashed = Array.isArray(status.crashed) ? status.crashed : [];
    let msg = 'plugin scan done: ' + status.count + ' known';
    if (crashed.length) {
        msg += '; excluded ' + crashed.length + ' that crashed or hung: ' +
            crashed.join(', ');
    } else if (status.blacklistCount) {
        msg += ' (' + status.blacklistCount + ' blacklisted)';
    }
    if (status.error) msg += '; scan error: ' + status.error;
    onLog(msg);
    await render();  // re-fetch the list with the scan's discoveries
}

function shortName(path) {
    const parts = String(path).split(/[\\/]/);
    return parts[parts.length - 1] || '';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;',
        '"': '&quot;', "'": '&#39;',
    }[c]));
}
