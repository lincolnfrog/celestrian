# Loop selection: regions, splices and the top

How a track's **loop region** works: what it is in the model, what each edit does to the sound and to the picture, the two surfaces that edit it, and what keeps the picture steady while you edit. It also records what Phase 1 shipped (2026-09-23) and the proposed roadmap for Phase 2.

§12 is the 2026-10-01 audit of the surface as it stands after the 2026-09-29 rulings (one loop places the frame; no edit hold; a slotted-in loop's ↺ is where it starts playing): what it found, what was fixed, and what was proposed and ruled. §13 is the work list the rulings became, and **§14 is what was built from it** (the same day) and what is still open. **§15 (2026-10-08) is the current surface:** the region panel moved to an edit bar at the foot of the session view, and only the selected track wears handles.

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
| **Top `↺`** | The loop's one: where it reads as starting. The first loop longer than Q places the frame at its ↺; every other loop's ↺ reads where it starts playing — the sample at the left edge (frame.md §1). Phase 2 makes it a stored mark: region edits leave it put while they still play it (resetting it to the region start when they drop it), and its drag **shifts** the audio in time (§9). A take never edited reads its region start. |
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
- **Keys:** ←/→ nudge 1Q, ⇧ 4Q. (The ⌥ ⅛Q nudge, which predated the ruling, was removed on 2026-10-08, §15.)

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

The panel shows in the **edit bar** at the foot of the session view (since 2026-10-08, §15; until then it was a row under the selected track). It has a label (the track's name over its terms), a whole-take **navigator** with a view box, and a zoomable **detail strip**. The navigator is an abstract map, not a waveform (owner, 2026-09-29: a second waveform of the take over the detail read as a redundant third track). It shows the take's extent as a line, the kept region as solid blocks with cuts as the gaps between them, the ↺ tick, the cursor, and the detail's view box. It is always shown, so both ends of a loop stay one click apart however far the detail is zoomed.

| Element / input | Does |
|---|---|
| The kept box | Drag = slide (whole Q; ⌥ free) |
| Brackets | Drag = trim (the period snaps to whole Q); ⌥ = slide |
| Cut chips / handles | Slide / resize a cut; heal |
| Detail strip | Double-click = cell cut on the take's grid |
| +/− | Zoom the panel one step about the playhead (owner, 2026-09-29). A playhead in view keeps its place; one outside it is brought to the middle. The song view zooms only with no panel shown (`zoomSelectedPanel`, `keyZoomView`). |
| Ctrl/⌘+wheel, pinch | Zoom about the Q under the pointer. On the navigator, this applies inside the view box; elsewhere the view zooms about its middle. |
| Shift+wheel, sideways swipe | Pan |
| Navigator box | Drag = pan; its edges set the span; click elsewhere = centre; double-click = whole take. (Drag-vertically-to-zoom is gone: +/− zoom.) |
| Label terms, Z / ⇧Z | Fit the loop / fit the whole take |
| Box or bracket drag at an edge | Edge pan |
| ← / → | Nudge the region 1Q (⇧ 4Q). Presses within 800 ms form one pinned gesture (`makeChainPin`). |

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
   - Tests: `seat_nearest.test.mjs` (now `frame_seat.test.mjs`, Phase 2's seat), `release_lifecycle.test.mjs`, `record_gate.test.mjs`, `release_chrome.spec.js`.
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

**A new take plays as performed** (owner, 2026-09-24), so it resets the clip's `retime` to 0: the timing readout and "Timing as played" then describe the newest take, and the older takes keep their shift as a baked fact, which ⌘Z can still undo.

**Groups are loops too** (owner, 2026-09-29: the fractal principle). A group has its own ↺, re-time, timing readout and "Timing as played", exactly as a clip does. Dragging a group's ↺ shifts the whole group, and its members move with it, so they keep their placement inside it. The group's top rides its region edits by the same rule as a clip's (§9.1, P2). Phase 2 had kept groups at their region start and never re-timed them. That exception is gone: `AudioEngine::setTiming` takes any committed node, and the top and re-time live on `AudioNode`. Pinned by scenario S44 and `set_timing.test.mjs`.

**The timing readout shows only what you can hear** (owner, 2026-09-29). A loop sounds the same moved by any whole number of its own length, so the readout folds the re-time to the loop's period, into (−½, +½] of it. A 2Q drum loop moved 13Q reads "shifted +1Q", never "+13Q". "Timing as played" undoes that audible part, and a loop moved by whole periods reads "as played". The engine keeps the raw count; the fold is the view model's (`foldShift` in `math_utils.js`, `topFields`). Pinned by `top_fields.test.mjs`.

### 9.3 The ↺ and the splice are independent

- **The ↺ is the loop's one.** It is a mark on the audio (a raw sample `T`), so it sounds at `O + a0 + heardOffsetOf(segs, T)`.
- **The splice is where the recording jumps back** to the loop's start: the region's bound in heard time.
- **They begin on the same spot and come apart on a swap.** The audio does not move, so the ↺ stays put; the region does move, so the splice moves with it.
- **They are grabbed separately**, even when they coincide. The ↺ grabs by the upper half of the lane (its tab at the top edge), the splice by the lower half (its tab at the bottom edge).

**When a swap drops the ↺'s spot** (owner, 2026-09-24), the ↺ resets to the region's start, its leftmost kept sample, and so rejoins the splice. In the example above, the swap to bars 2–5 drops bar 1, so the ↺ moves to bar 2. While the region still holds the ↺'s spot, the ↺ stays put and only the splice moves. For example, after sliding to bars 3–6 the ↺ is on bar 3, and sliding back to bars 2–5 leaves it there.

- **Rejected:** v9 tried "same beat, another pass". Bar 5 plays where bar 1 played, so the ↺ stayed still on the lane, but in the panel it jumped from 0 to 4 for a one-bar slide. The owner: "why wouldn't it be at 1Q?"
- **The top is stored at every edit (2026-09-24, P2).** A map edit reconciles from the ↺ as it showed — the EFFECTIVE top, which on a take no edit has touched is its region start — and stores the answer: that top while the new region still plays it, else the new region start (`timing::reconcileTop`, engine and mock alike; the prototype's `st.top = segs1[0][0]`). So after the swap to bars 3–6 the ↺ is stored on bar 3, and sliding back to bars 2–5 leaves it there; a fresh loop's first slide left keeps its ↺ where it showed, and the splice comes apart. A top is unset only on a take never edited: a fresh take, a session saved before tops.
- **Rejected:** Phase 2's first build left a reset top UNSET, with the region start standing in. An unset top rides the region start, so the slide back to bars 2–5 moved the ↺ to bar 2, and a fresh loop's leftward slide dragged its ↺ along. That is v5's "every slide moved the ↺" by the side door (§11), and it breaks P2.

**Ghosts** (session_view.md §3). When a loop is shorter than the frame, one tile is the take and every other repeat is a faded print. The take tile starts at the first ↺ on screen.
- The take tile carries the handles' tabs.
- Handles on ghost repeats stay grabbable but show only a faint line; the tab appears on hover. A tab on every repeat buried a 3Q loop in a 12Q frame under twelve labels.

**A shift moves the ↺ and the audio together** on the lane, and the splices ride along. In the panel, the ↺ is Ableton's start marker: drag it onto the hit that should land on the one, and the audio moves so that it does. Both are the same verb: a new origin.

### 9.4 The deselect settle (revoked 2026-09-29)

**Superseded (owner, 2026-09-29):** there is no hold and no deselect settle. The main view shows the loops' true alignment at once: an edit realigns it immediately. The first loop longer than Q places the frame (its ↺ is the left edge; a 1Q loop never places), and every other loop slots in where its ↺ falls, so editing a later loop never moves the frame or the play start (frame.md §1). The history below is kept for the record.

On deselect the frame settled, animated, onto the bar lines of the first lane (every Q for a 1Q loop, every 4Q for a 4-bar bass). The ↺ lands at the left edge when it sits on one of those lines. A top up to ¼Q early counts as a pickup to the next line, so a take pulled slightly early does not throw the picture back a whole Q. The whole picture glides as one: tiles, handles, cursor, arm marker, and the ruler and gridlines too, each tick labelled where the glide lands it (built 2026-09-24; frame.md §1). The consequences:
- A swapped part never moves on deselect.
- A re-timed part stays visibly shifted against the lane that sets the bar lines. That is the honest picture of a re-time.

### 9.5 What prototype v8 got wrong

- **The switch** "moving the region keeps [the top | the timing]". Its "top" option shifted the audio under a fixed ↺ on every region move, which is an implicit re-time. v9 makes the shift explicit, on the ↺ only.
- **The splice was labelled "wrap"**, which read as a second top, and the swept-strip tint lit up during panel drags. v9 gives the splice a plain "splice" tab on the bottom edge, and shows the tint only while a lane splice is dragged.
- **A class-name clash.** The wrap handle's `wrap` class also matched the page's layout container, which inflated its hit box. It is renamed in v9.

---

## 10. Phase 2 roadmap

### Status: built 2026-09-24 (uncommitted on top of ec97ac7)

Seven workstreams, then one review pass. The fixes the review confirmed are applied.
- **A:** engine, bridge, mock and persistence.
- **B:** view model and frame.
- **C:** the lane and panel UI.
- **D:** materialized tops and the ruler glide.
- **E:** an identity first commit opens a gesture.
- **F:** the ↺ on plain loops.
- **G:** a new take resets the re-time, and identity `setSegments` records nothing.

| Step | State | Where |
|---|---|---|
| P2.1 edit hold + settle | built, then REMOVED 2026-09-29 (owner: realign at once) | frame.md §1; session_view.md law 17 |
| P2.2 stored top + shift verb | built as ONE verb, `setTiming` | `src/time_map.h`, `clip_node.h`, `engine/map_edits.cc`, `edit_log.cc`, `session_io`; the mock twin; time_maps.md §7 |
| P2.3 splice handles | built | `session_view/splice_handles.js`, the pluggable `runRawDrag`, `map_edit.js` `slideSeam`; time_maps.md §6 |
| P2.4 ⇧-length at a splice | built, except the frame-length tween on release | `lengthAtSeam`, `runRevealDrag` |
| P2.5 retire the grips and chip | done (one-shots keep their grips; the Q-definer keeps its brackets) | time_maps.md §8 |
| P2.6 presentation | built: lane ↺ and splice tabs, ghosts, the glide, the panel ↺ tab, the timing readout, "Timing as played"; the ↺ also on plain unwindowed loops | `splice_handles.js`, `region_panel.js` |
| P2.7 seat on the first lane's bar lines | built: floor with a ¼Q pickup, from the top's moment | `view_model.js` `seatFrameZero`; frame.md §1 |

**Also decided or fixed on the way (2026-09-24):**
- **A new take plays as performed** (owner) and resets the clip's `retime` (takes.md §4).
- **"Bounce selected…" on a clip starts at its ↺** (owner; bounce.md).
- **Every map edit stores a concrete top** (§9.3), so the ↺ never rides the region start.
- **Undo steps:** the engine and the mock track the open gesture explicitly, so a drag whose first commit is an identity gets its own undo step.
- **Live-commit throttles start at −∞.** `performance.now()` counts from page start.
- **A bypassed map's region start is 0.** It plays whole.
- **Group composites** place a windowed member at origin + region start.
- **The recording bar** folds on the settle's landing, not on the seat.

**Open:**
- The frame-length tween when ⇧-length changes the frame (P2.4).
- ~~Group lanes have splice handles but no ↺~~ — done 2026-09-29: groups store a top and re-time like clips (§9.2). Group composites still show no pending preview.
- Cancelling a ↺ drag leaves a no-op undo step. The older map drags do the same. (It also ends the redo branch: a true cancel needs an engine verb that drops the gesture's step.)
- An imported take does not reset `retime`.
- An edit made while a map is bypassed that drops the top stores 0.
- The carry-overs below.

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
  - **Engine side built 2026-09-24** as ONE verb, `setTiming(uuid, shiftSamples, topSamples?, live?)` (the shift and the start marker share it), with per-clip facts `loopTop` (effective) and `retime` (the cumulative user shift). Every map edit STORES its reconciled top, from the effective top before it (§9.3); a live drag reconciles every commit from the effective top its gesture started with. time_maps.md §7 "The top and the re-time".
- **P2.3 The single splice handle.**
  - Add `slideSeam(segs, j, δ, totalQ)` to `map_edit.js`. A loop-top drag moves the outer bounds only; an inner seam slides its cut.
  - One handle on every repeat of every splice (knob at the lane's bottom edge; the chip keeps the top-right).
  - Drag = a heard-space slide with **locally rendered pending tiles**, no reveal. Whole-Q relative snap, ⌥ free. The swept tint shows during the drag.
  - Exclude the Q-definer, one-shots (they keep edge trims), and recording lanes (the gate).
  - **P2.3–P2.6 built 2026-09-24** (`splice_handles.js`, the pluggable `runRawDrag`, `region_panel.js`; time_maps.md §6). The swap preview predicts the top the engine will store from the published effective top alone (§9.3: kept while the new region plays it, else the new start), so the ↺ never jumps at release.
- **P2.4 ⇧-drag = length at a splice.**
  - Moves the end of the material before the splice: the loop's end at the wrap, the cut's start at a cut. Right = more material, left = less; whole Q; a cut shrunk to zero heals.
  - Goes through the reveal, anchored so the grabbed bound sits under the hand, and cross-fades in and out. The frame length tweens on release.
- **P2.5 Retire** the paired `] [` grips, the "↺ loop top" chip, and lane trims without ⇧. Update time_maps.md §6 and §8.
- **P2.6 Presentation of the top** (§9.3–9.5):
  - The ↺ tab on the lane's top edge; the splice tab on its bottom edge. Each grabs by its own half of the lane.
  - Tabs only on the take tile. Handles on ghost repeats are faint lines whose tabs appear on hover (§9.3).
  - An instant edit that resets the ↺ (a cut, a nudge, a heal) glides it to its new place. *(Retired 2026-10-01: the ↺ lands at once and the frame moves onto it — the re-seat tween, §13.2.)*
  - The panel's ↺, grabbed only by its tab inside the kept box.
  - A readout of the take's timing against how it was played, and a "timing as played" reset.
  - **A plain loop** (no map, the commonest case: "my drum loop is 40 ms late") wears the ↺ alone, grabbed by its tab so the latent brackets keep their press, and the panel's ↺ walks its whole take. A bypassed map wears none; the reset still shows wherever the take is shifted (built 2026-09-24, review finding; time_maps.md §6).
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
- **A top that rides the region start until "set"** (the v5 era). Every panel slide moved the ↺, including slides that still held it. The current rule resets to the start only when the region drops the top (§9.3). Phase 2's first build (2026-09-24) brought it back by the side door: a reset left the top unset, so it rode the start again. The reconcile now stores the reset (§9.3).
- **Tabs on every repeat.** A 3Q loop in a 12Q frame showed twelve labels. Ghost repeats now carry faint lines only (§9.3).
- **No handle rebuilds during a drag.** This hid the handles the live edit needed. Rule: create mid-gesture, remove only after.
- **A shortest-way-round swept tint.** It lit the wrong side for |δ| ≥ S/2. The tint must use the signed drag distance.

---

## 12. Audit, 2026-10-01

After the 2026-09-29 rulings — one loop places the frame, no edit hold, a slotted-in loop's ↺ is where it starts playing (§9.4, frame.md §1) — the whole surface was audited: every gesture driven with a real mouse in the mock, the code read against the rulings, all three suites run, and the take-related findings checked against the real engine (the headless server).

### 12.1 Found and fixed

| # | What you saw | Cause | Fix |
|---|---|---|---|
| 1 | After a splice drag on a loop that slots in ("clip 3+"), the lane sat on the drag's result for 1.5 s: a ⌘Z, a nudge or a panel edit made meanwhile did not show | The swap preview carries the top the engine will store. It was predicted from the ↺ **as shown** — since 09-29 the sample at the frame's top, which the engine does not publish — so the preview never matched the commit's answer and lived to the hold cap | The lane carries both: `topQ` (the ↺ as shown) and `storedTopQ` (the engine's). `topAfterSwap` and the start marker's cancel read the engine's. An undo or redo also drops any preview and queued verdict still up (`dropStaleEditFeedback`) |
| 2 | ⇧ on the main loop's splice could not shorten the loop: 1.2Q of hand took 3Q | ⇧ moves the end of the material **before** a splice. The placing loop's wrap rests on the lane's left edge always, and was drawn there only — so shortening meant dragging off the lane, where the reveal's edge pan ran away. It is the 2026-08-18 report again: "the right handle is gone" | A splice on the frame's left edge shows at the **right edge too** (`.lr-end`): the loop's END handle. Dragged inward it shortens, with the material in view; the left one lengthens the same way |
| 3 | A whole-Q drag of a cut toward a 1Q neighbour left a 1/64 Q sliver playing at the splice; a drag into the take's edge re-gridded a free offset | `slideSeam` answers its clamp bound, which is fractional | `slideSeamWhole`: the largest whole number of Qs inside the bound; 0 when none fits. ⌥ still reaches the bound |
| 4 | ⌥→ then ⌥← a moment later came back one sample late (and could flip a ↺ to the far end of its region) | ⅛Q is rarely a whole number of samples; each landing rounded separately | `nudgeStepQ`: the step is whole samples, rounded by magnitude |
| 5 | A new take of the 1Q loop shown above the main loop shifted every lane and the cursor for as long as it recorded | The seat counted it as a growing take ("a recording take places the frame") | A new take seats as the slot it is (`retakeSlot`, frame.md §1) |
| 6 | (real engine only) During a new take the lane re-tiled its old take at the captured length — thirty tiny tiles a quarter Q in — and the bar jumped about; re-taking the loop that alone made the frame collapsed the frame to 1Q and regrew it Q by Q | The engine publishes the live captured length as `duration` while a new take captures; the mock keeps the slot's. The view read `duration` | `retakeSlot` in the lane, `settledForFrame` for the cycle and the growing frame (takes.md §6) |
| 7 | (tests) Five Playwright specs and one engine spec failed on HEAD | They still asserted the edit hold, the old "free move" seating and a group with no ↺ | Rewritten to the 09-29 picture. `slotted_loop.spec.js` is new: nothing had driven a loop that slots in, which is how #1 got through |
| 8 | (mock) A cut map published its superseded window as `loopStart` / `loopEnd` | Mock/engine drift: the engine publishes 0 there under an override | `mock/publish.js` |

Suites on the final tree: node 586 (573 before), mock e2e 139 (131 before, 5 of them failing), engine e2e 31 (1 failing before; run against a headless engine rebuilt from HEAD).

### 12.2 Proposed — and ruled (owner, 2026-10-01)

Ordered by how much it is felt. **Rulings:** 1 → claim the track at the gesture's END (the dock stays an option, §13.1); 2 → yes, tween the re-seat; 3 → yes, bounce from the ↺ as shown; 4 → remove the glide, the tween of item 2 takes its place. All four are built (§14); §13 is the plan they were built from.

1. **Grabbing a handle on a lower track makes that track jump.** A press on a handle claims the track at once, the region panel moves under it, and when the panel that closes was *above* the grabbed lane the lane leaps up by the panel's height (74 px) out from under the pointer. The drag survives (pointer capture), but the hand is no longer on the lane, and a double-click (heal a cut) on an unselected lower lane misses: its second click lands on the panel. Options: (a) claim the track when the gesture **ends** — and, for a plain click, after the double-click window — so nothing moves under a hand; (b) give the panel a fixed dock (the foot of the session view) so selecting never re-flows the lanes. (a) is small; (b) removes the whole class.
2. **Edits of the placing loop end in a jump.** By the 09-29 ruling the frame re-seats at once — but a drag pins the frame while the hand is down, so the re-seat lands as one jump at release: any swap that drops the ↺ (every rightward slide of an untouched loop) and every ↺ drag end with the dragged lane snapping back to the left edge and all the others shifting the other way. It is honest, and abrupt. Proposal: tween the re-seat for those two gestures only (~200 ms), every lane moving together. (The removed deselect settle was a *delayed* realign; this is the same realign, at the same moment, drawn so the eye can follow.)
3. **"Bounce selected…" on a slotted-in loop starts at the engine's stored top**, which the UI no longer shows anywhere; the ↺ shown is the frame's top. The owner ruled that a clip's bounce starts at its ↺ (bounce.md). Proposal: the app names the start for a loop lane — the frame's top (`bounce(uuid, path, start)` takes it already) — so a stem lines up with the song bounce. (`bounce.cc` also still treats a group as having no top.)
4. **The ↺ glide has little left to do.** Since the frame re-seats on the placing loop's ↺ and a slotted-in loop's ↺ rests at the left edge, the ↺ only moves on screen while a pin holds the frame; the glide then runs 0 → 1Q and the re-seat takes it back 0.8 s later. Remove it, or fold it into the tween of item 2.
5. **Smaller.**
   - A bypassed window over a take tile that wraps the frame: its end bracket and chip fall past the lane's right edge instead of wrapping with the tile (the panel still edits it).
   - The transport readout widens when "· loop NQ" appears mid-drag and pushes the meters along.
   - A cancelled drag leaves an undo step and ends the redo branch (needs an engine verb that drops the gesture's step).
   - The ⌥ ⅛Q nudge against the "no sub-Q grid" ruling (§4.4) is still open.
   - A slotted-in loop that starts a hair *late* reads its ↺ at the END of its region in the panel (the sample at the frame's top is its tail: the drums' 3.975Q, `frame_seat.test.mjs` (d)). True to the rule; worth a look once in hand.
   - The mock's new-take publication should match the engine's (takes.md §6), so the mock suite can see what only the engine probe found.

---

## 13. The work list (written 2026-10-01 — the plan; §14 is what was built)

This section is the plan as it was written for a fresh session, kept for its reasoning and its measurements. It was then built in the same session: **§14 records the outcome, where it departs from the plan, and what is still open.** Read **§13.0** before working on any of it.

### 13.0 How to work on this (what the audit learned the hard way)

- **Three suites, all green** (counts as of §14): `cd ui && npm test` (node, 621) · `cd ui && npx playwright test` (mock e2e, 156; reuses or starts a server on :8080) · `cd ui && npm run test:engine` (real UI on the real engine, 32, ~3 min; needs `build/CelestrianHeadless_artefacts/Debug/CelestrianHeadless`, rebuilt 2026-10-01 with `cmake --build build --parallel 8 --target CelestrianHeadless`; times out when machine load exceeds the core count — check `uptime`).
- **Every interactive change gets a REAL-mouse check** (Playwright `page.mouse`, or the browser pane's click/drag) — synthetic `dispatchEvent` bypasses hit-testing. ⇧/⌥ drags need Playwright (`keyboard.down('Shift')` before `mouse.down()`); the browser pane's drag tool does not hold modifiers.
- **Two tops.** `lane.topQ` is the ↺ AS SHOWN (the placing loop: the engine's top; any other loop: the sample at the frame's top). `lane.storedTopQ` is the engine's own (`loopTop`). Anything that predicts or restores ENGINE state reads `storedTopQ`.
- **Which loop places the frame:** `vm` does not publish it — `seatFrameZero` returns `placerId` and `deriveViewModel` keeps it in `ctx.placerId` only. Nothing below strictly needs it (13.3 reads `lane.topHeardQ`), but a test that asks "is this lane the placing loop" does: add `placerId` to the returned object then, rather than re-deriving it.
- **The test topology for all of this** is `ui/e2e/slotted_loop.spec.js`'s `setup`: A a 1Q loop · B a 12Q take looped to [4, 8) — the placing loop · C a 16Q take from 14Q looped to [6, 10) — slotted in, selected. Its helpers (`handles`, `marks`, `tabPoint`, `drag` with `mods`, `panelTopQ`) are real-mouse and reusable.
- **Spec races seen:** a handle position read right after a commit is read under the drag pin — poll `body._cycleQ` (or the handle's own place) before the next grab; never wait on a value that is the same before and after the edit (wait on the thing that MOVES); the in-app browser pane throttles `requestAnimationFrame`, so sample animations with a headless Playwright script, not there.
- **Baseline against untouched HEAD** when a spec fails: `git worktree add --detach <scratch>/head HEAD`, symlink `ui/node_modules` into it, run with a copy of the Playwright config on another port. Six specs were already red on HEAD before the audit; assume nothing.
- **Engine truth for display questions:** spawn `CelestrianHeadless --port N --ui-dir <ui dir> --paused --input chirp --inputs 5`, open `/index.html?engine=true` in Playwright with that `baseURL`, and drive it with `ui/e2e_engine/engine_helpers.mjs` (`openEngine`, `rec`, `call`, `engine(page, 'advance', {samples})`, `state`, `advanceUntil`). (When this was written the mock and the engine did not publish a new take alike; since §14 they do — takes.md §6.)
- Edit files with the editor tools, not shell redirects; match the comment style around you; do not commit.

### 13.1 Claim the track when the gesture ENDS (ruling 1)

**The problem, measured.** A press on any lane handle calls `selectOnly(lane.id)` at POINTERDOWN. The region panel is a row under the selected lane, so when the panel that closes is *above* the pressed lane, that lane moves up by the panel's height at the press: in the audit, lane body top 370 → 296 px between pointerdown and pointerup with the pointer still at y = 428. The drag survives (pointer capture) but the hand is off the lane, and a double-click (heal a cut) on an unselected lower lane misses — the second click lands on the panel.

**Where the claim happens today** (`ui/js/session_view/`):
- `gesture.js` `beginGesture(ev, { claim })` → `selectOnly(claim)` at the press (used by `window_edit.js` bracket drags and `map_bands.js` cut-band drags, `claim: lane.id`);
- `splice_handles.js` `startSpliceDrag`, `startLengthDrag`, `startTopDrag` (press) and `onHeal` (double-click / right-click);
- `map_bands.js` `wireBandCreate` (the body's double-click), the seam handle's and the trim grip's `startDrag` (one-shot lanes);
- `region_panel.js` `startPanelDrag`, `startPanelTopDrag`, `resetTiming` — these are already on the selected lane (the panel only shows for it): leave them.

**What to build.**
1. One helper, e.g. `claimAtEnd(id)` in `gesture.js` (or `selection.js`): records the lane to claim; the gesture runner applies it in `end()` — after `onEnd`, for a commit AND for a cancel (an Escape still leaves the track claimed: the user touched it). Give `beginGesture`'s `claim` this meaning (today `gesture.js:180` selects at the press; `end()` is where it belongs, after `onEnd`) and route the direct `selectOnly` calls of the list above through it. `runRawDrag` (`map_core.js`) starts its gesture with `beginGesture(ev, { stop: true, … })` and takes no `claim` today, and `runRevealDrag` (`map_bands.js`: the length drag, the one-shot seam drag and trim grip) wraps `runRawDrag` — give both a `claim` option that passes through, and have the callers pass it instead of calling `selectOnly` themselves.
2. **A press that never engaged a drag is a click, and may be the first click of a double-click:** defer its claim by a double-click window (~350 ms; cancel the timer if a second `pointerdown` arrives on the same lane — that press's own gesture end, or the double-click handler, claims instead) so both clicks land on the same geometry. The double-click handlers (`onHeal`, `wireBandCreate`) keep selecting at once — by then the second click has landed.
3. The `[` `]` `{` `}` teleport and the nudge keys read `activeSelectedId()`; they act on the previous selection until the release. That is correct (nothing was claimed yet), but check `teleport.js`'s header comment ("grab a splice, swap it, hit the bracket key") still reads true after a release.
4. `patchRegionPanel` already refuses to hide a panel whose strip is being dragged; with the claim deferred no panel changes at all under a lane gesture — verify nothing else keys on "selected during the drag" (`mapEditInFlight` reads the row's own strip; `selection.js ensureDefaultSelection` runs every patch and must not fight the deferred claim).

**Honest limit.** The lane still moves when the panel swaps — now at the release, with no hand on it. If that still reads badly, two follow-ons, in order of cost: animate the panel row's height (~150 ms) so the move can be followed; or the **dock** — the panel stops being a row under the selected lane and becomes ONE fixed strip (the foot of the session view, the way a DAW's clip/detail view sits under the arrangement) that always shows the selected track's take. Lanes then never re-flow on selection, and the whole class of problem is gone. It is a layout redesign (`region_panel.js` `buildRegionPanel` per row → one panel; `pinToViewport` goes away; `playhead_mask.js` no longer needs to mask it; the specs' `.lane[data-id] .lane-region` locators change), so it was not chosen now.

**Tests.** A real-mouse spec (add to `ui/e2e/slotted_loop.spec.js`, whose topology has the selected lane above or below at will): select the upper lane, press a handle on the lower one — the lower lane's body `top` is identical at `pointerdown`, mid-drag and just before `pointerup`; after the release it is selected and its panel shows. Double-click a cut's splice on an unselected lower lane: it heals on the first try. A drag cancelled with Escape still claims. Existing specs that assert "the panel appeared with the grab" (`region_panel.spec.js` same-scale reveal) assert after the release already; `release_chrome.spec.js` and `splice_handles.spec.js` select the lane first.

### 13.2 Tween the re-seat; remove the ↺ glide (rulings 2 and 4)

**The behaviour wanted.** When the frame's zero moves, every lane, the ruler, the gridlines, the cursor and the arm marker move TOGETHER over ~200 ms instead of jumping. No delay — the tween starts at the moment the jump happens today (the 2026-09-29 ruling stands: an edit realigns at once; this only draws the realign so the eye can follow). It is not the edit hold coming back: nothing is held, and nothing waits for a deselect.

**When the zero moves today** (all jumps): the drag pin or the nudge chain's pin releases after an edit that moved the placing loop's ↺ (a swap that dropped it; any ↺ drag; the panel's start marker on the placing loop keeps the moment, so no move); an unpinned edit of the placing loop (a double-click cut over its ↺, a bracket drag in `window_edit.js`, a bypass toggle); an undo/redo of any of those; a lane reorder or delete that changes which loop places the frame.

**What to build — most of it exists in git.** The settle removed on 2026-09-29 (`b1b69f2`) was exactly this machinery with a different trigger. Read it there: `git show b1b69f2^:ui/js/session_view/frame_hold.js` (module state + rAF contract), and in `git show b1b69f2 -- ui/js/view_model.js ui/js/app.js ui/js/session_view/patch.js ui/css/session.css` the removed `settleZero` / `settleLanding` / `easeInOut`, `resolveFrameZero`'s settle branch, `vm.frameSettling`, the `settleRaf` loop in `app.js`, and the CSS rule that switches tile transitions off while the frame glides. Its tests: `git show b1b69f2^:ui/js/tests/frame_hold.test.mjs`, `git show b1b69f2^:ui/e2e/frame_settle.spec.js`. Still in the tree and ready: `buildRulerTicks(qEstablished, cycleQ, offQ, toZeroQ)` (ticks ride a fractional zero and are named where they LAND), `recordingHeadQ(…, restZero)`, `animator.js animatorFrame` (the playhead takes the frame's own move on a re-render), `render_request.js` (`requestRender` re-derives from the last poll).
1. A small module (call it `session_view/reseat_tween.js`): it remembers the zero the last render DREW, relative to the root frame (`vm.frameZero − vm.rootFrame`, so a seek — which moves every origin and the island zero together — is not a move) and the frame length it was drawn at. Before each derive `app.js` asks it for `opts.settle = { fromRel, t }` (linear progress 0..1 over `RESEAT_MS ≈ 200`); after each derive it is told what was drawn and what the seat is.
2. It STARTS a tween when a render at rest (no pin, no gesture live) would draw a zero that differs from the last drawn one by something other than a whole number of frames. It does NOT tween — it jumps, as today — when: a take is recording or armed (the frame grows with it); Q changed; the frame LENGTH changed in the same step (a trim, a cut that changes the LCM: that is a re-layout, and the display law is "morph only pure moves, snap re-layouts", session_view.md law 11); the island changed (project load); `prefers-reduced-motion`; or the page was hidden. A pin taken mid-tween captures the tween's TARGET (as the old `drag_pin.js noteFrame` did: `patch.js` passed `vm.seatedZero` while settling), so a hand always edits a grid-true frame.
3. `resolveFrameZero`: `pin ?? settle ?? seat ?? root`, the settle branch as removed — eased, the SHORTEST way round the frame (`settleLanding`), landing exactly on the seat at t = 1; return `landing` and `settling` so the ruler names its ticks from the landing and `recordingHeadQ` folds on it.
4. `app.js`: the rAF loop that calls `renderNow()` each frame while a tween runs; `patch.js`: toggle `#lanes.frame-settling`; `session.css`: `#lanes.frame-settling .reps-layer .rep:not(.recording-bar) { transition: none; }` (a tile's own left/width transition would trail the tween, and a tile div re-used across the frame edge would sweep across the lane).
5. **Remove the ↺ glide** from `splice_handles.js`: `TOP_GLIDE_MS`, `glideOffset`, `noteTop`, `placeTops`, `glideLoop`, `body._lrGlide` / `_lrTopPrev` / `_lrTops`, the `off` term in `layoutHandles`, and its header paragraph. Under a pin the ↺ then lands on its reset place at once, and the pin's release tweens the frame onto it. Remove test `(d)` in `splice_handles.test.mjs` and the "The ↺ glide" describe in `splice_handles.spec.js`; update time_maps.md §6 ("The glide").

**Watch for.** The splice-handle layer positions handles on every patch (they will ride the tween for free). A slotted-in loop's ↺ is drawn at `posMod(seat − frameZero, S)`: during the tween `frameZero ≠ seat`, so it slides in from where the new edge is — that is right. The region panel is raw time and must not move. The tween must never run under a hand: `isGestureLive()` or a held pin means no tween (complete it at once, as the old module did).

**Tests.** Unit: the tween's trigger table (each "does not tween" case above), the shortest way round, landing exactly, relative-to-root across a seek, pin-captures-target. E2E (sampled per animation frame: a `requestAnimationFrame` loop inside `page.evaluate` that records a tile's `left` each frame — the `sample(page, ms)` helper of the removed `frame_settle.spec.js`, and the one in `splice_handles.spec.js` "The ↺ glide" before step 5 deletes it): on the §13.0 topology drag the placing loop's splice +1Q (drops the ↺) and assert the OTHER lanes' tiles pass through intermediate positions for ~200 ms and land where the jump landed; a trim that changes the frame length still snaps; a recording never tweens. The specs updated in the audit assert only the settled picture (they `expect.poll` it), so they should survive the tween unchanged — run them.

**Docs to bring along:** frame.md §1 (the zero drawn: `pin ?? tween ?? seat ?? root`), session_view.md (the law the old settle had — law 17 before `b1b69f2`), design_language.md (motion), time_maps.md §6. `git show b1b69f2 -- docs/` shows the wording that was removed.

### 13.3 "Bounce selected…" starts at the ↺ as shown (ruling 3)

**Why.** The owner ruled (2026-09-24, bounce.md) that a clip's bounce opens on its ↺. Since 2026-09-29 the ↺ of a loop that slots into the frame is the sample it plays at the frame's top — but the engine's default start is still its own stored top, which the UI no longer shows anywhere. So a bounce of "clip 3" opens at a spot nothing on screen marks, and stems of different tracks start at different musical moments. Bounced from the ↺ as shown, every stem opens at the song's top and lines up with "Bounce song…".

**What to build.**
1. `ui/js/app.js`, `buildProjectMenu`: "Bounce selected…" calls `bounceTo(sel.id)` (no start → the engine's default). For a lane that wears a ↺ pass the start: `lastFrame.zero + lane.topHeardQ × quantum` (absolute samples; `topHeardQ` is the ↺'s place on the lane, measured from the zero DRAWN — 0 on a slotted-in loop, the pickup offset on the placing loop). Use `lastFrame.zero`, the same zero "Bounce song…" passes (`app.js` ~line 1161), not `.seat`: `topHeardQ` is folded from the drawn zero, so only that sum is the ↺'s moment, and a stem then opens on the very sample the song bounce does. The lane fields are not kept between polls today: keep the last view model's lanes by id (the poll loop already builds `lanesById`) and read `topHeardQ` / `canRetime` / `retimeLocked` there. A one-shot, a lane with no ↺, and the root keep today's calls. `bounce(uuid, path, start)` already takes the start for any node (`src/engine/bounce.cc`, `ui/js/mock/bounce.js`).
2. Check in `bounce.cc` that a named start earlier than the node's origin, or mid-period, renders one whole period from there for a looping clip, a windowed clip, a cut map and a group (it should: the render is the kernel equation at absolute time) — and add those cases to `tests/bounce_tests.cc` (the pattern is its test "A clip bounces from its ↺ top, not from the splice": the topped file is the plain one, rotated).
3. Engine default, for parity: `bounce.cc` (~line 105–122) adds the top offset only for a `ClipNode` (`dynamic_cast`); groups have had a ↺ since 2026-09-29 and `effectiveTop()` lives on the base (`src/audio_node.h`, published as `loopTop`). Use the base method for any anchored non-root node, and fix the comment ("Phase 2 stores no stack top").
4. `docs/bounce.md` "A clip starts at its ↺ top": rewrite to "…the ↺ as shown: the placing loop's own top; any other loop's — the frame's top", and note the app names the start.

**Tests.** `ui/js/tests/bounce_mock.test.mjs` and `ui/e2e/bounce.spec.js`: the request recorded for a slotted-in lane carries the song bounce's own start (the zero drawn), for the placing loop its ↺'s moment, for a one-shot none. C++ as in step 2. Engine e2e if time: bounce a slotted loop and the song, and check the two files' first frames carry the same capture clock (the chirp input makes that readable — `engine_helpers.mjs listen`).

### 13.4 Smaller, any order

- **A bypassed window over a wrapped take tile** (`lane_body.js`, the bracket overlay branch; `window_edit.js`): brackets and the chip are placed at `anchorQ + startQ/endQ` unwrapped, so on a take tile that wraps the frame's edge the END bracket and the chip fall past the lane's right edge (seen: a 16Q take at 8Q of a 16Q frame, window [6, 10) → start bracket at 14Q, end at 18Q = off-lane, chip clipped to "window"). Wrap them with the tile (`posMod(anchorQ + q, cycleQ)`), as the seam handles do (`map_bands.js wrapQ`), and split the dim when the window straddles the edge.
- **The transport readout's width** (`#position-readout` in `index.html` / `index_test.html`, `session.css`): "· loop NQ" appears while a drag pins the fold and widens the box, pushing the meters ~12 px. Give the readout a fixed width (tabular figures, ellipsis) — the state-metrics law, applied to the transport.
- **A cancelled drag leaves an undo step and ends the redo branch** (the restore is a commit). Needs an engine verb that DROPS the open gesture's step and restores the redo branch — `AudioEngine` `openGesture` / `sameGesture` in `src/engine/edit_log.cc`, mock twin `ui/js/mock/undo.js` — then `runRawDrag`'s `unsend` calls it instead of committing the old map.
- **The mock's new-take publication ≠ the engine's** (takes.md §6): make the mock publish pending as `isPendingStart` only, the live captured length as `duration`, and `periodQ` — so the mock suite can see what only the engine probe found. (A task chip with the full brief was left in the 2026-10-01 session; the brief is: `ui/js/mock/recording.js` `armRetake` / `growRecordingClips` / `commitRetake`, `ui/js/mock/publish.js`, then the takes specs.)
- **A group lane while its members take a new take** still reads the members as published (its own period can collapse for the take): thread `settledForFrame`'s view of the members into `pushGroupLane`'s period math, keeping the real nodes for the arm state (`groupArmState`) and the recording lanes.
- **Still the owner's to rule:** the ⌥ ⅛Q nudge vs. "no sub-Q grid" (§4.4); whether a slotted-in loop that starts a hair late should read its ↺ at the END of its region in the panel (§12.2 item 5), or get a pickup tolerance like the placing loop's ¼Q; and whether the right-edge splice handle (§12.1 #2) should also appear on a loop SHORTER than the frame as a tabbed handle at the take tile's own end (today that spot is a ghost line with its tab on hover).

---

## 14. Built, 2026-10-01 (the §13 work list)

All of it is UNCOMMITTED on top of `f7e4627`, beside the audit's fixes (§12.1) — the owner commits.

### 14.1 The claim lands when the gesture ends (§13.1, ruling 1)

Built as planned. `gesture.js` `beginGesture`'s `claim` selects the lane in `end()` — after `onEnd`, for a release and for a cancel; `runRawDrag` and `runRevealDrag` pass it through, so the splice, ↺, length, seam and grip drags no longer call `selectOnly` at the press. A press that was only a click (under `CLICK_SLOP_PX` of travel, inside `CLAIM_CLICK_MS` = 350 ms) claims after that window (`selection.js` `claimSoon`); a new press, or any explicit selection, drops a claim still waiting (`cancelClaim`); the double-click handlers still claim at once.

Measured again with a real mouse on the §13.0 topology: the lower lane's body stays at 370 px from the press to the release (it was 296 px by the first frame of the press), then moves when the panel swaps. Pinned by `gesture_latches.test.mjs` (3 tests) and `slotted_loop.spec.js` "A handle on an unselected track" (5 tests, 4 of them red on the press-time claim; the fifth red when a rail click does not cancel a waiting claim).

**Open, the owner's:** unselected lanes wear their handles (at 55 %, full on hover — `session.css` `.lane:not(.sel) .lr-layer`). If handles should show on the SELECTED track only — one click on the rail before editing another track — that is a small change on top of this (hide `.lr-layer` and the lane overlay's handles on `.lane:not(.sel)`, or gate `patchSpliceHandles`), and nothing can then be grabbed on a lane whose panel is not already open. Not done: it removes one-gesture editing of another track, which the ruling kept.

### 14.2 The re-seat tween; the ↺ glide retired (§13.2, rulings 2 and 4)

`session_view/reseat_tween.js` (new) + `view_model.js` `resolveFrameZero` (`pin ?? tween ?? seat ?? root`; `reseatZero`, `reseatLanding`, `easeInOut`) + `app.js` `deriveFrame` / `patchFrame`. frame.md §1 is the write-up. Where it departs from §13.2:

- **Every re-seat at rest, not two gestures.** The proposal said "for those two gestures only"; the rule built is the general one — a render at rest whose seat sits elsewhere in the SAME frame moves there — so an undo, a nudge chain's end, a double-click cut over the ↺ and a delete of the placing loop all move the same way. A re-layout (the frame's length or Q changed in the same step), a take live or armed, the trim view, another island, reduced motion and a hidden page jump as before. If only the two gestures should move, gate `noteReseat`'s start on "a pin was just released".
- **Two derives on the frame that would have jumped.** The seat is only known after a derive, so `noteReseat` answers "derive again" when a move starts (or its seat moves again mid-move — it carries on from the zero on screen) and `deriveFrame` derives once more from the move's first step. No frame of the jump is ever patched.
- **The curve is a sine ease-in-out, 200 ms.** The removed settle's cubic does its travelling in the middle third (three times the mean speed — a quarter Q a frame on a 1Q move), which at 200 ms reads as the jump it replaces.
- **`vm.restZero`** (new): the zero the frame rests on — the seat, mid-move. A drag's pin (`patch.js` `noteFrame`), a placement (import, the song's anchor) and "Bounce song…" read it (`lastFrame.rest`), never the passing zero; `seek.js` `seekApplied` carries it.
- `lane_body.js` `mapEditInFlight` counts a moving frame as an edit in flight (surplus tiles go at once, no cross-fade), and `#lanes.frame-tweening` switches off the tiles' own morph and the lane cursor's.
- The ↺ glide is gone from `splice_handles.js` (and its unit test `(d)`); `splice_handles.spec.js` "A reset ↺" now pins the nudge case — the ↺ lands at once under the chain's pin, then the frame moves onto it.

Pinned by `reseat_tween.test.mjs` (19) and `reseat_tween.spec.js` (7, real mouse, every animation frame sampled: the whole picture moves as one, lands exactly, ~200 ms; an undo moves back; a trim snaps; the cursor keeps its pace while playing; a hand mid-move completes it; a pin taken mid-move holds the seat; reduced motion jumps). Each was checked against a mutation (the tween stubbed out; the move not dropped under a hand; the pin capturing the passing zero).

### 14.3 "Bounce selected…" starts at the ↺ as shown (§13.3, ruling 3)

`view_model.js` `bounceStartOf(vm, laneId)` — the zero drawn plus the ↺'s place on the lane; `app.js` passes it (`lastVm`). `bounce.cc`'s default now reads the top off any anchored non-root node (a group's ↺ too), and `tests/bounce_tests.cc` adds "A group bounces from its ↺ top too" and "A named start: one pass from any moment is the loop's pass, rotated" (a window, a cut map, a group; starts later in the pass, whole passes later, before the take began, before the clock's zero). bounce.md is rewritten. UI: `top_fields.test.mjs` (4), `bounce.spec.js` (the stem of a slotted-in loop and the song open on the same sample).

### 14.4 The smaller items (§13.4)

- **The transport readout's width** — built: an invisible template line (`#odometer::before`) reserves the width of the longest everyday readout in the digits' own face, so " · loop NQ" no longer resizes the box. It costs the odometer ~50 px of resting width; it still shrinks (ellipsis) when the row is crowded. (`slotted_loop.spec.js` (g): without it the box grew 90 px in headless Chromium.)
- **The mock publishes a take as the engine does** — built (`mock/publish.js`, at the boundary): armed is `isPendingStart` alone; `duration` is the live captured length while capturing, a new take's too; `periodQ` is the committed length. `takes_mock.test.mjs` (a) pins the shape and (h) runs the mock's own state through the view for a whole group take.
- **A group lane while its mics take a new take** — built: `pushGroupLane` reads the group through `settledForFrame`, so its period, map and ↺ are the slot's (it re-tiled a 4Q kit as four 1Q tiles on the engine's shape). `takes_ui.test.mjs`, `takes_mock.test.mjs` (h).
- **A spec race found on the way:** `session_view.spec.js` `dragHold` read a bracket's box while the overlay was being rebuilt after the previous drag's commit (null, 1 run in 12 here, 0 in 72 on HEAD — the timing moved, not the behaviour). It now waits for a handle that is there.
- **A cancelled drag leaves no trace** — built: the engine verb `cancelGesture(uuid)` (`edit_log.cc`; the redo branch a gesture's first entry invalidates is kept with the gesture, `gesture_redo_`, and a seek shifts it), its bridge entry and mock twin (`mock/undo.js`), and every cancel path in the UI (`map_core.js` `cancelBandGesture`: the raw drag's default, the splice, the ↺, the panel's start marker, the cut band). Escape now leaves the undo stack and the redo branch as the drag found them, puts an unset top back unset, and says "Cancelled — nothing changed". time_maps.md §7 is the write-up.

- **Brackets on a take tile that wraps the frame** — built, and wider than §13.4 said: the same geometry put the LATENT end bracket of every plain loop whose take tile wraps (a take as long as the frame, performed mid-frame) past the lane's right edge, so a region could only be drawn in from its start. Brackets and the chip now wrap with the tile (`window_edit.js` `bracketQ`), the pointer reads the content on the dragged edge's side of the wrap (`contentQNear`), a latent pair that lands on one line keeps one side each (`.win-bracket.abut`), and a clip's dims wrap too (`dims.js`). session_view.md §2 ("Brackets wrap with the take tile").

### 14.5 Still open

- The owner's rulings listed at the end of §13.4; the handles question of §14.1 — now leaning one way, §14.6; and whether the re-seat tween should move every re-seat (as built) or only the two gestures the proposal named (§14.2). Nothing else from §13 is open. *(All ruled 2026-10-08 except the late slotted-in loop's ↺ — §15.)*

### 14.6 Handles on the selected track only (owner's note, 2026-10-08 — reading 1 BUILT the same day, §15)

The owner, shown that unselected tracks wear their handles (§14.1): *"handles on selected tracks only seems like the only UX that makes sense to me. I don't see how handles on the looping section work — that section is visualizing how the loop aligns with the song."* Not sure yet, but that is the direction. Two readings, in order of size:

1. **Handles on the selected track only** (the small step — the one §14.1 priced). A lane's loop chrome is an affordance of the SELECTED track, as the region panel already is: the splices and the ↺ (`splice_handles.js`), the latent and bypassed brackets (`window_edit.js`), the cut bands, a one-shot's seams and grips (`map_bands.js`). An unselected lane shows its loop section as what it is — how the loop aligns with the song — and takes no presses there; click its rail (or its body, if that is made a select) to edit it. The lane then NEVER moves under a hand: the claim-at-end machinery of §14.1 stays (harmless: a claim of the selected track is a no-op), and the tween of §14.2 is unaffected.
2. **No handles on the loop section at all; the panel edits.** The stronger reading of the note. The lane keeps only what reads the alignment (the ↺ mark, the splice marks as marks), and every edit — swap, shift, length, cuts — happens on the region panel of the selected track. A bigger redesign (the ⇧ length reveal, the whole-Q swap preview and the ↺ drag all live on the lane today); not for a session with little context.

**How to build reading 1** (one session, mostly gating + the five tests):
- `lane_body.js patchLaneBody`: the overlay's bracket/band/grip branches and `patchSpliceHandles` draw only when the lane is selected (`selection.has(lane.id)` from `selection.js`; the row carries `.sel`). Dims, chips (read-only), the arm marker and the heard cursor stay on every lane; the chip's bypass toggle can stay a click on any lane or follow the rule — decide.
- Or CSS-only first: `.lane:not(.sel) .lr-layer, .lane:not(.sel) .overlay-layer > :is(.win-bracket, .cut-band, .cut-handle, .seam-handle) { display: none; }` — same picture, chrome still built; cheaper, and `[` `]` (`teleport.js`) already walk the selected track only. Remove `.lane:not(.sel) .lr-layer { opacity: 0.55 }` and its hover rule either way.
- Selection has to be CHEAP then: a click on an unselected lane's body selects it (`lane_build.js` only selects on the rail today) — otherwise every edit of another track is rail-click + handle.
- Tests to flip: `slotted_loop.spec.js` "A handle on an unselected track" (5) become "an unselected track shows no handles; its body click selects it; the handles appear" (the measured no-move-under-the-hand assertion can stay as a selected-lane case); `splice_handles.spec.js` and `release_chrome.spec.js` already select first; `gesture_latches.test.mjs` claim tests stand.
- Docs: time_maps.md §6 "A handle's gesture claims its track" (rewrite to the selected-track rule), design.md's teleport line, session_view.md §2 brackets, frame.md unaffected.

### 14.7 The suites

Node 621 · mock e2e 156 · engine e2e 32 · C++ all passing (`CelestrianTests`, ~7 min; the new cases: `bounce_tests.cc` "A group bounces from its ↺ top too", "A named start…"; `time_map_record_tests.cc` "a CANCELLED drag…"). Every new e2e test was run against a mutation of the code it pins (the module served altered through `page.route` from a scratch copy of the spec — nothing in the tree is touched): each failed where it should.

---

## 15. The edit bar; handles on the selected track only (2026-10-08)

The §12–§14 batch was committed on 2026-10-08 (suites green: node 621, mock e2e 156, engine e2e 32, C++). The owner then ruled on what §14.5 left open and asked for the dock §13.1 had priced.

### 15.1 Rulings (owner, 2026-10-08)

- **The edit bar** — "matching Ableton's fixed edit bar at the bottom": yes.
- **Handles on the selected track only** (§14.6, reading 1): the lane's loop section shows how the loop aligns with the song; it is not an edit surface for every track.
- **The re-seat tween's scope:** keep it as built — every re-seat at rest moves (§14.2).
- **The ⌥ ⅛Q nudge:** drop it ("I never use it"). No sub-Q grid; fine moves are the ⌥ drag's.
- **A right-edge handle on loops shorter than the frame** (§13.4): leave it unless someone misses it.

### 15.2 What was built

**The edit bar** (`#region-dock` in `index.html` / `index_test.html`, a row of `#app` between the session and the status strip). Every lane still builds its own panel (`region_panel.js` `buildRegionPanel`, `row._regionNav`, `.lane-region[data-lane-id]`), but mounts it in the bar instead of its row; one shows at a time. So:
- selecting a track swaps what the bar shows and **no lane ever moves** — the panel was a row under the selected lane, and every lane below it moved by its height (74 px) on a selection;
- the bar has a **fixed height** (132 px) while there are lanes, so a selection never resizes the session either; when the selected track has no panel the bar says why (`noPanelReason`: "A 1Q take — no loop region to edit", "This track sets Q — drag its brackets on the lane", a member under its group's map, "Recording…", "Nothing recorded yet"; "Select a track to edit its loop" when nothing is);
- the label names the track (the bar is not next to its lane) and is a rail wide, so the detail strip starts where a top-level lane's body does;
- the bar sits outside the session's scroll: the panel keeps one width at every main zoom and scroll with no JS (`pinToViewport` and the scroll listener are gone; a `ResizeObserver` repaints on a window resize, `wireRegionDock`), and the playhead never crosses it (`playhead_mask.js` no longer masks the panel);
- the recording gate reaches the bar (`#region-dock.map-locked`, patch.js).

**Handles on the selected track only** (`session.css` `.lane:not(.sel)`, `lane_build.js`). An unselected lane draws its ↺ and splices as quiet lines — no tabs, badges or tints, no grab — and its brackets, grips and cut handles and chips not at all; dims, cut bands, a one-shot's seam marks, the chip's readout, the arm marker and the cursors stay (they are what the loop IS). A press anywhere on it SELECTS the track and does nothing else — a capture-phase listener on the lane body, ahead of every handle, band and cut; ⌘/⇧ add to the selection as on the rail. A double-click whose first press selected never cuts (it owns exactly one double-click). The chip keeps its click — a readout and a switch, not a handle — and selects too. Handing Q to a track (its Q lamp) selects it, since the trim view's brackets set Q.

The claim-at-end machinery of §14.1 stays and is a no-op: every handle is on the selected track now.

**The ⌥ ⅛Q nudge** is gone (`init.js`; `nudgeStepQ` deleted — whole-Q steps are whole samples already).

Pinned by `region_panel_keys.test.mjs` (c) (the bar's hint) and `slotted_loop.spec.js` "An unselected track" (marks, not handles; a press selects and nothing else, no lane moves at the press or after; its double-click never cuts; its chip still toggles) — each checked against a mutation (the capture listener off; the double-click guard off). The specs reach the panel through `panelOf(page, id)` (`region_panel_helpers.js`), not the lane's row.

### 15.3 Open

- **A slotted-in loop that starts a hair late** reads its ↺ at the END of its region in the panel (§12.2 item 5): explained to the owner in plain terms, not yet ruled. The proposal is the placing loop's tolerance for every loop.
- **"The song has a one"** — a proposal for which edits move the frame (the second clip is special only while nothing else can tell where bar 1 is): with the owner, not written up yet.
