/**
 * The built-in effects, UI against engine. The UI restates three things
 * the engine owns, and this test parses the C++ source to hold them
 * together:
 *   - effect_schema.js's slider ranges ↔ the ranges each slot's
 *     setParam clamps to (the parameter tables in src/dsp/fx_chain.cc):
 *     a slider that travels past a clamp shows a value the engine is
 *     not using;
 *   - the schema's types and order ↔ FxChain::kBuiltInTypes
 *     (src/dsp/fx_chain.h);
 *   - fx_viz.js's EQ band placement ↔ the constants in
 *     src/dsp/effects.cc: the response curve is drawn from them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { EFFECT_SCHEMA } from '../effect_schema.js';
import { EQ_BANDS } from '../fx_viz.js';
import { repoRoot } from './helpers.mjs';

const source = rel => readFileSync(path.join(repoRoot, rel), 'utf8');

/**
 * { type id → { param key → [min, max] } } from fx_chain.cc, by the
 * path a setSlotParam takes: makeBuiltIn builds a slot class per type
 * id, the class's setParam clamps through one parameter table
 * (setFromTable), and the table's rows are {key, member, min, max}.
 */
function engineClamps() {
    const src = source('src/dsp/fx_chain.cc');
    const tables = {};
    for (const t of src.matchAll(
        /constexpr Param<\w+> (\w+)\[\]\s*=\s*\{([\s\S]*?)\n\};/g)) {
        const rows = {};
        for (const r of t[2].matchAll(
            /\{\s*"(\w+)",\s*&\w+::\w+,\s*(-?[\d.]+)f,\s*(-?[\d.]+)f\s*\}/g)) {
            rows[r[1]] = [Number(r[2]), Number(r[3])];
        }
        tables[t[1]] = rows;
    }
    const tableOfClass = {};
    for (const fn of src.matchAll(
        /bool (\w+)::setParam\([^)]*\)\s*\{[\s\S]*?setFromTable\((\w+),/g)) {
        tableOfClass[fn[1]] = fn[2];
    }
    const clamps = {};
    for (const m of src.matchAll(
        /type_id == "(\w+)"\)\s*return std::make_shared<(\w+)>/g)) {
        clamps[m[1]] = tables[tableOfClass[m[2]]] || {};
    }
    return clamps;
}

test('the parser finds every built-in and its clamps', () => {
    const clamps = engineClamps();
    assert.deepEqual(Object.keys(clamps).sort(), ['compressor', 'echo', 'eq', 'reverb']);
    for (const [type, params] of Object.entries(clamps)) {
        assert.ok(Object.keys(params).length >= 3, `${type}: clamps parsed`);
    }
    // One known value, so a regex that matched the wrong numbers fails here.
    assert.deepEqual(clamps.compressor.makeup, [-12, 24]);
});

test('every schema slider spans exactly the engine\'s clamp', () => {
    const clamps = engineClamps();
    for (const effect of EFFECT_SCHEMA) {
        const engine = clamps[effect.type];
        assert.ok(engine, `the engine has no built-in '${effect.type}'`);
        assert.deepEqual(effect.params.map(p => p.key).sort(), Object.keys(engine).sort(),
            `${effect.type}: the schema and setParam name the same params`);
        for (const p of effect.params) {
            assert.deepEqual([p.min, p.max], engine[p.key],
                `${effect.type}.${p.key}: slider range vs engine clamp`);
        }
    }
});

test('the schema lists the built-ins in the engine\'s canonical order', () => {
    const header = source('src/dsp/fx_chain.h');
    const list = header.match(/kBuiltInTypes\s*=\s*\{([^}]*)\}/);
    assert.ok(list, 'kBuiltInTypes not found in fx_chain.h — parser broken?');
    const engineOrder = [...list[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    assert.deepEqual(EFFECT_SCHEMA.map(e => e.type), engineOrder);
});

test('every slider can reach both ends of its range in whole steps', () => {
    for (const effect of EFFECT_SCHEMA) {
        for (const p of effect.params) {
            const steps = (p.max - p.min) / p.step;
            assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6,
                `${effect.type}.${p.key}: ${p.min}..${p.max} in steps of ${p.step}`);
        }
    }
});

test('the EQ curve is drawn from the engine\'s band placement', () => {
    const src = source('src/dsp/effects.cc');
    const constant = name => {
        const m = src.match(new RegExp(`constexpr double ${name}\\s*=\\s*([\\d.]+)`));
        assert.ok(m, `${name} not found in effects.cc — parser broken?`);
        return Number(m[1]);
    };
    assert.deepEqual({ ...EQ_BANDS }, {
        lowShelfHz: constant('kLowShelfHz'),
        midPeakHz: constant('kMidPeakHz'),
        midQ: constant('kMidQ'),
        highShelfHz: constant('kHighShelfHz'),
        shelfSlope: constant('kShelfSlope'),
    });
});
