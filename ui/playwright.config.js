import { defineConfig, devices } from '@playwright/test';

// E2E_PORT escapes machines where something else owns 8080 (a firewall
// or forwarder that RESETS the port reads as a phantom "server", so the
// suite fails with ERR_CONNECTION_RESET instead of starting its own).
const PORT = Number(process.env.E2E_PORT) || 8080;

export default defineConfig({
    testDir: './e2e',
    timeout: 30000,
    // Default for async expect matchers (incl. expect.poll) — the specs
    // used to repeat `{ timeout: 3000 }` inline ~40 times. Longer waits
    // (harness boot at 5000) stay explicit in the spec.
    expect: { timeout: 3000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',
    use: {
        baseURL: `http://localhost:${PORT}`,
        trace: 'on-first-retry',
        // The bundled-chromium download can stall on a slow network.
        // E2E_CHROME_CHANNEL=chrome runs the suite in the installed
        // system Chrome instead (the E2E_MOCK_RATE pattern).
        ...(process.env.E2E_CHROME_CHANNEL
            ? { channel: process.env.E2E_CHROME_CHANNEL } : {}),
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    // Local web server for ES module support (file:// URLs have CORS issues)
    webServer: {
        // serve falls back to a random port WITHOUT FAILING when the
        // requested port is unavailable; playwright then waits on the
        // configured port until timeout. Hence E2E_PORT above.
        command: `npx serve . -l ${PORT}`,
        port: PORT,
        reuseExistingServer: !process.env.CI,
    },
});
