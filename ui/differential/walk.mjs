/**
 * THE RANDOM WALK: seeded op sequences over the journeys' verb set,
 * driven against both backends from an empty session and compared after
 * every op (session.mjs, no undo probe — undo and redo are ops here).
 *
 * An op is a DESCRIPTOR { t, r: [six draws] }: it carries its randomness
 * and resolves against the live state when applied (which node, which
 * window), so a recorded sequence replays exactly and shrinks by
 * dropping ops (the idea of ui/js/tests/fuzz_loop_region.test.mjs).
 * Choices read the ENGINE's state — it is the clock and the source of
 * truth; the same resolved call then goes to both sides by label.
 *
 * What a diff does to a walk:
 *   - claimed by an `everywhere` pattern of known_drift.mjs — ignored,
 *     the walk goes on;
 *   - claimed by a KNOWN_WALK rule ({ family, verb, field, engine?,
 *     mock?, when?(engineState, mockState) }) — the two sides have
 *     parted on a known drift: the walk ends there, counted under its
 *     family;
 *   - anything else — a FINDING: the sequence is shrunk to a minimum
 *     and the run fails with it.
 * Seeds are fixed, so a run is reproducible and a KNOWN_WALK rule that
 * ends no walk is stale.
 */

import { BLOCK } from './engine_process.mjs';
import { showValue } from './normalize.mjs';
import { JourneyEnd } from './session.mjs';
import { Q } from './journeys.mjs';

export const WALK_SEEDS = [1, 2, 3, 5, 7, 11, 13, 17];
export const WALKS_PER_SEED = 12;
const OPS_MIN = 16;
const OPS_SPAN = 30;
const SHRINK_BUDGET = 150;

/** Park–Miller, as ui/js/tests/helpers.mjs makeLcg. */
function makeLcg(seed) {
    return () => (seed = (seed * 48271) % 2147483647) / 2147483647;
}

const OP_WEIGHTS = [
    ['take', 14], ['advance', 12], ['createClip', 5], ['createStack', 3],
    ['arm', 3], ['stop', 4], ['newTake', 4],
    ['window', 10], ['cells', 5], ['toggleWindow', 4], ['timing', 4],
    ['selectTake', 2], ['deleteTake', 2], ['comp', 2],
    ['combine', 3], ['reorder', 3], ['delete', 4], ['rename', 1], ['mute', 2],
    ['periodSource', 2], ['definer', 2],
    ['song', 4], ['toggleSong', 2], ['audition', 2],
    ['seek', 3], ['undo', 6], ['redo', 4], ['knob', 2], ['import', 2], ['pause', 1],
];
const TOTAL_WEIGHT = OP_WEIGHTS.reduce((n, [, w]) => n + w, 0);

function genOps(rng) {
    const count = OPS_MIN + Math.floor(rng() * OPS_SPAN);
    const ops = [];
    for (let i = 0; i < count; i++) {
        let pick = rng() * TOTAL_WEIGHT;
        let t = OP_WEIGHTS[0][0];
        for (const [name, w] of OP_WEIGHTS) {
            if (pick < w) { t = name; break; }
            pick -= w;
        }
        ops.push({ t, r: [rng(), rng(), rng(), rng(), rng(), rng()] });
    }
    return ops;
}

const at = (r, n) => Math.min(n - 1, Math.floor(r * n));
const hot = n => !!(n.isRecording || n.isPendingStart || n.isAwaitingStop);

/** The live nodes by label, per the engine: [{ label, node }]. */
function live(s) {
    return s.order.map(label => ({ label, node: s.engineNode(label) })).filter(x => x.node);
}

/** A node label — now and then one that names nothing. */
function pickLabel(s, r0, r1, want = () => true) {
    if (r0 < 0.05) return 'no-such-node';
    const pool = live(s).filter(x => want(x.node));
    return pool.length ? pool[at(r1, pool.length)].label : 'no-such-node';
}

const isClip = n => n.type === 'clip';
const isStack = n => n.type === 'stack';
const committed = n => isClip(n) && n.duration > 0 && !hot(n);

/** A take through the bridge, without assuming the arm is accepted. */
async function recordInto(s, label, len) {
    const first = !(s.last.engine.quantum > 0);
    await s.callLive('startRecordingInNode', label);
    await s.advance(BLOCK);
    if (!s.hotIn(label)(s.last.engine)) return;
    const limit = 12 * Math.max(Q, s.last.engine.quantum || Q);
    try {
        await s.until(`${label} capturing`, st => s.capturingIn(label)(st) || !s.hotIn(label)(st), limit);
    } catch (e) {
        if (e instanceof JourneyEnd) throw e;
    }
    const node = s.engineNode(label);
    if (!node || !node.isRecording) return;
    const islandQ = s.last.engine.quantum;
    const target = first ? len : len - Math.floor(Math.min(len, islandQ) / 4);
    if (target > node.duration) await s.advance(target - node.duration);
    await s.callLive('stopRecordingInNode', label);
    try {
        await s.until(`${label} settled`, st => !s.hotIn(label)(st), limit);
    } catch (e) {
        if (e instanceof JourneyEnd) throw e;
    }
    await s.advance(BLOCK);
}

/** Apply one descriptor. `log` gets the resolved call, for the report. */
async function applyOp(s, op, log) {
    const r = op.r;
    const st = s.last.engine;
    const q = st.quantum > 0 ? st.quantum : Q;
    const note = text => log.push(text);
    if (NEEDS_Q.has(op.t) && !(st.quantum > 0)) return;
    switch (op.t) {
        case 'createClip': case 'createStack': {
            const type = op.t === 'createClip' ? 'clip' : 'stack';
            const parent = r[0] < 0.4 ? pickLabel(s, 1, r[1], isStack) : '';
            note(`createNode(${type}, ${parent || 'top'})`);
            await s.callLive('createNode', type, parent === 'no-such-node' ? '' : parent);
            break;
        }
        case 'take': {
            const parent = r[0] < 0.3 ? pickLabel(s, 1, r[1], isStack) : '';
            const len = st.quantum > 0
                ? [q / 2, q, q, 2 * q, 3 * q, 4 * q][at(r[2], 6)]
                : [Q, Q, 2 * Q, 4 * Q][at(r[2], 4)];
            note(`take ${len} under ${parent === 'no-such-node' || !parent ? 'top' : parent}`);
            const before = new Set(s.order);
            await s.callLive('createNode', 'clip', parent === 'no-such-node' ? '' : parent);
            const made = s.order.find(l => !before.has(l));
            if (made) await recordInto(s, made, Math.round(len));
            break;
        }
        case 'arm': {
            const label = pickLabel(s, r[0], r[1]);
            note(`startRecordingInNode(${label})`);
            await s.callLive('startRecordingInNode', label);
            await s.advance(BLOCK);
            break;
        }
        case 'stop': {
            const up = live(s).filter(x => hot(x.node));
            const label = up.length && r[0] < 0.8 ? up[at(r[1], up.length)].label : pickLabel(s, r[0], r[1]);
            note(`stopRecordingInNode(${label})`);
            await s.callLive('stopRecordingInNode', label);
            await s.advance(BLOCK);
            break;
        }
        case 'newTake': {
            const label = pickLabel(s, r[0], r[1], n => committed(n) || isStack(n));
            note(`newTake(${label})`);
            await s.callLive('newTake', label);
            await s.advance(BLOCK);
            break;
        }
        case 'advance': {
            const menu = [BLOCK, q / 4, q / 2, q, q, 2 * q, 4 * q, 1 + Math.floor(r[1] * 2.5 * q)];
            const n = Math.max(1, Math.round(menu[at(r[0], menu.length)]));
            note(`advance(${n})`);
            await s.advance(n);
            break;
        }
        case 'window': {
            const label = pickLabel(s, r[0], r[1], n => committed(n) || isStack(n));
            const node = s.engineNode(label);
            const span = node && node.duration > 0 ? node.duration : 4 * q;
            let a, b;
            if (r[2] < 0.6) {                    // on the Q grid
                const len = [q / 2, q, 2 * q, 3 * q][at(r[3], 4)];
                a = at(r[4], 4) * q;
                b = a + len;
            } else if (r[2] < 0.75) {            // whole
                a = 0; b = span;
            } else if (r[2] < 0.85) {            // clear
                a = 0; b = 0;
            } else {                             // anything
                a = Math.floor(r[3] * span); b = Math.floor(r[4] * 1.5 * span);
            }
            note(`setLoopPoints(${label}, ${a}, ${b})`);
            await s.callLive('setLoopPoints', label, Math.round(a), Math.round(b));
            break;
        }
        case 'cells': {
            const label = pickLabel(s, r[0], r[1], n => committed(n) || isStack(n));
            const start = at(r[2], 2) * q;
            const flat = r[3] < 0.15 ? [] : [start, start + q, start + 2 * q, start + 3 * q];
            note(`setSegments(${label}, [${flat.join(', ')}])`);
            await s.callLive('setSegments', label, flat);
            break;
        }
        case 'toggleWindow': {
            const label = pickLabel(s, r[0], r[1]);
            note(`toggleLoopWindow(${label})`);
            await s.callLive('toggleLoopWindow', label);
            break;
        }
        case 'timing': {
            const label = pickLabel(s, r[0], r[1], committed);
            const shift = [q, -q, q / 4, 1234][at(r[2], 4)];
            note(`setTiming(${label}, ${shift})`);
            await s.callLive('setTiming', label, Math.round(shift));
            break;
        }
        case 'selectTake': case 'deleteTake': {
            const label = pickLabel(s, r[0], r[1], committed);
            const index = at(r[2], 3);
            note(`${op.t}(${label}, ${index})`);
            await s.callLive(op.t, label, index);
            break;
        }
        case 'comp': {
            const label = pickLabel(s, r[0], r[1], committed);
            const node = s.engineNode(label);
            const cells = node && st.quantum > 0 ? Math.ceil(node.duration / st.quantum) : 1;
            const comp = r[2] < 0.2 ? [] : Array.from({ length: Math.min(cells, 16) },
                (_, i) => (i + at(r[3], 2)) % Math.max(1, node ? node.takes : 1));
            note(`setComp(${label}, [${comp.join(', ')}])`);
            await s.callLive('setComp', label, comp);
            break;
        }
        case 'combine': {
            const a = pickLabel(s, r[0], r[1]);
            const b = pickLabel(s, r[2], r[3]);
            note(`combineNodes(${a}, ${b})`);
            await s.callLive('combineNodes', a, b);
            break;
        }
        case 'reorder': {
            const label = pickLabel(s, r[0], r[1]);
            const parent = r[2] < 0.5 ? '@ROOT' : pickLabel(s, 1, r[3], isStack);
            const index = at(r[4], 3);
            note(`reorderNode(${label}, ${parent}, ${index})`);
            await s.callLive('reorderNode', label, parent, index);
            break;
        }
        case 'delete': {
            const label = pickLabel(s, r[0], r[1]);
            note(`deleteNode(${label})`);
            await s.callLive('deleteNode', label);
            break;
        }
        case 'rename': {
            const label = pickLabel(s, r[0], r[1]);
            const name = `walk ${at(r[2], 9)}`;
            note(`renameNode(${label})`);
            await s.callLive('renameNode', label, name);
            break;
        }
        case 'mute': {
            const label = pickLabel(s, r[0], r[1]);
            note(`toggleMute(${label})`);
            await s.callLive('toggleMute', label);
            break;
        }
        case 'periodSource': {
            const label = pickLabel(s, r[0], r[1]);
            const source = r[2] < 0.7 ? 'context' : 'own';
            note(`setPeriodSource(${label}, ${source})`);
            await s.callLive('setPeriodSource', label, source);
            break;
        }
        case 'definer': {
            const label = pickLabel(s, r[0], r[1], n => committed(n) || isStack(n));
            note(`setDefiner(${label})`);
            await s.callLive('setDefiner', label);
            break;
        }
        case 'song': {
            const holder = r[0] < 0.6 ? '@ROOT' : pickLabel(s, 1, r[1], isStack);
            const gated = pickLabel(s, 1, r[2], isClip);
            const lens = [2 * q, 4 * q][at(r[3], 2)];
            const payload = r[4] < 0.15 ? null : {
                steps: [{ name: 'A', len: lens }, { name: 'B', len: lens, cue: r[5] < 0.3 }],
                gates: gated === 'no-such-node' ? {} : { [gated]: [1, 0] },
            };
            note(`setSequence(${holder}, ${payload ? `2×${lens}${payload.steps[1].cue ? ' cue' : ''} gating ${gated}` : 'null'})`);
            await s.callLive('setSequence', holder, payload);
            break;
        }
        case 'toggleSong': {
            const holder = r[0] < 0.6 ? '@ROOT' : pickLabel(s, 1, r[1], isStack);
            note(`toggleSequence(${holder})`);
            await s.callLive('toggleSequence', holder);
            break;
        }
        case 'audition': {
            const holder = r[0] < 0.6 ? '@ROOT' : pickLabel(s, 1, r[1], isStack);
            const step = at(r[2], 3) - 1;
            note(`auditionStep(${holder}, ${step})`);
            await s.callLive('auditionStep', holder, step);
            break;
        }
        case 'seek': {
            const delta = Math.round((r[0] - 0.3) * 6 * q);
            note(`seekTransport(${delta})`);
            await s.callLive('seekTransport', delta);
            break;
        }
        case 'undo': note('undo()'); await s.callLive('undo'); break;
        case 'redo': note('redo()'); await s.callLive('redo'); break;
        case 'knob': {
            const label = pickLabel(s, r[0], r[1]);
            const verb = ['setNodeGain', 'setNodePan', 'toggleSolo'][at(r[2], 3)];
            note(`${verb}(${label})`);
            if (verb === 'toggleSolo') await s.callLive(verb, label);
            else await s.callLive(verb, label, Math.round(r[3] * 10) / 10);
            break;
        }
        case 'import': {
            const label = r[0] < 0.3 ? '@ROOT' : pickLabel(s, r[0], r[1]);
            const len = [Q, 2 * Q][at(r[2], 2)];
            note(`importAudio(${label}, ${len} samples, zero+${Math.round(at(r[3], 4) * q)})`);
            await s.callLive('importAudio', label, s.wav(len), s.fromZero(Math.round(at(r[3], 4) * q)));
            break;
        }
        case 'pause': {
            note('togglePlayback() ×2 around 3 blocks');
            await s.callLive('togglePlayback');
            await s.advance(3 * BLOCK);
            await s.callLive('togglePlayback');
            await s.advance(BLOCK);
            break;
        }
        default: break;
    }
}

function ruleClaims(rule, r, states) {
    if (rule.field !== r.field) return false;
    if (rule.verb !== undefined && rule.verb !== r.verb) return false;
    if ('engine' in rule && showValue(rule.engine) !== showValue(r.engine)) return false;
    if ('mock' in rule && showValue(rule.mock) !== showValue(r.mock)) return false;
    if (rule.when && !rule.when(states.engine, states.mock)) return false;
    return true;
}

/** The ops that author geometry, songs or takes of a slot: not walked
 * before the island has a Q. (The engine scrubs geometry authored on an
 * empty island when Q is established; the journeys hold the one case
 * the view can reach, a song before the first take.) */
const NEEDS_Q = new Set([
    'window', 'cells', 'toggleWindow', 'timing', 'song', 'toggleSong', 'audition',
    'definer', 'periodSource', 'comp', 'selectTake', 'deleteTake', 'newTake', 'seek',
]);

/**
 * Run the walks. `ctx` = { openSession, engineDown, ledger, known,
 * seeds, walks, out }. Answers { summary, failures, stale, findings,
 * endings }.
 */
export async function runWalks(ctx) {
    const seeds = ctx.seeds || WALK_SEEDS;
    const perSeed = ctx.walks || WALKS_PER_SEED;
    const hits = new Map();
    const endings = {};
    const findings = [];
    let walks = 0, clean = 0, opsRun = 0, compares = 0;

    /** One descriptor sequence from an empty session. Answers
     * { end: null | { kind, record, rule }, log, done }. */
    async function runOps(ops, name) {
        let end = null;
        const log = [];
        let s = null;
        const onDiffs = records => {
            for (const r of records) {
                if (ctx.ledger.judge(r)) continue;
                const rule = ctx.known.find(k => ruleClaims(k, r, s.last));
                end = rule ? { kind: 'known', record: r, rule } : { kind: 'finding', record: r };
                return 'end';
            }
            return 'go';
        };
        let done = 0;
        try {
            s = await ctx.openSession({ journey: name, probe: false, onDiffs });
            for (const op of ops) {
                await applyOp(s, op, log);
                done++;
            }
        } catch (e) {
            if (!(e instanceof JourneyEnd)) {
                end = { kind: 'error', error: String(e && e.stack || e) };
                ctx.engineDown();
            }
        }
        if (s) compares += s.compares;
        return { end, log, done };
    }

    const sigOf = end => `${end.record.verb}|${end.record.field}`;

    async function shrink(ops, sig) {
        let cur = ops.slice();
        let budget = SHRINK_BUDGET;
        for (let pass = 0; pass < 6 && budget > 0; pass++) {
            let changed = false;
            for (let size = Math.max(1, cur.length >> 1); size >= 1; size >>= 1) {
                for (let i = 0; i + size <= cur.length && budget > 0;) {
                    const cand = cur.slice(0, i).concat(cur.slice(i + size));
                    budget--;
                    const res = await runOps(cand, 'walk (shrinking)');
                    if (res.end && res.end.kind === 'finding' && sigOf(res.end) === sig) {
                        cur = cand.slice(0, res.done + 1);
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

    for (const seed of seeds) {
        const rng = makeLcg(seed);
        for (let w = 0; w < perSeed; w++) {
            const ops = genOps(rng);
            const name = `walk seed ${seed} #${w + 1}`;
            const res = await runOps(ops, name);
            walks++;
            opsRun += res.done;
            if (!res.end) { clean++; continue; }
            if (res.end.kind === 'known') {
                hits.set(res.end.rule, (hits.get(res.end.rule) || 0) + 1);
                (endings[res.end.rule.family] = endings[res.end.rule.family] || []).push({
                    name, ops: res.done + 1, of: ops.length, record: res.end.record,
                });
                continue;
            }
            if (res.end.kind === 'error') {
                findings.push({ name, error: res.end.error, log: res.log });
                continue;
            }
            const sig = sigOf(res.end);
            const seen = findings.find(f => f.sig === sig);
            if (seen) { seen.also.push(name); continue; }   // one report per signature
            const minimal = ctx.shrink === false
                ? ops.slice(0, res.done + 1) : await shrink(ops.slice(0, res.done + 1), sig);
            const again = await runOps(minimal, `${name} (minimal)`);
            findings.push({
                name, sig, also: [],
                record: (again.end && again.end.record) || res.end.record,
                log: again.end ? again.log : res.log,
                shrunk: !!again.end,
                descriptors: minimal,
            });
        }
    }

    const failures = [];
    for (const f of findings) {
        if (f.error) {
            failures.push(`${f.name}: ${f.error.split('\n')[0]}`);
            continue;
        }
        failures.push(`${f.name}${f.also.length ? ` (+${f.also.length} more walks)` : ''}: ` +
            `[${f.record.step}] ${f.record.key}: engine ${showValue(f.record.engine)} mock ${showValue(f.record.mock)}`);
        failures.push(`    minimal sequence (${f.log.length} ops${f.shrunk ? '' : ', not shrunk'}): ${f.log.join(' ; ')}`);
    }
    const stale = ctx.known.filter(k => !hits.get(k))
        .map(k => ({ family: { id: k.family }, claim: k, kind: 'walk' }));
    const ended = Object.entries(endings).map(([family, list]) => `${family} ×${list.length}`).join(', ');
    const summary = `walk: ${walks} walks over seeds [${seeds.join(', ')}], ${opsRun} ops, ` +
        `${compares} compare points: ${clean} ran to their end with no unclaimed diff, ` +
        `${walks - clean - findings.length - findings.reduce((n, f) => n + (f.also ? f.also.length : 0), 0)} ` +
        `ended at a known drift${ended ? ` (${ended})` : ''}, ${findings.length} findings`;
    return { summary, failures, stale, findings, endings, walks, clean };
}
