/**
 * A SESSION: one verb sequence driven against the engine and the mock
 * at once, compared after every step.
 *
 *   const s = new Session({ engine, mock, journey, q });
 *   await s.begin();
 *   await s.create('@A');                     // createNode, bound to @A
 *   await s.call('startRecordingInNode', '@A');
 *   await s.advance(q);
 *   …
 *
 * NODES are named by LABEL (`@A`): ids differ between the backends, so
 * a label resolves to each side's own id wherever it appears in a call's
 * arguments (values and object keys — a sequence's gates). A node no
 * step named gets `@n1`, `@n2` … in tree order; the two sides' new nodes
 * pair up in that order. `@ROOT` is the root.
 *
 * TIME PARITY. The engine's clock is paused; `advance(n)` renders n
 * samples through the device callback in blocks of 512 (a last partial
 * block when n is not a multiple). The mock is then advanced by exactly
 * what the engine's TRANSPORT moved — read from the published clock
 * (islandPos + islandZero) — in the same blocks. So:
 *   - verbs are issued between two blocks, on both sides at the same
 *     clock reading;
 *   - a stopped engine transport moves neither clock; the declick tail
 *     the engine runs after a pause (one fade length, to the block's
 *     end) moves both;
 *   - the mock's own isPlaying does not gate its clock here (it is a
 *     compared fact; were it also the clock's switch, one missing
 *     `isPlaying = true` would make every later step differ).
 * COMPARE POINTS. A 'block' point is right after an advance that
 * rendered audio; a 'verb' point is right after a bridge call. The take
 * flags (isRecording / isPendingStart / isAwaitingStop), a live take's
 * length and the window phase (`playhead`) belong to the audio thread —
 * the engine publishes an arm as pending until its next block picks it
 * up — so they are read at block points; at verb points the three flags
 * fold into one `hot` (fields.mjs).
 *
 * WHAT A STEP REPORTS: the keys that differ now and did not differ at
 * the previous compare point. An undo probe is judged against the state
 * before its step as well, a redo probe against the state after it, so
 * a drift is reported where it first appears and not again each time an
 * undo/redo pair walks across it.
 */

import path from 'node:path';

import { BLOCK } from './engine_process.mjs';
import { normalise, diff, deepEqual } from './normalize.mjs';
import { scratchDir, wavOf } from './wav.mjs';
import { BRIDGE_METHODS, answerKind } from '../js/protocol.js';

const HANDLE = /^@[A-Za-z0-9_]+$/;

/** A node a verb made, by its label: ids differ between the sides. */
const madeNode = (r, side) => (r ? side.labelOf(String(r)) || 'an unlabelled node' : r);
/** A record as its keys and their types: the values are each side's own
 * (a folder, a dated id). */
const shapeOf = record => (record && typeof record === 'object' && !Array.isArray(record)
    ? Object.fromEntries(Object.keys(record).sort().map(k => [k, typeof record[k]]))
    : record);
/** A listing whose rows are each side's own library: it reads the same
 * on both sides when it is a list and every row holds exactly `keys`,
 * all text — else it reads as the raw answer, and differs. */
const listOf = keys => rows => (Array.isArray(rows) && rows.every(row =>
    row && typeof row === 'object' &&
    deepEqual(Object.keys(row).sort(), keys) && keys.every(k => typeof row[k] === 'string'))
    ? `a list of {${keys.join(', ')}}` : rows);

/** The verbs that answer a value, each mapped to its comparable form. */
const VALUE_RETURNS = {
    ping: r => r,
    seekTransport: r => (r && typeof r === 'object' ? { advance: Math.round(r.advance) } : r),
    createNode: madeNode,
    combineNodes: madeNode,
    getProjectInfo: shapeOf,
    listTemplates: listOf(['id', 'name', 'path']),
    listRecentProjects: listOf(['id', 'name', 'path']),
    // The track-template library is the journey's own: row for row.
    listTrackTemplates: rows => rows,
};

/**
 * THE ANSWERS COMPARED (ui/js/protocol.js `returns`). A verb that
 * answers whether it applied, and one nothing can refuse, are compared
 * as they come: `true` and `false` exactly, so a mock that announces
 * what the engine refused — or answers nothing at all — is a diff. A
 * value is compared in the form above; a value with no form here is the
 * side's own business (a waveform, a device list).
 */
const RETURNS = Object.fromEntries(BRIDGE_METHODS
    .map(m => [m.name, answerKind(m) === 'value' ? VALUE_RETURNS[m.name] : (r => r)])
    .filter(([, read]) => read));

/** Thrown to stop a journey at a diff the known-drift list marks as one
 * the rest of the journey cannot be read past. */
export class JourneyEnd extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}

export function findNode(state, id) {
    for (const n of state.nodes || []) {
        if (n.id === id) return n;
        const hit = findNode(n, id);
        if (hit) return hit;
    }
    return null;
}

/** Samples every session lets pass before its first step. */
const PRE_ROLL = 1000;

/** The verbs that hand a take to the audio thread (see COMPARE POINTS). */
const TAKE_VERBS = new Set(['startRecordingInNode', 'stopRecordingInNode', 'newTake']);

/** The fields fields.mjs reads at one kind of compare point only. */
const POINT_ONLY = {
    block: new Set(['isRecording', 'isPendingStart', 'isAwaitingStop', 'playhead', 'firstTakeCursor']),
    verb: new Set(['hot']),
};

const isHot = n => !!(n.isRecording || n.isPendingStart || n.isAwaitingStop);
const anyHot = node => (node.nodes || []).some(n => isHot(n) || anyHot(n));
const hotIds = (node, out = []) => {
    for (const n of node.nodes || []) {
        if (isHot(n)) out.push(n.id);
        hotIds(n, out);
    }
    return out;
};

function idsInOrder(state, out = []) {
    for (const n of state.nodes || []) {
        out.push(n.id);
        idsInOrder(n, out);
    }
    return out;
}

export class Session {
    /**
     * engine, mock — sides (sides.mjs); journey — the name records carry;
     * q — the journey's Q in samples (labels print sample counts in Q);
     * probe — follow every call with undo and redo, comparing after each;
     * onDiffs(records) → 'end' stops the journey; keys — a KeySets.
     */
    constructor({ engine, mock, journey, q = 0, probe = false, onDiffs = null, onStep = null, keys = null, rate = 44100 }) {
        this.engine = engine;
        this.mock = mock;
        this.journey = journey;
        this.q = q;
        this.probe = probe;
        this.onDiffs = onDiffs;
        this.onStep = onStep;   // ({ step, point, engine, mock, differing }) after every compare
        this.keys = keys;
        this.rate = rate;
        this.records = [];
        this.trace = [];
        this.steps = 0;
        this.compares = 0;
        this.ids = { engine: new Map(), mock: new Map() };       // label → id
        this.labels = { engine: new Map(), mock: new Map() };    // id → label
        this.order = [];                                          // labels, creation order
        this.autoLabels = 0;
        this.wanted = [];                                         // labels the next step binds
        this.labelCount = new Map();
        this.prev = new Set();
        this.open = new Map();                                    // key → its live record
        this.hotBefore = new Set();                               // labels under a take at the last compare
        this.last = { engine: null, mock: null };
        this.engineClock = 0;
        // No take verb since the last block, and no take up there: the
        // published cursor is the message thread's to compute.
        this.viewSettled = true;
        // The two absolute clocks agree from the reset to the first arm
        // (the mock restarts its clock there).
        this.clockAligned = true;
    }

    /** Both sides empty, clocks aligned, transports as the engine's
     * reset leaves them (playing). Answers the engine's normalised
     * empty state (the runner checks it is pristine, then calls
     * `start`). */
    async begin() {
        await this.engine.reset();
        // A fresh engine's clock stands at 0, a reused one's anywhere:
        // the pre-roll leaves neither on a whole second, where the
        // pre-Q cursor's fold would read 0 by coincidence.
        await this.engine.advance(PRE_ROLL);
        const est = await this.engine.state();
        this.engineClock = est.islandPos + est.islandZero;
        const mst = await this.mock.reset({
            rate: this.rate, clock: this.engineClock, playing: !!est.isPlaying,
        });
        this.last = { engine: est, mock: mst };
        this.#bindLabel('engine', '@ROOT', this.engine.rootId);
        this.#bindLabel('mock', '@ROOT', this.mock.rootId);
        this.atBegin = this.#compare('verb', est, mst, null);
        this.prev = new Set(this.atBegin.map(d => d.key));
        return normalise(est, this.#ctx('engine', 'verb'));
    }

    /** Report what already differs on the empty pair (after the runner
     * has judged the engine's empty state pristine). */
    start() {
        this.#report('begin', 'reset', 'verb', this.atBegin);
    }

    // ------------------------------------------------------------ labels

    #bindLabel(side, label, id) {
        this.ids[side].set(label, id);
        this.labels[side].set(id, label);
    }

    idOf(side, label) {
        return this.ids[side].get(label) || `unbound${label}`;
    }

    /** The engine's record of `label` in its last state (null: absent). */
    engineNode(label, state = this.last.engine) {
        return findNode(state, this.idOf('engine', label));
    }

    #ctx(side, point) {
        return {
            point,
            labelOf: id => this.labels[side].get(id),
            // A take was up on this node at the previous compare point.
            settling: id => this.hotBefore.has(this.labels[side].get(id)),
            viewSettled: this.viewSettled,
            clockAligned: this.clockAligned,
            rate: this.rate,
        };
    }

    /** Name the nodes neither side's map knows yet: the labels the step
     * asked for first, then @n1, @n2 … — the two sides' new nodes pair
     * in tree order. */
    #bindNew(est, mst) {
        const fresh = {
            engine: idsInOrder(est).filter(id => !this.labels.engine.has(id)),
            mock: idsInOrder(mst).filter(id => !this.labels.mock.has(id)),
        };
        const count = Math.max(fresh.engine.length, fresh.mock.length);
        for (let i = 0; i < count; i++) {
            const label = this.wanted.shift() || `@n${++this.autoLabels}`;
            this.order.push(label);
            if (i < fresh.engine.length) this.#bindLabel('engine', label, fresh.engine[i]);
            if (i < fresh.mock.length) this.#bindLabel('mock', label, fresh.mock[i]);
        }
        this.wanted = [];
    }

    // --------------------------------------------------------- arguments

    #resolve(value, side) {
        if (typeof value === 'function') return value(side, this);
        if (typeof value === 'string') return HANDLE.test(value) ? this.idOf(side, value) : value;
        if (Array.isArray(value)) return value.map(v => this.#resolve(v, side));
        if (value && typeof value === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(value)) {
                out[HANDLE.test(k) ? this.idOf(side, k) : k] = this.#resolve(v, side);
            }
            return out;
        }
        return value;
    }

    /** A sample count in Q where that reads better. */
    fmt(n) {
        const q = this.q;
        if (typeof n !== 'number' || !Number.isInteger(n) || !(q > 0)) return String(n);
        const eighth = q / 8;
        if (n !== 0 && Number.isInteger(eighth) && Math.abs(n) >= eighth && n % eighth === 0) {
            return `${n / q}Q`;
        }
        return String(n);
    }

    #show(value) {
        if (typeof value === 'function') return value.label || 'ƒ';
        if (typeof value === 'number') return this.fmt(value);
        if (typeof value === 'string') return HANDLE.test(value) ? value : JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(v => this.#show(v)).join(',')}]`;
        if (value && typeof value === 'object') {
            return `{${Object.entries(value).map(([k, v]) => `${k}:${this.#show(v)}`).join(',')}}`;
        }
        return String(value);
    }

    #label(base) {
        const n = (this.labelCount.get(base) || 0) + 1;
        this.labelCount.set(base, n);
        return n === 1 ? base : `${base}#${n}`;
    }

    // ----------------------------------------------------------- compare

    #compare(point, est, mst, answers) {
        if (this.keys) {
            this.keys.note('engine', est);
            this.keys.note('mock', mst);
        }
        const found = diff(normalise(est, this.#ctx('engine', point)),
                           normalise(mst, this.#ctx('mock', point)));
        if (answers && RETURNS[answers.verb]) {
            const read = RETURNS[answers.verb];
            const e = read(answers.engine, { labelOf: id => this.labels.engine.get(id) });
            const m = read(answers.mock, { labelOf: id => this.labels.mock.get(id) });
            if (!deepEqual(e, m)) {
                found.push({ key: 'call.returns', scope: 'call', field: 'returns', engine: e, mock: m });
            }
        }
        this.compares++;
        return found;
    }

    #report(step, verb, point, fresh) {
        if (!fresh.length) return;
        const at = this.trace.length;
        const records = fresh.map(d => ({
            journey: this.journey, step, verb, point, at, until: null, ...d,
        }));
        this.records.push(...records);
        for (const r of records) if (r.key !== 'call.returns') this.open.set(r.key, r);
        if (this.onDiffs && this.onDiffs(records) === 'end') {
            throw new JourneyEnd(`known drift at "${step}"`);
        }
    }

    /** Read both states, name new nodes, diff, report what is new
     * against `baseline` (a set of keys). Answers the full key set.
     * `closes` — a key that no longer differs ends its record's life
     * here (an undo probe closes nothing: its redo brings the state
     * back). */
    async #observe({ step, verb, point, answers = null, baseline, est = null, closes = true }) {
        est = est || await this.engine.state();
        const mst = this.mock.state();
        this.#bindNew(est, mst);
        this.engineClock = est.islandPos + est.islandZero;
        this.last = { engine: est, mock: mst };
        const found = this.#compare(point, est, mst, answers);
        this.hotBefore = new Set([
            ...hotIds(est).map(id => this.labels.engine.get(id)),
            ...hotIds(mst).map(id => this.labels.mock.get(id)),
        ]);
        if (this.onStep) this.onStep({ step, point, engine: est, mock: mst, differing: found.length });
        const keys = new Set(found.filter(d => d.key !== 'call.returns').map(d => d.key));
        if (closes) {
            for (const [key, record] of this.open) {
                // A fact read at one kind of point only (a take flag,
                // `hot`) is not gone because this point does not read it.
                if (keys.has(key) || !this.#readAt(record, point)) continue;
                record.until = step;
                this.open.delete(key);
            }
        }
        this.#report(step, verb, point, found.filter(d => d.key === 'call.returns' ||
            (!baseline.has(d.key) && !this.open.has(d.key))));
        return keys;
    }

    #readAt(record, point) {
        if (POINT_ONLY.block.has(record.field)) return point === 'block';
        if (POINT_ONLY.verb.has(record.field)) return point === 'verb';
        return true;
    }

    async #callBoth(verb, args) {
        const engine = await this.engine.call(verb, this.#resolve(args, this.engine.name));
        const mock = await this.mock.call(verb, this.#resolve(args, this.mock.name));
        return { verb, engine, mock };
    }

    // -------------------------------------------------------------- steps

    /**
     * One bridge verb on both sides, then a compare; with the session's
     * probe on, then `undo` + compare and `redo` + compare. `opts.probe
     * = false` leaves the probe out for this call (a live gesture's
     * commits: an undo ends the gesture).
     */
    async call(verb, ...args) {
        return this.#call(verb, args, {});
    }

    /** `call` without the undo/redo probe. */
    async callLive(verb, ...args) {
        return this.#call(verb, args, { probe: false });
    }

    async #call(verb, args, opts) {
        const step = this.#label(`${verb}(${args.map(a => this.#show(a)).join(',')})`);
        this.steps++;
        const before = this.prev;
        if (TAKE_VERBS.has(verb)) {
            this.viewSettled = false;
            if (verb !== 'stopRecordingInNode') this.clockAligned = false;
        }
        const answers = await this.#callBoth(verb, args);
        this.trace.push({ step, probe: false });
        const atStep = await this.#observe({ step, verb, point: 'verb', answers, baseline: before });
        this.prev = atStep;
        if (this.probe && opts.probe !== false) {
            const undo = `${step} / undo`;
            const undone = await this.#callBoth('undo', []);
            this.trace.push({ step: undo, probe: true });
            const atUndo = await this.#observe({
                step: undo, verb: 'undo', point: 'verb', closes: false,
                answers: undone, baseline: new Set([...atStep, ...before]),
            });
            const redo = `${step} / redo`;
            const redone = await this.#callBoth('redo', []);
            this.trace.push({ step: redo, probe: true });
            this.prev = await this.#observe({
                step: redo, verb: 'redo', point: 'verb',
                answers: redone, baseline: new Set([...atUndo, ...atStep]),
            });
        }
        return answers;
    }

    /** Let `samples` of device time pass on both sides (see TIME PARITY). */
    async advance(samples) {
        if (!(samples > 0)) return;
        await this.engine.advance(samples);
        await this.#afterEngineAdvance(samples);
    }

    async #afterEngineAdvance(samples) {
        const step = this.#label(`advance(${this.fmt(samples)})`);
        this.steps++;
        const est = await this.engine.state();
        const moved = est.islandPos + est.islandZero - this.engineClock;
        this.mock.advance(moved);
        this.viewSettled = !anyHot(est);
        this.trace.push({ step, probe: false });
        this.prev = await this.#observe({
            step, verb: 'advance', point: 'block', baseline: this.prev, est,
        });
    }

    /**
     * Advance block by block until the ENGINE's state satisfies `pred`
     * (the engine is the clock: the mock then gets the same samples in
     * one step, and one compare follows). No step when it holds already.
     */
    async until(what, pred, max = 0) {
        const limit = max > 0 ? max : 64 * (this.q || this.rate);
        let done = 0;
        let st = this.last.engine;
        while (!pred(st)) {
            if (done >= limit) throw new Error(`until(${what}): not within ${limit} samples`);
            await this.engine.advance(BLOCK);
            done += BLOCK;
            st = await this.engine.state();
        }
        if (done > 0) await this.#afterEngineAdvance(done);
    }

    // ---------------------------------------------------------- vocabulary

    /** createNode, the new node bound to `label`. */
    async create(label, type = 'clip', parent = '') {
        this.wanted = [label];
        return this.call('createNode', type, parent);
    }

    /** combineNodes(dragged, target), the new stack bound to `label`. */
    async combine(label, dragged, target) {
        this.wanted = [label];
        return this.call('combineNodes', dragged, target);
    }

    /** The nodes the NEXT step makes take these labels, in tree order. */
    bindNext(labels) {
        this.wanted = [...labels];
    }

    /** A step that makes nodes no verb names (an import onto a stack, a
     * template insert): bind them to `labels` in tree order. */
    async callBinding(labels, verb, ...args) {
        this.bindNext(labels);
        return this.call(verb, ...args);
    }

    /** The clock since the island zero, per the engine. */
    get islandPos() {
        return this.last.engine.islandPos;
    }

    /** Advance to phase `p` of `cycle` (samples from the island zero). */
    async toPhase(p, cycle) {
        const need = (((p - this.islandPos) % cycle) + cycle) % cycle;
        await this.advance(need);
    }

    /** Advance until position `pos` of `label`'s whole take sounds on a
     * plain loop: (clock − origin) mod duration, per the engine. */
    async toTakePosition(label, pos) {
        const st = this.last.engine;
        const n = this.engineNode(label);
        const at = st.islandPos + st.islandZero - n.origin;
        await this.advance((((pos - at) % n.duration) + n.duration) % n.duration);
    }

    hotIn(label) {
        return st => {
            const n = this.engineNode(label, st);
            return !!(n && (n.isRecording || n.isPendingStart || n.isAwaitingStop));
        };
    }

    capturingIn(label) {
        return st => {
            const n = this.engineNode(label, st);
            return !!(n && n.isRecording);
        };
    }

    /**
     * Record a take on the armed node(s): `arm` is the label the arm verb
     * names (a clip, or a stack for a group take), `watch` a clip that
     * records. Stops a quarter Q short of `len` (a stop pads forward to
     * the Q grid, so the take commits at `len`) and settles a block past
     * the commit. With no Q yet the stop is the commit: the take is
     * exactly `len`.
     */
    async record(arm, len, { watch = arm, verb = 'startRecordingInNode' } = {}) {
        const islandQ = this.last.engine.quantum;
        const first = !(islandQ > 0);
        await this.call(verb, arm);
        await this.advance(BLOCK);
        await this.until(`${watch} capturing`, this.capturingIn(watch));
        const live = this.engineNode(watch).duration;
        // Three quarters into the last Q (or into a sub-Q take): past
        // the half where a stop may still land on a subdivision.
        const target = first ? len : len - Math.floor(Math.min(len, islandQ) / 4);
        await this.advance(target - live);
        await this.call('stopRecordingInNode', arm);
        await this.until(`${watch} settled`, st => !this.hotIn(watch)(st));
        await this.advance(BLOCK);
    }

    /** A fresh clip under `parent` with a take of `len` samples. */
    async take(label, len, parent = '') {
        await this.create(label, 'clip', parent);
        await this.record(label, len);
    }

    /** An absolute clock argument: `offset` samples from each side's
     * own island zero (a seated frame zero, an import's origin). */
    fromZero(offset) {
        const pick = side => Math.round(this.last[side].islandZero + offset);
        pick.label = `zero+${this.fmt(offset)}`;
        return pick;
    }

    /** An absolute clock argument: each side's own clock reading. */
    clock(offset = 0) {
        const pick = side => Math.round(this.last[side].islandPos + this.last[side].islandZero + offset);
        pick.label = offset ? `clock+${this.fmt(offset)}` : 'clock';
        return pick;
    }

    /** An audio file of `samples` frames (wav.mjs): one path for both
     * sides, printed by its length. */
    wav(samples, stem = 'file') {
        const file = wavOf(samples, this.rate, stem);
        const pick = () => file;
        pick.label = `wav(${stem},${this.fmt(samples)})`;
        return pick;
    }

    /** A path in the scratch directory, printed by its name. */
    scratch(name) {
        const file = path.join(scratchDir(), name);
        const pick = () => file;
        pick.label = `scratch(${name})`;
        return pick;
    }

    /** A slot resolver: the uuid of the `type` slot in `label`'s chain,
     * per side. */
    slot(label, type) {
        const pick = side => {
            const st = this.last[side];
            const node = label === '@ROOT' ? st : findNode(st, this.idOf(side, label));
            const hit = node && node.effects && (node.effects.chain || []).find(x => x.type === type);
            return hit ? hit.slot : `no-${type}-slot`;
        };
        pick.label = `slot(${label},${type})`;
        return pick;
    }
}
