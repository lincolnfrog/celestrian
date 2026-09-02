# Celestrian Docs Index

> Every doc carries a status: **spec** (binding — drift from code is a
> bug), **proposal** (direction, not yet fully built), or **journal**
> (history — kept for context, may describe superseded designs).
> Index trued 2026-09-01.

## Canon (read these first)

| Doc | Status | What it is |
|---|---|---|
| [design_language.md](design_language.md) | spec | The vocabulary (§1), the numbered invariants (I1–I9), worked examples with state tables, and the owner-ruling INDEX (§5: Q1–Q17 in full, plus one-line pointers to rulings recorded elsewhere). **Start here.** |
| [kernel.md](kernel.md) | spec — implemented | The cyclic kernel: one monotonic clock, per-clip origins, time-maps. All four migration steps complete (steps 1–3 2026-07-07/16; step 4 = time-maps phases 1–3, 2026-07-09/21/22). §1/§3/§5/§6 are history. |
| [recording.md](recording.md) | spec | Recording math: quantum, origins, arm/stop snapping, the LCM cycle view, ghosts. The worked examples are the executable spec (golden vectors). |
| [time_maps.md](time_maps.md) | spec + journal | Loop windows and non-contiguous selections as time-maps; recording through a map; the seam theorem; the content-frame law. Phases 1–3 implemented; the 2026-07-22→25 gesture-UX journal is history. |
| [sequencer.md](sequencer.md) | spec + journal | The fractal Sequence primitive on stacks: the **period law** (§2 — a stack's effective period is window ▸ active sequence length ▸ LCM of children's effective periods, i.e. the composition law), gate/cue entrances, record-into-a-step, cue steps. Rulings S1–S22. Build steps 1–4 shipped. |
| [engine_lcm_guard.md](engine_lcm_guard.md) | spec | The Q-coherence ruling (2026-08-09): every map/window period is a whole multiple or exact divisor of Q, enforced categorically on both sides; free-length cuts abolished. |
| [performance.md](performance.md) | spec | The audio-thread contract (§1 is project law), latency model, calibration feature, perf backlog and instrumentation. |
| [composition.md](composition.md) | spec | The recursive theory of time composition stated once: the node record, the one anchoring law for every node (Q18, 2026-09-01 — stacks have origins), the period/cycle consumer table, the epoch's role, anchoring events, invariants I10–I16, worked group examples. **Read after design_language.md.** |

## Supporting

| Doc | Status | What it is |
|---|---|---|
| [design.md](design.md) | vision | Product vision, UX flows, feature roadmap. Broadest and oldest; overruled mechanics carry bracketed pointers to the ruling. |
| [ui_overhaul.md](ui_overhaul.md) | spec + journal | The Tape Room UI (2026-07-09) and the display laws (§6, laws 1–14, incl. the window law 13 and the seek law 14). Phases 1–3 and 6 done; 4 done differently; 5 partial (§5). The §3 palette is superseded by `ui/css/session.css`. |
| [projects.md](projects.md) | spec | Projects as folders, birth at first take, the continuous mirror, whole-session templates, per-track record, post-hoc groups. The launch ritual is superseded by Q17 (boot empty). |
| [vst3.md](vst3.md) | spec + journal | VST3 effect + instrument hosting: dynamic per-node chain, native editor windows, out-of-process scanning, MIDI clips. Rulings Q-V1–V5 (§9). Phases 1–5 shipped. |
| [stacks.md](stacks.md) | spec + journal | Stack/nesting UX. The visual-design sections (superseded by ui_overhaul.md) and the Loop-on-Collapse section (superseded by time_maps.md) carry dated banners. |
| [ui.md](ui.md) | spec | Frontend/backend separation of concerns; the masterPos contract; bridge placement rules (`ui/js/protocol.js` is the method list). |
| [test_harness.md](test_harness.md) | spec | How to build and run every test layer, the gotchas, and the field checklist for loop regions. |
| [tasks.md](tasks.md) | tracker | Tiered task list + the Open Design Questions table. |
| [mockups/](mockups/) | design artifacts | HTML mockups (`sequencer_ux.html`, `sequencer_ux2.html` — the 2026-08-19 sequencer rounds behind S15). |

## Archive (`docs/archive/` — history; not edited)

| Doc | What it was | Superseded by |
|---|---|---|
| [refactoring_proposal.md](archive/refactoring_proposal.md) | The 2026-07-07 refactor plan (P0–P3) with status notes | The kernel migration (kernel.md §5; all P0 landed); remaining items in tasks.md |
| [implementation.md](archive/implementation.md) | Architecture status snapshots + the pre-session-view waveform-rendering design | kernel.md, performance.md, time_maps.md; UI by ui_overhaul.md |
| [unification_audit.md](archive/unification_audit.md) | The 2026-07-16 audit of the engine against the kernel; the rational-time decision (§4) | §1–§3 all fixed / primitives built; §4 RULED 2026-07-16 as Q12 (design_language.md) |
| [loop_region_audit.md](archive/loop_region_audit.md) | The 2026-08-30/31 loop-region / time-map audit | Content-frame law → time_maps.md (and composition.md); §5 field checklist → test_harness.md; Q13-for-groups refinements → design_language.md Q13 |
| [test_audit.md](archive/test_audit.md) | The 2026-08-12 test catalog (Tier 4) | test_harness.md; tasks.md Tier 4 |
| [design_alternatives.md](archive/design_alternatives.md) | Options considered and rejected, with reasons | The rulings in design_language.md §5 |

## Where the rulings live

Q1–Q17 — design_language.md §5 · S1–S22 — sequencer.md §0/§9/§11/§13 ·
Q-V1–V5 — vst3.md §9 · map coherence — engine_lcm_guard.md · projects
model — projects.md · display laws 13/14 — ui_overhaul.md §6.

## Ground rules for editing docs

- **design_language.md §5 is the ruling INDEX.** A ruling may live in
  the doc that owns its feature (sequencer S-series, vst3 Q-V series,
  engine_lcm_guard), but §5 must carry a one-line pointer for each.
  Rulings are recorded with dates and, where possible, direct quotes;
  docs cite rulings rather than restating them.
- Worked examples carry **state tables** (origin/period/launch/x per
  clip) — schematics drift during refactors; tables pin exact values and
  convert into golden vectors.
- Name your units: samples (engine), Q (musical), pixels (UI). Unlabeled
  frame-mixing has caused multiple field bugs.
- When a design is superseded, keep the old text under a dated
  SUPERSEDED banner pointing at the replacement — history explains why
  the code looks the way it does. Whole docs that are pure history move
  to `docs/archive/` with a 2-line ARCHIVED banner.
