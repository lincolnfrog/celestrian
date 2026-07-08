# Celestrian Performance & Latency

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
from `process`, `calculateTimelineLength`, `isAnyNodeRecording`) must obey:

| Rule | Why | Enforced by (today) |
|---|---|---|
| No locks (mutex, recursive_mutex) | Priority inversion with the message thread → dropouts | Child lists are immutable snapshots published by atomic swap (`StackNode::renderChildren`); the old `children_mutex` is deleted |
| No heap allocation/free | malloc can take a lock or syscall | `ProcessContext` is POD; `mix_buffer` preallocated (8192 frames); LCM helper is a free function, not `std::function`; deferred frees go through `AudioEngine::retire()` |
| No file I/O / logging | `juce::Logger` writes files | `src/rt_log.h` fixed-slot ring; drained on the message thread in `getGraphState()` |
| No buffer copies proportional to clip length | A 30 s clip copy is milliseconds of stall | Commit rotation is virtual: `rotation_offset_`/`rotation_span_` remapped in read-index math, samples never move |
| No unbounded waits | — | The one remaining lock-ish thing is the RtLog `SpinLock`, held for a ≤160-byte memcpy, with try-lock (drops the message on contention) |
| No device queries per block | Driver calls can block | Latencies cached in `audioDeviceAboutToStart` |
| Iterate child snapshots with **one** load | Paired `getNumChildren()`/`getChild(i)` calls can straddle a republish | Use `getChildrenSnapshot()` in anything audio-thread-reachable |

**Object lifetime rule:** anything removed from the graph while audio runs is
freed via `AudioEngine::retire()` — the deleter runs only after the callback
counter has advanced two callbacks past retirement. Never `delete` a node or
snapshot directly from a mutation path; `StackNode::retireOrDelete` handles
the no-reclaimer (unit test) case.

**PR checklist for anything touching the process path:**

- [ ] No `new`/`delete`/`setSize`/`makeCopyOf`/`juce::String`/`juce::var`
      construction on the audio thread (grep the diff).
- [ ] No `juce::Logger` — use `RtLog::instance().post(...)`.
- [ ] Child iteration uses `getChildrenSnapshot()`.
- [ ] Cross-thread fields are `std::atomic` (see `AudioNode::parent`).
- [ ] Destruction of graph objects goes through `retire()`.

Known residual violations (tracked in refactoring_proposal.md):

- `ClipNode::getWaveform()` reads the recording buffer on the message thread
  while the audio thread writes it. Benign-ish (aligned float reads), fix
  belongs with the state-snapshot work (P3 note).
- ~22 `dynamic_cast`s per block (P1-8: replace with virtual dispatch /
  `forEachChild`).
- `getEffectiveQuantum()` walks and re-derives min-duration per call, per
  node, per block (P0-3 makes quantum stored state).

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

## 3. The record latency issue

### What actually happens on record

1. `startRecordingInNode` (message thread) sets `is_pending_start`.
2. The next callback's `ClipNode::process` computes `compensated_pos` and
   either starts capture **at the top of that block** or arms
   `awaiting_start_at` for a Q boundary.
3. Capture writes input from that moment forward. The compensation is
   applied to the clip's **timestamps** (trigger position → anchor/launch
   point), not to its **contents**.

### The defect

Latency compensation back-dates *when we say the recording started*, but the
samples from that back-dated window were never stored. Two consequences:

- **Attack clipping:** the first `input_latency + output_latency` samples of
  the phrase (typically 10–30 ms — audible on any transient) are missing
  from the clip.
- **Button-press truncation:** if the user's phrase begins before their
  finger confirms it (universal for musicians — you hit record *as* you
  play, not before), the pre-click audio is gone too, plus the average
  ½-block scheduling delay from §2.2.

The Q-boundary path partially hides this — when capture waits for the next
boundary the buffer *is* aligned at that boundary — but the first-clip path
and any boundary crossed mid-block (`awaiting_start_at` fires mid-callback
but capture starts at the block top) exhibit it.

### The fix: an always-on pre-record ring

Standard looper technique:

1. `AudioEngine` owns a preallocated input ring (e.g. 2 s × input channels,
   ~350 KB at 44.1 kHz mono), written unconditionally at the top of every
   callback — audio thread, sequential writes, no allocation, RT-safe.
2. When capture actually starts at master position `P` with intended start
   `P - C` (compensation `C`, plus mid-block boundary offset), copy the last
   `C` samples out of the ring into the front of the clip buffer.
3. That copy is proportional to `C` (a few thousand samples, not a clip
   length) — acceptable in-callback, or done as the first act of capture.

This turns the compensation math we already have into *recovered audio*
instead of a bookkeeping shift. It also fixes mid-block Q-boundary starts
exactly: back-fill from the ring for the `boundary → block-top` gap.

### Confirm before building (an afternoon, in order)

1. **Log the reported latencies** at device start (`audioDeviceAboutToStart`
   already has the device): block size, input latency, output latency. If
   these are zeros on your interface, compensation is currently a no-op and
   the whole delay is uncompensated — instant confirmation.
2. **Loopback test:** cable output→input (or speaker→mic), play a click from
   a clip, record it into a new clip, diff the transient position against
   the grid in samples. That number = true end-to-end error; compare with
   what the compensation math predicts.
3. **Human test:** record a sharp transient (rim click) against the
   metronome of an existing 1Q clip; inspect where the transient landed in
   the committed buffer.

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
3. **Sample rate is assumed 44100 everywhere** (`pc.sample_rate`, clip
   buffer sizing, `calculateTimelineLength` fallback, mock's Q). On a 48 k
   interface all seconds-based reasoning and the latency numbers above are
   ~9 % off. This is refactoring_proposal.md §P0-5: capture the device rate
   in `audioDeviceAboutToStart`, thread it through `ProcessContext`, treat a
   `44100` literal as a lint failure.
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

- The measured value is **not persisted** — it lives for the engine's
  lifetime. Follow-up: store per-device (device name + sample rate + buffer
  size key) and reload on `audioDeviceAboutToStart`; invalidate when the
  device config changes.
- Acoustic calibration includes speaker→mic flight time, which inflates the
  number slightly relative to an electrical loopback. For our purposes
  (aligning what the mic heard to what the speakers played) that inflation
  is actually *correct* — it's the real path the user's audio takes.
- Calibration measures channel 0 only; per-channel offsets on exotic
  interfaces are out of scope.
- Calibration corrects the *timestamps*. The first `latency` samples of
  audio are still physically lost until the pre-record ring (§3) exists —
  these two features complete each other: the ring recovers the audio, the
  calibration tells it exactly how much to recover.

---

## 8. Suggested order of attack

1. ~~Instrumentation~~ ✅ done (§6.1–6.3).
2. ~~Loopback measurement~~ ✅ done — run the 🎯 button on real hardware to
   get your machine's number.
3. Pre-record ring buffer (§3) — the actual record-latency fix; sized by
   the calibrated number from §7.
4. Device config: explicit buffer size + sane channel request (§4.1–4.2).
5. Sample-rate capture, P0-5 (§4.3) — prerequisite for trusting any of the
   above on non-44.1 k hardware.
6. Segmented playback loop (§5.1) when/if the callback meter shows pressure,
   or before shipping larger sessions.
