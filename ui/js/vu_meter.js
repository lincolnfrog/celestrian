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
 * THE MASTER READING (B5): the engine meters the device buffers after
 * root_node->process, i.e. after the root stack's own output stage —
 * post-fader, post-rack; what the speakers get.
 *
 * Dial mapping: −48 dB … 0 dB across the −26° … +26° sweep. The engine
 * meters an envelope follower (~15 ms attack, ~400 ms release), so the
 * needle dances with transients; the wide absolute scale means quiet
 * laptop takes read mid-dial and a hot mix rides the top (a −20…+3 VU
 * range would pin everything below −20 dB).
 *
 * Peak-hold tick: a thin marker parked at the highest needle angle of
 * the last HOLD_MS, then falling at HOLD_FALL_PER_MS — the "how hot did
 * that hit" answer a moving needle cannot give.
 * Clip lamp: lit (momentary) above −3 dB as the near-clip warning, and
 * LATCHED — solid, until the meter is clicked — once the follower reads
 * full scale (CLIP_LV): the buffers are unclamped floats, so an over
 * pushes the follower to or past 1.0 and only an over can.
 */

const SWEEP_MIN_DB = -48;
const SWEEP_MAX_DB = 0;
const SWEEP_DEG = 26;
const PEAK_LV = 0.9375;  // −3 dB on the −48..0 sweep
const CLIP_LV = 1.0;     // linear full scale — the follower reads it only on an over
const HOLD_MS = 1500;    // the peak tick parks this long before falling
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
 * One poll of peak-hold + clip-latch bookkeeping. PURE: returns the next
 * memory for `level` (linear 0..1) at wall clock `now` (ms) — the DOM
 * drive below applies it, and js/tests pin it without a document.
 * A held peak is refreshed by any level reaching it; once HOLD_MS has
 * passed it falls linearly toward the live level, never below it. The
 * latch only ever sets here — clearing is the click (clearClip).
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
export function clearClip(id) {
    memoryFor(id).clipped = false;
}

/**
 * Point one meter's needle at `level`, park the hold tick and set the
 * clip lamp. Rotations are inline transforms; the CSS transition on
 * .needle supplies the sweep between polls (the tick jumps — a held
 * peak is a fact, not a motion).
 *
 * @param {Element|null} el the meter root (.needle, .hold, .peak)
 * @param {number} level linear RMS 0..1 from the engine
 * @param {number} now wall clock, ms
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

/**
 * Patch both master meters from polled state. Idempotent; cheap enough
 * to call every poll tick. `now` defaults to the wall clock.
 */
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
