# Celestrian: Implementation Roadmap & Task List

> Status: **tracker**. Overhauled 2026-07-16 around the unification
> audit (`unification_audit.md`, owner-endorsed) — tiers now follow its
> recommended order. Audited 2026-08-20 (stale lines closed: VST3
> phases 1–5, stereo rack, selective recording; March Stacks/UI
> backlog flagged for re-ruling; S18/S19 added). Previous version (2026-03-05 audit) is condensed
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

- [x] **D1: Stack mute is a no-op** — ✅ fixed 2026-08-06 by the Tier 3
  output stage: the group's final sum applies `outputStageGains`
  (gain·pan, mute = gain 0), so containers silence like leaves. Children
  still render while muted (playhead telemetry keeps flowing) and the
  rack is skipped (tails freeze — the same semantics as a muted clip).
  Pinned by `tests/output_stage_tests.cc` (incl. nested-group scope and
  mute-beats-soloed-child).
- [x] **D2: Stop-boundary race** — ✅ fixed 2026-07-16 by the state
  machine: `stopRecording` only sets a request flag; the AUDIO thread
  computes the boundary from its own write position at the next block
  top and transitions to PendingStop. Pinned by "stop boundary is
  picked by the AUDIO thread" in clip_node_tests.
- [x] **D3: `getWaveform` race** — ✅ fixed 2026-08-11: the message
  thread may read clip content ONLY in Idle — `getWaveform` gates on
  the recording state machine (empty while armed/capturing/pending;
  the UI already draws live takes from `currentPeak`, and app.js
  ignores empty results, so the torn-poll window can't poison its
  peak cache). Commit's seq-cst Idle store is now the documented
  publication point, replacing the ACCIDENTAL write_position
  release/acquire edge — which the phase-2 through-map fold had
  silently broken (destinations scatter across [0, C) while
  write_position counts HEARD samples: a genuine mid-take data race
  since 2026-07-21), reachable even from the polite UI through a
  getGraphState torn-field window (isRecording read pre-capture,
  duration read post-first-block). Only the message thread arms, so
  Idle observed there can't flip mid-read. Stack aggregation inherits
  the clip gate; mock parity in mock/waveform.js. Pinned by the "D3"
  tests in clip_node_tests.cc (which also un-pins the racy read the
  old Buffer Writing test encoded) + time_map_record_tests.cc (the
  fold case). Full C++/JS suites green.
- [x] **D4: The recording wall is GONE** ✅ done 2026-07-19i (owner
  ruling: no fixed limit — memory is the only limit): at ARM the
  content buffer becomes a huge VIRTUAL reservation (~6.7 h at
  44.1 kHz, `ClipNode::kMaxTakeSamples`; address space only — the OS
  commits pages as capture writes, so a take costs exactly what it
  records). Post-commit COMPACTION (`AudioEngine::compactIdleTakes`,
  app heartbeat) swaps an exact-size buffer in atomically — content is
  behind ONE atomic pointer, old buffers retire via the reclaimer, so
  the swap is safe under an actively rendering clip; keep =
  recordedLength so a lock-collapsed definer retains its material for
  uncollapse. The integrity guard at the reservation bound
  auto-finishes CLEANLY at the last boundary that fits (capHit
  surfaced; never a silent zombie). loadCommitted sizes exactly (long
  saved takes no longer truncate to a prior capacity). Pinned by
  `tests/take_capacity_tests.cc` (70 s take intact; compaction
  bit-identical; wall-guard clean commit; collapse+compaction+
  uncollapse round trip).
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

- [x] **Reify `TimeMap` as a type** — ✅ done 2026-07-21 (pulled
  forward as phase 2's foundation per owner direction: phase 2 must be
  segment-general from day one): `src/time_map.h` ↔ `ui/js/time_map.js`
  POD value type (segments, `period`/`mapOffset`/`seamDistance`),
  pinned by `time_map_cases` goldens incl. multi-segment + sub-Q punch
  vectors; consumed by `childContext`, `getEffectivePeriod`,
  `snapEffectivePeriod`. Multi-segment STORAGE (`setSegments` bridge,
  atomic immutable segment publication, session_io) rides with the
  phase-3 editor — the math and every record/playback consumer are
  already segment-general.
- [x] **time_maps.md phase 2** — ✅ done 2026-07-21: recording through
  an active map, end to end. Heard-time arm on the map-period grid
  (`island_pos` invariant clock + map facts on ProcessContext; Q15
  fold subsumed), capture fold through the frozen map
  (`timing::throughMapDest`, dense zero-initialized `[0, C)` commit,
  literal silence in unvisited regions), one-period cap (auto-finish,
  clamped stops), commit at the mapping node's full inner cycle (no
  epoch re-base), compaction keeps `max(recordedLength, duration)`.
  PLUS: sub-block seam splitting in StackNode control/render (§5 —
  playback through maps now sample-exact across mid-block seams,
  pinned by the I1 block round-trip test); nested-active-map arms
  refused (phase-3 scope); mid-take map edits REFUSED (owner-ruled;
  siblings editable); UI cue (ruling 5: "⟲ NQ map" rail cue + amber
  capped bar + "⟲ map live" on the group) and the extension-2
  sweep-vs-bracket fix for sole top-level stack windows. Latent
  `armTarget` bug fixed en route (final-partial-Q arm in an unsnapped
  context folded into the past; now arms at the context top — both
  mirrors, golden-pinned). Engine + mock + VM in lockstep. Pinned by
  `tests/time_map_record_tests.cc` + `ui/js/tests/map_record.test.mjs`;
  verified in the mock preview. (Also fixed: `index_test.html` had
  drifted from `index.html` — missing `create-row`/`selection-bar`
  crashed the harness at init since 2026-07-19g.)
- [x] **time_maps.md phase 3** — ✅ done 2026-07-22, FULLY FRACTAL
  (owner ruling: "clips too, now"): multi-segment storage (one atomic
  pointer per node + reclaimer retire), `setSegments` (validated,
  undoable via `Edit::Segments` with raw-state inverses, n≤1 delegates
  to the single-window path, mid-take gated), bridge 3-place +
  `segments` metadata + `segmentsQ` persistence (additive; templates
  strip). THE ANCHORING LAW: clip map playback = mapOffset((t − origin
  − mapOffset(0)) mod period), run-split seam-exact in ClipNode::render
  — the whole legacy suite passes byte-identically. Q13 generalized:
  segments re-trim of the sole definer re-establishes (Q := period,
  epoch := origin' + mapOffset(0), phase-preserving via the new
  `heardOffsetOf` inverse); multi-segment lock-collapse = SPLICE COPY
  with a buffer-owning edit inverse (undo un-splices). THE SEQUENCER
  (§4): map_edit.js pure algebra + ✎ editor (click = toggle Q cell,
  drag = punch with linked kQ edges, Alt = free cut "N.NNQ ⚠", one
  commit per gesture); resting display = dims + seam ticks + `map · NQ`
  chip; heard-view lanes tile concatenated segment content; children
  of a mapped group project its excluded regions as dims. Engine-level
  record-through-cells pinned over the real callback path. Deferred
  (post-field): zero-crossing micro-snap, seam audition, per-segment
  edge drag, true heard-frame child unroll, multi-segment top-level
  cursor mapping.
- [x] **Fractal output stage** — ✅ done 2026-08-06 (order follows the
  SHIPPED stereo/pan chain, fx before the scalars): per-node
  `sum/render → time-map → fx → gain·pan → parent`, identical at every
  level (I5) via `outputStageGains` (audio_node.h). Adds the missing
  **gain** primitive: `AudioNode::gain` atomic, [0, 1] — unity default,
  attenuate-only per the pan no-boost law (boost lives in comp makeup);
  a mixer fact like pan (not undoable). Mute = gain 0 AT THE STAGE
  (fixes D1; container mute beats a soloed child); solo stays
  leaf-resolved (a container applying the ancestor rule would silence
  its own soloed descendants). Transport /`is_playing` gating is
  UNCHANGED at the top of clip render — the full three-mechanism
  collapse was deliberately not forced (no behavior to gain from it
  yet). Bridge `setNodeGain` (3-place), `gain` in metadata +
  session_io (ABSENT KEY LOADS UNITY — legacy sessions), UI gain dial
  in the rail head (vertical drag = the axis it represents, dblclick
  = unity, amber below unity; dial family shrunk 22→18px — two dials
  now share the head row and group-rail names pay for every pixel).
  Pinned: tests/output_stage_tests.cc, ui/js/tests/gain.test.mjs, two
  real-input e2e specs. Mono→Stereo's "one bus" was largely delivered
  by the 2026-07-27 stereo work; the stage is now that bus's one exit.
- [x] **One-shots as a period-source knob** (Q5 ruling) — ✅ done
  2026-08-06: `AudioNode::period_from_context_` stores the kernel
  triple's period source; a one-shot clip renders
  content[(t − origin − a0) mod CONTEXT_CYCLE] with honest silence past
  its length (rest regions feed the fx rack, so echo/reverb tails ring
  out). The context cycle is a fact PASSED DOWN
  (`ProcessContext.context_cycle`, the P1-6 pattern): each stack gives
  its children lcm(Q, its LOOPING children's effective periods) — map
  period when mapped, the received cycle when the scope has no loops of
  its own. One-shots are EXCLUDED from every composition fold
  (stack/snapshot intrinsic + effective, mock, VM, timeline model):
  they adopt the scope cycle, never extend it, which is what keeps a
  composite honestly periodic in its claimed period (I1). Clips only
  (a stack has no origin to anchor a firing to — fractal one-shot
  groups deferred); UNDOABLE (`Edit::PeriodSource` — a musical fact,
  unlike the mixer knobs); bridge `setPeriodSource` (3-place),
  `periodSource` metadata + additive persistence (absent = loop).
  Display per canon: dashed take tile, NO ghost repetitions
  (recording.md Example 3); ↺/1× toggle chip in the clip rail HEAD
  (the foot row is at width). Windowed one-shots fire the window
  segment once per cycle. Pinned: tests/one_shot_tests.cc,
  ui/js/tests/one_shot.test.mjs, two e2e specs (incl. undo + the
  frame-never-extends check).
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
  - [x] **Projects (docs/projects.md)** ✅ done 2026-07-19f
    (owner-ratified model): a project is a dated FOLDER
    (`YYYYMMDD-NN` = ID; rename never moves it; loading never reads
    the folder name → portable), BORN at the first committed take,
    continuously MIRRORED after (incremental take wavs — immutable
    post-commit, lock-collapse triggers the one legit rewrite; crash
    loses ≤ the take in flight). Templates = performance-stripped
    projects (pre-Q by construction) with save-as/new-from; recents;
    duplicate-to-next-serial (the -02 habit). `ProjectManager` +
    session_io SaveOptions + 9 bridge methods (3-place) + empty-state
    template/recents UI + header rename. Pinned by
    project_manager_tests.cc; verified in the mock preview. Deferred:
    orphan pruning, device-aware input fallback, auto-open default
    template, cross-rate load.
  - [x] **Step 3: whole-graph immutable snapshot** ✅ done 2026-07-19d
    (core; see carve-outs): `src/graph_snapshot.h` — flat DFS arena
    (entries + packed child spans), built on the message thread after
    every STRUCTURAL edit (`AudioEngine::publishGraph`, called from the
    applyEdit wrapper + loadSession), loaded ONCE per callback into
    `ProcessContext.snap`. Stacks iterate child index spans; leaves
    resolve solo-ancestry by parent indices; island facts (quantum,
    invariant epoch, island root) ride the context; audio-side cycle
    math lives in snapshot-space free functions (`snapIntrinsicDuration`
    / `snapEffectivePeriod` / `snapEffectiveCycle`). DELETED:
    `render_children_` + `republishChildren` + `getChildrenSnapshot` +
    per-stack reclaimer plumbing (`setReclaimer`/`retireOrDelete`) +
    `removeChild(uuid)` + the dead `forEachChild` LCM visitor; node
    traversal virtuals and parent walks are message-thread-only now
    (raw pointers off one atomic load — no shared_ptrs, lifetimes on
    the engine graveyard, exactly per the RT-trap note). The live-take
    carve-out holds: snapshots pin STRUCTURE, per-node state stays
    atomics, so capture/commit need no republish. performance.md §1
    updated (rules + checklist), pinned by
    `tests/graph_snapshot_tests.cc` (builder shape, snapshot-vs-node
    math agreement, publish discipline incl. undo/redo). **Deferred
    from Step 3's original text:** bridge collapse to `apply(edit)`
    (UI-facing, not kernel) and the §2.3 pure-render split (§2.3 is its
    own item below).
- [x] **Pure render function** ✅ done 2026-07-19e (§2.3):
  `AudioNode::process` = non-virtual `{ control; render; }` sequencer —
  control (arm/boundaries/capture/commit) settles across the WHOLE
  graph before the first sample renders; `render(outputs, ctx) const`
  is the kernel equation with compiler-enforced purity (`mutable` only
  on DSP scratch + playhead telemetry). Commit-block silence preserved
  via a per-clip gate (historical semantics, bit-for-bit). Pinned by
  `tests/render_purity_tests.cc` (golden determinism, musical-state
  invariance, gate sequencing, fractal purity through stacks).

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
  - [x] **UI affordance** ✅ done 2026-07-16: `view_model.js` exposes
    `soleQDefinerId` + per-lane `isQDefiner`; the sole clip's loop handles
    are always shown (even at 1Q — `latentWindow` override), styled
    tempo-red ("sets tempo · drag to trim" chip), and drag FREE (sub-Q)
    with a live `Q = N.NNs` readout since they DEFINE Q rather than snap
    to it. Mock derives Q from the sole clip's window (parity). Pinned by
    `ui/js/tests/q13.test.mjs`; verified in the preview (drag → Q changes,
    undo restores). Field-motivated: trimming dead air out of the scratch
    loop before building on it.
  - [x] **Phase + cursor fixes** ✅ done 2026-07-19 (from the two-cursors
    field bug): clip-window playback now anchors at `origin + loopStart`
    so island phase 0 audibly IS the trimmed loop's top (the time_maps.md
    "deliberate asymmetry" bit — resolved; pinned sample-exact in
    `qtime_lock_tests.cc`); the ONE playhead maps into the selection
    (`vm.loopStartQ`, animator wraps in loop coords) and the lane's amber
    cursor is gone; re-trim gated on `!hasActiveTake()`; loop points
    clamped to the buffer (engine + mock + fractional drag clamp); island
    Q now STORED in the mock (`state.islandQ`) and published top-level
    (`quantum`) engine+mock, the VM prefers it over min-derivation — the
    JS side of P0-3 done; echo tiles follow the new anchoring
    (`echoReps` first ≡ offset + winStart).
  - [x] **LOCK-COLLAPSE** ✅ done 2026-07-19b (owner ruling — the
    unifying simplification): arming take 2 makes the trimmed region
    THE take (`Edit::CollapseTake`: duration := Q, origin := epoch,
    window consumed, `ClipNode::content_base_` shifts; undoable; save
    writes the collapsed take). Kills the incommensurate-buffer bug
    class at the source — off-grid take anchors (origin − epoch =
    56298), exploded frames, mismatched cursors. `commensuratePeriod`
    (timeline_model) stays as a defensive display net. Engine + mock
    parity; VM trim view ends at ARM (matches the hasActiveTake gate).
    Pinned: qtime_lock_tests.cc (collapse + on-grid take-2 anchor +
    undo/redo; content-base playback sample-exact), q13.test.mjs.
  - [x] **Re-open uncollapse + phase-preserving trim** ✅ done
    2026-07-19c (field): deleting back to one clip UNCOLLAPSES the
    survivor (full material returns, old trim = window, audio-neutral;
    undo re-collapses via the Insert edit's uuid2 rider); provisional
    re-trims RE-ANCHOR origin (`Edit.setsOrigin/iorg` rides LoopPoints)
    so the sounding position never jumps while nudging handles. Engine
    + mock parity; pinned in qtime_lock_tests.cc (re-open restore +
    undo/redo; exact position continuity) and q13.test.mjs.
- [x] **Heard-frame windows (law 13 amended)** ✅ done 2026-07-20
    (owner-chosen design A from three mocks): windowed clip lanes REST
    in heard time — window content tiled at its audible positions,
    frame = audible loop, one honest cursor, "window NQ" chip; grabbing
    an edge grip or the chip EXPANDS the lane to its full raw take on
    its own scale (per-lane trim view: brackets, dims, amber cursor,
    done/Esc). vm windowEdit view state; lane.frameQ threads a
    per-lane scale through the patch layer; renderer tone follows
    ghostness (bright src tiles are warm). Supersedes Q14c clip echo
    rendering. See time_maps.md phase-1-extension-4.
- [x] **Track Controls — close-out (Q16, ruled 2026-08-13)** ✅ done
  2026-08-13: per-node Play/Stop is SUPERSEDED (one transport + Q10:
  "play this node" = solo + transport, "stop this node" = mute — no
  third audibility state). SOLO CANON pinned and implemented:
  island-wide, ADDITIVE, fractal (I5) — solo moved from the engine's
  single `soloed_node_uuid` to per-node atomic flags (`is_soloed`,
  published as `isSoloed`; `soloedId` is gone), resolved per callback
  from the snapshot (`snapAnySolo` + ancestor walk — no republish, no
  cached pointer, deleting a soloed node just drops out of the scan);
  not undoable (mock parity). The old single-solo was EXCLUSIVE — the
  additive canon is a behavior change, not just a pin.
  - [x] `tests/solo_tests.cc` names all three properties (+ mute-beats-
    solo + the no-snapshot fallback) via distinct-amplitude DC clips;
    twin `ui/js/tests/solo.test.mjs` pins the state contract (per-node
    additive flags, vm exposure incl. groups, not-undoable).
  - [x] Vestiges deleted: engine+bridge+protocol+mock `togglePlay`,
    `ClipNode::stopPlayback`; `is_playing` survives as the internal
    content-sounds gate only.
- [x] **Creation Menu = template picker (Q17, ruled 2026-08-13)** ✅
  done 2026-08-13 — every + opens the SAME menu
  (`session_view/creation_menu.js`): fixed "Track" default row anchored
  under the cursor (click-click = bare track), the user's subtree
  templates below (fetched per open — the input-menu pattern), "Save
  as template" row when one lane is selected. No "New Box" item —
  groups stay post-hoc (2026-07-19h) or arrive whole via a group
  template.
  - [x] Engine: `src/track_template.h` (capture/build/countClips;
    structure + names + inputs, additive format) +
    `AudioEngine::{capture,insert}TrackTemplate` (insert = ONE
    undoable Edit::Insert) + `ProjectManager::{trackTemplatesRoot
    (<base>/TrackTemplates — global user-level), saveTrackTemplate,
    listTrackTemplates, createFromTrackTemplate}`.
  - [x] Bridge (3 places: main_component + protocol.js + mock) —
    `listTrackTemplates` / `saveTrackTemplate(uuid,name)` /
    `createFromTrackTemplate(name,parentUuid?)`; mock twin
    `mock/track_templates.js`, createFrom in the UNDOABLE set.
  - [x] Menu UI on all three + affordances (top-level ＋ Track, group
    rail +, add-row — group entries insert into their group);
    Escape + outside-press dismissal ride the existing dispatchers.
  - [x] `R` with an empty project creates + arms the default track
    (app.js onRecordKey zero-lane case — the one-key spark).
  - [x] Boot EMPTY: `ensureLaunchSession` + `autoLoadLastTemplate` +
    `createDefaultSession` deleted (mock boot-ritual too); session
    templates stay explicit in the projects UI;
    `lastTemplateName` survives as bookkeeping.
  - [x] Tests: `tests/track_template_tests.cc` (capture round-trip,
    fresh-uuid build, ONE-undo insert, PM disk round-trip + junk-file
    tolerance) + `ui/js/tests/track_templates.test.mjs` (mock twin) +
    5 e2e specs (menu default click-click; template insert
    names+routes+undoes-whole; save-from-selection; drum group →
    group ● arms all (Q7); R-on-empty spark). Suites after: C++ 31
    suites green (sandbox: stereo_pan env-excluded), JS units 25
    files green, Playwright 47/47.
- [x] **Selective Recording** — ✅ SUBSUMED 2026-08-12/20: "record
  into specific nodes" is Q7 group arm + the `R` key (below); "record
  into a specific STEP" is Sequencer step 2 (Tier 4b). What remains of
  the original idea is **takes** (re-record a committed clip —
  alternate content buffers sharing one origin/period), tracked under
  Tier 5.
- [x] **Group arm (Q7 ruling)** — ✅ done 2026-08-12: the ENGINE owns
  the cascade — `startRecordingInNode`/`stopRecordingInNode` accept any
  node; a stack target resolves every EMPTY Idle clip beneath it and
  arms/stops the whole set in ONE message-thread call (the UI's old
  per-clip bridge loop could straddle an audio block and split the
  group across two boundaries). Arm targets emptiness at the engine
  level too (direct arm on a committed clip is refused — re-recording
  is the *takes* feature). Two simultaneity fixes rode along: the
  group-stop path snapshots island-Q BEFORE any stop runs (a
  first-take group stop's first commit establishes Q, which flipped
  the siblings onto the record-to-next-boundary path — they'd run a
  full extra Q; `ClipNode::stopRecording(bool)` overload), and the
  mock gained arm-cancel parity (stop-while-pending un-arms instead of
  wedging into a phantom awaiting-stop). Mock + UI in lockstep
  (`onArm` is now one bridge call on the lane's own id; the mock
  treats `mock-root` as a stack over the whole graph). **The I2
  simultaneity invariant test now exists**: `tests/group_arm_tests.cc`
  (first-take group → one origin/one duration/one Q; mid-cycle group →
  shared Q11 boundary; committed member untouched; group cancel
  balances the take counter) + `ui/js/tests/group_arm.test.mjs` (mock
  twin). Companions still open: **templates** (saved subtrees) and
  **takes** (alternate content buffers sharing one origin/period —
  deferred).
- [x] **`R` = the record key** — ✅ done 2026-08-12 (field request):
  pressing `r` presses the selected track's (or group's) ● — group
  targets cascade per Q7. Stop is SELECTION-PROOF: while anything
  records, `r` stops it all via ONE engine call on the island root
  (the selection may have changed mid-take; a stop that silently
  no-ops while tape rolls is the worst failure mode). With nothing
  hot: records the selected lane; no selection + exactly one
  top-level lane → that lane (＋ Track → `r`, no click). Wired in the
  session-view keyboard dispatcher (no-modifier, not-typing gate,
  like the zoom/teleport keys); handler in app.js `onRecordKey`.
- [x] **Space stops recording too** — ✅ done 2026-08-21 (field: "space
  bar stops playback but not recording, it should do both"; `r` stays
  the record key). With a take rolling, Space requests the stop (the
  take finishes to its boundary — stops always pad forward) and the
  transport pauses the moment it lands; pausing the clock first would
  strand the take. A second Space before it lands pauses at once.
  Without a hot take: plain pause/resume. app.js `onSpace` +
  `settlePendingPause` (poll hook); e2e "SPACE stops recording too".

### Stacks / UI (pre-audit backlog, 2026-03 — owner to re-rule)
> Untouched since the March round and written before the unification
> audit; kept as candidates, not commitments. Composite waveform
> rendering was rewritten by D13 (audible-content composite) and the
> heard-frame lanes; "Combine into Stack" exists as drag-combine
> (Edit::Combine) — multi-select is the missing half; drill-in/ZUI is
> Tier 5.
- [ ] Cache invalidation optimization (composite waveform) — revisit
  only if the perf meters show it.
- [ ] Multi-select → "Combine into Stack" (drag-combine + templates
  cover the single case today).
- [ ] Drill-in mode (double-click) + keyboard navigation + quick
  expand/collapse shortcut → folded into Tier 5 "ZUI navigation".
- [ ] Ghost coordinate mismatch for stack children (drag & drop);
  verify drag-drop end-to-end (e2e drag specs exist since 2026-08-13 —
  confirm the ghost case is covered, then close).

### Effects
- [x] **VST3 hosting** — ✅ phases 1–5 DONE (2026-08-15 / 2026-08-18,
  docs/vst3.md §8/§10): dynamic FxChain, VST3 effect + instrument
  slots, editor windows, MIDI input, MIDI takes as a ClipNode content
  kind. Owner-committed (`75fad92`).
  - [ ] **Phase 6 — polish**: all-notes-off on stop/mute/solo-silence
    (sound-off to the instrument, not event starvation — more pressing
    now that mute rings tails through the S7 gate), instrument state in
    take undo entries, piano-roll-ish MIDI lane rendering, SysEx, a
    note held across the take's start boundary, out-of-process
    scanning, AU. PDC stays deferred indefinitely (Q-V2).
  - [x] vst3.md §8 prose updated 2026-08-20 (mute = the S7 pre-fx gate).
- [x] **Stereo rack** — ✅ delivered by the 2026-07-27 stereo work + the
  Tier 3 output stage (stereo fx accumulator, Q-V1 promotion in
  FxChain::run, pan post-chain). Mono→Stereo *recording* remains a
  Tier 5 item.
- [x] **Effect tails on mute** — ✅ RESOLVED 2026-08-20 by the S7
  smoothness law (docs/sequencer.md §5/§9): mute is now a ramped
  PRE-FX gate (~10 ms), the rack keeps running, tails ring out.
  Pinned in sequencer_tests.cc ("MUTE rides the same gate").

### Clip manipulation (Segment 5)
- [ ] Move clips in 2D space; resize durations via UI handles.

### Tests
- [x] **Verify existing C++ test coverage; catalog pass/fail** — ✅
  done 2026-08-12: see **docs/test_audit.md**. 30 suites; 29 ran (211
  sections, 0 failures, Debug binary per the gotcha); Stereo & Pan
  crashes in the Linux audit sandbox only (double-free, reproduced on
  a PRISTINE checkout → environmental, not a regression; green on
  macOS 2026-08-11 — one Mac confirmation run closes it).
- [x] **Audit JS unit/E2E test health** — ✅ done 2026-08-12
  (test_audit.md): JS units 23 files / 169 tests / 0 fail / 0 skipped;
  Playwright 42/42, 0 skipped, 0 flaky. The archive's "2 of 4
  collapsed-stack tests still skipped" is moot — zero skips remain.
- [ ] E2E: recording inside expanded stack; collapse → playhead
  constrained; drag visual feedback + grid lines for collapsed stacks.
- [x] **New invariant tests the audit motivates:** ~~stack-mute
  audibility (D1)~~ ✅ (output_stage_tests.cc, 2026-08-06), ~~I2
  simultaneity test~~ ✅ (group_arm_tests.cc, 2026-08-12 — pinned at
  the source: takes performed together commit with one origin and one
  duration), ~~stop-boundary race regression (D2)~~ ✅ was never
  actually missing — pinned since 2026-07-16 by clip_node_tests.cc
  "stop boundary is picked by the AUDIO thread" (audit 2026-08-12
  found the tracker line stale, not the test).

## Tier 4b: The Sequencer (docs/sequencer.md — direction ratified 2026-08-19)

The fractal per-stack Sequence (steps + gates); rulings S1–S14 recorded
in docs/sequencer.md §0/§9. Build order as ruled:

- [x] **1. Core** — ✅ done 2026-08-20: `src/sequence.h` (steps ≤ 64,
  uint64 gate masks, the PURE gate envelope — schedule-derived, so
  render output never depends on block splits), storage on StackNode
  (atomic pointer, `map_override_` discipline, bypass flag separate),
  gate playback per S7 (pre-fx: the parent hands each child exact
  (g0, g1) envelope endpoints — forEachSeamRun splits blocks at
  envelope corners; mute/solo moved onto the SAME ramped pre-fx gate,
  so tails RING through a closed gate — the "effect tails on mute"
  item below is resolved), period law (StackNode::getEffectivePeriod +
  snapEffectivePeriod twins; sequence context_loop/context_cycle for
  record-over-the-song), `Edit::Sequence`/`Edit::SequenceBypass`
  (copy-swap-retire, raw-state inverses), bridge in all 3 places
  (`setSequence`/`toggleSequence`), mock twin (mock/sequence.js +
  cycles/publish/undo/state), session save/load (additive `sequence`
  block, lenQ as QTime), track templates carry sequences (S14 —
  lenQ counts, gates re-keyed by child index like inputs), VM (period
  law in frame math, `seqDims` lane projection, `seq:` grid rows), UI
  (rail `seq` chip on group lanes + the pad grid per the ruled
  grammar: pad toggle/paint, row toggle, step rename/resize/delete/
  append, bypass footer, playing-column highlight). Pinned by
  tests/sequencer_tests.cc (envelope math, period law + snapshot twin,
  concatenation, fractal gates, I1 entrance phase, S7 ramps +
  block-split purity + ringing tails incl. mute, heard frame, engine
  verbs/undo/mid-take gate, session + template round trips),
  ui/js/tests/sequence.test.mjs (mock twin, 7 tests), e2e
  sequencer.spec.js (grid lifecycle with real input, period law in
  the readout, rename/delete). Suites after: C++ all green (solo/
  output-stage/midi mute pins updated to settled-fade reads), JS units
  29 files green, Playwright 56/56. The ROOT sequencer ships too
  (same day, after the owner's loose-clips field report): a
  transport-bar `seq` chip beside the odometer opens the session
  root's grid as the first row over the top-level tracks — no
  grouping required (`#root-seq-btn`, vm.rootSeq/rootId; pinned by
  the ROOT e2e + the root-grid-row unit test).
- [x] **2. Step recording + section audition** — ✅ BUILT 2026-08-20
  (docs/sequencer.md §11 design, §11.10 record): the step audition as
  a DERIVED window (`StackNode::audition_step_` → virtual
  `activeTimeMap`; `auditionStep` bridged 3-place + mock; grid header
  ⟲, Esc, ruler brackets for the root, chips), through-map record
  into it with **S18 = a step-sized part** (C = map period under an
  active sequence — no silence insertion, ruled), **TAKES ARE
  UNDOABLE** (Edit::Take/Untake, PendingTake reconciled on the message
  thread, group take = one step, refused while live), the **S19
  auto-gate** folded into the take's one undo step (direct children
  only), **S16** window domain (suspended, never deleted), and the
  **song-rides-the-epoch** re-base fix found en route. Tests:
  sequencer_tests.cc (+5 sections), tests/take_undo_tests.cc, JS
  audition/take_undo/frame_health units, 2 new e2e. Suites after: C++
  all green (sandbox, stereo_pan env-excluded), JS 32 files,
  Playwright 58/58 ×2. Owner commits.
- [x] **3. Nested sequences in UI** — ✅ BUILT 2026-08-20 (docs/
  sequencer.md §12): the period law on GROUP lanes (a sequenced group
  tiles at its song length; chip reads it), seq dims as COMPOSED
  LAYERS (outer scope over inner — `lane.seqDims[]`), one-shot echoes
  at the scope cycle, nested audition brackets restored, the "Fractal
  Drums" mock scenario + harness button; sequence.test.mjs + e2e
  "NESTED". JS 32 files green, Playwright 59/59. Owner commits.
- [ ] **4. Cue steps** — per-step epoch re-base = the Q6 serial
  primitive (`cue` reserved in the step format now, S11).
- [ ] **5. Successor graphs + the seed** — branch-with-chance /
  radio; root-only stochastic, seed stored as data (S12).
- [x] **Frame-health badge** (S10) — ✅ BUILT 2026-08-20 with step 2:
  `ui/js/frame_health.js` (pure; golden `frame_health_cases`), two
  faces (blowup > 4× largest member, attributed to the knob-bearing
  member whose removal heals the scope; drift = seqLen mod inner ≠ 0),
  shown on the responsible lane's chip, the grid footer (one-click
  snap, delta on the last step), the grip's live readout, and the seq
  chips. Closes open question 5 below.
- [ ] **Per-step fade control** (S13 future work, owner-requested) —
  `fadeInQ`/`fadeOutQ` on the step format ("fade this part out over a
  few seconds"); the anti-pop micro-fade ships in Core.
- [x] **S16** — ✅ RULED + BUILT 2026-08-20: `window_domain_` stamped
  by the LoopPoints/Segments appliers; a sequence-domain window is
  SUSPENDED while the sequence is off (metadata `windowSuspended`,
  dashed dim brackets + chip), returns with it, persisted additively.
- [x] **S15** — ✅ RULED 2026-08-20: the pad grid is the ONE control at
  every depth (root included — the root stack's rail chip); lanes are
  display (period law), not a second editor. Mockups:
  docs/mockups/sequencer_ux.html (round 1) / sequencer_ux2.html
  (round 2 — grid chrome, S17 flow, fractal drum demo).
- [x] **S17** — ✅ RULED + BUILT 2026-08-20 as proposed (⟲ → R →
  commit auto-gates → Esc); sequencer.md §11.3.
- [x] **S18** — ✅ RULED 2026-08-20: (a) EVERYWHERE — a step-take is a
  step-sized part; no silence insertion, ever (the (b) branch is
  dropped). Built.
- [x] **S19** — ✅ RULED 2026-08-20: takes ARE undoable (owner: "it's
  weird they aren't" — an accident of the July undo log, not a
  design); the auto-gate composes into the take's one undo step.
  Built (edit.h Take/Untake, tests/take_undo_tests.cc).

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
  transitions. **Largely subsumed by the Sequencer (Tier 4b)**: serial
  = cue steps; branch-with-chance = weighted successors; transitions =
  step fades.
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
- [ ] **Takes** — re-record a committed clip: alternate content buffers
  sharing one origin/period (the Q7 companion; was "Selective
  Recording"). Take commits ARE undo entries now (2026-08-20,
  sequencer.md §11.10) — the alternate-buffers half remains.

---

## Open Design Questions

(See design_language.md §5 for the full ruling record.)

| # | Question | Status / source |
|---|----------|-----------------|
| 1 | Max practical nesting depth before UI gets unwieldy? | open — stacks.md |
| 2 | Quantum mismatches between connected islands? | open — implementation.md |
| 3 | "Breaking out" a stack from an island — UX + implementation? | open — implementation.md |
| 4 | Connecting stacks after Q established — polyrhythmic interaction? | open — recording.md |
| 5 | Warning UX for very large LCMs (coprime durations)? | ✅ CLOSED 2026-08-20 — the frame-health badge (sequencer.md §11.6/§11.10): amber on the responsible lane, grid-footer snap offer, live grip readout |
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
