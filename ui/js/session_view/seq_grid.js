/**
 * THE SEQUENCER GRID (docs/sequencer.md §9, S15 — "the pad grid is the
 * one control, at every depth"): a synthetic row under a stack lane
 * (the fx-row expansion pattern). Rows = the stack's direct children,
 * columns = steps, pads = gates.
 *
 * TIME-HONEST LAYOUT (owner feedback 2026-08-20): the pads live in the
 * lane-body column and span its full width, so step boundaries sit ON
 * the shared time axis — a 2Q step ends exactly where 2Q is on the
 * ruler (I2 in spirit). Row names live in the RAIL column (mirrored
 * fixed-height rows), and the append verb lives in the footer, so
 * nothing non-temporal steals width from the timeline.
 *
 * Grammar (ruled): pad click = toggle · drag across pads = paint ·
 * row-name click = whole-row toggle · header dblclick = rename ·
 * header grip drag = resize (cycle-multiple snap default, ⌥ = whole-Q)
 * · header right-click = delete step · footer ＋ = append (one inner
 * cycle) · footer chip = bypass toggle (the jam comes back) · header ⟲
 * = LOOP THIS STEP (the step audition, docs/sequencer.md §11.2: the
 * song folds to the step — audition it, or arm a track and record INTO
 * it; click ⟲ again or Esc to stop).
 *
 * One setSequence per finished gesture = one undo step (engine-side).
 * The grid REBUILDS when its shape signature changes and only patches
 * the playing-column highlight otherwise (the keyed-reconcile law).
 */

import { ctx } from './context.js';
import { el, setText, fmtQ } from './sv_util.js';
import { kBlowupRatio, cycleMinutes, fmtDuration } from '../frame_health.js';
import { lcm } from '../math_utils.js';

/** Build the synthetic grid row once; content renders in patch. */
export function buildSeqGrid(row, lane) {
    row.classList.add('lane-seq');
    row.dataset.depth = String(Math.min(lane.depth, 2));
    const rail = el('div', 'seq-rail');
    const body = el('div', 'seq-body');
    row.append(rail, body);
    row._seqSig = null;
    return row;
}

/** The current sequence as a bridge payload (steps in samples). */
function payloadOf(lane, quantum, mutate) {
    const p = {
        steps: lane.steps.map(s => ({
            name: s.name, len: Math.round(s.lenQ * quantum),
            cue: !!s.cue })),
        gates: {},
    };
    lane.children.forEach(c => { p.gates[c.id] = c.gates.slice(); });
    if (mutate) mutate(p);
    // Drop rows that are all-ON (absent = inherit ON — keeps new
    // tracks audible everywhere by default, engine parity).
    for (const [id, bits] of Object.entries(p.gates)) {
        if (bits.every(Boolean)) delete p.gates[id];
    }
    return p;
}

function commit(row, mutate) {
    const lane = row._lane;
    if (!lane || !lane.editable) return;
    const p = payloadOf(lane, row._quantum, mutate);
    ctx.cb.onSetSequence(lane.ownerId, p);
    // Optimistic local apply, so successive gestures inside one poll
    // COMPOSE (a fast double-click on "+ step" adds two steps, not one
    // twice). The next poll's published state confirms and rebuilds.
    lane.steps = p.steps.map(s => ({
        name: s.name, lenQ: s.len / row._quantum, cue: !!s.cue }));
    lane.totalQ = lane.steps.reduce((t, x) => t + x.lenQ, 0);
    lane.children.forEach(c => {
        const bits = p.gates[c.id];
        c.gates = bits ? bits.slice() : lane.steps.map(() => true);
    });
}

/** Patch: rebuild on shape change; highlight the playing column. */
export function patchSeqGrid(row, lane, vm) {
    row._lane = lane;
    row._quantum = vm.quantum;
    row._sampleRate = vm.sampleRate || 44100;
    row.classList.toggle('bypassed', !!lane.bypassed);
    row.classList.toggle('locked', !lane.editable);

    const sig = JSON.stringify({
        s: lane.steps, b: lane.bypassed, e: lane.editable,
        c: lane.children.map(c => [c.id, c.name, c.gates]),
        q: lane.qEstablished, a: lane.auditionStep, h: lane.health || null,
    });
    row.classList.toggle('auditioning', lane.auditionStep >= 0);
    if (row._seqSig !== sig) {
        row._seqSig = sig;
        rebuild(row, lane);
    }

    // The playing column: the owner's sequence phase. The frame equals
    // the song when the sequence defines it (period law), so the
    // playhead's fold names the step.
    const body = row.querySelector('.seq-body');
    if (lane.steps.length && lane.totalQ > 0 && vm.isPlaying &&
        !lane.bypassed) {
        const rel = ((vm.playheadQ % lane.totalQ) + lane.totalQ) % lane.totalQ;
        let pos = 0, playing = -1;
        lane.steps.forEach((s, i) => {
            if (playing < 0 && rel < pos + s.lenQ) playing = i;
            pos += s.lenQ;
        });
        body.querySelectorAll('[data-step]').forEach(cell => {
            cell.classList.toggle('playing',
                Number(cell.dataset.step) === playing);
        });
    } else {
        body.querySelectorAll('[data-step].playing')
            .forEach(c => c.classList.remove('playing'));
    }
}

function rebuild(row, lane) {
    const rail = row.querySelector('.seq-rail');
    const body = row.querySelector('.seq-body');
    rail.textContent = '';
    body.textContent = '';

    // The rail column mirrors the body's rows at fixed heights: the
    // label sits beside the header row, one name beside each pad row.
    rail.appendChild(el('div', 'seq-rail-label mono',
        { textContent: 'SEQUENCER' }));

    if (!lane.steps.length) {
        // No sequence yet: the creation affordance — one step of one
        // inner cycle (the degenerate jam sequence, ready to split).
        const start = el('button', 'seq-start mono', {
            textContent: '＋ start a sequence (1 step · ' +
                fmtQ(lane.innerCycleQ) + 'Q)',
            title: 'Creates a one-step sequence over this group — ' +
                   'then split and gate it into a song',
        });
        start.addEventListener('click', () => {
            const l = row._lane;
            ctx.cb.onSetSequence(l.ownerId, {
                steps: [{ name: 'A',
                          len: Math.round(l.innerCycleQ * row._quantum) }],
                gates: {},
            });
        });
        body.appendChild(start);
        return;
    }

    const totalQ = lane.totalQ > 0 ? lane.totalQ : 1;

    // EXACT time positions (the pct() idiom every timeline overlay
    // uses): cells are absolutely positioned by left/width percent, so
    // a 2Q step's boundary sits ON 2Q of the ruler — flex-grow skews
    // boundaries by each cell's constant padding.
    const startsQ = [];
    {
        let pos = 0;
        lane.steps.forEach(s => { startsQ.push(pos); pos += s.lenQ; });
    }
    const place = (elx, i) => {
        elx.style.left = (startsQ[i] / totalQ * 100) + '%';
        elx.style.width =
            'calc(' + (lane.steps[i].lenQ / totalQ * 100) + '% - 4px)';
    };

    // Header row: step cells only — full body width IS the time axis.
    const head = el('div', 'seq-grid-row seq-head');
    lane.steps.forEach((s, i) => {
        const cell = el('div', 'seq-hcell mono');
        cell.dataset.step = String(i);
        place(cell, i);
        const nm = el('span', 'seq-hname',
            { textContent: s.name || String(i + 1) });
        nm.title = 'Double-click to rename · right-click to delete step';
        nm.addEventListener('dblclick', () => renameStep(row, cell, i));
        const len = el('span', 'seq-hlen', { textContent: fmtQ(s.lenQ) + 'Q' });
        // \u21e4 — CUE (S22, ruled 2026-08-27): a per-step pip on the
        // header toggles gate-mode <-> cue-mode. A cued step re-bases
        // its span to the SONG TOP (docs/sequencer.md ss3 — the serial
        // primitive: verse-box then chorus-box). Rides setSequence
        // (one undo step, whole-object swap).
        const cued = !!s.cue;
        const cue = el('button', 'seq-cue mono', {
            textContent: '\u21e4',
            title: cued
                ? 'Cued: this step replays the song top - click to ' +
                  'return it to gate mode (in-phase)'
                : 'Cue this step: play everything from the song top on ' +
                  'entry (chain parts like verse -> chorus)',
        });
        cue.classList.toggle('on', cued);
        cue.addEventListener('click', e => {
            e.stopPropagation();
            commit(row, p => { p.steps[i].cue = !p.steps[i].cue; });
        });
        cell.classList.toggle('cued', cued);
        // The resize grip: a VISIBLE handle (the bracket vocabulary —
        // it was a 3px hairline nobody found; owner field report
        // 2026-08-20b: "we do need a way to lengthen each section").
        const grip = el('span', 'seq-grip', {
            title: 'Drag to resize this step (snaps to whole cycles; ' +
                   '⌥ = whole Q)' });
        grip.appendChild(el('span', 'seq-grip-bar'));
        wireGrip(grip, row, i);
        // ⟲ — the STEP AUDITION (§11.2): loop this step. Visible on
        // hover; lit while looping. Not undoable (monitoring).
        const looping = lane.auditionStep === i;
        const loop = el('button', 'seq-loop mono', {
            textContent: looping ? '⟲ looping' : '⟲',
            title: looping
                ? 'Looping this step — click (or Esc) to stop'
                : 'Loop this step: audition it, or arm a track and ' +
                  'record into it (Esc stops)',
        });
        loop.classList.toggle('on', looping);
        loop.addEventListener('click', e => {
            e.stopPropagation();
            const l = row._lane;
            if (!l.editable && l.auditionStep !== i) return;
            ctx.cb.onAuditionStep(l.ownerId, looping ? -1 : i);
        });
        cell.classList.toggle('looping', looping);
        cell.append(nm, len, cue, loop, grip);
        cell.addEventListener('contextmenu', e => {
            e.preventDefault();
            deleteStep(row, i);
        });
        head.appendChild(cell);
    });
    body.appendChild(head);

    // Pad rows in the body; the matching name in the rail column.
    lane.children.forEach((child, ci) => {
        const nm = el('div', 'seq-rowname', { textContent: child.name });
        nm.dataset.child = String(ci);
        nm.title = 'Click: toggle the whole row';
        nm.addEventListener('click', () => {
            const c = row._lane.children[ci];
            if (!c) return;
            const allOn = c.gates.every(Boolean);
            commit(row, p => { p.gates[c.id] = c.gates.map(() => !allOn); });
        });
        rail.appendChild(nm);

        const r = el('div', 'seq-grid-row');
        child.gates.forEach((on, i) => {
            const col = el('div', 'seq-col');
            col.dataset.step = String(i);
            place(col, i);
            const pad = el('button', 'seq-pad');
            pad.classList.toggle('on', on);
            pad.title = (on ? 'On' : 'Off') + ' — click to toggle, drag to paint';
            pad.addEventListener('pointerdown', e => {
                e.preventDefault();
                row._paint = !child.gates[i];
                paintPad(row, child.id, i, row._paint);
            });
            pad.addEventListener('pointerenter', () => {
                if (row._paint !== undefined && row._paint !== null) {
                    paintPad(row, child.id, i, row._paint);
                }
            });
            col.appendChild(pad);
            r.appendChild(col);
        });
        body.appendChild(r);
    });
    if (!body._paintEnd) {
        body._paintEnd = true;
        document.addEventListener('pointerup',
            () => { row._paint = null; });
    }

    // Footer: totals on the left; the append verb + bypass toggle in a
    // RIGHT cluster (the nav-dock pattern: action chrome right-aligned
    // under the row, directly below where the song ends — the owner's
    // eye lands there after the last step).
    const foot = el('div', 'seq-foot mono');
    foot.appendChild(el('span', 'seq-total',
        { textContent: 'seq · ' + fmtQ(totalQ) + 'Q' }));
    if (!row._lane.editable) {
        foot.appendChild(el('span', 'seq-lock',
            { textContent: '● recording — sequence locked' }));
    }
    // THE FRAME-HEALTH BADGE (docs/sequencer.md §11.6): only when an
    // edit warrants it — the blowup face (this song's length explodes
    // the parent frame) and the drift face (passes differ). Each offer
    // is one click: the delta lands on the LAST step (the append unit
    // in reverse), one setSequence, undoable.
    if (lane.health) {
        const h = lane.health;
        const snapTo = totalTargetQ => {
            const delta = totalTargetQ - lane.totalQ;
            commit(row, p => {
                const last = p.steps[p.steps.length - 1];
                last.len = Math.max(row._quantum,
                    Math.round((last.len / row._quantum + delta) * row._quantum));
            });
        };
        if (h.blowup) {
            const b = h.blowup;
            const mins = fmtDuration(cycleMinutes(
                b.cycleQ, row._quantum, row._sampleRate || 44100));
            const badge = el('span', 'seq-health seq-health-blowup', {
                textContent: '⚠ ' + fmtQ(b.responsiblePeriodQ) + 'Q → parent ×' +
                    fmtQ(b.cycleQ) + ' (' + mins + ')',
                title: 'This song\'s length makes the enclosing frame ' +
                    fmtQ(b.cycleQ) + 'Q — ' + Math.round(b.ratio) +
                    '× its largest member (coprime lengths LCM)' });
            foot.appendChild(badge);
            if (b.offerQ) {
                const fix = el('button', 'seq-health-fix', {
                    textContent: 'snap to ' + fmtQ(b.offerQ) + 'Q',
                    title: 'Resize the last step so the song agrees with its siblings' });
                fix.addEventListener('click', () => snapTo(b.offerQ));
                foot.appendChild(fix);
            }
        }
        if (h.drift) {
            const d = h.drift;
            const badge = el('span', 'seq-health seq-health-drift', {
                textContent: '↯ drifting · ' + fmtQ(d.seqLenQ) + 'Q over ' +
                    fmtQ(d.innerQ) + 'Q',
                title: 'The song is not a whole number of inner cycles: each ' +
                    'pass frames different bars (deliberate? fine — it is ' +
                    'badged, never silent)' });
            foot.appendChild(badge);
            d.offers.filter(Boolean).forEach(q => {
                const fix = el('button', 'seq-health-fix', {
                    textContent: 'snap to ' + fmtQ(q) + 'Q',
                    title: 'Resize the last step so every pass repeats identically' });
                fix.addEventListener('click', () => snapTo(q));
                foot.appendChild(fix);
            });
        }
    }
    const right = el('span', 'seq-foot-right');
    const add = el('button', 'seq-addstep', {
        textContent: '＋ step · ' + fmtQ(lane.innerCycleQ) + 'Q',
        title: 'Append a step (one cycle of the loops — drag its right ' +
               'edge to stretch it)' });
    add.addEventListener('click', () => {
        const l = row._lane;
        commit(row, p => {
            p.steps.push({
                name: '', len: Math.round(l.innerCycleQ * row._quantum) });
            for (const bits of Object.values(p.gates)) bits.push(true);
        });
    });
    const byp = el('button', 'seq-bypass', {
        textContent: lane.bypassed ? '⊘ bypassed · click to activate'
                                   : '⟳ active · click to bypass',
        title: 'Bypassed = the jam (everything sounds); the sequence ' +
               'geometry is kept' });
    byp.addEventListener('click',
        () => ctx.cb.onToggleSequenceBypass(row._lane.ownerId));
    right.append(add, byp);
    foot.appendChild(right);
    body.appendChild(foot);
}

function paintPad(row, childId, step, on) {
    const child = row._lane.children.find(c => c.id === childId);
    if (!child || child.gates[step] === on) return;
    commit(row, p => {
        const bits = p.gates[childId] ||
            row._lane.steps.map(() => true);
        bits[step] = on;
        p.gates[childId] = bits;
    });
}

function deleteStep(row, i) {
    const lane = row._lane;
    if (lane.steps.length <= 1) {
        // Deleting the last step clears the sequence entirely.
        ctx.cb.onSetSequence(lane.ownerId, null);
        return;
    }
    commit(row, p => {
        p.steps.splice(i, 1);
        for (const bits of Object.values(p.gates)) bits.splice(i, 1);
    });
}

function renameStep(row, cell, i) {
    if (cell._editing) return;
    cell._editing = true;
    const nm = cell.querySelector('.seq-hname');
    const input = el('input', 'seq-hname-input', { type: 'text' });
    input.value = row._lane.steps[i].name || '';
    input.maxLength = 24;
    nm.style.display = 'none';
    nm.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = ok => {
        if (done) return;
        done = true;
        const next = input.value.trim();
        input.remove();
        nm.style.display = '';
        cell._editing = false;
        if (ok) commit(row, p => { p.steps[i].name = next; });
    };
    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

/** Step resize: pointer drag on the grip; live flex preview; ONE
 * setSequence on release. Snap: whole inner cycles (S2 default);
 * ⌥ = whole Qs. Minimum 1Q. */
function wireGrip(grip, row, i) {
    grip.addEventListener('pointerdown', e => {
        e.preventDefault();
        e.stopPropagation();
        const lane = row._lane;
        if (!lane || !lane.editable) return;
        const cell = grip.parentElement;
        const gridRow = cell.parentElement;
        const rowW = gridRow.getBoundingClientRect().width;
        const totalQ = lane.totalQ > 0 ? lane.totalQ : 1;
        const qPerPx = totalQ / Math.max(1, rowW);
        const startX = e.clientX;
        const startLenQ = lane.steps[i].lenQ;
        grip.setPointerCapture(e.pointerId);
        let liveLenQ = startLenQ;
        const onMove = ev => {
            const cyc = Math.max(1, lane.innerCycleQ);
            const rawQ = startLenQ + (ev.clientX - startX) * qPerPx;
            liveLenQ = ev.altKey
                ? Math.max(1, Math.round(rawQ))
                : Math.max(cyc, Math.round(rawQ / cyc) * cyc);
            // Live preview: recompute EVERY cell's exact time position
            // (the total changes, so every boundary moves).
            const stepsQ = lane.steps.map(
                (s, k) => (k === i ? liveLenQ : s.lenQ));
            const newTotal = stepsQ.reduce((a, b) => a + b, 0) || 1;
            let pos = 0;
            const lefts = stepsQ.map(l => { const x = pos; pos += l; return x; });
            row.querySelectorAll('.seq-hcell, .seq-col').forEach(c => {
                const k = Number(c.dataset.step);
                c.style.left = (lefts[k] / newTotal * 100) + '%';
                c.style.width =
                    'calc(' + (stepsQ[k] / newTotal * 100) + '% - 4px)';
            });
            // LIVE frame-health readout (§11.6): warn as soon as the
            // provisional song length would blow up the parent frame
            // (⚠) or drift against the inner cycle (↯).
            let warn = '';
            if (lane.parentOthersQ > 0) {
                const cyc2 = lcm(Math.round(lane.parentOthersQ), Math.round(newTotal));
                const largest = Math.max(lane.parentLargestQ || 0, newTotal);
                if (cyc2 > kBlowupRatio * largest) warn += ' ⚠';
            }
            if (lane.innerCycleQ > 0 && Math.round(newTotal) % lane.innerCycleQ !== 0) {
                warn += ' ↯';
            }
            setText(cell.querySelector('.seq-hlen'), fmtQ(liveLenQ) + 'Q' + warn);
        };
        const onUp = ev => {
            grip.releasePointerCapture(e.pointerId);
            grip.removeEventListener('pointermove', onMove);
            grip.removeEventListener('pointerup', onUp);
            if (liveLenQ !== startLenQ) {
                commit(row, p => {
                    p.steps[i].len = Math.round(liveLenQ * row._quantum);
                });
            }
        };
        grip.addEventListener('pointermove', onMove);
        grip.addEventListener('pointerup', onUp);
    });
}
