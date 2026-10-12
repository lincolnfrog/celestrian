/**
 * THE SEQUENCER GRID (docs/sequencer.md §9): a synthetic row under a
 * stack's lane — rows = the stack's direct children, columns = its
 * PROGRAM (§14), pads = gates. The one control, at every depth.
 *
 * LAYOUT: the pads span the lane-body column, so a column boundary sits
 * ON the shared time axis (a 2Q step ends where 2Q is on the ruler). Row
 * names mirror the pad rows in the rail column and the verbs live in the
 * footer: nothing non-temporal takes width from the timeline. A radio
 * shows its graph, not its run (seq_columns.js); a step the program
 * never reaches has no column and waits in the footer as an orphan chip.
 *
 * THE LANE the grid draws is the view model's seq row (buildSeqRow,
 * vm/sequence_rows.js) with its health post-pass (attachFrameHealth):
 *   ownerId, editable, bypassed, auditionStep (−1 = none)
 *   steps[i]      { name, lenQ, cue, next: [{to, w}], fadeInQ, fadeOutQ }
 *   visits[k]     { step, startQ, lenQ } — the program, in play order
 *   totalQ, radio, seed, reachable[i], phaseQ (the song's anchor)
 *   innerCycleQ   one cycle of the loops: the append unit and resize snap
 *   children[ci]  { id, name, gates: [on? per step] }
 *   health        { blowup?, drift? } (frame_health.js) — when unhealthy
 *   parentMembers, scopeInnerQ — what the grip's live warning is judged
 *                 over (the view model's seqHealthAt)
 *
 * THREE INDEX SPACES, never interchangeable:
 *   i   a STEP, in list order — `data-step`; indexes steps[] and gates[]
 *   k   a COLUMN (seq_columns.js) — `data-col`; a visit, or for a radio
 *       the ordinal of a reachable step
 *   ci  a CHILD row — `data-child`
 *
 * UNITS: the lane is in Q, the bridge payload in samples; `row._quantum`
 * (samples per Q) converts, in payloadOf and the view model's
 * seqRowFacts only.
 *
 * THE ROW'S STATE (expandos; patchSeqGrid writes the first four):
 *   _lane        the lane last patched — handlers read it at event time
 *   _quantum     samples per Q
 *   _sampleRate  Hz
 *   _seqSig      the signature the DOM was built from; null = rebuild
 *   _paint       the gate value a pad drag paints; null/undefined = none
 * An open fades popover carries `_carried` (openFadesOf).
 *
 * EDITS: each finished gesture is one `commit` — one setSequence, one
 * undo step. The DOM REBUILDS when the lane's signature changes; a patch
 * otherwise moves only the playing-column highlight.
 */

import { ctx } from './context.js';
import { el, setText, fmtQ, holdControl, inlineRename, MAX_INDENT_DEPTH }
    from './sv_util.js';
import { openPopover, closePopover, closePopoverOf, openPopoverIn }
    from './popover.js';
import { columnsOf, shownQOf, playingColumn } from './seq_columns.js';
import { cycleMinutes, fmtDuration } from '../frame_health.js';
import { randomSeed } from '../sequence_program.js';
import { seqRowFacts, seqHealthAt } from '../view_model.js';

/* A step is never shorter than this (Q). */
const MIN_STEP_Q = 1;
/* Step lengths within this of each other are one length (Q). */
const STEP_EPS_Q = 1e-9;
/* A step's name is at most this long. */
const STEP_NAME_MAX = 24;
/* A successor's weight is a whole number in this range. */
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 99;

/** Build the synthetic grid row once; its content renders in the patch. */
export function buildSeqGrid(row, lane) {
    row.classList.add('lane-seq');
    row.dataset.depth = String(Math.min(lane.depth, MAX_INDENT_DEPTH));
    const rail = el('div', 'seq-rail');
    const body = el('div', 'seq-body');
    row.append(rail, body);
    row._seqSig = null;
    return row;
}

/** The lane's sequence as a bridge payload (samples), after `mutate`. */
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
    // A row that is ON everywhere is sent as no row: absent = inherit
    // ON, so a new track sounds in every step (engine parity).
    for (const [id, bits] of Object.entries(p.gates)) {
        if (bits.every(Boolean)) delete p.gates[id];
    }
    // Canonical successors: an empty list IS the loop successor.
    p.steps.forEach(s => { if (s.next && !s.next.length) delete s.next; });
    return p;
}

/**
 * The step a frame-health snap resizes to change the song's length by
 * `deltaQ`: the LAST step the program plays — once per pass, so its
 * length is the song's — that stays a step (≥ MIN_STEP_Q) after the
 * change. A step no visit reaches (an orphan) moves nothing. −1 when no
 * step can take the delta. Exported for the tests.
 */
export function snapStep(lane, deltaQ) {
    const visits = lane.visits || [];
    const plays = new Map();
    for (const v of visits) plays.set(v.step, (plays.get(v.step) || 0) + 1);
    for (let k = visits.length - 1; k >= 0; k--) {
        const i = visits[k].step;
        if (plays.get(i) === 1 &&
            lane.steps[i].lenQ + deltaQ >= MIN_STEP_Q - STEP_EPS_Q) return i;
    }
    return -1;
}

/**
 * ONE SEQUENCE EDIT: `mutate` the bridge payload and send it — one
 * setSequence, one undo step. Refused silently while the lane is locked
 * (a take records below it).
 *
 * The edit is applied to `row._lane` at once, and to nothing else: a
 * second gesture inside the same poll composes with the first (two fast
 * "+ step" clicks add two steps). The DOM does not change here — it
 * follows the next poll's published state, so an edit the engine
 * refuses never shows.
 */
function commit(row, mutate) {
    const lane = row._lane;
    if (!lane || !lane.editable) return;
    const p = payloadOf(lane, row._quantum, mutate);
    ctx.cb.onSetSequence(lane.ownerId, p);
    const { gates, ...facts } = seqRowFacts(p, lane.children, row._quantum);
    Object.assign(lane, facts);
    lane.children.forEach((c, ci) => { c.gates = gates[ci]; });
}

/** Patch: rebuild when the lane's signature changed; then light the
 * playing column. */
export function patchSeqGrid(row, lane, vm) {
    row._lane = lane;
    row._quantum = vm.quantum;
    row._sampleRate = vm.sampleRate;
    row.classList.toggle('bypassed', !!lane.bypassed);
    row.classList.toggle('locked', !lane.editable);
    row.classList.toggle('radio', !!lane.radio);
    row.classList.toggle('auditioning', lane.auditionStep >= 0);

    // Everything the build reads off the lane.
    const sig = JSON.stringify({
        s: lane.steps, v: lane.visits, b: lane.bypassed, e: lane.editable,
        c: lane.children.map(c => [c.id, c.name, c.gates]),
        i: lane.innerCycleQ, a: lane.auditionStep, h: lane.health || null,
        r: lane.radio, d: lane.seed,
    });
    if (row._seqSig !== sig) {
        row._seqSig = sig;
        rebuild(row, lane);
    }

    const playing = vm.isPlaying && !lane.bypassed
        ? playingColumn(lane, vm.playheadQ) : -1;
    row.querySelector('.seq-body')
        .querySelectorAll(playing < 0 ? '[data-col].playing' : '[data-col]')
        .forEach(cell => cell.classList.toggle('playing',
            Number(cell.dataset.col) === playing));
}

/** Rebuild the grid's DOM from `lane`. An open popover closes with the
 * cells it hung from — but an open FADES popover is carried across: its
 * own commits are what rebuild the grid, and it has a second field. */
function rebuild(row, lane) {
    const rail = row.querySelector('.seq-rail');
    const body = row.querySelector('.seq-body');
    const fades = openFadesOf(row);
    if (openPopoverIn(row)) closePopover();
    rail.textContent = '';
    body.textContent = '';
    buildGrid(row, lane, rail, body);
    if (fades) reopenFades(row, fades);
}

/** Build the grid into the emptied `rail` and `body`: the creation
 * affordance with no sequence; else the header row, a pad row per child
 * (its name beside it in the rail) and the footer. */
function buildGrid(row, lane, rail, body) {
    rail.appendChild(el('div', 'seq-rail-label mono',
        { textContent: 'SEQUENCER' }));
    if (!lane.steps.length) {
        body.appendChild(buildStart(row, lane));
        return;
    }
    // Cells are placed by exact left/width percent (the pct() idiom of
    // every timeline overlay): flex-grow would skew each boundary by
    // the cells' constant padding.
    const { cols, total } = columnsOf(lane);
    const place = (node, k) => {
        node.style.left = (cols[k].start / total * 100) + '%';
        node.style.width = 'calc(' + (cols[k].len / total * 100) + '% - 4px)';
        return node;
    };
    const head = el('div', 'seq-grid-row seq-head');
    cols.forEach((c, k) =>
        head.appendChild(place(buildHeaderCell(row, lane, c.step, k), k)));
    body.appendChild(head);
    lane.children.forEach((child, ci) => {
        const { name, pads } = buildPadRow(row, child, ci, cols, place);
        rail.appendChild(name);
        body.appendChild(pads);
    });
    body.appendChild(buildFooter(row, lane));
}

/** No sequence yet: the button that creates one step of one inner cycle
 * (the jam as a sequence, ready to split). */
function buildStart(row, lane) {
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
    return start;
}

/* ---------- the header ---------- */

/** Column k's header cell, for step i: name (double-click renames),
 * length chip, cue pip, successors pip, loop pip, resize grip. A
 * right-click anywhere on it deletes the step. */
function buildHeaderCell(row, lane, i, k) {
    const s = lane.steps[i];
    const cell = el('div', 'seq-hcell mono');
    cell.dataset.col = String(k);
    cell.dataset.step = String(i);
    cell.classList.toggle('cued', !!s.cue);
    cell.classList.toggle('looping', lane.auditionStep === i);
    const name = el('span', 'seq-hname', {
        textContent: s.name || String(i + 1),
        title: 'Double-click to rename · right-click to delete step' });
    name.addEventListener('dblclick', () => renameStep(row, cell, i));
    cell.append(name, lengthChip(row, s, i), cuePip(row, s, i),
        successorPip(row, s, i), loopPip(row, lane, i), resizeGrip(row, i));
    cell.addEventListener('contextmenu', e => {
        e.preventDefault();
        deleteStep(row, i);
    });
    return cell;
}

/** The length chip: the step's length, with a marker for a fade in (◢)
 * and out (◣). Click = the fades popover. */
function lengthChip(row, s, i) {
    const chip = el('span', 'seq-hlen', {
        textContent: (s.fadeInQ > 0 ? '◢' : '') + fmtQ(s.lenQ) + 'Q' +
                     (s.fadeOutQ > 0 ? '◣' : ''),
        title: 'Click: fade this step in / out (in Q)' });
    chip.addEventListener('click', e => {
        e.stopPropagation();
        openFadePopover(row, chip, i);
    });
    return chip;
}

/** ⇤ — CUE (§3): gate mode ↔ cue mode. A cued step re-bases its span
 * to the song top (the serial primitive: verse-box, then chorus-box). */
function cuePip(row, s, i) {
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
    return cue;
}

/** → — SUCCESSORS (§14): which steps may follow this one. Lit when the
 * step names its own (the default is the next step in the list). */
function successorPip(row, s, i) {
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
        openNextPopover(row, pip, i);
    });
    return pip;
}

/** ⟲ — THE STEP AUDITION (§11.2): the song folds to this step — audition
 * it, or arm a track and record into it. Monitoring, so not undoable. A
 * locked grid can still stop the step that is looping. */
function loopPip(row, lane, i) {
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
    return loop;
}

/**
 * The resize grip of step i: a drag previews the new length and its
 * release commits it — snapped to whole inner cycles, or with ⌥ to
 * whole Q; never under one of either. A drag taken away (cancelled,
 * capture lost) commits nothing. The row's width stands for shownQOf.
 *
 * The preview moves every column of a periodic grid (the total changes,
 * so every boundary does) — indexing the visits by `data-col`, which is
 * only a visit index there. A radio's graph columns stay put; only the
 * chip follows. The chip also warns live: ⚠ the length would blow up
 * the parent frame, ↯ its passes would drift.
 */
function resizeGrip(row, i) {
    const grip = el('span', 'seq-grip', {
        title: 'Drag to resize this step (snaps to whole cycles; ' +
               '⌥ = whole Q)' });
    grip.appendChild(el('span', 'seq-grip-bar'));
    let lane, cell, qPerPx, startX, startLenQ, liveLenQ;
    holdControl(grip, {
        onStart: e => {
            e.preventDefault();
            e.stopPropagation();
            lane = row._lane;
            if (!lane || !lane.editable) return false;
            cell = grip.parentElement;
            const rowW = cell.parentElement.getBoundingClientRect().width;
            qPerPx = shownQOf(lane) / Math.max(1, rowW);
            startX = e.clientX;
            startLenQ = liveLenQ = lane.steps[i].lenQ;
        },
        onMove: e => {
            const cyc = Math.max(MIN_STEP_Q, lane.innerCycleQ);
            const rawQ = startLenQ + (e.clientX - startX) * qPerPx;
            liveLenQ = e.altKey
                ? Math.max(MIN_STEP_Q, Math.round(rawQ))
                : Math.max(cyc, Math.round(rawQ / cyc) * cyc);
            const visitsQ = lane.visits.map(
                v => (v.step === i ? liveLenQ : lane.steps[v.step].lenQ));
            const songQ = visitsQ.reduce((a, b) => a + b, 0) || 1;
            if (!lane.radio) {
                let pos = 0;
                const lefts = visitsQ.map(q => { const x = pos; pos += q; return x; });
                row.querySelectorAll('.seq-hcell, .seq-col').forEach(c => {
                    const k = Number(c.dataset.col);
                    c.style.left = (lefts[k] / songQ * 100) + '%';
                    c.style.width =
                        'calc(' + (visitsQ[k] / songQ * 100) + '% - 4px)';
                });
            }
            const health = seqHealthAt(lane, songQ);
            setText(cell.querySelector('.seq-hlen'), fmtQ(liveLenQ) + 'Q' +
                (health.blowup ? ' ⚠' : '') + (health.drift ? ' ↯' : ''));
        },
        onEnd: e => {
            if (e && liveLenQ !== startLenQ) {
                commit(row, p => {
                    p.steps[i].len = Math.round(liveLenQ * row._quantum);
                });
            } else {
                // Nothing was sent, so no poll will redraw what the
                // preview wrote over: rebuild.
                row._seqSig = null;
            }
        },
    });
    return grip;
}

/** The inline editor for step i's name (an empty name shows the step's
 * number). */
function renameStep(row, cell, i) {
    if (cell._editing) return;
    cell._editing = true;
    inlineRename(cell.querySelector('.seq-hname'), {
        value: row._lane.steps[i].name || '',
        maxLength: STEP_NAME_MAX,
        className: 'seq-hname-input',
        allowEmpty: true,
        onDone: () => { cell._editing = false; },
        onCommit: name => commit(row, p => { p.steps[i].name = name; }),
    });
}

/** Delete step i; successors name steps by index, so edges into it drop
 * and the ones past it shift. Deleting the only step clears the
 * sequence. */
function deleteStep(row, i) {
    const lane = row._lane;
    if (lane.steps.length <= 1) {
        ctx.cb.onSetSequence(lane.ownerId, null);
        return;
    }
    commit(row, p => {
        p.steps.splice(i, 1);
        for (const bits of Object.values(p.gates)) bits.splice(i, 1);
        p.steps.forEach(s => {
            if (!s.next) return;
            s.next = s.next.filter(n => n.to !== i)
                .map(n => ({ to: n.to > i ? n.to - 1 : n.to, w: n.w }));
        });
    });
}

/* ---------- the pads ---------- */

/** Child ci's row: its `name` for the rail column (click = toggle the
 * whole row) and its `pads`, one per column (click = toggle, drag =
 * paint). */
function buildPadRow(row, child, ci, cols, place) {
    const name = el('div', 'seq-rowname', {
        textContent: child.name, title: 'Click: toggle the whole row' });
    name.dataset.child = String(ci);
    name.addEventListener('click', () => {
        const c = row._lane.children[ci];
        if (!c) return;
        const allOn = c.gates.every(Boolean);
        commit(row, p => { p.gates[c.id] = c.gates.map(() => !allOn); });
    });

    const pads = el('div', 'seq-grid-row');
    cols.forEach((c, k) => {
        const i = c.step;
        const on = !!child.gates[i];
        const col = el('div', 'seq-col');
        col.dataset.col = String(k);
        col.dataset.step = String(i);
        const pad = el('button', 'seq-pad', {
            title: (on ? 'On' : 'Off') + ' — click to toggle, drag to paint' });
        pad.classList.toggle('on', on);
        pad.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            beginPaint(row, !child.gates[i]);
            paintPad(row, child.id, i, row._paint);
        });
        pad.addEventListener('pointerenter', e => {
            if (row._paint === undefined || row._paint === null) return;
            // No button down: the release never arrived (a capture
            // dropped by a window switch) — the paint is over.
            if (!(e.buttons & 1)) { row._paint = null; return; }
            paintPad(row, child.id, i, row._paint);
        });
        col.appendChild(pad);
        pads.appendChild(place(col, k));
    });
    return { name, pads };
}

/* The grid row a pad drag is painting, and the ONE document listener
 * that ends the paint at the release. */
let paintingRow = null;
let paintEndWired = false;

/** A pad press starts a paint of `on` across the pads the drag enters. */
function beginPaint(row, on) {
    if (!paintEndWired) {
        paintEndWired = true;
        document.addEventListener('pointerup', () => {
            if (paintingRow) paintingRow._paint = null;
            paintingRow = null;
        });
    }
    paintingRow = row;
    row._paint = on;
}

/** Set one pad (one edit); a pad already at `on` sends nothing. */
function paintPad(row, childId, step, on) {
    const child = row._lane.children.find(c => c.id === childId);
    if (!child || child.gates[step] === on) return;
    commit(row, p => { p.gates[childId][step] = on; });
}

/* ---------- the footer ---------- */

/** The footer: the song's total and lock notice, the radio's seed, the
 * orphan chips and the health badges on the left; append and bypass in
 * a cluster on the right, under where the song ends. */
function buildFooter(row, lane) {
    const foot = el('div', 'seq-foot mono');
    foot.appendChild(el('span', 'seq-total', {
        textContent: (lane.radio ? 'radio · ' : 'seq · ') +
                     fmtQ(lane.totalQ > 0 ? lane.totalQ : 1) + 'Q' }));
    if (!lane.editable) {
        foot.appendChild(el('span', 'seq-lock',
            { textContent: '● recording — sequence locked' }));
    }
    foot.append(...radioChrome(row, lane), ...orphanChips(row, lane),
        ...healthBadges(row, lane));

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
    const bypass = el('button', 'seq-bypass', {
        textContent: lane.bypassed ? '⊘ bypassed · click to activate'
                                   : '⟳ active · click to bypass',
        title: 'Bypassed = the jam (everything sounds); the sequence ' +
               'geometry is kept' });
    bypass.addEventListener('click',
        () => ctx.cb.onToggleSequenceBypass(row._lane.ownerId));
    right.append(add, bypass);
    foot.appendChild(right);
    return foot;
}

/** THE RADIO (§6, §14): a period-less program, whose seed IS the
 * performance — shown so a run can be named, with the re-roll verb. */
function radioChrome(row, lane) {
    if (!lane.radio) return [];
    const seedHex = (lane.seed >>> 0).toString(16).padStart(8, '0');
    const badge = el('span', 'seq-radio', {
        textContent: '📻 radio · seed ' + seedHex,
        title: 'This song branches (or never returns to its top), so ' +
            'it has no period — the seed decides every branch; the ' +
            'same seed always plays the same run. ' +
            'It repeats after ' + (lane.visits || []).length +
            ' steps. The grid shows the graph; the lanes show the ' +
            'run.' });
    const reroll = el('button', 'seq-reroll', {
        textContent: '⟳ re-roll',
        title: 'A new seed: a new run of the same song (undoable)' });
    reroll.addEventListener('click', () => {
        commit(row, p => { p.seed = randomSeed(); });
    });
    return [badge, reroll];
}

/** ORPHANS (§14): one chip per step the program never reaches. Click to
 * re-link it (the successors popover), right-click to delete it. */
function orphanChips(row, lane) {
    const chips = [];
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
        chips.push(chip);
    });
    return chips;
}

/**
 * THE FRAME-HEALTH BADGES (§11.6), shown only when an edit warrants
 * them: the blowup face (this song's length explodes the parent frame)
 * and the drift face (its passes differ). Each snap offer is one edit:
 * the delta lands on the step snapStep names, and an offer no step can
 * take is not made.
 */
function healthBadges(row, lane) {
    const h = lane.health;
    if (!h) return [];
    const nodes = [];
    const offer = (targetQ, why) => {
        const delta = targetQ - lane.totalQ;
        const i = snapStep(lane, delta);
        if (i < 0) return;
        const fix = el('button', 'seq-health-fix', {
            textContent: 'snap to ' + fmtQ(targetQ) + 'Q',
            title: 'Resize step ' + (lane.steps[i].name || String(i + 1)) +
                ' ' + why });
        fix.addEventListener('click', () => commit(row, p => {
            p.steps[i].len = Math.round((lane.steps[i].lenQ + delta) * row._quantum);
        }));
        nodes.push(fix);
    };
    if (h.blowup) {
        const b = h.blowup;
        const mins = fmtDuration(
            cycleMinutes(b.cycleQ, row._quantum, row._sampleRate));
        nodes.push(el('span', 'seq-health seq-health-blowup', {
            textContent: '⚠ ' + fmtQ(b.responsiblePeriodQ) + 'Q → parent ×' +
                fmtQ(b.cycleQ) + ' (' + mins + ')',
            title: 'This song\'s length makes the enclosing frame ' +
                fmtQ(b.cycleQ) + 'Q — ' + Math.round(b.ratio) +
                '× its largest member (coprime lengths LCM)' }));
        if (b.offerQ) offer(b.offerQ, 'so the song agrees with its siblings');
    }
    if (h.drift) {
        const d = h.drift;
        nodes.push(el('span', 'seq-health seq-health-drift', {
            textContent: '↯ drifting · ' + fmtQ(d.seqLenQ) + 'Q over ' +
                fmtQ(d.innerQ) + 'Q',
            title: 'The song is not a whole number of inner cycles: each ' +
                'pass frames different bars (deliberate? fine — it is ' +
                'badged, never silent)' }));
        d.offers.filter(Boolean).forEach(
            q => offer(q, 'so every pass repeats identically'));
    }
    return nodes;
}

/* ---------- the popovers (the rules: popover.js) ---------- */

/** Show `pop` as the open popover of `trigger`: under the trigger's
 * header cell, or — an orphan has no column — beside its footer chip. */
function showStepPopover(row, pop, trigger) {
    const cell = trigger.closest('.seq-hcell');
    if (cell) pop.style.left = cell.style.left;
    else pop.classList.add('in-foot');
    openPopover({ menu: pop, trigger,
        mount: cell ? row.querySelector('.seq-head') : trigger.parentElement });
}

/** A popover field: presses stay in it, and its keys reach no hotkey —
 * so it answers Escape itself. `onEnter` is optional. */
function wireField(input, onEnter) {
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') closePopover();
        else if (e.key === 'Enter' && onEnter) onEnter();
    });
}

/** The successors of step i in effect: its own list, else the loop. */
function candidatesOf(lane, i) {
    const s = lane.steps[i];
    if (s.next && s.next.length) return s.next.map(n => ({ ...n }));
    return [{ to: (i + 1) % lane.steps.length, w: 1 }];
}

/**
 * THE SUCCESSORS POPOVER (§14) of step i: one line per step j.
 *   its name   — ONLY j follows i (a single successor: legal anywhere,
 *                so re-routing a nested song never passes through a
 *                branch)
 *   ＋ / −     — add or drop j as a BRANCH candidate (two or more make
 *                the song a radio: root only)
 *   its weight — a candidate's relative chance
 * Every change is one edit and closes the popover. The default (only
 * the next step, weight 1) is stored as no list at all.
 */
function openNextPopover(row, trigger, i) {
    if (closePopoverOf(trigger)) return;
    const lane = row._lane;
    if (!lane || !lane.editable) return;
    const pop = el('div', 'seq-next-pop mono');
    pop.dataset.step = String(i);
    const label = j => lane.steps[j].name || String(j + 1);
    pop.appendChild(el('div', 'seq-next-title', {
        textContent: 'after ' + label(i) + ' →' }));
    const current = candidatesOf(lane, i);
    const write = list => {
        const n = lane.steps.length;
        const canonical = list.length === 1 && list[0].to === (i + 1) % n &&
                          list[0].w === 1;
        commit(row, p => {
            if (canonical) delete p.steps[i].next;
            else p.steps[i].next = list.map(x => ({ to: x.to, w: x.w }));
        });
        closePopover();
    };
    lane.steps.forEach((s, j) => {
        const line = el('div', 'seq-next-line');
        const entry = current.find(c => c.to === j);
        const only = el('button', 'seq-next-opt', {
            textContent: label(j) + (j === i ? ' (again)' : ''),
            title: 'Click: ONLY ' + label(j) + ' follows ' + label(i) });
        only.dataset.to = String(j);
        only.classList.toggle('on', !!entry);
        only.addEventListener('click', e => {
            e.stopPropagation();
            write([{ to: j, w: entry ? entry.w : 1 }]);
        });
        const branch = el('button', 'seq-next-add mono', {
            textContent: entry ? '−' : '＋',
            title: entry
                ? 'Drop this branch'
                : 'Add as a branch: ' + label(i) + ' may go here OR elsewhere ' +
                  '(a chance = a radio, root only)' });
        branch.dataset.to = String(j);
        branch.addEventListener('click', e => {
            e.stopPropagation();
            const list = current.filter(c => c.to !== j);
            if (!entry) list.push({ to: j, w: 1 });
            if (!list.length) return;  // a step always has a successor
            write(list);
        });
        line.append(only, branch);
        if (entry) {
            const weight = el('input', 'seq-next-w', {
                type: 'number', min: String(MIN_WEIGHT), max: String(MAX_WEIGHT),
                value: String(entry.w),
                title: 'Weight: the relative chance of this branch' });
            weight.dataset.to = String(j);
            wireField(weight);
            weight.addEventListener('change', () => {
                const w = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT,
                    Math.round(Number(weight.value)) || MIN_WEIGHT));
                write(current.map(c => (c.to === j ? { to: j, w } : c)));
            });
            line.appendChild(weight);
        }
        pop.appendChild(line);
    });
    if (current.length > 1) {
        pop.appendChild(el('div', 'seq-next-hint', {
            textContent: 'a branch with chance — the song is a radio ' +
                '(root only); the seed decides' }));
    }
    showStepPopover(row, pop, trigger);
}

/**
 * THE FADES POPOVER (§15) of step i: fade in / fade out, in Q (0 = the
 * anti-pop micro-fade only). A gate run that starts on the step ramps in
 * over the fade-in; one that ends on it ramps out over the fade-out.
 * Each field's change is one edit, and the popover stays open through
 * the rebuild that follows (rebuild), so both can be set in one visit.
 */
function openFadePopover(row, trigger, i) {
    if (closePopoverOf(trigger)) return;
    const lane = row._lane;
    if (!lane || !lane.editable) return;
    const pop = el('div', 'seq-fade-pop mono');
    pop.dataset.step = String(i);
    const s = lane.steps[i];
    pop.appendChild(el('div', 'seq-fade-title', {
        textContent: (s.name || String(i + 1)) + ' · fades (Q)' }));
    const field = (label, key, value) => {
        const line = el('div', 'seq-fade-line');
        const input = el('input', 'seq-fade-q', {
            type: 'number', min: '0', step: '0.25', value: String(value),
            title: '0 = no musical fade (the 10 ms anti-pop only)' });
        input.dataset.fade = key;
        wireField(input, () => input.blur());
        input.addEventListener('change', () => {
            if (pop._carried) return;  // rebuild() carries the field on
            const q = Math.max(0, Number(input.value) || 0);
            commit(row, p => {
                const samples = Math.round(q * row._quantum);
                if (samples > 0) p.steps[i][key] = samples;
                else delete p.steps[i][key];
            });
        });
        line.append(el('label', '', { textContent: label }), input);
        return line;
    };
    pop.append(field('fade in', 'fadeIn', s.fadeInQ || 0),
               field('fade out', 'fadeOut', s.fadeOutQ || 0));
    showStepPopover(row, pop, trigger);
}

/** The row's open fades popover as rebuild() carries it — its step and,
 * when one of its fields has the focus, that field with the text in it —
 * or null with none open. The popover is about to be rebuilt, so it is
 * marked `_carried`: a field losing its focus to the rebuild commits
 * nothing. */
function openFadesOf(row) {
    const pop = openPopoverIn(row);
    if (!pop || !pop.classList.contains('seq-fade-pop')) return null;
    pop._carried = true;
    const focused = document.activeElement;
    const typing = focused && pop.contains(focused) && focused.dataset.fade
        ? { key: focused.dataset.fade, text: focused.value } : null;
    return { step: Number(pop.dataset.step), typing };
}

/** Re-open the fades popover rebuild() carried, on the same step (if
 * the grid still shows it), the field in use focused again: with the
 * text typed into it, or — untouched — selected, as a Tab into it
 * leaves it. */
function reopenFades(row, fades) {
    const chip = row.querySelector(
        '.seq-hcell[data-step="' + fades.step + '"] .seq-hlen');
    if (!chip) return;
    openFadePopover(row, chip, fades.step);
    const pop = openPopoverIn(row);
    if (!pop || !fades.typing) return;
    const input = pop.querySelector('input[data-fade="' + fades.typing.key + '"]');
    input.focus();
    if (input.value === fades.typing.text) input.select();
    else input.value = fades.typing.text;
}
