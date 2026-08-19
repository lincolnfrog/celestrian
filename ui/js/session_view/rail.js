/**
 * Rail state: patch every rail control in place from the lane snapshot
 * — all writes idempotent (the setText law), none over a held control
 * (_hot) or an open rename editor (_renaming).
 */

import { setText, setTitle, fmtQ } from './sv_util.js';
import { selection } from './selection.js';
import { setGainDial, setPanDial } from './dials.js';
import { patchFxRow } from './fx_row.js';

/* The recording sub-line prints one decimal below this, whole Qs above
 * ("12.3Q…" outgrew the slot). */
const REC_LEN_DECIMAL_MAX_Q = 9.95;

/**
 * Patch one lane's rail: selection classes, name (never over a rename),
 * Q-definer chip, arm/mute/solo/delete/fx/input/one-shot states and
 * tooltips, the sub-line (period ↔ live take length ↔ armed), the
 * status word, and the two dials (never over a drag).
 */
export function patchRail(row, lane, vm) {
    if (lane.kind === 'add') return; // affordance row: nothing to patch
    if (lane.kind === 'fx') return patchFxRow(row, lane);
    row._lane = lane; // current lane snapshot for click handlers
    const railEl = row.querySelector('.lane-rail');
    if (railEl) railEl.classList.toggle('selected', selection.has(lane.id));
    row.classList.toggle('sel', selection.has(lane.id));
    row.dataset.depth = String(Math.min(lane.depth, 2));
    // Never patch the name over an open rename editor (or its optimistic
    // value — the backend echoes the new name on the next poll anyway)
    if (!row._renaming) setText(row.querySelector('.rail-name'), lane.name);
    const tempoChip = row.querySelector('.tempo-chip');
    if (tempoChip) {
        const show = lane.isQDefiner ? '' : 'none';
        if (tempoChip.style.display !== show) tempoChip.style.display = show;
    }

    const arm = row.querySelector('.arm-btn');
    arm.classList.toggle('recording', lane.recording);
    if (lane.kind === 'group') {
        const g = lane.groupArm;
        arm.classList.toggle('on', g.state === 'all');
        arm.classList.toggle('some', g.state === 'some');
        if (arm.disabled !== (g.armable === 0)) arm.disabled = g.armable === 0;
        setTitle(arm, g.armable === 0
            ? 'Nothing to record: every track has a take (re-recording arrives with takes)'
            : g.state === 'none'
                ? `Record all ${g.armable} empty track${g.armable > 1 ? 's' : ''} (full ones just play)`
                : 'Stop recording');
    } else {
        arm.classList.toggle('on', lane.armed);
        if (arm.disabled !== !lane.armable) arm.disabled = !lane.armable;
        setTitle(arm, !lane.armable
            ? 'Already has a take (re-recording arrives with takes)'
            : lane.recording ? 'Stop recording'
            : lane.armed ? 'Recording starts at the next Q boundary'
                : 'Record into this track');
    }

    // Sub-line: the period at rest; while RECORDING it becomes the live
    // take length, pulsing record-red — the period slot is the one place
    // on the rail with reserved room, so nothing else reflows (owner
    // feedback 2026-08-08: the head-row "recording…" word squeezed the
    // name to an ellipsis, a weird visual fluctuation).
    const sub = row.querySelector('.rail-sub');
    const recLen = lane.recordingLengthQ;
    const clipArmed = lane.kind === 'clip' && lane.armed && !lane.recording;
    if (lane.recording) {
        // Decimal below 10Q; whole Qs above — "12.3Q…" outgrew the slot
        const len = Number.isFinite(recLen) && recLen > 0
            ? (recLen < REC_LEN_DECIMAL_MAX_Q
                ? recLen.toFixed(1) : Math.round(recLen)) + 'Q'
            : 'rec';
        setText(sub, len + (lane.awaitingStop ? '…' : ''));
    } else if (clipArmed) {
        // Armed lives in the Q slot too (owner feedback 2026-08-08b) —
        // the same reserved room, the same no-reflow guarantee. It hands
        // over to the live length when audio starts flowing.
        setText(sub, 'armed');
    } else if (lane.kind === 'group') {
        setText(sub, lane.periodQ > 0 ? fmtQ(lane.periodQ) + 'Q' : 'group');
    } else if (lane.periodQ > 0) {
        setText(sub, fmtQ(lane.periodQ) + 'Q');
    } else {
        setText(sub, 'empty');
    }
    sub.classList.toggle('recording', !!lane.recording || clipArmed);

    const status = row.querySelector('.rail-status');
    // "A map is shaping time" (time_maps.md ruling 5): through-map
    // takes carry the ⟲ cue on the recording lane AND the mapping
    // group's rail. Clip arm/record state lives ENTIRELY in the sub-line
    // (the head row never reflows); the status word only carries the
    // group aggregates and the map cue.
    setText(status, lane.recording || clipArmed
        ? (lane.throughMap ? '⟲map' : '')
        : lane.kind === 'group'
            ? (lane.mapRecording ? '⟲ map live'
                : lane.groupArm.state !== 'none'
                    ? 'armed ' + (lane.groupArm.state === 'all' ? 'all' : 'some') : '')
            : '');

    const fold = row.querySelector('.fold-btn');
    if (fold) setText(fold, lane.folded ? '▸' : '▾');
    row.querySelector('.mute-btn').classList.toggle('on', lane.muted);
    row.querySelector('.solo-btn').classList.toggle('on', lane.soloed);

    // Delete is refused mid-take by the engine (cancel is the verb), so
    // disable it while recording/armed rather than offer a dead click.
    const del = row.querySelector('.delete-btn');
    if (del) {
        const busy = lane.recording || lane.armed;
        if (del.disabled !== busy) del.disabled = busy;
    }

    const fxBtn = row.querySelector('.fx-btn');
    if (fxBtn) {
        setText(fxBtn, lane.fxCount > 0 ? 'fx·' + lane.fxCount : 'fx');
        fxBtn.classList.toggle('on', lane.fxCount > 0);
    }

    // Period-source toggle (Q5): ↺ = loop, 1× = one-shot.
    const ps = row.querySelector('.oneshot-btn');
    if (ps) {
        setText(ps, lane.oneShot ? '1×' : '↺');
        const t = lane.oneShot
            ? 'One-shot: sounds once per cycle at its spot — click to loop'
            : 'Loops at its own length — click for one-shot ' +
              '(sounds once per cycle)';
        if (ps.title !== t) ps.title = t;
        ps.classList.toggle('on', !!lane.oneShot);
    }

    const input = row.querySelector('.input-btn');
    if (input && lane.isMidi) {
        // A MIDI track (phase 5) records notes from the keyboard into
        // its instrument — there is no audio input to pick. The chip
        // says so instead of offering a channel, and LIGHTS while this
        // lane is the keyboard's target (monitoring follows selection —
        // app.js syncMidiTarget; there is no arm toggle).
        setText(input, lane.midiArmed ? '♪ MIDI' : 'MIDI');
        const t = lane.midiArmed
            ? 'MIDI track — your keyboard plays this instrument now'
            : 'MIDI track — select it to play its instrument from your keyboard';
        if (input.title !== t) input.title = t;
        input.classList.add('midi');
        input.classList.toggle('on', !!lane.midiArmed);
        if (!input.disabled) input.disabled = true;
    } else if (input) {
        input.classList.remove('midi', 'on');
        // −1 = device default (no explicit assignment yet). A stereo
        // pair shows both channels, compact ("3/4" — the rail foot runs
        // at the rail's full width, no room for a prefix).
        const stereo = lane.inputChannelR >= 0;
        setText(input, stereo
            ? ((lane.inputChannel >= 0 ? lane.inputChannel : 0) + 1) +
              '/' + (lane.inputChannelR + 1)
            : lane.inputChannel >= 0 ? 'in ' + (lane.inputChannel + 1) : 'in ·');
        input.title = stereo
            ? 'Recording inputs (stereo pair) — click to choose'
            : 'Recording input — click to choose';
        // The take is being written from its input NOW — switching
        // mid-take is not a thing (the engine reads the channel per block)
        if (input.disabled !== !!lane.recording) input.disabled = !!lane.recording;
    }

    // Pan/gain dials: reflect the engine value unless the user is
    // mid-drag (_hot — the held-control guard vs the 50ms tick).
    const dial = row.querySelector('.pan-dial');
    if (dial && !dial._hot) setPanDial(dial, lane.pan || 0);
    const gdial = row.querySelector('.gain-dial');
    if (gdial && !gdial._hot) {
        setGainDial(gdial, typeof lane.gain === 'number' ? lane.gain : 1);
    }
}
