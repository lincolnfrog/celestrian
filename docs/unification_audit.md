# Unification Audit

> Written 2026-07-16 from a full pass over the engine (`src/`) and the
> canon docs. Companion to `kernel.md` (this audit measures the code
> against it) and successor to `refactoring_proposal.md` (the 2026-07-07
> round, whose P0 items all landed).
>
> Status: **proposal — owner-endorsed direction (2026-07-16: "great
> analysis, I agree completely")**. The rational-time decision (§4)
> was **ruled the same day**: adopt now, `QTime` exact rational —
> recorded as **Q12 in design_language.md §5**, which is the canonical
> statement (this §4 is the decision record that led to it).
>
> **Postscript (2026-07-16, end of day): §1 (finish-the-kernel) is
> COMPLETE** — see tasks.md Tier 1 — and the same-day field session
> drove out and fixed D9–D13 plus rulings Q13/Q14a-c (take marking,
> heard-top epoch re-base, echo grammar). §2's four primitives remain
> the roadmap: QTime engine migration, TimeMap reification, the
> fractal output stage, immutable graph + edits-as-events.

---

## 0. Executive summary

The beautiful design already exists — it is kernel.md. `(content,
period, origin)` over one monotonic clock, with time-maps as the only
time-transforming mechanism, is correct and elegant. The finding of
this audit is that **the code is roughly 60% of the way through its own
kernel, and the remaining 40% is where all the residual ugliness
lives** (§1). Beyond finishing it, four unifying primitives the kernel
does not yet name would take the system the rest of the way (§2):

1. **Rational musical time** — positions as rationals of Q; samples
   only at the device edge (§4 is the decision).
2. **The graph as an immutable value; edits as events** — buys undo
   (currently absent!), save/load, and a smaller bridge.
3. **Control-plane / data-plane split** — rendering becomes a pure
   function `out = render(snapshot, t, n)`.
4. **The fractal output stage** — one per-node channel strip (gain →
   fx → mute/solo), which also fixes a real bug (stack mute is a
   no-op) and adds the missing gain primitive.

Several concrete defects were found in passing (§3).

The through-line: the docs are unusually honest about which ideas are
ratified and which are aspirational, but the code still contains the
fossil record of every pre-kernel design. The transformation is not a
new idea — it is deleting until the kernel equation is the only thing
left, then extending the same three primitives (origin, period,
time-map) with the two the kernel forgot: rational time and the output
stage.

---

## 1. Kernel divergences (finish-the-kernel)

Every item here is a place where the code has not caught up with
kernel.md; each is a deletion or a consolidation, not new design.

### 1.1 The clock is still mutated, twice

kernel.md §2: the clock "never wraps, never resets, and is never
mutated by musical events." But:

- `AudioEngine::startRecordingInNode` resets the transport to 0 on
  first clip (`audio_engine.cc`, "INITIAL RECORDING RESET"). The
  rationalization — "it IS the epoch capture" — conflates two things:
  epoch capture is `epoch := t`, no clock mutation required.
- `togglePlayback` zeroes the transport on stop.

These resets are load-bearing for hidden absolute-frame math:
`ClipNode::getMetadata` publishes `trigger_master_position % Q` as
`recordingStartPhase` — a one-frame-rule violation that only works
because the reset keeps the epoch ≡ 0 (mod Q). **Delete the resets and
the surviving absolute-frame math will surface immediately; that is a
feature.** Stop/play behavior ("resume from cycle top"?) becomes an
explicit epoch/`play_epoch` policy instead of a clock mutation.

### 1.2 Three of the six timing fields still exist

- `launch_point_samples` and `anchor_phase_samples` are stored "for
  UI/metadata compat" — stored-but-derivable fields are precisely the
  disease the kernel diagnosed.
- `trigger_master_position` still feeds the x/slot math (P1-7 owed).
- `x_pos` in **pixels**, with `base_width = 200.0`, is still computed
  in C++ (`clip_node.cc` arm + commit paths) — the most flagrant
  remaining I6 violation. The UI derives x from `origin` in one line
  of `timeline_model.js`.

End state per kernel.md: a clip stores `{origin, period-source,
window, buffer}` and nothing else timing-shaped.

### 1.3 Recording is five booleans pretending to be a state machine

`is_pending_start`, `is_recording`, `is_awaiting_stop`,
`is_node_recording`, `is_playing` + four int64 atomics encode
`Idle → Armed → Capturing → PendingStop → Committed`. Illegal
combinations are representable; the arm path in `ClipNode::process` is
~160 lines with the same branch-pile character the transport used to
have. kernel.md §3 already calls for the explicit per-clip machine —
it is the last unbuilt piece of P0-4.

Sub-items:

- The ~60-line arm-target computation (single-clip vs multi-clip
  context) should be one pure `timing::armTarget(rel, Q,
  context_loop)` with golden vectors, like all other timing math.
- **Race:** `stopRecording` computes `nextStopBoundary` on the message
  thread from a `write_position` the audio thread is concurrently
  advancing — a stop boundary can land behind the write head and never
  fire. The state machine (boundary computed on the audio thread, or
  from an event) removes the race structurally.

### 1.4 Clips and stacks disagree about what a window is

A stack window phases off the island clock (`(t − epoch) mod len`); a
clip's window is origin-anchored through `launchPointFor`.
time_maps.md calls the asymmetry deliberate ("revisit if it bites") —
it will bite the moment the cell/punch editor lands, because a
multi-segment map on a clip has no home in the clip's inlined playback
equation. Fix by reifying the primitive: **make `TimeMap` an actual
type** and let clip playback be a one-segment instance of it.
(`ClipNode::process` and `StackNode::process` currently each inline
their own bypass/fallback logic.)

### 1.5 The audio callback still makes musical decisions

- The epoch re-base at commit (simple-extension vs polyrhythm,
  `scanCommitted`, the `view_base_`/`view_anchor_t_`/`view_lcm_before_`
  bookkeeping) runs inside the device callback by *detecting* the
  recording→not-recording edge and re-scanning the graph. Commit is an
  event that happens at one known place (`commitRecording`); the
  re-base should be a consequence of that event carrying
  `{origin, duration}`, not a per-block edge detection.
- `isAnyNodeRecording()` recursively scans the graph every block to
  derive one bit.

### 1.6 `dynamic_cast` is the traversal mechanism — on the audio thread

`scanCommitted`, `computeLcmRecursive`, solo ancestry,
`maybeEstablishQuantumFrom`'s walk-to-root, `findNodeByUuid` (P1-8,
never done). One virtual `forEachChild` kills ~20 casts. "Walk to
island root" should be a named operation, since islands are intended
to become first-class (Q10).

---

## 2. Four missing unifying primitives

### 2.1 Rational musical time (the gate — see §4)

Today the engine's only unit is device-rate samples, which couples
every musical fact to hardware: mid-session rate changes break
alignment, save files would be device-specific, and warp /
tempo-nesting (design.md Challenge #1 — the recursive clock problem,
arguably the defining problem of a looper-first DAW) is unbuildable.
design_language.md already legislates "samples are the only engine
unit; Q is the only musical unit" as a *documentation convention* —
make it a **type system**. Every deferred hard thing — warp, nested
BPM, swing, cross-island transitions, device-independent persistence —
is downstream of this one decision, and kernel.md §6 correctly notes
retrofitting units is the expensive path. §4 states the decision.

### 2.2 The graph as an immutable value; edits as events

> **Status 2026-07-19d: implemented** (staged — Step 1 undo 2026-07-16,
> Step 2 save/load 2026-07-16, Step 3 whole-graph snapshot 2026-07-19d;
> see tasks.md Tier 3). The audio thread now loads ONE immutable graph
> snapshot per callback (`graph_snapshot.h`); the per-stack snapshot
> machinery and its reclaimer plumbing are deleted. Remaining from this
> section's text: the bridge collapse to `apply(edit)` (UI surface).

`StackNode` already invented copy-on-write for one level (immutable
child snapshots + the reclaimer graveyard). Generalize: **every
mutation publishes a whole immutable graph snapshot; the audio thread
loads one root pointer per block.** The per-stack snapshot machinery,
the reclaimer plumbed through every stack, and the atomic-parent
contortions collapse into one swap. Three missing features then fall
out nearly free:

- **Undo.** Absent from code and roadmap — and for a tool whose pitch
  is "capture the creative spark," a mis-click deleting a take is
  fatal. I9 (predictable, reversible degradation) is already the house
  value system; undo is its global form. Immutable snapshots make it a
  list of old roots.
- **Save/Load** (Segment 6) becomes "serialize the snapshot" — and
  doubles as an audit: anything that needs saving is canonical state;
  anything that doesn't must be derived. Serialization will reveal
  whether the kernel's claimed per-clip state set is actually true yet.
- **The bridge simplifies:** ~20 imperative methods become
  `apply(edit)` over a small edit vocabulary (also the P3
  binding-table cleanup).

### 2.3 Control plane / data plane split

> **Status 2026-07-19e: implemented.** `AudioNode::process` is a
> NON-virtual sequencer over two virtuals: `control(inputs, ctx)` (arm
> targets, stop boundaries, capture, commit + island consequences) and
> `render(outputs, ctx) const` (the kernel equation). Called at the
> root, control settles across the WHOLE graph before the first sample
> renders. Purity is compiler-enforced: the only `mutable` members are
> DSP scratch (mix/fx buffers, effect state) and playhead telemetry,
> explicitly marked. The historical commit-block silence is preserved
> by a per-clip gate. Pinned by `tests/render_purity_tests.cc` —
> `render(state, t) == golden`, determinism, state invariance.

The endgame of "playback is one equation" is that rendering is a
*pure function*: `out = render(graph_snapshot, t, n)`. Today
`process()` interleaves rendering with decisions (arm scheduling,
commit detection, epoch re-base, peak bookkeeping). If node state only
changes via events applied between blocks — arm, boundary-crossed,
commit — the render path takes an immutable snapshot and a time and
produces samples, with no branches on mutable flags. Payoff beyond
aesthetics: the entire engine becomes testable as
`assert(render(state, t) == golden)` — the C++ analogue of the UI's
deriveViewModel refactor (P2-10). The kernel equation deserves to be
literally visible in the code as one function.

### 2.4 The fractal output stage — and the missing gain primitive

Every node currently has **three overlapping audibility mechanisms**
— global transport, per-clip `is_playing`, mute/solo — evaluated in
different places, plus an fx rack evaluated in a fourth. And **there
is no gain control anywhere in the node model**: a looper with no
per-loop volume fader cannot balance a mix. It is the most conspicuous
missing primitive in the system.

Unification: every node has one output stage — *sum children (or
render content) → time-map → gain/pan → fx → mute/solo resolution* —
applied identically at every level (I5). Mute becomes gain 0 rather
than a separate concept; container mute/solo/gain become correct by
construction. This also fixes a real bug (§3: stack mute is a no-op)
and gives Mono→Stereo one bus abstraction to upgrade instead of three
scattered assumptions.

---

## 3. Defects found in passing

| # | Defect | Where | Severity |
|---|---|---|---|
| D1 | **Muting a stack does nothing.** `toggleMute` sets `is_muted` on any node, but `StackNode::process` never reads it; only clips check their own flag. Solo works on containers (ancestor walk); mute doesn't — an I5 violation and a user-visible bug. | `stack_node.cc::process`, `clip_node.cc` playback | High |
| D2 | **Stop-boundary race.** `nextStopBoundary` computed on the message thread from a racing `write_position`; boundary can land behind the write head and never fire. | `clip_node.cc::stopRecording` | Medium |
| D3 | **`getWaveform` race** (known, P3): message thread reads the clip buffer while the audio thread records into it. | `clip_node.cc::getWaveform` | Medium |
| D4 | **Silent 60-second wall.** Clip buffers are fixed at 60 s; recording past that silently stops writing with no user-visible signal. A monotonic looper invites long takes. | `clip_node.cc` ctor + capture paths | Medium |
| D5 | **Scope mismatch in epoch re-base.** `scanCommitted` scans `focused_node` but `setEpoch` targets `root_node` — inconsistent once focus ≠ root (nested editing). | `audio_engine.cc` callback commit branch | Low (latent) |
| D6 | **Absolute-frame metadata.** `recordingStartPhase = trigger % Q` only works because of the residual first-clip transport reset (§1.1). | `clip_node.cc::getMetadata` | Low (fragile) |
| D7 | **One-shots don't exist in the engine.** The Q5 ruling (period source: own length \| context) is exactly a `period_source` field on the kernel triple; the code stores no `period` at all, only `duration` + window. Storing the actual triple implements one-shots as a knob and deletes the last derived-but-stored fields in one move. | `audio_node.h` / `clip_node.cc` | Feature gap |
| D8 | **Mono-bus assumption in three places.** Clip adds the same mono signal to every output channel; stack fx folds channel 0 "losslessly"; the rack is mono. Fine today, but it should become one bus abstraction before Mono→Stereo, or it becomes N places. | `clip_node.cc`, `stack_node.cc`, `dsp/effects.h` | Structural |

---

## 4. The rational-time decision (gates everything)

**The question: what is the unit of musical position and duration in
the engine, and where does the sample conversion happen?** Framed as
five sub-decisions (D-T1…D-T5), with recommendations. This restates
design_language.md Q9 ("origins under warp") in its true, larger form
— it was never really about warp.

A structural observation that shapes the answer: **by construction,
the canonical musical facts are already clean fractions of Q.** Arm
targets are always the next Q boundary (Q11 ruling); committed
origins are Q-multiples in the epoch frame; hysteresis snap yields Q
multiples or Q/2, Q/4, Q/8 subdivisions. The *messy* sample-exact
facts (an unsnapped take's raw length, a free-length punch cut
"1.37Q ⚠") are exactly the sanctioned deliberate-decoupling cases
(Q2/I9). So a hybrid is natural, not a compromise.

- **D-T1 — Adopt music-time, yes/no.** Recommendation: **yes.**
  Staying all-samples forecloses warp, nested tempi, and
  device-independent persistence; kernel.md §6 already flags
  retrofitting as the expensive path.
- **D-T2 — Representation.** Options: (a) exact rational newtype
  `QTime {int64 num, int64 den}` normalized, meaning `(num/den)·Q`;
  (b) fixed tick grid (PPQ-style int64); (c) floating beats.
  Recommendation: **(a)**. Fixed ticks cannot represent free lengths
  without a lossy snap — alien to a tempo-free looper; floats drift
  and break exact LCM math. Denominators stay tiny in practice (2, 4,
  8 now; 3, 5 with tuplets), so int64 rationals with gcd
  normalization are safe and the LCM/GCD algebra carries over
  exactly.
- **D-T3 — What stays in samples.** The monotonic clock `t`, the
  epoch (a sample-clock timestamp), ring indices, buffer lengths, and
  the calibration constant C are *physical* facts and stay in
  samples. All *musical* state — origin (as offset from epoch),
  period, window segments, arm targets, Q subdivisions — becomes
  QTime. The island owns the exchange rate: `Q_samples` (int64,
  established at first commit exactly as today). Warp later = making
  the exchange rate a function of time; nested tempi = per-subtree
  rates — the time-map rate term, same primitive.
- **D-T4 — One rounding law.** `Q_samples` need not be divisible by
  8: `Q/8` can be fractional samples (today's integer division in
  `nextStopBoundary` is already silently lossy). Therefore one shared
  conversion `toSamples(QTime, island)` with a single stated rounding
  rule, used by capture and playback alike (I1 preserved because both
  sides round identically), pinned by golden vectors.
- **D-T5 — Unsnapped content.** Raw take lengths and free-length cuts
  remain sample-exact (an exact `n/Q_samples` rational is
  representable but treat it as samples semantically). The QTime
  layer describes where content *belongs*; buffers describe what it
  *is*.

**Sequencing:** decide before time_maps phases 2–3 and before
Save/Load — the serialization format must not bake samples in. The
mechanical migration rides along with §1.2's field deletions (origins
are being touched anyway).

---

## 5. Recommended order

1. **Rule on §4** (rational time) — record the ruling in
   design_language.md §5; even a minimal `QTime` decision unblocks
   everything downstream.
2. **Finish the kernel (§1):** delete both clock resets; delete
   stored `launch_point`/`anchor_phase`/`trigger` and pixels-in-C++;
   explicit per-clip recording state machine with `timing::armTarget`.
3. **Reify `TimeMap` (§1.4/§2.1)** and route clip playback through it
   — unblocks time_maps phases 2–3.
4. **Fractal output stage with gain (§2.4)** — fixes D1, unifies
   audibility, adds the fader.
5. **Whole-graph immutable snapshots + edit events (§2.2)** → undo
   and Save/Load in the same stroke.

Fix D2–D6 opportunistically inside steps 2–4 (each sits in code those
steps rewrite).
