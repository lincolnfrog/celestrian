/**
 * fuzz_loop_region.test.mjs — randomized sequence fuzzer for the
 * loop-region system (windows, segment maps, Q13 definers, the
 * content-frame law, undo/redo bookkeeping), driven through the mock
 * backend exactly like the directed suites (loadScenario / callNative /
 * advanceBy / getState / deriveViewModel).
 *
 * Each iteration: from an empty session, 20-60 random ops (create /
 * combine / reorder / rename / record / new take / advance / stop /
 * cancel / setLoopPoints incl. deliberately invalid / setSegments incl.
 * malformed / toggleLoopWindow / setTiming / setDefiner /
 * setPeriodSource / setSequence incl. malformed / toggleSequence /
 * selectTake / deleteTake / setComp / seek / delete / undo / redo /
 * togglePlayback), asserting after EVERY op:
 *   I1 getState() + deriveViewModel() succeed; every lane has finite
 *      periodQ/intrinsicQ >= 0 and reps within [0, cycleQ + eps].
 *   I2 Q coherence: every ACTIVE non-definer window/map period is a
 *      whole multiple or exact divisor of state.quantum — until Q is
 *      handed to a track (setDefiner): from there other tracks drift.
 *   I3 subtree anchoring (docs/composition.md I10/I11, Q18): the
 *      DEFINER STACK (state.definerId) is anchored and its members'
 *      origins equal the stack's (they ride with their parent).
 *   I4 undo/redo round-trip: the graph facts (the tree, names,
 *      durations, origins, maps, tops, re-times, takes, comps, songs,
 *      period sources, quantum, zero, the definer) return EXACTLY after
 *      k undos + k redos.
 *   I5 no NaN/Infinity anywhere in the published state.
 *   I6 an undoable edit that leaves the graph facts as they were — a
 *      refusal, an identity — leaves the undo/redo bookkeeping too; one
 *      aimed at a nonexistent node changes neither.
 *
 * DETERMINISTIC: the op stream derives only from the seeded LCG
 * (helpers.mjs makeLcg); op descriptors carry their random draws, so a
 * recorded sequence replays and shrinks exactly. On a violation the
 * seed + full op log is printed, then the sequence is greedily shrunk
 * and the MINIMAL repro reported. A violation is a bug: fix it — no
 * invariant is ever suppressed or skipped.
 *
 * Env knobs (deep local runs):
 *   FUZZ_SEED=<n>   run only that seed
 *   FUZZ_ITERS=<n>  iterations per seed (CI default below)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario }
    from '../mock_backend.js';
import { findNode as rawNode, state as mockState } from '../mock/state.js';
import { deriveViewModel } from '../view_model.js';
import { flatSegPeriod } from '../time_map.js';
import { posMod } from '../math_utils.js';
import { makeLcg, nodeById } from './helpers.mjs';

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

// Fixed CI seed set (~20 seeds). Chosen arbitrarily; stable forever so
// CI failures are reproducible by seed alone.
const CI_SEEDS = [1, 2, 3, 5, 7, 11, 13, 17, 19, 23,
                  29, 31, 37, 41, 43, 47, 53, 59, 61, 67];

const ENV_SEED = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : null;
const ITERS = process.env.FUZZ_ITERS ? Number(process.env.FUZZ_ITERS)
    : (ENV_SEED != null ? 200 : 100);  // CI: 20 seeds x 100 = 2000/run
const SHRINK_BUDGET = 600;             // max replays per shrink

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const idx = (r, n) => Math.min(n - 1, Math.floor(r * n));
const findIn = (nodes, id) => nodeById(id, nodes);

/** a is (nearly) a whole multiple of m. */
function wholeMultiple(a, m) {
    if (!(m > 0)) return false;
    const r = posMod(a, m);
    const tol = 1e-6 * Math.max(1, m);
    return r < tol || m - r < tol;
}

/** Walk every enriched node depth-first. */
function flatNodes(st, out = []) {
    const walk = ns => (ns || []).forEach(n => { out.push(n); walk(n.nodes); });
    walk(st.nodes);
    return out;
}

/** First NaN/Infinity found anywhere in a JSON-ish value, as a path. */
function findNonFinite(v, path) {
    if (typeof v === 'number') {
        return Number.isFinite(v) ? null : `${path} = ${v}`;
    }
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
            const r = findNonFinite(v[i], `${path}[${i}]`);
            if (r) return r;
        }
        return null;
    }
    if (v && typeof v === 'object') {
        for (const k of Object.keys(v)) {
            const r = findNonFinite(v[k], `${path}.${k}`);
            if (r) return r;
        }
    }
    return null;
}

/** Graph-shape facts for the I4 round-trip (spec: ids, durations,
 * origins, loop points, segments, quantum, zero). Durations of hot
 * (recording/pending) clips excluded — the transport grows them. */
function graphFacts(st) {
    const nodes = [];
    // A song's undoable facts (the audition is a monitoring gesture).
    const song = h => (h.sequence ? {
        steps: h.sequence.steps, gates: h.sequence.gates, seed: h.sequence.seed,
        bypassed: !!h.sequence.bypassed,
    } : null);
    const walk = (ns, parent) => (ns || []).forEach(n => {
        const hot = !!(n.isRecording || n.isPendingStart);
        // The STORED map and top, from the mock's own node: a step
        // audition publishes its derived window over them, and an edit
        // may store the top a lane already showed.
        const stored = rawNode(n.id) || {};
        nodes.push({
            id: n.id, type: n.type, parent, name: n.name, hot,
            dur: hot ? null : (n.duration || 0),
            origin: n.origin || 0,
            ls: stored.loopStart || 0, le: stored.loopEnd || 0,
            byp: !!stored.loopBypassed,
            segs: stored.segments || null,
            storedTop: stored.storedTop ?? null,
            retime: n.retime || 0,
            source: n.periodSource || 'own',
            takes: hot ? null : (n.takes || 0), active: n.activeTake || 0,
            comp: n.comp || [], compCell: n.compCellLen || 0, compOff: n.compOffset || 0,
            domain: n.windowDomain || null, song: song(n),
        });
        walk(n.nodes, n.id);
    });
    walk(st.nodes, '');
    // The root is a stack too: its song, its anchor, its own stored map.
    const root = mockState.root;
    return JSON.stringify({ q: st.quantum, zero: st.islandZero, definer: st.definerId,
                            song: song(st), anchored: !!st.anchored,
                            rootOrigin: st.anchored ? st.origin : 0,
                            rootMap: [root.loopStart || 0, root.loopEnd || 0,
                                      root.segments || null, !!root.loopBypassed,
                                      root.storedTop ?? null, root.windowDomain || null],
                            nodes });
}

/* ------------------------------------------------------------------ */
/* Invariants                                                          */
/* ------------------------------------------------------------------ */

/** Q was handed to a track in this run (setDefiner, Q22): from then on
 * the definer's trims move Q under the other tracks' geometry, which
 * DRIFTS instead of being refused — I2 no longer binds. */
let handOffSeen = false;

/** Nodes whose map was BYPASSED when Q moved under it (a bypassed map is
 * not in use, so it does not hold the definer back): switched on again
 * it plays against a grid it was not judged on, and drifts. I2 binds an
 * edit, not these. */
const staleMaps = new Set();
let lastQuantum = 0;
function noteQuantum(st) {
    if (st.quantum !== lastQuantum) {
        for (const n of flatNodes(st)) {
            const stores = (Array.isArray(n.segments) && n.segments.length >= 4) ||
                (n.loopEnd || 0) > (n.loopStart || 0);
            if (n.loopBypassed && stores) staleMaps.add(n.id);
        }
    }
    lastQuantum = st.quantum;
}

function checkInvariants() {
    let st;
    try { st = getState(); }
    catch (e) { return { inv: 'I1', msg: 'getState threw: ' + (e && e.stack || e) }; }

    noteQuantum(st);

    // I5 — no NaN/Infinity anywhere in the published state.
    const nf = findNonFinite(st, 'state');
    if (nf) return { inv: 'I5', msg: 'non-finite published: ' + nf };

    // I1 — deriveViewModel succeeds and lanes are sane.
    let vm;
    try { vm = deriveViewModel(st); }
    catch (e) { return { inv: 'I1', msg: 'deriveViewModel threw: ' + (e && e.stack || e) }; }
    const eps = 1e-6;
    if (!Number.isFinite(vm.cycleQ)) {
        return { inv: 'I1', msg: 'cycleQ not finite: ' + vm.cycleQ };
    }
    for (const lane of vm.lanes || []) {
        for (const key of ['periodQ', 'intrinsicQ']) {
            const x = lane[key];
            if (x == null) continue;
            if (!Number.isFinite(x) || x < -eps) {
                return { inv: 'I1', msg: `lane ${lane.id} ${key} bad: ${x}` };
            }
        }
        for (const rep of lane.reps || []) {
            if (!Number.isFinite(rep.startQ) || !Number.isFinite(rep.endQ) ||
                rep.startQ < -eps || rep.endQ > vm.cycleQ + eps) {
                return { inv: 'I1', msg: `lane ${lane.id} rep out of frame: ` +
                    `[${rep.startQ}, ${rep.endQ}] cycleQ=${vm.cycleQ}` };
            }
        }
    }

    // I2 — Q coherence of every ACTIVE non-definer window/map. Skipped:
    // the provisional definer itself, direct clip members of a definer
    // STACK (the Q13 exemption zone — their raw extents are legally
    // incommensurate while provisional), and full-span clip windows
    // (they select nothing; their "period" is the material).
    const q = st.quantum;
    if (q > 0 && !handOffSeen) {
        const definer = st.definerId ? findIn(st.nodes, st.definerId) : null;
        const definerMembers = new Set(
            definer && definer.type === 'stack'
                ? (definer.nodes || []).map(m => m.id) : []);
        for (const n of flatNodes(st)) {
            if (!n.windowActive || n.id === st.definerId) continue;
            if (definerMembers.has(n.id) || staleMaps.has(n.id)) continue;
            // A song's steps are free lengths (S10), its audition one of them.
            if (n.sequence && !n.sequence.bypassed) continue;
            const multi = Array.isArray(n.segments) && n.segments.length >= 4;
            if (!multi && n.type === 'clip' && n.duration > 0 &&
                (n.loopStart || 0) <= 0 && (n.loopEnd || 0) >= n.duration) {
                continue;   // full-span: restricts nothing
            }
            const p = multi ? flatSegPeriod(n.segments)
                : (n.loopEnd || 0) - (n.loopStart || 0);
            if (!(p > 0)) continue;
            if (!wholeMultiple(p, q) && !wholeMultiple(q, p)) {
                const kind = (Array.isArray(n.segments) && n.segments.length >= 4)
                    ? 'segments' : 'window';
                const shape = `${n.type} ${kind}` +
                    `${n.isRecording || n.isPendingStart ? ' hot' : ''}` +
                    `${n.duration > 0 ? ' committed' : ' empty'}`;
                return { inv: 'I2', msg: `node ${n.id} [${shape}] active map ` +
                    `period ${p} incoherent with Q ${q} (dur ${n.duration})` };
            }
        }
    }

    // I3 — subtree anchoring (composition.md I10/I11, Q18) for the
    // DEFINER STACK: the stack is ANCHORED (it holds committed content)
    // and its members' origins ride with it — a member's origin equals
    // the stack's, since the group's one take anchored the stack there
    // and every re-anchor since (definer trim, seek, lock-collapse)
    // moved the whole subtree by one delta. (After a trim zero = origin
    // + window start, so "zero ≡ member origin (mod duration)" is no
    // law — composition.md §4.) It binds through a hand-off and a
    // member's re-time too: a mic's own lock leaves the group on the
    // mics it still holds, and mics moved off their group are not its
    // one take.
    if (st.definerId) {
        const d = findIn(st.nodes, st.definerId);
        if (d && d.type === 'stack') {
            if (!d.anchored) {
                return { inv: 'I3', msg: `definer stack ${d.id}: holds ` +
                    `committed content but is not anchored` };
            }
            for (const m of d.nodes || []) {
                if (m.type !== 'clip' || !(m.duration > 0) || m.isRecording) continue;
                if ((m.origin || 0) !== (d.origin || 0)) {
                    return { inv: 'I3', msg: `definer stack ${d.id}: origin ` +
                        `${d.origin} !== member ${m.id} origin ${m.origin} ` +
                        `(the subtree must ride with its stack)` };
                }
            }
        }
    }

    return null;
}

/* ------------------------------------------------------------------ */
/* Op generation (descriptors carry their random draws — replayable)   */
/* ------------------------------------------------------------------ */

const OP_WEIGHTS = [
    ['createClip', 8], ['createStack', 3], ['combine', 2],
    ['rec', 8], ['stop', 8], ['recCancel', 2],
    ['advance', 10], ['loopPoints', 11], ['segments', 6],
    ['toggleWindow', 4], ['seek', 4], ['deleteNode', 5],
    ['undo', 4], ['redo', 3], ['togglePlayback', 3], ['roundtrip', 6],
    ['groupTake', 4],
    ['timing', 5], ['definer', 3], ['periodSource', 3], ['newTake', 4],
    ['sequence', 4], ['toggleSequence', 2], ['reorder', 4], ['rename', 2],
    ['selectTake', 2], ['deleteTake', 2], ['comp', 3],
];
const TOTAL_W = OP_WEIGHTS.reduce((s, [, w]) => s + w, 0);

function genOps(rng) {
    const n = 20 + Math.floor(rng() * 41);   // 20-60 ops
    const ops = [];
    for (let i = 0; i < n; i++) {
        let pick = rng() * TOTAL_W, t = OP_WEIGHTS[0][0];
        for (const [name, w] of OP_WEIGHTS) {
            if (pick < w) { t = name; break; }
            pick -= w;
        }
        ops.push({ t, r: [rng(), rng(), rng(), rng(), rng(), rng()] });
    }
    return ops;
}

/** Pick an existing node id, occasionally a bogus/deleted one. */
function pickId(st, r0, r1, tombstones, { bogusP = 0.08 } = {}) {
    if (r0 < bogusP) {
        const bogus = ['no-such-node', 'mock-root', ...tombstones];
        return bogus[idx(r1, bogus.length)];
    }
    const all = flatNodes(st);
    if (!all.length) return 'no-such-node';
    return all[idx(r1, all.length)].id;
}

/** A window [a, b) for setLoopPoints — coherent, full-span, random,
 * negative, past-duration, reversed, or zero-length. */
function drawWindow(st, node, r) {
    const q = st.quantum > 0 ? st.quantum : 4096;
    const D = node && node.duration > 0 ? node.duration : 4 * q;
    const mode = r[2];
    let a, b;
    if (mode < 0.35) {                       // coherent attempt
        const lens = [q / 4, q / 2, q, 2 * q, 3 * q, 4 * q];
        const len = Math.max(1, Math.round(lens[idx(r[3], lens.length)]));
        a = Math.round(idx(r[4], 8) * q / 4);
        b = a + len;
    } else if (mode < 0.5) {                 // full span
        a = 0; b = Math.round(D);
    } else if (mode < 0.65) {                // random sub-window
        a = Math.floor(r[3] * D); b = a + 1 + Math.floor(r[4] * D);
    } else if (mode < 0.75) {                // negative start
        a = -1 - Math.floor(r[3] * q); b = Math.floor(r[4] * D);
    } else if (mode < 0.85) {                // end past the material
        a = Math.floor(r[3] * D); b = Math.round(D + 1 + r[4] * 2 * q);
    } else if (mode < 0.93) {                // reversed
        a = Math.floor(r[3] * D); b = a - 1 - Math.floor(r[4] * q);
    } else {                                 // zero-length / clear
        a = Math.floor(r[3] * D); b = a;
    }
    if (r[5] < 0.08) { a += 0.25; b += 0.75; }  // fractional stress
    return [a, b];
}

/** A flat segment list, 0-3 cells, sometimes malformed. */
function drawSegments(st, node, r) {
    const q = st.quantum > 0 ? st.quantum : 4096;
    const B = node && node.duration > 0 ? node.duration : 4 * q;
    const count = idx(r[2], 4);              // 0..3 cells
    const pts = [];
    for (let i = 0; i < 2 * count; i++) pts.push(Math.floor(r[(i % 3) + 3] * B * (0.3 + 0.7 * ((i * 7919) % 13) / 13)));
    pts.sort((x, y) => x - y);
    // De-dup adjacent equal points so cells are non-empty by default.
    for (let i = 1; i < pts.length; i++) if (pts[i] <= pts[i - 1]) pts[i] = pts[i - 1] + 1;
    if (r[5] < 0.25 && pts.length >= 2) {    // malform deliberately
        const kind = idx(r[4], 3);
        if (kind === 0) { const t = pts[0]; pts[0] = pts[1]; pts[1] = t; }       // reversed cell
        else if (kind === 1) pts[pts.length - 1] = Math.round(B * 3 + q);        // past intrinsic
        else pts[0] = -1 - Math.floor(r[3] * q);                                  // negative
    }
    return pts;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

/** I6 — AN EDIT THAT CHANGES NOTHING RECORDS NOTHING: an undoable verb
 * that leaves the graph facts as it found them — a refusal, an identity
 * — leaves the undo/redo bookkeeping too; and one aimed at a NONEXISTENT
 * node (`mustRefuse`) changes neither. Checked only when no take is hot
 * (the probe's extra getState() polls tick the transport, which could
 * commit a take — a false positive). */
async function callEdit(method, args, all, { mustRefuse = false } = {}) {
    const anyHot = all.some(n => n.isRecording || n.isPendingStart);
    if (anyHot) return callNative(method, ...args);
    const b = getState();
    const factsBefore = graphFacts(b);
    const logBefore = `undo:${b.canUndo},redo:${b.canRedo}`;
    const answer = await callNative(method, ...args);
    const a = getState();
    const factsAfter = graphFacts(a);
    const logAfter = `undo:${a.canUndo},redo:${a.canRedo}`;
    if (mustRefuse && factsBefore !== factsAfter) {
        throw new FuzzViolation('I6', `${method}('${args[0]}') on a nonexistent ` +
            `node changed the graph:\nBEFORE ${factsBefore}\nAFTER  ${factsAfter}`);
    }
    if (factsBefore === factsAfter && logBefore !== logAfter) {
        throw new FuzzViolation('I6', `${method}(${JSON.stringify(args)}) changed ` +
            `nothing but the undo bookkeeping: ${logBefore} -> ${logAfter}`);
    }
    return answer;
}

const callCheckedNoop = (method, id, args, all) =>
    callEdit(method, [id, ...args], all, { mustRefuse: true });

/** A song payload for setSequence: 1-4 steps on the Q grid, some cued,
 * gates on the holder's children — now and then null (a clear) or
 * malformed (a zero length, a successor out of range). */
function drawSequence(st, holder, r) {
    if (r[2] < 0.15) return null;
    const q = st.quantum > 0 ? st.quantum : 2048;
    const count = 1 + idx(r[3], 4);
    const lens = [q / 2, q, 2 * q, 4 * q];
    const steps = Array.from({ length: count }, (_, i) => ({
        name: String.fromCharCode(65 + i),
        len: Math.round(lens[idx((r[4] * (i + 3)) % 1, lens.length)]),
        cue: ((r[5] * (i + 2)) % 1) < 0.3,
    }));
    if (r[2] < 0.22) steps[0].len = 0;
    else if (r[2] < 0.29) steps[0].next = [{ to: count + 2, w: 1 }];
    const gates = {};
    for (const child of (holder && holder.nodes) || []) {
        if (((r[4] * 7 + child.id.length) % 1) < 0.5) {
            gates[child.id] = steps.map((_, i) => (i + child.id.length) % 2 === 0);
        }
    }
    return { steps, gates };
}

/** Apply one descriptor against the LIVE state. Records the concrete
 * resolved call into `log`. Returns nothing; may throw (a finding). */
async function applyOp(op, log, tombstones) {
    const st = getState();
    const all = flatNodes(st);
    const isBogus = id => id !== 'mock-root' && !findIn(st.nodes, id);
    const stacks = all.filter(n => n.type === 'stack');
    const r = op.r;
    switch (op.t) {
        case 'createClip': case 'createStack': {
            const type = op.t === 'createClip' ? 'clip' : 'stack';
            const parent = r[0] < 0.45 && stacks.length
                ? stacks[idx(r[1], stacks.length)].id : '';
            log.push(`createNode('${type}', '${parent}')`);
            await callNative('createNode', type, parent);
            break;
        }
        case 'combine': {
            if (all.length < 2) { log.push('(combine skipped: <2 nodes)'); break; }
            const a = all[idx(r[0], all.length)];
            const b = all[idx(r[1], all.length)];
            if (a.id === b.id) { log.push('(combine skipped: same node)'); break; }
            log.push(`combineNodes('${a.id}', '${b.id}')`);
            await callNative('combineNodes', a.id, b.id);
            break;
        }
        case 'rec': {
            const pool = [...all.map(n => n.id), 'mock-root'];
            const id = pool[idx(r[0], pool.length)];
            log.push(`startRecordingInNode('${id}')`);
            await callNative('startRecordingInNode', id);
            break;
        }
        case 'stop': {
            const hot = all.filter(n => n.isRecording || n.isPendingStart);
            const id = r[0] < 0.7 && hot.length ? hot[idx(r[1], hot.length)].id
                : (r[0] < 0.85 || !all.length ? 'mock-root'
                    : all[idx(r[1], all.length)].id);
            log.push(`stopRecordingInNode('${id}')`);
            await callNative('stopRecordingInNode', id);
            break;
        }
        case 'recCancel': {
            // Arm then stop immediately (an armed clip cancels).
            const empties = all.filter(n => n.type === 'clip' && !(n.duration > 0));
            const id = empties.length && r[0] < 0.8
                ? empties[idx(r[1], empties.length)].id : 'mock-root';
            log.push(`startRecordingInNode('${id}'); stopRecordingInNode('${id}')  # cancel`);
            await callNative('startRecordingInNode', id);
            await callNative('stopRecordingInNode', id);
            break;
        }
        case 'advance': {
            const q = st.quantum > 0 ? st.quantum : 2048;
            const menu = [0, Math.round(q / 4), Math.round(q / 2), q, q,
                          2 * q, 3 * q, 1 + Math.floor(r[1] * 2.5 * q)];
            const n = Math.max(0, Math.round(menu[idx(r[0], menu.length)]));
            log.push(`advanceBy(${n})`);
            advanceBy(n);
            break;
        }
        case 'loopPoints': {
            const id = pickId(st, r[0], r[1], tombstones);
            const node = findIn(st.nodes, id);
            const [a, b] = drawWindow(st, node, r);
            log.push(`setLoopPoints('${id}', ${a}, ${b})`);
            if (isBogus(id)) await callCheckedNoop('setLoopPoints', id, [a, b], all);
            else await callEdit('setLoopPoints', [id, a, b], all);
            break;
        }
        case 'segments': {
            const id = pickId(st, r[0], r[1], tombstones);
            const node = findIn(st.nodes, id);
            const flat = drawSegments(st, node, r);
            log.push(`setSegments('${id}', [${flat.join(', ')}])`);
            if (isBogus(id)) await callCheckedNoop('setSegments', id, [flat], all);
            else await callEdit('setSegments', [id, flat], all);
            break;
        }
        case 'toggleWindow': {
            const id = pickId(st, r[0], r[1], tombstones);
            log.push(`toggleLoopWindow('${id}')`);
            if (isBogus(id)) await callCheckedNoop('toggleLoopWindow', id, [], all);
            else await callEdit('toggleLoopWindow', [id], all);
            break;
        }
        case 'seek': {
            const q = st.quantum > 0 ? st.quantum : 4096;
            const pos = Math.floor((r[0] - 0.2) * 6 * q);   // sometimes negative
            log.push(`seekTransport(${pos})`);
            await callNative('seekTransport', pos);
            break;
        }
        case 'deleteNode': {
            const id = pickId(st, r[0], r[1], tombstones, { bogusP: 0.05 });
            log.push(`deleteNode('${id}')`);
            if (isBogus(id)) await callCheckedNoop('deleteNode', id, [], all);
            else {
                await callNative('deleteNode', id);
                tombstones.push(id);
                if (tombstones.length > 6) tombstones.shift();
            }
            break;
        }
        case 'undo': log.push('undo()'); await callNative('undo'); break;
        case 'redo': log.push('redo()'); await callNative('redo'); break;
        case 'togglePlayback':
            log.push('togglePlayback()');
            await callNative('togglePlayback');
            break;
        case 'roundtrip': {
            // I4 probe. Skipped while any take is hot: the extra
            // getState() polls advance the transport, which can commit
            // an awaiting-stop take mid-probe (a false positive, not a
            // bookkeeping bug). Only SUCCESSFUL undos are redone — a
            // spare redo would replay a pre-existing redo branch, which
            // is a state change, not a violation.
            const anyHot = all.some(n => n.isRecording || n.isPendingStart);
            if (anyHot) { log.push('(roundtrip skipped)'); break; }
            const k = 1 + idx(r[0], 3);
            log.push(`# I4 probe: facts, up to ${k}x undo, same-count redo, compare`);
            const before = graphFacts(getState());
            let done = 0;
            for (let i = 0; i < k; i++) {
                if (!await callNative('undo')) break;
                done++;
            }
            for (let i = 0; i < done; i++) await callNative('redo');
            const after = graphFacts(getState());
            if (before !== after) {
                throw new FuzzViolation('I4', `undo x${done}/redo x${done} ` +
                    `round-trip changed graph facts:\nBEFORE ${before}\nAFTER  ${after}`);
            }
            break;
        }
        case 'groupTake': {
            // A composite that reliably builds a DEFINER STACK (q13
            // group-take shape): stack + 2-3 clips, one group arm,
            // advance, one group stop, settle — the I3 hot path.
            const n = 2 + idx(r[0], 2);
            const q = st.quantum > 0 ? st.quantum : 2048;
            const len = Math.max(1, Math.round([q / 2, q, 2 * q][idx(r[1], 3)]));
            log.push(`# groupTake: stack + ${n} clips, arm, advanceBy(${len}), stop, settle`);
            const stackId = await callNative('createNode', 'stack', '');
            for (let i = 0; i < n; i++) await callNative('createNode', 'clip', stackId);
            await callNative('startRecordingInNode', stackId);
            advanceBy(len);
            await callNative('stopRecordingInNode', stackId);
            advanceBy(Math.max(1, Math.round(r[2] * len)));
            break;
        }
        case 'timing': {
            const id = pickId(st, r[0], r[1], tombstones);
            const node = findIn(st.nodes, id);
            const q = st.quantum > 0 ? st.quantum : 2048;
            const shifts = [0, q / 4, -q / 4, q, -q, 3 * q, 0.5, Math.floor(r[3] * q)];
            const shift = shifts[idx(r[2], shifts.length)];
            // No top, the top it shows, a random one (kept or not), a bad one.
            const span = node && node.duration > 0 ? node.duration : 4 * q;
            const tops = [null, null, node ? node.loopTop : 0, Math.floor(r[5] * span), -5];
            const top = tops[idx(r[4], tops.length)];
            log.push(`setTiming('${id}', ${shift}, ${top})`);
            await callEdit('setTiming', [id, shift, top], all, { mustRefuse: isBogus(id) });
            break;
        }
        case 'definer': {
            const id = pickId(st, r[0], r[1], tombstones);
            log.push(`setDefiner('${id}')`);
            const facts = graphFacts(st);
            await callEdit('setDefiner', [id], all, { mustRefuse: isBogus(id) });
            if (graphFacts(getState()) !== facts) handOffSeen = true;
            break;
        }
        case 'periodSource': {
            const id = pickId(st, r[0], r[1], tombstones);
            const source = r[2] < 0.65 ? 'context' : 'own';
            log.push(`setPeriodSource('${id}', '${source}')`);
            await callEdit('setPeriodSource', [id, source], all, { mustRefuse: isBogus(id) });
            break;
        }
        case 'newTake': {
            const pool = [...all.map(n => n.id), 'mock-root'];
            const id = pool[idx(r[0], pool.length)];
            log.push(`newTake('${id}')`);
            await callNative('newTake', id);
            // Half the time run it through: to its top, then one period.
            if (r[1] < 0.5) {
                const q = st.quantum > 0 ? st.quantum : 2048;
                const span = Math.max(q, ...all.map(n => n.duration || 0));
                log.push(`advanceBy(${2 * span})  # the new take runs its period`);
                advanceBy(2 * span);
            }
            break;
        }
        case 'sequence': {
            const holders = ['mock-root', ...stacks.map(n => n.id), ...tombstones,
                             ...all.filter(n => n.type === 'clip').slice(0, 1).map(n => n.id)];
            const id = holders[idx(r[0], holders.length)];
            const payload = drawSequence(st, id === 'mock-root' ? st : findIn(st.nodes, id), r);
            log.push(`setSequence('${id}', ${JSON.stringify(payload)})`);
            await callEdit('setSequence', [id, payload], all, { mustRefuse: isBogus(id) });
            break;
        }
        case 'toggleSequence': {
            const holders = ['mock-root', ...stacks.map(n => n.id), 'no-such-node'];
            const id = holders[idx(r[0], holders.length)];
            const holder = id === 'mock-root' ? st : findIn(st.nodes, id);
            log.push(`toggleSequence('${id}')`);
            // (A holder with no song keeps the flag for its next one —
            // a step, but nothing the published state shows.)
            if (holder && !holder.sequence) await callNative('toggleSequence', id);
            else await callEdit('toggleSequence', [id], all, { mustRefuse: isBogus(id) });
            break;
        }
        case 'reorder': {
            const id = pickId(st, r[0], r[1], tombstones);
            // The root, a stack (its own subtree included), a clip, nothing.
            const parents = ['mock-root', 'mock-root', ...stacks.map(n => n.id),
                             ...all.slice(0, 1).map(n => n.id), '', 'no-such-node'];
            const parent = parents[idx(r[2], parents.length)];
            const index = idx(r[3], 4) - 1;
            log.push(`reorderNode('${id}', '${parent}', ${index})`);
            await callEdit('reorderNode', [id, parent, index], all,
                { mustRefuse: isBogus(id) || id === 'mock-root' });
            break;
        }
        case 'rename': {
            const id = pickId(st, r[0], r[1], tombstones);
            const name = `fuzz ${idx(r[2], 4)}`;
            log.push(`renameNode('${id}', '${name}')`);
            await callEdit('renameNode', [id, name], all, { mustRefuse: isBogus(id) });
            break;
        }
        case 'selectTake': case 'deleteTake': {
            const id = pickId(st, r[0], r[1], tombstones);
            const node = findIn(st.nodes, id);
            const k = idx(r[2], (node && node.takes ? node.takes : 1) + 2) - 1;  // −1 … count
            log.push(`${op.t}('${id}', ${k})`);
            await callEdit(op.t, [id, k], all, { mustRefuse: isBogus(id) });
            break;
        }
        case 'comp': {
            const id = pickId(st, r[0], r[1], tombstones);
            const node = findIn(st.nodes, id);
            const q = st.quantum > 0 ? st.quantum : 2048;
            const want = node && node.duration > 0 ? Math.ceil(node.duration / q) : 1;
            const count = r[2] < 0.2 ? 0 : (r[2] < 0.3 ? want + 1 : Math.min(want, 64));
            const takes = node && node.takes ? node.takes : 1;
            // Take indices in range, −1, and now and then one past the list.
            const cells = Array.from({ length: count },
                (_, i) => idx((r[3] * (i + 2)) % 1, takes + 2) - 1 + (r[4] < 0.1 ? 1 : 0));
            log.push(`setComp('${id}', [${cells.join(', ')}])`);
            await callEdit('setComp', [id, cells], all, { mustRefuse: isBogus(id) });
            break;
        }
        default: break;
    }
}

class FuzzViolation extends Error {
    constructor(inv, msg) { super(msg); this.inv = inv; }
}

/** Run a descriptor sequence from a fresh empty session.
 * Returns null, or { violation, at, log }. */
async function runOps(ops) {
    loadScenario('empty');
    handOffSeen = false;
    staleMaps.clear();
    lastQuantum = 0;
    const log = [];
    const tombstones = [];
    for (let i = 0; i < ops.length; i++) {
        try {
            await applyOp(ops[i], log, tombstones);
        } catch (e) {
            const inv = e instanceof FuzzViolation ? e.inv : 'CRASH';
            return { violation: { inv, msg: String(e && e.stack || e) }, at: i, log };
        }
        const v = checkInvariants();
        if (v) return { violation: v, at: i, log };
    }
    return null;
}

/** Greedy shrink: drop ops (chunks, then singles) while a violation of
 * the same invariant persists. */
async function shrink(ops, inv) {
    let cur = ops.slice();
    let budget = SHRINK_BUDGET;
    for (let pass = 0; pass < 8 && budget > 0; pass++) {
        let changed = false;
        for (let size = Math.max(1, cur.length >> 1); size >= 1; size >>= 1) {
            for (let i = 0; i + size <= cur.length && budget > 0;) {
                const cand = cur.slice(0, i).concat(cur.slice(i + size));
                budget--;
                const res = await runOps(cand);
                if (res && res.violation.inv === inv) {
                    cur = cand.slice(0, res.at + 1);
                    changed = true;
                } else {
                    i += size;
                }
            }
            if (size === 1) break;
        }
        if (!changed) break;
    }
    return cur;
}

/** A stable signature for a violation: invariant + message with node
 * ids and numbers normalized (groups the reports of one bug). */
function violationSig(v) {
    const norm = v.msg.split('\n')[0]
        .replace(/node-\d+|stack-\d+/g, '<id>')
        .replace(/-?\d+(\.\d+)?/g, '<n>');
    return `${v.inv}: ${norm}`;
}

/* ------------------------------------------------------------------ */
/* The tests                                                           */
/* ------------------------------------------------------------------ */

// The mock narrates every call; at fuzz volume that is megabytes of
// noise and most of the runtime. Silence log/warn for the fuzz run
// (assert failures and our reports use the real console.error).
const realLog = console.log, realWarn = console.warn;
console.log = () => {};
console.warn = () => {};
process.on('exit', () => { console.log = realLog; console.warn = realWarn; });

for (const seed of ENV_SEED != null ? [ENV_SEED] : CI_SEEDS) {
    test(`fuzz loop-region: seed ${seed} (${ITERS} iterations)`, async () => {
        const rng = makeLcg(seed);
        const failures = [];
        for (let iter = 0; iter < ITERS; iter++) {
            const ops = genOps(rng);
            const res = await runOps(ops);
            if (!res) continue;
            const sig = violationSig(res.violation);
            // Report: seed + full op log, then the shrunken minimum.
            const minOps = await shrink(ops.slice(0, res.at + 1), res.violation.inv);
            const minRes = await runOps(minOps);
            const lines = [
                `VIOLATION ${res.violation.inv} @ seed ${seed} iter ${iter} op ${res.at}`,
                `signature: ${sig}`,
                res.violation.msg,
                `--- full op log (${res.log.length} ops) ---`,
                ...res.log.map((l, i) => `  ${i === res.at ? '>' : ' '} ${l}`),
                `--- MINIMAL repro (${minRes ? minRes.log.length : '?'} ops; ` +
                `descriptors below replay via runOps) ---`,
                ...(minRes ? minRes.log.map(l => `    ${l}`) : ['  (shrink lost the violation)']),
                `--- minimal descriptors (JSON) ---`,
                JSON.stringify(minOps),
                minRes ? `--- minimal violation: ${minRes.violation.inv}: ${minRes.violation.msg.split('\n')[0]}` : '',
            ];
            console.error(lines.join('\n'));
            failures.push(sig);
            if (failures.length >= 3) break;   // enough per seed
        }
        assert.equal(failures.length, 0,
            `seed ${seed}: ${failures.length} violation(s) — ` +
            failures.join(' | '));
    });
}
