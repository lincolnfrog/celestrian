/**
 * The master monitor: VU needles, their peak ticks and clip lamps, and
 * the master fader.
 *
 * THE MASTER READING: the engine meters the device buffers after the
 * root stack's own output stage — post-fader, post-rack, what the
 * speakers get — through an envelope follower, and publishes it as
 * masterVuL / masterVuR (linear 0..1) on every state. The needle's CSS
 * transition (#master-monitor in session.css) carries the sweep between
 * polls.
 *
 * The dial spans SWEEP_MIN_DB … SWEEP_MAX_DB: an absolute scale wide
 * enough that a quiet take reads mid-dial and a hot mix rides the top.
 * The peak tick parks at the highest needle angle of the last HOLD_MS,
 * then falls — "how hot did that hit". The clip lamp is lit above
 * PEAK_LV and LATCHED, until the face is clicked, once the follower
 * reads CLIP_LV: the buffers are unclamped floats, so only an over
 * pushes it there.
 */

import { setTitle } from './session_view/sv_util.js';

const SWEEP_MIN_DB = -48;
const SWEEP_MAX_DB = 0;
const SWEEP_DEG = 26;    // the needle swings ± this
const PEAK_LV = 0.9375;  // −3 dB on the sweep, as a dial fraction
const CLIP_LV = 1.0;     // linear full scale
const HOLD_MS = 1500;
const HOLD_FALL_PER_MS = 0.4 / 1000;  // dial fraction per ms (~2.5 s full sweep)

/** Map a linear RMS level (0..1) to dial fraction (0..1). */
export function levelToDial(level) {
    const db = 20 * Math.log10((Math.abs(level) || 0) + 1e-6);
    const lv = (db - SWEEP_MIN_DB) / (SWEEP_MAX_DB - SWEEP_MIN_DB);
    return Math.max(0, Math.min(1, lv));
}

/** A meter's memory between polls: the held peak (dial fraction), when
 * it may start falling, the clip latch, and the last poll's clock. */
export function freshMeterMemory() {
    return { hold: 0, holdUntil: 0, clipped: false, lastMs: 0 };
}

/**
 * One poll of peak-hold and clip-latch bookkeeping, pure: the next
 * memory for `level` (linear 0..1) at wall clock `now` (ms). A held
 * peak is refreshed by any level reaching it; once HOLD_MS has passed
 * it falls linearly toward the live level, never below it. The latch
 * only ever sets here — clearing is the click (clearClip).
 */
export function meterStep(memory, level, now) {
    const lv = levelToDial(level);
    let { hold, holdUntil } = memory;
    if (lv >= hold) {
        hold = lv;
        holdUntil = now + HOLD_MS;
    } else if (now > holdUntil) {
        // The fall clock starts when the park ends, not at the last
        // poll — a long park must not become one big drop.
        const from = Math.max(memory.lastMs || now, holdUntil);
        hold = Math.max(lv, hold - Math.max(0, now - from) * HOLD_FALL_PER_MS);
    }
    return {
        hold,
        holdUntil,
        clipped: memory.clipped || level >= CLIP_LV,
        lastMs: now,
    };
}

/** Per-meter memory, keyed by element id ('vu-l' / 'vu-r'). */
const meterMemory = new Map();

function memoryFor(id) {
    if (!meterMemory.has(id)) meterMemory.set(id, freshMeterMemory());
    return meterMemory.get(id);
}

/** Release a meter's clip latch (the click on the meter face). */
function clearClip(id) {
    memoryFor(id).clipped = false;
}

/**
 * Point one meter's needle at `level` (linear 0..1), park the hold
 * tick and set the clip lamp. The needle sweeps by its CSS transition;
 * the tick jumps — a held peak is a fact, not a motion.
 */
function drive(el, level, now) {
    if (!el) return;
    const memory = meterStep(memoryFor(el.id), level, now);
    meterMemory.set(el.id, memory);
    const lv = levelToDial(level);
    const angle = v => -SWEEP_DEG + v * 2 * SWEEP_DEG;
    const needle = el.querySelector('.needle');
    const hold = el.querySelector('.hold');
    const peak = el.querySelector('.peak');
    if (needle) {
        needle.style.transform = `translateX(-50%) rotate(${angle(lv)}deg)`;
    }
    if (hold) {
        hold.style.transform =
            `translateX(-50%) rotate(${angle(memory.hold)}deg)`;
    }
    if (peak) {
        peak.style.opacity = memory.clipped || lv > PEAK_LV ? '1' : '0.15';
        peak.classList.toggle('latched', memory.clipped);
    }
    el.classList.toggle('clipped', memory.clipped);
}

/** Patch both master meters with the polled levels. */
export function updateMasterVU(levelL, levelR, now = Date.now()) {
    drive(document.getElementById('vu-l'), levelL, now);
    drive(document.getElementById('vu-r'), levelR, now);
}

/** Wire the meters: a click on a face releases its clip latch. */
export function initMasterMeters() {
    for (const id of ['vu-l', 'vu-r']) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', () => clearClip(id));
    }
}

/* ---------- master fader (the root's gain) ---------- */
// The grip tracks the pointer 1:1 and streams the gain as it moves
// (a knob: not undoable). While a drag holds it (`faderHot`), the
// poll's reflection stands off, so the two never fight over the grip.

let faderHot = false;
let faderValue = 1;

/** Grip travel in px: container inner height minus grip and 1px pads. */
function faderTravel(el, grip) {
    return Math.max(1, el.clientHeight - grip.offsetHeight - 2);
}

/** Place the grip for gain `v` (0 = bottom of travel, 1 = top). The
 * gesture and the poll's reflection both draw through here. */
function paintFader(v) {
    const el = document.getElementById('master-fader');
    if (!el) return;
    const grip = el.querySelector('.grip');
    if (grip) grip.style.bottom = (1 + v * faderTravel(el, grip)) + 'px';
}

/** Wire the fader. onSetGain(v) streams 0..1 to the backend. */
export function initMasterFader(onSetGain) {
    const el = document.getElementById('master-fader');
    if (!el) return;
    el.addEventListener('pointerdown', e => {
        e.preventDefault();
        // Capture keeps the drag alive off-element; a webview that
        // refuses it (or a synthetic pointer) must not stop the wiring
        // below.
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        faderHot = true;
        const grip = el.querySelector('.grip');
        const travel = faderTravel(el, grip);
        const startY = e.clientY;
        const startV = faderValue;
        const move = ev => {
            const v = Math.max(0, Math.min(1,
                startV + (startY - ev.clientY) / travel));
            faderValue = v;
            paintFader(v);
            onSetGain(v);
        };
        const up = () => {
            faderHot = false;
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
            el.removeEventListener('pointercancel', up);
            el.removeEventListener('lostpointercapture', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        // Capture torn away mid-drag (a re-render, an OS gesture) must
        // release the hold too, or the poll never reclaims the grip.
        el.addEventListener('lostpointercapture', up);
    });
    el.addEventListener('dblclick', () => {
        faderValue = 1;
        paintFader(1);
        onSetGain(1);
    });
    paintFader(faderValue);
}

/** Reflect the engine's value between gestures (idempotent, per poll). */
export function updateMasterFader(gain) {
    if (faderHot) return;
    const v = Math.max(0, Math.min(1, typeof gain === 'number' ? gain : 1));
    if (v === faderValue) return;
    faderValue = v;
    paintFader(v);
}

/* ---------- the monitor as a whole ---------- */

/** A linear level as a dB figure for the hover readout. */
const dbText = v => {
    const n = Number(v) || 0;
    return n <= 0 ? '−∞' : (20 * Math.log10(n)).toFixed(1);
};

/** Whether `state` carries no master levels: an engine that publishes
 * none would otherwise show dead needles that look broken. */
export const masterLevelsMissing = state =>
    typeof state.masterVuL === 'undefined';

/** The monitor's hover title: the live dB readout (which doubles as the
 * diagnostic surface for the meter path), or why the meters are dim. */
export function masterMonitorTitle(state) {
    if (masterLevelsMissing(state)) {
        return 'No master levels in engine state — rebuild the app (the ' +
            'C++ engine predates the master VU)';
    }
    return 'Master output (post-fader) — L ' + dbText(state.masterVuL) +
        ' dB · R ' + dbText(state.masterVuR) + ' dB (raw L=' +
        state.masterVuL + ') · click a face to release its clip lamp';
}

/** Poll hook: the whole master monitor from polled `state` — the dim
 * `.stale` look and the title, the needles, and the fader at
 * `rootGain`. The title is a guarded write: the monitor is clickable. */
export function updateMasterMonitor(state, rootGain) {
    const monitor = document.getElementById('master-monitor');
    if (monitor) {
        monitor.classList.toggle('stale', masterLevelsMissing(state));
        setTitle(monitor, masterMonitorTitle(state));
    }
    updateMasterVU(Number(state.masterVuL) || 0, Number(state.masterVuR) || 0);
    updateMasterFader(rootGain);
}
