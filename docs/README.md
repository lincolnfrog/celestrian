# Celestrian Docs Index

> Every doc carries a status: **spec** (binding — drift from code is a
> bug), **proposal** (direction, not yet fully built), or **journal**
> (history — kept for context, may describe superseded designs).

## Canon (read these first)

| Doc | Status | What it is |
|---|---|---|
| [design_language.md](design_language.md) | spec | The vocabulary, the numbered invariants (I1–I9), worked examples with state tables, and the owner-ruling record (Q1–Q11). **Start here.** |
| [kernel.md](kernel.md) | spec | The cyclic kernel: one monotonic clock, per-clip origins, time-maps. Migration steps 1–3 done, step 4 in progress. |
| [recording.md](recording.md) | spec | Recording math: quantum, origins/launch points, hysteresis snapping, LCM cycle view, ghosts. The worked examples are the executable spec (golden vectors). |
| [time_maps.md](time_maps.md) | spec (phases 2–3 proposal) | Loop windows as time-maps: active/bypassed state, recording-through-map semantics, the seam theorem, Q-cell + punch-cut editor design. Phase 1 implemented. |
| [performance.md](performance.md) | spec | The audio-thread contract (§1 is project law), latency model, calibration feature, perf backlog and instrumentation. |

## Supporting

| Doc | Status | What it is |
|---|---|---|
| [design.md](design.md) | vision | Product vision, UX flows, feature roadmap. Broadest and oldest; details defer to the canon docs above. |
| [ui_overhaul.md](ui_overhaul.md) | spec + proposal | The ratified UI redesign (2026-07-09): "Tape Room" direction, session view, instrument-in-hand sizing; carries P2-10 (deriveViewModel) and the phased build plan. |
| [stacks.md](stacks.md) | spec + journal | Stack/nesting UX and visual design. The "Stack Loop Processing" section is superseded history (see time_maps.md); the visual-design sections are superseded by ui_overhaul.md. |
| [ui.md](ui.md) | spec | Frontend/backend separation of concerns; the bridge API placement rules. |
| [implementation.md](implementation.md) | journal | Architecture status snapshots and the waveform-rendering design (§7, still current for the UI). |
| [refactoring_proposal.md](refactoring_proposal.md) | journal | The 2026-07-07 refactor plan with status annotations; P0 items all landed. |
| [design_alternatives.md](design_alternatives.md) | journal | Options considered and rejected, with reasons. |
| [tasks.md](tasks.md) | tracker | Tiered task list + the Open Design Questions table. |
| [test_harness.md](test_harness.md) | spec | How to build and run every test layer — including the stale-binary gotcha. |

## Ground rules for editing docs

- Owner rulings are recorded in design_language.md §5 with dates and, where
  possible, direct quotes; docs cite rulings rather than restating them.
- Worked examples carry **state tables** (origin/period/launch/x per
  clip) — schematics drift during refactors; tables pin exact values and
  convert into golden vectors.
- Name your units: samples (engine), Q (musical), pixels (UI). Unlabeled
  frame-mixing has caused multiple field bugs.
- When a design is superseded, keep the old text under a dated
  SUPERSEDED banner pointing at the replacement — history explains why
  the code looks the way it does.
