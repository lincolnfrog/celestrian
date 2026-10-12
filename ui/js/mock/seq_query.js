/**
 * mock/seq_query.js — pure reads of a STORED sequence
 * ({ steps: [{name, len, cue, next?, fadeIn?, fadeOut?}], gates, seed })
 * and of its holder (a stack, the root included: `sequence`,
 * `sequenceBypassed`, `auditionStep`). A leaf: the state queries and the
 * sequence verbs both read it. Every timeline question goes through the
 * unrolled program (sequence_program.js).
 */

import { posMod } from '../math_utils.js';
import { sequenceProgram, sequenceTotalSamples, visitBounds }
    from '../sequence_program.js';

const hasSteps = seq => !!seq && Array.isArray(seq.steps) && seq.steps.length > 0;

/** The length of the holder's ACTIVE song in samples; 0 with none, or a
 * bypassed one (engine StackNode::activeSequenceLen). */
export function activeSeqLen(holder) {
    if (!holder || holder.sequenceBypassed || !hasSteps(holder.sequence)) return 0;
    return sequenceTotalSamples(holder.sequence);
}

/** Visit bounds of a stored sequence: [b0, …, bN], samples. */
export function seqBounds(seq) {
    if (!hasSteps(seq)) return [0];
    return visitBounds(sequenceProgram(seq).visits,
        seq.steps.map(s => (s.len > 0 ? Math.round(s.len) : 0)));
}

/** The visit at song position `rel` (folded on the song); −1 with none. */
export function visitIndexAt(seq, rel) {
    const b = seqBounds(seq);
    const total = b[b.length - 1];
    if (!(total > 0)) return -1;
    const r = posMod(rel, total);
    for (let k = 0; k + 1 < b.length; k++) if (r < b[k + 1]) return k;
    return b.length - 2;
}

/** The step playing at song position `rel`; −1 with none. */
export function stepIndexAt(seq, rel) {
    const k = visitIndexAt(seq, rel);
    return k < 0 ? -1 : sequenceProgram(seq).visits[k];
}

export function stepCued(seq, i) {
    return !!(hasSteps(seq) && seq.steps[i] && seq.steps[i].cue);
}

/** Does the program visit a cued step (engine Sequence::any_cue)? */
export function anyCue(seq) {
    return hasSteps(seq) && sequenceProgram(seq).visits.some(i => stepCued(seq, i));
}

/** The span [start, end) of step i's first visit, or null. */
export function firstVisitSpan(seq, i) {
    if (!hasSteps(seq)) return null;
    const k = sequenceProgram(seq).firstVisit[i];
    if (!(k >= 0)) return null;
    const b = seqBounds(seq);
    return b[k + 1] > b[k] ? [b[k], b[k + 1]] : null;
}

/** The map a step audition derives (engine StackNode::auditionMap): the
 * audited step's first visit, while the song is active. Null with none. */
export function auditionMapOf(holder) {
    const i = holder.auditionStep;
    if (!(i >= 0) || !(activeSeqLen(holder) > 0)) return null;
    const span = firstVisitSpan(holder.sequence, i);
    return span ? { segs: [span] } : null;
}
