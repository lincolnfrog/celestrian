// The backend facade: the ONE module that knows which backend the app
// is talking to. Every other module takes { callNative, log, getState }
// from here — never from bridge.js or mock_backend.js — so every mode
// runs the same code above this line. Decided once, at module load:
//
//   MOCK     ?mock=true: mock_backend.js, imported dynamically, with
//            its test surface on window.__celestrianTest — the one
//            namespace Playwright drives the mock through. With
//            &harness=1 the scenario sidebar is mounted beside the app
//            (harness_sidebar.js), for working on the UI by hand.
//   ENGINE   ?engine=true: the real engine behind the headless server's
//            HTTP twin of the bridge (bridge_http.js; docs/
//            test_harness.md "Engine e2e"). __celestrianTest carries
//            callNative and the server's `engine` control surface.
//   NATIVE   otherwise: the JUCE bridge (bridge.js).
//
// `getState` is the mock's synchronous state getter. It is null on a
// real bridge, where the state is read with callNative('getGraphState')
// (shell_io.js readState).

let callNative, log, getState;

const params = new URLSearchParams(
    typeof window !== 'undefined' ? window.location.search : '');
const useMock = params.get('mock') === 'true';
const useEngine = !useMock && params.get('engine') === 'true';

if (useEngine) {
    const http = await import('./bridge_http.js');
    ({ callNative, log } = http);
    getState = null;
    window.__celestrianTest = {
        callNative: http.callNative,
        engine: http.control,
    };
    console.log('[Backend] Using HTTP engine bridge (headless engine server)');
} else if (useMock) {
    const mockBackend = await import('./mock_backend.js');
    ({ callNative, log, getState } = mockBackend);

    window.__celestrianTest = {
        loadScenario: mockBackend.loadScenario,
        setMasterPos: mockBackend.setMasterPos,
        setIsPlaying: mockBackend.setIsPlaying,
        callNative: mockBackend.callNative,
        // The last accepted bounce / import request (mock/bounce.js,
        // mock/import.js)
        getLastBounce: mockBackend.getLastBounce,
        getLastImport: mockBackend.getLastImport,
        // The simulated transport (mock/transport.js). stepClock hands
        // time to the test or back to the polls; readState reads the
        // published state without a poll's tick of the clock.
        startTransport: mockBackend.startTransport,
        pauseTransport: mockBackend.pauseTransport,
        advanceBy: mockBackend.advanceBy,
        stepClock: mockBackend.stepClock,
        readState: mockBackend.readState,
        SIMULATED_SAMPLES_PER_SECOND: mockBackend.SIMULATED_SAMPLES_PER_SECOND,
    };
    if (params.get('harness') === '1') {
        const { mountHarnessSidebar } = await import('./harness_sidebar.js');
        mountHarnessSidebar(mockBackend.loadScenario);
    }

    console.log('[Backend] Using Loaded Mock backend');
} else {
    const bridge = await import('./bridge.js');
    ({ callNative, log } = bridge);
    getState = null;
    console.log('[Backend] Using JUCE bridge');
}

export { callNative, log, getState };
