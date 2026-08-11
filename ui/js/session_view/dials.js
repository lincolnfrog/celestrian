/**
 * The rail's two rotary controls, one parameterized builder.
 *
 * GAIN — the volume fader (output stage, engine setNodeGain): 0..1,
 * unity default — attenuate-only per the no-boost law, so the resting
 * tick points fully clockwise (+90°) and turning it DOWN is the whole
 * gesture. Drag is VERTICAL (up = louder — the axis a level control
 * represents, the same ruling that made pan horizontal); double-click
 * restores unity. Amber whenever below unity.
 *
 * PAN — a small rotary: the tick sweeps −90° (hard left, pointing at
 * the L channel) .. +90° (hard right). The full quarter-turn each way
 * is the point — a 45° stop reads as "half way" when the signal is
 * already fully panned. Horizontal drag edits (right = right, matching
 * the axis the control represents); double-click recenters. Engine
 * semantics are the balance law — center is unity, panning attenuates
 * the far channel only.
 *
 * Both dials sweep one VALUE UNIT per DIAL_PX_PER_UNIT of drag: gain's
 * 0..1 range is a 75px sweep, pan's −1..+1 range is 150px end to end.
 * The engine value streams while dragging; `_hot` keeps the 50ms tick
 * from fighting the gesture (the fx-slider lesson).
 */

import { ctx } from './context.js';
import { el, capturePointer } from './sv_util.js';

const DIAL_PX_PER_UNIT = 75;

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
    // The rail is an HTML5 drag source (lane reorder) and children
    // inherit that; a dial drag looks exactly like the start of a rail
    // drag, so opt this element out explicitly rather than relying on
    // the pointerdown preventDefault alone.
    dial.draggable = false;
    const tick = el('div', 'pan-tick');
    dial.appendChild(tick);
    dial._tick = tick;

    const send = v => {
        const lane = row._lane;
        if (lane) spec.send(lane.id, v);
    };
    dial.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        capturePointer(dial, ev);
        dial._hot = true;
        dial._start = spec.axis === 'y' ? ev.clientY : ev.clientX;
        dial._startV = spec.value(row._lane);
    });
    dial.addEventListener('pointermove', ev => {
        if (!dial._hot) return;
        const d = spec.axis === 'y'
            ? dial._start - ev.clientY    // up = more
            : ev.clientX - dial._start;   // right = more
        const v = Math.max(spec.min, Math.min(spec.max,
            dial._startV + d / DIAL_PX_PER_UNIT));
        spec.paint(dial, v);
        send(v);
    });
    const end = () => { dial._hot = false; };
    dial.addEventListener('pointerup', end);
    dial.addEventListener('pointercancel', end);
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

export function setGainDial(dial, gain) {
    // 0 → −90° (silent), 1 → +90° (unity): the same sweep the pan tick
    // uses, so the two dials read as one family.
    dial._tick.style.transform =
        `translateX(-50%) rotate(${(gain * 180 - 90).toFixed(1)}deg)`;
    dial.classList.toggle('off-center', gain < 0.99);
    dial.title = gain >= 0.99
        ? 'Volume: full (drag up/down)'
        : `Volume: ${Math.round(gain * 100)}%`;
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
    dial.classList.toggle('off-center', Math.abs(pan) > 0.01);
    const pc = Math.round(Math.abs(pan) * 100);
    dial.title = pan === 0 ? 'Pan: center (drag; double-click to center)'
        : `Pan: ${pc}% ${pan < 0 ? 'left' : 'right'}`;
}
