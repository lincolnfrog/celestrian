# Celestrian: Implementation Roadmap & Task List

> Status: **tracker**. Overhauled 2026-07-16 around the unification
> audit (`unification_audit.md`, owner-endorsed) — tiers now follow its
> recommended order. Previous version (2026-03-05 audit) is condensed
> into the archive at the bottom; completed items keep one line each.

Tasks are ordered by leverage: the rational-time ruling gates the rest;
each tier de-risks the next.

---

## Tier 0: The Rational-Time Ruling (GATE)

- [x] **Owner ruling on unification_audit.md §4 (D-T1…D-T5)** — ✅
  RULED 2026-07-16 (design_language.md Q12): adopt now; `QTime` exact
  rational for musical facts; samples for physical facts; island owns
  `Q_samples` as the exchange rate; one shared rounding law. Subsumes
  Q9.
- [x] **Implement `QTime` + `toSamples` rounding law** — ✅ done
  2026-07-16: `src/qtime.h` ↔ `ui/js/qtime.js`, pinned by the
  `qtime_*` sections of `shared/timing_golden.json`
  (`tests/qtime_tests.cc` + `ui/js/tests/qtime_golden.test.mjs`,
  including round-trip/monotonicity/tie-rule property tests). Law:
  nearest sample, exact halves toward +∞. Not yet wired into the
  engine — that's the Tier 1 migration (start by re-deriving the Q/2,
  Q/4, Q/8 subdivisions in `timing.h` through `toSamples`, which
  changes goldens by ≤1 sample where Q isn't divisible).

## Tier 1: Finish the Kernel (deletions, not designs)

From `unification_audit.md` §1 — each item is the code catching up
with kernel.md:

- [ ] **Delete both clock mutations** — first-clip transport reset
  (`startRecordingInNode`) becomes pure epoch capture (`epoch := t`);
  `togglePlayback` stop-reset becomes an explicit epoch/play-epoch
  policy. Expect hidden absolute-frame math to surface (that's the
  point); D6 below is one known instance.
- [ ] **Delete the residual stored timing fields** —
  `launch_point_samples`, `anchor_phase_samples` (derive in metadata if
  the UI still wants them), `trigger_master_position` (P1-7's last
  feeder). End state per kernel: clip stores `{origin, period-source,
  window, buffer}`.
- [ ] **Pixels out of C++** (P1-7) — delete `x_pos = slot * 200.0` from
  `clip_node.cc`; UI derives x from `origin` in `timeline_model.js`.
- [ ] **Explicit per-clip recording state machine** — one
  `enum class RecState { Idle, Armed, Capturing, PendingStop,
  Committed }` replacing the five booleans; pure
  `timing::armTarget(rel, Q, context_loop)` extracted from the ~60-line
  arm branch, golden-vector tested (the last piece of P0-4).
- [ ] **Commit as an event** — epoch re-base driven by the commit event
  carrying `{origin, duration}`, not by per-block recording-edge
  detection + `scanCommitted` graph scans in the callback; replace the
  per-block `isAnyNodeRecording()` scan with a counter.
- [ ] **Kill `dynamic_cast` traversal** (P1-8) — virtual
  `forEachChild`; named "island root" lookup.
- [ ] **Context passed down, not scanned up** (P1-6 remainder) — parent
  computes `{context_loop, Q}` once and passes via `ProcessContext`;
  delete the sibling scans in `ClipNode` arm/commit.

## Tier 2: Defects (audit §3 — fix inside Tier 1/3 rewrites)

- [ ] **D1: Stack mute is a no-op** — `StackNode::process` ignores
  `is_muted`; only clips silence themselves. Fixed structurally by the
  Tier 3 output stage; fix ad-hoc sooner if it bites.
- [ ] **D2: Stop-boundary race** — `stopRecording` computes
  `nextStopBoundary` from a racing `write_position`; boundary can never
  fire. Falls out of the recording state machine.
- [ ] **D3: `getWaveform` race** — message thread reads the clip buffer
  while recording writes it (long-known P3 item).
- [ ] **D4: Silent 60 s recording wall** — buffer full stops capture
  with no signal; surface it (grow, or warn).
- [ ] **D5: Epoch re-base scope mismatch** — `scanCommitted` walks
  `focused_node`, re-base hits `root_node`; latent until nested focus.
- [ ] **D6: `recordingStartPhase` uses absolute frame** — `trigger % Q`
  survives only because of the first-clip reset; make it
  epoch-relative.

## Tier 3: The Unifying Primitives (audit §2)

- [ ] **Reify `TimeMap` as a type** — clips and stacks share one
  implementation (fixes the deliberate clip/stack window-phase
  asymmetry noted in time_maps.md before the cell/punch editor makes it
  bite); window state (`none|active|bypassed` + segments) becomes its
  data.
- [ ] **time_maps.md phase 2** — recording through an active map (heard-
  time arm math, one-period cap, dense buffers with silence in
  unvisited regions — semantics already owner-ratified).
- [ ] **time_maps.md phase 3** — cell mode + punch mode editor (seam
  theorem: cuts groove-transparent iff removed length ≡ 0 mod Q);
  zero-crossing micro-snap; seam audition.
- [ ] **Fractal output stage** — per-node `sum/render → time-map →
  gain/pan → fx → mute/solo`, applied identically at every level (I5).
  Adds the missing **gain** primitive (no volume fader exists!),
  makes mute = gain 0, fixes D1, collapses the three audibility
  mechanisms (global transport / per-clip `is_playing` / mute-solo)
  into one resolution, and gives Mono→Stereo one bus to upgrade.
- [ ] **One-shots as a period-source knob** (Q5 ruling) — store the
  kernel triple's `period_source: own_length | context`; deletes the
  last reason `duration` doubles as period.
- [ ] **Whole-graph immutable snapshots + edits-as-events** — one
  atomic root swap replaces per-stack snapshots + reclaimer plumbing;
  bridge collapses toward `apply(edit)`. Unlocks:
  - [ ] **Undo/redo** — currently absent everywhere; I9's global form.
  - [ ] **Save/Load (Segment 6)** — serialize the snapshot
    (QTime-based, device-independent). Doubles as the canonical-state
    audit.
- [ ] **Pure render function** — `out = render(snapshot, t, n)`;
  control decisions become events applied between blocks; engine
  testable as `render(state, t) == golden`.

## Tier 4: Feature Work (carried forward)

### Interaction (Segment 4, in progress)
- [ ] **Q re-trim before lock (Q13, ruled 2026-07-16)** — while the
  island's only committed content is the Q-defining clip, dragging its
  loop region re-establishes `(Q, epoch)` (`Q_samples := window len`,
  `epoch := origin + window start`); Q locks at the next commit.
  Engine: relax `StackNode::setQuantum` once-only to
  re-settable-until-locked, hook `setLoopPoints` on the sole
  Q-definer. UI: locked/unlocked affordance on the Q-definer's loop
  handles. Field-motivated: trimming dead air out of the scratch loop
  before building on it. Should ride along with Tier 1's island/epoch
  work (same code).
- [ ] **Track Controls** — Play/Solo/Record buttons; partially done.
- [ ] **Creation Menu** — contextual node creation; partially done.
- [ ] **Selective Recording** — record into specific nodes.
- [ ] **Group arm (Q7 ruling)** — arming a stack arms every armable
  child (empty clips only); one arm target, one committed duration.
  Companions: **templates** (saved subtrees) and **takes** (alternate
  content buffers sharing one origin/period — deferred).

### Stacks / UI
- [ ] Cache invalidation optimization (composite waveform).
- [ ] Collapsed composite waveform rendering.
- [ ] Multi-select → "Combine into Stack".
- [ ] Drill-in mode (double-click) + keyboard navigation + quick
  expand/collapse shortcut.
- [ ] Ghost coordinate mismatch for stack children (drag & drop);
  verify drag-drop end-to-end.

### Effects
- [ ] **VST3 hosting** — replaces the fixed rack's internals with a
  dynamic chain; bridge surface designed to survive.
- [ ] **Stereo rack** — lands with Mono→Stereo (see the Tier 3 output
  stage: one bus abstraction first).
- [ ] **Effect tails on mute** — muted clip freezes echo/reverb rather
  than ringing out; revisit if it reads as a bug.

### Clip manipulation (Segment 5)
- [ ] Move clips in 2D space; resize durations via UI handles.

### Tests
- [ ] Verify existing C++ test coverage; catalog pass/fail (run the
  **Debug** binary — test_harness.md stale-binary gotcha).
- [ ] Audit JS unit/E2E test health.
- [ ] E2E: recording inside expanded stack; collapse → playhead
  constrained; drag visual feedback + grid lines for collapsed stacks.
- [ ] **New invariant tests the audit motivates:** stack-mute
  audibility (D1), I2 simultaneity test (still missing), stop-boundary
  race regression (D2).

## Tier 5: Advanced Engine & Vision (unchanged)

- [ ] **Warp (Segment 8)** — WSOLA time-stretch, BPM discovery,
  primary-relative warping. Now explicitly downstream of Tier 0
  (QTime) — a warp is a rate term on `TimeMap`.
- [ ] **Multi-range clip loops (Segment 7)** — subsumed by `TimeMap`
  segments (Tier 3); conservation-of-loop-length = the punch-mode
  linked-edge rule.
- [ ] **PhaseAligner** — crossfade synthesis at seams; intelligent edge
  analysis.
- [ ] **Multi-threaded root mixer** — only if perf meters ever show
  pressure (currently <1% DSP load).
- [ ] **Connections between boxes (Segment 9)** — serial composition =
  concatenation time-map (Q6 provisional ruling); branch-with-chance;
  transitions.
- [ ] **ZUI navigation** — dive/exit, transitions.
- [ ] **Islands & multi-stack** — island as first-class object
  (Q, epoch, exchange rate); inherit-vs-new-song; one active island for
  now (Q10 ruling).
- [ ] **Corpus & automation** — library, procedural combination,
  infinite radio mode.
- [ ] **UI polish** — prettier waveforms, zoom-dependent peaks, visual
  growth during recording, stepped zoom, depth indicators, copy/paste.
- [ ] **Disable auto-quantize toggle** (revives design_language Q3).
- [ ] **Mono → Stereo** recording.

---

## Open Design Questions

(See design_language.md §5 for the full ruling record.)

| # | Question | Status / source |
|---|----------|-----------------|
| 1 | Max practical nesting depth before UI gets unwieldy? | open — stacks.md |
| 2 | Quantum mismatches between connected islands? | open — implementation.md |
| 3 | "Breaking out" a stack from an island — UX + implementation? | open — implementation.md |
| 4 | Connecting stacks after Q established — polyrhythmic interaction? | open — recording.md |
| 5 | Warning UX for very large LCMs (coprime durations)? | open — Q2 resolved the model question; the UX remains |
| 6 | **Rational time (D-T1…D-T5)** — ✅ RULED 2026-07-16 (design_language.md Q12): QTime rational, adopt now; subsumes Q9 | unification_audit.md §4 |
| 7 | Record on a composite — ✅ resolved (Q7): group arm, empty clips only; takes/templates as companions | design_language.md Q7 |
| 8 | Stop/play epoch policy once the `togglePlayback` clock reset is deleted — resume from cycle top, or from stopped phase? | new — falls out of Tier 1 |
| 9 | Grid honesty when auto-quantize is disabled — deferred with that feature | design_language.md Q3 |

---

## Archive: completed work (condensed)

### 2026-07 kernel migration & audit round (refactoring_proposal.md, kernel.md)
- [x] P0-1 One source of timing truth — protocol.js contract test,
  timing.h ↔ timeline_model.js pinned by shared golden vectors.
- [x] P0-2 RT-safe audio thread — lock-free child snapshots + reclaimer
  graveyard, RtLog ring, POD ProcessContext, no rotation copies.
- [x] P0-3 Quantum + epoch stored at island root; composite duration =
  LCM of children; Q survives its creator (Q1 ruling).
- [x] P0-4 Transport branch-pile **dissolved** — monotonic clock,
  per-clip origins, derived cycle view (~90 lines deleted).
- [x] P0-5 Device sample rate threaded everywhere (found the 48 kHz
  field device).
- [x] Rotation deleted entirely; origin stored absolute; one-frame rule
  (island epoch) established and field-hardened.
- [x] Latency: empirical round-trip calibration (🎯), per-device
  persistence, arrival-time capture via pre-record ring
  (performance.md §3/§7) — ~1-sample repeatability.
- [x] time_maps.md phase 1 — loop windows as island-aligned time-maps;
  `internal_transport_` deleted; collapse purely visual (I6b test);
  clip windows first-class (fractal); masterPos wraps on the EFFECTIVE
  cycle.
- [x] Built-in effects — fixed per-node rack (EQ/comp/echo/reverb),
  fractal, all-atomic params, scope telemetry gated on panel-open.
- [x] P2-9 backend.js facade (exposed + fixed two latent drag bugs).

### 2026-03 round (original tasks.md tiers)
- [x] Tier 0 hygiene: BoxNode removal, debug-log cleanup,
  reorderNode/createNode API cleanup, app.js modularization (1660→634),
  LCM/GCD consolidation.
- [x] Stack loop window tests rewritten to time-map semantics.
- [x] Recording ghost bug suite (extension lag, cursor jump, abstraction
  mismatch, ghost counts) — tested & passing.
- [x] Composite waveform cache tests; stack_loop_repro fix; un-skipped
  collapsed-stack Playwright tests (2 of 4).
