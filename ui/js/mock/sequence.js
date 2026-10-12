/**
 * mock/sequence.js — the sequencer's verbs (docs/sequencer.md): engine
 * twins AudioEngine::setSequence / toggleSequence / auditionStep, and
 * the island-quantum write that keeps every song on the grid
 * (setIslandQuantum). A holder is a stack — the root included — storing
 * `sequence` ({ steps, gates, seed }), `sequenceBypassed` and
 * `auditionStep` (seq_query.js reads them).
 */

import { state, nodeOrRoot, eachNode } from './state.js';
import { posMod } from '../math_utils.js';
import { programOf, sequenceProgram } from '../sequence_program.js';
import { activeSeqLen } from './seq_query.js';

const MAX_STEPS = 64;

const stackOf = id => {
    const node = nodeOrRoot(id);
    return node && node.type === 'stack' ? node : null;
};

/** A payload step's successors, [] for none; null when malformed (an
 * index out of range, a weight that is not positive). */
function readSuccessors(step, stepCount) {
    if (step.next == null) return [];
    if (!Array.isArray(step.next)) return null;
    const next = [];
    for (const s of step.next) {
        const to = Number(s && s.to);
        const w = Math.trunc(Number(s && s.w !== undefined ? s.w : 1));
        if (!Number.isInteger(to) || to < 0 || to >= stepCount || !(w > 0)) return null;
        next.push({ to, w });
    }
    return next;
}

/** The root's anchor rides its song (docs/frame.md §4): a song authored
 * on the root anchors it at `zero` — the absolute sample the view seated
 * the frame's zero on, snapped to the Q grid; the island zero when the
 * view names none — and a root already anchored keeps its origin. */
function anchorRoot(zero) {
    const root = state.root;
    const Q = state.islandQ;
    if (root.anchored || !(Q > 0)) return;
    const islandZero = state.islandZero || 0;
    const z = Number.isFinite(zero) ? Math.round(zero) : islandZero;
    root.anchored = true;
    root.origin = z - posMod(z - islandZero, Q);
}

function clearSong(holder) {
    holder.sequence = null;
    holder.auditionStep = -1;
    if (holder === state.root) {
        holder.anchored = false;
        holder.origin = 0;
    }
}

export function setSequence(id, payload, zero) {
    const holder = stackOf(id);
    if (!holder) return;
    if (!payload || !Array.isArray(payload.steps) || !payload.steps.length) {
        if (holder.sequence) clearSong(holder);  // the bypass flag survives
        return;
    }
    if (payload.steps.length > MAX_STEPS || payload.steps.some(s => !(s.len > 0))) return;
    const nexts = payload.steps.map(s => readSuccessors(s, payload.steps.length));
    if (nexts.some(n => n === null)) return;
    const steps = payload.steps.map((s, i) => ({
        name: String(s.name || ''),
        len: Math.round(s.len),
        cue: !!s.cue,
        ...(nexts[i].length ? { next: nexts[i] } : {}),
        ...(s.fadeIn > 0 ? { fadeIn: Math.round(s.fadeIn) } : {}),
        ...(s.fadeOut > 0 ? { fadeOut: Math.round(s.fadeOut) } : {}),
    }));
    const seed = Number.isFinite(Number(payload.seed)) ? (Number(payload.seed) >>> 0) : 0;
    // A radio has no period to hand a parent: the root only (S12).
    if (programOf(steps, seed).radio && holder !== state.root) return;
    const gates = {};
    for (const [uuid, bits] of Object.entries(payload.gates || {})) {
        gates[uuid] = steps.map((_, i) => !!(bits && bits[i]));
    }
    // A change of shape ends the audition.
    const before = holder.sequence ? holder.sequence.steps.length : 0;
    if (before !== steps.length) holder.auditionStep = -1;
    holder.sequence = { steps, gates, seed };
    if (holder === state.root) anchorRoot(zero);
}

/** The step audition: a monitoring gesture, not logged. False for
 * anything but a stack and for a step the active program does not reach. */
export function auditionStep(id, step) {
    const holder = stackOf(id);
    if (!holder) return false;
    const n = Number(step);
    if (n >= 0) {
        const seq = activeSeqLen(holder) > 0 ? holder.sequence : null;
        if (!seq || n >= seq.steps.length || !sequenceProgram(seq).reachable[n]) return false;
    }
    holder.auditionStep = n >= 0 ? Math.floor(n) : -1;
    return true;
}

/** The bypass is a fact of the song: a holder with none has nothing to
 * toggle. */
export function toggleSequence(id) {
    const holder = stackOf(id);
    if (holder && holder.sequence) holder.sequenceBypassed = !holder.sequenceBypassed;
}

/** Engine setIslandQuantum: write (Q, zero); a re-established Q rescales
 * every song's lengths and fades, an island reverting to no Q clears
 * them. */
export function setIslandQuantum(q, zero) {
    const oldQ = state.islandQ;
    state.islandQ = q;
    state.islandZero = zero;
    if (q === oldQ) return;
    const scale = v => Math.round(v * q / oldQ);
    eachNode(holder => {
        if (holder.type !== 'stack' || !holder.sequence) return;
        if (!(q > 0)) {
            clearSong(holder);
            return;
        }
        if (!(oldQ > 0)) return;
        holder.sequence = {
            ...holder.sequence,
            steps: holder.sequence.steps.map(st => ({
                ...st,
                len: scale(st.len),
                ...(st.fadeIn > 0 ? { fadeIn: scale(st.fadeIn) } : {}),
                ...(st.fadeOut > 0 ? { fadeOut: scale(st.fadeOut) } : {}),
            })),
        };
    });
}
