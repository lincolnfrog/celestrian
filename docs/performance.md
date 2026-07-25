# Celestrian Performance & Latency

> Status: **spec** — §1 (the audio-thread contract) is project law.
>
> Written 2026-07-07, immediately after the real-time-safety refactor
> (refactoring_proposal.md §P0-2). This doc has three jobs:
>
> 1. Define the **audio-thread contract** so we never regress into glitch
>    territory.
> 2. Model **end-to-end latency** and analyze the suspected **record latency
>    issue** (spoiler: we back-date timestamps but throw away the audio the
>    user played before capture began).
> 3. Keep a ranked backlog of **throughput and latency work**, with
>    measurement techniques so we fix what's real, not what's imagined.

---

## 1. The audio-thread contract

Everything reachable from `AudioEngine::audioDeviceIOCallbackWithContext`
(`StackNode::process`, `ClipNode::process`, `commitRecording` when it fires
from `process`, the snapshot-space cycle math in `graph_snapshot.h`) must
obey:

| Rule | Why | Enforced by (today) |
|---|---|---|
| No locks (mutex, recursive_mutex) | Priority inversion with the message thread → dropouts | The audio thread traverses ONE immutable whole-graph snapshot per callback (`ProcessContext.snap`, published by atomic swap in `AudioEngine::publishGraph` — Tier 3 Step 3); the old per-stack snapshots and `children_mutex` are deleted |
| No heap allocation/free | malloc can take a lock or syscall | `ProcessContext` is POD; `mix_buffer` preallocated (8192 frames); snapshot math is free functions over index spans; deferred frees go through `AudioEngine::retire()` |
| No file I/O / logging | `juce::Logger` writes files | `src/rt_log.h` fixed-slot ring; drained on the message thread in `getGraphState()` |
| No buffer copies proportional to clip length | A 30 s clip copy is milliseconds of stall | No rotation exists at all — content is stored in the origin frame and playback offsets reads by the clip's origin (kernel.md; plus a `content_base_` storage offset after a Q13 lock-collapse); samples never move |
| No unbounded waits | — | The one remaining lock-ish thing is the RtLog `SpinLock`, held for a ≤160-byte memcpy, with try-lock (drops the message on contention) |
| No device queries per block | Driver calls can block | Latencies cached in `audioDeviceAboutToStart` |
| **One structure load per callback** | Per-stack loads could straddle a republish mid-callback; a whole-graph load can't | The engine loads `graph_snapshot_` once into `ProcessContext.snap`; stacks iterate child index spans, leaves resolve ancestry by parent indices. Island facts (quantum, epoch, island root) ride the context — the audio thread never walks node parent pointers or reads the ownership vectors |

**Object lifetime rule:** anything removed from the graph while audio runs is
freed via `AudioEngine::retire()` — the deleter runs only after the callback
counter has advanced two callbacks past retirement. This covers nodes AND
superseded graph snapshots (publish the successor first, then retire).
Never `delete` a node or snapshot directly from a mutation path.

**Phase split (§2.3, 2026-07-19e):** each callback runs CONTROL over the
whole graph (decisions + capture: arm, boundaries, commit — the only
place musical state changes), then RENDER (`const` — the kernel
equation; mutables are DSP scratch + playhead telemetry only).
`AudioNode::process` is the non-virtual sequencer; never interleave a
decision into a render path.

**Take content storage (D4, 2026-07-19i):** a clip's content buffer is
reached through ONE atomic pointer. Arm makes it a huge VIRTUAL
reservation (message thread, clip idle — pages commit as capture
writes; deliberately never cleared, and nothing reads past
write_position). Post-commit compaction swaps an exact-size copy in on
the message thread and retires the old buffer via the reclaimer — legal
under an actively rendering clip because render loads the pointer once
per block. Never resize or swap a buffer the audio thread might be
CAPTURING into (compaction skips armed/recording clips).
*Phase 3 (2026-07-22):* a node's multi-segment map override follows
the same discipline — ONE atomic pointer (`AudioNode::map_override_`),
message-thread swaps, superseded maps retired through the reclaimer,
audio thread loads at most once per call. A multi-segment
lock-collapse SPLICES a new content buffer in; the displaced buffer is
owned by the undo entry (never freed inline) and the un-splice retires
the spliced one.
*Documented deviation (time_maps.md phase 2, 2026-07-21):* a
THROUGH-MAP arm zeroes exactly `[0, C)` at arm time on the message
thread — the commit is a dense buffer with literal silence in
unvisited regions (ruling 2), and reads DO cover the whole span; an
audio-thread memset at commit would violate this contract. The
reservation tail past C stays uncleared. Compaction keeps
`max(recordedLength, duration)` (through-map content folds past the
heard length).

**Threading split after Step 3:** node ownership vectors
(`StackNode::ownedChildren`) and the traversal virtuals
(`getIntrinsicDuration`, `getEffectivePeriod`, `findNodeByUuid`,
metadata/waveform) are MESSAGE THREAD ONLY; their audio-side twins are the
snapshot-space free functions in `graph_snapshot.h`
(`snapIntrinsicDuration`, `snapEffectivePeriod`, `snapEffectiveCycle`,
`snapIsUnderSolo`). Parent-pointer walks (`getParent`/`rootNode`/
`getEffectiveQuantum`) survive only as message-thread helpers and the
single-threaded unit-test fallback inside `process` paths.

**PR checklist for anything touching the process path:**

- [ ] No `new`/`delete`/`setSize`/`makeCopyOf`/`juce::String`/`juce::var`
      construction on the audio thread (grep the diff).
- [ ] No `juce::Logger` — use `RtLog::instance().post(...)`.
- [ ] Structure traversal uses `ProcessContext.snap` / `graph_snapshot.h`
      — never `ownedChildren()`, never parent pointers.
- [ ] Island facts come from the context (`quantum`, `island_epoch`,
      `island`) — no walks.
- [ ] Cross-thread fields are `std::atomic`.
- [ ] Destruction of graph objects goes through `retire()`.

Known residual violations (tracked in refactoring_proposal.md):

- `ClipNode::getWaveform()` reads the recording buffer on the message thread
  while the audio thread writes it. Benign-ish (aligned float reads), fix
  belongs with the state-snapshot work (P3 note).
- ~22 `dynamic_cast`s per block (P1-8: replace with virtual dispatch /
  `forEachChild`).
- ~~`getEffectiveQuantum()` re-derives min-duration~~ — ✅ resolved
  (P0-3, 2026-07-09): quantum is stored island state; the lookup is a
  parent walk to one atomic read. `getIntrinsicDuration()` on stacks
  (composite LCM) still walks children per call — cache if the perf
  meters ever care.

---

## 2. Latency model

Four independent chains matter. Numbers below assume 44.1 kHz; a block of
512 samples ≈ 11.6 ms, 256 ≈ 5.8 ms, 128 ≈ 2.9 ms.

### 2.1 Monitoring chain (instrument → ears)

We do no software input monitoring today — users hear themselves
acoustically or through hardware monitoring. So this chain is currently
zero-cost for us, but it defines the *reference* the user plays against:
they play in time with what they **hear** (playback delayed by output
latency), and their sound reaches us delayed by input latency. That is
exactly the model behind the compensation in `ClipNode::process`:

```
compensated_pos = master_pos - (input_latency + output_latency)
```

This formula is right *if* the reported latencies are honest (see §4,
loopback calibration — consumer devices routinely under-report).

### 2.2 Record-start chain (button press → first captured sample)

```
click in webview
  → JS event + bridge hop (callNative)            ~1–10 ms
  → JUCE message thread sets is_pending_start      <1 ms
  → NEXT audio callback runs pending-start logic   0 … 1 block (avg ½ block)
  → capture begins at that block boundary
```

Everything the user played **before** that block is not in the clip buffer.
See §3 — this is the prime suspect for "record feels late".

### 2.3 Playback chain

Output latency (device buffer + DAC), typically 1–2 blocks. Nothing of ours
adds to it; keep it that way (the summing tree writes straight into the
device's output buffers).

### 2.4 Visual chain (state → pixels)

The UI polls `getGraphState` every 50 ms (`ui/js/app.js` poll loop), so any
state change (record armed, playhead moved, commit happened) is visible
0–50 ms later, plus a frame. Fine for playheads; sluggish for button
feedback. Cheap wins, in order:

1. **Optimistic UI** — flip the record button locally on click, reconcile on
   next poll.
2. Drop the poll to ~33 ms *only while a gesture is in flight*.
3. Long-term: push events over the bridge instead of polling (pairs with the
   P2-10 view-model refactor).

---

## 3. The record latency issue — ✅ fixed (2026-07-07): arrival-time capture

> **Correction.** The first draft of this section framed the fix as
> "back-fill the first C samples from a ring" — that had the *sign of the
> error backwards* for the play-along case. The analysis below is the
> corrected model that the implementation follows; the measured 139 ms
> round trip on real hardware made the error direction unambiguous.

### The model

The user plays in time with what they **hear** (delayed by output latency);
their audio reaches the input delayed by input latency. So a note played on
the heard beat at musical time `B` **arrives at the input at `B + C`**,
where `C` is the full round trip (empirically measured by calibration, §7).

The old capture copied the live input block starting when the recording
state flipped (≈ the boundary `B`). Clip position 0 therefore held the
audio that *arrived* at `B` — which the musician played `C` earlier. The
note meant for the beat landed at clip position `C`, and every recording
played back **late by the round trip** (139 ms on the measured setup —
exactly the reported symptom).

### The fix: capture by arrival time, fed from a pre-record ring

Implemented as two pieces:

1. **Pre-record ring** (`AudioEngine::prerecord_ring_`): every input block
   is copied unconditionally into a preallocated ring (8 ch × 2 s), indexed
   by a **monotonic input clock** (`input_clock_` — total samples since
   engine start; unlike `master_pos` it never wraps or resets). Two bounded
   memcpys per channel per block; RT-safe. The ring and clock travel to
   nodes via `ProcessContext`.
2. **Arrival-time capture window** (`ClipNode`): when recording starts, the
   clip computes the input-clock position of its first sample:

   ```
   window_start = input_clock + (trigger − compensated_now)
   ```

   i.e. clip position `p` holds the input that arrived at performance-time
   `trigger + p` — which is master-time `trigger + C + p`. Capture then
   streams from the ring as those samples arrive. The window start may be
   in the future (boundary ahead → wait), mid-block, or slightly in the
   past ("already at boundary" starts reach back into the ring — this is
   where the ring's history is essential).

Consequences worth knowing:

- The first clip is unchanged by construction (`trigger = compensated_now`
  → the window starts at "now"); it *defines* the grid, so there is nothing
  to align to.
- A recording's commit lands `C` later in wall time than before (the last
  window sample must physically arrive). Musically nothing moves — the
  committed content covers exactly `[trigger, trigger + duration)` in
  performance time.
- Peak meters read the captured (windowed) region, so the record meter lags
  by `C`. Live-input metering could be added separately if that feels off.
- Unit tests that drive `ClipNode::process` directly (no ring in the
  context) fall back to the old live-block capture, unchanged.

**Test:** `tests/pre_record_tests.cc` calibrates a synthetic 137-sample
loopback, records a grid clip, then records a second clip where an impulse
*arrives* exactly `boundary + 137` — the arrival time of a note played on
the heard beat. The impulse must land at clip position 0 (pre-fix behavior
put it ~137 late), and nowhere else.

### Confirmation checklist (now mostly automated)

1. ~~Log the reported latencies~~ ✅ logged at every device start.
2. ~~Loopback measurement~~ ✅ the 🎯 calibration feature (§7); measured
   139.1 ms on the reference setup.
3. **Human test (do this after pulling):** record a sharp transient against
   an existing clip's beat and confirm it plays back on the beat. This is
   the end-to-end validation of calibration + arrival-time capture on real
   hardware.

---

## 4. Device configuration

Current init (`AudioEngine::init`):

```cpp
device_manager.initialiseWithDefaultDevices(8, outputs);
```

Issues, in priority order:

1. **Buffer size is whatever the OS defaults to** (often 512). For a live
   looper, 128–256 is the right target on macOS/CoreAudio. Set an explicit
   preferred buffer size via `AudioDeviceSetup`; expose it in settings
   eventually. Every block halved removes ~5.8 ms from §2.2 and from the
   monitoring reference error.
2. **Requesting 8 inputs** can force channel-count negotiation or an
   aggregate-device config on some interfaces (aggregates add latency and
   clock-drift resampling). Request what the session needs (1–2), grow on
   demand.
3. ~~Sample rate is assumed 44100 everywhere~~ — ✅ *P0-5 implemented
   (2026-07-07)*. The device rate captured in `audioDeviceAboutToStart`
   now feeds `ProcessContext.sample_rate`, clip creation (buffer sizing +
   honest metadata), the timeline fallback, and every samples→ms display
   via `perf.sampleRate`. Field-motivated: the reference setup runs at
   48 kHz, caught when the same 6679-sample calibration displayed as
   139.1 ms (C++, true rate) and 151.4 ms (UI, hardcoded 44100)
   simultaneously. Sample-domain math was never affected. Residuals:
   remaining 44100 literals are commented device-less test defaults; the
   mock simulates a 44.1 kHz device; mid-session rate changes are not
   resampled (clips keep their recorded rate). The "44100 literal as lint
   failure" guardrail is part of §6.6 (not built).
4. Add `juce::ScopedNoDenormals` at the top of the callback — denormal
   floats in feedback/decay tails can multiply CPU cost 10–100×.

---

## 5. Throughput backlog (ranked)

None of these currently cause audible trouble at small graph sizes; they're
ordered by (impact × likelihood we hit them as graphs grow).

1. **Per-sample playback loop** (`ClipNode::process`): per sample it does
   int64 modulo, rotation remap, and a per-channel store. Replace with
   segmented `FloatVectorOperations::add` runs between wrap points (loop
   boundary, rotation seam, block end) — typically 1–3 memcpy-speed segments
   per block instead of `num_samples × channels` scalar ops. Biggest CPU win
   available in the engine, and mechanical to test against the current
   implementation (golden output comparison).
2. **Quantum/LCM re-derivation per block** (`calculateTimelineLength`,
   `getEffectiveQuantum`): O(graph) walks with `dynamic_cast`s, per block,
   plus again per node in `getMetadata` per UI poll. P0-3 (stored quantum)
   plus caching the LCM (invalidate on commit/graph change — both are
   message-thread events) reduces this to atomic reads.
3. **`dynamic_cast` per block** (~22 sites): P1-8 — virtual
   `forEachChild`/`getNodeType` dispatch. Cheap individually; they add up
   and they're a code smell that hides layering problems.
4. **`getGraphState` cost per poll**: builds a full `juce::var` tree and
   JSON-serializes it across the bridge every 50 ms, O(nodes) allocations on
   the message thread. Fine below ~100 nodes. The endgame (per
   refactoring_proposal.md P0-2/P2-10) is a POD state snapshot + delta
   updates; don't invest in intermediate optimizations here.
5. **Waveform fetches** (`getWaveform`): O(clip samples) scan per call on
   the message thread. The UI fetches on-demand (guarded in
   `fetchWaveform`), so this is bounded today. If live waveform-while-
   recording is wanted, maintain incremental peak buckets during capture
   (audio thread appends one max per N samples into a preallocated array)
   instead of rescanning.
6. **Stack summing** clears and adds `mix_buffer` per child; a single-child
   stack could pass through. Micro; only bother if profiling says so.

JS-side rendering cost (per-frame ghost rebuild, `getBoundingClientRect`
per clip, per-frame logging) is covered by refactoring_proposal.md P2-10 and
not duplicated here.

---

## 6. Instrumentation & verification

What we can't measure we will regress. Cheap, permanent instrumentation:

1. **Callback duration meter** — ✅ *implemented (2026-07-07)*. The callback
   samples `getHighResolutionTicks()` at entry/exit
   (`AudioEngine::updatePerfMeters`); max duration and a decaying load
   average live in atomics and ship in every `getGraphState()` result as
   `perf.maxBlockUs` / `perf.avgLoadPct`.
2. **Overrun (xrun) detector** — ✅ *implemented*. Entry-to-entry gaps
   beyond 2 × block period (and < 0.5 s, to exclude stop/start idle) bump
   `perf.xruns`.
3. **Latency self-report** — ✅ *implemented*. `audioDeviceAboutToStart`
   logs device name, sample rate, block size, and reported input/output
   latencies, and caches sample rate/block size for the meters. If that log
   line shows zero latencies, driver-based compensation is a no-op —
   calibrate (§7).
4. **Loopback calibration** — ✅ *implemented as an in-app feature*, see §7.
5. **Perf regression harness:** a test target that builds a deep/wide graph
   (e.g. 4 stacks × 16 clips × 30 s) and times 1000 callback invocations —
   fails if the p99 block cost exceeds a budget (say 20 % of block duration).
   This is the same manual-callback pattern the unit tests already use, so
   it's deterministic and CI-safe. *(Not built yet.)*
6. **Static guardrails:** CI grep over `src/` for `Logger::writeToLog`,
   `makeCopyOf`, `setSize`, `std::function` construction, and `44100`
   literals inside the known audio-thread files; the list of allowed
   exceptions lives next to the check. Crude but catches the common
   regressions at review speed. *(Not built yet.)*

`juce::ScopedNoDenormals` now guards the callback (§4.4 done).

---

## 7. Empirical latency calibration (implemented 2026-07-07)

**The idea** (credit: user request): don't trust what the driver reports —
*measure* the machine. Record the playback of something we ourselves
emitted; the offset between "when we played it" and "when it came back in
the input" is the true round-trip latency of this exact device chain. That
empirical number then drives all session recording alignment.

**Implementation** (impulse variant of the record-the-playback idea — same
measurement, sharper onset than re-recording a clip):

1. `AudioEngine::startLatencyCalibration()` (bridge:
   `startLatencyCalibration`) preallocates a 2 s capture buffer on the
   message thread and arms the callback.
2. While capturing, the callback mirrors input channel 0 into the capture
   buffer and, 250 ms in (after establishing a noise floor), emits a
   128-sample decaying click into the outputs. Emission and capture share
   the same block timeline, so no clock bookkeeping is needed. Everything
   is preallocated and bounded — the calibration pass is itself RT-safe.
3. `getLatencyCalibration()` (message thread) runs onset detection when the
   window completes: noise floor from the lead-in, then the first
   post-click sample exceeding `max(4 × floor, 0.3 × peak)`. Its offset
   from the emission point **is** the round trip. Returns
   `{ phase, roundTripSamples, roundTripMs, calibrated }`; fails cleanly
   (`phase: "failed"`) when no loopback signal is detected.
4. **The measured value supersedes the driver.** In the callback:

   ```cpp
   measured >= 0 ? pc.input_latency = measured   // empirical round trip
                 : (reported input + output latencies as before)
   ```

   `ClipNode`'s `compensated_pos = master_pos − (input + output)` math is
   unchanged — it just gets a number that is now *true by construction*.

**How to run it:** the 🎯 *Calibrate Latency* button in the debug panel
(`ui/index.html`, wired in `app.js`). Route output to input first — a
patch cable is ideal; speakers→mic works too (add ~1 ms per 34 cm of air
between speaker and mic). Keep the room quiet for the 2 s window.

**State surfaces:** `getGraphState().perf` reports
`latencyCompensationSamples` (the effective value in use) and `calibrated`
(whether it's empirical or driver-reported).

**Tests:** `tests/latency_calibration_tests.cc` feeds engine output back to
engine input through a synthetic delay line of exactly 700 samples and
asserts the measurement returns 700 and becomes the effective compensation;
plus clean-failure (silent input) and perf-meter coverage.

**Known limitations / follow-ups:**

- ~~The measured value is not persisted~~ — ✅ implemented (2026-07-07,
  after a field session was found running uncalibrated): the value is
  stored in `<user app data>/Celestrian/calibration.json` keyed by
  `deviceName|sampleRate|bufferSize`, saved when calibration completes,
  and restored in `audioDeviceAboutToStart`. A key mismatch (different
  device/rate/block) **resets** to the driver-reported fallback rather
  than applying a stale measurement. Check the startup log line
  ("Calibration restored…" vs "No stored calibration…"), or
  `perf.calibrated` in a state dump.
- Acoustic calibration includes speaker→mic flight time, which inflates the
  number slightly relative to an electrical loopback. For our purposes
  (aligning what the mic heard to what the speakers played) that inflation
  is actually *correct* — it's the real path the user's audio takes.
- Calibration measures channel 0 only; per-channel offsets on exotic
  interfaces are out of scope.
- ~~Calibration corrects the *timestamps* only~~ — resolved: the
  arrival-time capture window (§3, implemented) consumes the calibrated
  value, so the measured round trip now moves the *audio*, not just the
  bookkeeping. The two features complete each other: calibration supplies
  the number, the ring-fed capture window applies it.

---

## 8. Suggested order of attack

1. ~~Instrumentation~~ ✅ done (§6.1–6.3).
2. ~~Loopback measurement~~ ✅ done — 139.1 ms measured on the reference
   setup via the 🎯 button.
3. ~~Pre-record ring + arrival-time capture~~ ✅ done (§3).
4. Device config: explicit buffer size + sane channel request (§4.1–4.2).
   With calibration + arrival-time capture in place this no longer affects
   recording *alignment* — only monitoring feel and visual responsiveness.
5. ~~Sample-rate capture, P0-5~~ ✅ done (§4.3).
6. ~~Persist the calibrated latency per device config~~ ✅ done (§7).
7. Segmented playback loop (§5.1) when/if the callback meter shows pressure,
   or before shipping larger sessions.
