# Test Harness

> Status: **spec** — how to build and run every test layer, plus the
> gotchas that have actually bitten this project. (Rewritten 2026-07-09;
> the old version referenced a long-deleted `app_test.js`.)

## The layers

| Layer | What it covers | Run with |
|---|---|---|
| C++ unit/engine tests | Nodes, timing math, engine workflows, calibration, pre-record capture | `cmake --build build --parallel 8 --target CelestrianTests && ./build/CelestrianTests_artefacts/Debug/CelestrianTests` (`--category=<name>` runs one suite) |
| JS unit tests | The view model, the timing mirrors, the mock, the shell's modules, the session view's pure parts | `cd ui && npm test` (= `node --test js/tests/*.test.mjs`: one process per file, in parallel; one file alone is `node js/tests/<name>.test.mjs`) |
| Playwright e2e | UI behavior against the mock backend | `cd ui && npm run test:playwright` |
| **Engine e2e** | The REAL UI in Chromium against the REAL C++ engine (the headless engine server) — see below | `cmake --build build --target CelestrianHeadless && cd ui && npm run test:engine` |
| **Differential** | The mock against the engine: one verb sequence on both, every published fact compared after every step — see below | `cmake --build build --target CelestrianHeadless && cd ui && npm run test:diff` |
| Golden vectors | Pin each C++ timing law and its JS twin to the SAME numbers — see "Adding timing math" | `shared/timing_golden.json`, consumed by the C++ and JS unit suites |
| Protocol contract | The bridge method list in `protocol.js` ⇔ `bridge_dispatch.cc` (+ the window verbs of `main_component.cc`) ⇔ `mock_backend.js` | part of `npm test` (`protocol_contract.test.mjs`) |

`npm run test:all` runs the JS unit, mock e2e, engine e2e and
differential layers in that order. In the C++ binary,
`--category=Scenarios` runs the scenario catalog (docs/scenarios.md)
and `--category=Golden` the three golden-fixture readers alone.

**Mock-vs-engine parity is pinned by the differential, not by unit
tests.** The JS unit cases that replayed an engine sequence on the mock
were deleted where a differential journey holds the same verbs and
facts; what the unit layer keeps of the mock is the mock's own
mechanisms (`mock_contract.test.mjs`) and the view tests that use it
for a scene. So `npm test` alone does NOT show that the mock still
matches the engine: `npm run test:diff` does, and it needs
`CelestrianHeadless` built (it exits 77, skipped, without it).

**The twin ledger rule.** A test is deleted as redundant only when a
named TWIN asserts the same fact in the same situation, and the twin is
then on the KEEP side: it may not be deleted as someone else's
redundancy. A case deleted on a twin always leaves a kept twin.

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
   coincide — which hid two field bugs. Field-shaped tests run the
   transport first, by a count that is no whole second and no whole Q
   (`monotonic_clock_tests.cc` "The first take's cursor…" and the
   UI-contract capture have the pattern).
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
   reproduced solo. `boot` in `ui/e2e/helpers.js` does the wait — boot
   through it.
8. **Poll an observable; never sleep.** `ui/css/session.css` animates
   fades and morphs (~0.2 s transitions); a single computed-style read
   lands mid-transition under parallel-worker load. Use `expect.poll` (or
   `toHaveCSS`), or one of the waits in `ui/e2e/helpers.js` (`settled`,
   `watchFrames`). No spec calls `waitForTimeout`.
9. **The mock's clock is STEPPED under test.** A person on the mock page
   gets the engine's behaviour: ● from stopped starts the transport and
   every poll ticks the clock. A test must own time, or a state read
   changes what it observes — see "The mock's clock" below.
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

   `boot` in `ui/e2e/helpers.js` is what seeds the page's rate, so a
   spec joins the e2e sweep by booting through it. Run the e2e sweep at
   44100 and above (the first exception says why). Three deliberate
   exceptions, each load-bearing:

   - `transport.samplesPerTick` is a fixed SAMPLE STEP, not 50 ms of
     audio. Deriving it from the rate moves every play-then-poll clock
     position and flips outcomes that fold on them. Consequence: the
     mock simulates a constant `SIMULATED_SAMPLES_PER_SECOND` of audio
     per wall-clock second — real-time specs size their sampling window
     from that constant, never from a hardcoded millisecond count. At a
     rate of 22050 or below that step is two or more times real time,
     and the playhead's dead-reckoner reads every poll as a seek
     (`playhead_clock.js` `TELEPORT_VEL_FACTOR`): a spec that watches
     the cursor keep its pace cannot hold there. That is the mock's
     step, not the UI.
   - The e2e sweep seeds `window.__celestrianMockRate` via
     `addInitScript`, NOT `?rate=`: the static server's clean-urls
     redirect drops the query of a path that names a file, which once
     left a page quietly at 44.1 kHz through an entire "48 kHz" run.
     For the same reason specs open `/?mock=true`, never
     `/index.html?mock=true`.
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
   `ui/js/tests/engine_replay.test.mjs` and `display_contract.test.mjs`
   read `shared/ui_contract_capture.json` and
   `shared/display_contract_capture.json`, which the C++ Debug test
   binary writes (`tests/ui_contract_tests.cc`,
   `tests/display_contract_tests.cc`). With no capture on disk those
   tests SKIP, and say so — a skip there is not a pass.

## Adding a bridge method

Three places, or the contract test fails: `ui/js/protocol.js` (the
canonical list), `src/bridge_dispatch.cc` (the table both hosts serve;
a verb that needs a window is bound in `src/main_component.cc` with
`bindWindowVerb`), and `ui/js/mock_backend.js` (`handlers` table +
implementation). All three in the same answer KIND (ui.md "The answer
law"): `boolMethod` for a verb the engine can refuse, `valueMethod`
for a value, `voidMethod` for a knob nothing can refuse —
`protocol.js` says the kind in `returns`, the contract test parses the
C++ registrations and calls the mock for an applied and a refused case
of every bool verb. `tests/bridge_dispatch_tests.cc` (`--category=Bridge`)
drives each family through the bridge handler by name: refused →
`false` and the graph, the undo flags and the transport unchanged.

## Adding timing math

Put the pure function in BOTH mirrors, then pin them with a case in
`shared/timing_golden.json` — the golden tests on each side keep the
two implementations from drifting. Each group's `*_note` in the fixture
names its law and the two functions that must agree.

| C++ | JS twin | golden groups |
|---|---|---|
| `src/timing.h` `innerAt`, `stackFold` | `ui/js/time_map.js` | `inner_at_cases`, `stack_fold_cases` |
| `src/time_map.h` (the map, its inverse, the top) | `ui/js/time_map.js` | `time_map_cases`, `map_inverse_cases`, `top_reconcile_cases`, `effective_top_cases` |
| `src/timing.h` `armTarget`, `nextStopBoundary`, `snapCommittedDuration`, `launchPointFor`, the through-map arm | `ui/js/timeline_model.js` | `arm_target_cases`, `stop_boundary_cases`, `snap_cases`, `launch_point_cases`, `through_map_*_cases` |
| `src/period_law.h` | `ui/js/period_law.js` | `period_law_cases` (tree fixtures, a take being recorded included), `scope_cycle_cases` |
| `src/heard_index.h` `continuityOriginFor`, `nearestRepresentative` | `ui/js/mock/heard.js` | `continuity_origin_cases`, `nearest_representative_cases` |
| `src/sequence.h` `Sequence::finalize`, `readSuccessors` | `ui/js/sequence_program.js` | `sequence_program_cases` |
| `src/qtime.h` (`posMod`, the Q arithmetic) | `ui/js/math_utils.js`, `ui/js/qtime.js` | `pos_mod_cases`, `lcm_cases`, `qtime_*_cases` |
| `ClipNode::peakBucket` | `ui/js/mock/waveform.js` | `peak_bucket_cases` |

The C++ reader FAILS on a missing or empty group (`forEachCase`,
`tests/timing_golden_tests.cc`): a renamed key cannot pass as "no
cases".

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
`bridge_http.js`). The HTTP bridge sends a VERB once: when the
connection drops (the server busy with a long render) only a query —
a method `protocol.js` marks `read` — is sent again; a lost verb
answers `null`, and the shell says the engine did not answer. The
control surface follows the same rule (`status`, `pause`, `resume`,
`input`, `reset` may be re-sent; `advance`, `listen`, `truth` never).
By hand:

```bash
./build/CelestrianHeadless_artefacts/Debug/CelestrianHeadless --port 8091 --ui-dir ui
```

**The control surface** (`POST /control {op}`; in the page,
`window.__celestrianTest.engine(op, params)`) makes runs deterministic:
`pause` / `resume` the clock, `advance {samples}` by an exact count,
`input {kind, freq, gain}`, `status` (quantum, zero, islandPos,
cycle by the period law, paused, clock), `reset` (below),
`truth` — THE AUDIBLE TRUTH: the engine solos each clip and listens
one island cycle, answering per Q cell whether it sounds. The
see-vs-hear spec (`ui/e2e_engine/see_vs_hear.spec.js`) builds a root
song with real clicks on the grid and asserts every lane's `.seq-dim`
sits exactly where the engine is silent.

**`reset` is a fresh boot.** At start-up the server saves the engine's
own empty session as THE BOOT BUNDLE (`<projects-dir>/headless-reset`).
`reset` then: ends any live take through the engine's own stop (a
pending arm is cancelled; a capturing take runs to where its stop
lands — the server renders that much clock); closes an opened or born
project (`ProjectManager::closeProject`: flushed, then unborn); lets
the root go of what no session carries (solo, MIDI arm, scope, a
rename); LOADS THE BOOT BUNDLE — every node gone, the master rack and
fader as built, no song, no Q, no hand-off, and (a load starts the
history afresh) nothing to undo; removes track templates saved since
boot. It answers `{ok}`: false when the bundle would not load. Left as
they are, on purpose: the transport (running — the specs expect it),
the input choice, and the clock (never reset). A loaded session's
placeholder plugins are revived, as in the app
(`bridge::revivePlaceholders`).

**The spectral listener** (`--input chirp`, `listen {samples, hop}`;
the codec is `src/headless/chirp_codec.h`) is the harness's instrument.
The input is a linear frequency sweep
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
that x (tile grid, window slice, rotation). A peak reads back to under
two hundredths of a bin; the listener resolves about 0.01 Q.
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
of the scenarios: the owner's chain, growth and the zero,
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
`--inputs 5` (`playwright.engine.config.js`) so each mic of the kit
records its own sweep.

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
in `undo.test.mjs`). Not yet covered: MIDI lanes
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

## Differential — the mock against the engine

The mock-page specs and most JS unit tests run on the mock, so a mock
that behaves "plausibly" instead of as the engine does makes them all
vouch for a UI that breaks on hardware (gotcha 11). The differential
harness (`ui/differential/`, node only, no browser) is what holds the
mock to the engine: it launches `CelestrianHeadless` as a child
(`--paused --input ramp`, a port the OS hands out, its own scratch
projects directory), drives ONE verb sequence against the engine and
the mock, and compares every published fact after every step.

```bash
cmake --build build --target CelestrianHeadless   # the engine, from this tree
cd ui && npm run test:diff                         # the harness's selftest, then the suite

node ui/differential/run.mjs --only window/ --show --plain   # read journeys step by step, both states
node ui/differential/run.mjs --emit                          # unclaimed diffs as `sites` literals
node ui/differential/run.mjs --report out.md                 # the drift report
CELESTRIAN_HEADLESS=<path> node ui/differential/run.mjs      # another binary
```

**Exit codes:** 0 green · 1 failed (an unclaimed diff, a stale claim, a
key-set change, a harness error) · **77 SKIPPED, the engine is not
built** — nothing was compared; npm reports the script failed, and that
is right: a skip is not a pass.

The parts (each file's header is its document):

- **`session.mjs`** — the driver, and the TIME-PARITY rules: the
  engine's clock is paused and advanced by exact sample counts in
  512-sample blocks; the mock is advanced by what the engine's
  transport moved, in the same blocks; the take flags, a live take's
  length and the window phase are compared at block points, the rest
  after every verb. Nodes are named by label (`@A`), resolved to each
  side's own id. Every verb's ANSWER is compared as well as the state
  it leaves (the kinds come from `protocol.js`): `true` / `false`
  exactly for a verb that can be refused, the new node by label for the
  two that make one, the listings by shape — so a mock that announces
  what the engine refused, or answers nothing, is a diff. The answers
  of the undo and redo probes are compared too.
- **`fields.mjs`** — one row per published fact: how it is read, or the
  one-line reason it is not compared. `normalize.mjs` turns a state
  into `scope.field` facts (ids → labels, positions from the island
  zero) and diffs them; it also holds the KEY SETS — a raw key only one
  side publishes fails the run.
- **`journeys.mjs`** — about a hundred deterministic journeys from an
  empty session: every undoable verb accepted and refused, and the
  gestures beside them (seek, audition, knobs, a cancelled drag). Most
  are `docs/scenarios.md`'s sequences. Each runs TWICE: plain, and with
  an undo and a redo after every call. Q is 10 000 samples — not a
  block multiple, so grid lines fall inside blocks as on a device.
- **`walk.mjs`** — seeded random walks over the same verbs (fixed
  seeds, so a run is reproducible). A diff no claim covers is a
  FINDING: the SHRINKER drops ops until the sequence is minimal, and
  the run fails with it. Pin a finding as a journey.
- **`known_drift.mjs`** — the list of differences known and not yet
  fixed, by family (what differs, which side is right, why) with exact
  sites. The suite is green while every diff is claimed AND every claim
  still claims a diff — an UNCLAIMED diff fails the run, and so does a
  STALE entry. So the list can only shrink: fix a family, the run names
  its entry as stale until it is deleted. **The list is EMPTY**: the two
  sides agree on every journey and every walk. If it ever grows, each
  entry must be explainable on its own — what differs, which side is
  right, the line of spec or code that says so — and an entry that
  marks an engine bug (`engineBug`) is a task, not a resting place.

**Reading a failure.** The run prints the journey, the step, the key
and both values. `--only <journey> --show --plain` prints both states
after every step. Decide which side is right from the docs and the
engine's code; fix the mock (the usual case), or — when the engine is
the one that is wrong — fix the engine with a C++ test first. Add a
claim only for a difference that is understood and deliberately left.

**Gaps** (not compared): a plugin add / remove that SUCCEEDS (needs a
real VST3 in the engine's registry), MIDI input, the window verbs the
headless server stands in for, content (`getWaveform`, what a bounce
writes — state only), and more than one rate or block size.

## The mock's clock

`ui/js/mock/transport.js`, `state.js` `transport`:

- **A poll is the mock's audio callback.** `getState()` runs one pass
  of the mock's "audio thread": it ticks the clock by one fixed step
  while the transport runs, and lands what the audio thread owes even
  on a still clock: an arm's start (an arm reads pending until its next
  callback), a first take's stop (it commits at the next callback, as
  the engine's commits at its next block top), a capturing new take's
  cancel. The e2e recipes (`recordDefiner`) run that callback after a
  stop. `readState()` reads
  the published state WITHOUT that pass — the differential's mock side
  reads through it.
- **An arm starts the transport**, as the engine's does.
- **Under test the clock is STEPPED** (`transport.stepped`): an arm
  still starts the transport, but a poll no longer ticks the clock —
  time passes by `advanceBy(samples)`, or in real time once the test
  itself plays (Space, `togglePlayback`, `startTransport`). It is on
  from the start outside a page (the node tests) and on a page that
  sets `window.__celestrianMockClock = 'stepped'` before the mock loads
  — `boot` in `ui/e2e/helpers.js` does. `stepClock(false)` hands the
  clock back to the polls.

`window.__celestrianTest` (set by `backend.js` under `?mock=true`)
carries the controls: `loadScenario`, `callNative`, `startTransport`,
`pauseTransport`, `advanceBy`, `stepClock`, `readState`, `setMasterPos`,
`setIsPlaying`, `getLastBounce`, `getLastImport`,
`SIMULATED_SAMPLES_PER_SECOND`.

## The mock-page specs' shared recipes

`ui/e2e/helpers.js` is the one fixture module of `ui/e2e/*.spec.js`;
its header states the law — REAL INPUT: every interactive element is
driven with `page.mouse` / `page.keyboard`; the bridge is for setup and
for reading state, never for the gesture under test. What it owns:

- **`boot(page, {scenario, lanes, bridgeDelayMs})`** — sets the stepped
  clock, seeds the rate from `E2E_MOCK_RATE`, opens `/?mock=true`,
  waits for the test surface, loads the scenario.
- **bridge and state** — `mock`, `call`, `graph`, `root`, `node`,
  `seqOf`, `quantum`, `loopOf`, `segsOf`, `setLoop`, `recordMapCalls` +
  `consoleDrained` (the exact fence for "no call reached the bridge").
- **lanes and the edit bar** — `laneOf`, `panelOf`, `stripOf`,
  `selectLane`, `laneHandles`, `laneMarks`, `handleTab`.
- **pointer** — `dragBy`, `dragTo`, `release`, `gripDrag`,
  `jiggleUntil`, `ctrlWheel`, `undo` / `redo`.
- **waits** — `settled(page)` (no live gesture, no pending preview, no
  pin, no tween, the picture unchanged over two polls), `watchFrames` /
  `sampleFrames` (per-frame sampling that an observable ends),
  `pastVerdict`, `projectAnnounced`.
- **recipes** — `recordDefiner`, `recordTake`, `recordDefinerAndTake`,
  `loopedTake`, `slottedTopology`, `armPending`: they drive the mock's
  clock by hand and leave the transport stopped.

The JS unit layer has the same split: `ui/js/tests/helpers.mjs` (the
scene family — `clipAt`, `windowed`, `mapped`, `groupAt`, `island` —
and `laneOf`, `near`, `loadCapture`; no mock import),
`mock_scene.mjs` (recipes that drive the mock) and `dom_stub.mjs`.

## Browser harness (mock backend)

For UI iteration without a C++ rebuild:

```bash
cd ui
npx serve . -p 8080           # file:// won't work (CORS); port 8080 =
                              # .claude/launch.json + playwright.config.js
# open http://localhost:8080/?mock=true&harness=1
```

Backend selection lives in `ui/js/backend.js` — the only module that
knows which backend the page talks to: `?mock=true` (the mock, with
its test surface on `window.__celestrianTest`), `?engine=true` (the
headless engine server) or the JUCE bridge. `&harness=1` mounts the
scenario sidebar beside the app (`ui/js/harness_sidebar.js`);
`ui/index_test.html` is only a redirect to `/?mock=true&harness=1`.
The mock (`ui/js/mock_backend.js` + `ui/js/mock/*`) holds **state +
protocol only** — its timing math is imported from the mirror modules
(`time_map.js`, `period_law.js`, `sequence_program.js`,
`timeline_model.js`; `mock/heard.js` is the twin of
`src/heard_index.h`), so it cannot drift from the UI or, via golden
vectors, from the C++ engine. Scenario definitions live in
`ui/js/mock/scenarios.js` (re-exported as `loadScenario`).
Limitations: no real audio, simulated waveforms, state resets on
reload.

## Field debugging

The app's **📦 Dump State** button writes `celestrian_state.json` (app
cwd), containing per-node timing fields (`origin`, `duration`,
`contextCycle`, `periodSource`, `windowActive`, `loopBypassed`,
`segments`) and the `perf` block (DSP load, xruns,
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
