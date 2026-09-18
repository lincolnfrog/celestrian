# The Sequencer: a Fractal Sequence Primitive

> Status: **spec — shipped through build step 6.** Every design
> question is ruled (S1–S22); the core, record-into-a-step, nested
> sequences, cue steps, successor graphs + the seed, and per-step fades
> are all in code. Companions: kernel.md, composition.md,
> design_language.md (I1–I9, Q1–Q18), time_maps.md.
>
> **Section numbers are stable.** Other docs cite `sequencer.md §2`,
> `§5`, `§13` and friends — including `.agent/style.md`'s example of
> correct citation form. Renumber nothing without fixing the callers.
>
> §16 records the designs that were tried and rejected. It is the only
> backward-looking section; §0–§15 state present law.

**Contents**

| | | |
|---|---|---|
| [0. Rulings S1–S7](#0-ruling-record-s1s7) | [1. The primitive](#1-the-primitive-the-sequence-lives-on-the-stack) | [2. The period law](#2-the-period-law) |
| [3. Gate and cue](#3-entrance-semantics-gate-and-cue) | [4. Recording under a sequence](#4-recording-under-a-sequence) | [5. Transitions](#5-transitions--the-smoothness-law) |
| [6. The radio](#6-the-radio-successors-chance-and-the-seed) | [7. Where it lives](#7-where-it-lives) | [8. Round-2 questions](#8-open-questions-round-2) |
| [9. Rulings S8–S17](#9-ruling-record-s8s17) | [10. The core](#10-the-core) | [11. Record into a step](#11-record-into-a-step-s16s19) |
| [12. Nested sequences](#12-nested-sequences-in-the-display) | [13. Cue steps](#13-cue-steps-s20s22) | [14. Successors + the seed](#14-successor-graphs-and-the-seed) |
| [15. Per-step fades](#15-per-step-fades-s13) | [16. Appendix](#16-appendix--alternatives-considered-and-rejected) | |

---

## 0. Ruling record (S1–S7)

Recorded 2026-08-19, first round.

- **S1 — Gate shape: mute-shaped.** Entrances keep the content phase —
  the track sounds where it would have been (I1's shape).
  Launch-shaped restarts are a per-step time-map, i.e. **cue**
  semantics (§3, §13).
- **S2 — Length unit: whole Qs**, cycle-multiple snapping as the UI
  default. Owner: *"alignment with hardware looper makes sense as a
  default concept in general."* This ruling carries §2's drifting-pass
  guardrail.
- **S3 — End behavior: loops as a whole** by default; play-once arrives
  later as an export/radio mode.
- **S4 — Verb composition:** manual mute ∧ gate (both must pass); solo
  per the Q16 canon over the gated population.
- **S5 — Recording under an active sequence** — answered in §4, ruled
  as S8.
- **S6 — Vocabulary: the feature is the Sequencer** (owner: *"I
  conceptualize it kind of like a drum pad"*). The per-stack object is
  a **Sequence**, its entries are **Steps** — drum-machine words for a
  drum-pad concept.
- **S7 — Transitions, and it's a law.** *"All transitions need to be
  smooth as much as possible"* — tails (echo/reverb) ring out when a
  track gates off; entrances and exits are quick fades, never hard cuts.
  §5 designs it; it also resolves the standing "effect tails on mute"
  question — mute adopts the same mechanism.

---

## 1. The primitive: the Sequence lives on the stack

**The Sequence** is a per-stack object, stored beside the stack's
time-map under the atomic-pointer discipline of the effect chain:

```text
sequence = {
    state: none | active | bypassed,
    steps: [ { name?, lenQ, gates: { childId → on },
               cue?, fadeIn?, fadeOut?, next?: [{to, w}] }, ... ],
    seed:  uint32
}
```

- A step's `gates` speak only about the stack's **own children** —
  never across the tree. There are no references, because a sequence
  only ever gates the subtree it already owns. Scenes-of-scenes is not
  a new mechanism; it is *nesting*.
- Absent childId = **inherit on** — a track added after the sequence
  was written sounds everywhere until told otherwise, and a new take is
  audible while you jam along (§4).
- Gates are **fractal downward** (I5): gating a child group gates its
  subtree, exactly like mute.
- The island root IS a StackNode, so "the song" is just the root's
  sequence. No special island-level object exists; depth 0 is the
  fractal identity, not a special case.

### The unification table

One primitive, five products — each row a degenerate case of the same
object:

| Product | Sequence shape |
|---|---|
| **Today's jam** | the degenerate sequence: one step, `lenQ` = inner cycle, everyone on (or simply `state: none`) |
| **The song** | N steps, overlapping gate sets, loop successor, loops (S3) |
| **The serial box** (Q6: 4Q box ⧺ 6Q box = 10Q) | N steps, ONE cued child each (§3, §13) — Q6's concatenation IS a sequence |
| **The drum pad** | steps of 1Q over one-shot children — the step grid at its smallest scale |
| **The radio / branch-with-chance** | steps over cued song-stacks, stochastic successor (§6, §14) |

---

## 2. The period law

**An ACTIVE sequence sets the stack's effective period to the sequence
length** (`Σ lenQ · Q`, and see §14 — it is the *program* total, not
the raw step list). The stack's *intrinsic* cycle (LCM of children) is
unchanged and still governs everything inside; the parent composes its
LCM from children's **effective** periods, as it already does
(`getEffectivePeriod`).

This is exactly the precedent windows set (time_maps.md: an active
window contributes its window length to the island LCM). The full
chain of sources is: **map period if a map is active, else sequence
length if a sequence is active, else the intrinsic LCM.**

Consequences, all falling out of existing machinery:

- A sequenced stack is, from outside, a clip of period seqLen (I5: the
  collapsed subtree obeys clip laws). An "album" stack that sequences
  song-stacks needs nothing new.
- `masterPos` wraps on the effective cycle, so the playhead sweeps the
  whole song; `heard_cycle_at_arm_` snapshots seqLen, so take anchoring
  (Q14/Q15) speaks the sequence frame with zero new code.
- Bypass restores the intrinsic cycle — the jam — which is the I9
  degradation shape: nothing baked, round-trippable.
- Coprime sequence lengths can explode a parent frame, the same
  standing issue as coprime takes. S2 snapping is the default
  mitigation; the frame-health badge (§11) is the warning.

### The drifting pass (a real phenomenon, named)

Mute-shaped gates (S1) plus a seqLen that is NOT a multiple of the
inner cycle ⇒ **successive passes of the song differ**. Example: inner
cycle 12Q (a 3Q and a 4Q loop), sequence 28Q. Pass 1 hears the 12Q
pattern at phases 0–28; pass 2 begins at phase 28 mod 12 = 4Q — the
same steps now frame *different bars* of the polyrhythm. Nothing is
wrong (every track is phase-honest, I1 holds), but the song is not
identical each time around.

- **The guardrail is S2:** cycle-multiple snapping makes seqLen a
  multiple of the inner cycle by default ⇒ identical passes.
- **The escape hatch is deliberate:** un-snapped step lengths are a
  drifting song chosen on purpose — a legitimate ambient/generative
  instrument — badged visibly (↯), never silent.
- **Cue-mode entrances (§3) also restore per-pass determinism**, since
  a cued child restarts identically each visit.

---

## 3. Entrance semantics: gate and cue

Two ways a step can bring a child in — different musical intents, not
competing designs. Both are built.

- **Gate (S1, the default).** Audibility only. The child's phase
  derives from the clock as always; entrances land in-phase for free.
  Right for tracks inside a song.
- **Cue (§13).** The step re-bases the child's received frame to the
  step top, so the child hears `t' = childZero + (t − stepStart)` — a
  per-step zero re-base, which is to say **a time-map**, the object
  Q6's ruling names ("a serial group is a composite whose time-map
  routes each child a sub-range of the cycle"). A cued child starts
  from its own top on every entrance. Right for chaining boxes
  (verse-box then chorus-box) and for the radio's song-after-song.

Cue interacts with I1 the way any deliberate re-framing does (I9): the
child's *internal* coherence is untouched — its takes align with each
other — and the box as a whole is being played like an instrument.

---

## 4. Recording under a sequence

Two record modes; neither needs a refusal.

**Mode 1 — record over the song.** The transport is already running the
sequence; you jam along and hit record. The take anchors by origin as
always; the heard frame (`contextCycle`) is the sequence period, which
the existing arm snapshot already captures because seqLen IS the
effective cycle (§2). A new empty track inherits ON in every step, so
you hear yourself everywhere while tracking. A take longer than seqLen
is the existing frame-growth story, nothing new.

**Mode 2 — record into a step** (*"record the guitar solo over the
breakdown"*). The step's range `[stepStart, stepEnd)` over the song
timeline is **a one-segment window**, and recording through it is
**through-map recording** (time_maps.md §3): heard-time arm on the step
grid, one-period cap — take ≤ step length, musically exactly right for
a section part — and a dense commit. Arm quantization is Q11 unchanged;
the step is just the context loop.

Two extras ride the commit:

- the take **auto-gates**: ON in the target step, OFF elsewhere (that
  was the intent of aiming at the step), as one undoable edit with the
  take (§11);
- looping a step while working doubles as the **section audition** —
  the same window, activated without arming.

**S21 makes the modes automatic inside a cued step.** See §13.

### The composition law (S9)

> **Per node, fractal, fixed order: `inner timeline → SEQUENCE →
> TIME-MAP → parent`.** The sequence gates children and sets the
> timeline's period (seqLen); an active time-map's segments then select
> spans **of that post-sequence timeline**. Walking down: the node maps
> received time first (`m(t)` = a song position), looks up the step at
> that position, and passes time + gates to children.

With no sequence this degenerates to today exactly — the map selects
spans of the intrinsic cycle. With one, "loop the chorus" is a
one-segment window `[8Q, 16Q)` over the song, which is *precisely* the
Mode-2 record and the section-audition affordance. Sequences and loop
regions are not rivals; their composition IS the feature.

---

## 5. Transitions — the smoothness law

Tails ring, edges fade, nothing pops (S7).

- **Gate placement is PRE-FX.** A gate silences the child's dry content
  *before* the node's effect chain, so echo and reverb keep processing
  and ring out naturally. **Mute and solo use the same pre-fx gate** —
  one mechanism, one behavior.
- **Two timescales of fade:**
  - the **anti-pop micro-fade** — a short equal-power ramp (~10 ms) on
    every gate/mute/solo edge, always on, not user-visible; the
    speaker-pop guarantee, and the floor under every other ramp;
  - **musical fades** — per-step fade-in/out lengths, §15.
- **The envelope is pure** (§10): one smoothed gain per node, target set
  by the gate resolve — allocation-free; the mixer already sums per
  node.
- **Cue seams cut** (S20, §13): at a cued-step edge the child clock
  jumps, so the boundary is a hard cut through zero with the micro-fade,
  even for a child gated ON across it.

---

## 6. The radio: successors, chance, and the seed

A sequence's steps advance by a **successor function**. The loop
(`successor(i) = (i+1) mod N`, S3) is the default; the radio and
branch-with-chance are one generalization — **successor is a small
weighted graph over steps**, where a plain song is the graph with every
edge at p = 1.

**The purity problem, and the answer.** Playback is a pure function of
clock + state (I6); a random draw at each boundary would break that. So
the randomness is **a seed, stored as data**: the step program is a
deterministic unroll of `(sequence, seed)`. Every callback derives
"which step at time t" purely, the UI projects the upcoming path
honestly, and a radio run is *reproducible*:

- **"I liked that run" = save the seed.** Re-roll = new seed (one
  verb). Export a radio session = render `(sequence, seed, length)`.
- The infinite radio (design.md mode 3) is a root stack whose children
  are cued song-stacks, stochastic successor, play-once off — *the
  catalog is the instrument, the seed is the performance.*

**A stochastic sequence has no well-defined period**, so it cannot
contribute to a parent LCM. Stochastic successors are therefore legal
on the ROOT only; nested radios are refused (§14).

---

## 7. Where it lives

| Layer | Home |
|---|---|
| Storage | `sequence` behind one atomic pointer per StackNode; `Edit::Sequence` undoable with raw-state inverse; save format additive (`sequence` block, QTime lengths) |
| Engine | `src/sequence.h` (the pure envelope, `gainAt`, `songToContent`, `rampsOf`, `finalize`, `linearize`), `src/stack_node.cc` (`childContext` re-base, gate lookup, seam-run splitting), `src/audio_engine.cc` (verbs, S21 auto-target, refusals) |
| Bridge | `setSequence(uuid, seq)`, `toggleSequence(uuid)`, `auditionStep(uuid, step)` — three places plus the mock twin |
| Mock | `ui/js/mock/sequence.js`, `ui/js/mock/recording.js` |
| VM | `ui/js/view_model.js` (grid, `displayPeriodQ`, `seqDims` layers), `ui/js/sequence_program.js`, `ui/js/frame_health.js` |
| UI | `ui/js/session_view/seq_grid.js` (the grid, pips, popovers), `lane_body.js` (dims, cue marks, fade gradients) |
| Templates | `src/track_template.h` — sequences carried, gates re-keyed to rebuilt ids (S14) |

### The pad grid is the one control, at every depth (S15)

- **ONE edit surface:** the grid, expanded from a stack's `seq · NQ`
  rail chip (the fx-row pattern). The root has no rail, so its sequence
  opens from a **transport-bar chip** beside the odometer; its grid is
  the FIRST row, over the top-level tracks. The chip hides until Q is
  established. Rows = children, columns ∝ lenQ.
- **Step verbs on column headers** (cut-band grammar): grip resize
  (whole-Q, cycle-multiple default), dblclick rename, drag reorder,
  right-click merge/delete, ＋ appends, hover ⟲ loops the step
  (audition / record), ⇤ pip toggles cue (S22), → pip opens the
  successors popover (§14), the length chip opens the fades popover
  (§15).
- **Pad verbs:** click toggle, drag paint, row-name whole-row toggle.
- **Footer:** totals ("seq · 28Q · 1:52"), bypass toggle, frame-health
  badge when warranted, orphan ⤳ chips, and a radio's
  `📻 radio · seed xxxxxxxx` + `⟳ re-roll`.
- **Lanes are display, not control.** Their song-frame rendering is the
  period law's display consequence — a pure projection. Lane span
  gestures are already dense (trim grips, cut bands, seams), so gate
  toggling stays in the grid.

"+ step" defaults to one intrinsic cycle of the stack — which for an
all-one-shot kit is 1Q, the drum-machine scale. **Sequences track Q:**
a definer re-trim rescales step lengths (and fades) with Q.

---

## 8. Open questions, round 2

The S8–S15 questions were raised and ruled the same day (2026-08-19).
The questions are preserved inside their rulings — see §9.

---

## 9. Ruling record (S8–S17)

Recorded 2026-08-19 unless noted.

- **S8 — The two record modes, go.** Mode 1 + Mode 2 + auto-gating +
  Q11 arm math as §4 proposes. Owner: the record-over-the-chorus UX
  needs another specificity pass later (→ S17); the general idea is
  sound.
- **S9 — Sequences and loop regions COMPOSE.** The owner rejected
  refuse-v1 (*"we should be able to support sequencing and loop
  regions… modify the loop region to only loop over the chorus, then
  hit record"*). The worry that the two features fight dissolves into
  **the composition law** (§4). One honest subtlety became S16.
- **S10 — The drifting pass: snapped-by-default, badged free lengths.**
  The owner's worry (*"one part 11Q, one part 12Q and the song blows
  out to 25 minutes"*) located precisely: **within one sequence, steps
  CONCATENATE, they never LCM** — an 11Q step beside a 12Q step is a
  23Q song, harmless. The blowup risk lives at **sibling composition**:
  a sequenced stack of effective period 11Q beside a 12Q loop makes the
  parent frame LCM(11,12) = 132Q — the same standing risk as coprime
  takes. So: ONE guardrail wired to both sources, the **frame-health
  badge** (§11).
- **S11 — Cue reserved in the step format now**, implementation
  deferred (built 2026-08-27, §13).
- **S12 — Root-only stochastic successors**; the seed is data — saved,
  re-rollable, exportable (§6, §14).
- **S13 — Fixed ~10 ms anti-pop now**; mute and solo adopt it in the
  same change. **Per-step musical fades are committed future work**
  (owner: *"I could definitely imagine wanting a part to fade out over
  a few seconds"*) — built 2026-09-03, §15.
- **S14 — Templates carry sequences**, gates re-keyed to the rebuilt
  ids (the `insertTrackTemplate` input-rekey precedent).
- **S15 — The PAD GRID is the one control, at every depth**
  (2026-08-20, after two mockup rounds). The owner chose the grid and
  asked the decisive question — *"why would we have two ways of doing
  the same thing… are we just missing an explicit top-level stack?"*
  Answer: the root stack already exists and owns the top rail, so the
  root's sequence hangs off a chip like any stack's. Canon in §7.
- **S16 — Window domain** (ruled 2026-08-20). Window coordinates
  authored over a sequence timeline lose their meaning if the sequence
  is bypassed, so a window records its domain (`sequence | intrinsic`);
  a domain-mismatched window **auto-bypasses — never deletes** (I9) —
  and reactivates with the sequence. Built as §11's
  `StackNode::window_domain_`.
- **S17 — Mode-2 record gesture** (ruled 2026-08-20). The concrete
  gesture is the step audition: hover ⟲ on the step header loops it,
  and R while it loops records into it. Built as §11.
- **S18 — (a) everywhere** (2026-08-20). A manual window on a sequenced
  stack behaves like the audition: `C = map period` whenever the
  mapping node has an active sequence. Owner: *"we should not be in the
  business of inserting silence"* — **no silence is ever inserted by a
  sequence.**
- **S19 — Takes ARE undoable** (2026-08-20). Owner: *"it's weird they
  aren't."* The auto-gate composes into the take's one undo step.

---

## 10. The core

- **The gate envelope is PURE** (`src/sequence.h`): a schedule-derived
  piecewise-linear gain, with corners at step boundaries ± the 10 ms
  fade (plus step midpoints for short runs). The parent stack splits
  render blocks at envelope corners (`forEachSeamRun` carries a
  corner-distance term) and hands each child exact `(gate_g0, gate_g1)`
  endpoints in `ProcessContext`, so **output is block-split
  independent** (pinned: the same span rendered in odd chunks is
  byte-identical).
- **Mute and solo ride the same pre-fx gate** with a per-node smoothed
  ramp, seeded at first target so there is no phantom fade on load.
- **The mid-take gate** refuses `setSequence` / `toggleSequence` while a
  take is armed or recording in the subtree (the `setSegments`
  precedent).
- **Fractal, root included** — engine, mock, and VM all handle a
  sequence on the session root; groups keep their own rail chips.

---

## 11. Record into a step (S16–S19)

### 11.2 The step audition is a derived window (S17)

`StackNode::audition_step_` makes the selected step a derived
one-segment map. `AudioNode::activeTimeMap()` and
`isLoopWindowActive()` are VIRTUAL so StackNode can answer with the
derived map — and, for S16, with *none* while suspended.
`AudioEngine::auditionStep(uuid, step)` refuses mid-take and
out-of-range. A step-COUNT change (delete) clears the audition; a
resize keeps it — decided inside the Sequence edit applier so undo and
redo agree.

Metadata publishes `sequence.auditionStep` plus the derived window over
`loopStart` / `loopEnd` / `windowActive`, root included (the VM reads
the root's top-level fields into `vm.rootWindow`; the ruler draws the
brackets). The frame stays the SONG and the cursor is mapped into the
step — the sole-top-level-window pattern. Group lanes under an audition
hid their brackets until §12 put group lanes in song coordinates. Esc
clears it through `onEscapeAudition`.

### 11.4 The commit cycle — the song rides the island zero (S18)

A root song's steps fold from the island zero, and no commit moves it
(`StackNode::takeCommitted`; frame.md): a part recorded into a song
never re-phases the song. The view seats the root song first, so the
song owns the frame on screen exactly as it does on the audio thread.

### 11.5 Takes are undoable, and the auto-gate composes (S19)

`Edit::Kind::Take` / `Untake` with `Edit::TakePayload` — content moved,
never copied, retired through the reclaimer like every displaced
buffer; `ClipNode::stripTake()` / `restoreTake()`.

Commit is an audio-thread event, so the engine registers a
**PendingTake** at arm (uuids, the pre-take Q/zero, the auto-gate
target) and `reconcileTakes()` logs it — at the top of every
`getGraphState` poll and before any log operation — once every member
has settled. A Q7 group take is ONE entry; a cancelled performance logs
nothing. Undo/redo of a take entry is REFUSED (entry kept) while a take
is live. The first take's establishment of Q and the island zero rides
`setsIsland` (no commit moves them afterwards). Untake deliberately does NOT uncollapse a Q13
definer — the `CollapseTake` entry beneath it does.

**The auto-gate composes:** `applyAutoGate` folds one `Edit::Sequence`
into the take's Untake entry (the `seq` rider), so ⌘Z removes take and
gates together. Direct children of the auditioning stack only; a deeper
take lands ungated with a log line.

### 11.6 The frame-health badge (S10)

`ui/js/frame_health.js`, pure, with golden vectors `frame_health_cases`
in `shared/timing_golden.json`. Whenever an edit would make an
ancestor's effective cycle exceed ~4× its largest member's period, the
responsible chrome shows an amber warning — "⚠ 11Q → parent frame ×132
(25 min)" — with a one-click "snap to NQ" offer. The gentler
**drifting-pass badge** (↯; seqLen not a multiple of the inner cycle,
§2) is the second face of the same component.

Attribution prefers a member WITH a length knob whose removal would
make the scope healthy, then the largest shrink — the raw "largest
shrink" blamed the loop rather than the song for two coprime members.
The threshold is strict: coprime p beside q has ratio min(p, q), so 7Q
beside 4Q (28Q, exactly 4×) is healthy while 7Q beside 5Q (35Q) warns.

Shown on the responsible lane's period chip (amber, tooltip), the grid
footer (badge + one-click snap, delta on the last step, one undoable
`setSequence`), the grip's live readout (⚠ / ↯ while dragging), and the
seq chips (↯ for drift).

### 11.7 "+ step" defaults to one intrinsic cycle

A new step is one intrinsic cycle of the stack it is added to — which
for an all-one-shot kit is 1Q, the drum-machine scale. **Sequences
track Q:** a definer re-trim rescales every step length (and its fades)
with Q, so a song written against a provisional Q survives the re-trim
that locks it.

### 11.8 Window domain (S16)

`StackNode::window_domain_`, stamped by the LoopPoints and Segments
appliers (`Edit::window_domain`; inverses restore the old stamp).
Suspended = sequence-domain ∧ sequence off ∧ a valid window
(`activeTimeMap()` → none; metadata `windowDomain` / `windowSuspended`),
persisted additively, drawn as dashed dim brackets with a
"window · suspended (sequence off)" chip.

---

## 12. Nested sequences in the display

The engine has had nested sequences since the core (fractality); these
are the four projections that make the DISPLAY honest about them. Each
is the period law (§2), "ghosts show what sounds" (Q10), and S15
("lanes are display") applied one level down.

### 12.2 The four projections

1. **Group lanes obey the period law.** `displayPeriodQ` of a stack
   with an active sequence is its seqLen; the lane tiles one take tile
   plus ghosts per pass across the frame. The rail's period chip reads
   the song length; the composite waveform tiles with it. Bypass
   returns the lane to its intrinsic tiling (I9).
2. **Dims COMPOSE.** `lane.seqDims` is a LIST of layers
   `[{periodQ, offSegsQ}, …]`, outermost first: the root's pass dims
   the whole Drums subtree over 8Q, the Drums pass dims Kick over 4Q,
   and `patchSeqDims` tiles every layer. A lane reads as silent where
   ANY enclosing sequence silences it — exactly the engine's fractal
   gate.
3. **One-shots echo at their scope cycle.** A one-shot under a
   sequenced scope fires once per pass of that scope's song; its lane
   shows ghost tiles at that period (dashed, the one-shot tone) when
   the scope cycle is shorter than the frame. The Q5 "no ghost
   repetitions" rule survives unchanged where scope cycle = frame.
4. **Nested auditions draw.** With the group lane in song coordinates,
   the derived window's brackets land where they mean (first tile), and
   the children's `parentMapSegs` dims are already in that frame.

**The nested grid is the same grid**, one row down (S15: one control,
every depth). The playing column is `(playheadQ − phaseQ) mod totalQ`,
where `phaseQ` is the group's Q18 origin in the lane frame — **a nested
song folds from its GROUP's origin, the root's from the root's own
origin — the zero the view had seated when the song was authored
(frame.md §4, 2026-09-17), the island zero before that** ("the
grid you see is the grid you hear", design_language.md §5).

---

## 13. Cue steps (S20–S22)

### Rulings (2026-08-27)

- **S20 — Cue seams dip.** At every cued-step edge (both edges, the song
  wrap included) the child clock JUMPS, so the gate envelope treats the
  boundary as a HARD CUT and dips through zero with the standard ~10 ms
  anti-pop micro-fade, even for a child gated ON across it. Musical
  crossfades between cued children remain S13 future work.
- **S21 — Arm inside a cued step auto-targets it.** A Mode-1 take lands
  at absolute positions, but cue playback re-bases the step to the song
  top — the take would never replay where the performer heard it. So
  arming while the playhead is inside a cued step BECOMES Mode-2
  record-into-that-step: the nearest sequenced ancestor's audition
  engages on that step (an audition already active anywhere wins — the
  performer aimed), and the S18 part + S19 auto-gate flow does the
  rest. The implicit audition is the same monitoring gesture as an
  explicit one; Esc releases it. Arming in a PLAIN step stays honest
  Mode 1.
- **S22 — The header pip.** Cue is a per-STEP property and the pad grid
  stays the ONE control (S15): each step header carries a ⇤ pip
  (hover-revealed like ⟲, always lit while cued, amber — the re-frame
  colour) toggling gate-mode ↔ cue-mode. It rides `setSequence`: one
  whole-object swap, one undo step.

### Semantics

**The cue map.** Song position → content position:
`content(rel) = rel − stepStart(i)` on a cued step i, identity
elsewhere (`Sequence::songToContent`). The re-base lives in
`StackNode::childContext`, layered UNDER any authored or audition map —
the S9 composition law: the map selects SONG positions, and the cue
maps song positions to CONTENT positions:

```text
t' = receivedZero + content(fold(childPos − receivedZero))
```

The child frame's cycle top returns to the received zero, so a nested
song-stack restarts from its own top on every entrance.
`forEachSeamRun` already splits blocks at step bounds, so the step is
constant within any one run.

- **Gates stay on the SONG timeline.** `renderChildren` derives the step
  lookup from the received clock through the own map alone — never from
  the re-based child clock, or a child gated off in a cued step would
  wrongly read step 0's gates.
- **Record into a cued step composes.** Under an audition aimed at a
  cued step, `childContext` hands down the COMPOSED map
  (`single(0, stepLen)`), so the through-map arm math places the take at
  the song top `[0, stepLen)` — exactly where cue playback reads it.
  C = the step (S18), as before.
- **An authored window over cued steps refuses the arm** (the
  nested-active-maps refusal precedent): the window may span several
  steps, so composed take placement would be a multi-segment product.
  Playback through such a window is fine — the per-run re-base is
  exact; only the ARM refuses, with a log naming the fix (audition the
  step to record into it).
- **Period law unchanged.** Steps still concatenate; `total`, the frame,
  and the chip read exactly as before. Persistence is additive (`cue`
  per step in session, metadata, and templates; the sequences-track-Q
  rescaling copies it).
- **Display honest, pure projection.** Lanes mark cued spans
  (`seqDims[].cueSegsQ` → the amber top-hairline + ⇤ marker) on every
  child of the scope, gated or not — the span still SOUNDS, it just
  replays the song top.

---

## 14. Successor graphs and the seed

The radio of §6, built. S12 as ruled: root-only stochastic successors;
the seed is data.

**The model.** Each step carries `next: [{to, w}]` — its weighted
successors; empty = the loop successor `(i+1) mod n` (S3). The sequence
carries a `seed` (uint32). The **PROGRAM** is the walk from step 0: a
list of VISITS (a step index each). Every timeline question — position
→ step, gates, cues, the audition span, the period — reads through the
program, never the raw step list. A plain song's program is
`0, 1, …, n−1`: today's behaviour exactly.

**Purity.** A draw at visit k is `mix32(seed ^ mix32(k·φ + c))`
(lowbias32, integer-only) mod the weight sum — a counter hash, so
`(sequence, seed)` unrolls to ONE program on the message thread
(`Sequence::finalize`) and the audio thread derives "which step at t"
from snapshot + clock alone (I6). The JS mirror
(`ui/js/sequence_program.js`) reproduces the walk bit for bit, pinned by
`sequence_program_cases` in `shared/timing_golden.json` from both sides.

**Periodic vs RADIO.** When every visited step has exactly one candidate
successor AND the walk returns to step 0, the program is that loop and
`total` is its period — a jump graph (A → C → A, B orphaned) is a
legitimate 2-step song anywhere in the tree. Otherwise the sequence is a
**radio**: it has no period, so it is legal on the ROOT only.
`setSequence` refuses it nested with a log; a nested block in a session
or template is DEMOTED to the loop on load (`Sequence::linearize`).

Two things make a radio: a branch with chance (two or more candidates),
or an **intro** — a deterministic walk that revisits a step other than 0
(0 → 1 → 2 → 1 → 2 …). A radio's program is the walk unrolled to the
**horizon** (`kMaxVisits` = 256 visits), after which it repeats; the
horizon total is what the root's frame folds on (masterPos wrap, the
ruler, the grid). That is long enough for hours of song-stacks.

**What rides the program.** Cue re-bases per VISIT (a cued step
revisited re-bases on every entrance; S20 cuts at every seam). The gate
envelope runs over visits (runs merge across revisits of on-steps; the
all-on fast path reads the REACHABLE mask, so an orphan's gate is
irrelevant). The step audition loops the step's FIRST visit; an orphan
has no span and refuses. S21's arm-inside-a-cued-step reads the visit
under the playhead. The frame-health faces read the program total.

**Persistence.** Additive: `next` per step and `seed` on the block, in
metadata, session, and templates (the template's index-keyed gates are
untouched — successors name STEP indices, which the template keeps). The
ROOT's own sequence is persisted as the `sequence` block of the root's
own node record (`root`), applied after Q; version-1 bundles'
bundle-level `rootSequence` still loads.

**UI.** While the program is periodic the grid's COLUMNS are its visits
in program order — a deterministic loop plays each step at most once, so
a column is a step, time-honest. A RADIO's grid shows the GRAPH instead:
one equal-width column per reachable step in list order, since the
horizon would be hundreds of slivers. The lanes stay the honest timeline
and the frame chip reads the whole program.

The header's → pip opens the SUCCESSORS popover: one row per step — the
name = "ONLY this follows" (a single successor, legal anywhere, so
re-routing a nested song never passes through a branch), ＋/− adds or
drops a branch candidate, a weight when on; the default (next step,
weight 1) stores as no list; every change is one `setSequence`. Orphans
have no column and wait in the footer as ⤳ chips — click to choose what
follows them, right-click to delete; deleting a step re-indexes every
edge.

**Open:** whether a nested radio should ever be legal (tasks.md C3) — it
would need the horizon total as a period, a different rule from "no
period". Refused until someone needs it.

---

## 15. Per-step fades (S13)

S13's committed future work, built.

**The model.** Each step carries `fade_in` / `fade_out` (samples;
musical — QTime in the session, Q counts in templates, scaled with Q on
a definer re-trim like `len`). 0 = no musical fade. The fades are
properties of the STEP, applied to every child's gate RUN through it: a
run ramps in over its FIRST step's fade-in and out over its LAST step's
fade-out. The S7 anti-pop micro-fade (10 ms) is the floor — a ramp is
never shorter than it, so nothing ever pops. Ramps that do not fit the
run shrink proportionally so they meet (`Sequence::rampsOf`); with no
musical fades this reproduces the symmetric half-run clamp exactly. Cue
seams still cut (S20) — a cued step's own fades shape the dip on each
side.

**Purity kept.** The envelope stays a pure function of position
(`gainAt`); the seam-run splitter's corner distance is MASK-AWARE
(`cornerDistance(rel, fade, mask)`) — the parent folds it over every
gate row plus the all-on mask, and every visit boundary is always a
corner — so each block still has constant-slope gain and `(g0, g1)` are
exact.

**Wire format** (additive): `fadeIn` / `fadeOut` samples in metadata and
the verb payload (negatives clamp to 0, absent when 0); `fadeInQ` /
`fadeOutQ` in session blocks and templates.

**UI.** The step header's length chip opens the FADES popover (fade in /
fade out in Q, one `setSequence` per change); the chip wears ◢ / ◣ while
a fade is set. The lanes project the ramps as gradients into and out of
the dims (`seqDims[].fadeSegsQ` — runs merged across the wrap and broken
at cue seams, engine parity `runAround`).

---

## 16. Appendix — alternatives considered and rejected

Kept so they are not re-proposed.

**Option A — one Arrangement at the island root**, a gate schedule
hanging off the song. **Superseded** by the fractal reframe (owner: *"we
could make the sequencer an embedded part of stacks — any stack can
declare a sequence, and then if you have a stack that contains that
stack, that entire stack itself can be sequenced"*). A survives exactly
as the root-sequence case, since the root IS a StackNode.

**Option B — sections as scene nodes on a serial time-map.** **Blocked
and abandoned** on reference/aliasing semantics: scenes referring to
tracks elsewhere in the tree needed a reference model nothing else in
Celestrian has. The fractal reframe *dissolved* the problem rather than
solving it — a sequence only ever gates the subtree it already owns, so
there are no references, and scenes-of-scenes is just nesting.

**Option C — perform-the-arrangement capture.** Not rejected:
**unchanged and still available** as a capture verb that writes sequence
data through the mute gestures the owner already performs. Nothing in
the built design forecloses it.

**Refuse-v1 for sequence × time-map on one node** (the S9 proposal,
following the nested-active-maps precedent). **Rejected by the owner** —
*"we should be able to support sequencing and loop regions"* — and
replaced by the composition law (§4), which turned the feared conflict
into the record-into-a-step feature.

**A second, root-level sequencer control** (mockup round 1, variant A),
separate from the per-stack grid. **Rejected** with S15 — owner: *"why
would we have two ways of doing the same thing… are we just missing an
explicit top-level stack?"* The root's sequence hangs off a chip like
any stack's, and the lanes' song-frame rendering was never a control to
begin with; it is the period law's display consequence.

**Lane-level gate toggling** as a second edit surface alongside the
grid. **Deferred, not built:** lane span gestures are already dense
(trim grips, cut bands, seams). A modifier-click toggle can ride later
without moving the design.

**S18 option (b) — inserting silence** so a manual window on a sequenced
stack could hold a fixed span. **Rejected**, owner: *"we should not be
in the business of inserting silence."* A manual window behaves like the
audition instead: `C = map period`.

**Mute as an output-stage zero with frozen tails.** **Replaced** by the
pre-fx gate (S7): one mechanism for gate, mute and solo, so echo and
reverb ring out naturally. This also closed the standing "effect tails
on mute" question.

**Deleting a domain-mismatched window** when its sequence is bypassed.
**Rejected** under I9 (S16): the window auto-*bypasses*, never deletes,
and reactivates with the sequence — nothing baked, round-trippable.

**Launch-shaped gate entrances** — a gate that restarts the child rather
than unmuting it. **Rejected as a gate** (S1) and redirected: a restart
is a per-step time-map, which is exactly what cue became (§13). The two
intents stayed separate rather than being collapsed into one knob.

**A random draw at each step boundary.** **Rejected** on purity: the RT
thread derives everything from the snapshot (I6), so a live draw would
break the "playback is a pure function of clock + state" law. The seed
as data gives the same musical result and makes a radio run
reproducible and exportable.

**Nested radios.** **Refused** (S12) with a log, and demoted to the loop
on load: a stochastic sequence has no period, so it cannot contribute to
a parent LCM. Reopening it would need the horizon total to serve as a
period — a different rule (tasks.md C3).
