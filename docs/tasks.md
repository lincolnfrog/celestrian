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
the vision beyond 1.0.

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
  change; one class, eight files under `src/engine/`): `island_geometry.cc`
  (definers, continuity, anchoring, Q re-establishment, scrubs),
  `edit_log.cc` (applyEdit + inverses, undo/redo), `take_service.cc`
  (arm, group arm, settle, compaction), `transport.cc` (play/seek/state),
  `verbs.cc` (bridge verbs), `map_edits.cc` (windows, segments,
  sequences), `audio_callback.cc` (the ONE audio-thread file —
  performance.md §1 reviews it), `device_service.cc` (device,
  calibration, MIDI inputs). `audio_engine.cc` keeps construction,
  publishGraph, the reclaimer and save/load (159 lines).
  `engine/engine_internal.h` declares the three helpers shared across
  files.
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
  root's frame top IS the epoch by the 2026-09-09 never-anchored ruling;
  the bounce's root branch collapsed into the node branch, `epoch + a0`
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
  e2e-only and `app.js` glue has few units — the confirmed UI bug lived
  there. A Windows/WebView2 Playwright target would catch the platform
  differences the field keeps finding.
- [ ] **Docs:** `design.md` is the 2025 vision and reads stale next to
  the specs — rewrite it post-1.0 as a one-page manifesto that points
  at composition.md; recording.md's islands section becomes the one
  home for islands (open question 8). Done 2026-09-15: kernel.md's
  migration history lives in its §6 appendix, stacks.md is folded into
  composition.md §10 and session_view.md, and every spec carries a
  final "alternatives considered and rejected" appendix (README.md).
- [ ] **Process:** agent tasks stall when they span several features;
  one feature per task with the suites run after each step is the
  cadence that worked (memory note).

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

Closed since the 2026-08-20 tracker: rational time (Q12), record on a
composite (Q7), large-LCM warning (frame-health badge), windowed-lane
rendering (Q14c → law 13 amended), the stack/clip anchoring asymmetry
(Q18).

---

## Archive: completed work (one line each)

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
