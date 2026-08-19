# Time-Maps: Loop Windows, Non-Contiguous Selections, and Recording Through Them

> Written 2026-07-09 from the owner's Q4/q6 rulings and the non-contiguous
> drum-loop requirement. Resolves the Loop-on-Collapse contradiction
> (stacks.md caution banner) with one primitive. Companion: kernel.md
> (this is migration step 4 made concrete).
>
> Status: **proposal — owner-reviewed direction, not yet implemented.**

---

## 1. Motivation

Three open problems, one object:

1. **Loop-on-Collapse violates I6b** (owner ruling: "collapsing just
   displays the full LCM; the sound shouldn't change"). The implemented
   model activates the stack loop window on collapse and runs a private
   `internal_transport_` clock that restarts at the collapse moment —
   sound changes from a view action, and phase depends on *when* you
   collapsed (a second clock, violating I8).
2. **Recording inside a windowed stack** needs defined semantics that
   honor Audio Memory (I1) without promising the impossible.
3. **Non-contiguous looping selections** (e.g. the stack loops Q1 & Q3,
   skipping Q2 & Q4 — critical for drum tracks) need a home that also
   answers №2.

## 2. The primitive

A **time-map** is an ordered list of segments over a node's inner
timeline:

```
map = { state: none | active | bypassed,
        segments: [ [a1, b1), [a2, b2), ... ] }   // VIEW-position ranges
period = Σ (bi − ai)
m(t)  = cycle_epoch + walk_segments( (t − cycle_epoch) mod period )
```

> ⚠️ **The mapped time stays in the received frame** (the `cycle_epoch +`
> term). Segments select *view positions* of the cycle; children align by
> their ABSOLUTE origins, so a map that emits epoch-stripped small values
> shifts every child whose origin ≢ 0 (mod its duration). Field bug
> 2026-07-09: a 2Q clip (origin = the re-based epoch, an odd Q multiple)
> looped its Q2 under a Q1 window. Pinned by "Stack window selects view
> positions" in `pre_record_tests.cc`.

- **Island-aligned phase**: `m` is a pure function of the island clock
  and the epoch — no stored counter, no dependence on when the user
  collapsed anything. `internal_transport_` is deleted (kernel step 4).
- **One implementation, fractal (I5)**: a clip's loop region is a
  one-segment map; a stack's window is the same object; non-contiguous
  selections are multi-segment maps; Warp (Segment 8) later adds a rate
  term to the same primitive.
- **View purity (I6b)**: expand/collapse changes *nothing* audible.
  The `active/bypassed` state is data, edited by an explicit toggle on
  the loop-handle UI. Bypassed keeps today's faded-handle visual
  language (which currently means "expanded"); collapse becomes purely
  a display choice.
- **Period contribution**: an active map makes the node contribute
  `period` (not its full inner duration) to the parent cycle — as the
  implemented window already does (design_language.md E-C), but now
  deterministically, independent of view state.

## 3. Recording through an active map

**Semantics: the take is captured into the stack's INNER timeline,
through the map.** No new invariant is needed — this is what the
existing plumbing does once the map drives the child clock:

- Children already receive time via `context.master_pos`, which the
  stack maps before passing down.
- Capture is already arrival-time based: the clip writes content at
  whatever positions its clock names. Under a `{Q1, Q3}` map, audio
  performed during the heard Q1-pass lands at inner Q1; the Q3-pass at
  inner Q3; inner Q2/Q4 stay empty.

Consequences, all falling out of the storage model:

| Situation | Behavior |
|---|---|
| Map unchanged | Playback through the map reproduces exactly what was heard — **I1 holds by construction** |
| Map deactivated/edited | The clip plays its inner timeline honestly: content where you played, gaps where you didn't, seam-crossing phrases split *at the seams* (where the performance was actually stitched) |
| Same map re-activated | **Full coherence returns** — nothing was baked; the degradation is a round trip, not a cliff |

The coherence question is settled by the owner's Q2 ruling: *editing
loop points is deliberate decoupling*.

> **The Degradation Contract (owner-ratified 2026-07-09, now invariant
> I9 in design_language.md):** the design does not owe coherence across
> window changes — no design can deliver it. What it owes is
> **predictable, non-destructive, reversible degradation**: deactivate
> the window and the clip plays its inner timeline honestly — content
> where you played, silence where you didn't, seam-crossing phrases
> split exactly where the performance was stitched. Nothing is ever
> baked, so re-activating the same window restores full coherence.

### The one-period cap (inherent, not chosen)

A looping map makes inner time revisit itself; a take longer than one
window period would overwrite its own first pass, and Celestrian has no
overdub by design. Therefore: **a take recorded through an active map
uses the window as its context loop and commits at ≤ one window period**
(hysteresis snapping as usual, computed in *heard* time). This applies
to contiguous windows equally — it is the price of any map that loops
child time. (Ordinary recording over looping clips never hits this:
island time is monotonic; clips loop, the timeline doesn't.)

### Arm/anchor semantics

Arm math runs in heard (mapped) time — you anchor against what you
hear, per the Q11 rule (next Q boundary), then the anchor maps to an
inner-time origin through `m`. Anchors land inside visited segments by
construction.

## 4. Non-contiguous selections (the drum case)

A `{Q1, Q3}` selection over a 4Q stack is simply
`segments = [[1Q,2Q), [3Q,4Q)]`, period 2Q.

### The seam theorem (groove-transparent cuts)

A cut is **groove-transparent iff the amount of time removed is a
multiple of Q** — the seam jumps inner time by `kQ`, so content phase
mod Q is continuous through it and the downbeat grid never hiccups.
Segment *boundaries* may sit anywhere (mid-Q punch-outs are fine); only
the removed *length* matters. Q-cell toggles are the special case where
boundaries lie on the grid. Corollary: if the inner span is a Q multiple
and every removal is a Q multiple, the map's period stays a Q multiple
and the parent LCM stays sane.

### Editor: two modes over one primitive

The map machinery permits arbitrary segments; coherence assistance
lives entirely in the editor (owner request 2026-07-09: sequencer
default, sub-Q slicing possible, UX enforces Q coherence):

- **Cell mode (default):** toggle Q cells on/off directly on the
  composite waveform — a step-sequencer gesture, natural for drums.
- **Punch mode (mistake-ectomy):** drag inside the waveform to place a
  cut's in-point anywhere; the out-point **snaps to in + kQ** — the two
  edges are linked and move in lockstep, so incoherent cuts are
  impossible by default. The dimmed cut band carries a length badge
  ("1Q", "2Q"). A modifier breaks the link for a free-length cut,
  flagged visibly (e.g. "1.37Q ⚠") — permitted as deliberate
  decoupling (Q2 ruling), never silent. This generalizes design.md's
  original "Conservation of Loop Length" linked-edge rule to modular
  arithmetic.

Refinements: **zero-crossing micro-snap** at seams (design.md
"Intelligent Edge Analysis") adjusting BOTH edges by the same amount so
the kQ length is preserved; a **seam audition** control that loops
playback across the splice before committing; non-selected regions use
the existing dim-layer visual language, extended to multiple regions.
`PhaseAligner` crossfading (implementation.md) applies at seams
unchanged.

Recording through a punch-cut map needs nothing extra: heard time is
groove-continuous across seams (the theorem), so arm math is
unaffected; capture write positions simply jump by kQ at each seam,
which arrival-based capture handles by construction.

## 5. Deletions and additions

Deleted: `internal_transport_` + its reset logic; loop-on-collapse
branch in `StackNode::process`; the collapse-moment phase jump; the
stacks.md caution-banner contradiction.

Added: map state field + segments list (single segment = today's
`loop_start/end`, so persistence is a superset); bypass-toggle bridge
method (protocol.js + main_component.cc + mock, contract-tested);
sub-block seam handling in `StackNode::process` (a seam mid-block splits
the block into runs — bounded, allocation-free); heard-time snap for
through-map takes; Q-cell selection UI.

Future generalization (explicitly deferred): storing a **birth map** on
the clip (contiguous heard-time buffer + mapping metadata) instead of
eager inner-time slicing — strictly more flexible (post-hoc re-mapping),
meaningfully more complex. Eager slicing is v1; the storage formats are
compatible (slicing = applying the birth map at write time).

## 6. Owner rulings (2026-07-09) — design ratified

1. **Bypassed map → plain recording** (full inner timeline). ✅ Confirmed.
2. **Through-map takes commit at the stack's full cycle** (e.g. 4Q),
   with **literal silence** in unvisited regions — one dense,
   zero-initialized buffer, exactly what capture already produces. No
   sparse-clip data structure ("probably a UX nightmare" — owner).
3. **Record through the active map** ✅ — with a visual cue that a map
   is shaping time.

Status: direction and semantics ratified.
**Phase 1 ✅ implemented (2026-07-09):** window state
(active/bypassed via `toggleLoopWindow`, bridged through
protocol/mock/C++), phase derived from `ProcessContext.cycle_epoch`
(windowed stacks re-base it to their window start for children — the
kernel's first time-map), `internal_transport_` deleted, collapse now
purely visual, engine publishes window phase on the stack's `playhead`
metadata field, UI fade/toggle keyed to bypass state instead of
expansion. Guarded by the rewritten `stack_loop_tests.cc`, including an
explicit I6b sound-neutrality test (expanded vs collapsed output must be
identical) and a nested-window epoch re-basing test.
**Phase 1 extension (2026-07-11, fractal per I5):** clip windows are
first-class — window state (bypass flag, `windowActive`/`loopBypassed`
metadata) hoisted from StackNode to AudioNode, `toggleLoopWindow`
accepts any node, and ClipNode playback falls back to the full take
when bypassed (its loop points were always a single-segment map; the
flag makes it toggleable). One asymmetry stood, deliberately: a
stack's window phase is island-aligned ((t − epoch) mod len, §1) while
a clip's remained origin-anchored (the kernel playback equation through
`launchPointFor`); "revisit if it bites." **It bit (2026-07-19, via
Q13):** the provisional re-trim defines `epoch := origin + loopStart`
("the trimmed loop's top is island phase 0"), but origin-anchored
playback put the audible loop top at island phase (−loopStart mod
len) — a sub-Q trim made the grid every later take arms against point
mid-loop. Clip windows now anchor at **origin + loopStart**
(`launchPointFor(origin + start, dur)`, clip_node.cc): the window's
content sounds at its OWN performed moment (mod len) — the kernel
equation applied to the surviving material, the un-windowed case
(start = 0) unchanged, and the fractal twin of the stack's
window-start re-base. Pinned in qtime_lock_tests.cc ("windowed
playback anchors at origin + loopStart"). UI: same
brackets/latents/chip/heard-time cursor on both.
**Cycle-top rule (2026-08-18, owner question "if my first track is 1Q,
why the mid-lane split?"):** the Q13 `epoch := origin + loopStart`
generalizes to LOCKED islands. A window/map edit on the clip that
DEFINES the island cycle after the edit — its new period is a multiple
of Q and of every other loop's period — moves the epoch to that
loop's heard top (`origin' + mapOffset(0)`) whenever the top sits a
whole number of Qs off the current epoch and is not already at the
frame top; the loop you just shaped fills the frame from its own top
(the visual successor of "epoch re-bases to the newest cycle-defining
origin" at commit). Whole-Q only: the Q grid never moves; an off-grid
⌥-slid top honestly stays mid-phase (its end/start grips meet under
the "↺ loop top" chip). A NON-definer edit (a sub-loop under someone
else's cycle) leaves the frame to whoever defines it — while playing,
two-anchor continuity (2026-08-09) rides the epoch by the origin's
whole-Q delta so the edited clip's frame position holds; stopped,
nothing moves. This SUPERSEDES the "both anchors stay put when the
edit removed the sounding region" half of 2026-08-09 for the definer
(the origin still stays put — audio is never touched; only the frame
top moves). `AudioEngine::attachMapEditRiders` / mock
`applyMapEditRiders`; pinned in regression_tests.cc ("CYCLE-TOP
RULE"), time_map_record_tests.cc (two-anchor, updated),
tests/trim_drag.test.mjs, e2e "trim a long take".
**Phase 1 extension 2 (2026-07-11, E-C in the transport):** the
engine's published masterPos wraps on the EFFECTIVE island cycle
(`calculateEffectiveCycleLength` / `AudioNode::getEffectivePeriod`,
recursive): an active window contributes its window length to the
island LCM, so the playhead loops with what is heard and never sails
past a top-level window (field report). Commit/epoch-re-base logic
keeps the intrinsic length. The window-not-at-0 sole-lane case leaves
the island playhead sweeping [0, len) outside the brackets (amber
cursor carries heard time) — revisit in phase 2. *(Partially addressed
2026-07-16, Q15: takes recorded while the heard cycle is shortened now
anchor INSIDE the swept [0, heard) region via the heard-frame origin
fold, so the cursor, the new take, and the heard loop read as one
coherent frame; the sweep-vs-bracket mismatch itself was resolved in
phase 2, 2026-07-21: a sole top-level stack window maps the ONE
playhead into its brackets, mirroring the Q13 resolution.)* *(Resolved for the Q13 provisional trim view, 2026-07-19: the
VM maps the ONE playhead into the selection — `playheadQ = selStartQ +
islandPos`, `loopStartQ` tells the animator where the loop region
begins — so the main cursor sweeps exactly [selStart, selEnd) and the
lane draws no separate amber cursor. The "two cursors" field bug was
this mismatch: the island playhead swept the first Q of DEAD AIR at
the buffer frame's left while the amber cursor swept the selection.)*
**Phase 1 extension 3 (2026-07-16, display grammar — Q14/Q14c):**
windowed lanes render per "ghosts show what sounds": ghost tiles are
ECHOES of the window segment at its audible repetitions (anchored at
origin + window start since 2026-07-19, matching the engine's
clip-window playback), drawn in the echo tone; the take tile is the one place showing recorded truth, with
window dims applied only there; the group composite mixes audible
content (window segments, wrap-tiled). Take marks fold by each take's
stored heard frame (`contextCycle`), so they survive frame growth and
epoch re-bases. The phase-3 cell/punch editor inherits all of this:
multi-segment maps are the same echo rendering with more segments.

**Phase 1 extension 4 (2026-07-20, LAW 13 AMENDED — the heard frame):**
the 2026-07-19 anchoring change made a clip window's frame position an
EDIT fact (where the material came from), not a playback fact (the
window loops continuously, anchored at origin + start) — but the
display still drew it as a playback fact, so the island cursor swept
regions that never sound while the sounding material sat where the
cursor never goes (field screenshot 2026-07-19). Law 13 ("windows
never reframe") is amended per the owner's ruling: **the resting view
is HEARD TIME.** A windowed clip lane displays the window's CONTENT
tiled where it audibly sounds (displayed period = window length; every
rep carries the segment src); the display frame = the audible cycle;
the one white cursor is honest on every lane. The window's raw-take
truth lives in the **EDIT VIEW**: grabbing the lane's edge grip or its
"window NQ" chip expands the lane to its full raw duration on its OWN
horizontal scale (an inspector — the seed track's trim view, per
lane), with selection brackets, dims, the amber heard cursor, and a
"done" exit (Esc works too). Law 13's original concern — content
hidden with no way to see it — is answered by the edit view instead of
by refusing to reframe. Supersedes the Q14c clip-echo rendering (the
whole heard-view lane IS audible truth; `echoReps` remains for
bypass-free legacy paths). Pinned in view_model tests ("heard view" /
"heard view is fractal").

**Phase 2 ✅ implemented (2026-07-21), on the reified `TimeMap`:**
the map is a TYPE — `src/time_map.h` ↔ `ui/js/time_map.js` (segments +
`period`/`mapOffset`/`seamDistance`), pinned by the `time_map_cases`
goldens including MULTI-SEGMENT vectors, and consumed by
`childContext`/`getEffectivePeriod`/`snapEffectivePeriod` — so every
phase-2 mechanism below is segment-general TODAY even though only
single-segment windows can be created until the phase-3 editor.
Recording through an active map works end to end:

- **Context**: `ProcessContext` carries `island_pos` (the invariant
  monotonic clock — the folded `master_pos` cannot drive arm triggers),
  the innermost active `map`, its heard grid anchor
  (`map_heard_epoch`), and `map_count`; a mapping stack publishes them
  in `childContext` and sets `context_loop = period` (ruling 2).
- **Arm** (`ClipNode::armEvaluate` through-map branch): heard-time
  `armTarget` on the map-period grid; the anchor maps to an inner
  origin through `m`. The Q15 origin fold is SUBSUMED (an inner-time
  origin has no equivalent slots). Fixing the goldens exposed a latent
  `armTarget` bug: a next-Q mark overshooting an unsnapped context top
  folded into the PAST — it now arms at the top itself (both mirrors).
- **Capture** (`timing::throughMapDest`): destinations fold through the
  frozen map — bounded seam runs, dense zero-initialized `[0, C)`
  buffer (zeroed at ARM on the message thread; documented D4
  deviation), literal silence in unvisited regions.
- **One-period cap**: heard length is clamped to one map pass; a full
  pass auto-finishes cleanly (D4 wall-guard discipline); user stops
  clamp their boundary to the period. Commit: `duration = C` (the
  mapping node's full inner cycle, snapshotted at arm), no epoch
  re-base (C divides the island cycle). Compaction keeps
  `max(recordedLength, duration)`.
- **Sub-block seam split** (§5, delivered): `StackNode`
  control/render split blocks into runs at `seamDistance` boundaries —
  playback through a map is sample-exact across mid-block seams (the
  I1 block round-trip test), fixing the pre-existing wrap blur.
- **Gates**: nested ACTIVE ancestor maps refuse the arm (their
  composition is a map product — phase 3+); window edits on a stack
  whose subtree holds a live take are REFUSED until commit
  (owner-ruled 2026-07-21; siblings stay editable); a mapped cycle too
  large for a dense buffer refuses with a log.
- **UI** (ruling 5): recording lanes under a map carry
  `throughMap`/`mapPeriodQ` — amber-tinted capped bar + "⟲ NQ map"
  rail cue; the mapping group's rail shows "⟲ map live". The
  extension-2 sweep-vs-bracket item is RESOLVED for stack windows: a
  sole top-level stack window maps the ONE playhead into its brackets
  (the Q13 resolution, mirrored). Mock in lockstep (heard-time pend,
  cap, dense-C commit, refusals, gates).
- Pinned by `tests/time_map_record_tests.cc` (context plumbing,
  FIELD-style fold/cap/commit, I1 round trip, I9 degradation round
  trip, multi-segment node-level fold, bypassed==plain, engine gates)
  and `ui/js/tests/map_record.test.mjs` (mock + VM parity).

**Phase 3 ✅ implemented (2026-07-22), FULLY FRACTAL (owner-ruled:
"clips too, now" — the stacks-only scope cut and the invisible-wrapper
indirection were both considered and rejected):**

- **Storage**: multi-segment maps live behind ONE atomic pointer per
  node (`AudioNode::map_override_`, message-thread swap + reclaimer
  retire — the D4 content-buffer discipline); the loop atomics remain
  the single-segment form; the bypass flag gates both.
  `activeTimeMap()` prefers the override, so every phase-2 consumer
  (childContext, seam splitting, effective periods, the record path)
  went multi-segment with zero changes.
- **The verb**: `setSegments(uuid, map)` — engine validates
  WELL-FORMEDNESS only (ordered, disjoint, non-empty, within the inner
  cycle, ≤ 8; the editor owns coherence per §4); n ≤ 1 delegates to
  `setLoopPoints` (one single-segment path, Q13 for free); undoable
  (`Edit::Segments`, inverse captures the RAW old storage — bypassed
  geometry survives undo; `setLoopPoints` clears an override and its
  inverse restores it). Mid-take gate applies. Bridge in all 3 places;
  `segments` (flat samples) in metadata; `segmentsQ` (QTime pairs) in
  the save format (additive; templates strip it).
- **THE ANCHORING LAW (clips)**: clip map playback ≡ the stack map
  with epoch := origin + mapOffset(0) —
  p(t) = mapOffset((t − origin − mapOffset(0)) mod period). Its
  single-segment case IS the 2026-07-19 `origin + loopStart` anchor.
  `ClipNode::render` is now a run-split read through `activeTimeMap()`
  (seam-exact, purity preserved); the whole legacy suite passes
  byte-identically.
- **Q13, multi-segment definer**: a segments re-trim of the sole
  committed clip re-establishes (Q := period, epoch := origin' +
  mapOffset(0)) with the phase-preserving origin re-anchor generalized
  through the map inverse (`heardOffsetOf`). LOCK-COLLAPSE of a
  multi-segment definer is a SPLICE COPY (kept cells → exact-size
  buffer; the edit inverse OWNS the pre-splice buffer + map, so undo
  un-splices — the owned-subtree precedent).
- **The SEQUENCER — CUT BANDS (§4 via the 2026-07-22 mock round; the
  first modal cell/punch editor shipped briefly and was replaced after
  one field session: its full-lane punch surface intercepted the
  bracket drags — modes are where it went wrong)**: a cut is a
  first-class object in the bracket vocabulary — a dim band with two
  bracket-style handles and a length chip, living DIRECTLY on the lane
  (groups at rest; clips in their raw-take view beside the trim
  brackets; windowless resting clips in place). Double-click the take
  → a 1Q cut on that Q cell (cell mode as a gesture); double-click a
  cut → it heals; drag the chip → the cut SLIDES freely, length held
  (the "exclude 1Q off the boundary" move); drag a handle → resize,
  length snapping to whole Qs on release (⌥ free, badged "N.NNQ ⚠" —
  the seam theorem visible). ONE `setSegments` per finished gesture =
  one undo step. The vocabulary split: leading/trailing exclusions are
  the WINDOW brackets' domain; bands are only the INNER gaps — the two
  gestures never overlap. `ui/js/map_edit.js` holds the pure algebra
  (innerCuts/applyCut/healCut/cellCutAt/resizeCutTarget/
  slideCutTarget). Resting display: dims over uncovered regions per
  tile, seam ticks, one `map · NQ` chip (bypass toggle); heard-view
  clip lanes tile the CONCATENATED segment content (`srcSegs`);
  composite cache keys include segments.
- **HEARD-LANE LIVE EDITING (field 2026-07-23, second iteration —
  "no modes, let me manipulate the handles live")**: on a heard-view
  lane a cut has ZERO width (it IS the splice), so it renders as a
  grabbable SEAM HANDLE with its length chip — drag slides the cut
  freely through the underlying take (length held), ⌥-drag resizes
  (whole-Q snap), double-click heals; double-click on content still
  creates a cell cut (the pointer hops heard→raw through mapOffset).
  The edge grips are LIVE TRIM handles (inward consumes kept time,
  outward reveals more take, whole-Q snap, one setSegments on release;
  **⌥-drag SLIDES** the loop by any fractional amount with the other
  end pulled along — length held, so Q coherence survives — owner
  request 2026-08-18; the plain window brackets do the same)
  — they no longer open the inspector on pointerdown (that ate the
  drag); the chip CLICK opens it, for inspection only. Two frame-math
  bugs fixed in the same pass: `clipCycleContribution` and the VM's
  audible-cycle `effPeriod` read raw loop atomics and missed segment
  overrides — the frame stayed intrinsic (4Q ruler) while the engine
  wrapped at the map period (3Q), and the next rep leaked into the
  phantom quarter ("my removed segment shows at the end"). Both now go
  through the segments-aware `nodeMapPeriod`. *Third iteration (same
  day):* the real can't-drag bug was HIT-TESTING — the overlay layer is
  pointer-events:none and the new cut chrome never opted in (and
  synthetic-event tests bypass hit-testing, so they never caught it —
  real-input verification is now the law for interactive elements).
  *Fourth iteration:* heard tiles sit on the FRAME grid with the
  loop's phase BAKED IN AS CONTENT ROTATION (`srcTopFrac`) — no wrap
  slivers, no false ghosts (a loop that fills the frame is ALL
  material; the old display dimmed its own wrap as if it were a
  repeat), correct waveform slicing everywhere, cross-lane phase
  alignment (I2) preserved. The loop top is a marked ↺ point with the
  paired trim grips separated (16 px since 2026-08-18 — the end grip
  hid 3 px behind the start: owner repro "drag the left handle to 6Q,
  the right handle is gone, a split-looking thing mid-lane"; the pair is
  now visible at rest under a "↺ loop top" chip that NAMES the mid-
  phase wrap; e2e "trim a long take" + tests/trim_drag.test.mjs pin
  the recipe) and drag badges labeled "loop
  start/end". LIVE SPLICE: seam/band/grip drags stream throttled
  `setSegments` commits — the new loop is AUDIBLE (and its waveform
  visible) while dragging; `Edit::Segments` coalesces in the undo log
  (the Position precedent) so one gesture stays one undo step.
  Seam handles/ticks wrap mod the frame with the content (a loop
  resting mid-phase per Q14 keeps its chrome ON the bright tile, never
  clipped at the frame edge); trim grips hug the content's heard
  bounds and follow the pointer with the snap-ghost + period badge
  (the two-layer bracket feedback restored).
- **THE EXPANDED MAP DRAG (owner-ruled, field 2026-07-23e — the
  design that finally landed)**: grabbing ANY map handle on a heard
  lane EXPANDS the lane to its full raw take for the duration of the
  drag — excluded material visible as dims, the cut a real band, the
  trim bracket riding an ABSOLUTE raw bound over visible content
  (dragging back over dimmed material RESTORES it; nothing is ever off
  an edge) — then release commits and the lane relaxes back to the
  heard view. Live audio streaming continues through the drag (in the
  raw frame exclusion reads as dimming, not destruction, so live
  commits stop feeling like losses). The lesson that took four
  iterations: CUT/TRIM GEOMETRY IS RAW-FRAME DATA — the heard view is
  the right RESTING view and the wrong EDITING surface; every heard-
  space editing scheme (zero-width seams, wrapping grips) fought that
  fact. Implementation notes: the drag preview renders into a
  dedicated `.drag-preview-layer` (wiping the overlay mid-gesture
  destroys the captured handle — found by real-input verification);
  drag baselines are taken at POINTERDOWN (first-move baselining ate
  single-move drags); the raw-frame pointer mapping is purely
  geometric, valid before the visuals swap.
  *UX pass (2026-07-23f):* TWO-LAYER FEEDBACK restored inside the
  expanded frame — a pointer-attached FOLLOW element (the bracket
  you're trimming, or the full band + handles of the cut you're
  sliding) moves continuously with the mouse while the dashed snap
  ghost + a live badge ("loop start · 3Q" / "1.37Q cut ⚠") mark the
  whole-Q landing; the preview appears AT pointerdown, not on the
  first move. The expansion eases open (200ms, reduced-motion aware).
  Double-click create/heal on a heard lane FLASH-EXPANDS (~0.9s) so
  the new cut is seen landing in raw context — one principle
  everywhere: every manipulation shows the whole clip and its map
  structure, then relaxes to the heard view.
  *Video round (2026-07-23g):* THE FRAME PIN — while any map gesture
  is live, the SHARED display frame holds at its drag-start value
  (`dragPinQ` → `pinFrameQ` into the VM): live commits keep streaming
  audibly, but the ruler and the OTHER lanes no longer rescale under
  the pointer; the frame settles once, on release ("the world must
  not squirm while you hold it"). Two chrome fixes rode along: the
  coincident ↺ loop-top chip is hover-revealed (it read as mid-lane
  clutter at rest), and the drag badge is edge-clamped so its text
  never clips off the lane. The round also surfaced a REAL frame bug:
  `commensuratePeriod` (timeline_model.js) predated law-13-amended —
  a whole-Q clip with an active map contributed its full DURATION to
  the stack LCM (`d % q === 0` early-out), and segments were
  invisible to it entirely, so a multi-segment clip inside a track
  stack (the owner's actual topology — top-level clips had been fixed
  in 2026-07-23b) showed a duration-sized frame. Now an active map's
  period (summed segments, or the window as its single-segment form)
  wins whenever it is a real whole-Q shortening; incommensurate
  free-cut maps still fall to the finite ceil fallback.
  *Field round (2026-07-25):* three fixes. (1) EXACT Q LABELS — a slid
  cut with fractional bounds whose sample lengths summed to exactly 1Q
  displayed "0.9999…Q": `mapOf.periodQ` is now ONE division of the
  sample sum (never a sum of per-segment divisions; pinned in
  segments.test.mjs), and user-facing Q labels go through `fmtQ`
  (snaps < 1e-6 fp residue to the whole Q, honest fractions keep two
  decimals). (2) ABSOLUTE DRAG TRACKING — runExpandedDrag's delta
  baseline carried the heard↔raw pixel mismatch through the whole
  gesture: the handle rode ~a-cut-width away from the mouse and bounds
  near a lane edge were unreachable (the mouse ran out of lane first).
  `onMove` now receives the pointer's ABSOLUTE raw-take Q; once the
  pointer moves > 4px the handle is GLUED to it (trim bracket = the
  bound, seam slide = the cut's start, ⌥-resize = the end edge). A
  grab that never moves renders the at-rest geometry, snaps nothing,
  and commits nothing. (3) THE RAW SOUND CURSOR — the expanded editing
  view now carries the amber cursor: runExpandedDrag seeds a
  `.win-cursor` in the overlay, `patchWinCursor` runs BEFORE the
  `_winDrag` gates (the reconcile stays frozen; the ear doesn't), and
  the cursor maps the live-committed segments — sweeping kept
  material, JUMPING the dimmed cuts. The main white playhead stays
  suppressed over the inspecting lane (nonsensical there); the amber
  line is the lane's one honest cursor, mid-gesture included.
  *Video round 2 (2026-07-25b):* the flicker and the grab-jump.
  FLICKER had three legs: (a) the lane-open keyframes dipped the reps
  to 25% opacity for 200ms on EVERY grab — the greys pulsed and the
  z-6 playhead bled through the translucent body (the animation is now
  transform-only); (b) the drag preview rendered raw-frame dims over
  the still-heard lane for the ~1-poll gap before the expansion landed
  (a wrong-space flash at each grab — the preview layer is now hidden
  until `.inspecting` is real and reveals with the open); (c) the
  z-index suppression of the white playhead depended on the lane
  painting opaquely over it, and the webview compositor let stray
  frames bleed — the playhead now carries a vertical MASK carving out
  the inspecting lanes' bands (`maskPlayheadOverInspectors`, patched
  per poll; paint-order-independent). GRAB-JUMP: the owner asked how
  to reconcile "handle under the mouse" with the geometric fact that
  expansion moves the grabbed content out from under the pointer.
  Answer: EASED CAPTURE — the heard↔raw grab offset measured at
  pointerdown decays with pointer travel (gone within ~15% of the
  take's width), so the first pixels behave like a delta drag (no
  teleport) and the handle then catches up and glues to the pointer:
  reachable everywhere, discontinuous nowhere. (Alternatives ruled
  out: pure delta = permanent offset + unreachable edges; pure
  absolute = teleport on first move; pointer-lock warping = fragile in
  the webview; anchoring the expansion around the grip = breaks
  "whole clip visible, raw 0 at left".)
  *The Gordian cut (2026-07-25d, owner-proposed):* rather than easing
  the geometry to the pointer, the NATIVE side moves the POINTER to
  the geometry. A `warpPointer(x, y)` bridge verb
  (juce::Desktop::setMousePosition ← CGWarpMouseCursorPosition;
  viewport CSS px ≡ JUCE points at default zoom) teleports the OS
  cursor onto the followed handle once the drag is real (> 4px — a
  sloppy grab must not move the cursor) and the raw view has landed;
  the grab offset is then zeroed and the drag is pure 1:1 absolute.
  Backends that cannot warp (the mock harness — and any future
  platform without cursor control) return false and keep the
  eased-capture fallback, which remains below.
  *Simplification (2026-07-25f, owner-ruled):* the bound is RELATIVE
  for the WHOLE gesture — anchorQ plus accumulated pointer deltas —
  and the warp is pure COSMETICS: since the cursor's absolute position
  never feeds the bound, the warp can land early, late, or mid-flight
  without resetting anything (a user who grabs and immediately drags
  fast loses nothing; there is also no intermediate to "animate along"
  — the lane-open ease is vertical, the horizontal mapping flips in
  one patch). Where warping is unsupported the mode flips to ABSOLUTE:
  the handle snaps to the pointer and stays glued — one visible jump,
  but every bound reachable and zero easing machinery. The eased
  capture (offset decay, glide timer) is DELETED.
  *Video round 7 (2026-07-25i):* the continuity re-anchor's FOLD
  branch retired. Cutting the region that was PLAYING re-anchored
  origin to a folded heard phase — sound "continuity" into an
  arbitrary cell, and the honest display rotated the whole heard lane
  so the new seam rendered at the playhead instead of the click ("the
  cut appears to the far left"). Rule now: continuity re-anchor ONLY
  while the new map still covers the sounding position; when the edit
  deletes what you are hearing, origin stays FIXED — the audible jump
  is expected (you removed that sound), and the lane stays anchored at
  the click. Net behavior: cut AFTER the playing point = no rotation,
  no jump; cut BEFORE it = whole-Q rotation, no jump; cut AT it = no
  rotation, one expected jump.
  *Video round 6 (2026-07-25h):* THE CONTINUITY RE-ANCHOR (a law
  amendment). The owner's "main playback is discontinuous when I
  double click to add/remove a Q — sometimes it works" decomposed into
  two facts (frame-forensics on the cursor trace): the white cursor's
  jump is the audible-cycle FOLD moving by whole Qs (honest, display
  only, "works" when the position lands in the shared region) — but
  the MUSICAL discontinuity was real: with a fixed origin, the
  anchoring law re-derives the clip's phase when its period changes,
  so WHICH cell is sounding jumps arbitrarily at the commit. Fix: the
  sole-definer Q13 phase-preserving re-anchor is now GENERALIZED to
  every clip map edit while playing (`continuityOrigin`, engine + mock
  in lockstep): origin' keeps the sounding sample sounding
  (inverse-mapped when covered; heard phase folds into the new period
  when the cut removed it). I4 AS AMENDED: for whole-Q maps origin
  moves by whole Qs only — the anchor's grid phase (mod Q) is exactly
  preserved; WHICH cell aligns re-derives from the edit instant (the
  looper's launch-quantized feel). Idle edits keep the deterministic
  fixed-origin layout (gated on isPlaying). Engine-level continuity
  test in time_map_record_tests.cc; the I4 regression pin updated to
  the mod-Q invariant. Also: the post-warp echo filter is TIME-BOXED
  (armed only ~400ms after the warp — armed forever it ate genuine
  fast-flick deltas and the handle fell ~1Q behind the pointer with no
  resync; owner video "drag quickly → cursor disconnected").
  *Video round 5 (2026-07-25g):* the doubled split + the engage gate.
  Dblclick-to-heal was geometrically broken on heard lanes: a cut has
  ZERO width there (it IS the splice), so the pointer is never
  "inside" it — the heal path could not match and the dblclick cut an
  ADJACENT Q instead, which merged into a doubled cut ("‖ 2Q cut").
  Fixes: (1) on heard lanes a dblclick within ±12px of a seam HEALS
  that cut; (2) RIGHT-CLICK on any seam handle, chip, or cut band
  heals — the explicit, timing-proof path; (3) THE ENGAGE GATE:
  expansion AND warp start only once a press is a real drag (> 4px or
  a 160ms hold) — a quick click(-click) leaves heard geometry
  completely untouched, so both clicks of a double-click land on the
  same world (the immediate warp used to teleport the cursor between
  them, and the expansion moved the seam out from under click two).
  Release before engagement = pure click, no commit, no visual churn.
  Also: the drag badge rides at 22% lane height (it sat on the follow
  bracket, unreadable), and a FLIGHT RECORDER (`window.__mapDbg`, last
  400 gesture events + a console warning when renders disagree under a
  still pointer) ships for the one flicker the mock cannot reproduce.
  *Video round 4 (2026-07-25e):* the warp echo. CGWarp during a held
  button can interleave pointer events from the warped cursor and the
  un-warped hardware position (the macOS local-event-suppression
  gotcha) — the absolute stream flip-flopped ~1.5Q with a stationary
  hand, blinking the preview dims ("flickering") AND streaming
  alternating setSegments maps (the "playback discontinuity" was the
  audio honestly following that flip-flop). Post-warp the gesture goes
  RELATIVE: deltas accumulate on the warped bound, and any single
  event jumping ≥150px is a warp echo that only rebases. Two more in
  the same round: the ANIMATOR wraps on vm.loopCycleQ, which the pin
  now also freezes (the readout was continuous while the 60fps line
  still folded at every live commit), and the warp fires at GRAB
  (owner-ruled; waiting for the first move felt late). BUILD GOTCHA:
  the app bundle's ui/ copy runs only on relink — JS-only changes need
  a manual sync or the field build runs stale UI.
  *Video round 3 (2026-07-25c):* two field failures fixed. (1) EASED
  CAPTURE now decays on TIME as well as travel (~350ms, a setTimeout
  glide while the pointer is still — NOT rAF, which webviews throttle
  when unfocused): travel-only decay never paid off
  against a lane edge — the trailing bound's grip rests AT the heard
  right edge, so there was no room to move and the handle sat ~1Q
  short of the pointer forever. (2) CURSOR CONTINUITY through live
  commits: the engine's published masterPos is folded on the CURRENT
  audible cycle, so every live setSegments commit moved the fold point
  and the white cursor jumped mid-gesture. getGraphState now also
  publishes `islandPos` — the RAW epoch-relative island clock, the
  invariant the canon already names — and while the frame is pinned
  the VM folds THAT on the FOLD CYCLE pinned at drag start (the
  audible cycle of that moment, ≤ the pinned frame — folding on the
  frame itself would have jumped at the grab whenever windows had
  shortened the audible cycle below the display frame): the cursor
  sweeps continuously through any number of live commits, and takes
  exactly one honest snap when the frame settles at release. (Mock
  publishes the same field; engine + mock + VM stay in lockstep.)
- **CURSOR HONESTY (field 2026-07-22)**: raw-take INSPECTOR lanes
  (edit view) stack above the global playhead — the white cursor is
  suppressed over a lane running its own horizontal scale; the amber
  heard cursor is its one honest cursor. The amber cursor is
  SEAM-AWARE everywhere (`patchWinCursor`): heard phase maps through
  the segments, jumping across cuts (snap, never a sweep through
  removed time); multi-segment maps skip the linear animator. Mapped
  group lanes carry the amber cursor too.
- **Children of a mapped group** project the map's excluded regions as
  dims (`parentMapSegs`) — the conservative step; the true re-based
  heard-frame child unroll stays deferred (it breaks the shared
  vertical time grid; needs its own ruling).
- Pinned by: `map_inverse_cases` goldens, storage/undo/gate tests +
  the ENGINE-LEVEL record-through-a-setSegments-cell-map test
  (tests/time_map_record_tests.cc), the multi-segment clip kernel +
  splice round-trip tests, the multi-segment definer + splice-collapse
  flow (tests/qtime_lock_tests.cc), session round trips
  (tests/session_io_tests.cc), and ui/js/tests/{segments,map_edit}
  .test.mjs; verified end-to-end in the mock preview (cells, punch,
  undo, record-through-cells).

**Deferred from phase 3** (post-field-test refinements): zero-crossing
micro-snap, seam audition, and the true heard-frame unroll of
mapped-group children. (Per-segment edge dragging shipped with cut
bands; the multi-segment heard cursor shipped seam-aware on the amber
line — the WHITE cursor still sweeps the audible cycle linearly over
intrinsic-frame group lanes, with the amber line as the honest one.)
