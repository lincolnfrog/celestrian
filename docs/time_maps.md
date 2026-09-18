# Time-Maps: Loop Windows, Non-Contiguous Selections, and Recording Through Them

> Status: **spec**. A loop window, a trim, and a non-contiguous drum
> selection are one object — the time-map. Companions: kernel.md (the
> playback equation), composition.md (Q18: every node has an origin),
> engine_lcm_guard.md (map coherence is categorical). Index:
> docs/README.md.
>
> §8 records the designs that were tried and rejected on the way here.
> It is the only backward-looking section; §1–§7 state present law.

**Contents**

1. [Motivation](#1-motivation)
2. [The primitive](#2-the-primitive)
3. [Recording through an active map](#3-recording-through-an-active-map)
4. [Non-contiguous selections (the drum case)](#4-non-contiguous-selections-the-drum-case)
5. [Anchoring: where a map's phase comes from](#5-anchoring-where-a-maps-phase-comes-from)
6. [The editing surfaces](#6-the-editing-surfaces)
7. [Implementation and pins](#7-implementation-and-pins)
8. [Appendix — alternatives considered and rejected](#8-appendix--alternatives-considered-and-rejected)

---

## 1. Motivation

Three open problems, one object:

1. **Loop-on-Collapse violates I6b** (owner ruling: "collapsing just
   displays the full LCM; the sound shouldn't change"). The superseded
   model activated the stack loop window on collapse and ran a private
   `internal_transport_` clock that restarted at the collapse moment —
   sound changed from a view action, and phase depended on *when* you
   collapsed (a second clock, violating I8).
2. **Recording inside a windowed stack** needs defined semantics that
   honor Audio Memory (I1) without promising the impossible.
3. **Non-contiguous looping selections** (e.g. the stack loops Q1 & Q3,
   skipping Q2 & Q4 — critical for drum tracks) need a home that also
   answers №2.

---

## 2. The primitive

A **time-map** is an ordered list of segments over a node's inner
timeline:

```text
map    = { state: none | active | bypassed,
           segments: [ [a1, b1), [a2, b2), ... ] }
period = Σ (bi − ai)
a0     = mapOffset(0)
inner(t) = mapOffset((t − origin − a0) mod period)
t_child  = origin + inner(t)
```

The same object serves clips and stacks (Q18, composition.md §2): every
node has an origin, and the map anchors at `origin + a0`.

- **Origin-anchored phase.** `inner` is a pure function of the node's
  own origin and the monotonic clock — no stored counter, no dependence
  on when the user collapsed anything.
- **One implementation, fractal (I5).** A clip's loop region is a
  one-segment map; a stack's window is the same object; non-contiguous
  selections are multi-segment maps; Warp (Segment 8) later adds a rate
  term to the same primitive.
- **View purity (I6b).** Expand/collapse changes *nothing* audible. The
  `active/bypassed` state is data, edited by an explicit toggle. Collapse
  is purely a display choice.
- **Period contribution.** An active map makes the node contribute
  `period` — not its full inner duration — to the parent cycle
  (design_language.md E-C), deterministically and independent of view
  state.
- **Segments select buffer coordinates.** A window `[ws, we)` selects
  buffer samples `[ws, we)`; a multi-segment map walks its segments in
  buffer coordinates. Nothing selects content by the zero, so a zero
  move on its own never re-selects a windowed group's material. Pinned
  by `tests/content_frame_tests.cc` — which buffer sample is audible,
  not which phase is published.

---

## 3. Recording through an active map

**Semantics: the take is captured into the node's INNER timeline,
through the map.** No new invariant is needed — this is what the
existing plumbing does once the map drives the child clock:

- Children receive time via `context.master_pos`, which the mapping node
  maps before passing down.
- Capture is arrival-time based: the clip writes content at whatever
  positions its clock names. Under a `{Q1, Q3}` map, audio performed
  during the heard Q1-pass lands at inner Q1; the Q3-pass at inner Q3;
  inner Q2/Q4 stay empty.

Consequences, all falling out of the storage model:

| Situation | Behavior |
|---|---|
| Map unchanged | Playback through the map reproduces exactly what was heard — **I1 holds by construction** |
| Map deactivated/edited | The clip plays its inner timeline honestly: content where you played, gaps where you didn't, seam-crossing phrases split *at the seams* (where the performance was actually stitched) |
| Same map re-activated | **Full coherence returns** — nothing was baked; the degradation is a round trip, not a cliff |

The coherence question is settled by the owner's Q2 ruling: *editing
loop points is deliberate decoupling*.

> **The Degradation Contract** (invariant I9, design_language.md). The
> design does not owe coherence across window changes — no design can
> deliver it. What it owes is **predictable, non-destructive, reversible
> degradation**: deactivate the window and the clip plays its inner
> timeline honestly — content where you played, silence where you
> didn't, seam-crossing phrases split exactly where the performance was
> stitched. Nothing is ever baked, so re-activating the same window
> restores full coherence.

### The one-period cap (inherent, not chosen)

A looping map makes inner time revisit itself; a take longer than one
window period would overwrite its own first pass, and Celestrian has no
overdub by design. Therefore: **a take recorded through an active map
uses the window as its context loop and commits at ≤ one window
period** (hysteresis snapping as usual, computed in *heard* time). This
applies to contiguous windows equally — it is the price of any map that
loops child time. (Ordinary recording over looping clips never hits
this: island time is monotonic; clips loop, the timeline doesn't.)

### Arm/anchor semantics

Arm math runs in heard (mapped) time — you anchor against what you
hear, per the Q11 rule (next Q boundary) — then the anchor maps to an
inner-time origin through the map. Anchors land inside visited segments
by construction.

### Ruled behaviour (owner, 2026-07-09)

1. **Bypassed map → plain recording** (full inner timeline).
2. **Through-map takes commit at the mapping node's full cycle** (e.g.
   4Q), with **literal silence** in unvisited regions — one dense,
   zero-initialized buffer, exactly what capture already produces.
3. **Record through the active map**, with a visual cue that a map is
   shaping time.

---

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

### Coherence is categorical

Every map/window period is a whole multiple or exact divisor of Q,
refused categorically by the editor, the engine and the mock
(engine_lcm_guard.md). There is no free-length escape hatch; the `⚠`
badge in the editor is defensive display only.

### The gestures

The map machinery permits arbitrary segments; coherence assistance lives
entirely in the editor.

- **Cell cut.** Double-click the take → a 1Q cut on that Q cell — a
  step-sequencer gesture, natural for drums.
- **Punch cut.** Drag inside the waveform to place a cut's in-point;
  the out-point **snaps to in + kQ** — the two edges are linked and move
  in lockstep, so incoherent cuts are impossible. The dimmed cut band
  carries a length badge ("1Q", "2Q"). This generalizes design.md's
  original "Conservation of Loop Length" linked-edge rule to modular
  arithmetic.
- **Heal.** Double-click a cut, or right-click any seam handle, chip, or
  cut band.

The vocabulary splits cleanly: leading/trailing exclusions are the
**window brackets'** domain; **bands** are only the INNER gaps. The two
gestures never overlap.

Recording through a punch-cut map needs nothing extra: heard time is
groove-continuous across seams (the theorem), so arm math is unaffected;
capture write positions simply jump by kQ at each seam, which
arrival-based capture handles by construction.

**Deferred refinements:** zero-crossing micro-snap at seams (design.md
"Intelligent Edge Analysis") adjusting BOTH edges by the same amount so
the kQ length is preserved; a seam-audition control that loops playback
across the splice before committing; the true heard-frame unroll of a
mapped group's children (it breaks the shared vertical time grid and
needs its own ruling).

---

## 5. Anchoring: where a map's phase comes from

### The anchoring law

`inner(t) = mapOffset((t − origin − a0) mod period)` for clips and
stacks alike. Its single-segment case is `origin + loopStart` anchoring:
the window's content sounds at its OWN performed moment (mod len), the
un-windowed case (`start = 0`) unchanged. Pinned in
`tests/qtime_lock_tests.cc` ("windowed playback anchors at origin +
loopStart").

### The resting view is heard time

A windowed clip lane displays the window's CONTENT tiled where it
audibly sounds (displayed period = window length; every rep carries the
segment src); the display frame is the audible cycle; the one white
cursor is honest on every lane. Heard tiles sit on the frame grid with
the loop's phase baked in as content rotation (`srcTopFrac`) — a loop
that fills the frame is ALL material, so there are no wrap slivers and
no false ghosts, and cross-lane phase alignment (I2) is preserved. The
loop top is a marked `↺` point carrying the paired trim grips, separated
16 px so the end grip cannot hide behind the start.

This is session_view.md law 13 as amended: law 13's original concern —
content hidden with no way to see it — is answered by the editing
surfaces in §6, not by refusing to reframe.

### Where the frame starts

The anchoring law says where a loop's content *sounds*. Where the
frame's left edge sits is a separate fact, and it is not stored: the
view **seats** the zero from the lanes in the order they are shown —
the first lane's top is the top, and each next lane pulls the zero
forward by whole cycles-so-far until its own top lies inside the
current cycle, landing at the left edge when it can and otherwise at
its offset, wrap ghosted. The full statement, the pictures and the
rulings live in frame.md. No map edit and no commit moves an island
fact; the island zero is the first take's origin, Q's grid phase, and
only a Q13 re-trim or a seek moves it.

The case the rule exists for — A is 1Q, B a 10Q take, digits are B's
Qs; every state drawn is one the user sees:

```text
record A, 1Q            A  |a   |

record B, 10Q           B  |0   |1   |2   |3   |4   |5   |6   |7   |8   |9   |
                        A  |a   |a   |a   |a   |a   |a   |a   |a   |a   |a   |

window B to 6Q..10Q     B  |6   |7   |8   |9   |     A constrains nothing;
                        A  |a   |a   |a   |a   |     B's top seats the frame
```

And the case that needs no rule — A is a 2Q loop, B a 4Q loop whose
top falls 1Q after A's — is drawn honestly, wrap ghosted:

```text
     0    1    2    3
A    |p   |q   |p   |q   |
B    |4   |1   |2   |3   |     offset 1Q; ↺ marks the loop's top
```

A map edit while playing re-anchors the edited lane's origin (next
section) and nothing else; the seating re-derives from the new origin,
and the map-gesture pin holds the zero for the length of a drag.

### The continuity re-anchor

A map edit changes a clip's period, and the anchoring law re-derives its
phase from that period — so without intervention *which* cell is
sounding jumps arbitrarily at the commit. `continuityOrigin` (engine and
mock in lockstep) keeps the sounding sample sounding:

- **Only while the new map still covers the sounding position.** When
  the edit deletes what you are hearing, origin stays FIXED — the
  audible jump is expected (you removed that sound), and the lane stays
  anchored at the click.
- **I4 as amended:** for whole-Q maps origin moves by whole Qs only, so
  the anchor's grid phase (mod Q) is exactly preserved. Which cell
  aligns re-derives from the edit instant — the looper's
  launch-quantized feel.
- **Playing only.** Idle edits keep the deterministic fixed-origin
  layout.

Net behaviour for the origin: a cut AFTER the playing point causes no
re-anchor and no jump; BEFORE it, a whole-Q re-anchor and no jump; AT
it, no re-anchor and one expected jump. Where the loop then sits on
screen is the view's seating (frame.md), in every case. Engine-level continuity test in
`tests/time_map_record_tests.cc`; the I4 regression pin asserts the
mod-Q invariant.

### Q13: the definer's re-trim

While the island's only committed content is the Q-defining clip (or
definer stack), a segments re-trim re-establishes `Q := period`,
`zero := origin' + a0`, with the phase-preserving origin re-anchor
generalized through the map inverse (`heardOffsetOf`). Lock-collapse of
a multi-segment definer is a **splice copy** — kept cells into an
exact-size buffer — and the edit inverse owns the pre-splice buffer and
map, so undo un-splices (`Edit::Kind::Collapse`; the owned-subtree
precedent). Full statement of Q13, including the group case, lives in
design_language.md.

---

## 6. The editing surfaces

Two surfaces, one law (`ui/js/session_view/map_core.js`). Both edit in
RAW coordinates, because cut and trim geometry *is* raw-frame data —
the heard view is the right resting view and the wrong editing surface.

### The same-scale reveal

A heard lane's trim grip or seam handle drags in raw coordinates at the
lane's **own** px-per-Q (`map_bands.js runRevealDrag`).

- **Engage gate.** A real drag is > 4 px of travel or a 160 ms hold. A
  click never edits, so both clicks of a double-click land on the same
  world.
- **The unroll.** The lane unrolls the raw take around the grabbed
  thing: a reveal layer draws the visible raw slice (waveform + raw-Q
  gridlines) where the heard tiles were, the preview layer's
  dims/brackets/bands sit over it, and the view is placed so the grab
  pixel IS the handle's raw position. The handle never leaves the
  pointer; nothing rescales.
- **Edge panning.** Dragging into a visible edge (36 px, clipped by the
  viewport) pans the raw take under the hand (`PAN_MAX_PX_PER_S`), the
  bound following.
- **The frame stays pinned** for the whole gesture; live commits stream
  and are audible; release commits and the lane relaxes.
- **Cursors.** The white playhead is masked over a `.revealing` body
  like an inspector; the amber `.reveal-cursor` maps the engine's map
  phase through the committed segments (`rawCursorQ`) — sweeping kept
  material, jumping the dimmed cuts.

### The region panel

The selected clip or group grows a 52 px row under its lane
(`.lane-region`, grid column 2) with a viewport-pinned panel
(`region_panel.js`): a label ("loop 4Q · 52Q take"), then a strip
drawing the WHOLE raw take (clip peaks; a group's map mixdown — the same
array the heard tiles slice).

| Element | Gesture |
|---|---|
| The kept region (`.region-kept`) | drag = **slide** by whole Qs; ⌥ = any amount (`slideMoveFn`) |
| Bracket handles | drag = **trim** (`trimMoveFn`); ⌥ slides |
| Inner cuts (bands) | slide by their chip; resize by their handles |
| The strip | double-click = a 1Q cell cut |

Excluded material is dimmed, the kept region a bright box, and the amber
raw-time cursor runs across it. The strip is a band host with
`cycleQ = totalQ` and anchor 0, so it reuses the lane's raw-frame band
code verbatim.

**Shown** for the most recently selected lane with a ≥ 2Q take. **Not
shown** for the Q-definer (its trim law SETS Q), a pinned inspector (the
lane is its own overview), a child under a parent's map, or a recording
lane.

Overview and detail are both live: a panel drag re-tiles the heard lane
per commit; a lane drag re-draws the panel.

### Selection is the affordance

The panel appears with selection and leaves with it. Deselect with
Escape, a click on empty canvas, or a click on the top bar's empty space
(`#transport`, controls excluded).

**Keyboard:** `←` / `→` slide the selected region by 1Q (⇧ 4Q, ⌥ ⅛Q),
length held, one undo step per press (`nudgeRegion`). `[` / `]` walk the
viewport through the selected track's handles; `{` / `}` jump to the
outer loop bounds.

Pinned by `ui/js/tests/map_core.test.mjs` (the three move laws) and
`ui/e2e/region_panel.spec.js` (panel on select / off on top-bar click
and Escape; panel trim, slide, cut; nudges; the reveal keeps the grip
under the pointer and pans at the edge).

---

## 7. Implementation and pins

### Storage and the verb

- Multi-segment maps live behind ONE atomic pointer per node — one
  inline seqlocked `TimeMap` (`AudioNode::storedMap` / `setMap`), a
  window being the `n = 1` case. The loop atomics remain the
  single-segment form; the bypass flag gates both. `activeTimeMap()` is
  the single read point, so every consumer is segment-general.
- The map is a TYPE: `src/time_map.h` ↔ `ui/js/time_map.js` (segments +
  `period` / `mapOffset` / `seamDistance`), pinned by the
  `time_map_cases` goldens including multi-segment vectors.
- **The verb** is `setSegments(uuid, map)`. The engine validates
  WELL-FORMEDNESS only — ordered, disjoint, non-empty, within the inner
  cycle, ≤ 8; the editor owns coherence (§4). `n ≤ 1` delegates to
  `setLoopPoints`, so there is one single-segment path. Undoable via
  `Edit::Segments`, whose inverse captures the RAW old storage, so
  bypassed geometry survives undo. Drags stream throttled commits and
  `Edit::Segments` coalesces in the undo log, keeping one gesture to one
  undo step.
- Bridged in all three places (`protocol.js` ↔ `main_component.cc` ↔
  mock); `segments` (flat samples) in metadata, `segmentsQ` (QTime
  pairs) in the save format (additive; templates strip it).

### Recording through a map

- **Context.** `ProcessContext` carries `island_pos` (the invariant
  monotonic clock — the folded `master_pos` cannot drive arm triggers),
  the innermost active `map`, its heard grid anchor (`map_heard_top`),
  and `map_count`. A mapping stack publishes them in `childContext` and
  sets `context_loop = period`.
- **Capture.** `timing::throughMapDest` folds destinations through the
  frozen map — bounded seam runs, dense zero-initialized `[0, C)` buffer
  (zeroed at ARM on the message thread; documented D4 deviation),
  literal silence in unvisited regions.
- **Commit.** `duration = C`, the mapping node's full inner cycle
  snapshotted at arm; no island fact moves (none does at any commit).
  Compaction keeps `max(recordedLength, duration)`.
- **Seam-exact playback.** `StackNode` and `ClipNode` split blocks into
  runs at `seamDistance` boundaries, so playback through a map is
  sample-exact across mid-block seams.

### Gates and refusals

- Nested ACTIVE ancestor maps refuse the arm — their composition is a
  map product, not yet designed.
- A window edit on a node whose subtree holds a live take is refused
  until commit; siblings stay editable.
- A mapped cycle too large for a dense buffer refuses with a log.

### UI cues

Recording lanes under a map carry `throughMap` / `mapPeriodQ` — an
amber-tinted capped bar and a "⟲ NQ map" rail cue; the mapping group's
rail shows "⟲ map live". A resting mapped lane shows dims over
uncovered regions, seam ticks, and one `map · NQ` chip that reads out
the period and toggles bypass. Children of a mapped group project the
map's excluded regions as dims (`parentMapSegs`).

### What is pinned where

| Layer | Tests |
|---|---|
| Map algebra | `time_map_cases` / `map_inverse_cases` goldens, `ui/js/tests/segments.test.mjs` |
| Kernel + capture | `tests/time_map_record_tests.cc` (context plumbing, fold/cap/commit, I1 round trip, I9 degradation round trip, multi-segment node fold, bypassed == plain, gates) |
| Content frame | `tests/content_frame_tests.cc` (which buffer sample is audible) |
| Definer + splice | `tests/qtime_lock_tests.cc` |
| Frame/zero rules | `tests/regression_tests.cc`, `ui/e2e_engine/loop_edits.spec.js` |
| Persistence | `tests/session_io_tests.cc` |
| Editor algebra | `ui/js/tests/map_edit.test.mjs`, `ui/js/tests/map_core.test.mjs`, `ui/js/tests/trim_drag.test.mjs` |
| Gestures end-to-end | `ui/e2e/region_panel.spec.js`, `ui/e2e/session_view.spec.js` ("trim a long take") |

### What the map replaced

Deleted: `internal_transport_` and its reset logic; the loop-on-collapse
branch in `StackNode::process`; the collapse-moment phase jump.

**Deferred generalization:** storing a **birth map** on the clip
(contiguous heard-time buffer + mapping metadata) instead of eager
inner-time slicing — strictly more flexible (post-hoc re-mapping),
meaningfully more complex. Eager slicing is v1; the storage formats are
compatible, since slicing is applying the birth map at write time.

---

## 8. Appendix — alternatives considered and rejected

Kept so they are not re-proposed. Each entry states the design, why it
lost, and where its replacement lives.

**The modal cell/punch editor** (2026-07-22). A dedicated editing mode
with a full-lane punch surface, cells toggled in one mode and punches
dragged in another. **Rejected** after one field session: the punch
surface intercepted the bracket drags. *Modes are where it went wrong* —
the gestures now live directly on the lane (§4).

**Heard-space editing** (2026-07-23). Cuts as zero-width seam handles on
the heard lane, trim grips wrapping mod the frame. **Rejected:** cut and
trim geometry is raw-frame data, and every heard-space scheme fought
that fact — a cut has zero width in heard space, so the pointer is never
"inside" it and heal could not match. Replaced by raw-coordinate editing
(§6).

**The expanded map drag** (2026-07-23 → 2026-09-11). Grabbing a map
handle expanded the lane to its full raw take for the duration of the
drag, then relaxed on release. **Rejected:** with a 1Q definer and a 52Q
take that is a 13× rescale under the pointer (300 → 23 px/Q at 1200 px)
— snap targets smaller than a fingertip, the kept region a 92 px sliver
in a field of dims, and the other lanes still on the old grid. Owner:
"all sorts of issues happen — I am very confused about where the current
selection is." Replaced by the same-scale reveal (§6), which never
rescales.

**Eased capture** (2026-07-25). The heard↔raw grab offset measured at
pointerdown, decayed over pointer travel and then also over time, so the
handle caught up to the pointer without teleporting. **Deleted:** it
existed only to paper over the expanded drag's rescale. Two rejected
siblings, recorded because they are the obvious first ideas: *pure
delta* leaves a permanent offset and makes lane-edge bounds unreachable;
*pure absolute* teleports the handle on first move.

**The pointer warp** (2026-07-25). A `warpPointer(x, y)` bridge verb
moving the OS cursor onto the followed handle
(`juce::Desktop::setMousePosition` ← `CGWarpMouseCursorPosition`), so
the drag could be pure 1:1 absolute. **Rejected:** `CGWarp` during a
held button interleaves events from the warped cursor and the un-warped
hardware position, so the stream flip-flopped ~1.5Q under a stationary
hand — visible as flicker, audible as the map honestly following the
flip-flop. The echo filter that suppressed it had to be time-boxed, and
then the same-scale reveal removed the need entirely. *The bridge verb
still exists in `main_component.cc` and `protocol.js` with no JS caller,
kept for protocol parity.* A fourth alternative was ruled out here too:
pointer-lock warping is fragile in the webview.

**Anchoring the expansion around the grip.** Considered as a way to keep
the grabbed handle still. **Rejected:** it breaks "whole clip visible,
raw 0 at left".

**Free-length cuts** (`⌥`-resize, badged "1.37Q ⚠"). Permitted as
deliberate decoupling under Q2. **Abolished 2026-08-09**
(engine_lcm_guard.md): map coherence is categorical, refused on both
sides. The `⚠` badge survives as defensive display only.

**The fold branch of the continuity re-anchor** (2026-07-25).
Re-anchoring origin to a folded heard phase when the edit deleted the
sounding region. **Rejected:** it produced "continuity" into an
arbitrary cell, and the honest display then rotated the whole heard lane
so the new seam rendered at the playhead instead of at the click ("the
cut appears to the far left"). Origin now stays fixed in that case
(§5).

**The chip-click inspector** (retired 2026-09-13). Clicking a lane's
"window NQ" chip opened the lane's full raw duration on its own
horizontal scale, with a "done" chip and a `windowEdit` view state.
**Rejected** — owner: "I have never used it." The chip is now the
readout + bypass toggle like every other chip. *`windowEditLane`
survives only as comp mode's raw lane (takes.md §6).*

**The handle nav dock** and its ticks/viewport box. **Replaced** by the
region panel (§6), which shows the same overview in the lane's own
column and is editable. The `[` `]` `{` `}` teleport keys survive.

**The double-click flash-expand.** A ~0.9 s expansion so a new cut was
seen landing in raw context. **Gone:** the cut now lands in raw context
on the region panel, permanently.

**Stacks-only scope for multi-segment maps**, and an **invisible
wrapper node** to give clips maps by indirection. Both considered at
phase 3 and **rejected** in favour of making maps fractal — owner:
"clips too, now."

**Sparse clip storage** for through-map takes. **Rejected** — owner:
"probably a UX nightmare." Through-map takes commit as one dense,
zero-initialized buffer with literal silence in unvisited regions (§3).

**The zero-anchored map frame** (pre-Q18). Stacks anchored their map at
the RECEIVED zero (`m(t) = frame_top + walk_segments((t −
frame_top) mod period)`), so a stack window selected *zero-relative*
view positions while clips read their buffers origin-relative. The two
frames agreed only while `zero ≡ origin (mod D)`, which forced a
"content-selecting frames move together" law: definer re-trims carried
`Edit::origins` riders, seeks carried every origin by the zero delta,
and map-edit riders had to move in `AudioEngine::epochViewStep` steps.
**Superseded by Q18** (composition.md §0, §8): every node has its own
origin, maps anchor at `origin + a0` for clips and stacks alike, and
nothing selects content by the zero — so `epochViewStep` and both rider
branches are deleted. The hazard the old frame created is worth keeping:
a map that emits zero-stripped small values shifts every child whose
origin ≢ 0 (mod its duration) — the 2026-07-09 field bug where a 2Q clip
looped its Q2 under a Q1 window, still pinned by "Stack window selects
view positions" in `tests/pre_record_tests.cc`.

**A stored frame zero, moved by rules** (2026-07-19 → 2026-09-16). The
frame's left edge was the island "zero", a stored absolute sample the
engine moved for display reasons: at commit by whole old cycles (the
growth re-base, Q14b), on a window edit to the shaped loop's top (the
cycle-top rule, 2026-08-18; later gated to the loop that *defined* the
cycle, then to a "free" move invisible to every untouched lane,
2026-09-15), and alongside a playing lane's origin re-anchor (two-anchor
continuity, 2026-08-09, then only by whole cycles of everyone else,
2026-09-10). Each rule was a patch on where that number should go, it
rode every undo entry and the bundle, and the mock twinned every write.
**Rejected by the owner** as a kernel abstraction with no user-facing
meaning: the zero is not stored at all — the view seats it from the
lanes in the order shown, which reproduces every picture those rules
produced (frame.md). The engine keeps the island zero as the first
take's origin, Q's grid phase, and never moves it for a commit or an
edit.
