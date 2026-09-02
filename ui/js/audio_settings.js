/**
 * Audio device panel (docs/performance.md §4).
 *
 * Why this exists: whatever Windows calls the default input is a
 * 2-channel endpoint. Worse, a multi-channel
 * interface's WDM driver publishes each pair as its OWN stereo endpoint
 * ("MOTU Analog 1-2", "Analog 3-4", …) and Windows opens one at a time —
 * so on WASAPI there is NO device that gives you 8 inputs. Only the ASIO
 * driver type presents the interface whole. That makes the driver TYPE
 * the primary control here, not an advanced afterthought.
 *
 * The selection is persisted by the engine (audio_device.xml), so this
 * panel is a launch-time ritual you perform once, not every session.
 *
 * Ordering note: type → device → rate/buffer is a dependency chain. A
 * type switch invalidates the device list, and a device switch
 * invalidates the rate/buffer lists, so every apply re-reads full state
 * from the engine rather than patching locally.
 */

let panel = null;
let callNative = null;
let onLog = () => { };

/** Wires the status-strip button. `log` writes to the status line. */
export function initAudioSettings(callNativeFn, log) {
    callNative = callNativeFn;
    if (log) onLog = log;

    const btn = document.getElementById('audio-device-btn');
    if (!btn) return;
    btn.addEventListener('click', () => togglePanel(btn));

    // Close on outside click / Escape, like the project menu.
    document.addEventListener('click', (e) => {
        if (!panel) return;
        if (panel.contains(e.target) || e.target === btn) return;
        closePanel();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panel) closePanel();
    });

    // Surface the channel count on the button itself — the whole bug was
    // that "only 2 inputs" was invisible until you opened a track's menu.
    refreshButtonLabel();
}

/** Remove the panel from the DOM (no-op when closed). Module-internal:
 *  nothing imports this today, so it is deliberately not exported. */
function closePanel() {
    if (panel) { panel.remove(); panel = null; }
}

async function togglePanel(btn) {
    if (panel) { closePanel(); return; }
    panel = document.createElement('div');
    panel.className = 'audio-panel open';
    panel.innerHTML = '<div class="ap-head">Audio device</div>' +
        '<div class="ap-note">loading…</div>';
    document.getElementById('status-strip').appendChild(panel);
    await render();
}

/** Read the full device state from the engine (getAudioDeviceState).
 *  Returns the state object, or null on failure (already logged). */
async function fetchState() {
    try {
        return await callNative('getAudioDeviceState');
    } catch (err) {
        onLog('Audio device query failed: ' + err.message);
        return null;
    }
}

async function refreshButtonLabel() {
    const btn = document.getElementById('audio-device-btn');
    if (!btn) return;
    const s = await fetchState();
    if (!s) return;
    const n = s.inputChannels || 0;
    btn.textContent = s.currentDevice
        ? `🎛 ${s.currentDevice} · ${n} in`
        : '🎛 No audio device';
    btn.title = s.currentDevice
        ? `${s.currentType} — ${s.currentSampleRate} Hz, ${s.currentBufferSize} samples`
        : 'No audio device open — click to choose one';
}

/**
 * Build one labelled <select> row for the panel.
 * @param {string} labelText  Row label ("Driver", "Device", …).
 * @param {Array} options     Option values; an empty/missing list renders
 *                            a disabled "—" placeholder.
 * @param {*} current         Value to pre-select (compared as strings).
 * @param {function} onChange Called with the selected value (string).
 * @param {function} [formatter] Optional value → display-text mapper.
 * @returns {HTMLLabelElement} the assembled row.
 */
function sel(labelText, options, current, onChange, formatter) {
    const row = document.createElement('label');
    row.className = 'ap-row';
    const span = document.createElement('span');
    span.textContent = labelText;
    const select = document.createElement('select');
    (options || []).forEach(value => {
        const opt = document.createElement('option');
        opt.value = String(value);
        opt.textContent = formatter ? formatter(value) : String(value);
        if (String(value) === String(current)) opt.selected = true;
        select.appendChild(opt);
    });
    if (!options || !options.length) {
        select.disabled = true;
        const opt = document.createElement('option');
        opt.textContent = '—';
        select.appendChild(opt);
    }
    select.addEventListener('change', () => onChange(select.value));
    row.appendChild(span);
    row.appendChild(select);
    return row;
}

/**
 * Push a (partial) device change to the engine, then re-render the panel
 * and the strip button from freshly fetched state (never patched
 * locally — see the ordering note in the file header). All controls are
 * disabled while the change applies; errors go to the status line.
 */
async function apply({ type, device, sampleRate, bufferSize }) {
    // Empty/0 mean "keep current" on the native side; a type switch
    // deliberately sends no device so the engine picks that type's default
    // rather than failing on a name that belongs to the other type.
    panel.querySelectorAll('select, button').forEach(el => (el.disabled = true));
    try {
        const err = await callNative('setAudioDevice',
            type || '', device || '', sampleRate || 0, bufferSize || 0);
        if (err) onLog('Audio device error: ' + err);
        else onLog('Audio device updated.');
    } catch (e) {
        onLog('Audio device error: ' + e.message);
    }
    await render();
    refreshButtonLabel();
}

/**
 * (Re)build the open panel's contents from engine state: the four
 * dependency-chained selects (type → device → rate/buffer), the channel
 * count, the WASAPI→ASIO nudge hints, and any engine error. Safe if the
 * panel closed mid-fetch (bails), or if the engine is unreachable
 * (renders a note instead).
 */
async function render() {
    if (!panel) return;
    const s = await fetchState();
    if (!panel) return; // closed while fetching
    panel.textContent = '';

    const head = document.createElement('div');
    head.className = 'ap-head';
    head.textContent = 'Audio device';
    panel.appendChild(head);

    if (!s) {
        const note = document.createElement('div');
        note.className = 'ap-note';
        note.textContent = 'Engine not reachable.';
        panel.appendChild(note);
        return;
    }

    panel.appendChild(sel('Driver', s.types, s.currentType,
        v => apply({ type: v })));
    panel.appendChild(sel('Device', s.devices, s.currentDevice,
        v => apply({ type: s.currentType, device: v })));
    panel.appendChild(sel('Sample rate', s.sampleRates, s.currentSampleRate,
        v => apply({
            type: s.currentType, device: s.currentDevice,
            sampleRate: Number(v),
        }), v => `${v} Hz`));
    panel.appendChild(sel('Buffer', s.bufferSizes, s.currentBufferSize,
        v => apply({
            type: s.currentType, device: s.currentDevice,
            bufferSize: Number(v),
        }), v => {
            const sr = s.currentSampleRate || 48000;
            return `${v} samples (${(v / sr * 1000).toFixed(1)} ms)`;
        }));

    const stat = document.createElement('div');
    stat.className = 'ap-stat';
    stat.textContent = `${s.inputChannels} inputs · ${s.outputChannels} outputs`;
    panel.appendChild(stat);

    // The actionable nudge: on Windows, few inputs almost always means
    // "you are on WASAPI", and the fix is one dropdown away.
    const onAsio = (s.currentType || '').toUpperCase().includes('ASIO');
    if (!onAsio && s.asioAvailable && s.inputChannels <= 2) {
        const hint = document.createElement('div');
        hint.className = 'ap-hint';
        hint.textContent =
            'Only 2 inputs? Windows splits multi-channel interfaces into ' +
            'stereo pairs. Switch Driver to ASIO to get all channels at once.';
        panel.appendChild(hint);
    }
    if (!s.asioAvailable) {
        const hint = document.createElement('div');
        hint.className = 'ap-hint';
        hint.textContent =
            'No ASIO driver type — this build has no ASIO support, so ' +
            'multi-channel interfaces are limited to stereo pairs.';
        panel.appendChild(hint);
    }
    if (s.error) {
        const err = document.createElement('div');
        err.className = 'ap-err';
        err.textContent = s.error;
        panel.appendChild(err);
    }
}
