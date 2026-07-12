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
- **Effects live on the lane** (landed 2026-07-12): every clip AND
  stack rail carries an `fx` chip (enabled count at rest); it expands a
  rack row of the four built-ins in canonical order — EQ, Compressor,
  Echo, Reverb (src/dsp/effects.h) — each a power switch + sliders.
  FIXED rack, not a dynamic chain: "adding an effect" is enabling a
  slot, so the audio thread needs no new lock-free collection machinery
  (all params atomic; enable is a flag flip prepared on the message
  thread). Fractal: a clip's rack shapes its own playback, a stack's
  rack shapes the summed group (stack reverb wets the whole kit).
  Mono per node (upgrades with Mono→Stereo). Bridge surface is two
  methods (setEffectEnabled / setEffectParam) + `effects` on every
  node's metadata — VST3 later replaces the rack's internals, not this
  shape. A held slider is never overwritten by the 50ms tick (the
  rename-editor guard, applied to inputs).

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
3. **Core interactions.** ✅ Done 2026-07-11. Record landed 2026-07-09
   (pulled forward after a field report that the shell had no record
   path): per-lane ● (arm = `startRecordingInNode`; the engine owns the
   Q-boundary wait), group ● arms all armable children, global ● is
   island-wide group record and creates a fresh track when nothing is
   armable; content clips show a disabled ● with a takes teaser. Mock
   now mirrors "first committed take establishes Q". The remainder
   landed 2026-07-11 (frontend-only; all three ride existing bridge
   methods):
   - **Rename**: double-click the rail name → inline editor. Enter/blur
     commit `renameNode`, Escape cancels; patchRail skips the name
     write while editing, so the 50ms tick can't clobber typing (the
     WebKit replaced-node lesson, applied to inputs).
   - **Loop-window bracket drag**: brackets are drag handles
     (pointer-captured; Q-snapped via the pure `windowDragTarget`,
     window ≥ 1Q, clamped to the lane's `intrinsicQ`), committed as
     `setLoopPoints` on release; the chip click toggles
     active ↔ bypassed (`toggleLoopWindow`, groups only). Group lanes
     WITHOUT a window get hover-revealed LATENT full-span brackets —
     dragging one in CREATES the window; dragging back out to the full
     span removes it (creation and deletion are the same gesture). The
     overlay is never rebuilt mid-drag (`body._winDrag`).
     TWO-LAYER DRAG FEEDBACK (owner, 2026-07-11): the handle follows
     the pointer CONTINUOUSLY while a dashed snap-ghost bracket (+ live
     dims and the chip's length badge) previews the Q-snapped landing —
     you see your motion AND what a release commits.
     FRACTAL WINDOWS (owner, 2026-07-11 — I5: a clip's loop region is
     the single-segment case of the stack's time-map): clips window
     exactly like groups — latent brackets, drag, chip toggle. Engine
     side (small, tested): window state hoisted from StackNode to
     AudioNode (`loopBypassed`/`windowActive` publish for every node),
     `toggleLoopWindow` accepts any node, and ClipNode playback falls
     back to the FULL take when bypassed (clip playback always looped
     [loopStart, loopEnd) — the bypass flag makes it toggleable;
     `stack_loop_tests.cc` "Clip loop window is fractal").
     WINDOW CURSOR: an amber heard-time playhead inside active brackets
     (`.win-cursor`, engine-published window phase on `playhead`) — see
     display law 13's coda.
   - **Input picker**: per-clip rail chip (`in N`, `in ·` = device
     default; groups have none — Q7, children record from their own
     inputs). The menu fetches `getInputList` on open (hot-plugged
     interfaces appear without reload); picking calls `setNodeInput`;
     disabled while the lane records. Dismiss = outside press / Escape.
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
    CODA — DEAD-RECKONING WHILE IDLE/PLAYING (field 2026-07-11: "the
    playhead loops prematurely and starts somewhere non-zero"): the
    140ms glide + 50ms poll lag the drawn line ~190ms behind true time,
    so the sweep wrapped visibly before the loop end. When NOT
    recording, the playhead is driven by a rAF dead-reckoning clock
    (`playhead_clock.js`, pure + unit-tested): it advances at the
    transport velocity ESTIMATED from published masterPos deltas (a
    static mock scene stays static; a seek reads as a teleport, never a
    speed burst), wraps EXACTLY at the audible cycle (loopCycleQ), and
    is corrected each poll. Window cursors ride the same clock (heard
    time advances at one rate everywhere), each wrapping in its own
    window. While RECORDING the animator is off and the 140ms glide
    keeps bar-edge/playhead lockstep — there is no wrap during a take.
    Hidden tabs freeze rAF but the poll correction keeps the position
    current, so the first visible frame is right (self-healing).
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
13. **Windows never reframe the timeline** (owner ruling 2026-07-11).
    The display frame and every lane period derive from INTRINSIC
    periods (`displayPeriodQ`); an active window renders as brackets +
    outside-dims repeated per period tile — a visual subset, never a
    frame change. E-C ("a windowed composite behaves as a 2Q clip in
    its parent's LCM") stays an ENGINE-side audio fact; following it in
    the VM compressed a lone 2Q stack windowed to 1Q into a 1Q frame
    (hiding content) and made the frame breathe on every
    active/bypass toggle. The engine's masterPos wraps on clip
    durations — the intrinsic frame is the one the playhead actually
    sweeps (`view_model.test.mjs` pins toggle-invariance).
    CODA (field 2026-07-11 "the loop window doesn't work anymore"):
    once the frame stopped following the window, NOTHING displayed the
    loop — the island playhead sweeps ISLAND time and sails through the
    dimmed zone while the lane audibly loops. The map needs its own
    line: the amber WINDOW CURSOR (`.win-cursor`) draws heard time
    inside the brackets from the engine-published window phase
    (`playhead` metadata), gliding with the playhead's 140ms timing and
    snapping (never sweeping backwards) at the wrap. White = island
    time, amber = this lane's mapped time.
    CODA 2 — E-C TRANSPORT WRAP (field 2026-07-11 "I don't expect the
    playhead to go past my loop region"): the published masterPos now
    wraps on the AUDIBLE cycle — `calculateEffectiveCycleLength()`,
    where an active window contributes its window length
    (`AudioNode::getEffectivePeriod`, recursive through nested stacks).
    This is E-C finally applied to the island cycle itself: island
    times t and t+len are audibly identical under a top-level window,
    so sweeping past len displayed pure noise. Exact, not approximate —
    window phase is island-clock derived, so the subtree's output is
    periodic in exactly the window length. Commit/epoch-re-base logic
    stays on the INTRINSIC length (windows are reversible view-of-time
    state, not committed material); the recording view base freezes on
    the effective wrap (the view the user was watching). The readout
    explains an early wrap: `0.4Q / 3Q ↺ · loop 2Q` (vm.loopCycleQ).
    Known rough edge, deliberately deferred: a sole windowed lane whose
    window does NOT start at 0 has the white playhead sweeping
    [0, len) while the brackets sit elsewhere — the amber cursor is the
    honest line there; revisit with time-maps phase 2.

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
