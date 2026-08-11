import { defineConfig, devices } from '@playwright/test';

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
        baseURL: 'http://localhost:8080',
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
    // Local web server for ES module support (file:// URLs have CORS issues)
    webServer: {
        command: 'npx serve . -p 8080',
        port: 8080,
        reuseExistingServer: !process.env.CI,
    },
});
