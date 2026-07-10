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
- **The recording frame is TAKE-ANCHORED** (2026-07-09, from the field
  dump): while recording, the frame anchors at the take's start — the
  new phrase's downbeat is the visual top, previewing the engine's
  epoch re-base on commit — and grows one whole Q at a time to hold the
  cursor (`vm.cycleQ` = frame, decoupled from `vm.lcmQ`). Committed
  lanes rotate their origin-anchored tiles to show their phase against
  the take. The anchor snaps to a whole Q (Q11), which also cancels the
  pre-record latency compensation baked into live `duration` (the bar's
  end honestly trails the playhead by ~C — E-E). Ruler/readout mark a
  growing frame with `…`, a settled cycle with `↺`.
- **Arm is fractal (Q7 ruling, 2026-07-09).** Arming a group arms every
  *armable* child track; record captures them simultaneously, each from
  its own input, sharing one arm target and one committed duration. The
  drum use-case: one button records all five kit tracks. **Arm targets
  emptiness**: a clip with content is not armable (no overdub by
  design) — group record records the empty clips and just plays the
  full ones; re-recording content is the takes feature. The rail's arm
  control on a group shows aggregate state over armable children
  (all / some / none) and disables when nothing is armable.
- **Stacks are folds.** A group is a header (composite) lane plus
  indented child lanes; the chevron folds children away and the
  composite never moves. Sound-neutral by construction (I6b).
- **The main (non-ghost) tile is the first full repetition** (owner
  ruling 2026-07-10). A looping clip has no privileged historical rep —
  "which cycle it was recorded in" is not a musical fact, so
  origin-modular take marking (which drew the bright tile mid-frame) is
  wrong; only the clip's PHASE (origin mod period) shapes the tile
  grid. Groups tile from frame 0 (a composite is not a performance).
  Waveforms are display-normalized to the clip's own peak: waveforms
  show shape, meters show level.
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

1. **View-model core.** ✅ Done 2026-07-09: `ui/js/view_model.js`
   (`deriveViewModel` + `unrollReps`, Q units, window-aware periods per
   E-C, group-arm aggregate over armable children) with 14 unit tests
   incl. the I2/I8 random-scene property test; verified against a real
   hardware state dump. Take tile = origin mod **cycle** (mod period
   collapses "recorded at 2Q" onto the 0Q tile).
2. **Session-view shell.** ✅ Done 2026-07-09: `session_view.js` (patch
   layer — the app's only Q→geometry conversion, as % of cycle),
   `css/session.css` (Tape Room tokens), new `index.html` /
   `index_test.html`; app.js is glue (poll → derive → patch). Old canvas
   UI retired in the same commit (7 modules, 3 stylesheets, 13 old e2e
   specs deleted); 12 new session-view e2e specs including a pixel-level
   I2 check (0px boundary difference measured). Wired in phase 2: play,
   fold, M/S, add-stack/clip, calibrate, dump. Record button present but
   inert until phase 3.
3. **Core interactions.** 🔶 Record landed 2026-07-09 (pulled forward
   after a field report that the shell had no record path): per-lane ●
   (arm = `startRecordingInNode`; the engine owns the Q-boundary wait),
   group ● arms all armable children, global ● is island-wide group
   record and creates a fresh track when nothing is armable; content
   clips show a disabled ● with a takes teaser. Mock now mirrors
   "first committed take establishes Q". Still open in this phase:
   rename, loop-window bracket drag, input picker.
4. **Drag.** Rail-handle reorder with visible drop lines; **combine only
   via explicit modifier/drop chip** — never the silent default of a
   sloppy drop (today's center-drop surprise).
5. **Polish + performance pass.** Ghost/cycle-tick rendering, waveform
   quality at distance, status-strip log drawer, reduced-motion.
6. **Test realignment.** Playwright specs rewritten against the new DOM
   (record flow, window toggle, fold, reorder); the slow visual-math
   specs (`ghost_positioning`, `cursor_bugs`, …) become millisecond VM
   unit tests.

## 6. The display laws

> Status: **spec** — each law was paid for by a field bug (2026-07-09/10
> iteration arc with the owner); violations are bugs. Where a law has an
> executable test it is named; the rest are enforced by code structure.

1. **The masterPos contract** (ui.md): `masterPos` is the engine's
   DERIVED display position — wrapped when idle, growing past the LCM
   while recording. Consumers never re-wrap it; the mock mirrors it.
2. **Idempotent writes.** No DOM write unless the value changed —
   WebKit swallows clicks whose mousedown-target text node was replaced
   before mouseup, and the 50ms patch tick makes unconditional writes
   hit most human clicks (`setText`/`setHtml`/`setTitle`).
3. **State-metrics law.** A lane body's box metrics never change with
   state: accents are inset box-shadows, never borders/padding (a 2px
   armed border once shifted every rep; e2e pins body rects across
   states).
4. **Reconciled layers, never nuked.** Lane bodies patch in three
   layers (grid/reps/overlay); rep divs are REUSED with CSS-morphed
   geometry (e2e "NO FLASH" pins DOM-node identity across a commit).
   Fresh tiles materialize AT their geometry (`transition: none` until
   first paint); transiently empty peaks keep the last canvas.
5. **Append-stability.** Live waveforms draw at a FIXED px-per-slot
   scale (`poolColumns` fixed mode, nearest-only upsampling): a peak's
   pixels are a function of its slot index only — content appends, never
   remaps (`waveform_stability.test.mjs`). Live peaks are TIME-INDEXED
   (`live_peaks.js`): slot = duration at capture, immune to poll cadence.
6. **Ratcheting live normalization.** The running max only rises, so
   the boost target only falls; easing toward it (30%/poll) cannot
   oscillate and CONVERGES to the committed boost (0.95/max) — commits
   are popless by construction (`live_peaks.test.mjs`).
7. **Phase-preserving growing frame.** While recording, the frame
   shifts by WHOLE CYCLES only (never rotates committed lanes), extends
   one whole Q exactly AT the boundary (the take is never off-screen),
   and pure pending never extends. Tile grids derive from
   `offset mod period`, never through the frame (`view_model.test.mjs`).
8. **Composites are settled material.** Group waveforms mix only
   committed children whose REAL waveform has been fetched — never
   recording takes (per-poll regen glitches), never live meter peaks
   (their alien amplitude scale re-normalizes the composite to nothing).
9. **The main tile is the first full repetition** (owner ruling): a
   looping clip has no privileged historical rep; only phase shapes the
   grid. Groups tile from frame 0 (a composite is not a performance).
10. **The bar's edge is "now".** The recording bar extends to the
    playhead (both glide with the same 140ms timing); the written
    content trails inside by the latency compensation, honestly (E-E).
11. **Morph only pure moves; snap re-layouts.** A tile whose canvas was
    redrawn in the same patch as its geometry change SNAPS (transition
    suppressed for that frame): animating a container over new content
    is false motion — the composite visibly stretched at every growing
    commit until this. Since px-per-Q is preserved across a settle, the
    snap reads as content lighting up, not moving. Surplus tiles fade
    out (220ms) rather than vanish mid-morph.
12. **The mock speaks Q11 and awaiting-stop.** Arms PEND to the next
    boundary (origins always land on boundaries — a mid-Q mock origin
    once poisoned the whole grid after re-base); stops enter
    awaiting-stop and commit at `nextStopBoundary` while the rail shows
    "finishing…" (owner ruling 2026-07-10: stops always pad forward).

## 7. Open items (design when reached)

- **Long-cycle display: the px-per-Q floor** (ratified direction
  2026-07-09, after the growing-frame work). Fit-to-width dies on long
  LCMs (a 2.7Q take over a 1Q loop → 27Q cycle → every Q becomes
  spaghetti; tasks.md open question 5). The law: **a Q never renders
  below a minimum width (~48 px); when the frame exceeds what fits, the
  view keeps a fixed Q scale and auto-follows the playhead**, with the
  readout/ruler ↺ carrying cycle position (ghosts already say "it
  loops" — you need *now* + structure, not all 27Q at once). The
  groundwork exists: the display frame is already decoupled from the
  LCM (vm.cycleQ vs vm.lcmQ), so scroll-mode is a patch-layer change.
  Build in phase 5.

- **Templates** (Q7 companion ruling): a saved node subtree — structure,
  names, input assignments — loadable into a session ("drum stack" =
  one click). Needs a bridge method pair (save/load template) and a
  home in the transport or an "add" menu; intersects Save/Load
  (roadmap Segment 6). UI slot reserved in the shell; backend work
  scheduled after phase 3.
- **Takes** (Q7 companion, owner-deferred until core workflow lands):
  "new take" on the record button (context menu or long-press), a take
  list per clip to switch between; never duplicate-track/mute-old. VM
  keeps the door open: a lane's content is already a single `take` —
  extending to `takes[] + activeTake` touches no geometry.
- **Engine-side contract harness** — ✅ Built 2026-07-10:
  `tests/ui_contract_tests.cc` drives a real record→commit through the
  engine, asserts the published contract, and dumps every poll to
  `shared/ui_contract_capture.json`;
  `ui/js/tests/engine_replay.test.mjs` replays those polls through the
  actual `deriveViewModel` and asserts display invariants (frame never
  oscillates, playhead continuous, I2 tiling). First run immediately
  caught a false assumption: **the engine has NO downward stop snap** —
  `stopRecording` always awaits the NEXT boundary (`nextStopBoundary`),
  continuing to record until it lands (`isAwaitingStop` published).
  ✅ RESOLVED (owner, 2026-07-10): stops always pad FORWARD to the next
  boundary (the engine's behavior is canon; design_language.md
  hysteresis entry amended). The snap-back-with-auto-loop-window idea is
  deferred until it hurts in practice. Mock aligned to awaiting-stop;
  the rail shows "finishing…" while the take runs to its boundary.
- One-shot rendering (dashed, E-D style) — lands with time-maps phase 2.
- Waveform peak rendering quality at distance — iterate on hardware
  (clap-test workflow).
- Island switcher chrome — deferred until multi-island (Q10).
