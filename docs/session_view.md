# The Session View — "Tape Room"

> Status: **spec.** This is the shipped UI. Ratified 2026-07-09 by owner
> choice among three pitched directions; the rulings were **direction B
> (Tape Room)**, **session view** replaces the floating canvas for the
> active island, and **instrument-in-hand** is the primary use context.
> Index: docs/README.md.
>
> *(Was `ui_overhaul.md` until 2026-09-15 — the overhaul shipped, so the
> doc is named for what it specifies rather than for the project that
> produced it.)*
>
> §8 records the designs that were tried and rejected. It is the only
> backward-looking section; §1–§7 state present law.

**Contents**

1. [Why (the audit that started it)](#1-why-the-audit-that-started-it)
2. [The skeleton (invariants made structural)](#2-the-skeleton-invariants-made-structural)
3. [Visual language](#3-visual-language)
4. [Architecture](#4-architecture)
5. [The interactions](#5-the-interactions)
6. [The display laws](#6-the-display-laws)
7. [Open items](#7-open-items)
8. [Appendix — alternatives considered and rejected](#8-appendix--alternatives-considered-and-rejected)

---

## 1. Why (the audit that started it)

Driving the pre-session-view UI surfaced six findings; three were
structural:

1. **Time was invisible.** No ruler, no Q gridlines, no position
   readout. The LCM cycle — the product's thesis — had no visual
   existence.
2. **Alignment broke by construction.** Per-clip header bars indented
   every waveform differently; there was no vertical "now" line. I2
   (simultaneity ⇔ same x) was violated by the chrome, not by the math.
   Composites overflowed containers; nested clips overlapped headers.
3. **Recording was hidden.** The core verb had no visible affordance,
   and the arm rule the engine already implemented (next Q boundary,
   Q11) was nowhere represented.

Plus: controls scattered in floating bars, ghosts indistinguishable from
quiet audio, and a floating canvas that cost dead space, overflow, and
empty husks while a single active island pays nothing for it.

---

## 2. The skeleton (invariants made structural)

### Layout

- **Session view.** The active island fills the width. There is no
  infinite canvas; it returns as an island *switcher* when multi-island
  work starts (Q10 kept possible, not paid for early).
- **One shared time axis.** Controls live in a fixed left rail; every
  lane's timeline starts at the same x. I2 is a property of the layout.
  A single playhead line crosses ruler and all lanes (I8).
- **The cycle is drawn.** A Q ruler spans the island; the cycle end is
  marked `↺`, with a small cycle-boundary tick at each repetition start.
- **Stacks are folds.** A group is a header (composite) lane plus
  indented child lanes; the chevron folds children away and the
  composite never moves. Sound-neutral by construction (I6b).
- **Debug chrome is a status strip** along the bottom edge: transport
  health, calibration state (🎯 flow), dump, expandable log drawer.
  Nothing floats over the workspace.
- **The preferences panel is the one surface for per-machine choices.**
  The transport's gear opens it (`ui/js/preferences.js`); it holds the
  audio device pickers (`audio_settings.js` renders its
  dependency-chained selects into `#audio-device-host`), latency
  calibration (`#calibrate-btn` / `#calibration-status`; app.js wires
  the measurement — performance.md §7), and the **projects root**
  (projects.md) read from `getProjectInfo.projectsRoot`, with "Change…"
  picking it natively (`chooseProjectsRoot` answers the new path, `""`
  when cancelled). Per-machine and persisted — distinct from per-project
  state, which lives in the bundle.

### Recording

- **Record is the loudest thing on screen.** The track's ● is THE
  record verb; the transport carries no record button (per-track record,
  projects.md). An armed lane shows a marker at the next Q boundary:
  "your take starts here" (Q11).
- **The recording frame is TAKE-SEATED.** While recording, the pending
  take seats last in the frame's seating (frame.md) — it starts in the
  cycle it started in, so the frame during recording IS the frame after
  commit — and the frame grows one whole Q at a time to hold the cursor
  (`vm.cycleQ` = frame, decoupled from `vm.lcmQ`). Committed lanes keep
  their pictures. The take's start snaps to a whole Q
  (Q11), which also cancels the pre-record latency compensation baked
  into live `duration` — the bar's end honestly trails the playhead by
  ~C (E-E). Ruler and readout mark a growing frame with `…`, a settled
  cycle with `↺`.
- **Arm is fractal (Q7).** Arming a group arms every *armable* child
  track; record captures them simultaneously, each from its own input,
  sharing one arm target and one committed duration. The drum use-case:
  one button records all five kit tracks. **Arm targets emptiness** — a
  clip with content is not armable (no overdub by design), so group
  record records the empty clips and just plays the full ones;
  re-recording content is the takes feature. A group's arm control shows
  aggregate state over armable children (all / some / none) and disables
  when nothing is armable.
- **Takes ride the record button** (B4, takes.md §6). With nothing empty
  beneath, ● on a committed clip — or on a group whose committed direct
  clips exist — is a NEW TAKE (`newTake`; the ring carries a dot): the
  lane keeps its tiles dimmed and `silent` under the live bar while the
  slot renders silence, and ● again cancels. The rail head carries the
  take chip `T<active>/<n>` (quiet with one take), which opens the take
  list under the rail — per-take mini waveforms, ✓ on the active row,
  click selects, × deletes (never the last), and a `comp` row. Comp mode
  is view state like the window editor: one band per Q cell over the
  take tile in the cut-band grammar, badge `T<k>` or `·`, a click cycles
  the cell and commits ONE `setComp` (⌘Z per click); cells naming
  another take tint in that take's hue with its waveform slice drawn
  over, at rest too. Escape closes the list (PANEL scope) and leaves
  comp mode; the comp stays.

### Tiles and windows

- **Tiles derive from phase, not history.** A looping clip has no
  privileged historical rep — "which cycle it was recorded in" is not a
  musical fact — so only the clip's PHASE (`origin mod period`) shapes
  the tile grid. The take tile marks at its heard phase
  `(origin − zero) mod contextCycle` (Q14); whole cycle-counts fold
  away, and only takes with no honest position in the current frame fall
  back to the first full rep. A group has an origin and its lane carries
  a take mark like a clip's (Q18, composition.md §9).
- **Waveforms are display-normalized to the clip's own peak.** Waveforms
  show shape; meters show level. ONE gain per take (2026-09-23): every
  committed tile of a take — whole, heard slice, repeat — draws at the
  whole take's boost (`canvas_renderer.peaksBoost`), never at its own
  slice's loudest peak, so a loud hit entering or leaving a loop never
  rescales the lane (display law 16).
- **Loop windows live on the lane.** Bracket overlay `[ ]`: drag to edit
  (Q-snapped), click the bracket body to toggle active/bypassed.
  Outside-window audio dims; brackets stay visible and editable when
  bypassed. The full gesture set is §5; the raw extent lives on the
  region panel (time_maps.md §6).

### Effects

Every clip AND stack rail carries an `fx` chip (enabled count at rest)
that expands a rack row. **The chain is dynamic** — built-ins and
plugins are peer slots, addressed by slot uuid, reorderable; the chain
model, bridge surface, and persistence are vst3.md's. Fractal as
everything else: a clip's chain shapes its own playback, a stack's
chain shapes the summed group, so stack reverb wets the whole kit. A
held slider is never overwritten by the 50 ms tick (display law 2,
applied to inputs).

**Visualizations.** Every card carries a live canvas fed by the chain's
SCOPE. The audio thread only copies the pre-chain signal into a
2048-sample ring; the 24-bin Goertzel spectrum, peak, and compressor GR
are derived on the MESSAGE thread at poll time inside `getMetadata` —
zero analysis on the audio thread, and a racy ring read only smears a
picture.

| Card | Drawing |
|---|---|
| EQ | spectrum bars under the bands' analytic response curve — `fx_viz.js` ports the SAME RBJ math as the DSP, so the drawn curve IS the biquads (unit-pinned) |
| Compressor | scrolling peak envelope in dB space, threshold as a red dashed line, top-down GR meter + readout |
| Echo | tap timeline (dry pulse, then repeats at k·time with mix·fb^(k−1) heights), breathing with the live peak |
| Reverb | exponential tail scaled by mix, length from size/damp |

**Scope gating.** Capture is gated on the panel being OPEN
(`setEffectScope`, called by the fx chip toggle) — no watcher, no copy,
zero audio-thread cost for closed panels. An open panel's chain is
"live" even with zero slots enabled (`isLive = anyEnabled ∨ scope`), so
the spectrum and threshold-vs-peaks display work BEFORE committing to an
effect. The ring exists solely for the spectrum — every other display
consumes block peaks, and a spectrum cannot be derived from peaks.
Compressor makeup is an output trim, −12..+24 dB.

**Durable spectrum.** The EQ card draws a cream line over the live bars:
a weighted HIGH-WATER MARK, not an average. `holdSpectrum` in
`fx_viz.js` rises fast (half the gap per poll) and falls slowly (~5 s
time constant) per bin, so the line holds the song's tonal shape through
gaps and only relaxes when the content really left. Client-side over the
published bins; null polls are identity; a bin-count change reseeds.
*Bars = the moment, cream line = the song, tape curve = your EQ.*

### The master strip

The root stack IS the master bus — every node carries gate → fx →
gain·pan (composition.md §1), the root included — so the strip in the
transport bar is the root's output stage made visible. `#master-monitor`
holds the two VU faces (`#vu-l` / `#vu-r`), the vertical
`#master-fader`, and the `#master-fx-btn` chip.

- **The meter** is post-fader: the engine meters the device buffers
  after `root_node->process` (`audio_callback.cc`) — i.e. after the
  root's gain·pan and chain — through an envelope follower (~15 ms
  attack / ~400 ms release). Each face carries a peak-hold tick (parked
  ~1.5 s at the highest needle angle, then falling) and a clip lamp that
  breathes above −3 dB and LATCHES solid when the follower reads full
  scale; click the face to release it (`vu_meter.js meterStep`,
  unit-pinned).
- **The fader** is the root's `gain` through the same `setNodeGain(rootId, v)`
  verb the rail dials use — attenuate-only (unity is the ceiling, the
  no-boost law), double-click for unity, not undoable like every mixer
  knob. It is a fader rather than a dial because the master is a fader
  on every real deck.
- **The fx chip** opens the root's chain as the FIRST row of the
  session — the identical synthetic fx row a group rail's chip opens,
  keyed `fx:<rootId>` — so a master reverb or compressor is one click.
  `rootGain` / `rootFxCount` ride the view model beside `rootId`.
- **Persistence** is bundle-level like the root's mute and chain:
  `rootGain` / `rootPan` in session.json (absent = unity / center;
  `session_io_tests`).

---

## 3. Visual language

**The shipped theme is `ui/css/session.css`** — "Gunmetal & walnut":
matte gunmetal chassis, walnut side rails, light only from lit elements.
Read the CSS for colors; the rules below are the law that outlives any
palette.

A warm hardware world; lanes read as tape strips; **red is reserved for
record and nothing else**. Sized to be read from six feet with an
instrument in hand.

- **Ghosts = faded tape print** — the same fill at ~16% opacity, not a
  dimmer copy of "content", plus the cycle tick at each rep start.
- **Composites** carry their own tone, distinct from clip waveforms.
- **Echoes** (repetitions of a window segment) draw in a cool tone.
- **Type:** condensed bold for lane names and section labels; monospace
  for all time readouts (`5.2Q / 12Q · cycle 3 ↺`). Minimum sizes are
  chosen for distance legibility, not density.
- **Targets** (instrument-in-hand): transport play ≥ 48 px; rail buttons
  ≥ 32 px; lane heights generous; sparse ruler labels (4Q / 8Q / 12Q)
  with full gridlines.
- **Motion:** continuous playhead sweep, record pulse, fold animation —
  all respecting `prefers-reduced-motion`.
- **Hover-density is secondary.** The rail shows name + state at rest;
  M/S/input expand on hover or selection — but every state must be
  *readable* without hover. Glanceability first.

---

## 4. Architecture

```text
backend state ──▶ deriveViewModel(state)   pure, unit-testable:
                    view_model.js (display) over timeline_model.js
                    (kernel math, golden-pinned to src/timing.h)
              ──▶ session_view.js + ui/js/session_view/*.js
                    (the patch layer: keyed reconciliation, Q→px)
```

- `ui/js/view_model.js` — `deriveViewModel(state, viewPrefs)` returns
  plain data (lanes, reps, windows, arm marks, playhead, frame). **All
  geometry in Q units**; the *only* Q→px conversion happens in the patch
  layer with one scale function. I2 holds by construction, and the
  ghost/cursor "abstraction mismatch" bug class dies structurally —
  extent and cursor come from the same derivation. Kernel math (periods,
  LCMs, launch points, time-maps) is imported from `timeline_model.js`,
  never re-derived.
- `ui/js/session_view.js` + `ui/js/session_view/*.js` (`lane_build`,
  `lane_body`, `rail`, `ruler`, `map_bands`, `region_panel`, `seq_grid`,
  …) — keyed reconciliation of lanes and reps; no
  `getBoundingClientRect` per frame; no destroy-and-recreate (display
  law 4).
- **True recursion:** lanes build per node depth, so nested groups render
  at any depth.
- **Logging is gated behind a DEBUG flag** — no per-frame `nativeLog`.
- **The bridge grows with features, contract-tested.**
  `ui/js/protocol.js` carries the method list; every addition lands in
  all three places or `protocol_contract.test.mjs` fails.

---

## 5. The interactions

- **Record.** Per-lane ● arms (`startRecordingInNode`; the engine owns
  the Q-boundary wait). A group ● arms all armable children. Content
  clips show a disabled ● with a takes teaser.
- **Rename.** Double-click the rail name for an inline editor;
  Enter/blur commit `renameNode`, Escape cancels. `patchRail` skips the
  name write while editing, so the 50 ms tick cannot clobber typing
  (display law 2).
- **Loop-window bracket drag.** Brackets are drag handles
  (pointer-captured, Q-snapped via the pure `windowDragTarget`, window
  ≥ 1Q, clamped to the lane's `intrinsicQ`), committed as
  `setLoopPoints` on release; the chip click toggles active ↔ bypassed
  (`toggleLoopWindow`). The overlay is never rebuilt mid-drag
  (`body._winDrag`).
- **Latent brackets.** A lane WITHOUT a window gets hover-revealed
  full-span brackets: dragging one in CREATES the window; dragging back
  out to the full span removes it. Creation and deletion are the same
  gesture.
- **Two-layer drag feedback.** The handle follows the pointer
  CONTINUOUSLY while a dashed snap-ghost bracket — plus live dims and
  the chip's length badge — previews the Q-snapped landing. You see your
  motion AND what a release commits.
- **Windows are fractal (I5).** Clips window exactly like groups —
  latent brackets, drag, chip toggle. Engine side, window state lives on
  `AudioNode` (`loopBypassed` / `windowActive` published for every
  node), `toggleLoopWindow` accepts any node, and ClipNode playback
  falls back to the FULL take when bypassed (`stack_loop_tests.cc`,
  "Clip loop window is fractal").
- **The window cursor.** An amber heard-time playhead inside active
  brackets (`.win-cursor`, engine-published window phase on `playhead`)
  — display law 13's coda.
- **Input picker.** A per-clip rail chip (`in N`, `in ·` = device
  default); groups have none, since under Q7 children record from their
  own inputs. The menu fetches `getInputList` on open, so hot-plugged
  interfaces appear without reload; picking calls `setNodeInput`. It is
  disabled while the lane records. Dismiss with an outside press or
  Escape.
- **Drag.** HTML5 rail drag where **drop-on-clip COMBINES** the two into
  a new group, drop-on-group moves the track inside, and the ＋ Track row
  is the drag-out target. A selected rail carries the whole selection.
  Groups are a post-hoc gesture and order is by creation, so there is no
  within-parent reorder.
- **Zoom.** Manual horizontal zoom (`session_view/zoom.js`, ⌘/Ctrl+wheel,
  `+` / `−`).
- **Creating.** Every `+` is a template picker (Q17): a fixed "Track"
  default row plus the user's saved subtree templates. Groups are not a
  menu item.
- **Promoting.** Drag a sub-stack out of its parent and it becomes
  top-level; the ＋ Track row is the drag-out target.
- **Recording into a sub-stack.** Record on a clip inside a sub-stack;
  it respects Q from the island root and commit works normally. A
  group's ● arms every armable child (Q7).
- **Empty stacks are allowed** — created via a template or left behind
  by a drag-out, drawn with a placeholder.
- **Multi-select is level-scoped.** Shift/Cmd+click selects siblings
  only; selecting a group selects the whole group, not its contents;
  selection never spans nesting depths.

The map-editing gestures — the heard lane's splice handles (swap) and
↺ (shift), the same-scale reveal (⇧ = length), the region panel and its
start marker, nudges, and the `[` `]` `{` `}` teleports — are
time_maps.md §6.

---

## 6. The display laws

> Each law was paid for by a field bug; violations are bugs. Where a law
> has an executable test it is named; the rest are enforced by code
> structure.

1. **The masterPos contract** (ui.md): `masterPos` is the engine's
   DERIVED display position — wrapped when idle, growing past the LCM
   while recording. Consumers never re-wrap it; the mock mirrors it.
2. **Idempotent writes.** No DOM write unless the value changed —
   WebKit swallows clicks whose mousedown-target text node was replaced
   before mouseup, and the 50 ms patch tick makes unconditional writes
   hit most human clicks (`setText` / `setHtml` / `setTitle`).
3. **State-metrics law.** A lane body's box metrics never change with
   state: accents are inset box-shadows, never borders or padding (a 2px
   armed border once shifted every rep; e2e pins body rects across
   states).
4. **Reconciled layers, never nuked.** Lane bodies patch in three layers
   (grid / reps / overlay); rep divs are REUSED with CSS-morphed
   geometry (e2e "NO FLASH" pins DOM-node identity across a commit).
   Fresh tiles materialize AT their geometry (`transition: none` until
   first paint); transiently empty peaks keep the last canvas.
5. **Append-stability.** Live waveforms draw at a FIXED px-per-slot
   scale (`poolColumns` fixed mode, nearest-only upsampling): a peak's
   pixels are a function of its slot index only — content appends, never
   remaps (`waveform_stability.test.mjs`). Live peaks are TIME-INDEXED
   (`live_peaks.js`): slot = duration at capture, immune to poll cadence.
6. **Ratcheting live normalization.** The running max only rises, so the
   boost target only falls; easing toward it (30%/poll) cannot oscillate
   and CONVERGES to the committed boost (0.95/max) — commits are popless
   by construction (`live_peaks.test.mjs`).
7. **Phase-preserving growing frame.** While recording, the frame shifts
   by WHOLE CYCLES only (never rotates committed lanes), extends one
   whole Q exactly AT the boundary (the take is never off-screen), and
   pure pending never extends. Tile grids derive from `offset mod
   period`, never through the frame (`view_model.test.mjs`).
8. **Composites are settled material.** Group waveforms mix only
   committed children whose REAL waveform has been fetched — never
   recording takes (per-poll regen glitches), never live meter peaks
   (their alien amplitude scale re-normalizes the composite to nothing).
9. **Tiles derive from phase.** A looping clip has no privileged
   historical rep; only phase shapes the grid. The take tile marks at
   its heard phase `(origin − zero) mod contextCycle` (Q14/Q14b), and
   whole cycle-counts fold away. Groups have origins and take marks like
   clips (Q18, composition.md §9).
10. **The bar's edge is "now".** The recording bar extends to the
    playhead (both glide with the same 140 ms timing); the written
    content trails inside by the latency compensation, honestly (E-E).
    **Coda — dead-reckoning while idle or playing.** The 140 ms glide
    plus the 50 ms poll lag the drawn line ~190 ms behind true time, so
    a naive sweep wraps visibly before the loop end. When NOT recording,
    the playhead is driven by a rAF dead-reckoning clock
    (`playhead_clock.js`, pure and unit-tested): it advances at the
    transport velocity ESTIMATED from published masterPos deltas (a
    static mock scene stays static; a seek reads as a teleport, never a
    speed burst), wraps EXACTLY at the audible cycle (`loopCycleQ`), and
    is corrected each poll. Window cursors ride the same clock — heard
    time advances at one rate everywhere — each wrapping in its own
    window. While RECORDING the animator is off and the 140 ms glide
    keeps bar-edge and playhead in lockstep; there is no wrap during a
    take. Hidden tabs freeze rAF, but the poll correction keeps the
    position current, so the first visible frame is right.
11. **Morph only pure moves; snap re-layouts.** A tile whose canvas was
    redrawn in the same patch as its geometry change SNAPS (transition
    suppressed for that frame): animating a container over new content
    is false motion — the composite visibly stretched at every growing
    commit until this. Since px-per-Q is preserved across a settle, the
    snap reads as content lighting up, not moving. Surplus tiles fade
    out (220 ms) rather than vanish mid-morph — EXCEPT under a map edit
    (`lane_body.mapEditInFlight`: a live map/window gesture, the frame
    pin, a post-commit hold on the lane or its region panel, a lane's
    map geometry changing between polls, and 400 ms after the last of
    these). There surplus tiles go at once and a new peaks identity (a
    member's splice regenerating its group's composite) swaps without
    the content cross-fade: each live splice re-lays the tiles, and a
    fading copy of the old layout is a double image on every whole-Q
    trim step (loop-region diagnosis F9, 2026-09-23).
12. **The mock speaks Q11 and awaiting-stop.** Arms PEND to the next
    boundary — origins always land on boundaries, and a mid-Q mock
    origin once poisoned the whole grid after re-base. Stops enter
    awaiting-stop and commit at `nextStopBoundary` while the rail shows
    "finishing…"; stops always pad forward.
13. **A window sets the part's length — for groups exactly as for
    clips.** A lane's default material is what is HEARD: an active
    window's content tiled at the window length (the heard view, one
    shared `heardViewFields` for clip and group builders). Its chip and
    every cycle it feeds — the island frame, the transport readout, the
    root and nested "+ step" units, the seed step — read the EFFECTIVE
    period, mirroring the engine's `getEffectivePeriod`
    (`timeline_model.stackEffectivePeriod`: window, else sequence, else
    the children's effective LCM, nested windows shortening it all the
    way up).

    The raw extent lives on the REGION PANEL under the selected lane
    and, mid-gesture, in the lane's same-scale reveal — a ⇧-drag at a
    splice, a length change (time_maps.md §6); a plain splice drag is a
    swap, previewed on the heard lane itself; the chip toggles bypass. Children under an active group map show the
    slice the map selects of them (`childSrcSegsUnderMap`) — no
    projection dims, no chrome; the parent owns the edit. Bypass
    restores the raw-framed lane with its brackets, and the frame
    follows honestly, because the part IS its raw length again.

    Only a STEP AUDITION's derived window keeps the frame as the song's
    — it is a monitoring loop, not a part length (`isAuditionWindow`;
    the cursor maps into the step).

    Parity is pinned by `map_coherence.test.mjs` (PARITY),
    `view_model.test.mjs`, and `sequence.test.mjs` ("+ step" follows a
    windowed group).
14. **The ruler is the seek surface.** Click teleports the transport;
    press-and-drag scrubs continuously (no Q snap — the pointer is the
    truth). One inverse mapping serves every view
    (`ruler_seek.seekTargetFromFrac`, unit-tested): the audible loop
    occupies `[loopStartQ, loopStartQ + loopCycleQ)` of the display
    frame, a click CLAMPS into that span (an audition's bracket is a
    boundary, never an exit — clicking outside it scrubs to its edge),
    and the target is the offset into the loop — a PHASE. The app turns
    it into the phase ADVANCE the engine takes (`seek.js`): the view
    seats the frame's zero (frame.md), the engine reads no frame, so
    the view computes how far the phase must move against the latest
    poll's frame facts and names the clock reading it used; the engine
    corrects for the clock since. The play start (law 15) is a phase
    too, converted the same way on every return.

    Engine side, a seek moves the island's zero — and every origin with
    it — BACK by the advance (`AudioEngine::seekTransport` →
    `StackNode::seekZeroTo`): the monotonic clock is never touched
    (kernel.md), `islandPos` teleports with the zero, the picture is
    invariant (every lane rides the move), and the dead-reckoner (law
    10) classifies the jump as a teleport, never velocity. NOT undoable
    — a monitoring gesture, like `auditionStep`. REFUSED while any take
    is live or armed (takes place audio by the clock), mirrored in the
    UI as a locked cursor (`seek-locked`).

    Corollary: the playhead is VISIBLE WHILE STOPPED (dimmed,
    `#playhead.idle`) once Q is established — a seek needs somewhere to
    land, and the resting line says where playback will resume. The
    gesture must not `preventDefault` (it would suppress the focus
    change that blurs an open rename editor); tick-label selection is
    disarmed in CSS instead. A dim hover line previews the clamped
    landing spot. Pinned by `seek_tests.cc`, `ruler_seek.test.mjs`, and
    the "Ruler scrub (seek)" e2e block.
15. **Play starts from the play start, and stop returns to it** (owner
    ruling 2026-09-10). Space / ▶ always plays FROM the play start, and
    stopping returns the playhead TO it. The play start is the top (0)
    by default; a ruler seek moves it to that seek's target, and a click
    back at the top restores the default.

    This is **UI policy composed from two engine primitives** —
    `togglePlayback` (a pure pause/resume, which the engine's own flows
    and tests rely on) and `seekTransport` (a whole-island phase jump).
    The engine keeps neither a play-start nor a restart-from-top notion;
    positions here are `seekTransport` targets in published-masterPos
    samples.

    Per project and **not persisted** — a gesture of this session, so a
    project switch falls back to the top. Pre-Q there is no frame to
    seek in, so the toggle runs alone. A seek the engine refuses (a take
    live or armed, law 14) leaves the playhead where it is.
    `ui/js/play_start.js`, pinned by `play_start.test.mjs`.
16. **Heard tiles are sampled per column, exactly** (loop-region phase
    1, 2026-09-23 — the field video's "flashing waveforms"). Each pixel
    column of a heard tile maps through the tile's `srcSegs` +
    `srcTopFrac` — `mapOffset` of the column's heard phase, the heard
    view's own mapping — to its fractional raw range, and max-pools the
    peaks there (`canvas_renderer.mappedColumns`, one pooling kernel
    with `poolColumns`, one envelope renderer `drawEnvelope`). A tile
    the frame clips (a pinned frame mid-trim) shows the leading part of
    its period (`lane_body.tileSpan`). The retired renderer sliced
    `srcSegs` at whole peaks, rotated by a rounded peak count and refit
    the result to the tile, so every sub-peak edit re-stretched the
    tile and jittered every feature ½–1 peak (~11 px at 156 px/Q), and
    each canvas normalized to its own loudest peak — every live commit
    made the WHOLE lane lurch and breathe. THE INVARIANT: a map slide
    changes only the columns its seams sweep, on every repeat; every
    other column of every lane the map shapes is unchanged, and a loud
    hit entering the loop changes no other column (one gain per take).
    MIDI tiles place their notes through the same mapping
    (`midi_notes.sliceNotesToTile`). Pinned by
    `heard_tile_sampler.test.mjs` (with a reproduction of the old
    slicer proving the gate catches it) and `e2e/heard_tiles.spec.js`
    (the canvas pixels; no fading or cross-fading copy during a trim).
17. **The frame holds while you edit, and settles once** (loop-region
    phase 2, 2026-09-24; frame.md §1). While a lane is selected no edit
    re-seats the frame's zero — every loop edit lands in a still
    picture. A selection change, a clear or an armed take releases the
    hold, and the frame glides onto its seat once: 560 ms, the
    shortest way round, landing exactly (`session_view/frame_hold.js`).
    The glide is animation-frame RE-DERIVES from the last poll — the
    same path a gesture's local preview takes between polls
    (`requestRender`, `pending_edits.js`) — so four things must hold
    on a re-render: the ruler's ticks and every lane's gridlines are
    PLACED from the zero drawn (reused elements, never a keyed
    rebuild), so the grid scrolls with the picture, each label naming
    its line where the glide lands it (`buildRulerTicks`); tiles drop
    their own morph while the zero glides
    (`#lanes.frame-settling`), or they would trail it; the playhead's
    dead-reckoner is shifted, on every patch, by how far the zero moved
    against the island zero, and a re-render feeds it nothing else
    (`animatorFrame`) — fed as a poll, a stale clock reads as a jump
    back and stalls the sweep, and a poll that folded a glide into its
    delta would read it as speed (a seek, which moves the island zero
    with the frame, still reads as a teleport); and a hand on the frame (a live
    gesture, or its pin until the commit settles) is never moved under
    — a glide in motion completes as the hand comes down.
    `prefers-reduced-motion` jumps. Pinned by `frame_hold.test.mjs`
    and `e2e/frame_settle.spec.js`.

---

## 7. Open items

- **Long-cycle display: the px-per-Q floor.** Fit-to-width dies on long
  LCMs — a 2.7Q take over a 1Q loop gives a 27Q cycle, and every Q
  becomes spaghetti (tasks.md open question 5). The ratified law: **a Q
  never renders below a minimum width (~48 px); when the frame exceeds
  what fits, the view keeps a fixed Q scale and auto-follows the
  playhead**, with the readout and ruler `↺` carrying cycle position —
  ghosts already say "it loops", so you need *now* plus structure, not
  all 27Q at once. The groundwork exists: the display frame is already
  decoupled from the LCM (`vm.cycleQ` vs `vm.lcmQ`), so scroll-mode is a
  patch-layer change.
- **The status-strip log drawer.** Not built.
- **Waveform peak rendering quality at distance** — iterate on hardware
  (clap-test workflow).
- **Island switcher chrome** — deferred until multi-island (Q10).

### The contract harness (built, and worth knowing about)

`tests/ui_contract_tests.cc` drives a real record → commit through the
engine, asserts the published contract, and dumps every poll to
`shared/ui_contract_capture.json`; `ui/js/tests/engine_replay.test.mjs`
replays those polls through the actual `deriveViewModel` and asserts
display invariants (frame never oscillates, playhead continuous, I2
tiling). Its first run immediately caught a false assumption in the
docs: the engine has **no downward stop snap** — `stopRecording` always
awaits the NEXT boundary (`nextStopBoundary`), continuing to record
until it lands (`isAwaitingStop` published). That became the ruling
(law 12).

---

## 8. Appendix — alternatives considered and rejected

Kept so they are not re-proposed.

**The infinite canvas** with floating islands, the pre-session-view UI.
**Retired** with the Tape Room ruling: it cost dead space, overflow and
empty husks, while a single active island pays nothing for it. Its
modules were deleted wholesale in the shell commit —
`clip_updater.js`, `ghost_renderer.js`, the `syncUI` body in `app.js`,
the `stack_element.js` / `node_element.js` DOM builders, and the stack
CSS. It returns only as an island *switcher* if multi-island work starts
(Q10).

**Direction A "Signal Path"** and **direction C "Blueprint"** — the two
pitched alternatives to Tape Room. All three rendered the same scene
from one `deriveViewModel(scene)`, which is why the architecture
survived the choice. **Rejected** by owner preference for the hardware
world.

**A global record button** recording into a new lane of the active
island. **Superseded by per-track record** (projects.md): the track's ●
is THE record verb and the transport carries no record button.

**The 2026-07-09 palette tokens.** The original pitch fixed warm values
— `--ground #171310`, `--panel #201a15`, `--lane #241d17`, `--tape
#e8a13c`, `--tape-composite #c96f3a`, `--text #efe6d8`, `--text-dim
#93826d`, `--rec #d94f30`, `--grid #322920` / `--grid-q4 #453727`.
**Superseded** by the shipped "Gunmetal & walnut" theme in
`ui/css/session.css`. The *rules* above the table survived unchanged;
only the values moved, which is why §3 now points at the CSS instead of
restating hex.

**The fixed four-slot effect rack.** EQ → Compressor → Echo → Reverb per
node, enable-a-slot rather than add-an-effect, so the audio thread
needed no lock-free collection machinery; a two-method bridge
(`setEffectEnabled` / `setEffectParam`) keyed by type id; mono per node.
**Replaced** by the dynamic chain (vst3.md): built-ins and plugins are
peer slots addressed by slot uuid, and the type-id bridge methods no
longer exist. The prediction held — VST3 replaced the rack's internals,
not the *shape* of the lane's fx chip.

**"Windows never reframe the timeline"** (2026-07-11, reversed
2026-08-21 by law 13). The display frame and every lane period derived
from INTRINSIC periods (`displayPeriodQ`); an active window rendered as
brackets plus outside-dims repeated per period tile — a visual subset,
never a frame change. E-C was held to be an ENGINE-side audio fact only,
because following it in the VM compressed a lone 2Q stack windowed to 1Q
into a 1Q frame (hiding content) and made the frame breathe on every
active/bypass toggle. **Rejected** once the heard view arrived: a window
sets the part's length, and the raw extent got its own surface (the
region panel) instead of owning the frame. *The field origin of the
reversal: a 52Q drum group windowed to a few Q kept a 52Q chip, a 52Q
"+ step", seeded 52Q root steps — a 104Q song around a 4Q groove — and
showed two cursors, because the heard-view amendment had landed on the
CLIP builder only. Owner: "Celestrian is supposed to be fractal at a
deep level."*

**Groups tile from frame 0** ("a composite is not a performance").
**Superseded 2026-09-01 by Q18:** a group has an origin, so its lane
carries a take mark like a clip's (composition.md §9).

**Drop-lines with an explicit combine modifier**, and within-parent
reorder. The original phase-4 drag plan. **Did not ship:**
drop-on-clip COMBINES, drop-on-group moves inside, and order is by
creation, because groups are a post-hoc gesture.

**The always-visible stack waveform and the "flag" indent.** Before the
session view, a parent stack drew child stacks indented beneath an
aligned header waveform, with per-level playhead alignment as the
explicit design goal, plus a `stack-styles.css` opacity rule keyed on an
`isExpanded` flag. **Superseded by this doc:** a group is a composite
header lane plus indented child lanes on ONE shared time axis, so
alignment (I2) is structural rather than something the chrome achieves.
`stack-styles.css`, `.stack-header-waveform` and `isExpanded` are all
deleted; `ui/css/session.css` is the only stylesheet.

**Visual distinction by colored border** — a collapsed sub-stack drawn
clip-like with a purple border, an expanded one as an indented
container. **Superseded** by the lane grammar.

**"New Stack" as a creation-menu item.** **Rejected by Q17:** every `+`
is a template picker, and groups arrive post-hoc by drag or whole via a
group template — never as an empty container you then fill.

**Right-click → "Combine into Stack"** over a multi-selection.
**Replaced** by drag-to-combine; no such context menu exists.

**Zone-based drop targeting** — splitting each node into top / center /
bottom thirds, the center third meaning COMBINE. See the drop-lines
entry below; neither shipped.

**Drill-in mode** (double-click to make a sub-stack the whole view).
Listed as future work through the canvas era and never built; folding
plus the region panel cover the need. Kept because it is the obvious
thing to re-propose — if it returns it should be a zoom level, not a
mode.

**"Ghost clips are NOT rendered when a stack is collapsed."** The
rationale was that a collapsed stack acts like a single clip.
**Superseded by Q14c:** echoes mark every audible repetition, clips and
groups alike.

**Snap-back-on-stop with an auto loop window** — stopping outside the
hysteresis tolerance would end immediately and set the loop region to
the previous clean multiple, preserving the tail. **Deferred** (owner,
2026-07-10): stops always pad FORWARD to the next boundary. The idea
stays on file until it hurts in practice.
