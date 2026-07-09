// Single backend facade (refactoring_proposal.md P2-9). This is the ONLY
// module that knows whether the app is talking to the JUCE bridge, the
// index_test.html harness, or the browser mock (?mock=true). Every other
// module imports { callNative, log, getState } from here — never from
// bridge.js or mock_backend.js directly, so all modes exercise the same
// persistence path.

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
