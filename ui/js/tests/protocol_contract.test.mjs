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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { BRIDGE_METHOD_NAMES } from '../protocol.js';
import { handlers } from '../mock_backend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(condition, message) {
    if (!condition) {
        failures++;
        console.error(`  FAIL: ${message}`);
    }
}

const protocol = new Set(BRIDGE_METHOD_NAMES);

// --- 1. Mock backend vs protocol ---
console.log('Contract: mock backend vs protocol.js');
const mockMethods = new Set(Object.keys(handlers));

for (const name of protocol) {
    check(mockMethods.has(name), `mock_backend.js is missing protocol method '${name}'`);
}
for (const name of mockMethods) {
    check(protocol.has(name), `mock_backend.js implements '${name}' which is not in protocol.js`);
}

// --- 2. C++ bridge vs protocol ---
console.log('Contract: src/main_component.cc vs protocol.js');
const cppSourcePath = path.resolve(__dirname, '../../../src/main_component.cc');
const cppSource = readFileSync(cppSourcePath, 'utf8');

const cppMethods = new Set();
const bindingRegex = /withNativeFunction\(\s*"(\w+)"/g;
let match;
while ((match = bindingRegex.exec(cppSource)) !== null) {
    cppMethods.add(match[1]);
}

check(cppMethods.size > 0, `no withNativeFunction bindings found in ${cppSourcePath} — parser broken?`);

for (const name of protocol) {
    check(cppMethods.has(name), `main_component.cc is missing protocol method '${name}'`);
}
for (const name of cppMethods) {
    check(protocol.has(name), `main_component.cc binds '${name}' which is not in protocol.js`);
}

// --- Result ---
if (failures === 0) {
    console.log(`PASS: protocol contract holds (${protocol.size} methods, mock=${mockMethods.size}, cpp=${cppMethods.size})`);
} else {
    console.error(`FAIL: ${failures} protocol contract violation(s)`);
    process.exitCode = 1;
}
