/**
 * Audio device pickers (docs/performance.md §4), hosted by the
 * preferences panel (preferences.js renders them into
 * #audio-device-host on open).
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
 * is a launch-time ritual you perform once, not every session.
 *
 * Ordering note: type → device → rate/buffer is a dependency chain. A
 * type switch invalidates the device list, and a device switch
 * invalidates the rate/buffer lists, so every apply re-reads full state
 * from the engine rather than patching locally.
 */

let host = null;
let callNative = null;
let onLog = () => { };

/** Binds the bridge and the status line; rendering waits for a host. */
export function initAudioSettings(callNativeFn, log) {
    callNative = callNativeFn;
    if (log) onLog = log;
}

/** One line for the device: "MOTU 8A · 8 in · 48 kHz / 256", or the
 * no-device notice. */
export function deviceSummary(s) {
    if (!s || !s.currentDevice) return 'No audio device open';
    const n = s.inputChannels || 0;
    return `${s.currentDevice} · ${n} in · ` +
        `${(s.currentSampleRate || 0) / 1000} kHz / ${s.currentBufferSize || 0}`;
}

/** Render the pickers into `hostEl` (re-entrant: a later call replaces
 * the contents; an apply re-renders into the same host). */
export async function renderAudioDevice(hostEl) {
    host = hostEl;
    host.textContent = '';
    const note = document.createElement('div');
    note.className = 'ap-note';
    note.textContent = 'loading…';
    host.appendChild(note);
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

/**
 * Build one labelled <select> row.
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
 * Push a (partial) device change to the engine, then re-render from
 * freshly fetched state (never patched locally — see the ordering note
 * in the file header). All controls are disabled while the change
 * applies; errors go to the status line.
 */
async function apply({ type, device, sampleRate, bufferSize }) {
    // Empty/0 mean "keep current" on the native side; a type switch
    // deliberately sends no device so the engine picks that type's default
    // rather than failing on a name that belongs to the other type.
    host.querySelectorAll('select, button').forEach(el => (el.disabled = true));
    try {
        const err = await callNative('setAudioDevice',
            type || '', device || '', sampleRate || 0, bufferSize || 0);
        if (err) onLog('Audio device error: ' + err);
        else onLog('Audio device updated.');
    } catch (e) {
        onLog('Audio device error: ' + e.message);
    }
    await render();
}

/**
 * (Re)build the host's contents from engine state: the four
 * dependency-chained selects (type → device → rate/buffer), the channel
 * count, the WASAPI→ASIO nudge hints, and any engine error. Safe if the
 * host left the document mid-fetch (bails), or if the engine is
 * unreachable (renders a note instead).
 */
async function render() {
    if (!host) return;
    const s = await fetchState();
    if (!host || !host.isConnected) return;
    host.textContent = '';

    if (!s) {
        const note = document.createElement('div');
        note.className = 'ap-note';
        note.textContent = 'Engine not reachable.';
        host.appendChild(note);
        return;
    }

    host.appendChild(sel('Driver', s.types, s.currentType,
        v => apply({ type: v })));
    host.appendChild(sel('Device', s.devices, s.currentDevice,
        v => apply({ type: s.currentType, device: v })));
    host.appendChild(sel('Sample rate', s.sampleRates, s.currentSampleRate,
        v => apply({
            type: s.currentType, device: s.currentDevice,
            sampleRate: Number(v),
        }), v => `${v} Hz`));
    host.appendChild(sel('Buffer', s.bufferSizes, s.currentBufferSize,
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
    host.appendChild(stat);

    // The actionable nudge: on Windows, few inputs almost always means
    // "you are on WASAPI", and the fix is one dropdown away.
    const onAsio = (s.currentType || '').toUpperCase().includes('ASIO');
    if (!onAsio && s.asioAvailable && s.inputChannels <= 2) {
        const hint = document.createElement('div');
        hint.className = 'ap-hint';
        hint.textContent =
            'Only 2 inputs? Windows splits multi-channel interfaces into ' +
            'stereo pairs. Switch Driver to ASIO to get all channels at once.';
        host.appendChild(hint);
    }
    if (!s.asioAvailable) {
        const hint = document.createElement('div');
        hint.className = 'ap-hint';
        hint.textContent =
            'No ASIO driver type — this build has no ASIO support, so ' +
            'multi-channel interfaces are limited to stereo pairs.';
        host.appendChild(hint);
    }
    if (s.error) {
        const err = document.createElement('div');
        err.className = 'ap-err';
        err.textContent = s.error;
        host.appendChild(err);
    }
}
