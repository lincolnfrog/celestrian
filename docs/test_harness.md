# Test Harness

> Status: **spec** — how to build and run every test layer, plus the
> gotchas that have actually bitten this project. (Rewritten 2026-07-09;
> the old version referenced a long-deleted `app_test.js`.)

## The layers

| Layer | What it covers | Run with |
|---|---|---|
| C++ unit/engine tests | Nodes, timing math, engine workflows, calibration, pre-record capture | `cmake --build build --parallel 8 --target CelestrianTests && ./build/CelestrianTests_artefacts/Debug/CelestrianTests` |
| JS unit tests | Timeline model, protocol contract, stack logic, ghost math, composite waveform cache | `cd ui && npm test` |
| Playwright e2e | UI behavior against the mock backend | `cd ui && npm run test:playwright` |
| Golden vectors | Pin C++ `src/timing.h` and JS `timeline_model.js` to the SAME numbers | `shared/timing_golden.json`, consumed by both suites above |
| Protocol contract | The bridge method list in `protocol.js` ⇔ `main_component.cc` ⇔ `mock_backend.js` | part of `npm test` (`protocol_contract.test.mjs`) |

## Gotchas (each of these cost real debugging time)

1. **Run the `Debug/` binary.** The test executable lives at
   `build/CelestrianTests_artefacts/Debug/CelestrianTests`. A stale
   binary at `build/CelestrianTests_artefacts/CelestrianTests` (no
   `Debug/`) once reported "ALL TESTS PASSED" for **months** while real
   failures accumulated. If that path reappears, delete it.
2. **Never attach the audio device in tests.** `AudioEngine`'s
   constructor is device-free by design; `initialiseAudioDevice()` is
   called only by the app shell. A live CoreAudio callback running
   concurrently with manually driven test callbacks produces
   machine-dependent, sample-count-corrupting flakes.
3. **Test at large master positions.** Legacy tests recorded immediately
   after commits, near t=0, where absolute and cycle-relative values
   coincide — which hid two field bugs. Field-shaped tests play ~300k
   samples of silence first (`pre_record_tests.cc` has the pattern).
4. **Don't hold `getDynamicObject()` past its `juce::var`.** The var is
   the refcount owner; taking the pointer off a temporary dangles and
   reads freed memory (often as 0). Keep the var in a local.
5. **Synthetic loopback needs `delay > block size`.** A test harness can
   only feed back output from *previous* callbacks, so calibration
   round-trips shorter than one block are unmeasurable in tests (real
   hardware has no such limit).
6. **Calibration persistence in tests must use `setCalibrationFile`**
   (a temp path). Engines that never see a device have no device key and
   deliberately skip persisting — so unit tests can't pollute the real
   `~/Library/Application Support/Celestrian/calibration.json`.
7. **`?mock=true` specs must wait for `window.__celestrianTest`** before
   using it (`waitForFunction` with `?.` — a plain property access throws
   and aborts the wait). `backend.js` attaches the namespace during async
   module init; racing it was a ~1-in-3 full-suite flake that never
   reproduced solo.
8. **Poll opacity/style assertions.** `stack-styles.css` animates fades
   over 0.2 s; a single computed-style read lands mid-transition under
   parallel-worker load. Use `expect.poll` (or `toHaveCSS`), not a
   `waitForTimeout` + one-shot read.
9. **`index_test.html` must not statically import anything that reaches
   `backend.js`.** Static imports hoist above the `window.celestrian`
   assignment, so the facade would evaluate first and lock in the
   JUCE-bridge path for the whole page. `app.js` is dynamically imported
   there for exactly this reason.
10. **The mock's SAMPLE RATE is a variable — never spell 44100.** It
   lives in `ui/js/mock/rate.js` and everything rate-dependent derives
   from it: the published `perf.sampleRate`, the seconds conversions
   behind the VU and scope, the calibration `roundTripMs`, the device
   panel's `currentSampleRate`, and every scenario fixture length (1Q =
   one second of audio, so 3Q is `3 * Q`, not 132300). It got this way
   because the mock published 44100 under a device panel that claimed
   48000 — engine P0-5 threaded the device rate everywhere and the mock
   was left behind. Sweep it to prove a test is rate-independent:

   ```bash
   CELESTRIAN_MOCK_RATE=48000 npm test        # node suite
   E2E_MOCK_RATE=48000 npx playwright test    # seeds window.__celestrianMockRate
   ```

   Both suites pass at 22050/44100/44101/48000/88200/96000/12345.
   Three deliberate exceptions, each load-bearing:

   - `transport.samplesPerTick` is a fixed SAMPLE STEP, not 50 ms of
     audio. Deriving it from the rate moves every play-then-poll clock
     position and flips outcomes that fold on them (it put
     `map_anchor`'s cut in a different Q at 48 kHz). Consequence: the
     mock simulates a constant `SIMULATED_SAMPLES_PER_SECOND` of audio
     per wall-clock second — real-time specs size their sampling window
     from that constant, never from a hardcoded millisecond count.
   - The e2e sweep seeds `window.__celestrianMockRate` via
     `addInitScript`, NOT `?rate=`: the dev server's clean-urls
     redirect drops the query on `/index_test.html`, which left the
     harness quietly at 44.1 kHz through an entire "48 kHz" run.
   - The fp-exactness case in `segments.test.mjs` keeps its literals —
     its whole point is that 18480 + (88200 − 62580) = 44100 exactly.
     It carries its own `quantum`, so it is rate-independent anyway.

11. **The mock must mirror engine CONTRACTS, not plausible internals.**
   The mock once published the raw transport as `masterPos` while the
   engine publishes a derived view (wrapped idle, growing during
   recording — ui.md "masterPos contract"). UI code written against the
   mock's dialect passed every test and broke on hardware ("recording
   loops the old cycle"). Before keying UI behavior off a state field's
   semantics, read its producer in `src/*.cc` — then make the mock match.

## Adding a bridge method

Three places, or the contract test fails: `ui/js/protocol.js` (the
canonical list), `src/main_component.cc` (`withNativeFunction`), and
`ui/js/mock_backend.js` (`handlers` table + implementation).

## Adding timing math

Put the pure function in BOTH `src/timing.h` and
`ui/js/timeline_model.js`, then pin them with a case in
`shared/timing_golden.json` — the golden tests on each side keep the two
implementations from drifting.

## Browser harness (mock backend)

For UI iteration without a C++ rebuild:

```bash
cd ui
python3 -m http.server 8000   # file:// won't work (CORS)
# open http://localhost:8000/index_test.html
```

Backend selection lives in `ui/js/backend.js` (the P2-9 facade — the
only module that knows mock vs harness vs JUCE bridge; in `?mock=true`
mode it exposes Playwright helpers as `window.__celestrianTest`). The mock (`ui/js/mock_backend.js`) holds **state +
protocol only** — all timing math is imported from `timeline_model.js`
so it cannot drift from the UI or, via golden vectors, from the C++
engine. Scenario definitions live in `loadScenario()`; the sidebar in
`index_test.html` switches them. Limitations: no real audio, simulated
waveforms, state resets on reload.

## Field debugging

The app's **📦 Dump State** button writes `celestrian_state.json` (app
cwd), containing per-node timing fields (`origin`, `launchPoint`,
`anchorPhase`, `duration`, `x`, `windowActive`, `loopBypassed`) and the
`perf` block (DSP load, xruns, latency compensation, `calibrated`,
`sampleRate`). Asking for a dump is the fastest way to diagnose
alignment issues — it has settled every field bug so far in one glance.
