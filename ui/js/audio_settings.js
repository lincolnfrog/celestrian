/**
 * Audio device pickers (docs/performance.md §4), rendered into the
 * preferences panel's #audio-device-host when it opens.
 *
 * The driver TYPE is the primary control. On Windows a multi-channel
 * interface's WDM driver publishes each stereo pair as its own
 * endpoint ("Analog 1-2", "Analog 3-4", …) and Windows opens one at a
 * time: only the ASIO type presents the interface whole. The engine
 * persists the choice.
 *
 * type → device → rate / buffer is a dependency chain: a type switch
 * invalidates the device list, a device switch the rate and buffer
 * lists. So every apply re-reads the full state from the engine; none
 * is patched locally.
 */

let host = null;
let callNative = null;
let onLog = () => { };

/** Binds the bridge and the status line; rendering waits for a host. */
export function initAudioSettings(callNativeFn, log) {
    callNative = callNativeFn;
    if (log) onLog = log;
}

/** The status line for setAudioDevice's answer: "" is success, any
 * other text the engine's error, and `null` a call that was lost. */
export function deviceChangeVerdict(answer) {
    if (answer === null || answer === undefined) {
        return 'Audio device not changed — the engine did not answer';
    }
    return answer ? 'Audio device error: ' + answer : 'Audio device updated.';
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

/** One labelled <select> row. `current` is pre-selected (compared as
 * strings); `onChange` gets the chosen value as a string; `formatter`
 * maps a value to its display text. No options renders a disabled "—". */
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

/** Push a (partial) device change to the engine, say how it went, and
 * re-render from the state it leaves. Controls are disabled meanwhile. */
async function apply({ type, device, sampleRate, bufferSize }) {
    // '' and 0 mean "keep the current one". A type switch sends no
    // device, so the engine picks that type's default instead of
    // failing on a name that belongs to the other type.
    host.querySelectorAll('select, button').forEach(el => (el.disabled = true));
    onLog(deviceChangeVerdict(await callNative('setAudioDevice',
        type || '', device || '', sampleRate || 0, bufferSize || 0)));
    await render();
}

/** (Re)build the host from engine state: the four selects, the channel
 * count, the ASIO hints and any engine error. Does nothing if the host
 * left the document while the state was read; a lost read renders a
 * note. */
async function render() {
    if (!host) return;
    const s = await callNative('getAudioDeviceState');
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
