# UI Overhaul — "Tape Room"

> Status: **spec** (direction) + **proposal** (phasing). Ratified
> 2026-07-09 by owner choice among three pitched directions (A "Signal
> Path", B "Tape Room", C "Blueprint" — mockups in the session artifact;
> all three rendered the same scene from one `deriveViewModel(scene)`).
> Owner rulings: **direction B (Tape Room)**, **session view** replaces
> the floating canvas for the active island, **instrument-in-hand** is
> the primary use context. This doc is the build plan; it carries P2-10
> (deriveViewModel) with it — the redesign and the architecture are one
> project.

---

## 1. Why (the audit, condensed)

Driving the current UI (2026-07-09) surfaced six findings; three are
structural:

1. **Time is invisible.** No ruler, no Q gridlines, no position readout.
   The LCM cycle — the product's thesis — has no visual existence.
2. **Alignment breaks by construction.** Per-clip header bars indent
   every waveform differently; there is no vertical "now" line. I2
   (simultaneity ⇔ same x) is violated by the chrome, not by math.
   Composites overflow containers; nested clips overlap headers.
3. **Recording is hidden.** The core verb has no visible affordance, and
   the arm rule the engine already implements (next Q boundary, ruling
   Q11) is nowhere represented.

Plus: controls scattered in floating bars, ghosts indistinguishable from
quiet audio, and a floating canvas that costs (dead space, overflow,
empty husks) while a single active island pays nothing for it.

## 2. The skeleton (invariants made structural)

- **Session view.** The active island fills the width. The infinite
  canvas is retired for now; it returns as an island *switcher* when
  multi-island work starts (Q10 kept possible, not paid for early).
- **One shared time axis.** Controls live in a fixed left rail; every
  lane's timeline starts at the same x. I2 becomes a property of the
  layout. A single playhead line crosses ruler and all lanes (I8).
- **The cycle is drawn.** Q ruler across the island; the cycle end
  marked `↺`; a small cycle-boundary tick at each repetition start.
- **Record is the loudest thing on screen.** Global ● records into a
  new lane of the active island; per-lane arm on the rail. An armed lane
  shows a marker at the next Q boundary: "your take starts here" (Q11).
- **Stacks are folds.** A group is a header (composite) lane plus
  indented child lanes; the chevron folds children away and the
  composite never moves. Sound-neutral by construction (I6b).
- **Loop windows live on the lane.** Bracket overlay `[ ]`: drag to edit
  (Q-snapped, hysteresis), click the bracket body to toggle
  active/bypassed. Outside-window audio dims; brackets stay visible
  (editable) when bypassed.
- **Debug chrome becomes a status strip** along the bottom edge:
  transport health, calibration state (🎯 flow), dump, expandable log
  drawer. Nothing floats over the workspace.

## 3. Visual language (Tape Room tokens)

Warm hardware world; lanes read as tape strips; red is reserved for
record. Sized to be read from six feet with an instrument in hand.

| Token | Value | Use |
|---|---|---|
| `--ground` | `#171310` | app background |
| `--panel` | `#201a15` | transport, rails, status strip |
| `--lane` | `#241d17` | lane bodies (rounded tape ends) |
| `--tape` | `#e8a13c` | clip waveforms (the only loud color besides red) |
| `--tape-composite` | `#c96f3a` | group/composite waveforms |
| `--text` | `#efe6d8` | primary text (cream) |
| `--text-dim` | `#93826d` | secondary text |
| `--rec` | `#d94f30` | record, armed, and nothing else |
| `--grid` / `--grid-q4` | `#322920` / `#453727` | Q gridlines (heavier every 4Q) |

- **Ghosts = faded tape print**: same fill at ~16% opacity (not a
  dimmer copy of "content" — plus the cycle tick at each rep start).
- **Type**: condensed bold for lane names/section labels; monospace for
  all time readouts (`5.2Q / 12Q · cycle 3 ↺`); minimum sizes chosen for
  distance legibility, not density.
- **Targets** (instrument-in-hand): transport play/record ≥ 48 px;
  rail buttons ≥ 32 px; lane heights generous; sparse ruler labels
  (4Q/8Q/12Q) with full gridlines.
- **Motion**: continuous playhead sweep; record pulse; fold animation.
  All respect `prefers-reduced-motion`.
- **Hover-density is secondary**: rail shows name + state at rest;
  M/S/input expand on hover or selection — but every state must be
  *readable* without hover (glanceability first).

## 4. Architecture (P2-10, riding along)

```
backend state ──▶ deriveViewModel(state)   pure, unit-testable,
                                           timeline_model.js only
              ──▶ patchDOM(viewModel)      thin, keyed, no math
```

- `ui/js/view_model.js` — `deriveViewModel(state, viewPrefs)` returns
  plain data: `{ transport, ruler: ticks[], lanes: [{ rail, reps:
  [{xQ, wQ, ghost}], window, armAtQ }], playheadQ }`. **All geometry in
  Q units**; the *only* Q→px conversion happens in the patch layer with
  one scale function — I2 by construction, and the ghost/cursor
  "abstraction mismatch" bug class dies structurally (extent and cursor
  come from the same derivation).
- `ui/js/patch_dom.js` — keyed reconciliation of lanes/reps; no
  `getBoundingClientRect` per frame; no destroy-and-recreate.
- **True recursion**: `renderNode(node, depth)` — depth-3 stacks render
  (the current hand-unrolled syncUI silently drops them).
- **Logging gated behind a DEBUG flag** — kills the per-frame
  `nativeLog` native calls from clip_updater/ghost_renderer/syncUI.
- **Bridge untouched.** All 23 protocol methods stay; this is a
  frontend-only project (the contract test keeps everyone honest).
- Replaced wholesale: `clip_updater.js`, `ghost_renderer.js`, the
  syncUI body in `app.js`, `stack_element.js`/`node_element.js` DOM
  builders, and the stack CSS. `timeline_model.js`, `backend.js`,
  `protocol.js`, `drag_drop.js` (rewired, not rewritten) survive.

## 5. Phases (each lands green and committable)

1. **View-model core.** `deriveViewModel` + node unit tests (geometry,
   ghosts, windows, arm marker, fold). Port the golden cases from
   recording.md examples; add an executable **I2 test**: for random
   states, equal Q ⇒ equal x across all lanes.
2. **Session-view shell.** Transport bar, ruler, status strip, lanes
   rendered read-only from the VM in Tape Room tokens. Old canvas UI
   retired in the same commit (no long-lived dual UI).
3. **Core interactions.** Record (global + per-lane arm with Q-boundary
   marker), M/S, rename, fold, loop-window brackets.
4. **Drag.** Rail-handle reorder with visible drop lines; **combine only
   via explicit modifier/drop chip** — never the silent default of a
   sloppy drop (today's center-drop surprise).
5. **Polish + performance pass.** Ghost/cycle-tick rendering, waveform
   quality at distance, status-strip log drawer, reduced-motion.
6. **Test realignment.** Playwright specs rewritten against the new DOM
   (record flow, window toggle, fold, reorder); the slow visual-math
   specs (`ghost_positioning`, `cursor_bugs`, …) become millisecond VM
   unit tests.

## 6. Open items (design when reached)

- One-shot rendering (dashed, E-D style) — lands with time-maps phase 2.
- Waveform peak rendering quality at distance — iterate on hardware
  (clap-test workflow).
- Island switcher chrome — deferred until multi-island (Q10).
