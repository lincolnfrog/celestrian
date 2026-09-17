# Celestrian Docs Index

> Every doc carries a status: **spec** (binding — drift from code is a
> bug), **proposal** (direction, not yet fully built), or **journal**
> (history — kept for context, may describe superseded designs).
> Index trued 2026-09-15.
>
> A spec states what IS, in present tense. Where a doc has needed to
> record what it *used* to be, that lives in a final **Appendix —
> alternatives considered and rejected**: one entry per fork, saying
> what was tried, why it lost, and where its replacement lives. Nothing
> before the appendix looks backwards.

## Canon (read these first)

| Doc | Status | What it is |
|---|---|---|
| [design_language.md](design_language.md) | spec | The vocabulary (§1), the numbered invariants (I1–I9), worked examples with state tables, and the owner-ruling INDEX (§5: Q1–Q17 in full, plus one-line pointers to rulings recorded elsewhere). **Start here.** |
| [kernel.md](kernel.md) | spec — implemented | The cyclic kernel: one monotonic clock, per-node origins, time-maps. §2 is the kernel itself, §3 the transport + recording lifecycle, §5 the migration record. Appendix §6. |
| [recording.md](recording.md) | spec | Recording math: quantum, origins, arm/stop snapping, the LCM cycle view, ghosts. The worked examples are the executable spec (golden vectors). |
| [time_maps.md](time_maps.md) | spec | Loop windows and non-contiguous selections as time-maps; recording through a map; the seam theorem; anchoring (§5 — the anchoring law, the cycle-top rule, the continuity re-anchor, the content frame); the editing surfaces (§6 — the same-scale reveal and the region panel). Appendix §8. |
| [sequencer.md](sequencer.md) | spec | The fractal Sequence primitive on stacks: the **period law** (§2 — a stack's effective period is window ▸ active sequence length ▸ LCM of children's effective periods), gate/cue entrances, record-into-a-step, cue steps, successor graphs + the seed (§14 — the PROGRAM, root-only radios), per-step fades. Rulings S1–S22 (§0, §9, §11, §13). Appendix §16. **Section numbers are cited by other docs — do not renumber.** |
| [engine_lcm_guard.md](engine_lcm_guard.md) | spec | The Q-coherence ruling (2026-08-09): every map/window period is a whole multiple or exact divisor of Q, enforced categorically on both sides; free-length cuts abolished. |
| [performance.md](performance.md) | spec | The audio-thread contract (§1 is project law), latency model, calibration feature, perf backlog and instrumentation. |
| [composition.md](composition.md) | spec | The recursive theory of time composition stated once: the node record, the one anchoring law for every node (Q18 — stacks have origins), the period/cycle consumer table, the epoch's role, anchoring events, invariants I10–I16, worked group examples, and nesting in practice (§10 — the fractal principle, per-stack LCM, composites). **Read after design_language.md.** |

## Supporting

| Doc | Status | What it is |
|---|---|---|
| [design.md](design.md) | vision | Product vision, UX flows, feature roadmap. Broadest and oldest; overruled mechanics carry bracketed pointers to the ruling. |
| [session_view.md](session_view.md) | spec | The Tape Room session view (was `ui_overhaul.md`): the skeleton (§2), the interactions (§5), and the display laws (§6, laws 1–15, incl. the window law 13, the seek law 14 and the play-start law 15). Colors live in `ui/css/session.css`, not here. Appendix §8. |
| [projects.md](projects.md) | spec | Projects as folders, birth at first take, the continuous mirror, whole-session templates, per-track record, post-hoc groups, the launch ritual (boot empty, Q17). Appendix at the end. |
| [vst3.md](vst3.md) | spec | VST3/AU effect + instrument hosting: the dynamic per-node chain, native editor windows, out-of-process scanning, MIDI input and note clips (§8). Rulings Q-V1–V5 (§9). Appendix §11. |
| [ui.md](ui.md) | spec | Frontend/backend separation of concerns; the masterPos contract; bridge placement rules (`ui/js/protocol.js` is the method list). |
| [test_harness.md](test_harness.md) | spec | How to build and run every test layer, the gotchas, and the field checklist for loop regions. |
| [bounce.md](bounce.md) | spec | Bounce / export (Q19): the span rule (root: one effective cycle from the epoch; node: one effective period from origin + a0), the −90 dBFS tail, stereo float WAV at the device rate, the bounce == live render golden. |
| [takes.md](takes.md) | spec | Takes and comping (B4): a committed slot holds N immutable takes sharing one origin/period; the new-take arm rule (`t ≡ origin mod period`, one-period cap, stop = cancel); per-Q-cell comp with cell seams; undo shapes; persistence keys; what the UI half owes. Engine shipped; UI pending. |
| [import.md](import.md) | spec | Audio file import (B6): a WAV/AIFF/FLAC as a committed take — nearest-Q placement from the drop, the hysteresis length law, pre-Q import defines Q, a new take onto a committed slot, resampling, undo; the WebView path limit (a drop without a path → the chooser at the drop's Q). |
| [frame.md](frame.md) | spec | Where the frame starts: the shared frame's zero is seated by the view from the lanes in the order shown (each loop's top at the left edge when a whole cycle-so-far reaches it, else where it fell, wrap ghosted), never stored. The engine keeps Q and the island zero (the first take's origin) and moves neither for a commit or a map edit. The pictures, the rulings it replaced (2026-09-16), what is pending. |
| [tasks.md](tasks.md) | tracker | Tiered task list + the Open Design Questions table. |
| [mockups/](mockups/) | design artifacts | HTML mockups (`sequencer_ux.html`, `sequencer_ux2.html` — the 2026-08-19 sequencer rounds behind S15). |

## Archive (`docs/archive/` — history; not edited)

**The archive is inert: you never need to open it to learn current
law.** Live docs may cite it for *provenance* ("this came from the
2026-08-31 fuzz audit"), never for content. If you find yourself
opening an archived doc to find out how something works today, that is a
bug in the live doc — fix the live doc.

| Doc | What it was | Where its content lives now |
|---|---|---|
| [refactoring_proposal.md](archive/refactoring_proposal.md) | The 2026-07-07 refactor plan (P0–P3). Its **P-numbers are still cited** — see the legend below | The kernel migration (kernel.md §5; all P0 landed); remaining items in tasks.md |
| [implementation.md](archive/implementation.md) | Architecture status snapshots + the pre-session-view waveform-rendering design | kernel.md, performance.md, time_maps.md; UI by session_view.md |
| [unification_audit.md](archive/unification_audit.md) | The 2026-07-16 audit of the engine against the kernel; the rational-time decision (§4) | §1–§3 all fixed / primitives built; §4 RULED 2026-07-16 as Q12 (design_language.md) |
| [loop_region_audit.md](archive/loop_region_audit.md) | The 2026-08-30/31 loop-region / time-map audit | Content-frame law → time_maps.md §8 + composition.md §0/§8 (the epoch frame it described is deleted by Q18); §5 field checklist → test_harness.md; Q13-for-groups refinements → design_language.md Q13 |
| [design_alternatives.md](archive/design_alternatives.md) | Options considered and rejected, with reasons | The rulings in design_language.md §5 |

### P-number legend

The refactor plan's labels outlived it — 21 comments in `docs/`, `src/`
and `ui/js/` still cite them. They resolve here, so the archive stays
closed:

| Label | The item | Where it landed |
|---|---|---|
| P0-2 | Make the audio thread real-time safe | performance.md §1 (project law) |
| P0-3 | Store the Quantum explicitly | kernel.md §5 step 1; design_language.md Q1 |
| P0-4 | Extract the transport into a testable state machine | kernel.md §3 (`ClipNode::RecState`) |
| P0-5 | Stop hardcoding the sample rate | performance.md §4 |
| P1-6 | `ClipNode::process` god function → context down | kernel.md §5 step 2 |
| P1-7 | Pixels out of the engine | kernel.md §5 step 2; ui.md |
| P1-8 | Shrink `AudioNode`; virtual `forEachChild`/`getNodeType` instead of per-block `dynamic_cast` | performance.md §1 (threading split) |
| P2-9 | A single backend facade | ui.md; `ui/js/backend.js` |
| P2-10 | Derive a view model, then patch the DOM | session_view.md §4 |
| P2-11 | Mock backend: state + protocol only | test_harness.md |

## Where the rulings live

Q1–Q17 — design_language.md §5 · S1–S22 — sequencer.md §0/§9/§11/§13 ·
Q-V1–V5 — vst3.md §9 · map coherence — engine_lcm_guard.md · projects
model — projects.md · display laws 13/14 — session_view.md §6.

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
- **A spec states what IS.** Resolve amendment chains rather than
  stacking them: if a rule was ruled, then amended twice, the body
  carries the rule *as it stands now*. A reader must never have to
  replay the history to learn the current law.
- **When a design is superseded, it moves to the doc's final
  Appendix — alternatives considered and rejected.** One entry per
  fork: what was tried, why it lost, where the replacement lives. The
  point is not the record, it is that nobody re-proposes it. Drop the
  maintenance log (which bug, which round, which iteration) unless it
  states a standing hazard — and if it does, that hazard belongs on the
  law it guards, or in `.agent/tech.md`. Whole docs that are pure
  history move to `docs/archive/` with a 2-line ARCHIVED banner.
- **Some section numbers are an API.** sequencer.md especially is cited
  by number from eight other files (and by `.agent/style.md`'s example
  of citation form). Check `grep -rn '<doc>.md §' docs .agent` before
  renumbering anything.
- **Verify before restating.** These docs name the symbol and the test
  behind nearly every law. When rewriting one, grep `src/`, `ui/js/`,
  and `tests/` for the names it cites; a symbol that no longer exists
  means the doc has drifted, and that is a finding to report, not a
  sentence to copy forward.
