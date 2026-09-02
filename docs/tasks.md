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
- [ ] **A2 — One window storage.** Fold the phase-1 loop atomics into
  the `TimeMap` value behind `map_override_` (n = 1 for windows);
  delete the Segments/LoopPoints normalization, the three "is this
  window real" tests, and the `setsMap/tmap` rider plumbing.
- [ ] **A3 — Delete the snapshot-less fallback path.** Node-level unit
  tests build a `GraphSnapshot`; `ChildView`'s ownership branch, the
  `rootNode()` walks and `getEffectiveQuantum()` parent chains in
  clip_node.cc go with it.
- [ ] **A4 — `is_expanded` leaves the engine.** View state per I6b;
  the bridge round-trip and session field retire (UI-local, persisted
  with the projects UI prefs).
- [ ] **A5 — Remove `setNodePosition` and node x/y.** No UI caller since
  the session view; strip protocol, engine, mock (about 40 scenario
  literals) and the undo set; loading older sessions ignores the keys.
- [ ] **A6 — Split `audio_engine.cc`.** Island-geometry law (definers,
  continuity, cycle-top rule, anchoring) → `island_geometry.cc`; the
  edit log → `edit_log.cc`; take lifecycle → `take_service.cc`; device
  + calibration → `audio_device_service.cc`; the callback → its own
  file so performance.md §1 is reviewable in one screen.
- [ ] **A7 — One keyboard dispatcher.** app.js, session_view/init.js,
  audio_settings.js and plugin_panel.js each listen for keydown with
  different typing guards; one dispatcher with one guard.
- [ ] **A8 — Small residue.** `ProcessContext::is_recording` (always
  true; tests write it), `timing::playheadPercent` (golden-pinned, no
  engine caller), gate `window.__mapDbg` behind a debug flag without a
  circular import.
- [ ] **A9 — Comment hygiene rule.** Adopt in .agent/style.md: a comment
  states what is true now; history goes in the docs. Retire changelog
  comments as files are touched.

## Tier B: Product to 1.0

- [ ] **B1 — Software input monitoring.** Hear the armed input through
  the engine (performance.md §2.1 notes none exists); off by default
  when the interface offers direct monitoring; latency shown from the
  calibration.
- [ ] **B2 — Bounce / export.** Render any node (root = the song) to a
  WAV through the real render path at the device rate: one pass of the
  effective cycle for a loop, the full sequence for a song, with tails.
  projects.md deferred this "until the sequencer exists"; it does.
- [ ] **B3 — Count-in and metronome.** A metronome on the Q grid (after
  Q exists) and an optional count-in of N Q before the arm target.
- [ ] **B4 — Takes.** Re-record a committed clip: alternate content
  buffers sharing one origin/period, a take list per clip, "new take"
  on the record button. Take commits are already undo entries.
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
