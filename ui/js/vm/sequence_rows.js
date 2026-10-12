/**
 * The song on screen (docs/sequencer.md): a sequenced scope's grid row,
 * the overlays its gates project onto the lanes beneath it, its chip
 * facts, and the frame-health verdicts of every scope. The lanes are the
 * DISPLAY of a song; the grid row is its editor (§9).
 */

import { posMod } from '../math_utils.js';
import { assessBlowup, assessDrift, lcmAll } from '../frame_health.js';
import { publishedMapPeriod } from '../time_map.js';
import { publishedSequence, sequenceProgram, sequenceTotalSamples,
         activeSequenceSamples, auditionStepOf, visitBounds }
    from '../sequence_program.js';
import { EPS } from './tiling.js';
import { scopeMembers, subtreeRec, intrinsicPeriodQ } from './published.js';

/**
 * THE PROGRAM LAID OUT (§14): one span per VISIT, in samples, with that
 * step's cue and fades resolved onto it, and the song's total. A step
 * the walk plays twice has two spans and a step it skips has none, so
 * nothing downstream may index a per-step array by a visit. A length in
 * Q is ONE division of a sample bound, so spans abut exactly.
 *
 * @param {?Object} s  a published sequence, or null
 * @returns {{prog: Object, spans: Array<{step: number, start: number,
 *     end: number, cue: boolean, fadeIn: number, fadeOut: number}>,
 *     total: number}}
 */
function programSpans(s) {
    const prog = sequenceProgram(s);
    const steps = (s && s.steps) || [];
    const samples = v => (v > 0 ? Math.round(v) : 0);
    const bounds = visitBounds(prog.visits, steps.map(st => samples(st.len)));
    const spans = prog.visits.map((step, k) => ({
        step,
        start: bounds[k],
        end: bounds[k + 1],
        cue: !!steps[step].cue,
        fadeIn: samples(steps[step].fadeIn),
        fadeOut: samples(steps[step].fadeOut),
    }));
    return { prog, spans, total: bounds[bounds.length - 1] };
}

/**
 * THE ROW A SEQUENCE DERIVES — its steps, program and gates in the
 * grid's shape, Q. `sequence` is one as published, or as the grid sends
 * it ({ steps: [{ name, len, cue, next, fadeIn, fadeOut }] in samples,
 * gates: { childId: [on per step] }, seed }; `program` only when
 * published; null = none). buildSeqRow builds the committed row from
 * it, and the grid applies it to its own lane when an edit is sent, so
 * the two cannot differ.
 *
 * @param {Array<{id: string}>} children  the scope's direct children
 * @returns {{steps: Array, seed: number, visits: Array<{step: number,
 *     startQ: number, lenQ: number}>, totalQ: number, radio: boolean,
 *     reachable: boolean[], gates: boolean[][]}}  `visits` the program
 *     in play order; `radio` it has no period (§6): the seed is its
 *     performance; `gates[ci]` child ci's row, one entry per STEP
 */
export function seqRowFacts(sequence, children, quantum) {
    const s = publishedSequence({ sequence });
    const lenQ = v => (v > 0 ? Math.round(v) : 0) / quantum;
    const steps = s ? s.steps.map(st => ({
        name: st.name || '',
        lenQ: lenQ(st.len),
        cue: !!st.cue,          // the step re-bases its subtree to the song top (S22)
        // The successor graph (§14): [{to, w}]; empty = the loop
        // successor, and an entry with no weight weighs 1 (successorOf).
        next: Array.isArray(st.next)
            ? st.next.map(n => ({ to: n.to, w: n.w === undefined ? 1 : n.w }))
            : [],
        // Per-step fades (S13, §15); 0 = the anti-pop micro-fade.
        fadeInQ: lenQ(st.fadeIn),
        fadeOutQ: lenQ(st.fadeOut),
    })) : [];
    const { prog, spans, total } = programSpans(s);
    return {
        steps,
        seed: s ? ((s.seed || 0) >>> 0) : 0,
        visits: spans.map(v => ({
            step: v.step, startQ: v.start / quantum, lenQ: steps[v.step].lenQ })),
        totalQ: total / quantum,
        radio: !!prog.radio,
        reachable: steps.map((_, i) => !!prog.reachable[i]),
        // No gate row for a child = inherit ON (engine parity).
        gates: (children || []).map(c => {
            const row = s && s.gates && s.gates[c.id];
            return steps.map((_, i) => (row ? !!row[i] : true));
        }),
    };
}

/**
 * The SEQUENCER GRID row of a scope whose panel is open (opts.seqOpen;
 * §9 S15: the pad grid is the one control, at every depth). Rows are the
 * scope's direct children, pads their gates, and the COLUMNS are the
 * program's visits — a step the walk plays twice has two columns, both
 * editing the one step — so step boundaries stay on the shared time
 * axis. The sequence's own facts are seqRowFacts'.
 *
 * @param {Object} o  `holder` the stack node, or the state (the root);
 *     `innerCycleQ` the append default: one inner cycle of the scope's
 *     members; `editable` false while a take records beneath (the
 *     engine refuses the edit anyway); `anchorQ` the song's anchor in
 *     the lane frame — the owner's origin (a group's Q18 origin, the
 *     root's song top): the playing column is the playhead folded FROM
 *     it (`phaseQ`)
 */
export function buildSeqRow({ holder, ownerId, children, depth, quantum,
                              qEstablished, innerCycleQ, editable, anchorQ = 0 }) {
    const s = publishedSequence(holder);
    const { gates, ...facts } = seqRowFacts(s, children, quantum);
    return {
        kind: 'seq',
        id: 'seq:' + ownerId,
        ownerId,
        name: '',
        depth,
        bypassed: !!(s && s.bypassed),
        ...facts,
        phaseQ: facts.totalQ > 0 ? posMod(anchorQ, facts.totalQ) : 0,
        auditionStep: auditionStepOf(s),
        innerCycleQ: Math.max(1, Math.round(innerCycleQ)),
        qEstablished,
        editable,
        children: (children || []).map((c, ci) => ({
            id: c.id,
            name: c.name || '',
            kind: c.type === 'stack' ? 'group' : 'clip',
            gates: gates[ci],
        })),
    };
}

/** A group's grid row. */
export function seqRow(node, depth, quantum, qEstablished, anchorQ = 0) {
    return buildSeqRow({
        holder: node,
        ownerId: node.id,
        children: node.nodes,
        depth,
        quantum,
        qEstablished,
        innerCycleQ: intrinsicPeriodQ(node, quantum),
        editable: !subtreeRec(node),
        anchorQ,
    });
}

/** The rail / transport chip's facts for a published sequence `s`. */
export function seqChipFacts(s, quantum) {
    return {
        bypassed: !!s.bypassed,
        totalQ: sequenceTotalSamples(s) / quantum,
        stepCount: s.steps.length,
        auditionStep: auditionStepOf(s),
    };
}

/** The root song's chip facts, with its drift verdict; null without a
 * song. */
export function rootSeqChip(state, nodes, quantum) {
    const s = publishedSequence(state);
    if (!s) return null;
    return { ...seqChipFacts(s, quantum),
             drift: s.bypassed ? null
                 : scopeDrift(s, scopeMembers(nodes, quantum), quantum) };
}

/** The inner cycle a scope's song is judged against, in Q: the fold of
 * what its members hand it. */
const innerCycleOf = members => lcmAll(members.map(m => m.periodQ), 1);

/** Is the stack `c`'s SONG what it plays — active, with no map over it
 * (the period law: map ▸ sequence; a step audition is a map)? */
const songIsPeriod = c =>
    activeSequenceSamples(c) > 0 && !(publishedMapPeriod(c) > 0);

/** The DRIFT face of a scope's song against its members' inner cycle
 * (frame_health.assessDrift). */
function scopeDrift(s, members, quantum) {
    return assessDrift(sequenceTotalSamples(s) / quantum, innerCycleOf(members));
}

/**
 * THE FRAME-HEALTH FACES OF A SONG AT A PROVISIONAL LENGTH `songQ`
 * (§11.6) — what the grid's grip warns of while a step is dragged:
 * would this song be blamed for blowing up its parent's frame, would
 * its passes drift. Judged by the functions, over the members,
 * attachFrameHealth judges the committed badge with (the row carries
 * them: `parentMembers`, `scopeInnerQ`), so at the row's own length the
 * answer IS its badge.
 *
 * A song that is not what its scope hands the parent — bypassed, under
 * a window or a step audition, in a one-shot — changes no frame above
 * it by changing length: the blow-up face stands as committed. A
 * bypassed song's passes are not played: no drift.
 *
 * @param {Object} row  a seq row after attachFrameHealth
 * @returns {{blowup: boolean, drift: boolean}}
 */
export function seqHealthAt(row, songQ) {
    const members = row.parentMembers;
    const blow = members ? assessBlowup(members.map(
        m => (m.id === row.ownerId ? { ...m, periodQ: songQ } : m)), 1) : null;
    return {
        blowup: members ? !!blow && blow.responsibleId === row.ownerId
                        : !!(row.health && row.health.blowup),
        drift: !row.bypassed && !!assessDrift(songQ, row.scopeInnerQ),
    };
}

/**
 * Project a scope's ACTIVE sequence onto the lanes of its subtree
 * (lanes[from, to)): each direct child's gated-OFF spans, its fade ramps
 * and the scope's cued spans become a `seqDims` layer on the child's
 * lane and on every lane beneath it (gates are fractal), tiled every
 * song period. The layer's `phaseQ` is the song's anchor in the lane
 * frame (`anchorQ`, buildSeqRow): the step lookup folds from the owner's
 * origin, never from the lane's zero.
 */
export function attachSeqDims(lanes, from, to, children, seq, quantum, anchorQ = 0) {
    const { spans, total } = programSpans(seq);
    if (!(total > 0)) return;
    const totalQ = total / quantum;
    const phaseQ = posMod(anchorQ, totalQ);
    // CUED spans (§3): every lane under the scope replays the song top
    // during a cued step, gated or not.
    const cueSegsQ = spans.filter(v => v.cue)
        .map(v => [v.start / quantum, v.end / quantum]);
    const childIds = new Set((children || []).map(c => c.id));
    let offSegs = null;   // the CURRENT direct child's off spans
    let fadeSegs = null;  // …and its fade ramps (S13)
    for (let i = from; i < to; i++) {
        const lane = lanes[i];
        if (childIds.has(lane.id)) {
            // This child's gate on every VISIT (no gate row = ON).
            const bits = seq.gates ? seq.gates[lane.id] : null;
            const visits = spans.map(
                v => ({ ...v, on: bits ? !!bits[v.step] : true }));
            offSegs = [];
            let runStart = null;
            for (const v of visits) {
                if (!v.on && runStart === null) runStart = v.start;
                if (v.on && runStart !== null) {
                    offSegs.push([runStart / quantum, v.start / quantum]);
                    runStart = null;
                }
            }
            if (runStart !== null) offSegs.push([runStart / quantum, totalQ]);
            if (!offSegs.length) offSegs = null;
            fadeSegs = fadeSegsOf(visits, total, quantum);
            if (!fadeSegs.length) fadeSegs = null;
        }
        if ((offSegs || cueSegsQ.length) &&
            (lane.kind === 'clip' || lane.kind === 'group')) {
            // Layers compose (§12.2), outermost first: inner scopes
            // attached theirs during the recursion, so this one is
            // prepended. A lane is silent where ANY enclosing song
            // silences it.
            lane.seqDims = [{ periodQ: totalQ, offSegsQ: offSegs || [],
                              cueSegsQ: cueSegsQ.length ? cueSegsQ : null,
                              ...(fadeSegs ? { fadeSegsQ: fadeSegs } : {}),
                              ...(phaseQ ? { phaseQ } : {}) },
                            ...(lane.seqDims || [])];
        }
    }
}

/**
 * The ON-runs of a child's gates over the program's visits (engine
 * parity, Sequence::runAround): contiguous on-visits merge, INCLUDING
 * across the wrap, and break at cue seams (S20). Returns [{first, last}]
 * visit indices; a run that is the whole program with no seam is `whole`
 * (constant gain: no ramps anywhere).
 *
 * @param {Array<{on: boolean, cue: boolean}>} visits  one record per
 *     VISIT (programSpans, with the child's gate as `on`)
 */
function onRunsOf(visits) {
    const n = visits.length;
    if (!n) return [];
    const on = k => visits[k].on;
    const cut = (a, b) => visits[a].cue || visits[b].cue;
    let start = -1;
    for (let i = 0; i < n; i++) {
        const p = (i + n - 1) % n;
        if (on(i) && (!on(p) || cut(p, i))) { start = i; break; }
    }
    if (start < 0) return on(0) ? [{ first: 0, last: n - 1, whole: true }] : [];
    const runs = [];
    let i = start, seen = 0;
    while (seen < n) {
        if (!on(i)) { i = (i + 1) % n; seen++; continue; }
        let last = i, len = 1;
        while (len < n && on((last + 1) % n) && !cut(last, (last + 1) % n)) {
            last = (last + 1) % n;
            len++;
        }
        runs.push({ first: i, last });
        seen += len;
        i = (last + 1) % n;
    }
    return runs;
}

/**
 * PER-STEP FADE ramps (S13, §15) as display segments over the program:
 * [[fromQ, toQ, 'in'|'out'], …]. A run ramps in over its FIRST visit's
 * fade-in and out over its LAST visit's fade-out; ramps that do not fit
 * the run shrink proportionally so they meet (engine parity,
 * Sequence::rampsOf). A segment crossing the wrap is split. Measured in
 * samples (`visits` as for onRunsOf; `total` the program's length) and
 * divided once per edge.
 */
function fadeSegsOf(visits, total, quantum) {
    const least = EPS * quantum;
    const segs = [];
    const push = (from, len, kind) => {
        if (!(len > least)) return;
        const a = posMod(from, total);
        const b = a + len;
        if (b <= total + least) {
            segs.push([a / quantum, b / quantum, kind]);
        } else {
            segs.push([a / quantum, total / quantum, kind]);
            segs.push([0, (b - total) / quantum, kind]);
        }
    };
    const n = visits.length;
    for (const r of onRunsOf(visits)) {
        if (r.whole) continue;
        let runLen = 0;
        for (let k = r.first;; k = (k + 1) % n) {
            runLen += visits[k].end - visits[k].start;
            if (k === r.last) break;
        }
        let fIn = visits[r.first].fadeIn;
        let fOut = visits[r.last].fadeOut;
        if (fIn + fOut > runLen && fIn + fOut > 0) {
            fIn = fIn * runLen / (fIn + fOut);
            fOut = runLen - fIn;
        }
        const top = visits[r.first].start;
        push(top, fIn, 'in');
        push(top + runLen - fOut, fOut, 'out');
    }
    return segs;
}

/**
 * THE FRAME-HEALTH BADGE (§11.6): a post-pass over the built lanes, for
 * the root scope and every group. BLOWUP marks the RESPONSIBLE child's
 * lane (`lane.health`) and, when that child is a sequenced stack, its
 * grid row (`row.health.blowup`, with the snap offer). DRIFT marks a
 * sequenced scope's own row and chip (`row.health.drift`,
 * `lane.seq.drift`). A grid row also learns what its grip's live
 * warning is judged over (seqHealthAt): `scopeInnerQ`, its own members'
 * inner cycle, and `parentMembers`, its parent scope's members — itself
 * among them — when its song is what it hands that scope.
 */
export function attachFrameHealth(lanes, state, nodes, quantum, qEstablished) {
    if (!qEstablished) return;
    const byId = new Map();
    lanes.forEach(l => { if (l.kind === 'clip' || l.kind === 'group') byId.set(l.id, l); });
    const rowOf = new Map();
    lanes.forEach(l => { if (l.kind === 'seq') rowOf.set(l.ownerId, l); });

    const visitScope = (ownerId, holder, children) => {
        const members = scopeMembers(children, quantum);
        const blow = assessBlowup(members, 1);
        if (blow) {
            const lane = byId.get(blow.responsibleId);
            if (lane) lane.health = { ...blow, scopeId: ownerId };
            const row = rowOf.get(blow.responsibleId);
            if (row) row.health = { ...(row.health || {}), blowup: { ...blow, scopeId: ownerId } };
        }
        (children || []).forEach(c => {
            const row = rowOf.get(c.id);
            if (row && songIsPeriod(c) && members.some(m => m.id === c.id)) {
                row.parentMembers = members;
            }
        });
        const own = rowOf.get(ownerId);
        if (own) own.scopeInnerQ = innerCycleOf(members);
        const s = publishedSequence(holder);
        const drift = s && !s.bypassed ? scopeDrift(s, members, quantum) : null;
        if (drift) {
            if (own) own.health = { ...(own.health || {}), drift };
            const lane = byId.get(ownerId);
            if (lane && lane.seq) lane.seq.drift = drift;
        }
        (children || []).forEach(c => {
            if (c.type === 'stack') visitScope(c.id, c, c.nodes);
        });
    };
    visitScope(state.id || '', state, nodes);
}
