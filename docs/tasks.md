# Celestrian: Roadmap & Task Tracker

> Status: **tracker**. Rewritten 2026-09-01 after the foundation audit
> (the audit report and its recommendations are recorded in
> composition.md §0 and design_language.md Q18). The previous tracker
> (2026-07-16 → 08-31) is condensed into the archive at the bottom;
> every completed item keeps one line. Rules: one line per done item,
> dated; open items say what "done" means; the Open Questions table
> lists only questions that are actually open.

The foundation is complete: the kernel (one clock, origins on every
node, time-maps, QTime, immutable snapshots, pure render, the output
stage, the edit log) holds in code without exceptions and is pinned by
the test suite. What remains is (A) finishing the Q18 unification in the
UI and paying down the debt the audit listed, (B) the product features
between today's build and 1.0, (C) the sequencer's last step, and (D)
the vision beyond 1.0. Tiers E–G are follow-ups: E from building Tier
B, F from the Q hand-off, and G — the owner's questions and the open
items the 2026-10-12 cleanup audit left.

---

## What 1.0 is

**Launch, record a loop, build a song with the sequencer, bounce it to
a file, reopen it tomorrow.** Concretely, a musician with an interface
and no prior setup can:

1. open Celestrian to an empty session and press `R` (done);
2. record a scratch loop, trim it to define Q, then record a drum group
   and a bass over it, hearing themselves with no perceptible latency
   (done; software input monitoring is B1, ruled Q20);
3. shape parts with windows, cuts and one-shot groups (done — Q18);
4. arrange the parts into a song with the sequencer (done; no count-in
   by ruling Q21 — the scratch loop is the count-in);
5. bounce the song, or any node, to a WAV (done — B2, Q19);
6. save, quit, reopen, and find the session exactly as left (done);
7. install it from a signed build on macOS and Windows (B8).

Nothing in Tier D is required for 1.0.

---

## Tier A: Foundation follow-through (2026-09)

- [x] **A1 — Q18 in the UI** ✅ 2026-09-01 (code): group lanes carry a
  take mark, bracket/cut geometry on group lanes is inner-position
  offset by it, one-shot groups render dashed with no ghosts, the rail
  ↺/1× chip works on groups; mock in lockstep (`anchored` + `origin` on
  stacks, the settle rule, subtree origin shifts) — pinned by
  `ui/js/tests/stack_origin.test.mjs`, VM tests and an e2e.
  **Owner's part still open:** a field session with the five-mic drum
  group as a one-shot (the 1.0 checklist in test_harness.md, step 5).
- [x] **A2 — One window storage** ✅ 2026-09-01: a node's geometry is
  ONE inline `TimeMap` behind a seqlock (`AudioNode::storedMap` /
  `setMap`; a window is the n = 1 case) — the loop atomics, the heap
  override pointer, its reclaimer retirement and the LoopPoints/
  Segments normalization are gone; inverses carry the raw old map.
  Same pass: `timing::posMod` replaces ten hand-rolled folds; ONE
  message-thread effective-period fold (`StackNode::effectivePeriodOf`,
  `periodExcluding` deleted; the snapshot twin stays for the audio
  thread); `Edit::TakePayload` embeds `ClipNode::TakeState` (the
  13-field copy is gone).
- [x] **A3 — Delete the snapshot-less fallback path** ✅ 2026-09-01:
  node-level tests build a real `GraphSnapshot` through
  `test_utils::contextFor` (the callback's test-side twin: `refresh`,
  `rebuild`, `driveFrom`); `ChildView`'s ownership branch, the
  snapshot-or-children folds, and every audio-thread
  `getEffectiveQuantum()` / `rootNode()` / parent-pointer solo walk are
  gone; `process`/`control`/`render` assert the snapshot and island.
  The parent walks survive only on the message thread.
- [x] **A4 — `is_expanded` leaves the engine** ✅ 2026-09-01: folded
  groups are UI-local (`ui/js/view_prefs.js`, per project id in
  localStorage, session-only before a project is born); `toggleStackExpand`
  and `isExpanded` are gone from all three layers. Expansion is
  unrepresentable in the engine — I6b by construction.
- [x] **A5 — `setNodePosition` and node x/y removed** ✅ 2026-09-01:
  `Edit::Kind::Position`, the verb, the metadata, the session fields and
  every mock fixture literal are gone; older sessions load (unknown keys
  are ignored). `Segments` is the only coalescing edit kind.
- [x] **A6 — Split `audio_engine.cc`** ✅ 2026-09-01 (no behavior
  change; one class, its members by concern under `src/engine/`; the
  file list as of 2026-10-12): `island_geometry.cc` (`setDefiner`,
  continuity, anchoring, Q re-establishment, scrubs, the drift log),
  `definer.cc` (who defines Q: the one-take shape, the definer and the
  definer stack), `edit_log.cc` (the log itself: the kind table,
  `applyEdit`'s dispatch, the live-take gate, gestures, undo / redo),
  `edit_structure.cc` / `edit_geometry.cc` / `edit_takes.cc` /
  `edit_facts.cc` (one applier per edit kind, each with its inverse;
  `edit_internal.h` is what they share), `take_service.cc` (arm, group
  arm, settle, compaction), `transport.cc` (play/seek/state, waveform
  and note reads), `verbs.cc` (node and chain verbs), `map_edits.cc`
  (windows, segments, re-time, sequences — one `commitMap`),
  `import.cc`, `bounce.cc`, `audio_callback.cc` (the ONE audio-thread
  file — performance.md §1 reviews it), `device_service.cc` (device,
  calibration, MIDI inputs). `audio_engine.cc` keeps construction,
  publishGraph, the reclaimer and save/load.
  `engine/engine_internal.h` declares the helpers shared across files
  (the tree walks, the definer's laws, the take settle).
- [x] **A7 — One keyboard dispatcher** ✅ 2026-09-01: `ui/js/keys.js`
  (`registerKey` with one typing guard, Cmd/Ctrl normalization and
  scopes APP < VIEW < PANEL); the four module listeners are gone. The
  one intended change: Escape with a panel open closes only the panel.
  gesture.js keeps its transient capture-phase Escape for live drags.
- [x] **A8 — Small residue** ✅ 2026-09-02: `ProcessContext::is_recording`
  is gone (it was always true; capture is gated by the node's own
  state — 70 test writes and the one test that only exercised the flag
  deleted); `playheadPercent` is gone from both timing mirrors and the
  golden vectors (no caller in either). `window.__mapDbg` gating ✅
  `ui/js/debug_flags.js` (a leaf module; the recorder exists only with
  `?debug=true`).
- [x] **A9 — Comment hygiene rule** ✅ 2026-09-01: the rule is in
  .agent/style.md and a full present-tense pass ran over src/ and
  ui/js + ui/css (comment-only, verified by stripping comments and
  diffing).

- [x] **A10 — Kernel audit Tier 3 (the island and the root)** ✅
  2026-09-10 (ultracode_analysis.md §6 status note): D14-1 stage 1 —
  attaching content writes no island facts (`maybeEstablishQuantumFrom`,
  `scrubNestedIslandFacts` and the load-time scrub are gone; the NESTED
  FACTS test pins it); D15-1 — one frame-top law for every node (the
  root's frame top IS the zero by the 2026-09-09 never-anchored ruling;
  the bounce's root branch collapsed into the node branch, `zero + a0`
  under a root window; the S21 lookup reads the owning stack's song
  position through `heard::songPositionAt`); D7-3 + D15-8 — the root
  is ONE node record (`root`) in a version-2 bundle, loaded onto the
  live root through `session_io::applyNodeFacts` (version-1 bundles
  load); template step lengths are exact QTime (D7-4; legacy doubles
  build). Stage 2 (the `Island` record) waits for Tier D islands.

## Tier B: Product to 1.0

- [x] **B1 — Software input monitoring** ✅ 2026-09-02 (ruled Q20):
  `ClipNode::render` adds the block's pre-record-ring arrivals into the
  clip's dry signal ahead of the gate and rack (rack, gain, pan apply;
  zero added latency; never in a bounce); the rail's "mon" chip toggles
  it (off by default, not undoable, persisted + in templates) with the
  calibrated round trip in its tooltip; mock parity, one e2e.
- [x] **B2 — Bounce / export** ✅ 2026-09-02 (ruled Q19, docs/bounce.md):
  `AudioEngine::bounce` renders the root for one effective cycle (any
  node for one effective period) through the callback's own context
  builder to a stereo float WAV with the −90 dBFS tail; `bounce` /
  `bounceWithDialog` bridge verbs + mock twins; "Bounce song…" / "Bounce
  selected…" in the project menu; the golden in tests/bounce_tests.cc
  pins bounce == live render sample for sample.
- [x] **B3 — Count-in and metronome: CLOSED (ruled Q21, 2026-09-01).**
  No meter, no tempo, no beat to click on; the scratch loop is the
  count-in. A single Q-top pulse is a possible later option only.
- [x] **B4 — Takes and comping: ✅ engine + UI** (docs/takes.md). ● on
  a committed clip/group = `newTake`; the `T<a>/<n>` chip + take list
  (select / delete / mini waveforms); comp cells over the tile (one
  `setComp` per click, tinted slices at rest); ⌘Z throughout;
  ui/e2e/takes.spec.js drives the three flows.
- [x] **B5 — Master bus: ✅** the transport's master strip — root fader (`setNodeGain` on `rootId`), post-fader VU with peak-hold and clip latch, master fx chip opening the root's rack, root gain/pan persisted (`rootGain`/`rootPan`, absent = unity).
- [x] **B6 — Audio file import: ✅ 2026-09-02** (docs/import.md). A
  WAV/AIFF/FLAC becomes a committed take on the nearest Q boundary —
  a first take (hysteresis-snapped; pre-Q defines Q) or a new take of a
  committed slot (cut to the period); undoable; `importAudio` /
  `importAudioWithDialog`. UI: drop onto a lane body at the pointer's
  Q (a sandboxed WebView hands the page no path → the chooser at that
  Q), "Import audio…" in every + menu and the project menu.
- [x] **B7 — VST3 phase 6 polish: ✅ 2026-09-02.** engine (docs/vst3.md
  §11: sound-off edges, instrument state in take undo entries, boundary
  notes, worker-only scanning, AU) + UI: MIDI lanes paint note bars
  from `getMidiNotes` (pitch → row over a compact range fit, length →
  width, velocity → alpha), tiled like audio so windows/cuts/comps
  apply (ui/js/midi_notes.js, canvas_renderer.drawMidiTile).
- [ ] **B8 — Distribution.** Packaging scaffolding ✅ 2026-09-02:
  `scripts/package_macos.sh` (hardened-runtime sign → notarize →
  staple → zip; `scripts/celestrian.entitlements`) and
  `scripts/package_windows.cmd` + `scripts/celestrian.iss` (signtool +
  Inno Setup), identities from the environment only (README).
  Preferences panel ✅ 2026-09-02: the transport's gear opens the one
  panel — audio device pickers, latency calibration, the projects root
  (`chooseProjectsRoot` / `setProjectsRoot`; ui/js/preferences.js).
  Still open: the owner's certificates and a first notarized build;
  crash-safe project mirroring verified in the field.
- [ ] **B9 — Field checklist for 1.0.** One scripted session (the 1.0
  paragraph above) run on macOS and Windows with a real interface.

## Tier C: The sequencer's last step

- [x] **C1 — Successor graphs + the seed** ✅ 2026-09-02 (sequencer.md
  §14): `Step::next` = weighted successors, `Sequence::seed`; finalize
  unrolls the PROGRAM (visits) — periodic when the deterministic walk
  returns to step 0, else a RADIO (root only, S12; nested blocks demote
  on load) unrolled to a 256-visit horizon. Every consumer (gates, cue,
  audition, period, frame) reads the program; the JS mirror
  (`ui/js/sequence_program.js`) is golden-pinned against the engine.
  UI: visit columns, the → successors popover, orphan chips, the radio
  badge + ⟳ re-roll. Same pass: the ROOT's sequence is now persisted
  (`rootSequence`) — it was lost on reopen before.
- [x] **C2 — Per-step fades** ✅ 2026-09-03 (S13, sequencer.md §15):
  `Step::fade_in`/`fade_out` (samples; `fadeInQ`/`fadeOutQ` in session +
  templates, retimed with Q) shape a gate run's ramps at its first/last
  step, floored by the anti-pop micro-fade, shrunk proportionally when
  they do not fit; the seam-run corner distance is mask-aware so block
  splits stay exact. UI: the length chip's fades popover + ◢/◣ markers;
  lanes draw the ramps as gradients.
- [ ] **C3 — Nested stochastic sequences** (proposed under S12): refused
  by rule today (a nested block that unrolls to a radio is demoted to
  the loop on load; the verb refuses). Legalizing it would mean treating
  the horizon total as a period — a different rule from "no period";
  decide only if field use asks.

## Tier D: Vision (post-1.0)

- [ ] **Warp** — a rate term on `TimeMap` (well-defined now that every
  node has an origin); WSOLA time-stretch; nested tempi as per-subtree
  exchange rates.
- [ ] **Islands** as first-class objects; inherit-vs-new-song; one
  active island for now (Q10).
- [ ] **ZUI navigation** — dive/exit, transitions, multi-select →
  combine.
- [ ] **Corpus & radio** — library metadata (BPM, key), procedural
  combination, the infinite station (C1 is its engine).
- [ ] **Automation** — hierarchical envelopes as a VCA on the output
  stage.
- [ ] **PhaseAligner** — crossfade synthesis at seams; zero-crossing
  micro-snap; seam audition.
- [ ] **Meter-aware sub-Q snap — MAYBE, not decided.** Loop-region
  slides snap to whole Q with ⌥ free (owner ruling 2026-09-23), because
  a sub-Q grid is arbitrary relative to the music (a 3/4 phrase does not
  divide into quarters of Q). If field use asks for finer snapping, one
  option is an optional per-island meter: divide Q by its beat count,
  then halve per zoom level (8ths, 16ths). It would bring back the time
  signatures that Q21 ("no meter") deliberately leaves out, so do this
  only if the need turns out to be real.
- [ ] **Linux** build; **mono→stereo** recording upgrade path;
  **disable auto-quantize** toggle (revives Q3); **sharing** of
  projects and templates.

## Tier E: Follow-ups surfaced while building Tier B (2026-09-02)

Small, concrete, each a half-day or less unless marked. None blocks
1.0; all are captured so nothing is lost between sessions.

- [ ] **Import: a native file-drop path.** Sandboxed WebViews hand a
  dropped file its name only, so a drop currently opens the chooser at
  the drop's Q (docs/import.md). Fix: a JUCE `FileDragAndDropTarget`
  on the native component that forwards the real path + pointer
  position to the page — then the drop imports directly.
- [ ] **Bounce options.** An N-cycles choice at export (Q19 picked one
  cycle as the default, not the only option); 24-bit PCM alongside
  32-bit float; "bounce in place" — render a node to a NEW TAKE of
  itself (the takes list makes this natural).
- [ ] **Takes: MIDI comping** (refused today, docs/takes.md), take
  naming, auditioning a take while the transport runs (a solo-like
  monitoring gesture, not a selection edit).
- [ ] **Monitoring: a "monitor while armed" preference** (the Q20
  alternative), for interfaces without direct monitoring.
- [ ] **Master limiter / clip protection** on the root rack (the clip
  lamp latches today; nothing prevents the clip).
- [ ] **A Q-top pulse** — the one meter-free click (Q21 leaves it as a
  possible later option; only if field use asks).
- [ ] **Theme toggle** in Preferences (theme.js has none; the panel has
  the slot).
- [ ] **Deferred from time_maps phase 3:** zero-crossing micro-snap at
  seams, seam audition, the true heard-frame child unroll (open
  question 7).
- [ ] **Engine perf:** cache `StackNode::getIntrinsicDuration` (walks
  children per call on the message thread) if the perf meters ever
  care.
- [ ] **Test coverage shape** (from the 2026-09-01 audit): the DOM patch
  layer (`lane_body.js`, `map_bands.js`, `patch.js`, `rail.js`) is
  mostly e2e-only. (The app shell's glue is unit-tested since
  2026-10-12: it lives in modules that load under node.) A
  Windows/WebView2 Playwright target would catch the platform
  differences the field keeps finding.
- [ ] **Docs:** `design.md` is the 2025 vision and reads stale next to
  the specs — rewrite it post-1.0 as a one-page manifesto that points
  at composition.md; recording.md's islands section becomes the one
  home for islands (open question 8). Done 2026-09-15: kernel.md's
  migration history lives in its §6 appendix, stacks.md is folded into
  composition.md §10 and session_view.md, and every spec carries a
  final "alternatives considered and rejected" appendix (README.md).
- [x] **The frame, remaining passes (frame.md §7, 2026-09-16):** (1) ✅
  2026-09-17 — a root song authored after takes anchors the root at the
  seated zero (`setSequence` carries it; frame.md §4, S39, mock parity,
  the see_vs_hear journey); a root window (engine API only) still folds
  from the island zero; (2) ✅ 2026-09-17 — seek is a phase advance the
  view computes (`seek.js`), import lands at an absolute origin, bounce
  takes an absolute start (frame.md §7); (3) ✅ 2026-09-17 — the
  "epoch" is gone from the code: `islandZero` / `zero_samples_` across
  engine, mock, tests, docs and fixtures, bundle key `zero` (session
  version 3, legacy `epoch` still loads), `frame_top` for the received
  frame top (was `cycle_epoch`).
- [ ] **Process:** agent tasks stall when they span several features;
  one feature per task with the suites run after each step is the
  cadence that worked (memory note).

## Tier F: Q hand-off follow-ups (design_language Q22, 2026-09-24)

The hand-off itself shipped 2026-09-24 (`setDefiner`, the Q lamp, the
drift clause). What the owner asked for next, and the edges the build
left open:

- [ ] **Q as a SUBDIVISION of the definer's loop** (the owner's
  companion ask). A long definer loop (8 drum bars, ~20 s) makes Q
  20 s, so a stop that misses a boundary waits up to 20 s. Done means:
  the definer's loop is k Qs (k a small whole number the owner picks —
  a bar count), Q := loop / k, the grid and every arm/stop land on
  bars, and the definer's trims keep k. Needs a ruling on the control
  (a count on the definer's chip? on the Q lamp?) and on how k rides
  the trim.
- [ ] **Group composites with drifting members** draw a static mix; a
  drifting group lane (all members drift) should draw its pass the way
  a drifting clip lane does.
- [ ] **A root song across a hand-off** keeps its anchor on the OLD
  grid (the Q13 re-trim has the same edge): re-anchor it at the new
  zero, or refuse the hand-off while the root carries a song — ruling.
- [ ] **Bounce of a drifting song** renders one island cycle; the
  drifting loops sound different on each pass, so a bounced loop does
  not loop them seamlessly. Offer N cycles (the Bounce options item
  above) and say so in the dialog.
- [ ] **Short takes at rounded subdivisions** (Q/2, Q/4, Q/8 of a Q that
  does not divide) now drift by a few samples per Q instead of blowing
  the cycle up (engine_lcm_guard.md). Unbadged, but they still draw per
  pass and do not seat. Decide whether a short take should commit at an
  exact divisor instead (or render on a rational period, Q12).
- [x] **The Remove re-open overwrites a post-lock region** ✅
  2026-10-12: Remove and the hand-off share one `reopenCollapsed`, which
  keeps the collapse when a region was drawn on the node or its leaves
  since the lock (`tests/qtime_lock_tests.cc` "RE-OPEN keeps geometry
  authored after the lock…").

## Tier G: Cleanup audit follow-ups (2026-10-12)

What the cleanup (archive, 2026-10-12) left OPEN. Each line says what
"done" means; a question carries the smallest state that shows it.

**Questions for the owner — the law is not written, or two documents
disagree.** Done for each: a ruling in the named doc, and a test that
pins it.

- [ ] **Which extent does a group's authored map select over — a
  MEMBER's song.** State: clip A (1Q); group OUTER ⊃ group BAND ⊃ a 2Q
  take; BAND's song is 2Q | 4Q | 2Q. OUTER plays 8Q (period law), its
  raw inner cycle is 2Q. `setLoopPoints(OUTER, 0, 4Q)` is refused
  ("past the stack's inner cycle" — composition.md §1, §3; pinned by
  `tests/undo_tests.cc`), while OUTER's lane offers brackets over 8Q.
  Either the bound becomes what the group plays unmapped (the kernel
  already renders such a map), or the lane stops offering past the raw
  cycle.
- [ ] **…and the group's OWN song ("loop the chorus").** Same state:
  `setLoopPoints(BAND, 2Q, 6Q)` is refused for the same reason.
  sequencer.md S9 and composition.md §2 say a map selects song
  positions; composition.md §1 says `[0, D)`. Only an EMPTY sequenced
  group takes such a window today (no bound when D = 0). Rule which —
  with an active song, is the bound the song's length? — and make the
  three texts agree.
- [ ] **A sole definer's re-trim that REMOVES the sounding sample:
  which fold?** State: a 40000 take, the island's only content.
  Window = `setLoopPoints(c, 12000, 20000)`; cells =
  `setSegments(c, [12000,16000)+[20000,24000))`. A WINDOW folds the
  content position into the new window, map in force or not (playing
  27648 → 19648). CELLS over a map in force fold the old HEARD phase
  into the new period (playing 27680 under [10000, 30000), heard 17680
  → 13680). CELLS with no map in force start their pass at the edit
  (playing 27648 → 12000). One law for both verbs: the content fold
  generalised to cells, the heard-phase fold for both, or the origin
  stays (composition.md §5 and §7 G-1 state only the window's).
- [ ] **`setSegments` refuses what `setLoopPoints` clamps.** On an
  80000 take, `setSegments(clip, [0, 100000))` is refused (malformed:
  past the take); `setLoopPoints(clip, 0, 100000)` is accepted and
  stored as [0, 80000). Keep — a list is taken literally, a drag is
  clamped (time_maps.md §7) — or clamp a one-segment list too.
- [ ] **A delete that empties the island leaves the root's map
  stored** over nothing (it can be cleared, not edited or bypassed,
  until content returns). Should it go with the songs the same delete
  clears?
- [ ] **The two reverts to "no Q" differ.** Undoing the first take
  keeps every song; deleting the last content clears every song, one
  authored before any take included (composition.md §5, frame.md §4).
  Confirm, or make the delete keep them too.
- [ ] **The origin drift log runs on every poll** (it no longer
  allocates when nothing moved). Keep it there, name the seek as a
  step and drop the poll call, or put it behind a debug switch.
- [ ] **An import brackets itself with the take counter** (`takeArmed`
  / `takeCommitted`), which freezes the cursor's view for one block if
  a callback falls between the two. Keep, or drop the pair.
- [ ] **Keep or delete the reference Q algebra**: `qcmp` / `qadd` /
  `qsub` / `qlcm` (`src/qtime.h`), their JS twins and the two golden
  groups `qtime_lcm_cases` / `qtime_arith_cases` are called only by
  tests.

**Behaviour that changed — the owner to confirm, or say otherwise.**
Done for each: confirmed (tick it) or reverted.

- [ ] **A comp at a SPLICE is flattened**: a lock-collapse of a cut map
  cannot keep one comp grid, so what the comp sounded is copied into
  the active take and the comp is cleared (undo restores takes, map and
  comp). takes.md §3.
- [ ] **Monitoring an unassigned or out-of-range input plays the
  fallback channel** — the capture path's rule ("a take is never
  silently empty"), now the monitor's too. It used to play nothing.
- [ ] **Comp editing on a stale grid** (the comp was authored at
  another Q, or slid by a lock-collapse): a click re-reads the comp
  onto today's Q grid and cycles the clicked cell. The alternative is
  an inert editor until the comp is cleared. takes.md §6.
- [ ] **A song step's successor that names a step past its block's
  list is dropped at load** (it was stored, ignored by the walk, and
  published back). One argument of `Sequence::fromVar` flips it.
- [ ] **Session-view small changes**: a dial or grip holds on the
  PRIMARY button only; with the creation menu open, a press on another
  + moves it there; the fx picker shows its heading before its list
  arrives; the Q readout is written on every patch.
- [ ] **The frame follows the engine's period law everywhere**: a
  window that divides Q shortens its part at any depth; a plain group
  whose composite fits no whole number of Qs reads drifting.

**What the verbs answer — seven calls made with the answer law (ui.md);
the owner may overrule each.** Done for each: confirmed, or changed in
the engine, `protocol.js`, the mock and the shell together.

- [ ] **An identity answers `false`** ("nothing was applied")
  everywhere — `selectTake` of the active take and `setComp` with the
  comp it has included. Alternative: `true`, as an accepted no-op (a
  zero seek answers that way). The shell does not send an identity, so
  no line depends on it.
- [ ] **`toggleSequence` on a stack with no song is refused.** The
  flag is published and saved only inside the song, so flipping it
  there was an undo step that changed nothing visible and made the
  next song authored arrive bypassed. Alternative: keep it as a stored
  fact of the stack.
- [ ] **`setTiming(id, 0, top)` naming the top the lane already shows,
  on a take whose top was never stored, still records a step.** The
  stored top is a saved fact and pins the top against a later map
  edit, though nothing published moves — so its undo appears to do
  nothing. Alternative: refuse it as an identity.
- [ ] **`cancelGesture` answers `true` when the node is as the drag
  found it** — its step taken back, or none was logged — and `false`
  when what the drag did stands (no gesture open on the node, a live
  take). "Cancelled — nothing changed" is then true exactly when said.
  Alternative: `true` only when a step was taken back.
- [ ] **`stopRecordingInNode` answers `false` when nothing beneath was
  armed or capturing.** Alternative: `true` — a stop of nothing is an
  accepted no-op.
- [ ] **`createNode` answers the new node's uuid** (`""` refused), as
  `combineNodes` does, not a bool. Alternative: a bool, and the caller
  finds the node in the next state.
**Engine — open.**

- [ ] **The cancel of an ARMED take can race the block that starts
  it** (performance.md §1 "Known residual"): both threads check `Armed`
  and then store, so a cancel in the one block where the arm's target
  is reached can leave an uncounted live take. Done: a compare-exchange
  on both sides (the cancel `Armed → Idle`, on failure a stop request;
  the capture `Armed → Capturing`, on failure nothing). No
  deterministic test can show the race — owner's go, since every other
  change here was test-first.
- [ ] **A bypassed map, Q moved under it, switched on again.** A 4000
  take in a group; the group's window [0, 2000), bypassed; the sole
  clip trimmed to 1500, so Q = 1500. `toggleLoopWindow(group)` answers
  true and the window is active with a 2000 period on a 1500 grid: it
  drifts, the clip stops being the definer, and an EDIT of that window
  is judged. Ruling: (a) the toggle is an edit — refuse the switch-on
  (or clear the map) when its period no longer fits Q; or (b) the drift
  clause is the answer — it plays as stored, badged, and the next
  region edit lands it on the grid.
- [ ] **What makes clips one take.** `isOneTakeStack` reads two or more
  direct clips with one length and one origin — and, since 2026-10-12,
  the group's OWN origin. An overdub that lands at the group's origin
  with the group's length still reads as one take with the first mic.
  If "performed together" should be the rule it needs a persisted
  performance id stamped at the group arm (session format; what clears
  it — a re-time of one member? a new take of one member?). Confirm the
  narrowed predicate, or rule the id.
- [ ] **A device that stops under a first take.** Its stop is asked of
  an audio thread that is not running, so the take ends at the first
  block after the device returns (every later take already waits so).
  Should `audioDeviceStopped` end live takes itself?
- [ ] **`commitRecording`'s unsnapped-stop branch** (`Q > 0` with no
  final duration: the hysteresis snap and the provisional `[0, L)`
  window) is reachable only from one row of
  `tests/quantum_propagation_tests.cc`; with it `liftGroupWindow` can
  lift nothing for a recorded take. Delete both, or keep for a host
  that commits unsnapped.
- [ ] **The comp's offset is not saved.** A comp on a lock-collapsed
  clip reloads at offset 0 (`session_io` writes `compCellQ` only).
  Done: the offset round-trips.
- [ ] **MIDI play-through cuts at once under a mute** where monitored
  audio fades (`tests/midi_tests.cc` pins the cut). Done: an
  output-side ramp in the live tail, and that test changed with it.
- [ ] **`settleCommittedTake` is a free function** that hands its undo
  entry back for the caller to push. As a private member of the engine
  it would push its own, and `engine_internal::settleAnchors` would
  fold back into the member. Owner's call on the shape.
- [ ] **A one-shot under a MULTI-SEGMENT enclosing map**: a firing that
  straddles the parent's cut is drawn uncut. Done: the lane cuts it, or
  the limit is ruled acceptable.

**UI and shipping.**

- [ ] **The app loads its fonts from Google Fonts** (`ui/index.html`).
  A shipped app must not need the network to draw text. Done: the two
  families ship with the app behind a local `@font-face`.
- [ ] **The ＋ Track row falls below the fold at 1280×720** once a group
  of three and the edit bar are up, so a drag-out needs a scroll first.
  Done: the drop target is reachable without scrolling, or the lanes
  scroll under a held drag.
- [ ] **A press within one poll of the previous commit can be lost**
  (a bracket pressed right after a heal, a splice grabbed while the
  last release settles, → pressed within a poll of ⌘Z). Below a hand's
  speed; no test. Done: each has a unit test, or is ruled out of scope.
- [ ] **The project's birth line can overwrite the status line** (it
  rides the 2 s identity poll after the first committed take). Done:
  it never replaces a line the user has not had time to read.

**Tests and platforms.**

- [ ] **The take-capacity fixes have never run on Windows.** The
  committed-edge law (`ClipNode::takeReach`) is pinned on every
  platform through the `TakeStorage::commit_on_demand` seam, but the
  access violation and the forced stop it removes exist only on
  Windows. Done: the suite is green on a Windows build, and a take on
  an island whose Q is over a minute records whole there.
- [ ] **Differential gaps**: a plugin add that succeeds, and MIDI
  takes, are not compared (the headless server has no seeded plugin and
  no MIDI input). Done: a control op for each, and journeys that use
  them.
- [ ] **Two optional C++ test file merges** (small gain, two fewer
  files): `tests/effects_stereo_tests.cc` (4 cases) into
  `effects_tests.cc`; `tests/project_lifecycle_tests.cc` (8 cases) into
  `project_manager_tests.cc`. Done: merged with every assertion
  carried, the two files out of `CMakeLists.txt`.
- [ ] **Twenty-two differential journeys that would release about 40
  more mock-parity unit cases.** These JS unit cases pin mock parity
  and have NO journey twin yet, so they were kept. Each line below is
  "verbs → fields to compare"; every field is a compared row of
  `ui/differential/fields.mjs` already — only the sequence is missing
  from `ui/differential/journeys.mjs`. Done: the journey is in, green
  on both sides, and the unit cases it twins are deleted with their
  ledger lines.
  1. `session/save-load`: before the missing-session load,
     `toggleMute(@A)` → `canUndo` stays true. Before the save:
     `newTake(@B)` to its settle, `selectTake(@B, 0)`,
     `setComp(@B, [1,0,1,0])`, `setMonitor(@A, true)` → `takes`,
     `activeTake`, `comp` after the load.
  2. `timing/refusals`: `create(@H, stack)`, `setTiming(@H, Q)` (an
     EMPTY group) → `retime`, `loopTop`, `canUndo`. `timing/group`: a
     group with content — `setLoopPoints(@G…)`, `toggleLoopWindow` ×2,
     `setTiming(@G, Q)`, `setTiming(@G, −Q, top)`, a region edit that
     keeps the top and one that drops it, undo,
     `setTiming(@G, −retime)` → `loopTop`, `retime`, `origin` of the
     group and its members.
  3. `takes/new-take-on-a-re-timed-slot`: a 1Q and a 4Q take (the
     `oneAndFour` prelude); `setTiming(@B, Q)`; `advance(Q/2)`; `newTake(@B)` to its settle;
     `setTiming(@B, 0)`; `undo`, `redo`, `undo`, `undo` → `retime`,
     `origin`, `takes`, `activeTake`.
  4. `takes/new-take-then-undo`: `newTake(@B)` to its settle; `undo`,
     `redo`, `undo`, `undo`.
  5. `timing/live-drag`: `setLoopPoints(@B, 2Q, 4Q)` then a live
     `setTiming` then `undo` (the re-time is its own step); two drags
     each opened by an identity, then two undos; a refused first commit
     followed by a live one; a drag that dwells and returns to its
     start.
  6. `window/live-drag-past-the-top`: a top stored mid-region
     (`setTiming(@B, 0, top)`), then live commits that slide the region
     off the top and back, a live `setSegments` that drops it, `undo` →
     `loopTop` at each.
  7. `timing/top-through-a-collapse`: two takes;
     `setTiming(@A, 0, Q/2)`; `deleteNode(@D)`;
     `setLoopPoints(@A, Q/4, 3Q/4)`; a second take (collapse); its
     delete (re-open); a re-trim past the top; `undo` → `loopTop`.
  8. `window/delete-empty-beside-collapsed`: a second `undo` after the
     take's (the lock-collapse's own step) → the definer whole again
     with its trim.
  9. `take/group-first`: `undo`, `redo` after the group take (one step;
     every ancestor un-anchors and re-anchors — nest the group one
     level down); a group take stopped through `@ROOT`; a group arm
     cancelled while pending (two empty members, armed mid-cycle).
  10. `graph/delete-content-in-a-group`: a two-mic group take;
      `deleteNode` of each mic; `undo` ×2 → `anchored`, `origin`.
  11. `cuts/on-a-group`: `setSegments(@G, [0, Q, 2Q, 2.5Q])`
      (incoherent, refused).
  12. `take/refused-under-nested-maps`: `toggleLoopWindow(@H)`,
      `startRecordingInNode(@N)`, `advance(BLOCK)` → one map bypassed,
      the arm proceeds.
  13. `seq/refusals` with a song in place first (a zero-length step, an
      out-of-range successor, a zero weight: the song before stands);
      nested: a non-returning walk refused, a periodic jump graph
      taken.
  14. `seq/song-tracks-q`: a sole 4Q take (the `soleFour` prelude);
      `setSequence(@ROOT, 8Q + 12Q)`; `setLoopPoints(@A, 0, 2Q)` (steps rescale);
      `deleteNode(@A)` (the song cleared), each with its undo; and the
      same delete under a SEATED root song → `anchored`, `origin` of
      the root.
  15. `seq/audition-under-edits`: `auditionStep`, then a resize of a
      step (the audition follows), a step deleted (cleared),
      `toggleSequence` off and on (the window returns); on a jump graph
      (a revisited step loops its first visit, an orphan refuses); a
      window authored over a group song, then `toggleSequence` →
      `windowSuspended`, `windowActive`.
  16. `seq/record-over-a-song`: `undo`, `redo` after the auditioned
      take (the take and its gates are one step); a group arm under the
      root audition (the group's gate row untouched).
  17. `seq/window-over-cued-steps`: a group with a cued song and an
      authored window; an arm from the plain step is refused (control:
      no window, it takes).
  18. `definer/across-a-lock`: hand-off + trim, an arm (collapse, the
      designation cleared), cancel, two undos; `setDefiner` on a
      lock-collapsed track; a region drawn since the lock, then
      `setDefiner`; a designation naming a deleted track; a clip under
      a one-shot group.
  19. `templates/save-and-insert`: `setMonitor(@M1, true)` before the
      save → `monitor` on the insert.
  20. `cancelGesture`: under a live take; of a gesture that has ended
      (a rename after it); of a re-time with a top.
  21. `window/continuity-at-pass-counts`: a sub-Q loop slid after an
      odd number of its passes; a head trim before the playing point; a
      cut that keeps the sounding position, then its heal.
  22. The bounds no journey reaches: the take ceiling of `bounce`, the
      32-take and the 256-cell bounds.

  Beside them, 23 unit cases are kept only because another deletion
  named them as its twin (the ledger rule, test_harness.md). A journey
  also holds most of them: `cuts/bands` + `cuts/refusals` +
  `cuts/on-a-group`, `take/through-a-group-window`,
  `window/definer-group`, `window/sole-definer-retrim`, `graph/knobs`,
  `graph/one-shots`, `definer/hand-off`, `seq/root-song` +
  `seq/group-song`, `take/live-gate`. Owner's call: may a journey stand
  in for a kept unit twin? (The view-model assertions inside several of
  them have no journey and stay either way.)

---

## Open Design Questions

| # | Question | Source |
|---|---|---|
| 1 | Max practical nesting depth before the UI gets unwieldy? Plus the rest of the retired stacks.md's open list: a depth indicator beyond the indent, keyboard navigation into/out of stacks, whether copying a stack deep-copies its contents, and drawing the composite waveform in the collapsed view. | composition.md §10 |
| 2 | Quantum mismatches between connected islands? | Tier D islands |
| 3 | "Breaking out" a stack from an island — UX + implementation? | Tier D islands |
| 4 | Connecting stacks after Q is established — polyrhythmic interaction? | recording.md |
| 5 | ~~Stop/play policy~~ **RULED 2026-09-10** — the law now lives in session_view.md display law 15 (play starts from the play start; stop returns to it). | session_view.md law 15 |
| 6 | Grid honesty when auto-quantize is disabled — deferred with that feature | design_language Q3 |
| 7 | The true heard-frame unroll of a mapped group's children (today: excluded regions drawn as dims) — needs a ruling | time_maps.md phase 3 |
| 8 | Islands are specified in triplicate (recording.md, archive/implementation.md §8, design.md §8) — recording.md should be canonical | design_language §4 item 5 |
| 9 | Should an anchored stack's origin be editable directly (drag the group's take mark), i.e. is "move a group in time" a first-class edit? | composition.md §5 |
| 10 | A new take on a group (Q7-fractal) re-records every committed direct clip as one performance — should it also offer per-member retakes (one mic only), and does a per-member retake keep the group's "one take" definer status? | docs/takes.md |
| 11 | Import onto a committed slot cuts/pads the file to the period. Should a longer file instead offer "new clip at the drop" vs "new take of this slot"? | docs/import.md |
| 12 | **Grafting into the definer.** Recording a second thing locks Q, and a new track recorded INSIDE the Q-defining group counts as a second thing: the group's loop window can no longer be re-drawn. Should it instead count as part of the first thing — the group stays the definer, its window stays free, and the new track is silent where the window grows past its content — so a part can be grafted into the definer after the fact? The lock exists to keep a song coherent, not to block the player; the ruling should be made in that spirit. Needs: what "inside" means once the group has siblings, and whether a graft survives a hand-off (Q22). | design_language Q22, recording.md |

Closed since the 2026-08-20 tracker: rational time (Q12), record on a
composite (Q7), large-LCM warning (frame-health badge), windowed-lane
rendering (Q14c → law 13 amended), the stack/clip anchoring asymmetry
(Q18).

---

## Archive: completed work (one line each)

### 2026-10-12 — cleanup audit

What it left open is Tier G.

- [x] Cleanup audit (engine, UI, mock, tests, docs): report in
  `cleanup_audit_2026-10-11.md` at the repo root.
- [x] Engine bugs, each with the test that pins it: Combine refuses a
  node and its own ancestor, Explode restores the sibling order; a live
  gesture's one undo step keeps the origin and the bypass it found; a
  re-grid's undo restores every song exactly; a take's end is published
  facts → Idle → the island's count, and the settle waits for it; an
  arm validates before it changes anything (its own edits apply
  unlogged and revert on a refusal); an audio take with no input runs
  by the clock over silence; one committed edge per take
  (`ClipNode::takeReach`); the pre-Q scrub rides the take's undo entry;
  live MIDI and a parent's gate ramp are sliced per seam run
  (`StackNode::scopeFacts`, `timing::stackFold`); a one-shot group's
  rest keeps its members' racks and live input running; the first
  take's cursor; an arm starts in the run that reaches its target; a
  splice at the lock leaves no window; a first take's undo keeps the
  songs; the root of an island with no Q refuses a map; a definer
  stack's window is judged as clamped; both map appliers stamp the
  domain before the top reconciles; effects follow the device rate at
  device start; the project is flushed on open, new-from-template and
  quit; a template's folder is a legal name; a load replaces rack, song
  and bypass; a failed take write fails the save; the device-stop edge
  leads its block; one block ceiling (`kMaxBlockSamples`).
- [x] Owner rulings applied: a bypassed map is not in use at arm (no
  collapse, no splice, not geometry); a handle press selects its track
  at once (the claim machinery is deleted); one-shots stay editable;
  import onto a stack is one undo step (`Edit::then`); `lastTemplate`
  removed — the app always boots empty; `commit_master_pos` and the
  published `launchPoint` dropped.
- [x] Engine structure: one applier per edit kind
  (`engine/edit_{structure,geometry,takes,facts}.cc`, the `KindTraits`
  table), one `commitMap`, one live-take gate, `engine/definer.cc`, the
  tree walks and one take settle in `engine_internal.h`; the clip in
  `clip_node_{capture,takes,render}.cc`; one `sumOutputStage`; one song
  reader (`Sequence::fromVar`); effect parameters as tables; the
  headless server split (`chirp_codec.h`, `http_server.h`) and its
  `reset` a fresh boot; one source list for app, headless and tests.
- [x] UI: `view_model.js` a facade over `ui/js/vm/*` and the period law
  in `ui/js/period_law.js`; `app.js` split (`session_facts`,
  `shell_io`, `content_cache`, `edit_verdict`, `record_verbs`,
  `structure_verbs`, `project_menu`, `popover`); the session view's
  lane, panel and grid modules split (`map_moves`, `splice_spots`,
  `loop_runs`, `seq_dims`, `seq_columns`, `region_nav` / `_nudge` /
  `_dock`, `playhead`, `popover`); one-shot lanes drawn from the
  engine's fold; the comp drawn on its stored grid; every raw tile
  carries its mapping; the frame from the golden-pinned period law; the
  multi-segment definer's cursor and cuts; fade ramps per visit; the
  ruler locked while a take is armed; popovers on one rule set; the
  `unsupported` plugin chip; a plugin scan outlives its panel.
- [x] The status line reads the engine's answer (owner ruling "the
  status line should not lie"): every verb the engine can refuse
  answers whether it applied, end to end — engine verb → `boolMethod`
  (`bridge_dispatch.h`) → `protocol.js` `returns` → the mock → the
  shell's `call` / `callEach` with a `failMsg`
  (`shell_io.js`, `lane_verbs.js`); an edit that changes nothing
  records no undo step and keeps the redo branch; the listing verbs
  answer values, `createNode` its uuid; the HTTP bridge re-sends only
  reads; `tests/bridge_dispatch_tests.cc`.
- [x] Mock: rewritten against the differential — the root is a real
  node, timing imported from the mirrors (`mock/heard.js` the twin of
  `heard_index.h`), the engine's arm order, one published field list,
  the clock stepped under test; the differential compares every verb's
  answer and its known-drift list is empty.
- [x] Tests: the C++ suite from 394 s to about 30 s (per-sample graph
  reads hoisted, with a guard); `undo_symmetry_tests.cc` (every edit
  kind: edit, undo, redo, undo), `take_lifecycle_tests.cc`,
  `rack_rate_tests.cc`; the differential harness (`ui/differential/`,
  `npm run test:diff`); 37 golden vectors in three new groups and two
  grown ones; `ui/e2e/helpers.js`, no `waitForTimeout`; 32 new e2e
  cases for track verbs, the project menu and the plugin panel; the
  C++, JS unit and mock e2e suites thinned on a twin ledger (a case is
  deleted only on a named twin, which then stays) — mock-parity unit
  cases went to their differential journeys, `regression_tests.cc` and
  `audio_engine_tests.cc` are emptied and out of the build, the C++
  run prints no JUCE assertion line; category `Golden` for the fixture
  readers; `index_test.html` a redirect and the sidebar a module;
  `npm test` on `node --test`.
- [x] Comments put on a diet across engine, UI, mock and stylesheet;
  docs and `.agent/` brought up to the code.

### 2026-09-24 — Q hand-off (Q22)

- Hand Q to a track: `setDefiner` (engine, bridge, mock), the stored
  definer designation (cleared by the next take that records new
  content), keep-origin trims beside other tracks, the drift clause in
  the period law (engine + JS twin + golden cases), drifting lanes drawn
  per pass, the trim view with company, the rail's Q lamp offer, docs
  (design_language Q22, composition §3/§5, engine_lcm_guard, frame.md,
  session_view law 18).

### 2026-09-01 — foundation audit + Q18

- [x] Foundation audit (docs, engine, UI, tests); report in the artifact
  linked from composition.md §0's ruling record.
- [x] Repo hygiene: `ui/node_modules`, the state dump and a stray
  Playwright result untracked; three merged branches deleted; README
  test path and doc pointer fixed; `.claude/settings.json` tool names.
- [x] Docs consolidation: index rewritten; six journal docs archived
  under docs/archive/; superseded banners (design.md,
  time_maps.md, projects.md, session_view.md, recording.md); `.agent/`
  files rewritten to current canon; composition.md written.
- [x] Engine sweep: 0 JUCE assertion lines in the test run (em-dash
  literals; a ScopedJuceInitialiser in the runner); dead members
  removed (`MuteState`, `output_latency` folded, `cached_block_size_`,
  `Edit::s2`, `read_position`, `current_max_peak`, `width/height`,
  `focused_node`, duplicate uuid lookup, legacy MIDI drain); stale
  comments fixed; file/class overviews added; the disabled assertion
  re-pinned; `repro_first_clip_bug.cc` deleted.
- [x] UI sweep: `scheduleVerify` nodes/children bug; canvas-era code
  deleted (`computeGhostTiles`, stack waveform paths, echo branches,
  `#debug-log`); duplicates unified; fx_row bridge injection; mock
  scenarios on the stored-Q contract; unused exports; stale headers;
  engine_replay skips without the capture.
- [x] **Q18 — every node has an origin** (engine): `AudioNode` owns
  the gated origin + `anchored`; `StackNode::childContext` /
  `forEachSeamRun` / telemetry / sequence / cue on the one law;
  `settleAnchors` (anchor at first content, un-anchor at last, riders
  for undo); `shiftOriginsGated` subtree shifts replace the origin
  riders; `epochViewStep` deleted; one definer path in `setLoopPoints`
  / `setSegments`; group lock-collapse shifts origins like the clip's;
  seek shifts stacks; one-shot stacks (`setPeriodSource` on groups,
  rest regions split at seams); `heard_index.h` generic
  (`nodeInner`); session persists stack origins (additive). Pinned by
  `tests/stack_origin_tests.cc` (anchoring + undo; windowed group
  invariant under a cycle-growth re-base and a seek; one-shot group
  G-2; Combine; session round trip) and re-pinned old-law tests.

### 2026-08 — sequencer, loop regions, group definers

- [x] Sequencer steps 1–4 (core, step record + audition, nested
  sequences, cue steps) — sequencer.md §10–§13; frame-health badge.
- [x] Loop-region audit 2026-08-30/31: content-frame law, group
  definer (Q13 for groups), lock-collapse group twin, seqlock'd island
  facts, gated origins, group stop generation, gesture runner, fuzzer.
  (Superseded in mechanism by Q18; the render-level tests survive.)
- [x] Q16 solo canon; Q17 template picker; `R` and Space keys; group
  arm (Q7); VST3 phases 1–5; stereo/pan; output stage + gain;
  one-shots (Q5); heard-frame windows (law 13); map coherence ruling.

### 2026-07 — kernel migration & unification

- [x] Tier 0 rational time (Q12, QTime); Tier 1 finish-the-kernel
  (clock never mutated, one origin per clip, state machine, commit as
  event, cast-free traversal, context passed down); Tier 2 defects
  D1–D14; Tier 3 primitives (TimeMap, phases 2–3, output stage,
  undo/save/projects, whole-graph snapshot, pure render); Q13 re-trim
  and lock-collapse; latency calibration; time_maps phase 1.

### 2026-03 — hygiene round

- [x] BoxNode removal, debug-log cleanup, API cleanup, app.js
  modularization, LCM/GCD consolidation, ghost bug suite.
