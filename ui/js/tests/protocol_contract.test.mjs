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
    // The C++ side is ONE table plus the window-bound verbs: every
    // GUI-free method is registered in src/bridge_dispatch.cc
    // (voidMethod / valueMethod — shared by the app shell AND the
    // headless engine server), and main_component.cc binds only what
    // needs a window (bindWindowVerb, overriding same-named table
    // entries). The union must be the protocol, exactly.
    const sources = [
        ['src/bridge_dispatch.cc', /(?:voidMethod|valueMethod)\(\s*"(\w+)"/g],
        ['src/main_component.cc', /(?:withNativeFunction|bindWindowVerb)\(\s*"(\w+)"/g],
    ];
    const cppMethods = new Set();
    for (const [rel, regex] of sources) {
        const src = readFileSync(path.join(repoRoot, rel), 'utf8');
        let match, found = 0;
        while ((match = regex.exec(src)) !== null) {
            cppMethods.add(match[1]);
            found++;
        }
        assert.ok(found > 0, `no bridge bindings found in ${rel} — parser broken?`);
    }

    for (const name of protocol) {
        assert.ok(cppMethods.has(name),
            `the C++ bridge (bridge_dispatch.cc + main_component.cc) is missing protocol method '${name}'`);
    }
    for (const name of cppMethods) {
        assert.ok(protocol.has(name),
            `the C++ bridge binds '${name}' which is not in protocol.js`);
    }
});
