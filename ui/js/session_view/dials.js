/**
 * The rail's two rotary controls, one parameterized builder. Each is a
 * held control (context.js): the engine value streams while it is
 * dragged, one VALUE UNIT per DIAL_PX_PER_UNIT of travel.
 *
 * GAIN — the volume fader (the output stage, setNodeGain): 0..1,
 * attenuate-only (the no-boost law), so its resting tick points fully
 * clockwise and turning it DOWN is the whole gesture. Drag vertically
 * (up = louder); double-click restores unity.
 *
 * PAN — the tick sweeps −90° (hard left) .. +90° (hard right): a full
 * quarter-turn each way, because a 45° stop would read as "half way" on
 * a signal already fully panned. Drag horizontally; double-click
 * recentres. The engine applies the balance law: centre is unity,
 * panning attenuates the far channel only.
 */

import { ctx } from './context.js';
import { el, setTitle, holdControl } from './sv_util.js';

/* Drag travel per value unit: gain's 0..1 is a 75px sweep, pan's −1..+1
 * is 150px end to end. */
const DIAL_PX_PER_UNIT = 75;
/* A gain at or above this draws as unity; a pan within PAN_CENTER_EPS
 * of 0 draws as centred. */
const GAIN_UNITY_MIN = 0.99;
const PAN_CENTER_EPS = 0.01;

/**
 * Build one dial. `spec`:
 *   className — dial class ('gain-dial' / 'pan-dial')
 *   title     — resting tooltip
 *   axis      — 'x' | 'y' (drag axis; y is inverted: up = more)
 *   min, max  — value clamp
 *   reset     — the double-click restore value
 *   value(lane) — current engine value from the lane snapshot
 *   send(id, v) — the engine callback
 *   paint(dial, v) — the tick/tooltip painter (setGainDial/setPanDial)
 */
function buildDial(row, spec) {
    const dial = el('div', spec.className, { title: spec.title });
    // The rail is an HTML5 drag source (lane reorder) and its children
    // inherit that; a dial drag looks like the start of a rail drag, so
    // this element opts out explicitly.
    dial.draggable = false;
    const tick = el('div', 'pan-tick');
    dial.appendChild(tick);
    dial._tick = tick;

    const send = v => {
        const lane = row._lane;
        if (lane) spec.send(lane.id, v);
    };
    const at = ev => (spec.axis === 'y' ? -ev.clientY : ev.clientX);
    let start = 0, startV = 0;
    holdControl(dial, {
        onStart: ev => {
            ev.preventDefault();
            start = at(ev);
            startV = spec.value(row._lane);
        },
        onMove: ev => {
            const v = Math.max(spec.min, Math.min(spec.max,
                startV + (at(ev) - start) / DIAL_PX_PER_UNIT));
            spec.paint(dial, v);
            send(v);
        },
    });
    dial.addEventListener('dblclick', () => {
        spec.paint(dial, spec.reset);
        send(spec.reset);
    });
    return dial;
}

export function buildGainDial(row) {
    return buildDial(row, {
        className: 'gain-dial',
        title: 'Volume (drag up/down; double-click for full)',
        axis: 'y', min: 0, max: 1, reset: 1,
        value: lane =>
            lane && typeof lane.gain === 'number' ? lane.gain : 1,
        send: (id, v) => ctx.cb.onSetGain(id, v),
        paint: setGainDial,
    });
}

/** Paint the gain dial: 0 → −90° (silent), 1 → +90° (unity) — the pan
 * tick's sweep, so the two dials read as one family. Amber below unity. */
export function setGainDial(dial, gain) {
    dial._tick.style.transform =
        `translateX(-50%) rotate(${(gain * 180 - 90).toFixed(1)}deg)`;
    dial.classList.toggle('off-center', gain < GAIN_UNITY_MIN);
    setTitle(dial, gain >= GAIN_UNITY_MIN
        ? 'Volume: full (drag up/down)'
        : `Volume: ${Math.round(gain * 100)}%`);
}

export function buildPanDial(row) {
    return buildDial(row, {
        className: 'pan-dial',
        title: 'Pan (drag; double-click to center)',
        axis: 'x', min: -1, max: 1, reset: 0,
        value: lane => (lane && lane.pan) || 0,
        send: (id, v) => ctx.cb.onSetPan(id, v),
        paint: setPanDial,
    });
}

export function setPanDial(dial, pan) {
    dial._tick.style.transform =
        `translateX(-50%) rotate(${(pan * 90).toFixed(1)}deg)`;
    dial.classList.toggle('off-center', Math.abs(pan) > PAN_CENTER_EPS);
    const pc = Math.round(Math.abs(pan) * 100);
    setTitle(dial, pan === 0 ? 'Pan: center (drag; double-click to center)'
        : `Pan: ${pc}% ${pan < 0 ? 'left' : 'right'}`);
}
