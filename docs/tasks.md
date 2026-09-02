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
   (done, except software input monitoring — B1);
3. shape parts with windows, cuts and one-shot groups (done — Q18 UI
   in flight, A1);
4. arrange the parts into a song with the sequencer, count-in included
   (done except count-in — B3);
5. bounce the song, or any node, to a WAV (B2);
6. save, quit, reopen, and find the session exactly as left (done);
7. install it from a signed build on macOS and Windows (B8).

Nothing in Tier D is required for 1.0.

---

## Tier A: Foundation follow-through (2026-09)

- [ ] **A1 — Q18 in the UI.** Group lanes carry a take mark
  (`(origin − epoch) mod frame`), bracket/cut geometry on group lanes
  is inner-position offset by it, one-shot groups render dashed with no
  ghosts, the rail ↺/1× chip works on groups; mock in lockstep
  (`anchored` + `origin` on stacks, the settle rule, subtree origin
  shifts). Done = `stack_origin.test.mjs` + VM tests + one e2e green,
  and a field session with the five-mic drum group as a one-shot.
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
- [ ] **A8 — Small residue.** `ProcessContext::is_recording` (always
  true; tests write it), `timing::playheadPercent` (golden-pinned, no
  engine caller). ~~`window.__mapDbg` gating~~ ✅ `ui/js/debug_flags.js`
  (a leaf module; the recorder exists only with `?debug=true`).
- [x] **A9 — Comment hygiene rule** ✅ 2026-09-01: the rule is in
  .agent/style.md and a full present-tense pass ran over src/ and
  ui/js + ui/css (comment-only, verified by stripping comments and
  diffing).

## Tier B: Product to 1.0

- [ ] **B1 — Software input monitoring** (ruled Q20): hear the armed
  input through the engine; OFF by default, a per-track toggle with the
  calibrated latency shown beside it. Done = the toggle on the rail,
  the engine mixes the input at the output stage of the armed clip,
  the mock mirrors it, one e2e.
- [ ] **B2 — Bounce / export** (ruled Q19): render the island root for
  one effective cycle (the song when a sequence is active) to a WAV
  through the real render path at the device rate, tails ringing past
  the end; any node bounceable the same way. Done = a `bounce(uuid,
  path)` bridge verb, offline render through `AudioNode::process`
  with a fresh snapshot, a native file dialog, a pinned golden (a
  bounced loop equals the live render of the same cycle).
- [x] **B3 — Count-in and metronome: CLOSED (ruled Q21, 2026-09-01).**
  No meter, no tempo, no beat to click on; the scratch loop is the
  count-in. A single Q-top pulse is a possible later option only.
- [ ] **B4 — Takes and comping.** Re-record a committed clip: alternate
  content buffers sharing one origin/period, a take list per clip,
  "new take" on the record button; comping = choosing per-Q-cell which
  take sounds (a per-cell take index, the segment editor's grammar).
  Take commits are already undo entries.
- [ ] **B5 — Master bus.** A root output stage with a fader and meter;
  the VU today reads the device output.
- [ ] **B6 — Audio file import.** Drop a WAV onto a lane: it becomes a
  committed take (origin = the drop's frame position; length snapped
  per the hysteresis law or free with a window).
- [ ] **B7 — VST3 phase 6 polish.** All-notes-off on stop/mute/solo
  silence, instrument state in take undo entries, piano-roll-ish MIDI
  lane rendering, out-of-process scanning, AU.
- [ ] **B8 — Distribution.** Signed/notarized macOS build, Windows
  installer, a preferences panel (audio device, calibration, library
  paths), crash-safe project mirroring verified in the field.
- [ ] **B9 — Field checklist for 1.0.** One scripted session (the 1.0
  paragraph above) run on macOS and Windows with a real interface.

## Tier C: The sequencer's last step

- [ ] **C1 — Successor graphs + the seed (step 5, S12).** Weighted
  successors per step (branch-with-chance), root-only stochastic, the
  seed stored as data so a "radio" pass is reproducible. Needs the
  period-less-node rule stated in composition.md §3 (stochastic
  successors have no period → root only).
- [ ] **C2 — Per-step fades** (S13): `fadeInQ`/`fadeOutQ` on the step
  format.
- [ ] **C3 — Nested stochastic sequences** (proposed under S12): decide
  whether a nested stack's radio is legal once C1 lands.

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

---

## Open Design Questions

| # | Question | Source |
|---|---|---|
| 1 | Max practical nesting depth before the UI gets unwieldy? | stacks.md |
| 2 | Quantum mismatches between connected islands? | Tier D islands |
| 3 | "Breaking out" a stack from an island — UX + implementation? | Tier D islands |
| 4 | Connecting stacks after Q is established — polyrhythmic interaction? | recording.md |
| 5 | Stop/play policy: pause/resume is the default; ruler seek now gives "restart from the top" as a gesture. Re-ask whether a restart button is wanted. | seekTransport, law 14 |
| 6 | Grid honesty when auto-quantize is disabled — deferred with that feature | design_language Q3 |
| 7 | The true heard-frame unroll of a mapped group's children (today: excluded regions drawn as dims) — needs a ruling | time_maps.md phase 3 |
| 8 | Islands are specified in triplicate (recording.md, archive/implementation.md §8, design.md §8) — recording.md should be canonical | design_language §4 item 5 |
| 9 | Should an anchored stack's origin be editable directly (drag the group's take mark), i.e. is "move a group in time" a first-class edit? | composition.md §5 |

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
  under docs/archive/; superseded banners (design.md, stacks.md,
  time_maps.md, projects.md, ui_overhaul.md, recording.md); `.agent/`
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
