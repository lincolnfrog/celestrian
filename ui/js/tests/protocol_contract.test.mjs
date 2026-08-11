/**
 * Bridge Protocol Contract Test
 *
 * Verifies that both backend implementations expose exactly the methods
 * declared in ui/js/protocol.js:
 *   - the mock backend's `handlers` table (ui/js/mock_backend.js)
 *   - the C++ JUCE bridge bindings (src/main_component.cc, parsed from source)
 *
 * This is the test that would have caught `combineNodes` existing only in
 * the mock while production silently no-opped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BRIDGE_METHOD_NAMES } from '../protocol.js';
import { handlers } from '../mock_backend.js';
import { repoRoot } from './helpers.mjs';

const protocol = new Set(BRIDGE_METHOD_NAMES);

test('mock backend implements exactly the protocol surface', () => {
    const mockMethods = new Set(Object.keys(handlers));
    for (const name of protocol) {
        assert.ok(mockMethods.has(name),
            `mock_backend.js is missing protocol method '${name}'`);
    }
    for (const name of mockMethods) {
        assert.ok(protocol.has(name),
            `mock_backend.js implements '${name}' which is not in protocol.js`);
    }
});

test('C++ bridge binds exactly the protocol surface', () => {
    const cppSourcePath = path.join(repoRoot, 'src', 'main_component.cc');
    const cppSource = readFileSync(cppSourcePath, 'utf8');

    const cppMethods = new Set();
    const bindingRegex = /withNativeFunction\(\s*"(\w+)"/g;
    let match;
    while ((match = bindingRegex.exec(cppSource)) !== null) {
        cppMethods.add(match[1]);
    }

    assert.ok(cppMethods.size > 0,
        `no withNativeFunction bindings found in ${cppSourcePath} — parser broken?`);

    for (const name of protocol) {
        assert.ok(cppMethods.has(name),
            `main_component.cc is missing protocol method '${name}'`);
    }
    for (const name of cppMethods) {
        assert.ok(protocol.has(name),
            `main_component.cc binds '${name}' which is not in protocol.js`);
    }
});
