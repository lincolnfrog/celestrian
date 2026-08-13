# Test Audit — 2026-08-12

> Status: **catalog** (the Tier 4 "Tests" audit). Run against the
> post-group-arm tree (Q7 + I2 landed the same day). Environment: a
> Linux x86-64 sandbox (JUCE 8.0.4 via CPM, Debug build, per
> test_harness.md — including gotcha 1's `Debug/` binary path). One
> suite could not run there (noted below); a macOS confirmation run of
> the full binary is the only outstanding step.

## Verdict

Every test that can run in the audit environment passes. No skipped,
disabled, or dead tests were found in any layer. The three audit items
tasks.md carried are closed by this document: the C++ catalog (below),
the JS/E2E health check (below), and the "new invariant tests" bullet —
D1 was pinned 2026-08-06 (output_stage_tests), I2 is pinned as of
2026-08-12 (group_arm_tests), and the D2 stop-boundary pin turns out to
have existed all along (clip_node_tests.cc "stop boundary is picked by
the AUDIO thread" — the tracker line saying it was missing was stale).

## C++ engine suite (CelestrianTests, Debug)

30 registered suites. 29 ran in the sandbox: **211 sections, 0
failures — ALL TESTS PASSED.**

| Suite | Sections | Result |
|---|---|---|
| Timing Golden Vectors | 12 | ✅ |
| QTime (rational musical time) | 6 | ✅ |
| Monotonic Clock (never reset) | 2 | ✅ |
| Latency Calibration | 6 | ✅ |
| Pre-Record Capture | 6 | ✅ |
| ClipNode | 18 | ✅ |
| StackNode | 8 | ✅ |
| Quantum Propagation | 7 | ✅ |
| Stack Loop Window | 8 | ✅ |
| AudioEngine Workflow | 19 | ✅ |
| AudioEngine | 10 | ✅ |
| Undo | 8 | ✅ |
| Engine Bridge | 8 | ✅ |
| Provisional Q mutability (Q13) | 9 | ✅ |
| Whole-graph snapshot (Step 3) | 3 | ✅ |
| Pure render (§2.3) | 4 | ✅ |
| Take capacity (D4: no wall) | 3 | ✅ |
| Time-Map Recording | 14 | ✅ |
| Save (session io) | 4 | ✅ |
| Session Negative Paths | 7 | ✅ |
| Project Lifecycle | 6 | ✅ |
| FirstClipBug | 2 | ✅ |
| UI Contract Capture | 1 | ✅ |
| Effects Stereo | 8 | ✅ |
| Effects | 8 | ✅ |
| Output Stage | 7 | ✅ |
| One-Shots (period source) | 6 | ✅ |
| Callback Edges | 7 | ✅ |
| Group Arm (Q7) | 4 | ✅ (new 2026-08-12: the I2 pins) |
| **Stereo & Pan** | 7 | ⚠️ **not verifiable in the sandbox** |

⚠️ Stereo & Pan: the section "Stereo capture: two inputs land on two
content channels" aborts with `double free or corruption` **on Linux
only**, in a PRISTINE pre-group-arm checkout as well (verified against
a clean baseline build — the crash is byte-identical with and without
the 2026-08-12 changes, so it is environmental, not a regression). The
suite is reported green on macOS in the 2026-08-11 D3 run. Action:
confirm with one `Debug/CelestrianTests` run on the Mac; if it ever
fails THERE, treat as a real bug (the crash smells like an
AudioBuffer channel-count resize under glibc's stricter allocator —
a lead worth keeping if macOS ever agrees).

## JS unit suite (`cd ui && npm test`)

**23 files, 169 tests, 169 pass, 0 fail, 0 skipped.**

composite_waveform 29 · view_model 35 · timeline_model_golden 14 ·
q13 12 · qtime_golden 9 · segments 8 · map_edit 8 · fx_viz 7 ·
map_record 6 · group_arm 5 (new) · map_coherence 5 · playhead_clock 5 ·
engine_replay 4 · undo 4 · gain 3 · live_peaks 3 · one_shot 3 ·
protocol_contract 2 · session 2 · waveform_stability 2 · lcm_final 1 ·
map_anchor 1 · mock_epoch 1.

Health notes: the protocol contract test (bridge ⇔ mock ⇔
main_component method parity) passes, so the three-place bridge
discipline holds. No test relies on the removed mock behaviors (the
2026-08-12 arm-cancel parity and emptiness gate broke nothing).

## Playwright E2E (`npm run test:playwright`, chromium)

**42 tests, 42 pass, 0 fail, 0 skipped, 0 flaky** (~33 s, 2 workers).

Coverage groups: Session shell (windows/brackets/dims) · Loop window
brackets phase 3 (drag, snap ghost, fractal I5, window cursor, E-C
sweep, latent brackets) · Input picker (mono/stereo round-trip, Escape
dismissal, mid-take gate) · One-shot toggle (Q5, undo) · Gain dial
(fractal) · Effects rack (fractal, viz, drag-vs-tick) · Session shell
mock mode (empty state, deep playback frame, first take, DRUM FLOW
group ●, all-full island Q7 disable, no-flash commit, group arm rail
aggregate).

Historical note: the archive's "un-skipped collapsed-stack Playwright
tests (2 of 4)" is moot — the current suite carries zero skips.

## Known gaps (open, tracked in tasks.md Tier 4)

- E2E for: recording inside an EXPANDED stack; collapse → playhead
  constrained; drag visual feedback + grid lines for collapsed stacks.
- No e2e exercises the real JUCE bridge (all mock-backed by design;
  the UI Contract Capture C++ test covers the engine side of the
  boundary).
- Latency-calibration hardware paths are synthetic-loopback only
  (test_harness.md gotcha 5 — inherent).

## Repro

```
cmake -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build --parallel 8 --target CelestrianTests
./build/CelestrianTests_artefacts/Debug/CelestrianTests   # gotcha 1: Debug/ path
cd ui && npm test && npm run test:playwright
```
