/**
 * Master monitor VU needles (dark tape theme handoff, waveform-vu.js).
 *
 * The audio engine is native (JUCE) — there is no Web Audio graph to
 * analyse, so the mockup's attachMasterVU(audioCtx, masterNode, …) shape
 * doesn't apply here. Instead the engine computes smoothed output RMS on
 * the audio thread and publishes it as masterVuL/masterVuR (linear 0..1)
 * on every getGraphState; app.js hands those to updateMasterVU() from
 * the 50 ms poll. The needle's CSS transition (see #master-monitor in
 * session.css) interpolates between polls, so the sweep reads as
 * continuous without a rAF loop.
 *
 * Dial mapping: −48 dB … 0 dB across the −26° … +26° sweep. The engine
 * meters block PEAK (instant attack, ~400 ms release), so the needle
 * dances with transients; the wide absolute scale means quiet laptop
 * takes read mid-dial and a hot mix rides the top (a −20…+3 VU range
 * would pin everything below −20 dB).
 * Peak lamp above −3 dB: a true near-clip warning.
 */

const SWEEP_MIN_DB = -48;
const SWEEP_MAX_DB = 0;
const SWEEP_DEG = 26;
const PEAK_LV = 0.9375;  // −3 dB on the −48..0 sweep

/** Map a linear RMS level (0..1) to dial fraction (0..1). */
function levelToDial(level) {
    const db = 20 * Math.log10((Math.abs(level) || 0) + 1e-6);
    const lv = (db - SWEEP_MIN_DB) / (SWEEP_MAX_DB - SWEEP_MIN_DB);
    return Math.max(0, Math.min(1, lv));
}

/**
 * Point one meter's needle at `level` and set its peak lamp. The
 * rotation is written as an inline transform; the CSS transition on
 * .needle supplies the sweep between polls.
 *
 * @param {Element|null} el the meter root (contains .needle and .peak)
 * @param {number} level linear RMS 0..1 from the engine
 */
function drive(el, level) {
    if (!el) return;
    const lv = levelToDial(level);
    const needle = el.querySelector('.needle');
    const peak = el.querySelector('.peak');
    if (needle) {
        needle.style.transform =
            `translateX(-50%) rotate(${-SWEEP_DEG + lv * 2 * SWEEP_DEG}deg)`;
    }
    if (peak) peak.style.opacity = lv > PEAK_LV ? '1' : '0.15';
}

/**
 * Patch both master meters from polled state. Idempotent; cheap enough
 * to call every poll tick.
 */
export function updateMasterVU(levelL, levelR) {
    drive(document.getElementById('vu-l'), levelL);
    drive(document.getElementById('vu-r'), levelR);
}

/* ---------- master fader (root-node gain) ---------- */
// The vertical fader beside the meters: the grip tracks the pointer 1:1
// and streams setNodeGain on the island ROOT (the whole mix's output
// stage — stacks apply gain·pan at their output, so the root's fader IS
// the master fader). Same streaming/non-undoable contract as the rail
// dials; `hot` keeps the 50 ms state tick from fighting the gesture
// (the fx-slider lesson).

let faderHot = false;
let faderValue = 1;

/** Grip travel in px: container inner height minus grip and 1px pads. */
function faderTravel(el, grip) {
    return Math.max(1, el.clientHeight - grip.offsetHeight - 2);
}

/**
 * Position the fader grip for gain `v` (0..1). Pure DOM write — no
 * backend call; both the gesture and the poll reflection go through
 * this so the grip can never disagree with the value.
 *
 * @param {number} v master gain 0..1 (0 = bottom of travel, 1 = top)
 */
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
        // refuses (or a synthetic pointer) must not kill the gesture
        // wiring below (session_view convention).
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        faderHot = true;
        const grip = el.querySelector('.grip');
        const travel = faderTravel(el, grip);
        const startY = e.clientY;
        const startV = faderValue;
        const move = ev => {
            // 1:1 — the grip follows the pointer, real-fader feel
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
        // If capture is torn away mid-gesture (element re-render, OS
        // gesture steal), release the hot flag so the 50 ms poll can
        // reclaim the grip — otherwise the fader freezes forever.
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
