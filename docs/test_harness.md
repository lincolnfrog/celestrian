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
| **Engine e2e** | The REAL UI in Chromium against the REAL C++ engine (the headless engine server) — see below | `cmake --build build --target CelestrianHeadless && cd ui && npm run test:engine` |
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
8. **Poll opacity/style assertions.** `ui/css/session.css` animates
   fades and morphs (~0.2 s transitions); a single computed-style read
   lands mid-transition under parallel-worker load. Use `expect.poll` (or `toHaveCSS`), not a
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
12. **Run the C++ tests once before `npm test` on a fresh clone.**
   `ui/js/tests/engine_replay.test.mjs` reads
   `shared/ui_contract_capture.json`, which the C++ Debug test binary
   (`tests/ui_contract_tests.cc`) writes — with no capture on disk the
   replay suite has nothing to replay.

## Adding a bridge method

Three places, or the contract test fails: `ui/js/protocol.js` (the
canonical list), `src/main_component.cc` (`withNativeFunction`), and
`ui/js/mock_backend.js` (`handlers` table + implementation).

## Adding timing math

Put the pure function in BOTH `src/timing.h` and
`ui/js/timeline_model.js`, then pin them with a case in
`shared/timing_golden.json` — the golden tests on each side keep the two
implementations from drifting.

## Engine e2e — the real UI on the real engine (2026-09-09)

The WebView cannot be driven headless and the mock has no audio, so
"what I see is not what I hear" bugs (the 2026-09-09 sequencer field
report) had no test layer. This is that layer.

**The headless engine server** (`src/headless/headless_main.cc`, target
`CelestrianHeadless`) is AudioEngine + ProjectManager + PluginHostService
with no window and no device: a thread paces device-sized blocks of a
GENERATED input (sine by default; `--input ramp|silence`) through the
one callback the real device would call, the bridge table
(`src/bridge_dispatch.cc` — the very entries the app registers on the
WebView) is served as `POST /call {name, args}`, and `ui/` is served
as static files from the same origin. Open
`http://localhost:8091/index.html?engine=true` in any browser and the
real UI runs on the real engine (`backend.js` mode ENGINE →
`bridge_http.js`). By hand:

```bash
./build/CelestrianHeadless_artefacts/Debug/CelestrianHeadless --port 8091 --ui-dir ui
```

**The control surface** (`POST /control {op}`; in the page,
`window.__celestrianTest.engine(op, params)`) makes runs deterministic:
`pause` / `resume` the clock, `advance {samples}` by an exact count,
`input {kind, freq, gain}`, `status` (quantum, zero, islandPos,
cycle by the period law, paused, clock), `reset` (an empty project),
`truth` — THE AUDIBLE TRUTH: the engine solos each clip and listens
one island cycle, answering per Q cell whether it sounds. The
see-vs-hear spec (`ui/e2e_engine/see_vs_hear.spec.js`) builds a root
song with real clicks on the grid and asserts every lane's `.seq-dim`
sits exactly where the engine is silent.

**The spectral listener** (`--input chirp`, `listen {samples, hop}`)
is the harness's instrument. The input is a linear frequency sweep
(300 → 15 000 Hz over 240 s) whose clock advances ONLY while a take
is live, so the sweep is spent on recordings alone (a session may play
and listen for as long as it likes); `reset` restarts it. With
`--inputs N` every channel carries the sweep 240/N s apart, so a
group take of several mics records distinguishable signals. Every
recorded sample thus CARRIES ITS OWN CAPTURE CLOCK as a frequency.
`listen` renders one island cycle and decodes the OUTPUT frame by
frame (4096 samples, DECHIRPED by a reference chirp so each clip is a
pure tone, Hann, FFT, interpolated peaks): each peak's frequency is a
capture moment, each capture moment belongs to exactly one take
(their buffers are decoded the same way), so the answer per frame is
"clip X, take k, content index i is sounding" — the mix itself,
level-blind, no soloing. `verifyHeard(page)` in the helpers then
asserts, for every frame and clip, heard == the render law (the JS
twin of `timing::innerAt`, golden-pinned) == what the lane DRAWS at
that x (tile grid, window slice, rotation). Resolution ≈ 0.01 Q.
Frames whose window straddles a loop seam or a gate ramp are skipped
for that clip (two capture moments share the window). Gotcha: takes
recorded back to back have ADJACENT capture ranges, so attribution
prefers an exact range hit before the half-frame tolerance.

**When to run it.** The layers are complementary, not duplicates: the
C++ scenarios are the LAWS, sample-exact and fast (they run every
time); the engine e2e is the whole SYSTEM — a browser, the bridge, the
poll loop, the view model, the DOM, the engine and its threads at once.
It is slower and has more moving parts, so it is the deep-verification
pass: before a field session, after a change to the display laws, the
bridge, the recording lifecycle or the render equation, and whenever a
field report needs reproducing (script the flow, `listen`, compare the
DOM). `npm test` and `npm run test:playwright` stay the every-change
gates; `npm run test:all` is the deep pass and includes it. The specs
are JOURNEYS through the catalog's families, not one-for-one mirrors
of the 32 scenarios: the owner's chain, growth and the zero,
one-shots, takes and comps, the sequencer's gates and cues, loop-region
edits (moved, bypassed, cleared, while playing and stopped; the definer
trim and lock-collapse by fingerprint; undo/redo chains; "editing lane
B never moves lane A"), groups (combine, group windows, recording
through a map, one-shot groups, delete/undo), cut bands, cursors, the
edge journeys (nested maps, a window authored on an empty group, seek,
save/load), and THE OWNER'S WORKFLOW (`workflow.spec.js`): a five-mic
drum kit from a track template recorded as one take, the loop region
pulled in from both sides on the first clip, bass/guitar/keys, a long
replacement drum take cut and trimmed while playing (an ⌥-free seam,
whole-Q total), the scratch kit deleted, then three gate combinations
of a four-section song, a cued step and a bypass. The server runs
`--inputs 8` so each mic records its own sweep.

**What it has found** (2026-09-09, its first day): three see-vs-hear
bugs in the members of a windowed group — the slice was measured from
the zero instead of the group's origin (Q18), the members lacked the
group's heard-top rotation, and a member's own window inside a group
window was drawn ignoring the group's map — plus one engine-side rule
misfire: clearing a window (an edit that changes nothing audible)
moved the frame's zero to that loop's top when its period merely tied
another loop's, rotating every other lane on screen. All four are
pinned by `under_map_slice.test.mjs` and the journeys above. Day two
(2026-09-10) added a fifth: the frame's zero rode the edited clip's
whole-Q origin delta so that clip's tile held — and every OTHER lane
rotated by the delta whenever it was not a whole cycle of theirs
(loop_edits.spec.js "editing one lane's loop region never moves the
OTHER lanes' tiles", from four start phases). Both misfires were rules
that moved a stored zero; since 2026-09-16 the zero is not stored —
the view seats it from the lanes (frame.md) and the engine moves no
island fact for an edit. The gap-fill C++ scenarios (S33–S38, docs/scenarios.md)
found a sixth on arrival: clearing a window to "whole" left a stale
BYPASS, so the next window drawn on that lane was silently inert
(S34; fixed — a clear drops the bypass, undo restores it; mock twin
`bypass_clear.test.mjs`). Not yet covered: MIDI lanes
(the listener is audio; a note-clock twin would be the same idea),
plugin racks, and the WebView itself.

**Writing a spec** (`ui/e2e_engine/*.spec.js`, helpers in
`engine_helpers.mjs`): `openEngine(page)` (loads `?engine=true`,
resets), `rec(page, len, {atPhase})` records a take by the scenario
harness's recipe with the clock paused (arm, advance to the capture,
`len − live` more, stop, settle), `dimmedCells(page, laneId, cells)`
reads the DOM the way a performer does. Playwright starts the server
itself (`playwright.engine.config.js`, `--paused`); ONE engine process
serves the run, so specs are serial and start with `reset`.

Gotchas:

13. **`islandPos` is published ZERO-RELATIVE and unwrapped**
   (`AudioEngine::getGraphState`): the island phase is
   `islandPos mod cycle`, never `islandPos − zero`. The first
   see-vs-hear run subtracted the zero twice and armed a Q late.
14. **The server pumps the message loop by hand.** A console tool has
   no NSApplication, and on macOS `runDispatchLoop()` is `[NSApp run]`
   — it returns at once. The loop is `runDispatchLoopUntil(50)` (needs
   `JUCE_MODAL_LOOPS_PERMITTED=1`, set on the target); bridge verbs are
   marshalled there from the HTTP thread (`onMessageThread`), exactly
   the app's threading.
15. **Projects land in a temp folder** (`--projects-dir` defaults under
   the user cache) — the server must never birth projects into the
   real library.

## Browser harness (mock backend)

For UI iteration without a C++ rebuild:

```bash
cd ui
npx serve . -p 8080           # file:// won't work (CORS); port 8080 =
                              # .claude/launch.json + playwright.config.js
# open http://localhost:8080/index_test.html
```

Backend selection lives in `ui/js/backend.js` (the P2-9 facade — the
only module that knows mock vs harness vs JUCE bridge; in `?mock=true`
mode it exposes Playwright helpers as `window.__celestrianTest`). The mock (`ui/js/mock_backend.js`) holds **state +
protocol only** — all timing math is imported from `timeline_model.js`
so it cannot drift from the UI or, via golden vectors, from the C++
engine. Scenario definitions live in `ui/js/mock/scenarios.js`
(re-exported as `loadScenario`); the sidebar in `index_test.html`
switches them. Limitations: no real audio, simulated waveforms, state
resets on reload.

## Field debugging

The app's **📦 Dump State** button writes `celestrian_state.json` (app
cwd), containing per-node timing fields (`origin`, `launchPoint`
(derived), `duration`, `contextCycle`, `periodSource`, `windowActive`,
`loopBypassed`, `segments`) and the `perf` block (DSP load, xruns,
latency compensation, `calibrated`, `sampleRate`). Asking for a dump is
the fastest way to diagnose alignment issues — it has settled every
field bug so far in one glance.

### Field checklist: loop regions

*(Lifted from docs/archive/loop_region_audit.md §5, 2026-08-30.)*

- After a definer trim, the composite should NOT change shape, the loop
  should NOT jump, and undo should return exactly the previous window
  and its sound.
- Ruler seek: the audio must jump with the cursor, and the cursor must
  land ON the click. If it sounds like it did before (cursor moves,
  music doesn't), `seekTransport` has stopped carrying the origins with
  the zero (time_maps.md content-frame law); if it lands off the click,
  the view's phase-advance arithmetic (`seek.js`, frame.md) has parted
  from the seated zero.
- Five-mic group takes: `dumpState` and check every member's `origin`
  and `duration` are identical; if not, send the dump (the
  members-whole invariant, design_language.md Q13-for-groups).
- After take 2 against a trimmed group: the members should read as 1Q
  whole takes (collapsed), the group as a plain 1Q part; deleting take
  2 brings the full takes and the trim back (lock-collapse / re-open ⟹
  uncollapse, Q13).
- A release that briefly snaps a bracket back then forward is the
  reconcile-during-drag guard regressed (or a hold longer than 1.5 s:
  bridge latency).

### Field checklist: the 1.0 session (tasks.md B9)

One scripted session, run with a real interface on macOS and on
Windows before a build is called 1.0. Every step names the ruling it
exercises; a dump (📦) after each take is the evidence.

1. Launch to an empty session; press `R`. A track exists, is armed, and
   capture begins at the next boundary (Q17 spark, Q11).
2. Play a scratch loop ~4 bars; stop. Trim the dead air with the
   brackets while it plays; the loop does not jump (Q13, phase-preserving
   trim). Q reads the trimmed length.
3. + → Drums (a 5-mic group template); ● on the group. All five mics
   commit with ONE origin and ONE duration (Q7, I2). Trim the group's
   window: the mics stay one take and the zero is origin + start (Q18).
4. Record bass over it; the drum trim is locked (Q13 lock-collapse); the
   bass anchors on the grid.
5. Toggle the drums to a one-shot (↺/1×): they fire once per cycle from
   their take mark and rest silent (Q18, Q5). Toggle back.
6. Window the bass to [1Q, 2Q) while playing: audio continuous at the
   edit, the loop drawn from the frame top when a whole cycle of the
   drums reaches it (frame.md), else wrap-ghosted; ⌘Z restores.
7. Open the sequencer on the root; make three steps (intro / verse /
   chorus) with gates; cue the chorus. Playback follows the song; the
   frame-health badge stays quiet (S-series, sequencer.md).
8. Bounce the song (project menu). The WAV is one song long plus tails
   and equals what the speakers played (Q19).
9. Save; quit; relaunch; open. Everything above is exactly as left,
   including the one-shot knob, the windows, the sequence and the
   group's origin (session_io, Q18 persistence).
10. Optional interface features: turn software monitoring on for a track
    (Q20) and confirm the latency readout matches the calibration.

Any step that fails goes into tasks.md with the dump attached.
