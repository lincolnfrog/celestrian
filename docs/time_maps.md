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
coherent frame; the sweep-vs-bracket mismatch itself remains a phase-2
item.)* *(Resolved for the Q13 provisional trim view, 2026-07-19: the
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

**Phase 2 (record-through-map) and phase 3 (cell/punch editor): pending.**
