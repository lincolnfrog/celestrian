/**
 * theme.js — the canvas palette against css/session.css :root. Canvas
 * painters cannot read CSS variables, so three tones are spelled in
 * both places; this parses the stylesheet and holds them together.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { TAPE, COMPOSITE, ECHO, AMBER, rgbaOf } from '../theme.js';
import { repoRoot } from './helpers.mjs';

/** The value of custom property `name` in session.css :root. */
function rootColor(name) {
    const css = readFileSync(path.join(repoRoot, 'ui/css/session.css'), 'utf8');
    const m = css.match(new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6})\\b`, 'm'));
    assert.ok(m, `${name} not found in session.css — parser broken?`);
    return m[1].toLowerCase();
}

test('the waveform tones are the stylesheet\'s', () => {
    assert.equal(TAPE.mid, rootColor('--amber'));
    assert.equal(AMBER, rootColor('--amber'));
    assert.equal(COMPOSITE.mid, rootColor('--amber-group'));
    assert.equal(ECHO.mid, rootColor('--cyan'));
});

test('rgbaOf: a hex token at an opacity', () => {
    assert.equal(rgbaOf('#e8a13c', 0.28), 'rgba(232, 161, 60, 0.28)');
    assert.equal(rgbaOf('#000000', 1), 'rgba(0, 0, 0, 1)');
});
