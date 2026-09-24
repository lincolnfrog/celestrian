# Loop selection: regions, splices and the top

How a track's **loop region** works: what it is in the model, what each edit does to the sound and to the picture, the two surfaces that edit it, and what keeps the picture steady while you edit. It also records what Phase 1 shipped (2026-09-23) and the proposed roadmap for Phase 2.

It builds on three canon docs and does not restate them:
- [time_maps.md](time_maps.md): the map primitive, coherence, recording through maps, rejected alternatives (§8).
- [frame.md](frame.md): where the frame's left edge sits.
- [session_view.md](session_view.md): the display laws.

Working prototype of the Phase 2 interaction (synthesized audio, private link): https://claude.ai/artifact/CTXfc82VNJZEUQGJgvrxiK

---

## 1. Why this exists

On 2026-09-22 the owner filmed fine loop-region edits on the Windows build and called the feature "by far the weakest part of the UX … unusable as a looper".

What the video showed:
- **Release jump.** A −0.15Q slide jumped every lane by 1Q on release.
- **Waveform swap.** Grabbing a lane grip swapped the whole lane to raw audio.
- **Doubled chip.** The "↺ loop top" chip drew twice.
- **Stray cursor.** A cursor line flashed at the start of the take.
- **Unusable panel scale.** The region panel could not zoom: about 12 px per Q, so 1 px was about 0.08Q.
- **Confusing splice.** A mid-Q splice appeared as a confusing `] [` pair of grips.

An eight-agent diagnosis reproduced every one of these. Phase 1 fixed the glitches and made the panel zoomable. Phase 2 redesigns the lane-side gestures around one idea: a splice is one instant, so it gets one handle.

---

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Q** | The quantum, the island's grid unit. All positions below are in Q. |
| **Take** | The recorded buffer. Raw positions run from 0 to `totalQ`. |
| **Origin `O`** | The island time at which raw 0 was performed. |
| **Region (map)** | The kept segments `[[s0,e0), [s1,e1), …]` in raw Q. A plain window is one segment. |
| **Period `S`** | Σ segment lengths: how long one pass of the loop lasts. It is always a whole number of Q (or an exact divisor of Q; see time_maps.md §4). |
| **Raw time / raw view** | Positions in the take. The region panel shows raw time. |
| **Heard time / heard view** | Positions on the island clock, where things sound. Lanes show heard time. |
| **Frame `F`** | The shared visible cycle: the LCM of the lanes' periods. |
| **Frame zero `Z`** | The island time of the frame's left edge. The view picks it ("seats" it, frame.md); the engine does not store it. |
| **Splice (seam)** | A heard instant where the recording jumps. There is one at the **wrap** (the loop's end jumping back to its start) and one per **inner cut**. |
| **Top `↺`** | The loop's one: where it reads as starting, and where the frame settles on deselect. Today it is always the region start. Phase 2 proposes a stored mark that region edits leave alone and whose drag **shifts** the audio in time (§9). |
| **Swap / shift** | A swap changes *what* plays (region, splice, cut, trim); a shift changes *when* (the ↺ drag moves the take's origin). §9.2. |

---

## 3. The anchoring law, worked through

Every sample of a take sounds when it was performed, folded into the loop (time_maps.md §5):

```
inner(t) = mapOffset(segs, (t − O − s0) mod S)
```

`mapOffset` walks the segments. For a single segment `[s, s+S)` this is simply `s + ((t − O − s) mod S)`.

**Example.** A 56Q take performed from island 1Q (`O = 1`) is looped to `[46, 51)`, so `S = 5`. The frame is held with its left edge at island 45 (`Z = 45`). Each cell below shows which raw Q starts there:

```
lane x (Q)   0     1     2     3     4     5
plays       [49]  [50] |[46]  [47]  [48] |
                        ↑ the wrap splice: raw 50 → 46 (the top, x = 2)
```

Nothing chose "x = 2": it is simply where raw 46 was performed. That position is the loop's phase. The lane shows it honestly, and the anchoring law never moves it on its own.

---

## 4. What each edit does, in heard time

### 4.1 A slide (length held) moves the splice and nothing else

Slide the region by δ. By the law above, every sample outside a δ-wide strip keeps its time. Only the swept strip changes, and it now plays the material just past the old end (δ > 0) or just before the old start (δ < 0).

Slide **+1Q**, to `[47, 52)`:

```
x            0     1     2     3     4
before      [49]  [50] |[46]  [47]  [48]
after       [49]  [50]  [51] |[47]  [48]
                        ^^^^ swept: 46 → 51; the splice moved +1Q
```

Slide **−1Q**, to `[45, 50)`:

```
before      [49]  [50] |[46]  [47]  [48]
after       [49] |[45]  [46]  [47]  [48]
                  ^^^^ swept: 50 → 45; the splice moved −1Q
```

So dragging a single splice handle on the lane is **exact direct manipulation**. The waveform stays put, the handle moves, and nothing needs a raw view. Inner cuts behave the same way: sliding a cut moves only its splice.

With several segments, a loop-top drag moves only the outer bounds (`s0` and `e_last` together). The inner cuts keep their place on screen. The panel's box drag moves the whole pattern.

### 4.2 A trim changes the period, which reaches the whole lane

Trim the end by −1Q, to `[46, 50)` with `S = 4`. With only a 1Q definer the frame becomes 4Q, and every cell re-derives modulo 4:

```
x            0     1     2     3
after       [48]  [49] |[46]  [47]
```

Everything after the splice is re-tiled, and the frame length often changes (the LCM). A length change therefore cannot be drawn in place. It belongs in raw time: the region panel, or the ⇧-drag reveal in Phase 2 (§10).

### 4.3 Cuts and heals

- **Double-click** removes the take's **own** whole Q `[c, c+1)` (`cellCutAt`), even after a free slide. A cell not wholly inside the loop is refused, because it would leave a fractional period.
- **Heal:** double-click or right-click a cut.
- **Coherence** (time_maps.md §4): periods and removed lengths are whole Q. Slides may be fractional with ⌥, because they keep the length.

### 4.4 Snapping (owner ruling 2026-09-23)

- **Moves:** whole Q, relative, so a free offset set earlier is kept. ⌥ moves freely.
- **Lengths:** always whole Q.
- **No sub-Q grid,** because it would be arbitrary relative to the music; a meter-aware grid is a "maybe" in tasks.md Tier D.
- **Keys:** ←/→ nudge 1Q, ⇧ 4Q. ⌥ nudges ⅛Q, which predates the ruling and is an open question.

---

## 5. The frame, its zero, and the pins

### 5.1 Seating

The view places `Z` from the lanes (`seatFrameZero`, frame.md §1): the first seating lane's top sits at the left edge, and later lanes pull by whole cycles.

The video's −0.15Q slide on the lane that seats the frame:

```
before       Z = 47, top at x = 0
floor rule   Z → 46: the top shows at x = 0.85 and EVERY other lane shifts 1Q
             (the release jump)
Phase 1      nearest grid: Z stays 47; the top shows at x = 4.85 (a pickup
             wrapping at the right edge); nothing else moves
```

Phase 1's accepted trade: a slide ½–1Q *late* now re-seats (before, only early slides did). Also, a whole-Q slide of the lane that seats the frame still re-seats, because the resting rule puts that lane's top at the left edge. Phase 2's edit hold (§10, P2.1) removes both.

### 5.2 The drag pin

While a gesture runs, the frame's width, fold and zero are pinned (`drag_pin.js`). Phase 1 keeps the pin until the **final commit settles**, instead of dropping it at pointer-up (`gesture.js` `afterSettled`; an `onEnd` that returns its commit promise). Without this, a poll carrying the last live geometry could re-seat the frame first, and every lane would rescale twice.

### 5.3 The continuity re-anchor (engine)

An edit made while playing keeps the sounding sample sounding (time_maps.md §5). Phase 1 picks the origin **nearest the old one**, modulo the node's own fold (`continuityOrigin`, engine and mock in lockstep, scenario S40). A pure slide therefore never moves the origin. The old rule jumped it by m·P, which re-seated the frame depending on whether the pass count was odd or even, and broke bypass alignment.

---

## 6. The two surfaces (as of Phase 1)

### 6.1 The lane (heard time)

| Element | Gesture today |
|---|---|
| Trim grips at the loop's bounds; a `] [` pair plus "↺ loop top" chip when the top rests mid-lane | Drag = trim (whole-Q period) through the **same-scale reveal** (the lane shows raw audio under the hand). ⌥ = free slide. |
| Seam handle per inner cut | Drag = slide the cut; ⌥ = resize; double-click / right-click = heal |
| The lane body | Double-click = 1Q cell cut (the punch cut and heal: time_maps.md §4) |
| `[` / `]`, `{` / `}` | Walk the viewport through the lane's handles / jump to the outer loop bounds |
| Reveal edge pan | A drag held past the lane edge pans the raw view. It is direction-aware (`edge_pan.js`) and clamped only in the direction of travel (`panViewQ0`). |

Phase 2 replaces the grips, the pair and the chip with splice handles (§10).

### 6.2 The region panel (raw time)

The panel spans the full row under the selected track. It has a label, a whole-take **overview strip** with a view box, and a zoomable **detail strip**.

| Element / input | Does |
|---|---|
| The kept box | Drag = slide (whole Q; ⌥ free) |
| Brackets | Drag = trim (the period snaps to whole Q); ⌥ = slide |
| Cut chips / handles | Slide / resize a cut; heal |
| Detail strip | Double-click = cell cut on the take's grid |
| Ctrl/⌘+wheel, pinch | Zoom about the Q under the pointer. On the overview, this applies inside the view box; elsewhere the view zooms about its middle. |
| Shift+wheel, sideways swipe | Pan |
| Overview box | Drag = pan, drag vertically = zoom; its edges set the span; click elsewhere = centre; double-click = whole take |
| Label terms, Z / ⇧Z | Fit the loop / fit the whole take |
| Box or bracket drag at an edge | Edge pan |
| ← / → | Nudge the region 1Q (⇧ 4Q, ⌥ ⅛Q). Presses within 800 ms form one pinned gesture (`makeChainPin`). |

The panel shows for the most recently selected lane with a take of 2Q or more. It does not show for the Q-definer (its trim sets Q), a pinned inspector, a child under a parent's map, or a recording lane. time_maps.md §6 has the full table, with the code behind each row.

The view is per lane and lives in module state (`panel_view.js`). It opens fitted to the loop, with the loop filling about 55% of the strip. After that, only explicit input zooms; commits and nudges only pan to keep the region in view.

### 6.3 The recording gate

While any take records or waits to start, every loop edit is refused (`bandGate` in the view model, `#lanes.map-locked`). Grips and seams still draw, marked `.inert`: hovering one says why, and a press does nothing. Comp mode's "done" chip stays live, because it is a view toggle.

---

## 7. What keeps the picture steady

| Glitch (video) | Cause | Fix (Phase 1) |
|---|---|---|
| Whole lane lurches and "breathes" on every live commit | Heard tiles were sliced and rotated at whole peaks, and each canvas normalized to its own loudest peak | Per-column sampler (`mappedColumns` → `drawEnvelope`) plus one gain per take (`peaksBoost`). No tile fades during a map edit (`mapEditInFlight`). |
| Doubled "↺ loop top" chip at release | Hover CSS beat `.drag-live`; the preview was torn down before the commit | `!important` hide rule; the held preview stays until settle (`gesture.js` `deferTeardown`, flushed by patch.js after the reconcile) |
| Panel box snaps back for a moment after release | Same teardown order | Same fix |
| Amber line at raw 0 | The keyed rebuild created an unpositioned cursor | The cursor lives outside the keyed overlay |
| White playhead crossing the panel | The mask skipped `.lane-region` | `playhead_mask.js` masks the panel, re-run on engage and teardown |
| Blobby zoomed waveform | A flat 800 peaks per take | Peak count scales with duration (`peak_density.js`), with proportional engine buckets (`ClipNode::peakBucket`) |
| Group lanes cross-fade on edits | The composite cache was keyed on absolute origins | The key uses relative positions and skips recording children |
| The reveal leaps about 9Q on the first pan frame | The rewritten pan clamped into range every frame | `panViewQ0`: clamp only in the direction of travel |

**Prototype lesson for Phase 2:** during a gesture, never *remove* chrome, because the grabbed handle holds the pointer capture. But do *create* chrome the live edit needs. A slide that splits the top from the splice must show both marks mid-drag.

---

## 8. Phase 1 as shipped (2026-09-23)

Four workstreams, then integration and an adversarial review whose findings were fixed.

1. **Seating and lifecycle.**
   - Nearest-grid seating.
   - The pin held until the commit settles; held previews.
   - The `drag-live` CSS; the playhead mask; the recording gate.
   - Tests: `seat_nearest.test.mjs`, `release_lifecycle.test.mjs`, `record_gate.test.mjs`, `release_chrome.spec.js`.
2. **Panel navigation.**
   - Files: `panel_view.js`, `edge_pan.js`, `region_panel.js`.
   - The nudge chain is one pinned gesture; teleport keys skip the panel.
   - Tests: `panel_view.test.mjs`, `edge_pan.test.mjs`, `region_panel_keys.test.mjs`, `region_panel_view.spec.js`.
3. **Heard tiles.**
   - The sampler, `peaksBoost`, and no fades mid-edit. The panel strip and the reveal share `revealColumns`.
   - Tests: `heard_tile_sampler.test.mjs`, `heard_tiles.spec.js`.
4. **Engine.**
   - The continuity nearest representative; peak density; the composite key.
   - Quiet polls (`QUIET_POLLS` in protocol.js).
   - Tests: C++ plus scenario S40, `continuity_origin.test.mjs`, `peak_density.test.mjs`, `bridge_quiet.test.mjs`.

**Suites on the final tree:** node 478/478, mock e2e 112/112, engine e2e 30/30, C++ 451/451.

**Load gotcha:** `e2e_engine/workflow.spec.js` has a 240 s budget and times out whenever machine load exceeds the core count. Check `uptime` before calling it a regression. Never run the mock suite from `ui/` at the same time: it wipes `test-results/` under the engine run.

---

## 9. The top: swap or shift (proposed 2026-09-24, pending the owner; prototype v9)

### 9.1 Two principles (owner, 2026-09-24)

- **P1, performance coherence.** A performance keeps playing against what the performer heard, unless the user explicitly changes that, for example by modifying the loop's top.
- **P2, least surprise.** An existing top stays put when the region moves, if it can.

### 9.2 Two effects, two kinds of handle

A loop edit does one of two different things:

- **Swap** changes *what* plays. Moving the region (the panel box, ←/→, ↑/↓), a splice, a cut, or a bracket swaps in another pass of the performance. That pass plays at the same spot in the bar where it was performed (§4.1), so the groove never moves against the other tracks.
- **Shift** changes *when* it plays. Dragging the **↺ top** moves the audio in time, because the take's origin moves with the drag. That re-times the take against every other track. It is the only gesture that does this, which is how P1 holds: the timing never changes as a side effect.

In drums, with an 8-bar take and a 4-bar loop over a 4-bar bass (1Q = 1 bar; bar 4 ends in a fill, bar 5 opens with a crash):

```
bass phrase     A      F      C      G
as recorded    [1]    [2]    [3]    [4 fill]     the fill ends the phrase

swap +1 bar    [5 crash][2]  [3]    [4 fill]     bar 5 was played at the same spot
               (region → bars 2–5)               of the phrase as bar 1, so it plays
                                                 there: the fill still ends the phrase

shift +1 bar   [4 fill][1]   [2]    [3]          the whole part moved a bar later:
               (drag the ↺)                      the fill now opens the phrase
```

Both are real effects. A swap is subtle on a steady groove, because the swapped-in bar has the same pattern, so you only hear the differences between passes: the crash, a fill, a ghost note. A shift is never subtle.

**Modifiers** mean the same thing everywhere: a drag snaps by whole Q and keeps any fine offset set earlier, and ⌥ makes it free. So ⌥ on the ↺ is a fine re-time (for example, pulling a late take onto the grid), and no third key is needed. ⇧ on a splice changes the loop length there (§10, P2.4).

### 9.3 The ↺ and the splice are independent

- **The ↺ is the loop's one.** It is a mark on the audio (a raw sample `T`), so it sounds at `O + a0 + heardOffsetOf(segs, T)`.
- **The splice is where the recording jumps back** to the loop's start: the region's bound in heard time.
- **They begin on the same spot and come apart on a swap.** The audio does not move, so the ↺ stays put; the region does move, so the splice moves with it.
- **They are grabbed separately**, even when they coincide. The ↺ grabs by the upper half of the lane (its tab at the top edge), the splice by the lower half (its tab at the bottom edge).

**When a swap drops the ↺'s spot** (owner, 2026-09-24), the ↺ resets to the region's start, its leftmost kept sample, and so rejoins the splice. In the example above, the swap to bars 2–5 drops bar 1, so the ↺ moves to bar 2. While the region still holds the ↺'s spot, the ↺ stays put and only the splice moves. For example, after sliding to bars 3–6 the ↺ is on bar 3, and sliding back to bars 2–5 leaves it there.

- **Rejected:** v9 tried "same beat, another pass". Bar 5 plays where bar 1 played, so the ↺ stayed still on the lane, but in the panel it jumped from 0 to 4 for a one-bar slide. The owner: "why wouldn't it be at 1Q?"

**Ghosts** (session_view.md §3). When a loop is shorter than the frame, one tile is the take and every other repeat is a faded print. The take tile starts at the first ↺ on screen.
- The take tile carries the handles' tabs.
- Handles on ghost repeats stay grabbable but show only a faint line; the tab appears on hover. A tab on every repeat buried a 3Q loop in a 12Q frame under twelve labels.

**A shift moves the ↺ and the audio together** on the lane, and the splices ride along. In the panel, the ↺ is Ableton's start marker: drag it onto the hit that should land on the one, and the audio moves so that it does. Both are the same verb: a new origin.

### 9.4 The deselect settle

On deselect the frame settles, animated, onto the bar lines of the first lane (every Q for a 1Q loop, every 4Q for a 4-bar bass). The ↺ lands at the left edge when it sits on one of those lines. A top up to ¼Q early counts as a pickup to the next line, so a take pulled slightly early does not throw the picture back a whole Q. The consequences:
- A swapped part never moves on deselect.
- A re-timed part stays visibly shifted against the lane that sets the bar lines. That is the honest picture of a re-time.

### 9.5 What prototype v8 got wrong

- **The switch** "moving the region keeps [the top | the timing]". Its "top" option shifted the audio under a fixed ↺ on every region move, which is an implicit re-time. v9 makes the shift explicit, on the ↺ only.
- **The splice was labelled "wrap"**, which read as a second top, and the swept-strip tint lit up during panel drags. v9 gives the splice a plain "splice" tab on the bottom edge, and shows the tint only while a lane splice is dragged.
- **A class-name clash.** The wrap handle's `wrap` class also matched the page's layout container, which inflated its hit box. It is renamed in v9.

---

## 10. Phase 2 roadmap

Each step ships on its own, with unit tests plus a real-mouse e2e spec. Steps are ordered by dependency.

- **P2.1 The edit hold and the animated settle.**
  - While a track is selected, its edits never re-seat the frame: a selection-scoped zero pin (`drag_pin.js`), including nudges.
  - On deselect or arm, the frame settles once, animated: tween `frameZero` over about 500 ms.
  - The settle floors the top to the whole Q at or just before it, so an off-grid top lands just after the left edge and never wraps to the right. This replaces Phase 1's nearest rounding for held edits.
  - Amend frame.md §1.
- **P2.2 The top as a stored fact, and the shift verb.**
  - A per-node `loopTop` (raw samples), undoable and saved by `session_io`. A `setLoopTop` verb is wired the way `setSegments` is: `protocol.js`, `src/bridge_dispatch.cc`, the engine's `src/engine/map_edits.cc`, and the mock (`mock/maps.js`, `mock/undo.js`).
  - A shift verb that moves a node's origin (the ↺ drag): whole-Q by default, which keeps I4, and free with ⌥, which deliberately moves the take off its performed alignment (owner, 2026-09-24). The panel's start-marker drag is the same verb: it sets `T` and moves the origin so the ↺ keeps its moment.
  - Every map edit reconciles it by the §9.3 rule, deterministically, in the engine's map-edit path and the mock twin, pinned by goldens.
    - After the edit, `T′ = T` if the new map plays `T`, else `T′ = a0′` (the new region's start).
  - Seating reads the top's moment, `O + a0 + heardOffsetOf(segs, T)`, instead of the region start.
- **P2.3 The single splice handle.**
  - Add `slideSeam(segs, j, δ, totalQ)` to `map_edit.js`. A loop-top drag moves the outer bounds only; an inner seam slides its cut.
  - One handle on every repeat of every splice (knob at the lane's bottom edge; the chip keeps the top-right).
  - Drag = a heard-space slide with **locally rendered pending tiles**, no reveal. Whole-Q relative snap, ⌥ free. The swept tint shows during the drag.
  - Exclude the Q-definer, one-shots (they keep edge trims), and recording lanes (the gate).
- **P2.4 ⇧-drag = length at a splice.**
  - Moves the end of the material before the splice: the loop's end at the wrap, the cut's start at a cut. Right = more material, left = less; whole Q; a cut shrunk to zero heals.
  - Goes through the reveal, anchored so the grabbed bound sits under the hand, and cross-fades in and out. The frame length tweens on release.
- **P2.5 Retire** the paired `] [` grips, the "↺ loop top" chip, and lane trims without ⇧. Update time_maps.md §6 and §8.
- **P2.6 Presentation of the top** (§9.3–9.5):
  - The ↺ tab on the lane's top edge; the splice tab on its bottom edge. Each grabs by its own half of the lane.
  - Tabs only on the take tile. Handles on ghost repeats are faint lines whose tabs appear on hover (§9.3).
  - An instant edit that resets the ↺ (a cut, a nudge, a heal) glides it to its new place.
  - The panel's ↺, grabbed only by its tab inside the kept box.
  - A readout of the take's timing against how it was played, and a "timing as played" reset.
- **P2.7 The settle on the first lane's bar lines** (§9.4), replacing the plain floor seat of P2.1.
- **Carry-overs:**
  - Group composites are still drawn at 800 px.
  - Cut-band drags do not edge-pan.
  - Raw lanes' cut bands disappear, instead of drawing inert, under the recording gate.
  - The ⌥←/→ ⅛Q nudge ruling.
  - Verify pinch and ctrl+wheel in the real WebView2 and WKWebView builds.

---

## 11. Rejected or superseded (prototype round, 2026-09-23)

- **The v8 switch, "moving the region keeps [the top | the timing]".** The owner called it a false dichotomy (2026-09-24). It was: swap and shift are different effects with different handles (§9.2).
- **"Keep the top" as the default for region moves.** It slips the audio against the grid on every region move, an implicit re-time. It survives as the explicit ↺ drag (§9.2).
- **A display-only top** (the first 2026-09-24 draft: dragging the ↺ changed only where the loop reads, and ⌥⇧ re-timed). The owner: moving the top must change when material plays, "otherwise it has no effect", and a third modifier is unnecessary.
- **Dragging a joined ↺ moves the splice too** (the same draft). The owner wants the ↺ and the splice independent (§9.3).
- **Resetting an excluded top to the lane's far left** (my reading of "the far left", 2026-09-23). The owner meant the region's start (§9.3).
- **Keeping an excluded top on "the same beat of another pass"** (v9). It stayed still on the lane but jumped by whole periods in the panel (§9.3).
- **A top that rides the region start until "set"** (the v5 era). Every panel slide moved the ↺, including slides that still held it. The current rule resets to the start only when the region drops the top (§9.3).
- **Tabs on every repeat.** A 3Q loop in a 12Q frame showed twelve labels. Ghost repeats now carry faint lines only (§9.3).
- **No handle rebuilds during a drag.** This hid the handles the live edit needed. Rule: create mid-gesture, remove only after.
- **A shortest-way-round swept tint.** It lit the wrong side for |δ| ≥ S/2. The tint must use the signed drag distance.
