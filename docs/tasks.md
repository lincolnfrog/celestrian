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
  nearest sample, exact halves toward +∞. First engine wiring landed
  the same day: `timing::subdivisionSamples` routes the Q/2, Q/4, Q/8
  boundaries (stop boundary, snap candidates, loop-end fallback)
  through the law on both sides; goldens updated (Q/8 of 44100 is now
  5513) with new odd-Q vectors pinning the law inside the snapping
  functions.

## Tier 1: Finish the Kernel (deletions, not designs)

> **✅ TIER COMPLETE (2026-07-16).** kernel.md §2–§3 now hold in code
> without exceptions: one monotonic never-mutated clock, one stored
> origin per clip, an explicit recording state machine, commit as an
> event, cast-free traversal, context passed down.

From `unification_audit.md` §1 — each item is the code catching up
with kernel.md:

- [x] **Delete both clock mutations** — ✅ done 2026-07-16. First-clip
  reset replaced by epoch capture at arm (ClipNode stores the arm
  moment as island epoch); `togglePlayback` stop-reset replaced by
  pause/resume. D6 fixed in the same stroke (`recordingStartPhase` now
  epoch-relative). Mock mirrors pause/resume. Pinned by
  `tests/monotonic_clock_tests.cc` (first clip at t > 0; stop/play
  resume); full C++/JS/e2e suites green. kernel.md §2 now holds
  without exceptions.
- [x] **Delete the residual stored timing fields** — ✅ done 2026-07-16:
  `launch_point_samples`, `anchor_phase_samples`,
  `trigger_master_position` all deleted; metadata `launchPoint` derives
  at read time; `anchorPhase` and `recordingStartPhase` deleted (no
  consumers). Tests re-pinned in origin terms. Bonus fix: the composite
  waveform read `child.x` (pixels) as SAMPLES — a live frame-mixing bug
  that collapsed all offsets to ~0; it now projects
  `(origin − epoch) mod stackDuration` (epoch threaded through
  `patchSessionView` aux; two new unit tests pin it).
- [x] **Pixels out of C++** (P1-7) — ✅ done 2026-07-16: the slot×200
  math is gone from `clip_node.cc` (arm + commit); clips never write
  `x_pos` (stacks keep freeform x/y as the ui.md-sanctioned opaque
  blob); dead `calculateVisualOffset` deleted from `math_utils.js`.
  The commit-path sibling scan died with it (a piece of P1-6 — the
  arm-path scan remains, see "Context passed down" below).
- [x] **Explicit per-clip recording state machine** — ✅ done
  2026-07-16 (the last piece of P0-4): `ClipNode::RecState { Idle,
  Armed, Capturing, PendingStop }` replaces the five booleans
  (Committed = Idle-with-content); `is_node_recording` deleted from
  AudioNode in favor of a virtual `isArmedOrRecording()` (stacks answer
  for their subtree — two more dynamic_casts gone). Pure
  `timing::armTarget` + `inAnticipatoryWindow` extracted to timing.h /
  timeline_model.js with 18 shared golden vectors. Two fixes rode
  along: the anticipatory-window check now runs in the EPOCH frame
  (the old inline check used the absolute transport — wrong grid on
  re-based/nonzero epochs), and **stop-while-armed now cancels** the
  arm instead of wedging into a phantom awaiting-stop. Three new
  state-machine unit tests.
- [x] **Commit as an event** — ✅ done 2026-07-16: the island root
  (StackNode) owns the take lifecycle — `takeArmed` snapshots the
  pre-take cycle, `takeCommitted(origin)` performs the epoch re-base
  (simple-extension rule), `takeCancelled` balances, and an
  `active_takes_` counter answers `hasActiveTake()`. The callback's
  recording-edge detection, `scanCommitted`, `view_lcm_before_`, and
  the per-block `isAnyNodeRecording()` graph scan are all deleted (the
  view-freeze upkeep keys on the counter). Node add/remove/move
  re-balances live takes (pinned by a unit test). D5 fixed in the same
  stroke. `calculateTimelineLength` became dead and was deleted.
- [x] **Kill `dynamic_cast` traversal** (P1-8) — ✅ done 2026-07-16:
  allocation-free virtual `forEachChild` (function-pointer visitor, one
  snapshot load per stack), virtual `findByUuid`, `rootNode()` +
  island-event virtuals (`establishIsland`/`take*`) replacing
  walk-to-root casts, and `root_node` typed as StackNode. Zero
  traversal casts remain; the survivors are message-thread type checks
  on user-supplied targets (createNode/reorder/combine) and reclaimer
  propagation — legitimate type discrimination, not traversal.
- [x] **Context passed down, not scanned up** (P1-6) — ✅ done
  2026-07-16: `ProcessContext.context_loop` — each stack publishes its
  longest committed child duration to its children; clip arm math uses
  `max(Q, context_loop)`. Leaves never inspect siblings; ClipNode no
  longer includes stack_node.h at all.

## Tier 2: Defects (audit §3 — fix inside Tier 1/3 rewrites)

- [ ] **D1: Stack mute is a no-op** — `StackNode::process` ignores
  `is_muted`; only clips silence themselves. Fixed structurally by the
  Tier 3 output stage; fix ad-hoc sooner if it bites.
- [x] **D2: Stop-boundary race** — ✅ fixed 2026-07-16 by the state
  machine: `stopRecording` only sets a request flag; the AUDIO thread
  computes the boundary from its own write position at the next block
  top and transitions to PendingStop. Pinned by "stop boundary is
  picked by the AUDIO thread" in clip_node_tests.
- [ ] **D3: `getWaveform` race** — message thread reads the clip buffer
  while recording writes it (long-known P3 item).
- [ ] **D4: Silent 60 s recording wall** — buffer full stops capture
  with no signal; surface it (grow, or warn).
- [x] **D5: Epoch re-base scope mismatch** — ✅ fixed 2026-07-16 by
  commit-as-an-event: the island root scans exactly its own subtree in
  `takeCommitted`; `focused_node` no longer participates.
- [x] **D6: `recordingStartPhase` uses absolute frame** — ✅ fixed
  2026-07-16 with the clock-mutation deletion: now epoch-relative.
- [x] **D9 (field 2026-07-16): take tile folded by the clip's own
  period** — a 2Q take performed at heard 2Q jumped to 0Q–2Q at commit
  (audio identical, display wrong). ✅ Fixed per ruling Q14: era takes
  mark at their performed phase, whole cycles fold, pre-epoch takes
  keep first-full-rep. Pinned in view_model tests + the FIELD engine
  repro in regression_tests.
- [x] **D10 (field 2026-07-16, same flow): anticipatory-window deferral
  overshot the anchor by a full Q** when latency compensation was small
  (uncalibrated I/O) — a click just before 2Q anchored at 3Q. ✅ Fixed
  by deleting the deferral (`inAnticipatoryWindow` and its vectors are
  gone); `armTarget` over the heard clock subsumes the pickup.
- [x] **D14 (field 2026-07-16e): takes under a shortened heard cycle
  anchored at a die-roll slot** — with a window collapsing the audible
  cycle (e.g. 4Q clip windowed to 1Q), arming anchored the take at
  whichever intrinsic-frame Q slot the next boundary happened to fall
  in — unhearable and invisible to the performer ("started at 1Q
  instead of 0Q"). ✅ Fixed per ruling Q15: the heard-frame ORIGIN FOLD
  — capture starts at the real boundary, the stored origin folds back
  by whole heard cycles into the first heard window of the frame.
  Engine + mock in lockstep; `contextCycle` now sources from the heard
  (effective) cycle. Pinned by the "shortened heard cycle" FIELD repro
  in regression_tests.
- [x] **D13 (field 2026-07-16d): composite waveform drew recorded, not
  audible, content** — two defects: loop tiling ran FORWARD-only from
  the clip's offset (everything before it blank — "the stack is blank
  for the first 2Q"), and active windows were ignored (the not-in-window
  half drew at 3Q). ✅ Fixed: the composite now mixes each clip's
  AUDIBLE content — window segment (or full take) tiled at positions ≡
  origin (mod its period) across the whole cycle including the wrap;
  window bypass added to the cache key. Pinned by four composite unit
  tests (one prior test had encoded the forward-only bug as an
  expectation — rewritten to pin phase by amplitude pattern).
- [x] **D12 (field 2026-07-16c): loop-window brackets drew a phase off**
  for clips whose take tile is not at the frame top — window geometry
  is CONTENT-relative but the overlay anchored it at frame 0. ✅ Fixed:
  the view model exposes `takeStartQ` (the lane's content-frame origin
  = its take tile) and the whole overlay — brackets, chip, dims tiling,
  heard-time cursor (both animator and poll paths), and the drag
  pointer↔content mapping — shifts by it. Pinned in the 16b view-model
  test; verified live (brackets wrap the take tile at 25%/75% for a
  take at [1Q,3Q) of a 4Q frame).
- [x] **D11 (field 2026-07-16b): frame explosion teleported the new
  take** — a 5Q take from a heard cycle top drew at 12Q–17Q of the
  exploded 20Q frame (and clip 3's mark drifted to 6Q). ✅ Fixed per
  Q14b: every cycle growth re-bases the epoch to the take's heard top
  (whole pre-take cycles — phase-neutral; supersedes the polyrhythmic
  keep-epoch rule), and each take stores `contextCycle` (its heard
  frame) so take marks fold by the cycle they were performed against,
  surviving growth and re-bases. Engine + mock + view model in
  lockstep; pinned by the extended FIELD repro (C++), the 16b
  view-model test, and a live mid-cycle-armed browser run.

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
- [ ] **Edits-as-events → undo/save-load → (later) immutable root** —
  STAGED (audit verdict 2026-07-16; the full-RT-rewrite framing is the
  wrong entry point):
  - [x] **Step 1: `apply(edit)` + undo log — ZERO RT changes.** ✅ done
    2026-07-16: `src/edit.h` vocabulary; `AudioEngine::applyEdit` returns
    the inverse (structural removes own the detached subtree — safe by
    no-overdub); undo_/redo_ stacks, Position drags coalesce, dropped
    owned subtrees go through the reclaimer. New user verb `deleteNode`
    (the motivating undoable); armed takes are not undoable. Bridge (3
    places) + Cmd/Ctrl+Z/Shift+Z; `canUndo/canRedo` on getGraphState.
    `tests/undo_tests.cc` + `ui/js/tests/undo.test.mjs`; verified in the
    mock preview. Effect enable/param undo deferred (non-destructive
    knobs; drag-flood) — follow-up.
  - [x] **Step 2: Save/Load (Segment 6)** — ✅ done 2026-07-16:
    `src/session_io.{h,cc}` writes a bundle (session.json + audio/*.wav),
    device-independent + QTime-based (originQ/periodQ/windowQ from the
    Phase A helpers; **contextCycle** serialized as the recorded fact it
    is; island quantum + epoch + qSamples). Clip buffers → 32-bit float
    WAV; fx params round-trip generically. `AudioEngine::loadSession`
    swaps the root's CONTENTS in place (root identity stable → no
    audio-thread race), refuses mid-take, clears undo history. Bridge (3
    places) + native FileChooser + Cmd/Ctrl+S/O.
    `tests/session_io_tests.cc` + `ui/js/tests/session.test.mjs`; verified
    in the mock preview. The Q12 engine migration landed SEPARATELY (its
    own commit: the D-T3 type-discipline boundary — metadata now publishes
    device-independent QTime, pinned by `qtime_origin_cases` goldens).
  - [ ] **Step 3 (later, with the pure-render split §2.3): whole-graph
    immutable root** — one atomic swap replaces per-stack snapshots +
    reclaimer plumbing; bridge fully collapses to `apply(edit)`. The
    live take stays OUTSIDE the snapshot until commit (standard
    carve-out, not a blocker). RT trap to avoid: the audio thread
    traverses raw pointers off one atomic root load — never copies
    shared_ptrs (last-reference destruction on the audio thread);
    lifetimes stay on the epoch-graveyard. performance.md §1 is
    PRESERVED by all steps, not rewritten.
- [ ] **Pure render function** — `out = render(snapshot, t, n)`;
  control decisions become events applied between blocks; engine
  testable as `render(state, t) == golden`.

## Tier 4: Feature Work (carried forward)

### Interaction (Segment 4, in progress)
- **Q re-trim before lock (Q13, ruled 2026-07-16; non-sticky + revert
  amendment 2026-07-16)** — Q mutable ⟺ exactly one committed clip.
  - [x] **Engine + undo** ✅ done 2026-07-16: `setLoopPoints` on the sole
    committed clip re-establishes `(Q := window len, epoch := origin +
    window start)`; deleting the sole committed clip reverts `(Q,epoch)`
    to 0; deleting back down to one **re-opens** (lock is derived from
    `AudioEngine::islandCommittedClipCount()`, not a latched flag). All
    three ride the edit log — `Edit` gained a `setsIsland/iq/iepoch`
    payload so LoopPoints/Remove undo restores the GRID with the
    clip/window. `establishIsland` once-only guard untouched (first
    commit still establishes; provisional re-establishment goes through
    `setQuantum`). Pinned by `tests/qtime_lock_tests.cc` (re-trim +
    undo/redo; 2nd clip locks; delete reverts; delete 2→1 re-opens).
    Canon amended (design_language.md Q1 refinement + Q13 non-sticky).
  - [ ] **UI affordance** — locked/unlocked handles on the sole clip:
    always-draggable Q-handles (even at full span), distinct styling,
    live Q readout during drag. `view_model.js` exposes `soleQDefinerId`;
    mock derives Q from the sole clip's window. Field-motivated: trimming
    dead air out of the scratch loop before building on it.
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
| 8 | Stop/play policy — **implemented default (2026-07-16): pause/resume** (stop freezes, play continues the phase). The old reset only restarted "from the top" when the epoch happened to be 0. If restart-from-top is wanted, it's a root time-map + congruent epoch handling, not a clock reset — owner preference pending field use | audio_engine.cc togglePlayback |
| 9 | Grid honesty when auto-quantize is disabled — deferred with that feature | design_language.md Q3 |
| 10 | **Windowed-clip lane rendering** — ✅ RULED & IMPLEMENTED (2026-07-16): **ghosts show what SOUNDS.** A windowed clip's ghost tiles are ECHOES of the window segment at its audible repetitions, drawn in a distinct cool tone (canvas_renderer ECHO palette, owner: "an entirely different color for ghosts") at higher presence than raw-take ghosts; the take tile stays whole as the ONE place showing recorded truth (original material dimmed outside the brackets — the visible undo), and window dims apply only there on clip lanes. Nothing baked: bypass restores raw ghosts (pinned in view_model tests). Generalizes to multi-segment maps (phase 3) | view_model echoReps; session_view; D13 composite |

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
