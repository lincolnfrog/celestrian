/**
 * Rail state: patch every rail control in place from the lane snapshot.
 * The rail is never rebuilt, and no write lands on a held control or an
 * open rename editor (context.js).
 */

import { setText, setTitle, fmtQ, MAX_INDENT_DEPTH } from './sv_util.js';
import { selection } from './selection.js';
import { setGainDial, setPanDial } from './dials.js';
import { patchFxRow } from './fx_row.js';
import { patchSeqGrid } from './seq_grid.js';
import { takeVerbOwner } from './take_menu.js';

/* The recording sub-line prints one decimal below this, whole Qs above:
 * "12.3Q…" does not fit the slot. */
const REC_LEN_DECIMAL_MAX_Q = 9.95;

/** The fx chip — a rail's, and the master strip's: the count of enabled
 * slots at rest, lit with any. */
export function patchFxChip(btn, count) {
    setText(btn, count > 0 ? 'fx·' + count : 'fx');
    btn.classList.toggle('on', count > 0);
}

/** The sequencer chip — a group rail's, and the root's (docs/
 * sequencer.md §9): 'seq' with no sequence, 'seq·NQ' with one, '⟲ step
 * N' while a step loops; lit while active, struck while bypassed,
 * marked while its passes drift. `seq` is the lane's (or root's) seq
 * summary, or null. */
export function patchSeqChip(btn, seq) {
    const looping = !!(seq && seq.auditionStep >= 0);
    setText(btn, seq
        ? (looping ? '⟲ step ' + (seq.auditionStep + 1)
                   : 'seq·' + fmtQ(seq.totalQ) + 'Q')
        : 'seq');
    btn.classList.toggle('on', !!(seq && !seq.bypassed));
    btn.classList.toggle('looping', looping);
    btn.classList.toggle('drift', !!(seq && seq.drift));
    btn.classList.toggle('bypassed', !!(seq && seq.bypassed));
}

/**
 * Patch one lane's rail: selection classes, name, Q-definer chip,
 * arm / take / mute / solo / delete / fx / seq / one-shot / input /
 * monitor states and tooltips, the sub-line (period ↔ live take length
 * ↔ armed), the status word, and the two dials.
 */
export function patchRail(row, lane, vm) {
    if (lane.kind === 'add') return; // affordance row: nothing to patch
    if (lane.kind === 'fx') return patchFxRow(row, lane);
    if (lane.kind === 'seq') return patchSeqGrid(row, lane, vm);
    row._lane = lane; // current lane snapshot for click handlers
    const railEl = row.querySelector('.lane-rail');
    if (railEl) railEl.classList.toggle('selected', selection.has(lane.id));
    row.classList.toggle('sel', selection.has(lane.id));
    row.dataset.depth = String(Math.min(lane.depth, MAX_INDENT_DEPTH));
    if (!row._renaming) setText(row.querySelector('.rail-name'), lane.name);
    const tempoChip = row.querySelector('.tempo-chip');
    if (tempoChip) {
        // LIT on the definer; an unlit OFFER (hover-revealed) on a lane
        // that could take Q (Q22, vm/definer.js canDefineNode).
        const offer = !lane.isQDefiner && !!lane.canDefine;
        const show = lane.isQDefiner || offer ? '' : 'none';
        if (tempoChip.style.display !== show) tempoChip.style.display = show;
        tempoChip.classList.toggle('offer', offer);
        setTitle(tempoChip, offer
            ? 'Hand Q to this track: its loop becomes the tempo (Q) and ' +
              'the grid moves to its top — nothing sounds different. Then ' +
              'drag its brackets to trim it, like a first take. Tracks ' +
              'whose length no longer fits drift (↯). Locks when you ' +
              'record another track; ⌘Z undoes.'
            : 'This track defines the loop length (Q — the tempo). Drag ' +
              'its handles in the lane to trim. Locks when you record ' +
              'another track.');
    }
    // ↯ DRIFTING (Q22): the loop's length fits no whole number of Qs —
    // it plays as recorded and lines up differently every pass.
    row.classList.toggle('drifting', !!lane.drifting);

    const arm = row.querySelector('.arm-btn');
    arm.classList.toggle('recording', lane.recording);
    if (lane.kind === 'group') {
        const g = lane.groupArm;
        arm.classList.toggle('on', g.state === 'all');
        arm.classList.toggle('some', g.state === 'some');
        arm.classList.toggle('retake', g.mode === 'retake');
        if (arm.disabled !== (g.armable === 0)) arm.disabled = g.armable === 0;
        setTitle(arm, g.armable === 0
            ? 'Nothing to record: no track here takes (loop a one-shot ↺ to take it again)'
            : g.mode === 'retake'
                ? `New take of ${g.armable} track${g.armable > 1 ? 's' : ''} — one performance from the group top (● again cancels)`
            : g.state === 'none'
                ? `Record all ${g.armable} empty track${g.armable > 1 ? 's' : ''} (full ones just play)`
                : 'Stop recording');
    } else {
        // The ● verb (view_model.armMode): stop / record / new take;
        // a committed one-shot has no slot top to take at. A mic of the
        // group that sets the tempo (the trim view's `definerMember`) has
        // no ● of its own: that group is one take, and its ● takes it.
        const mode = lane.armMode ?? (lane.armable ? 'record' : null);
        const groups = !!lane.definerMember && !lane.armable;
        arm.classList.toggle('on', lane.armed);
        arm.classList.toggle('retake', mode === 'retake' && !groups);
        if (arm.disabled !== !lane.armable) arm.disabled = !lane.armable;
        setTitle(arm, groups
            ? 'This track is part of the group that sets the tempo — take ' +
              'it again with the group’s ● (all its tracks, one performance)'
            : mode === null
            ? 'One-shot: loop it (↺) to record a new take'
            : mode === 'retake'
                ? 'New take — one period from the slot top; ● again cancels (⌘Z undoes a take)'
            : lane.retake
                ? (lane.recording && !lane.pendingStart
                    ? 'Cancel the new take (the previous take stands)'
                    : 'New take starts at the slot top — ● again cancels')
            : lane.recording ? 'Stop recording'
            : lane.armed ? 'Recording starts at the next Q boundary'
                : 'Record into this track');
    }

    // The TAKE chip (docs/takes.md): `T<active+1>/<n>` on committed
    // clips, quiet (hover-revealed) with one take, lit in comp mode.
    const takeBtn = row.querySelector('.take-btn');
    if (takeBtn) {
        const n = lane.takes || 0;
        const show = lane.kind === 'clip' && n > 0 ? '' : 'none';
        if (takeBtn.style.display !== show) takeBtn.style.display = show;
        setText(takeBtn, n > 1 ? 'T' + ((lane.activeTake || 0) + 1) + '/' + n : 'T1');
        takeBtn.classList.toggle('quiet', n < 2 && !lane.compMode);
        takeBtn.classList.toggle('on', !!lane.compMode);
        takeBtn.classList.toggle('comped', !!(lane.comp && lane.comp.length));
        setTitle(takeBtn, lane.compMode
            ? 'Close the comp editor (Esc)'
            : n > 1
                ? `Take ${(lane.activeTake || 0) + 1} of ${n} sounds — click for the list` +
                  (lane.comp && lane.comp.length ? ' (comped per Q cell)' : '')
                : 'One take — ' + takeVerbOwner(lane) +
                  ' records another; click for the list');
    }

    // THE SUB-LINE: the one slot on the rail with reserved room, so
    // whatever it says, nothing reflows (a word on the head row would
    // squeeze the name to an ellipsis). The period at rest; "armed"
    // while a clip waits to start; the live take length, pulsing
    // record-red, while it records.
    const sub = row.querySelector('.rail-sub');
    const recLen = lane.recordingLengthQ;
    const clipArmed = lane.kind === 'clip' && lane.armed && !lane.recording;
    if (lane.recording) {
        const len = Number.isFinite(recLen) && recLen > 0
            ? (recLen < REC_LEN_DECIMAL_MAX_Q
                ? recLen.toFixed(1) : Math.round(recLen)) + 'Q'
            : 'rec';
        setText(sub, len + (lane.awaitingStop ? '…' : ''));
    } else if (clipArmed) {
        setText(sub, 'armed');
    } else if (lane.driftShown && lane.periodQ > 0) {
        setText(sub, '↯ ' + fmtQ(lane.periodQ) + 'Q');
    } else if (lane.kind === 'group') {
        setText(sub, lane.periodQ > 0 ? fmtQ(lane.periodQ) + 'Q' : 'group');
    } else if (lane.periodQ > 0) {
        setText(sub, fmtQ(lane.periodQ) + 'Q');
    } else {
        setText(sub, 'empty');
    }
    sub.classList.toggle('recording', !!lane.recording || clipArmed);
    const drifting = !!lane.driftShown && !lane.recording && !clipArmed;
    sub.classList.toggle('drift', drifting);
    // THE FRAME-HEALTH BADGE (docs/sequencer.md §11.6), blowup face: this
    // lane's period is what explodes its scope's frame. Amber chip + a
    // tooltip naming the figure; the fix (if any) lives on the grid.
    const hb = lane.health || null;
    sub.classList.toggle('health-warn', !!hb);
    if (hb) {
        setTitle(sub, '⚠ ' + fmtQ(hb.responsiblePeriodQ) + 'Q beside ' +
            fmtQ(hb.othersQ) + 'Q makes the frame ' + fmtQ(hb.cycleQ) + 'Q (' +
            Math.round(hb.ratio) + '× the largest part)' +
            (hb.offerQ ? ' — snap to ' + fmtQ(hb.offerQ) + 'Q in the grid' : ''));
    } else if (drifting) {
        setTitle(sub, '↯ Drifting: this loop is ' + fmtQ(lane.periodQ) +
            'Q long, which fits no whole number of Qs, so every pass ' +
            'lines up a little differently against the grid. It plays ' +
            'exactly as recorded; the lane shows the pass you hear.');
    } else if (sub.title) {
        setTitle(sub, '');
    }

    // THE STATUS WORD carries only the group aggregates and the map cue
    // (time_maps.md ruling 5: a through-map take shows ⟲ on the
    // recording lane AND on the mapping group's rail). A clip's own
    // arm / record state is the sub-line's.
    const status = row.querySelector('.rail-status');
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

    // The engine refuses a delete mid-take (cancel is the verb), so the
    // button is disabled rather than a dead click.
    const del = row.querySelector('.delete-btn');
    if (del) {
        const busy = lane.recording || lane.armed;
        if (del.disabled !== busy) del.disabled = busy;
    }

    const fxBtn = row.querySelector('.fx-btn');
    if (fxBtn) patchFxChip(fxBtn, lane.fxCount);

    const seqBtn = row.querySelector('.seq-btn');
    if (seqBtn) {
        const s = lane.seq;
        patchSeqChip(seqBtn, s);
        setTitle(seqBtn, s
            ? (s.bypassed
                ? 'Sequencer (bypassed — the jam): click to open the grid'
                : 'Sequencer: ' + s.stepCount + ' step' +
                  (s.stepCount > 1 ? 's' : '') + ' · click to open the grid')
            : 'Sequencer: gate this group’s tracks over steps (the song grid)');
    }

    // Period-source toggle (Q5; clips and groups): ↺ = loop, 1× =
    // one-shot.
    const ps = row.querySelector('.oneshot-btn');
    if (ps) {
        setText(ps, lane.oneShot ? '1×' : '↺');
        const what = lane.kind === 'group' ? 'the whole group' : 'it';
        setTitle(ps, lane.oneShot
            ? 'One-shot: ' + what + ' sounds once per cycle at its spot ' +
              '— click to loop'
            : 'Loops at its own length — click for one-shot ' +
              '(' + what + ' sounds once per cycle)');
        ps.classList.toggle('on', !!lane.oneShot);
    }

    const input = row.querySelector('.input-btn');
    if (input && lane.isMidi) {
        // A MIDI track records notes from the keyboard into its
        // instrument: there is no audio input to pick. The chip says so,
        // and LIGHTS while this lane is the keyboard's target —
        // monitoring follows selection (app.js syncMidiTarget).
        setText(input, lane.midiArmed ? '♪ MIDI' : 'MIDI');
        setTitle(input, lane.midiArmed
            ? 'MIDI track — your keyboard plays this instrument now'
            : 'MIDI track — select it to play its instrument from your keyboard');
        input.classList.add('midi');
        input.classList.toggle('on', !!lane.midiArmed);
        if (!input.disabled) input.disabled = true;
    } else if (input) {
        input.classList.remove('midi', 'on');
        // −1 = the device default (nothing assigned). A stereo pair
        // shows both channels, compact ("3/4": no room for a prefix).
        const stereo = lane.inputChannelR >= 0;
        setText(input, stereo
            ? ((lane.inputChannel >= 0 ? lane.inputChannel : 0) + 1) +
              '/' + (lane.inputChannelR + 1)
            : lane.inputChannel >= 0 ? 'in ' + (lane.inputChannel + 1) : 'in ·');
        setTitle(input, stereo
            ? 'Recording inputs (stereo pair) — click to choose'
            : 'Recording input — click to choose');
        // A take is written from its input as it records: no switching
        // mid-take.
        if (input.disabled !== !!lane.recording) input.disabled = !!lane.recording;
    }

    // The monitoring chip (Q20): lit while the input is heard through
    // the track; the tooltip names the calibrated round trip (the
    // latency the monitored signal carries) or says none is measured.
    // Hidden on MIDI tracks — no audio input to hear.
    const mon = row.querySelector('.mon-btn');
    if (mon) {
        const show = lane.isMidi ? 'none' : '';
        if (mon.style.display !== show) mon.style.display = show;
        mon.classList.toggle('on', !!lane.monitor);
        const ms = vm.monitorLatencyMs;
        setTitle(mon, 'monitor input · ' +
            (ms == null ? 'not calibrated' : ms.toFixed(1) + ' ms'));
    }

    const dial = row.querySelector('.pan-dial');
    if (dial && !dial._hot) setPanDial(dial, lane.pan || 0);
    const gdial = row.querySelector('.gain-dial');
    if (gdial && !gdial._hot) {
        setGainDial(gdial, typeof lane.gain === 'number' ? lane.gain : 1);
    }
}
