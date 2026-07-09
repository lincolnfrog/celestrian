# Celestrian Refactoring Proposal

> Generated 2026-07-07 from a full review of `docs/`, `src/`, `ui/js/`, `ui/e2e/`, and `tests/`.
> Focus: robustness, maintainability, extensibility of the core system. Ordered by leverage —
> the items at the top are the ones most likely responsible for the "persistent bugs."

---

## Executive Summary

The codebase is in better shape than "messy" — the recent modularization of `app.js`, the
`reorderNode` API cleanup, and the mock backend were all steps in the right direction. But there
are four structural problems that act as bug factories, and most of the known flaky behavior
(cursor jumps, loop alternation, ghost lag, waveform vibration) traces back to them:

1. **Timing semantics live in three places** (C++ engine, JS UI math, JS mock backend) with no
   contract keeping them in sync.
2. **The audio thread is not real-time safe** (locks, allocation, logging, buffer copies inside
   the device callback), which produces exactly the kind of nondeterministic glitches that are
   impossible to reproduce in tests.
3. **The Quantum is derived, not stored** — `getEffectiveQuantum()` returns the *minimum child
   duration*, so Q can silently change after the fact, invalidating every position/width
   calculation downstream.
4. **Transport/recording state is a tangle of boolean flags and special cases** inside the audio
   callback rather than an explicit, testable state machine.

Everything else (layering violations, frontend structure, hygiene) is listed after these, with a
suggested sequencing at the end.

---

## P0 — Correctness: the bug factories

### 1. One source of truth for timing semantics

> **Status: ✅ Implemented (2026-07-07).** `ui/js/protocol.js` + contract test
> (`protocol_contract.test.mjs`), `src/timing.h` ↔ `ui/js/timeline_model.js`
> pinned by `shared/timing_golden.json` (tests on both sides),
> `combineNodes` added to the C++ engine, mock backend now delegates its
> timing math to the timeline model.

**Problem.** The LCM/quantum/anchor/launch-point model is independently implemented in:

- C++: `audio_engine.cc` (`calculateTimelineLength`, snap logic), `clip_node.cc` (anchor/launch/rotation math)
- JS UI: `ghost_renderer.js`, `clip_updater.js`, `app.js` (stack LCM, playhead %, ghost tiling)
- JS mock: `mock_backend.js` (its own snap logic with hardcoded `Q = 44100`, its own
  first-clip-reset, its own `internalTransport` simulation)

Drift is already observable:

- `combineNodes` exists in the mock and is called by `drag_drop.js`, but there is **no C++
  binding** in `main_component.cc` — drag-to-combine silently does nothing in production.
- The mock's `internalTransport` is "masterPos % loopLen" while the C++ version is a stateful
  counter that resets on collapse — tests pass against one behavior, users see the other.
- The mock's duration snap (`snapDiff < 1000`) doesn't match the C++ hysteresis/subdivision logic.

**Proposal.**

- Define the bridge protocol in exactly one place: a `protocol` list (method name, arg types,
  semantics) that generates/validates both the `main_component.cc` binding table and the mock's
  dispatch switch. A trivial contract test then fails the build when the two diverge
  (`combineNodes` would have been caught immediately).
- Extract all *derivable* timing math (LCM, playhead %, ghost tile positions, anchor→slot,
  launch-point formula) into **one pure JS module** (`timeline_model.js`) used by both the UI
  renderer and the mock. The mock should contain *state + protocol*, not math.
- Encode the worked examples in `docs/recording.md` (1Q+4Q, 1Q+4Q+3Q, mid-loop 8Q@2Q, etc.) as
  **shared golden test vectors** (a JSON file of scenario → expected anchors/launch points/LCM/
  snap results) consumed by both the C++ unit tests and the JS unit tests. This makes the design
  doc executable and keeps the three worlds pinned to it.

### 2. Make the audio thread real-time safe

> **Status: ✅ Implemented (2026-07-07).** The audio callback no longer locks,
> allocates, logs, or copies buffers:
>
> - **Virtual rotation** — `commitRecording()` stores a `rotation_offset`/span
>   applied in the read-index math (playback + `getWaveform`); the multi-second
>   `makeCopyOf` + physical rotation is gone. Covered by a new
>   "Virtual Rotation" unit test.
> - **Lock-free traversal** — `StackNode` publishes an immutable child-pointer
>   snapshot (atomic swap on every mutation); `process()` and all
>   audio-thread iteration read one snapshot per loop. The `recursive_mutex`
>   is deleted. *Deviation from the proposal:* mutations stay synchronous on
>   the message thread (copy-on-write publish + epoch-based deferred free in
>   the engine's `retire()` graveyard) instead of a command FIFO — same
>   safety, but `createNode → getGraphState` stays synchronous for the
>   bindings and tests.
> - **No logging on the audio thread** — `src/rt_log.h` fixed-slot ring,
>   drained by the message thread in `getGraphState()`.
> - **No per-block allocation** — `ProcessContext` is POD (solo is a resolved
>   `AudioNode*`, not a `juce::String`), `mix_buffer` preallocated, the LCM
>   helper is a free function (no `std::function`), device latencies cached in
>   `audioDeviceAboutToStart`.
> - `AudioNode::parent` is atomic (audio thread walks parent chains during
>   reorders).
>
> Still open (folded into later items): `getWaveform()` reads the clip buffer
> while recording writes it (P3 note), `dynamic_cast`s per block (P1-8), and
> the derived-quantum walk (P0-3).

**Problem.** `audioDeviceIOCallbackWithContext` → `StackNode::process` → `ClipNode::process`
currently does, on the audio thread:

- Takes a `std::recursive_mutex` per stack per block (`stack_node.cc:110`) — priority inversion
  with the message thread, which holds the same lock during `getMetadata()`/`getWaveform()` on
  every 50 ms UI poll.
- Allocates: `mix_buffer.setSize` on channel-count/block-size change, `ProcessContext` copies a
  `juce::String` (`solo_node_uuid`) per node per block, `juce::var` construction, and worst of
  all `commitRecording()` performs `temp.makeCopyOf(buffer)` — a **multi-second heap allocation
  and full-buffer rotation inside the device callback** (commit fires from `process()` when the
  awaited stop boundary is crossed).
- Logs: `juce::Logger::writeToLog` in `process()`/commit paths (file I/O on the audio thread).
- `dynamic_cast`s per block (22 across `src/`).

These are the classic causes of intermittent glitches and heisenbugs.

**Proposal.**

- Graph mutations (create/reorder/remove, loop-point changes) go through a lock-free command
  FIFO (`juce::AbstractFifo`) drained at the top of the callback; the audio thread becomes the
  single writer of graph structure, and the children vector needs no mutex in `process()`.
- Snapshot state *out* for the UI: the audio thread publishes a POD state block (positions,
  peaks, flags) via atomics/double-buffer; `getGraphState()` reads the snapshot instead of
  walking the live graph under a lock.
- Move commit finalization (hysteresis snap decision can stay; buffer **rotation** cannot) to a
  background thread: audio thread flips the clip to "committed pending finalize" and posts a
  job; playback can compensate with a read-offset until the rotation lands — or better, drop
  physical rotation entirely and keep it virtual (a stored `rotation_offset` applied in the read
  index math). The rotation is pure index arithmetic; there is no need to move samples at all.
- Replace `solo_node_uuid` string compares with a resolved node pointer/int id in the context.
- No `Logger` calls in `process()`; use a lock-free debug ring buffer if needed.
- Preallocate `mix_buffer` for max block size in `audioDeviceAboutToStart` (currently empty).

### 3. Store the Quantum explicitly

> **Status: ✅ Implemented (2026-07-07)** as kernel.md migration step 1.
> `StackNode` stores `quantum_samples_` + `epoch_samples_` at the island
> root, set once at first commit; `getEffectiveQuantum` walks up to the
> nearest set value. Q survives its creator (owner ruling,
> design_language.md Q1). `getIntrinsicDuration()` split resolved:
> stacks now return composite duration (LCM of children) as the docs
> specify; the quantum is never derived from durations.

**Problem.** `StackNode::getEffectiveQuantum()` returns `getIntrinsicDuration()` = **min of all
child durations**. The docs say "the first recorded clip establishes Q, fixed forever." These are
not the same thing:

- Record clip 1 = 4 s → Q = 4 s. Record a short overdub that snaps to a Q/2 subdivision
  (`stopRecording` allows Q/2, Q/4, Q/8) → min duration is now 2 s → **Q retroactively halves**,
  and every width, slot, ghost, and grid mark in the UI doubles. This is precisely the
  "vibrating/drifting waveform" class of bug documented in `implementation.md` §7.
- It also makes `StackNode::getIntrinsicDuration()` disagree with the documented composite
  duration for nested stacks (docs: **LCM of children**; code: **min of children**).

**Proposal.**

- Add explicit state: `quantum_samples` on `StackNode` (or a future Island object), set once when
  the first clip in that scope commits, cleared only when the scope empties. `getEffectiveQuantum`
  walks up to the nearest set value — no derivation from child durations.
- Split the two meanings of `getIntrinsicDuration()`: `getQuantum()` (grid unit) vs
  `getCompositeDuration()` (LCM of children, used for parent LCM and collapsed playback). Right
  now one function serves both, incorrectly for both.

### 4. Extract the transport into a testable state machine

> **Status: ✅ Dissolved rather than built (2026-07-07)** — see kernel.md
> §3. With per-clip stored origins (kernel step 2) and a monotonic
> master clock (step 3), the ~120-line branch pile this item wanted to
> tame was *deleted*: no LCM wrap, no LCM-growth snap, no polyrhythm
> suppression, no first-clip snap, no `lcm_before_recording_` /
> `last_recording_duration_` reconstruction. The UI's wrapped masterPos
> is a derived view in `getGraphState`. The per-clip recording
> lifecycle (Idle → Armed → Capturing → PendingStop → Committed) still
> exists implicitly in `ClipNode` flags and would still benefit from an
> explicit little state machine — but it is now per-clip, over an
> immutable clock, and no longer the highest-churn code in the engine.

**Problem.** The LCM-wrap / snap-on-commit logic lives inline in
`audioDeviceIOCallbackWithContext` (~120 lines) coordinated through member flags
(`was_any_node_recording_`, `lcm_before_recording_`, `last_recording_duration_`), with three
special-cased branches (LCM grew, polyrhythmic expansion, first clip) and an early `return` that
skips the normal wrap. This is the highest-churn, hardest-to-test code in the engine, and every
recording bug fix has added another branch.

**Proposal.**

- Extract a `Transport` class with a pure step function:
  `TransportState advance(TransportState, BlockInfo, GraphSummary)` where `GraphSummary` is
  `{lcm, is_recording, committed_event}`. No JUCE types, no engine access — trivially
  unit-testable against the scenario tables in `recording.md` (which currently have **no**
  corresponding C++ tests; `tasks.md` Tier 1 already flags this).
- Model recording lifecycle explicitly: `Idle → PendingStart(boundary) → Recording →
  PendingStop(boundary) → Committed{duration, lcm_before}`. The commit event carries what the
  transport needs, eliminating the "recompute what just happened" logic (e.g. the current
  `last_recording_duration_ = old_pos % lcm_before` guess).

### 5. Stop hardcoding the sample rate

> **Status: ✅ Implemented (2026-07-07).** The device rate is captured in
> `audioDeviceAboutToStart` (was already cached for the perf meters) and now
> feeds `ProcessContext.sample_rate`, clip creation (buffer sizing +
> metadata `sampleRate`), the `calculateTimelineLength` fallback, and all
> samples→ms displays (`perf.sampleRate` → UI). Field-motivated: the
> reference interface turned out to run at 48 kHz, caught by two ms
> displays disagreeing about the same calibration. Remaining 44100s are
> deliberate device-less test defaults (commented as such); the mock
> simulates a 44.1 kHz device by design. Mid-session rate *changes* are not
> resampled — clips keep the rate they were recorded at.

`pc.sample_rate = 44100.0` in the callback, `ClipNode` buffer sized `sample_rate * 60` from a
constructor default, `calculateTimelineLength()` fallback `44100`, and the mock's `Q = 44100`.
On a 48 kHz or 96 kHz interface every duration/Q calculation is wrong. Capture the device rate in
`audioDeviceAboutToStart()` and thread it through `ProcessContext`; treat 44100 literals as a
lint failure.

---

## P1 — Layering: where the architecture leaks

### 6. `ClipNode::process()` is a god function with upward coupling

~300 lines mixing four responsibilities: PLL start scheduling, **visual x-position calculation in
pixels** (`base_width = 200.0` in C++!), recording capture, and playback. To do it, a *leaf* node
reaches up into `parent`, `dynamic_cast`s it to `StackNode`, and iterates its siblings (twice) to
find the context loop — a child depending on its container's internals. The stream-of-consciousness
comments in `commitRecording()` ("Wait... So we just need...") are the tell that this math has
never been isolated enough to reason about.

**Proposal.**

- The engine (or parent stack) computes the recording context — `{context_loop,
  context_launch_point, quantum}` — once per block and passes it **down** via `ProcessContext`.
  Leaves never inspect siblings.
- Extract the phase math (next-boundary, anchor, launch point, rotation offset) into pure free
  functions in a `timing.h` with exhaustive unit tests fed by the shared golden vectors from P0-1.
  `ClipNode::process` shrinks to: schedule-check, capture, playback.

### 7. Resolve the UI-state contradiction: pixels out of the engine

`docs/design.md` says "UI = Data" while `docs/ui.md` says pixels are a frontend responsibility —
and the code follows both halfway: `AudioNode` carries `x_pos/y_pos/width/height` in pixels,
`ClipNode` computes `x_pos = slot * 200.0`, yet `ui.md` proudly lists the pixel-API removal as
done. Pick one rule (ui.md's is the right one):

- Engine state is **samples and structure**: `anchor_phase_samples`, child order, `is_expanded`,
  and (for freeform top-level stacks) a persisted position that the engine treats as an opaque
  blob.
- JS derives x from data: `x = (anchor / Q) * baseWidth` — one line in `timeline_model.js`,
  already how ghosts are positioned. This deletes the slot/pixel code from `clip_node.cc`
  entirely and removes the duplicated `200`/`VISUAL_OFFSET`/`46px stack padding`/`38px header`
  constants that currently couple C++ to CSS.

### 8. Shrink the `AudioNode` base class

Everything is a public `std::atomic` member mutated from anywhere (engine, clip, stack, bindings).
Make loop points, mute, anchor, etc. private with accessors; move UI-only state per item 7. Add a
virtual `forEachChild(fn)` / `getChildren()` so `findNodeByUuid`, `isAnyChildRecording`, and
`calculateTimelineLength` stop `dynamic_cast`ing — most of the 22 casts disappear.

---

## P2 — Frontend structure

### 9. A single backend facade

`app.js` selects mock vs bridge at load time — but `drag_drop.js` and `canvas_renderer.js`
statically `import { callNative } from './bridge.js'`. Consequences:

- In mock/Playwright mode, drag-drop's `setNodePosition`/`reorderNode`/`combineNodes` go to the
  **absent JUCE bridge** and silently resolve `null`. The e2e drag tests exercise a different
  persistence path than production (drops "work" only because the mock's `window.celestrian`
  harness patches state separately — or not at all).
- `bridge.log()` fires a `nativeLog` native call for every log line.

Create `ui/js/backend.js` as the only module that knows about mock vs bridge; everything imports
`{ callNative, log, getState }` from it. Delete the ad-hoc selection block at the top of `app.js`
and the `window.*` global re-exports (expose one `window.__celestrianTest` namespace for
Playwright instead).

### 10. Derive a view model, then patch the DOM

The per-frame pipeline currently smears math across `syncUI` (stack LCM, header playhead),
`clip_updater.js` (widths, dual-mode peaks, one-shot detection), `ghost_renderer.js` (its own LCM
+ tiling + `getBoundingClientRect` per clip per frame), and `stack_element.js` (loop-handle
snapping). Restructure the poll loop as:

```
state (backend) → deriveViewModel(state)  [pure, unit-testable, uses timeline_model.js]
                → patchDOM(viewModel)     [thin, keyed, no math]
```

Payoffs: most of the slow Playwright specs (`ghost_positioning`, `cursor_bugs`,
`stack_loop_region_bug`, …) become millisecond-fast view-model unit tests; the
ghost/cursor "abstraction mismatch" bug class (recording.md §Known Bugs) is structurally
prevented because ghost extent and cursor position come from the same derivation.

Concrete sub-items:

- **True recursion.** `syncUI` hand-unrolls nesting: it renders stack → children, and nested
  stack → clip children only. A depth-3 stack's contents silently don't render. Replace with the
  `renderNode(node, container)` recursion already sketched in `stacks.md`.
- **Ghosts in local coordinates.** Render ghosts inside a relatively-positioned per-stack layer
  so the `stack.x + 46 + VISUAL_OFFSET` global math and the per-frame `getBoundingClientRect`
  disappear; reconcile keyed ghost elements instead of destroy-and-recreate every 50 ms.
- **Kill per-frame logging.** `clip_updater` logs `[DragInit]` per clip per frame,
  `ghost_renderer` logs 3+ lines per frame, `syncUI` logs per stack — each one a native call via
  `bridge.log`. Gate behind `DEBUG` flag.
- **One playhead computation.** Clips use the backend's `playhead` field; stack headers compute
  their own in JS from `masterPos`/`internalTransport` (still marked `// DEBUG`). After P0-1,
  both come from `timeline_model.js`.

### 11. Mock backend: state + protocol only

- Move its snap/LCM/first-clip logic onto `timeline_model.js` (P0-1) so it can't drift.
- `getState()` mutating state via `advanceTransport()` makes reads non-idempotent and
  poll-rate-dependent; advance on an explicit timer or only via `advanceBy()`.
- Scenario definitions are 500 of its 1000 lines — move to a `scenarios.js` (or JSON) file.

---

## P3 — Hygiene (quick wins, any time)

- **Dead code:** the 40-line commented "OLD STACK BUTTON LOGIC" block in `syncUI`; unused imports
  in `app.js` (`groupNodesByVisualX`, `calculateButtonPosition`, `gcd`, and `calculateStackLCM` —
  the last is doubly notable because `syncUI` re-implements the same stack-LCM loop inline at
  lines 254–261 instead of calling it); duplicate `y: 0` key in the mock's `nested-stacks`
  scenario.
- **Stale docs:** `test_harness.md` and `.agent/agent.md` reference `ui/js/app_test.js`, which no
  longer exists (mock selection now lives in `app.js`/`index_test.html`); README points at
  `.agent/design_doc.md` which doesn't exist.
- **Data race:** `getWaveform()` reads `buffer` on the message thread while the audio thread
  writes it during recording (fold into the P0-2 snapshot work).
- **`AudioEngine::findNodeByUuid`** takes a node parameter it half-ignores and needs a
  `const_cast` caller; make it a const method over the root.
- **Binding table:** the 200-line `withNativeFunction` chain in `main_component.cc` becomes a
  loop over the protocol table from P0-1.
- **Test naming:** `repro_first_clip_bug.cc`, `stack_loop_repro.spec.js`,
  `stack_loop_region_bug.spec.js` — fold verified fixes into the regression suites so the test
  tree reflects features, not incident history.

---

## Suggested sequencing

Each phase is independently shippable and de-risks the next:

1. **Quantum explicit + sample rate** (P0-3, P0-5). Small diffs, kills a whole bug class, no
   behavioral redesign.
2. **Transport extraction + golden vectors** (P0-4, P0-1 vectors). Turns `recording.md` into
   executable spec; safest moment is now, while the doc examples are fresh.
3. **Real-time safety** (P0-2). Virtual rotation offset first (one-day change, removes the worst
   offender), then the command FIFO + state snapshot.
4. **Context-down recording + pixels out of C++** (P1-6, P1-7, P1-8). Requires 1–2 to land first.
5. **Frontend facade + view model** (P2-9, P2-10, P2-11). Can proceed in parallel with 3–4; do
   the `backend.js` facade first (hours, fixes the mock drag-drop hole).
6. **Hygiene** (P3) opportunistically alongside each phase.

## What this buys the roadmap

The next roadmap segments get dramatically cheaper: **Save/Load** (Segment 6) falls out of the
snapshot/serialization work in P0-2 and the shrunken `AudioNode`; **multi-range loops**
(Segment 7) and **Warp** (Segment 8) plug into pure `timing.h` functions instead of the current
inline math; **Islands** get a natural home once Quantum is explicit state (P0-3) — an Island is
just where `quantum_samples` lives.
