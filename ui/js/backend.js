// Single backend facade (refactoring_proposal.md P2-9). This is the ONLY
// module that knows whether the app is talking to the JUCE bridge, the
// index_test.html harness, or the browser mock (?mock=true). Every other
// module imports { callNative, log, getState } from here — never from
// bridge.js or mock_backend.js directly, so all modes exercise the same
// persistence path.
//
// The three-way selection, decided once at module load (top-level await):
//
//   1. HARNESS  — window.celestrian already set (index_test.html imports
//      mock_backend statically and installs it BEFORE app.js loads; see
//      the import-order note in that file). We adopt its backend as-is.
//   2. MOCK     — ?mock=true in the URL: mock_backend.js is imported
//      dynamically and, for Playwright, exposed as the single test
//      namespace window.__celestrianTest (loadScenario / setMasterPos /
//      setIsPlaying / callNative / startTransport / pauseTransport /
//      advanceBy) — e2e drives the mock through that surface only.
//   3. NATIVE   — neither: the JUCE bridge (bridge.js). `getState` is
//      null in this mode; the polling loop detects that and calls
//      callNative('getGraphState') instead of a synchronous getter.

let callNative, log, getState;

const useMock = typeof window !== 'undefined' && (
    (window.celestrian) ||
    (new URLSearchParams(window.location.search).get('mock') === 'true')
);

if (useMock) {
    if (window.celestrian) {
        // Test harness environment (index_test.html) - use provided backend
        ({ callNative, log, getState } = window.celestrian);
        console.log('[Backend] Using Harness backend');
    } else {
        // Browser/Playwright Manual Mock Mode
        const mockBackend = await import('./mock_backend.js');
        ({ callNative, log, getState } = mockBackend);

        // Single test namespace for Playwright (no window.* scatter)
        window.__celestrianTest = {
            loadScenario: mockBackend.loadScenario,
            setMasterPos: mockBackend.setMasterPos,
            setIsPlaying: mockBackend.setIsPlaying,
            callNative: mockBackend.callNative,
            // Transport simulation
            startTransport: mockBackend.startTransport,
            pauseTransport: mockBackend.pauseTransport,
            advanceBy: mockBackend.advanceBy,
            // Simulated audio per wall-clock second (mock/transport.js)
            SIMULATED_SAMPLES_PER_SECOND: mockBackend.SIMULATED_SAMPLES_PER_SECOND,
        };

        console.log('[Backend] Using Loaded Mock backend');
    }
} else {
    // Production environment - use JUCE bridge
    const bridge = await import('./bridge.js');
    ({ callNative, log } = bridge);
    getState = null; // Not used in production (polling uses callNative('getGraphState'))
    console.log('[Backend] Using JUCE bridge');
}

export { callNative, log, getState };
