# The frame

> **Status: spec** (owner ruling 2026-09-16, implemented the same day).
> The shared frame and its one cursor stay. Its zero is not stored: the
> view seats it from the lanes, in the order they are shown, every time
> the picture is drawn. The engine keeps one island fact besides Q —
> the island zero, the first take's origin — and nothing moves it for a
> commit or a map edit. The code names it `islandZero` and nothing
> more (the "epoch" rename, §7, landed 2026-09-17). Since 2026-09-24
> (loop-region phase 2) the seat reads a top at its ↺'s moment, at or
> before it with a ¼Q pickup. Since 2026-09-29 (owner) ONE loop places
> the frame — the first loop longer than Q — every other loop slots in,
> and there is no edit hold: an edit realigns the main view at once (§1).

---

## 0. The laws that are fixed

- **Playback.** A performance plays over what the performer was
  hearing. Content `k` of a take sounds at `origin + k`; a window
  `[s, e)` selects samples that each still sound at their own performed
  moment; a stack's map anchors at the stack's own origin (Q18).
- **The picture.** One frame, one cursor (I8), one shared axis (I2). A
  loop whose top is not at the left edge is drawn where it falls, wrap
  ghosted at the start (the heard view, session_view.md law 13). The
  take mark (Q14, folded by the take's `contextCycle`) is unchanged.

The only thing this document decides is *where the frame's zero comes
from*.

## 1. The rule

Take the lanes in the order they are shown. **The first loop longer
than Q places the frame** (owner, 2026-09-29): the zero is the bar line
at its ↺. A 1Q loop never places anything — every bar line is its top.
**Every other loop slots in** where its ↺ falls, wrap ghosted, so
editing a later loop (its region, its ↺) never moves the frame and never
changes where the others start. With no loop longer than Q, the first
loop places it. A top is its ↺'s **moment** (loop_selection.md §9.3),
read on the Q grid line **at or before** it — a top up to **¼Q early**
is a pickup to the next line.

```text
Z = ⟦top_p⟧                                       p: the placing loop
top = origin + a0 + heardOffset(segs, T)          (T: the effective top, `loopTop`)
⟦x⟧ = gridPhase + ⌊(x − gridPhase)/Q + ¼⌋·Q       (at or before x; ¼Q pickup)
a lane's offset in the frame = (top − Z) mod period
```

(Until 2026-09-29 every later lane pulled the zero forward by whole
cycles-so-far to bring its own top to the left edge. That made the
frame — and so the play start — follow the most recently edited long
loop, which read as editing one track moving another.)

`T` is the engine's published effective top: the stored top while the
kept set still plays it, else the region start. With no `loopTop` (an
engine from before Phase 2), or one the kept set does not play, the
top is the region start `a0`, and the seat is exactly the pre-Phase-2
seat. A group seats from its ↺ exactly like a clip (fractal, owner
2026-09-29 — until then a stack stored no top and seated from its
region start).

- A group with a window or a song seats as **one** lane (its pass is
  what its members are heard through). A plain group is transparent:
  its members seat in the order shown, as top-level lanes do, so a take
  recorded into a group starts at the left edge just as one recorded
  loose would.
- The root places the frame when it carries a song: the song owns the
  frame. Its top is the root's own origin — the zero the view had
  seated when the song was authored (§4) — so authoring a song moves
  nothing.
- One-shots do not seat (their offset is their placement, Q5).
- Drifting loops do not seat (Q22): a loop whose length fits no whole
  number of Qs lands its top somewhere else every pass, so it has no top
  that stays put. Its lane is drawn from the PASS ZERO instead — the
  island time at the left edge in the pass the cursor is in
  (`rawClock − playheadQ·Q`, `vm.passZero`) — so what the lane shows
  under the cursor is what sounds. In the Q13 trim view of a track Q was
  handed to, every other lane is drawn that way, under the definer's
  buffer for the current pass of its loop, and dimmed outside the
  selection.
- A recording take counts as the placing loop when no loop longer than
  Q came before it; its period is unknown until stop, and the frame
  during recording *is* the frame after commit.
- An unanchored stack has no content and no top.
- The seat is always on the Q grid, so the arm marker and every tile
  stay grid-true whatever a ⌥-slid window start or a free (sub-Q)
  re-time does. The ruler's ticks and every lane's gridlines sit at
  `(line − zero) / Q` (`buildRulerTicks`).

The view model does this (`seatFrameZero`, `ui/js/view_model.js`) once,
for the mock and the engine alike, and publishes it as `vm.seatedZero`.
The zero DRAWN is the drag pin while a gesture holds it, else the seat
(`resolveFrameZero`). The map-gesture pin holds the zero for the length
of a drag, as it holds the frame width — and past the release until the
gesture's final commit settles (capped at the commit hold,
`COMMIT_HOLD_MAX_MS`), so no poll between the release and the engine's
answer seats an unpinned frame from the last *live* geometry.

**No edit hold (owner, 2026-09-29).** From 2026-09-24 a selected lane's
edits were HELD — the zero stayed where it was until you deselected,
then glided (560 ms) to the seat. The main view exists to show how the
loops truly align, so that is gone: once a drag's pin drops, the frame
IS the seat, and an edit realigns the view at once. The region panel
(the whole take) is where editing context lives.

**Why floor, with a pickup (2026-09-24).** The seat reads a top on the
grid line at or before it: the ↺ at the left edge when it sits on a bar
line, a top a little late shown just *after* the edge, never wrapped to
the right end. A top a *little* early is still a pickup: within ¼Q of
the next line the take was pulled slightly early, and flooring it would
throw the whole picture back a Q to show a long wrap tail. A re-timed
part stays visibly shifted against the loop that places the frame — the
honest picture of a re-time. Pinned by `ui/js/tests/frame_seat.test.mjs`.

## 2. Pictures

```text
A is 1Q; B is recorded, then shortened to 6Q..10Q.  A constrains nothing.
     0    1    2    3
B    |6   |7   |8   |9   |
A    |a   |a   |a   |a   |

A is a 4Q loop; B is an 8Q take recorded starting on A's third Q.
     0    1    2    3    4    5    6    7
A    |p   |q   |r   |s   |p   |q   |r   |s   |
B    |6   |7   |0   |1   |2   |3   |4   |5   |     offset 2Q, wrap ghosted

B shortened to its first 4Q: still 2Q off.
     0    1    2    3
A    |p   |q   |r   |s   |
B    |2   |3   |0   |1   |

A is a 2Q loop; B is a 4Q loop whose top falls 1Q after A's.
     0    1    2    3
A    |p   |q   |p   |q   |
B    |4   |1   |2   |3   |     offset 1Q; there is nothing to rule

A is a 4Q loop; C is a 6Q take recorded 2Q in (cycle 12Q).
C seats at 2Q, where the performer watched it grow — no jump at commit.

A is a 2Q loop; B is an 8Q take recorded 1Q late, later windowed to 1Q..5Q.
Unwindowed: B at 1Q. Windowed: B's top is now 2Q off A's. A — the first
loop longer than Q — places the frame, so B slots in 2Q in (until
2026-09-29 the zero moved 2Q to bring B to 0).
```

## 3. What the rule gives without being told to

| The old rule | Under seating |
|---|---|
| Commit growth re-base by whole old cycles | the new take is the last lane; the rule *is* the re-base |
| The cycle-top rule and the free-move law | a later loop lands at 0 the moment its top is a whole cycle-so-far off the zero; an earlier lane is never moved by a later one |
| Two-anchor continuity's frame ride | nothing to ride: the origin re-anchor while playing stays (it is audio), and `Z` re-derives; the drag pin holds `Z` for a gesture, the edit hold for a selection |
| Q13 definer re-trim: zero := origin + a0 | the definer is the first lane; its top is 0 (the island zero is re-set with Q, §4) |
| The frame on every undo entry | the lanes go back, so `Z` goes back |
| The recording-frame shift in the view | the pending take seats last by its arm target |
| The mock's zero writes and the engine's, kept in parity | one derivation in the view model |

## 4. What the engine keeps

| Fact | What it is |
|---|---|
| **Origins**, on every node (Q18) | when the node began; moved only to keep audio continuous (the continuity re-anchor while playing, the definer's re-trim), by a seek (everything together), and by a lock-collapse |
| **Q, with the island zero** | the grid: a length and where it starts. The zero is the first take's origin, set at the first commit (an import that establishes Q likewise), immortal until the island empties (Q1, S11), shifted by seek, re-set by a Q13 re-trim to the definer's new top. It is the arm grid's phase — user-facing as the ● "your take starts here" marker and the count-in — and the frame a root window folds from. Stored as a residue because committed origins are *not* all on the grid: a take recorded through an ⌥-slid window has an off-grid origin. |
| **The root's origin**, while it carries a song (2026-09-17) | Q18 at depth 0: authoring a song on the root anchors it at the zero the view had seated — `setSequence` carries that zero, snapped to the Q grid; the island zero when none is given — so the song's top is where the picture already started. Its song folds from it on both threads (`StackNode::frameOrigin`, `heard::songPositionAt`), the cursor, a seek and the root's bounce measure from it (`AudioEngine::rootFrameTop`), a seek shifts it with every origin, and the session stores it like any stack's. A root already anchored keeps its origin (the song owns the frame); clearing the song un-anchors, as does the island revert that clears every song. Content never anchors the root (`settleAnchors` skips it). Both changes ride the edit's inverse. |

Nothing else. No commit and no map edit moves the zero
(`StackNode::takeCommitted`, `AudioEngine::attachMapEditRiders`).

## 5. What changed for the user (ruled 2026-09-16)

- **Later lanes follow an earlier lane's edit.** Edit the *first*
  loop's start and a later lane whose top now lines up snaps to 0; one
  that no longer lines up shows a wrap ghost. The old rule remembered
  which lane was touched last and held the later lanes still. Lane
  order was chosen because it is one sentence and never depends on
  history. The 1Q scratch loop constrains nothing, so the common case
  is unaffected.
- **Deleting the lane that seats the frame** re-seats later lanes on
  the next lane in order: "that was the loop; now this is". Deleting the
  1Q scratch loop changes nothing.

Everything else is the picture the old rules produced, now derived.

## 6. Rulings

| Ruling | Status |
|---|---|
| Anchoring law (2026-07-19); heard view / law 13; I8; I2; Q14 with the contextCycle fold | kept |
| Cycle-top rule (2026-08-18), free-move law (2026-09-15), the growth re-base (Q14b), continuity's frame ride (2026-08-09, 2026-09-10) | superseded: consequences of §1, no longer rules |
| "Editing one lane never moves the others" (2026-09-10) | kept, and complete since 2026-09-29: only the placing loop (the first longer than Q) positions the frame |
| "The grid you see is the grid you hear" (2026-09-09) | kept: a song owns the frame, and its zero is the island zero on both threads |
| Q1 / S11 "Q survives its creator" | kept: Q and its zero are the island's, not a lane's |
| A top seats on its nearest grid line, not the one below (2026-09-23, loop-region phase 1) | superseded 2026-09-24: the edit hold keeps every release in place |
| A top is its ↺'s moment, `origin + a0 + heardOffset(T)`; it seats on the first lane's bar line at or before it, a top up to ¼Q early a pickup to the next (2026-09-24, loop-region phase 2, P2.7) | §1 |
| While a lane is selected its edits never re-seat the zero; a selection change, a clear or an armed take releases the hold, and the frame settles once — 560 ms, the shortest way round, onto the seat (2026-09-24, P2.1) | superseded 2026-09-29 (owner): no edit hold, no settle glide — an edit realigns the main view at once |
| The first loop longer than Q places the frame; a 1Q loop never does; every later loop slots in where its ↺ falls (owner, 2026-09-29) | §1 |

## 7. Pending

- ~~**A root song authored after takes** moves the picture to the
  island zero.~~ **Built 2026-09-17** (§4): the root anchors at the
  seated zero when its song is authored; pinned by scenario S39, the
  mock parity test in `ui/js/tests/sequence.test.mjs` and the engine
  e2e journey in `see_vs_hear.spec.js`. A root **window** (engine API
  only; the UI authors none) still folds from the island zero.
- ~~**Bounce, import and seek** take positions in the engine's
  zero-relative frame.~~ **Built 2026-09-17:** the engine reads no
  frame for any of them. A seek is a phase ADVANCE the view computes
  against the zero it seated (`seek.js`; the engine corrects for the
  clock since the poll); an import lands at an absolute origin the view
  computes (the engine snaps it to the Q grid); a bounce takes an
  absolute start, and the app bounces the song from the seated zero so
  the file starts where the picture starts. Before this the ruler seek
  landed the cursor off the click whenever the seated zero sat a
  non-cycle amount past the island zero.
- ~~**The name.** `islandEpoch` / `epoch_samples_` name the island
  zero; a rename is mechanical and pending.~~ **Renamed 2026-09-17:**
  `islandZero` / `zero_samples_` across engine, mock, tests, docs and
  the fixtures; the published state and the headless status carry
  `islandZero`; the bundle key is `zero` (session version 3 — a
  bundle's legacy `epoch` key still loads). The received frame top a
  stack hands its children (`frame_top`, was `cycle_epoch`) and the
  map's heard top (`map_heard_top`) are named for what they are. The
  RCU reclamation epoch in `AudioEngine::retire` is a different thing
  and keeps its name.
