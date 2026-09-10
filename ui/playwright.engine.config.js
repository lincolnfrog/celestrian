/**
 * ENGINE E2E (docs/test_harness.md "Engine e2e"): the REAL UI in a real
 * Chromium against the REAL C++ engine, served by the headless engine
 * server (src/headless/headless_main.cc — build target
 * CelestrianHeadless). Specs live in ./e2e_engine and drive the engine's
 * synthetic clock deterministically through window.__celestrianTest.engine.
 *
 *   cmake --build build --parallel 8 --target CelestrianHeadless
 *   cd ui && npm run test:engine
 *
 * ONE engine process serves the whole run, so specs execute serially and
 * each one starts with `engine('reset')` (a fresh empty project).
 */

import { defineConfig, devices } from '@playwright/test';

const BIN = process.env.CELESTRIAN_HEADLESS
    || '../build/CelestrianHeadless_artefacts/Debug/CelestrianHeadless';
const PORT = 8091;

export default defineConfig({
    testDir: './e2e_engine',
    timeout: 90000,
    expect: { timeout: 5000 },
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: 'list',
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: 'retain-on-failure',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: {
        // The clock starts PAUSED: specs advance it by exact sample
        // counts (a real-time clock would make every assertion a race).
        // CHIRP input: every recorded sample carries its capture clock as
        // a frequency, so `listen` can decode the mix (see engine_helpers).
        command: `${BIN} --port ${PORT} --ui-dir . --paused --input chirp`,
        url: `http://localhost:${PORT}/index.html`,
        reuseExistingServer: false,
        timeout: 60000,
        stdout: 'ignore',
        stderr: 'pipe',
    },
});
