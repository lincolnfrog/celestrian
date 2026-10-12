/**
 * The normaliser and the differ.
 *
 * `normalise(state, ctx)` turns one backend's getGraphState into a flat
 * map of comparable facts, keyed `<scope>.<field>`:
 *
 *   island.<field>   the transport and island facts
 *   root.<field>     the root node's own facts
 *   @<label>.<field> a node, named by the label the session gave it at
 *                    creation (nodes pair by creation order, never by id)
 *
 * What is read, how, and what is left out is fields.mjs — the table is
 * the only place a field is named.
 *
 * `diff(engine, mock)` lists the keys whose values differ (a key one
 * side lacks reads `undefined` there). `KeySets` collects which raw keys
 * each side publishes at all, per record kind.
 */

import { comparedRows, comparatorOf } from './fields.mjs';

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/**
 * ctx = { labelOf(id) → label | undefined, point: 'verb' | 'block' }.
 * Answers Map(key → { scope, field, value }).
 */
export function normalise(state, ctx) {
    const out = new Map();
    const paths = new Map();
    (function walk(parentLabel, nodes) {
        (nodes || []).forEach((n, i) => {
            paths.set(n.id, `${parentLabel}/${i}`);
            walk(ctx.labelOf(n.id) || `?${parentLabel}/${i}`, n.nodes);
        });
    })('ROOT', state.nodes);
    const full = { ...ctx, pathOf: id => paths.get(id) };
    const put = (scope, rows, record) => {
        for (const row of rows) {
            const facts = row.readMany
                ? Object.entries(row.readMany(record, state, full))
                : [[row.field, row.read(record, state, full)]];
            for (const [field, value] of facts) {
                if (value !== undefined) out.set(`${scope}.${field}`, { scope, field, value });
            }
        }
    };
    put('island', comparedRows('island'), state);
    put('root', comparedRows('root'), state);
    (function walk(nodes) {
        for (const n of nodes || []) {
            const scope = ctx.labelOf(n.id) || `?${paths.get(n.id)}`;
            put(scope, comparedRows('node'), n);
            put(scope, comparedRows(n.type === 'stack' ? 'stack' : 'clip'), n);
            walk(n.nodes);
        }
    })(state.nodes);
    return out;
}

const show = v => (v === undefined ? '∅' : JSON.stringify(v));

/** The keys that differ: [{ key, scope, field, engine, mock }] (values
 * as published-and-normalised; `undefined` = the side has no such fact). */
export function diff(engine, mock) {
    const out = [];
    // A node only one side has is ONE fact (`exists`), not one per field.
    const scopesOf = map => new Set([...map.values()].map(v => v.scope));
    const es = scopesOf(engine), ms = scopesOf(mock);
    const lone = new Set();
    for (const scope of new Set([...es, ...ms])) {
        if (es.has(scope) === ms.has(scope)) continue;
        lone.add(scope);
        out.push({
            key: `${scope}.exists`, scope, field: 'exists',
            engine: es.has(scope) ? true : undefined, mock: ms.has(scope) ? true : undefined,
        });
    }
    // …and so is a node the two sides hold as different kinds.
    for (const scope of es) {
        if (lone.has(scope)) continue;
        const e = engine.get(`${scope}.type`), m = mock.get(`${scope}.type`);
        if (!e || !m || e.value === m.value) continue;
        lone.add(scope);
        out.push({ key: `${scope}.type`, scope, field: 'type', engine: e.value, mock: m.value });
    }
    const keys = [...new Set([...engine.keys(), ...mock.keys()])].sort();
    const whole = new Set();   // `scope.sequence` differs: its parts say no more
    for (const key of keys) {
        const e = engine.get(key), m = mock.get(key);
        if (lone.has((e || m).scope)) continue;
        const dot = (e || m).field.indexOf('.');
        if (dot > 0 && whole.has(`${(e || m).scope}.${(e || m).field.slice(0, dot)}`)) continue;
        // …and a window phase under a map only one side plays.
        if ((e || m).field === 'playhead' && (!e || !m)) continue;
        const ev = e ? e.value : undefined, mv = m ? m.value : undefined;
        const field = (e || m).field;
        const equal = comparatorOf(field);
        const same = e && m && (equal ? equal(ev, mv) : deepEqual(ev, mv));
        if (!same) {
            out.push({ key, scope: (e || m).scope, field, engine: ev, mock: mv });
            if (dot < 0) whole.add(key);
        }
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export const showValue = show;
export { deepEqual };

/** Which raw keys each side publishes, per record kind — the shape
 * check beside the value check. */
export class KeySets {
    constructor() {
        this.seen = { engine: {}, mock: {} };
    }

    note(side, state) {
        const add = (kind, record) => {
            const set = (this.seen[side][kind] = this.seen[side][kind] || new Set());
            for (const k of Object.keys(record || {})) set.add(k);
        };
        const sequence = seq => {
            if (!seq) return;
            add('sequence', seq);
            (seq.steps || []).forEach(s => add('step', s));
        };
        const chain = fx => ((fx && fx.chain) || []).forEach(s => add(`slot:${s.type}`, s));
        add('state', state);
        sequence(state.sequence);
        chain(state.effects);
        (function walk(nodes) {
            for (const n of nodes || []) {
                add(n.type === 'stack' ? 'stack' : 'clip', n);
                sequence(n.sequence);
                chain(n.effects);
                walk(n.nodes);
            }
        })(state.nodes);
    }

    /** { kind: { engineOnly: [...], mockOnly: [...] } } for kinds both
     * sides published at least once. */
    compare() {
        const out = {};
        const kinds = new Set([...Object.keys(this.seen.engine), ...Object.keys(this.seen.mock)]);
        for (const kind of [...kinds].sort()) {
            const e = this.seen.engine[kind], m = this.seen.mock[kind];
            if (!e || !m) continue;
            const engineOnly = [...e].filter(k => !m.has(k)).sort();
            const mockOnly = [...m].filter(k => !e.has(k)).sort();
            if (engineOnly.length || mockOnly.length) out[kind] = { engineOnly, mockOnly };
        }
        return out;
    }
}
