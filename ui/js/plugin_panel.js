/**
 * The plugin registry panel (docs/vst3.md): a status-strip popover
 * (popover.js, in the preferences panel's .audio-panel styles) that
 * lists the known VST3 plugins and drives a rescan. A scan runs in the
 * backend's background and OUTLIVES THE PANEL: its status is polled
 * until it ends, so the status line reports the result with the panel
 * closed, and a panel opened meanwhile shows the scan running. The open
 * panel reads the list again when the scan ends. The registry view
 * only: adding a plugin to a chain is the fx row's "+" picker
 * (session_view/fx_row.js).
 */

import { wirePopover } from './popover.js';

const SCAN_POLL_MS = 250;  // how often an open panel asks a scan's status

let panel = null;          // the open panel's element; null while closed
let callNative = null;
let onLog = () => { };
let pollTimer = null;      // set while a scan this panel started runs

/** Wires the status-strip button. `log` writes to the status line. */
export function initPluginPanel(callNativeFn, log) {
    callNative = callNativeFn;
    if (log) onLog = log;

    const button = document.getElementById('plugins-btn');
    if (!button) return;
    wirePopover({
        button,
        isOpen: () => !!panel,
        open: openPanel,
        close: closePanel,
        holds: target => panel.contains(target),
    });
}

function closePanel() {
    if (panel) { panel.remove(); panel = null; }
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function openPanel() {
    panel = document.createElement('div');
    panel.className = 'audio-panel open';
    panel.innerHTML = '<div class="ap-head">Plugins</div>' +
        '<div class="ap-note">loading…</div>';
    document.getElementById('status-strip').appendChild(panel);
    await render();
}

async function render() {
    if (!panel) return;
    // A lost call (null) lists nothing.
    const plugins = await callNative('getKnownPlugins') || [];
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
    setScanBusy(!!pollTimer);
}

/** Enable or disable the Scan button of the open panel. */
function setScanBusy(busy) {
    const btn = panel && panel.querySelector('#plugin-scan-btn');
    if (btn) btn.disabled = busy;
}

async function startScan() {
    if (await callNative('scanPlugins') === null) {
        onLog('plugin scan not started — the engine did not answer');
        return;
    }
    setScanBusy(true);
    stopPolling();
    pollTimer = setInterval(pollScan, SCAN_POLL_MS);
}

async function pollScan() {
    const status = await callNative('getPluginScanStatus');
    if (!status) {
        // A lost call: stop asking, and leave the panel usable.
        stopPolling();
        setScanBusy(false);
        onLog('plugin scan status lost — the engine did not answer');
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
