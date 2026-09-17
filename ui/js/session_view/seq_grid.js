/**
 * THE SEQUENCER GRID (docs/sequencer.md §9, S15 — "the pad grid is the
 * one control, at every depth"): a synthetic row under a stack lane
 * (the fx-row expansion pattern). Rows = the stack's direct children,
 * columns = the PROGRAM's visits, pads = gates.
 *
 * TIME-HONEST LAYOUT: the pads live in the lane-body column and span
 * its full width, so visit boundaries sit ON the shared time axis — a
 * 2Q step ends exactly where 2Q is on the ruler (I2 in spirit). Row
 * names live in the RAIL column (mirrored fixed-height rows), and the
 * append verb lives in the footer, so nothing non-temporal steals
 * width from the timeline.
 *
 * THE PROGRAM (§14): the walk from step 0 through each step's
 * successors. While the program is PERIODIC the columns are its visits
 * in program order (a deterministic loop plays each step at most once,
 * so a column IS a step, time-honest). A RADIO unrolls to the horizon
 * — hundreds of visits — so its grid shows the GRAPH instead: one
 * equal-width column per step in list order; the lanes remain the
 * honest timeline. A step the program never reaches has no column —
 * it waits in the footer as an orphan chip until it is re-linked or
 * deleted.
 *
 * Grammar (ruled): pad click = toggle · drag across pads = paint ·
 * row-name click = whole-row toggle · header dblclick = rename ·
 * header grip drag = resize (cycle-multiple snap default, ⌥ = whole-Q)
 * · header right-click = delete step · footer ＋ = append (one inner
 * cycle) · footer chip = bypass toggle (the jam comes back) · header ⟲
 * = LOOP THIS STEP (the step audition, docs/sequencer.md §11.2: the
 * song folds to the step — audition it, or arm a track and record INTO
 * it; click ⟲ again or Esc to stop) · header → = the SUCCESSORS
 * popover (which steps may follow, with weights — a branch with
 * chance makes the song a RADIO) · footer ⟳ re-roll = a new seed.
 *
 * One setSequence per finished gesture = one undo step (engine-side).
 * The grid REBUILDS when its shape signature changes and only patches
 * the playing-column highlight otherwise (the keyed-reconcile law).
 */

import { ctx } from './context.js';
import { el, setText, fmtQ } from './sv_util.js';
import { kBlowupRatio, cycleMinutes, fmtDuration } from '../frame_health.js';
import { lcm, posMod } from '../math_utils.js';
import { programOf, randomSeed } from '../sequence_program.js';

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
            cue: !!s.cue,
            ...(s.next && s.next.length
                ? { next: s.next.map(n => ({ to: n.to, w: n.w })) } : {}),
            ...(s.fadeInQ > 0 ? { fadeIn: Math.round(s.fadeInQ * quantum) } : {}),
            ...(s.fadeOutQ > 0 ? { fadeOut: Math.round(s.fadeOutQ * quantum) } : {}),
        })),
        gates: {},
        seed: lane.seed >>> 0,
    };
    lane.children.forEach(c => { p.gates[c.id] = c.gates.slice(); });
    if (mutate) mutate(p);
    // Drop rows that are all-ON (absent = inherit ON — keeps new
    // tracks audible everywhere by default, engine parity).
    for (const [id, bits] of Object.entries(p.gates)) {
        if (bits.every(Boolean)) delete p.gates[id];
    }
    // Canonical successors: an empty list IS the loop successor.
    p.steps.forEach(s => { if (s.next && !s.next.length) delete s.next; });
    return p;
}

/** The visit columns of a step list (Q units) — the VM's shape. */
function visitsOf(steps, seed) {
    const prog = programOf(steps, seed);
    const visits = [];
    let pos = 0;
    prog.visits.forEach(i => {
        visits.push({ step: i, startQ: pos, lenQ: steps[i].lenQ });
        pos += steps[i].lenQ;
    });
    return { visits, totalQ: pos, radio: prog.radio,
             reachable: steps.map((_, i) => !!prog.reachable[i]) };
}

/**
 * The grid's COLUMNS: [{step, start, len}] over a `total` — the visits
 * (time-honest, in Q) while the program is periodic; the reachable
 * STEPS at equal widths (the graph) for a radio.
 */
function columnsOf(lane) {
    if (!lane.radio) {
        return { cols: (lane.visits || []).map(v => ({
                     step: v.step, start: v.startQ, len: v.lenQ })),
                 total: lane.totalQ > 0 ? lane.totalQ : 1 };
    }
    const cols = [];
    lane.steps.forEach((s, i) => {
        if (lane.reachable && !lane.reachable[i]) return;
        cols.push({ step: i, start: cols.length, len: 1 });
    });
    return { cols, total: Math.max(1, cols.length) };
}

/** The column that is PLAYING at `rel` (Q into the program), or −1. */
function playingColumn(lane, rel) {
    let visit = -1;
    (lane.visits || []).forEach((v, k) => {
        if (visit < 0 && rel < v.startQ + v.lenQ) visit = k;
    });
    if (visit < 0) return -1;
    if (!lane.radio) return visit;
    const step = lane.visits[visit].step;
    return columnsOf(lane).cols.findIndex(c => c.step === step);
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
        name: s.name, lenQ: s.len / row._quantum, cue: !!s.cue,
        next: s.next ? s.next.map(n => ({ ...n })) : [],
        fadeInQ: (s.fadeIn || 0) / row._quantum,
        fadeOutQ: (s.fadeOut || 0) / row._quantum }));
    lane.seed = p.seed >>> 0;
    Object.assign(lane, visitsOf(lane.steps, lane.seed));
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
    row.classList.toggle('radio', !!lane.radio);

    const sig = JSON.stringify({
        s: lane.steps, v: lane.visits, b: lane.bypassed, e: lane.editable,
        c: lane.children.map(c => [c.id, c.name, c.gates]),
        q: lane.qEstablished, a: lane.auditionStep, h: lane.health || null,
        r: lane.radio, d: lane.seed,
    });
    row.classList.toggle('auditioning', lane.auditionStep >= 0);
    if (row._seqSig !== sig) {
        row._seqSig = sig;
        rebuild(row, lane);
    }

    // The playing column: the owner's program phase. The frame equals
    // the program when the sequence defines it (period law), so the
    // playhead's fold names the visit.
    const body = row.querySelector('.seq-body');
    if (lane.visits.length && lane.totalQ > 0 && vm.isPlaying &&
        !lane.bypassed) {
        // The song is anchored at its owner's frame origin (Q18: a
        // group's origin; the root's, the zero its song was authored
        // on — frame.md §4) — `phaseQ` is that
        // origin in the lane frame, so the column follows what the
        // engine actually gates (the grid you see is the grid you hear).
        const rel = posMod(vm.playheadQ - (lane.phaseQ || 0), lane.totalQ);
        const playing = playingColumn(lane, rel);
        body.querySelectorAll('[data-col]').forEach(cell => {
            cell.classList.toggle('playing',
                Number(cell.dataset.col) === playing);
        });
    } else {
        body.querySelectorAll('[data-col].playing')
            .forEach(c => c.classList.remove('playing'));
    }
}

function rebuild(row, lane) {
    const rail = row.querySelector('.seq-rail');
    const body = row.querySelector('.seq-body');
    rail.textContent = '';
    body.textContent = '';
    closeNextPopover(row);

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
    const { cols, total } = columnsOf(lane);
    row._cols = cols;

    // EXACT time positions (the pct() idiom every timeline overlay
    // uses): cells are absolutely positioned by left/width percent, so
    // a 2Q step's boundary sits ON 2Q of the ruler — flex-grow skews
    // boundaries by each cell's constant padding. (A radio's columns
    // are the graph at equal widths — §14.)
    const place = (elx, k) => {
        elx.style.left = (cols[k].start / total * 100) + '%';
        elx.style.width =
            'calc(' + (cols[k].len / total * 100) + '% - 4px)';
    };

    // Header row: one cell per COLUMN — full body width IS the time axis.
    const head = el('div', 'seq-grid-row seq-head');
    cols.forEach((c, k) => {
        const i = c.step;
        const s = lane.steps[i];
        const cell = el('div', 'seq-hcell mono');
        cell.dataset.col = String(k);
        cell.dataset.step = String(i);
        place(cell, k);
        const nm = el('span', 'seq-hname',
            { textContent: s.name || String(i + 1) });
        nm.title = 'Double-click to rename · right-click to delete step';
        nm.addEventListener('dblclick', () => renameStep(row, cell, i));
        // The length chip: click = the FADES popover (S13, §15). The
        // markers show a fade in (◢) / out (◣) on the step.
        const len = el('span', 'seq-hlen', {
            textContent: (s.fadeInQ > 0 ? '◢' : '') + fmtQ(s.lenQ) + 'Q' +
                         (s.fadeOutQ > 0 ? '◣' : ''),
            title: 'Click: fade this step in / out (in Q)' });
        len.addEventListener('click', e => {
            e.stopPropagation();
            openFadePopover(row, cell, i);
        });
        // ⇤ — CUE (S22): a per-step pip on the header toggles
        // gate-mode <-> cue-mode. A cued step re-bases
        // its span to the SONG TOP (docs/sequencer.md ss3 — the serial
        // primitive: verse-box then chorus-box). Rides setSequence
        // (one undo step, whole-object swap).
        const cued = !!s.cue;
        const cue = el('button', 'seq-cue mono', {
            textContent: '⇤',
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
        // → — SUCCESSORS (§14): which steps may follow this one. Lit
        // when the step names its own successors (the default is the
        // next step in the list).
        const next = successorPip(row, cell, i);
        // The resize grip: a VISIBLE handle (the bracket vocabulary —
        // a hairline is not discoverable).
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
        cell.append(nm, len, cue, next, loop, grip);
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
        cols.forEach((c, k) => {
            const i = c.step;
            const on = !!child.gates[i];
            const col = el('div', 'seq-col');
            col.dataset.col = String(k);
            col.dataset.step = String(i);
            place(col, k);
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
        { textContent: (lane.radio ? 'radio · ' : 'seq · ') +
                       fmtQ(totalQ) + 'Q' }));
    if (!row._lane.editable) {
        foot.appendChild(el('span', 'seq-lock',
            { textContent: '● recording — sequence locked' }));
    }
    // THE RADIO (§6, §14): a period-less program. The seed IS the
    // performance — shown so a run can be named; ⟳ re-rolls it (one
    // setSequence, one undo step).
    if (lane.radio) {
        const seedHex = (lane.seed >>> 0).toString(16).padStart(8, '0');
        foot.appendChild(el('span', 'seq-radio', {
            textContent: '📻 radio · seed ' + seedHex,
            title: 'This song branches (or never returns to its top), so ' +
                'it has no period — the seed decides every branch; the ' +
                'same seed always plays the same run. ' +
                'It repeats after ' + (lane.visits || []).length +
                ' steps. The grid shows the graph; the lanes show the ' +
                'run.' }));
        const reroll = el('button', 'seq-reroll', {
            textContent: '⟳ re-roll',
            title: 'A new seed: a new run of the same song (undoable)' });
        reroll.addEventListener('click', () => {
            commit(row, p => { p.seed = randomSeed(); });
        });
        foot.appendChild(reroll);
    }
    // ORPHANS (§14): steps the program never reaches have no column.
    // They wait here — click to re-link (the successors popover),
    // right-click to delete.
    lane.steps.forEach((s, i) => {
        if (lane.reachable && lane.reachable[i]) return;
        const chip = el('button', 'seq-orphan mono', {
            textContent: '⤳ ' + (s.name || String(i + 1)),
            title: 'Unreachable: no step leads here. Click to choose ' +
                'what follows it, then point a step at it (or ' +
                'right-click to delete it)' });
        chip.dataset.step = String(i);
        chip.addEventListener('click', e => {
            e.stopPropagation();
            openNextPopover(row, chip, i);
        });
        chip.addEventListener('contextmenu', e => {
            e.preventDefault();
            deleteStep(row, i);
        });
        foot.appendChild(chip);
    });
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

/** The → pip on a header cell: opens the successors popover. */
function successorPip(row, cell, i) {
    const s = row._lane.steps[i];
    const explicit = !!(s.next && s.next.length);
    const pip = el('button', 'seq-next mono', {
        textContent: '→',
        title: explicit
            ? 'This step names what follows it — click to edit ' +
              '(several with weights = a branch with chance: a radio)'
            : 'What follows this step? (default: the next step; ' +
              'several with weights = a branch with chance: a radio)',
    });
    pip.classList.toggle('on', explicit);
    pip.addEventListener('click', e => {
        e.stopPropagation();
        openNextPopover(row, cell, i);
    });
    return pip;
}

/** The effective successor list of step i: explicit, else the loop. */
function candidatesOf(lane, i) {
    const s = lane.steps[i];
    if (s.next && s.next.length) return s.next.map(n => ({ ...n }));
    return [{ to: (i + 1) % lane.steps.length, w: 1 }];
}

function closeNextPopover(row) {
    if (row._nextPop) {
        row._nextPop.remove();
        row._nextPop = null;
    }
    if (row._nextPopOff) {
        document.removeEventListener('pointerdown', row._nextPopOff, true);
        row._nextPopOff = null;
    }
}

/**
 * THE SUCCESSORS POPOVER (§14): one row per step — a toggle (is it a
 * candidate to follow step i?) and, when on, its weight. Every change
 * is one setSequence (one undo step, the pad-toggle precedent). The
 * default (only the next step, weight 1) stores as NO explicit list.
 */
function openNextPopover(row, anchor, i) {
    const lane = row._lane;
    if (!lane || !lane.editable) return;
    if (row._nextPop && row._nextPop._step === i &&
        row._nextPop._kind === 'next') {
        closeNextPopover(row);
        return;
    }
    closeNextPopover(row);
    const pop = el('div', 'seq-next-pop mono');
    pop._step = i;
    pop._kind = 'next';
    pop.dataset.step = String(i);
    const name = lane.steps[i].name || String(i + 1);
    pop.appendChild(el('div', 'seq-next-title', {
        textContent: 'after ' + name + ' →' }));
    const current = candidatesOf(lane, i);
    const write = list => {
        const n = lane.steps.length;
        const canonical = list.length === 1 && list[0].to === (i + 1) % n &&
                          list[0].w === 1;
        commit(row, p => {
            if (canonical) delete p.steps[i].next;
            else p.steps[i].next = list.map(x => ({ to: x.to, w: x.w }));
        });
        closeNextPopover(row);
    };
    lane.steps.forEach((s, j) => {
        const line = el('div', 'seq-next-line');
        const entry = current.find(c => c.to === j);
        // The name = "ONLY this follows" (a single successor — legal
        // anywhere); ＋/− = add or drop it as a BRANCH candidate (two
        // or more make the song a radio: root only). Re-routing a
        // nested song never has to pass through a branch.
        const opt = el('button', 'seq-next-opt', {
            textContent: (s.name || String(j + 1)) + (j === i ? ' (again)' : ''),
            title: 'Click: ONLY ' + (s.name || String(j + 1)) +
                   ' follows ' + name });
        opt.dataset.to = String(j);
        opt.classList.toggle('on', !!entry);
        opt.addEventListener('click', e => {
            e.stopPropagation();
            write([{ to: j, w: entry ? entry.w : 1 }]);
        });
        const add = el('button', 'seq-next-add mono', {
            textContent: entry ? '−' : '＋',
            title: entry
                ? 'Drop this branch'
                : 'Add as a branch: ' + name + ' may go here OR elsewhere ' +
                  '(a chance = a radio, root only)' });
        add.dataset.to = String(j);
        add.addEventListener('click', e => {
            e.stopPropagation();
            const list = current.filter(c => c.to !== j);
            if (!entry) list.push({ to: j, w: 1 });
            if (!list.length) return;  // a step always has a successor
            write(list);
        });
        line.append(opt, add);
        if (entry) {
            const w = el('input', 'seq-next-w', {
                type: 'number', min: '1', max: '99', value: String(entry.w),
                title: 'Weight: the relative chance of this branch' });
            w.dataset.to = String(j);
            w.addEventListener('pointerdown', e => e.stopPropagation());
            w.addEventListener('keydown', e => {
                e.stopPropagation();
                if (e.key === 'Escape') closeNextPopover(row);
            });
            w.addEventListener('change', () => {
                const v = Math.max(1, Math.min(99, Math.round(Number(w.value)) || 1));
                write(current.map(c => (c.to === j ? { to: j, w: v } : c)));
            });
            line.appendChild(w);
        }
        pop.appendChild(line);
    });
    if (current.length > 1) {
        pop.appendChild(el('div', 'seq-next-hint', {
            textContent: 'a branch with chance — the song is a radio ' +
                '(root only); the seed decides' }));
    }
    // Anchor under the header cell (or beside an orphan chip).
    const head = row.querySelector('.seq-head');
    if (anchor.classList.contains('seq-hcell') && head) {
        pop.style.left = anchor.style.left;
        head.appendChild(pop);
    } else {
        anchor.parentElement.appendChild(pop);
        pop.classList.add('in-foot');
    }
    row._nextPop = pop;
    row._nextPopOff = e => {
        if (!pop.contains(e.target)) closeNextPopover(row);
    };
    document.addEventListener('pointerdown', row._nextPopOff, true);
}

/**
 * THE FADES POPOVER (S13, §15): fade in / fade out for step i, in Q
 * (0 = the anti-pop micro-fade only). A gate run that starts on the
 * step ramps in over the fade-in; one that ends on it ramps out over
 * the fade-out. Each change is one setSequence (one undo step).
 */
function openFadePopover(row, anchor, i) {
    const lane = row._lane;
    if (!lane || !lane.editable) return;
    if (row._nextPop && row._nextPop._step === i &&
        row._nextPop._kind === 'fade') {
        closeNextPopover(row);
        return;
    }
    closeNextPopover(row);
    const pop = el('div', 'seq-fade-pop mono');
    pop._step = i;
    pop._kind = 'fade';
    pop.dataset.step = String(i);
    const s = lane.steps[i];
    pop.appendChild(el('div', 'seq-fade-title', {
        textContent: (s.name || String(i + 1)) + ' · fades (Q)' }));
    const field = (label, key, value) => {
        const line = el('div', 'seq-fade-line');
        const lab = el('label', '', { textContent: label });
        const input = el('input', 'seq-fade-q', {
            type: 'number', min: '0', step: '0.25', value: String(value),
            title: '0 = no musical fade (the 10 ms anti-pop only)' });
        input.dataset.fade = key;
        input.addEventListener('pointerdown', e => e.stopPropagation());
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Escape') closeNextPopover(row);
            if (e.key === 'Enter') input.blur();
        });
        input.addEventListener('change', () => {
            const q = Math.max(0, Number(input.value) || 0);
            commit(row, p => {
                const samples = Math.round(q * row._quantum);
                if (samples > 0) p.steps[i][key] = samples;
                else delete p.steps[i][key];
            });
        });
        line.append(lab, input);
        return line;
    };
    pop.appendChild(field('fade in', 'fadeIn', s.fadeInQ || 0));
    pop.appendChild(field('fade out', 'fadeOut', s.fadeOutQ || 0));
    const head = row.querySelector('.seq-head');
    pop.style.left = anchor.style.left;
    head.appendChild(pop);
    row._nextPop = pop;
    row._nextPopOff = e => {
        if (!pop.contains(e.target)) closeNextPopover(row);
    };
    document.addEventListener('pointerdown', row._nextPopOff, true);
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
        // Successors name steps by index: drop edges into the deleted
        // step, shift the ones past it.
        p.steps.forEach(s => {
            if (!s.next) return;
            s.next = s.next.filter(n => n.to !== i)
                .map(n => ({ to: n.to > i ? n.to - 1 : n.to, w: n.w }));
        });
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

/** Step resize: pointer drag on the grip; live preview; ONE
 * setSequence on release. Snap: whole inner cycles (S2 default);
 * ⌥ = whole Qs. Minimum 1Q. `i` is the step. A periodic grid previews
 * every column's new position; a radio's graph columns stay put (only
 * the length label moves). */
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
            // Live preview: recompute EVERY column's exact time position
            // (the total changes, so every boundary moves).
            const stepsQ = lane.steps.map(
                (s, j) => (j === i ? liveLenQ : s.lenQ));
            const visitsQ = lane.visits.map(v => stepsQ[v.step]);
            const newTotal = visitsQ.reduce((a, b) => a + b, 0) || 1;
            if (!lane.radio) {
                let pos = 0;
                const lefts = visitsQ.map(l => { const x = pos; pos += l; return x; });
                row.querySelectorAll('.seq-hcell, .seq-col').forEach(c => {
                    const kk = Number(c.dataset.col);
                    c.style.left = (lefts[kk] / newTotal * 100) + '%';
                    c.style.width =
                        'calc(' + (visitsQ[kk] / newTotal * 100) + '% - 4px)';
                });
            }
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
