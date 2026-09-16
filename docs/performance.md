# Celestrian Performance & Latency

> Status: **spec** — §1 (the audio-thread contract) is project law.
>
> This doc has three jobs:
>
> 1. Define the **audio-thread contract** so we never regress into glitch
>    territory.
> 2. Model **end-to-end latency**, and specify the arrival-time capture
>    and calibration that keep a recording aligned with what the
>    performer heard.
> 3. Keep a ranked backlog of **throughput work**, with the measurement
>    techniques that tell us what is real rather than imagined.
>
> **Section numbers are API.** `src/`, `tests/` and `ui/js/` cite
> `performance.md §1`, `§2.3`, `§3`, `§6.3` and `§7` from code comments.
> Renumber nothing without fixing the callers
> (`grep -rn 'performance.md §' src tests ui/js docs`).
>
> §8 records the designs that were tried and rejected.

**Contents**

1. [The audio-thread contract](#1-the-audio-thread-contract) · 2. [Latency model](#2-latency-model) · 3. [Arrival-time capture](#3-arrival-time-capture) · 4. [Device configuration](#4-device-configuration)
5. [Throughput backlog](#5-throughput-backlog-ranked) · 6. [Instrumentation & verification](#6-instrumentation--verification) · 7. [Latency calibration](#7-latency-calibration) · 8. [Appendix](#8-appendix--alternatives-considered-and-rejected)

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
*The stamp is taken AFTER the publish (audit D5-1, 2026-09-08):* a node
detached during an edit stays reachable through the OLD snapshot until
`publishGraph` exchanges it, so a detached graph node goes through
`retireNode()`, which PARKS it; `publishGraph` moves parked nodes into
the graveyard stamped with the post-exchange count, re-stamps every
pending item to that count (belt and braces), then retires the old
snapshot. Detached subtrees an inverse edit owns (Remove, Explode) are
not retired at all until their log entry is dropped.

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
*The effect chain* follows the same discipline — ONE atomic pointer
(`AudioNode::chain_`), message-thread swaps, superseded chains retired
through the reclaimer, audio thread loads at most once per call. *A
node's time-map* is different: an inline seqlocked value
(`AudioNode::storedMap` / `setMap` — all-atomic segment fields, like
the island facts), so a window edit is a value write with no heap and
no retirement. *The seqlock is stated once* (`src/seq_locked.h`,
`SeqLock`, audit D5-2, 2026-09-08): the map, the island triple and the
take table all use it. Writer: odd bump (relaxed), RELEASE fence,
payload stores, even bump (release). Reader: acquire load, payload
loads, ACQUIRE fence, relaxed re-load. Any other order admits a torn
read on ARM64 (x86 TSO hides it). Bounded retry (16); after the bound
the reader takes what it has, clamped — the writer is the message
thread, so the bound is never hit in practice (tests/seq_lock_tests.cc
hammers all three). A multi-segment lock-collapse SPLICES a new content
buffer in; the displaced buffer is owned by the undo entry (never freed
inline) and the un-splice retires the spliced one.
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
`getEffectiveQuantum`) survive only as message-thread helpers; the
audio thread has no fallback path — `process`/`control`/`render` assert
the snapshot and island facts, and node-level tests build a real
snapshot through `test_utils::contextFor`. The offline bounce
(bounce.md) builds its context with the same `renderContext` helper the
callback uses.

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

Known residuals: none on the audio thread. `getWaveform` reads content
only while a clip is Idle (the state machine's commit store is the
publication point); traversal is cast-free over the snapshot; the
message-thread `getIntrinsicDuration()` on stacks walks children per
call — cache if the perf meters ever care.

---

## 2. Latency model

Four independent chains matter. Numbers below assume 44.1 kHz; a block of
512 samples ≈ 11.6 ms, 256 ≈ 5.8 ms, 128 ≈ 2.9 ms.

### 2.1 Monitoring chain (instrument → ears)

**Software input monitoring (Q20, tasks.md B1).** OFF by default — most
interfaces monitor directly, so the engine never doubles the signal
unasked. Per clip (`ClipNode::setMonitoring`; the rail's "mon" chip):
`render` adds this block's arrivals from the pre-record ring (§3 — the
callback writes the ring BEFORE the graph renders, so index
`(input_clock + i) mod ring_len` for the clip's input channel(s) is
already this block) into the dry signal ahead of the gate and the rack,
so the input takes the clip's chain, gain and pan exactly like content.
Zero added latency: the monitored signal carries only the device round
trip — the calibrated figure (§7) shown beside the chip. Independent of
the recording state (a capturing clip renders no content, so nothing
doubles). A bounce carries no ring: monitoring never reaches a bounce
(tests/monitor_tests.cc).

Monitored or not, this chain defines the *reference* the user plays
against: they play in time with what they **hear** (playback delayed by
output latency), and their sound reaches us delayed by input latency.
That is exactly the model behind the compensation in `ClipNode::process`:

```text
compensated_pos = master_pos - (input_latency + output_latency)
```

This formula is right *if* the reported latencies are honest (see §4,
loopback calibration — consumer devices routinely under-report).

### 2.2 Record-start chain (button press → first captured sample)

```text
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

## 3. Arrival-time capture

Recording is aligned to what the performer **heard**, not to when the
record state flipped. This section is the law that makes I1 true on real
hardware; §8 records the framing that got it wrong first.

### The model (why arrival time is the right frame)

The user plays in time with what they **hear** (delayed by output latency);
their audio reaches the input delayed by input latency. So a note played on
the heard beat at musical time `B` **arrives at the input at `B + C`**,
where `C` is the full round trip (empirically measured by calibration, §7).

Capturing the live input block from the moment the record state flips
would therefore put the note meant for the beat at clip position `C`,
and every recording would play back **late by the round trip** — 139 ms
on the reference setup (§8).

### The mechanism: capture by arrival time, fed from a pre-record ring

Two pieces:

1. **Pre-record ring** (`AudioEngine::prerecord_ring_`): every input block
   is copied unconditionally into a preallocated ring (8 ch × 2 s), indexed
   by a **monotonic input clock** (`input_clock_` — total samples since
   engine start; unlike `master_pos` it never wraps or resets). Two bounded
   memcpys per channel per block; RT-safe. The ring and clock travel to
   nodes via `ProcessContext`.
2. **Arrival-time capture window** (`ClipNode`): when recording starts, the
   clip computes the input-clock position of its first sample:

   ```text
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

### Confirmation

Reported latencies are logged at every device start, and loopback
measurement is the 🎯 calibration feature (§7). The one step that stays
human: **record a sharp transient against an existing clip's beat and
confirm it plays back on the beat.** That is the end-to-end validation
of calibration + arrival-time capture on real hardware, and no test
replaces it.

---

## 4. Device configuration

`AudioEngine::init` restores the last chosen device before falling back to
the OS default:

```cpp
device_manager.initialise(kPreRecordRingChannels, outputs, saved.get(), true);
enableAllInputChannels();
```

### Why the default device is the wrong answer on Windows

Field report (2026-07-25, Windows music machine): a MOTU interface showed
only "input 1" and "input 2". Three compounding causes, all fixed:

1. **`initialiseWithDefaultDevices` opens the OS default endpoint**, which
   on Windows is a 2-channel WASAPI device — never the user's interface.
2. **A multi-channel interface's WDM driver splits the box into stereo
   endpoints.** The MOTU publishes `MOTU Analog 1-2`, `Analog 3-4`,
   `Analog 5-6`, `Analog 7-8`, `Mic/Instrument 1-2`, `ADAT 1-2…7-8`,
   `S/PDIF 1-2` as *separate* capture devices, and Windows opens one at a
   time. On WASAPI there is therefore **no device that yields 8 inputs** —
   picking a better device cannot fix this. Only the ASIO driver type
   presents the interface whole (measured: 22 of 22 channels).
3. **Channel masks default to the requested count.** The callback's
   `input_channel_data` is indexed by *active* channel, so a channel the
   setup left inactive is not addressable at all. `enableAllInputChannels`
   turns on every channel the open device exposes, and `getInputList`
   reports active channels in active order so the index the UI sends *is*
   the callback index.

Consequences elsewhere: `kPreRecordRingChannels` went 8 → 32, because a
channel the pre-record ring cannot reach is a channel that cannot be armed
(the reference MOTU alone is 22 in). The per-block copy is still bounded by
the device's actual channel count, not the cap.

### ASIO in the build

Steinberg dual-licensed the ASIO SDK (proprietary **or** GPLv3). This
project is AGPLv3; GPLv3 §13 and AGPLv3 §13 grant mutual permission to
combine, so an ASIO-enabled binary is distributable under AGPLv3. CMake
fetches the SDK via CPM pinned to an immutable commit; override with
`-DCELESTRIAN_ASIO_SDK_DIR=<unzipped official SDK>`. Without either the
app still builds — ASIO simply does not appear as a driver type, and the
picker says so. JUCE compiles exactly one SDK header (`<iasiodrv.h>`,
closure `{iasiodrv.h, asiosys.h, asio.h}`); the SDK's Microsoft-copyright
driver-side files are never compiled.

### Persistence

The whole setup (type, device, rate, buffer, channel masks) round-trips
through `AudioDeviceManager::createStateXml` / `initialise` into
`<app data>/Celestrian/audio_device.xml` — the same format JUCE's own
selector writes, so nothing here knows the field layout. A stored device
that fails to open (interface unplugged) falls back to the default *and
keeps the file*, so plugging the box back in restores the choice.

Buffer size is now user-selectable in the picker (Audio button, status
strip) rather than "whatever the OS defaults to". For a live looper
128–256 is the right target; every block halved removes ~5.8 ms from §2.2
and from the monitoring reference error. Note that calibration is keyed on
`device|rate|buffer`, so changing any of them correctly invalidates it.

Remaining:

1. ~~Sample rate is assumed 44100 everywhere~~ — ✅ *P0-5 implemented
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
ordered by (impact × likelihood we hit them as graphs grow). Ranked
against the kernel-era engine (re-ranked 2026-09-15; the retired items
are in §8). Nothing here moves before the callback meter (§6.1) shows
pressure or a session is large enough to feel the message-thread items
— and with plugins in the chain, the VST3 slots dominate the callback
regardless.

1. **The per-sample copy inside a content run** (`ClipNode::render`, the
   lambda under `timing::forEachContentRun`). The run splitter already
   cuts a block at every map seam, comp cell, shot end and rest, so each
   run is one contiguous read of one buffer — but the read itself is
   still `scratch[i + k] = src[(base + p0 + k) % cap]` per sample: an
   int64 modulo (the slowest integer op on either CPU) and a scalar store,
   `num_samples × channels` times per playing clip per block. Split the
   run once more at the source buffer's end — the same two-piece read the
   pre-record ring already does in `addMonitorInput` — and each piece is a
   `FloatVectorOperations::copy`. The only per-sample audio-thread work
   left in the engine, and it scales with clip count; mechanical to
   golden-test against the current loop (the ramp method of
   `tests/content_frame_tests.cc` needs no constants). `renderMidi` has
   no equivalent: it reads events by `lowerBound`, not per sample.
2. **`getGraphState` cost per poll**: `tick()`, then a full `juce::var`
   tree — every node's `getMetadata`, its fx chain's slot metadata and,
   per open effects panel, a 24-bin Goertzel over a 2048-sample ring —
   JSON-serialized across the bridge every `POLL_MS` (50 ms), O(nodes)
   allocations on the message thread. Fine below ~100 nodes; the first
   item a large session feels, as UI jank rather than audio. The endgame
   (refactoring_proposal.md P0-2/P2-10) is a POD state snapshot + delta
   updates; don't invest in intermediate optimizations here.
3. **Per-block period walks over the snapshot** (`snapEffectivePeriod`
   from `StackNode::process`, once per stack per block — twice for a
   one-shot stack; `snapEffectiveCycle` once per callback):
   `period_law` recursion over the packed child spans, allocation- and
   cast-free, O(subtree) per stack so O(depth × nodes) per block of
   integer lcm. Q is stored and the snapshot is immutable, so the
   remaining move is caching `ownPeriod` / `contribution` per entry at
   `buildGraphSnapshot` time (message thread; nothing to invalidate).
   Worth it only for deep, wide graphs; the meter will say.
4. **Waveform peaks on commit** (`ClipNode::getWaveform` → `audioPeaks`):
   an O(take samples) scan on the message thread, once per commit or
   take switch (`fetchWaveform` guards it). The in-progress picture no
   longer needs it — `ui/js/live_peaks.js` builds it from the polled
   `currentPeak`, time-indexed — so what remains is the commit scan of a
   long take stalling the message thread (a UI hitch, never audio).
   Incremental peak buckets during capture (the audio thread appends one
   max per N samples into a preallocated array) would remove it; only
   when takes get long enough to notice.
5. **Stack summing** clears `mix_buffer` and adds it per child (plus
   `fx_accum_` when the stack's own chain is live); a single-child stack
   could pass through. Micro; only bother if profiling says so.

JS-side rendering cost (per-frame ghost rebuild, `getBoundingClientRect`
per clip, per-frame logging) is covered by refactoring_proposal.md P2-10 and
not duplicated here.

---

## 6. Instrumentation & verification

What we can't measure we will regress. Cheap, permanent instrumentation —
numbered because code comments cite these subsections.

### 6.1 Callback duration meter

The callback samples `getHighResolutionTicks()` at entry and exit
(`AudioEngine::updatePerfMeters`); max duration and a decaying load
average live in atomics and ship in every `getGraphState()` result as
`perf.maxBlockUs` / `perf.avgLoadPct`.

### 6.2 Overrun (xrun) detector

Entry-to-entry gaps beyond 2 × the block period — and under 0.5 s, to
exclude stop/start idle — bump `perf.xruns`.

### 6.3 Latency self-report

`audioDeviceAboutToStart` logs device name, sample rate, block size, and
the reported input/output latencies, and caches sample rate and block
size for the meters. **If that log line shows zero latencies,
driver-based compensation is a no-op — calibrate (§7).**

### 6.4 Loopback calibration

An in-app feature; see §7.

### 6.5 Perf regression harness — *not built*

A test target that builds a deep/wide graph (e.g. 4 stacks × 16 clips ×
30 s) and times 1000 callback invocations, failing if the p99 block cost
exceeds a budget (say 20% of block duration). The same manual-callback
pattern the unit tests already use, so it would be deterministic and
CI-safe.

### 6.6 Static guardrails — *not built*

A CI grep over `src/` for `Logger::writeToLog`, `makeCopyOf`, `setSize`,
`std::function` construction, and `44100` literals inside the known
audio-thread files, with the allowed-exception list living next to the
check. Crude, but it catches the common regressions at review speed.

`juce::ScopedNoDenormals` now guards the callback (§4.4 done).

---

## 7. Latency calibration

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

## 8. Appendix — alternatives considered and rejected

Kept so they are not re-proposed.

**"Back-fill the first C samples from a ring."** The first framing of the
record-latency fix: keep capturing from the state flip, then patch the
head of the clip with `C` samples of history. **Rejected — the sign of
the error was backwards** for the play-along case. A note played on the
heard beat *arrives late*, so the clip does not need earlier audio
prepended; it needs its whole capture window shifted into arrival time.
The measured 139 ms round trip on real hardware made the direction
unambiguous. §3 is the corrected model, and the implementation follows
it.

**Capturing the live input block from the record-state flip.** The
original behaviour. Clip position 0 held the audio that *arrived* at the
boundary — which the musician played `C` earlier — so every recording
played back late by the full round trip. That was the reported symptom,
not a tuning problem. **Replaced** by the pre-record ring plus the
arrival-time capture window (§3).

**Guessing the round trip from driver-reported latencies alone.**
Reported figures are a starting point and are logged at every device
start, but they do not account for the whole chain. **Replaced** by
empirical loopback measurement (§7); the driver numbers survive only as
the fallback when calibration has not run.

**Live-block metering during record.** Peak meters read the captured
(windowed) region, so the record meter lags by `C`. This is a
consequence of §3, accepted deliberately rather than worked around; live
input metering would be a separate signal path if the lag ever feels
wrong.

**Plugin delay compensation by delaying everyone else.** Out of scope
here and ruled on in vst3.md (Q-V2): in a cyclic kernel, plugin latency
delays a loop's content *within its cycle*, so classic PDC fights the
island clock. Latency *reporting* stays because it is near-free.

**Retired throughput items (the pre-kernel §5 list).** *Quantum/LCM
re-derivation per block* — `calculateTimelineLength` and the per-block
`getEffectiveQuantum` walks are gone: Q is stored on the island root
and the audio thread reads periods off the immutable snapshot
(`graph_snapshot.h`); what is left is §5 item 3. *`dynamic_cast` per
block* — none remain on the audio thread: children are packed index
spans and dispatch is `forEachChild` / `getNodeType`; every remaining
cast is message-thread code (edit log, take service, map edits, verbs,
island geometry, import, session I/O). *The segmented playback loop* —
landed as `timing::forEachContentRun`; only the per-run copy survives,
as §5 item 1.

### What landed when

Instrumentation (§6), loopback measurement (§7 — 139.1 ms on the
reference setup), the pre-record ring and arrival-time capture (§3),
sample-rate capture, and per-device-config persistence of the calibrated
latency are all in code. What remains from the original plan: explicit
buffer-size and channel-request configuration (§4), which no longer
affects recording *alignment* — only monitoring feel and visual
responsiveness — and the per-run copy (§5 item 1), to be picked up
when the callback meter shows pressure or before shipping larger
sessions.
