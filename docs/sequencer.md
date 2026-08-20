# The Sequencer: a Fractal Sequence Primitive

> Written 2026-08-19 from the owner's ask (*"4 bars of just bass, drop
> in the drums…"*); revised the same day after the first ruling round
> and the owner's fractal reframe: *"we could make the sequencer an
> embedded part of stacks — any stack can declare a sequence, and then
> if you have a stack that contains that stack, that entire stack
> itself can be sequenced… the design of the radio / markov chains
> needs to tie into this as elegantly as possible."*
> Companions: kernel.md, design_language.md (I1–I9, Q1–Q17),
> time_maps.md.
>
> Status: **shipping** — every design question ruled (§0/§9); build
> step 1 (CORE: engine + mock + VM + grid UI, all three test layers)
> landed 2026-08-20 — see §10 and tasks.md Tier 4b. Step 2 (the step
> audition, record-into-a-step, TAKES UNDOABLE + the auto-gate, the
> frame-health badge, the window domain) BUILT 2026-08-20, same day —
> design §11, rulings S16–S19 + implementation record §11.10.

---

## 0. Ruling record (2026-08-19, first round)

- **S1 — Gate shape: RULED, mute-shaped.** Entrances keep the content
  phase (the track sounds where it would have been — I1's shape);
  launch-shaped restarts are a per-step time-map, i.e. **cue**
  semantics (§3), deferred.
- **S2 — Length unit: RULED.** Whole Qs, cycle-multiple snapping as
  the UI default. Owner: *"alignment with hardware looper makes sense
  as a default concept in general."* (This ruling turns out to carry
  §2's drifting-pass guardrail.)
- **S3 — End behavior: RULED.** Loops as a whole by default;
  play-once arrives later as an export/radio mode.
- **S4 — Verb composition: RULED, confirmed.** Manual mute ∧ gate
  (both must pass); solo per the Q16 canon over the gated population.
- **S5 — Recording under an active sequence: OPEN**, owner flagged as
  the key question — addressed in §4 with a proposed answer, awaiting
  ruling.
- **S6 — Vocabulary: RULED with amendment.** The feature is the
  **Sequencer** (owner: *"I conceptualize it kind of like a drum
  pad"*). Adopted here: the per-stack object is a **Sequence**, its
  entries are **Steps** — drum-machine words for a drum-pad concept.
  ("Arrangement/Section" retired.)
- **S7 — Transitions: RULED, and it's a law.** *"All transitions need
  to be smooth as much as possible"* — tails (echo/reverb) ring out
  when a track gates off; entrances/exits are quick fades, never hard
  cuts (speaker pops). §5 designs it; it also resolves the standing
  "effect tails on mute" question (tasks.md) — mute adopts the same
  mechanism.

---

## 1. The reframe: the Sequence lives on the stack

The first draft hung one Arrangement off the island root. The owner's
fractal instinct is better, and it is not a generalization bolted on —
it *dissolves* the hard problem the first draft had (Option B's
reference/aliasing question) and unifies four roadmap features into
one primitive.

**The Sequence** is a per-stack object, stored beside the stack's
time-map (the same atomic-pointer discipline as `map_override_`):

```
sequence = {
    state: none | active | bypassed,
    steps: [ { name?, lenQ, gates: { childId → on } }, ... ],
    successor: next | (weighted edges, later — §6)
}
```

- A step's `gates` speak only about the stack's **own children** —
  never across the tree. This is what kills Option B's aliasing
  problem: there are no references, because a sequence only ever
  gates the subtree it already owns. Scenes-of-scenes is not a new
  mechanism; it is *nesting*.
- Absent childId = **inherit on** — a track added after the sequence
  was written sounds everywhere until told otherwise (and a new take
  is audible while you jam along, §4).
- Gates are **fractal downward** (I5): gating a child group gates its
  subtree, exactly like mute.
- The island root IS a StackNode, so "the song" is just the root's
  sequence — no special island-level object exists. Depth 0 is not a
  special case; it is the fractal identity.

### The unification table

One primitive, five products — each row is a degenerate case of the
same object:

| Product | Sequence shape |
|---|---|
| **Today's jam** | the degenerate sequence: one step, `lenQ` = inner cycle, everyone on (or simply `state: none`) |
| **The song** (this ask) | N steps, overlapping gate sets, `successor: next`, loops (S3) |
| **The serial box** (Q6: 4Q box ⧺ 6Q box = 10Q) | N steps, ONE cued child each (§3) — Q6's concatenation IS a sequence |
| **The drum pad** | steps of 1Q over one-shot children — the step grid at its smallest scale |
| **The radio / branch-with-chance** | steps over cued song-stacks, stochastic successor (§6) |

The first draft's Option A survives as the root-sequence special
case; Option B arrives *through* this model instead of against it
(per-step overrides beyond gates — windows, takes, fx — remain the
additive future of the step format); Option C (perform-the-
arrangement capture) is unchanged: it writes a sequence through the
mute gestures the owner already performs.

---

## 2. The period law — "do sequences affect the LCM?"

**Yes — by exactly the precedent windows set.** The canon already has
the rule shape (time_maps.md phase 1 ext 2: *"an active window
contributes its window length to the island LCM"*):

> **An ACTIVE sequence sets the stack's effective period to the
> sequence length** (`Σ lenQ · Q`). The stack's *intrinsic* cycle
> (LCM of children) is unchanged and still governs everything inside;
> the parent composes its LCM from children's **effective** periods,
> as it already does (`getEffectivePeriod`).

Consequences, all falling out of existing machinery:

- A sequenced stack is, from outside, a clip of period seqLen (I5:
  the collapsed subtree obeys clip laws). An "album" stack that
  sequences song-stacks needs nothing new.
- `masterPos` wraps on the effective cycle (already true), so the
  playhead sweeps the whole song; `heard_cycle_at_arm_` snapshots
  seqLen, so take anchoring (Q14/Q15) speaks the sequence frame with
  zero new code.
- Bypass restores the intrinsic cycle — the jam — which is the I9
  degradation shape: nothing baked, round-trippable.
- Coprime sequence lengths can explode a parent frame, the same
  standing issue as coprime takes (tasks.md open question 5); the S2
  snapping default is the mitigation here too.

### The drifting pass (a real phenomenon, named)

Mute-shaped gates (S1) + a seqLen that is NOT a multiple of the inner
cycle ⇒ **successive passes of the song differ**. Example: inner
cycle 12Q (a 3Q and a 4Q loop), sequence 28Q. Pass 1 hears the 12Q
pattern at phases 0–28; pass 2 begins at phase 28 mod 12 = 4Q — the
same steps now frame *different bars* of the polyrhythm. Nothing is
wrong (every track is phase-honest, I1 holds), but the song is not
identical each time around.

- **The guardrail is S2 as ruled**: cycle-multiple snapping makes
  seqLen a multiple of the inner cycle by default ⇒ identical passes.
- **The escape hatch is deliberate**: un-snapped step lengths are the
  ⌥-free-drag of this feature (the "1.37Q ⚠" precedent) — a drifting
  song is a legitimate ambient/generative instrument, chosen on
  purpose, badged visibly.
- Cue-mode entrances (§3) also restore per-pass determinism, since a
  cued child restarts identically each visit.

---

## 3. Entrance semantics: gate and cue

Two ways a step can bring a child in. Both are needed eventually;
they are different musical intents, not competing designs:

- **Gate (ruled, S1 — the v1 default).** Audibility only. The child's
  phase derives from the clock as always; entrances land in-phase for
  free. Right for tracks inside a song.
- **Cue (deferred — the serial primitive).** The step re-bases the
  child's received frame to the step top: the child hears
  `t' = childEpoch + (t − stepStart)` — a per-step epoch re-base,
  which is to say **a time-map**, the exact object Q6's provisional
  ruling names (*"a serial group is a composite whose time-map routes
  each child a sub-range of the cycle"*). A cued child starts from
  its own top on every entrance. Right for chaining boxes (verse-box
  then chorus-box) and for the radio's song-after-song.

The step format carries `{on}` today and `{on, cue?}` later —
additive. Cue interacts with I1 the way any deliberate re-framing
does (I9): the child's *internal* coherence is untouched (its takes
align with each other); the box as a whole is being played like an
instrument.

---

## 4. Recording under an active sequence (S5 — proposed answer)

The question dissolves into two record modes, and neither needs a
refusal:

**Mode 1 — record over the song.** The transport is already running
the sequence; you jam along and hit record. The take anchors by
origin as always; the heard frame (`contextCycle`) is the sequence
period — which the existing arm snapshot already captures, because
seqLen IS the effective cycle (§2). A new empty track inherits ON in
every step, so you hear yourself everywhere while tracking. A take
longer than seqLen is the existing 5Q-over-4Q frame-growth story,
nothing new. **This mode is nearly free** — it is what the machinery
does if we simply don't refuse the arm.

**Mode 2 — record into a step** (*"record the guitar solo over the
breakdown"*). Select a step as the record target: the step's range
`[stepStart, stepEnd)` over the song timeline is **a one-segment
window**, and recording through it is **through-map recording —
already built** (time_maps.md phase 2): heard-time arm on the step
grid, one-period cap (take ≤ step length — musically exactly right
for a section part), dense commit. *(Ruled mechanism, 2026-08-19 via
S9 — the owner's own phrasing: "modify the loop region to only loop
over the chorus, then hit record." The step window IS a loop region
over the song timeline; see §9's composition law. "Record into a
step" is sugar for setting that window.)* Two extras ride the
commit:

- the take **auto-gates**: ON in the target step, OFF elsewhere (that
  was the intent of aiming at the step), one undoable edit with the
  take;
- looping-a-step-while-working doubles as the **section audition**
  affordance (play just the chorus while editing it) — the same
  window, activated without arming.

Proposed v1 scope: Mode 1 ships with the sequencer core (it is the
no-op path); Mode 2 ships second, on the through-map plumbing.

Open sub-questions folded into S5 for ruling: confirm the two modes;
confirm auto-gating on step-record; does Mode-2 arm quantize to the
step's own Q grid (proposal: yes — Q11 unchanged, the step is just
the context loop)?

---

## 5. Transitions (S7, ruled) — the smoothness law

Ruled: tails ring, edges fade, nothing pops. Design:

- **Gate placement is PRE-FX.** A gate silences the child's dry
  content *before* the node's effect chain, so echo/reverb keep
  processing and ring out naturally. This is also the answer to the
  standing "effect tails on mute" question — **mute moves to the same
  pre-fx gate**, one mechanism, one behavior (tasks.md item resolved
  by this ruling).
- **Two timescales of fade:**
  - the **anti-pop micro-fade** — a short equal-power ramp (~10 ms)
    on every gate/mute/solo edge, always on, not user-visible; the
    speaker-pop guarantee.
  - **musical fades** — per-step fade-in/out lengths ("fade the pads
    in over 1Q"), later, additive on the step format; step-boundary
    crossfades between cued children (the design.md "smoothing
    transitions" primitive) live here too.
- RT shape: one smoothed gain per node, target set by the gate
  resolve — allocation-free, the mixer already sums per-node.

---

## 6. The radio: successors, chance, and the seed

A sequence's steps advance by a **successor function**. v1:
`successor(i) = (i+1) mod N` — the loop (S3). The radio and
branch-with-chance are one generalization: **successor becomes a
small weighted graph over steps** (design.md's "branch-with-chance"
is an edge with p < 1; a plain song is the graph where every edge has
p = 1).

The purity problem, and the inspired answer: playback today is a pure
function of clock + state (I6; the RT thread derives everything from
the snapshot). A random draw at each boundary would break that. So
the randomness is **a seed, stored as data**: the step program is a
deterministic unroll of `(sequence, seed)` — every callback can
derive "which step at time t" purely, the UI projects the upcoming
path honestly, and a radio run is *reproducible*:

- **"I liked that run" = save the seed.** Re-roll = new seed (one
  verb). Export a radio session = render `(sequence, seed, length)`.
- The infinite radio (design.md mode 3) is then: a root stack whose
  children are cued song-stacks, stochastic successor, play-once off
  (S3) — *the catalog is the instrument, the seed is the performance.*

One honest limit: a stochastic sequence has no well-defined period,
so it cannot contribute to a parent LCM. Rule (proposed): stochastic
successors are legal only where no ancestor needs a period from the
node — in practice, the root. Nested radios inside songs are refused
with a log until someone needs them and we rule properly (the
nested-active-maps refusal precedent).

---

## 7. Implementation sketch (revised for the fractal model)

- **Storage**: `sequence` behind one atomic pointer per StackNode
  (the `map_override_` discipline); `Edit::Sequence` undoable with
  raw-state inverse; save format additive (`sequence` block, QTime
  lengths); templates may strip or carry it (rule with S8 round).
- **Engine**: step resolve per callback from snapshot + clock (prefix
  sums over lenQ — the Q16 solo-scan shape); gate test joins the
  mute/solo audibility resolve; pre-fx smoothed gain (§5);
  `getEffectivePeriod` returns seqLen when active (§2). Cue = a
  per-step epoch re-base in `childContext` (later).
- **Bridge** (3 places + mock twin): `setSequence(uuid, seq)`,
  `toggleSequence(uuid)`; step-record rides the existing record verbs
  plus a target-step argument (Mode 2).
- **VM/UI**: any stack lane can expand its **sequencer grid** (the
  fx-row expansion pattern): rows = children, columns = steps, cells
  = gates (lit/dim), step headers carry name + lenQ chip + bracket
  handles (whole-Q snap, cycle-multiple default per S2, ⌥ free with
  the ⚠ badge). Frame switches to the sequence period when active;
  lanes tile their existing rendering across steps with gated-off
  spans dimmed. Root sequence = the same grid on the root.
- **Tests**: C++ — gate resolve (fractal, ∧-mute, Q16-solo compose),
  in-phase entrance golden (I1), effective-period = seqLen + parent
  LCM compose, drifting-pass vector (28Q over 12Q — pin the honest
  phases), tails-ring + micro-fade (no discontinuity > ε at a gate
  edge); mock twins; e2e grid interactions. Golden vectors into
  `shared/timing_golden.json` per house style.

Suggested build order: (1) sequence storage + gate playback + period
law + root grid UI (the ask, shippable); (2) Mode-2 step recording +
section audition; (3) nested sequences surfaced in UI (engine gets
them for free); (4) cue steps (serial); (5) successor graphs + seed
(radio). Export unlocks at (1).

---

## 8. Open questions, round 2 (S8-series) — RULED same day, see §9

- **S8 — S5 ratification.** Confirm the two record modes (§4),
  auto-gating on step-record, and Q11-unchanged arm math.
- **S9 — Sequence × time-map on ONE node.** A stack with both an
  active window and an active sequence: compose (sequence over the
  mapped period) or refuse v1 (nested-maps precedent)? Proposal:
  refuse v1, revisit with a real use case.
- **S10 — The drifting pass.** Ratify: snapped-by-default (S2),
  free lengths permitted-and-badged as deliberate decoupling
  (Q2/⚠ precedent), never silent?
- **S11 — Cue steps.** Ratify §3's cue as the serial/Q6 mechanism
  (deferred implementation), so the step format reserves `cue` now?
- **S12 — Stochastic placement.** Ratify root-only stochastic
  successors for now (§6), and "the seed is data" (saved, re-rollable,
  exportable)?
- **S13 — Fade times.** Fixed ~10 ms anti-pop now, per-step musical
  fades later? Mute/solo adopt the micro-fade in the same change?
- **S14 — Templates.** Does "Save as template" carry a stack's
  sequence? (Proposal: yes — a song template is a real thing — with
  gates re-keyed to the rebuilt ids, which insertTrackTemplate
  already knows how to do for inputs.)
- **S15 — Sequencer grid ergonomics.** Live-commit streaming while
  dragging step brackets (the setSegments coalescing precedent)?
  Right-click/double-click grammar on cells (the cut-band grammar)?

---

## 9. Ruling record, round 2 (2026-08-19, same day)

- **S8 — RULED, go.** The two record modes + auto-gating + Q11
  arm math as proposed (§4). Owner: the record-over-the-chorus UX
  needs another specificity pass later; the general idea is sound.
- **S9 — RULED, and upgraded: sequences and loop regions COMPOSE.**
  The owner rejected refuse-v1 (*"we should be able to support
  sequencing and loop regions… modify the loop region to only loop
  over the chorus, then hit record"*) while worrying the two features
  fight. They don't — the worry dissolves into a composition law:

  > **THE COMPOSITION LAW.** Per node, fractal, fixed order:
  > `inner timeline → SEQUENCE → TIME-MAP → parent`. The sequence
  > gates children and sets the timeline's period (seqLen); an active
  > time-map's segments then select spans **of that post-sequence
  > timeline**. In time terms, walking down: the node maps received
  > time first (`m(t)` = a song position), looks up the step at that
  > position, and passes time + gates to children.

  With no sequence this degenerates to today exactly (the map selects
  spans of the intrinsic cycle). With one, "loop the chorus" is a
  one-segment window `[8Q, 16Q)` over the song — which is *precisely*
  Mode-2 record and the section-audition affordance (§4). The two
  features are not rivals; their composition IS the feature. Effective
  period becomes a chain of sources: map period if map active, else
  seqLen if sequence active, else intrinsic LCM.

  One honest subtlety → **S16 (open):** window coordinates authored
  over a sequence timeline lose their meaning if the sequence is
  bypassed. Proposal: the window records its domain
  (`sequence | intrinsic`); a domain-mismatched window auto-bypasses
  (never deletes — I9) and reactivates with the sequence. Rule when
  the mockup round makes it concrete.
- **S10 — RULED with a design correction and a guardrail order.**
  Snapped-by-default, badged free lengths ratified. The owner's worry
  (*"one part 11Q, one part 12Q and the song blows out to 25
  minutes"*) — locating it precisely: **within one sequence, steps
  CONCATENATE, they never LCM** — an 11Q step beside a 12Q step is a
  23Q song, harmless. The blowup risk lives at **sibling
  composition**: a sequenced stack of effective period 11Q beside a
  12Q loop makes the parent frame LCM(11,12) = 132Q. Which is the
  SAME standing risk as coprime takes (tasks.md open question 5) —
  so build ONE guardrail and wire it to both sources:

  > **FRAME-HEALTH BADGE (VM, pure projection):** whenever an edit
  > would make an ancestor's effective cycle exceed ~4× its largest
  > member's period, the responsible chrome (step handle badge, strip
  > header, take chip) shows an amber warning — "⚠ 11Q → parent
  > frame ×132 (25 min)" — with a one-click "snap to 12Q" offer. The
  > gentler **drifting-pass badge** (seqLen not a multiple of the
  > inner cycle, §2) is the second face of the same component.
- **S11 — RULED.** Cue reserved in the step format now; implementation
  deferred (§3).
- **S12 — RULED.** Root-only stochastic successors for now; the seed
  is data (saved, re-rollable, exportable) (§6).
- **S13 — RULED.** Fixed ~10 ms anti-pop now; mute/solo adopt it in
  the same change. **Per-step fade control is committed future work**
  (owner: *"I could definitely imagine wanting a part to fade out
  over a few seconds"*) — tracked in tasks.md; the step format keeps
  `fadeInQ`/`fadeOutQ` slots additive.
- **S14 — RULED.** Templates carry sequences, gates re-keyed to the
  rebuilt ids (the insertTrackTemplate input-rekey precedent).
- **S15 — RULED (2026-08-20, mockup round 1 → 2): the PAD GRID is the
  one control, at every depth.** Round 1 offered three placements
  (`docs/mockups/sequencer_ux.html`); owner chose B (the grid) and
  asked the decisive question — *"why would we have two ways of doing
  the same thing… are we just missing an explicit top-level stack?"*
  Answer: the root stack already exists (it owns the top rail), so
  the root's sequence hangs off its rail chip like any stack's —
  variant A was a redundant second control tangled with something
  that was never optional: **the lanes' song-frame rendering is the
  period law's display consequence** (frame = seqLen, gated-off spans
  dimmed, one playhead), a pure projection, not a control. Canon:
  - ONE edit surface: the grid, expanded from a stack's `seq · NQ`
    rail chip (the fx-row pattern). Rows = children, columns ∝ lenQ.
  - Step verbs live on column headers (cut-band grammar): grip
    resize (whole-Q, cycle-multiple default, ⌥ free + ⚠), dblclick
    rename, drag reorder, right-click merge/delete, ＋ appends,
    hover ⟲ loops the step (S9 window → audition / S17 record).
  - Pad verbs: click toggle, drag paint, row-name whole-row toggle.
  - Footer: totals ("seq · 28Q · 1:52"), bypass toggle, frame-health
    badge (only when warranted).
  - Lanes stay read-only for gates v1 (their span gestures are
    already dense: trim grips, cut bands, seams); a modifier-click
    toggle can ride later without moving the design.
  Round 2 mockup: `docs/mockups/sequencer_ux2.html` — the grid on the
  root, the lanes-as-display panel, the S17 record-into-a-step flow,
  and the fractal drum-pattern demo (Drums' own 1Q-step grid). Owner
  sign-off on round 2 = ready to build.
- **S17 (new, open) — Mode-2 record UX specificity.** Owner flagged
  §4 Mode 2 needs a concrete gesture spec (how you aim the record at
  the chorus: step context-verb vs. windowing first vs. both). Pair
  it with the S15 mockup round.

---

## 10. Implementation record (build step 1 — CORE, shipped 2026-08-20)

Tier 4b step 1 landed (see tasks.md for the file-level record). Facts a
later phase should know:

- **The gate envelope is PURE** (src/sequence.h): schedule-derived
  piecewise-linear gain, corners at step boundaries ± the 10 ms fade
  (+ step midpoints for short runs). The parent stack splits render
  blocks at envelope corners (forEachSeamRun grew a corner-distance
  term) and hands each child exact `(gate_g0, gate_g1)` endpoints in
  ProcessContext — output is block-split independent (pinned).
- **Mute/solo moved onto the same pre-fx gate** with a per-node
  smoothed ramp (seeds at first target: no phantom fade on load). The
  old semantics — mute as output-stage zero with frozen tails — are
  gone; C++ pins that toggled mute/solo mid-test now settle one fade
  block before asserting.
- **The mid-take gate** refuses setSequence/toggleSequence while a
  take is armed/recording in the subtree (the setSegments precedent).
- **Fractal, ROOT INCLUDED — model and UI**: engine, mock, and VM all
  handle a sequence on the session root, and the UI reaches it through
  a **transport-bar chip** (`seq`, beside the odometer — the root has
  no rail); its grid opens as the FIRST row, over the top-level
  tracks. Shipped same day as the core after the owner's field report
  (two loose clips, no group, no affordance anywhere — the primary
  ask must never require knowing to group first). Groups keep their
  own rail chips (fractal). The chip hides until Q is established.
- **Step 2 next** (record into a step): the through-map machinery is
  untouched and ready; the step window is a one-segment map over the
  song timeline per the S9 composition law. S16 (window domain
  tagging) and S17 (the record gesture) gate it.
- **Frame-health badge (S10)** is not built yet — free step lengths
  are accepted engine-side and the UI snaps to cycle multiples
  (⌥ = whole Q), but nothing warns about sibling-LCM blowups yet.

---

## 11. Build step 2 — record into a step + the frame-health badge (design, 2026-08-20)

> Status: **RULED and BUILT 2026-08-20** (owner rulings the same day:
> S18 = (a) everywhere, *"we should not be in the business of inserting
> silence"*; S19 = takes ARE undoable — *"it's weird they aren't"* — so
> the auto-gate composes into the take's one undo step; S16/S17 as
> proposed). Scope = §4 Mode 2 + the section audition + the S10 badge
> + the "+ step" default. Written against the shipped core (§10) after
> reading the through-map path it rides on (`audio_engine.cc`
> startRecordingInNode, `clip_node.cc` through-map arm/commit,
> `stack_node.cc` childContext). §11.10 is the implementation record;
> where the built thing differs from the proposal below, §11.10 wins.

### 11.1 What already exists (so what step 2 is NOT)

The S9 composition law is in code: a stack's map wins
`getEffectivePeriod`, `childContext` maps received time first and the
gate lookup (`seq_rel0`) runs on the MAPPED clock — a window on a
sequenced stack already selects spans of the song timeline. Through-map
recording (phase 2) already arms on the map grid, caps at one map
period, and commits dense. So "record into a step" needs **no new
record machinery** — it needs (a) a way to aim a window at a step, (b)
the right commit cycle for that window, (c) the auto-gate at commit,
and (d) the projection (lanes, ruler, playhead) to follow.

### 11.2 The step audition = a DERIVED window (S17 mechanism)

`StackNode::audition_step_` (atomic int, −1 = none) — a **monitoring
gesture**, the solo/`midi_armed` class: not undoable, not persisted,
cleared by Esc, by a second ⟲, by deleting the step, and by bypassing
or clearing the sequence.

`activeTimeMap()` on StackNode is overridden: while `audition_step_ ≥ 0`
and the sequence is active, the node's map IS
`TimeMap::single(bounds[i], bounds[i+1])` — derived from the sequence,
overriding (not replacing) any authored window for the duration. Every
consumer (period law, childContext, arm math, cursor honesty,
`windowActive` metadata) sees an ordinary one-segment map, so nothing
downstream learns a new concept. Precedence while auditioning:
audition > authored window > none; Esc restores exactly what was
there (I9).

Why derived instead of "⟲ writes loop points": the window can never
desynchronise from the step it names (resize the step while looping
it and the loop follows), it cannot outlive the sequence (bypass the
sequence and the audition simply vanishes — S16's problem does not
even arise for this window), and it leaves the user's authored window
untouched underneath.

Bridge (3 places + mock): `auditionStep(uuid, index | −1)`. Metadata:
`auditionStep` on the stack (−1 when none) so the grid header can show
"⟲ looping" and the lanes can draw the brackets; `windowActive` /
`loopStart` / `loopEnd` publish the derived window like any other.

### 11.3 The gesture (S17 — as mocked in round 2, made exact)

- Hover a column header → ⟲ appears; click = loop that step (the song
  folds to it: playhead, ruler, every lane wrap the step — the cyan
  bracket pair on group lanes; on the ROOT, which has no lane, the
  ruler shows the bracketed span and the step header reads
  "⟲ looping · 16Q–20Q"). Click ⟲ again or press **Esc** = stop looping.
  Clicking ⟲ on another step moves the loop.
- While looping you are **auditioning**; nothing is armed. This is the
  section-audition affordance in full.
- `R` (or ●) on a lane arms it exactly as today. The engine sees an
  active map on the auditioning ancestor → through-map arm on the
  step's grid (Q11 unchanged — the step is the context loop), take
  capped at the step length (phase-2 ruling 2), stop/finish as today.
- At commit the take **auto-gates** (11.5) and the audition **stays
  on** (you typically want to hear the part in place, then Esc out).
  Owner-ruled in S8; confirmed here.
- Recording with no audition = Mode 1 (record over the song),
  unchanged.

Refusals (all logged, none silent): arming while the audition stack
has a *second* active map beneath it (the nested-active-maps refusal,
unchanged); setSequence while a take is live (existing mid-take gate);
editing the auditioned step's length while a take is live (the
mid-take map-edit refusal, inherited because the window IS the step).

### 11.4 The commit cycle — **S18 (needs a ruling)**

`startRecordingInNode` computes `C = max(mapping->getIntrinsicDuration(),
period)` — the mapping node's INTRINSIC cycle. Under a sequence that is
the wrong timeline (S9: the map selects spans of the POST-sequence
timeline), and two honest choices remain:

- **(a) C = the step (the map period).** The take is *a step-sized
  part*: a 4Q solo recorded into a 4Q breakdown commits as a 4Q clip
  with origin at the step top; the gate keeps it silent elsewhere
  while the sequence is active; bypass the sequence and the solo
  loops every 4Q in the jam like any 4Q part. Intrinsic cycle
  unchanged (lcm with 4Q); the **"+ step" unit stays the jam cycle**.
  Phase-correct on every song pass iff stepLen divides seqLen — and
  when it doesn't, that is precisely the drifting-pass condition the
  badge (11.6) already flags (the new take's period enters the
  intrinsic cycle, seqLen stops being a multiple of it).
- **(b) C = seqLen (the song).** The phase-2 rule applied to the S9
  timeline: the take is a *song-length clip* dense with silence
  outside the step. Always phase-correct; but the stack's intrinsic
  cycle becomes the song, bypass no longer returns the jam (a 28Q
  mostly-silent clip now loops in it), and the "+ step" unit — ruled
  "one intrinsic cycle" — becomes the whole song after the first
  step-take (the 2026-08-20b doubling bug back through a side door).

**Proposal: (a) for the step audition; (b) for a MANUAL window
authored over the song** (a region that need not be a whole step is
"a piece of the song", and the phase-2 rule is right for it:
`C = max(seqLen, period)` when the mapping node's sequence is active).
One line in startRecordingInNode decides by `audition_step_ ≥ 0`.

### 11.5 Auto-gate at commit — **S19 (S8 ruled the what; the how needs a nod)**

Takes are not undo entries (commit is an audio-thread event), so
"undo removes take + gates as one edit" (mockup round 2) is not
available without a takes-undo feature. Honest v1:

- At arm (message thread), the engine records a **pending auto-gate**
  `{clipUuid, stackUuid, stepIndex}` per target whose auditioning
  ancestor is the *direct parent* of the clip.
- The message thread observes commit (the compaction heartbeat
  already watches for Idle-with-content) and applies ONE
  `Edit::Sequence` on the stack: the clip's gate row := ON in
  `stepIndex`, OFF elsewhere (row created — an inheriting row becomes
  explicit). Cancelled takes drop the pending entry. Group arms (Q7)
  yield one Edit::Sequence carrying all rows.
- **Undo = un-gate** (the take stays, inheriting ON everywhere);
  **delete the take** is the existing undoable `deleteNode`. Two
  verbs, both honest; the composite undo arrives with takes-as-edits
  if that feature ever lands.
- Deeper takes (audition on the root, record Kick inside Drums): NOT
  auto-gated — gating the Drums row would silence the whole kit in
  every other section. The take lands inheriting ON; a one-line log
  + the lane's "recorded through breakdown" chip says so. Rule
  candidates for later: gate at the nearest sequenced ancestor of the
  clip if *it* is the auditioning stack (the fractal case — Drums'
  own grid looping its step 3).

### 11.6 The frame-health badge (S10 spec — VM-pure, two faces)

One component, `frame_health.js` (pure functions over the graph state,
unit-tested), projected into existing chrome:

- **Blowup face.** For every stack (root included): `cycle =
  lcm(children's effective periods)`, `largest = max member period`.
  Warn when `cycle > 4 × largest`. **Attribution**: the responsible
  child is the one whose removal shrinks the cycle the most
  (`lcm(all \ child)`); the **offer** is the nearest length for that
  child that divides — or is a multiple of — `lcm(all \ child)`, i.e.
  "snap to 12Q". Offers apply only to things that have a length knob:
  a sequenced stack (its last step absorbs the delta — the append
  unit in reverse) or a windowed node (window length). A TAKE has no
  knob: badge only, no offer. Shown on: the responsible child's rail
  chip (`seq · 11Q` turns amber, tooltip "⚠ parent frame ×132 · 25:04"),
  the grid footer of that stack ("⚠ 11Q → parent ×132 (25 min) ·
  snap to 12Q" as a one-click button), and while dragging a step grip
  the live readout gains the ⚠ as soon as the provisional length would
  trip it.
- **Drifting face.** For a sequenced stack: `seqLen mod innerCycle ≠ 0`
  (innerCycle = lcm of its children's effective periods, one-shots
  excluded). Footer: "↯ drifting · 28Q over 12Q · snap to 24Q / 36Q"
  (the two nearest multiples, both one-click: the delta goes to the
  last step). The rail chip gets a small ↯. Never blocks, never
  silent (S10 as ruled).
- Thresholds are constants in one place (`kBlowupRatio = 4`); the
  minutes figure uses the island's `Q_samples` and sample rate.

### 11.7 "+ step" default = one intrinsic cycle (ruled) — the interactions

The append unit is the stack's **inner cycle**: lcm of its children's
EFFECTIVE periods (a child that is itself a sequenced stack counts as
its seqLen; a windowed child as its window), captured before the
stack's own sequence re-frames anything (the 2026-08-20b fix). What
that means in practice, since a sequence *does* affect the LCM:

- Editing a child's sequence (Drums goes 4Q → 6Q) changes the parent's
  inner cycle; the parent's existing steps keep their lengths — the
  parent may now be drifting (28 mod 12 ≠ 0) and the ↯ face says so,
  with the snap offer. Nothing retroactive, nothing silent.
- A free-length child sequence (11Q) makes the parent's unit 44Q or
  132Q. The unit is honest; the ⚠ face fires at the child's chip and
  grip before the parent ever appends.
- S18(a) keeps step-takes from changing the unit; S18(b) would not.
- Empty stack / no Q: no chip (unchanged).

### 11.8 S16 — window domain (needs a ruling; small)

Only MANUAL windows on sequenced stacks need it (the audition is
derived, 11.2). Proposal: `window_domain_` ∈ {intrinsic, sequence} on
StackNode, set by `setLoopPoints`/`setSegments` from whether the
sequence was active at authoring time, persisted additively
(`windowDomain`), carried by Edit::LoopPoints/Segments for undo. Rule:
a `sequence`-domain window is **suspended** (activeTimeMap() → none,
`windowActive:false`, `windowSuspended:true` in metadata) while the
sequence is bypassed/cleared, and returns when it is reactivated —
never deleted (I9). The lane shows suspended brackets dimmed with a
"window · suspended (sequence off)" chip. Clips have no sequence, so
nothing changes for them.

### 11.9 Tests (per house style)

C++ `sequencer_tests.cc` (new sections): audition map equals the step's
span and follows a resize; precedence + restore over an authored
window; through-map arm on the step grid + one-step cap; S18 commit
cycle per branch; auto-gate edit applied once on commit, dropped on
cancel, undo un-gates; deeper take not gated; domain suspend/restore
round trip incl. session load. JS: `frame_health.test.mjs` (both
faces, attribution, offers — golden vectors into
`shared/timing_golden.json`: the 11/12 → 132 case, the 28-over-12
drift, the 4× threshold edge), mock twins for auditionStep + auto-gate
+ domain. e2e: ⟲ → lanes wrap → R → record → take lands gated → Esc;
root variant; badge appears on an 11Q step and the snap offer clears
it.

Build order inside step 2: (1) audition + projection (engine, mock,
VM, UI — shippable: section audition alone is a feature); (2) S18
commit cycle + auto-gate; (3) badge; (4) S16 domain.

### 11.10 Implementation record (built 2026-08-20, all three layers green)

What landed, and the three things building it taught:

- **S18 ruled (a) everywhere** — no (b): a manual window on a
  sequenced stack behaves like the audition (`C = map period` whenever
  the mapping node has an active sequence; `startRecordingInNode`).
  No silence is ever inserted by a sequence.
- **The audition is exactly §11.2**: `StackNode::audition_step_`;
  `AudioNode::activeTimeMap()` / `isLoopWindowActive()` became
  VIRTUAL so StackNode can answer with the derived map (and, for S16,
  with *none* while suspended). `AudioEngine::auditionStep(uuid, step)`
  refuses mid-take and out-of-range; a step-COUNT change (delete)
  clears the audition, a resize keeps it — decided inside the
  Sequence edit applier so undo/redo agree. Metadata:
  `sequence.auditionStep`, and the derived window over
  `loopStart/loopEnd/windowActive` (root included — the VM reads the
  root's top-level fields into `vm.rootWindow`; the ruler draws the
  brackets; the frame stays the SONG and the cursor is mapped into the
  step, the sole-top-level-window pattern). Group lanes under an
  audition HIDE their brackets (intrinsic-frame lanes cannot draw
  song coordinates); the grid header and the rail chip carry the
  state. Esc clears it through `onEscapeAudition` (app.js remembers
  the looping owner).
- **THE SONG RIDES THE EPOCH** (found by the first S18 test): the
  commit re-base moved the epoch by whole *old intrinsic cycles*, and
  a 4Q part recorded into an 8Q song shifted the epoch by 4Q — the
  chorus became the intro. `StackNode::takeCommitted` (and the mock)
  now lcm the active sequence length into BOTH sides of the growth
  comparison: re-bases happen in whole songs or not at all.
- **TAKES ARE UNDOABLE** (S19, the owner's call): `Edit::Kind::Take /
  Untake` with `Edit::TakePayload` (content moved, never copied;
  retired through the reclaimer like every displaced buffer);
  `ClipNode::stripTake()` / `restoreTake()`. Commit is an audio-thread
  event, so the engine registers a **PendingTake** at arm (uuids, the
  pre-take Q/epoch, and the auto-gate target) and `reconcileTakes()`
  logs it — at the top of every `getGraphState` poll and before any
  log operation — once every member has settled; a Q7 group take is
  ONE entry; a cancelled performance logs nothing. Undo/redo of a take
  entry is REFUSED (entry kept) while a take is live. The first take's
  Q/epoch establishment and any growth re-base ride `setsIsland`.
  Untake deliberately does NOT uncollapse a Q13 definer — the
  `CollapseTake` entry beneath it does (the log reads CollapseTake,
  Take; `qtime_lock_tests` now undoes twice). Mock: the snapshot is
  taken AFTER the Q13 collapse and BEFORE arming, pushed at commit.
- **The auto-gate composes**: `applyAutoGate` folds one
  `Edit::Sequence` into the take's Untake entry (the `seq` rider), so
  ⌘Z removes take + gates together, as the mockup promised. Direct
  children of the auditioning stack only; a deeper take lands ungated
  with a log line.
- **The badge** is `ui/js/frame_health.js` (pure; golden vectors
  `frame_health_cases` in `shared/timing_golden.json`). One correction
  to §11.6: attribution prefers a member WITH a length knob whose
  removal would make the scope healthy, then the largest shrink — for
  two coprime members the raw "largest shrink" blamed the loop, not
  the song. Note the threshold is strict: coprime p beside q has ratio
  min(p, q), so 7Q beside 4Q (28Q, exactly 4×) is healthy and 7Q
  beside 5Q (35Q) warns. Shown on: the responsible lane's period chip
  (amber, tooltip), the grid footer (badge + one-click "snap to NQ",
  delta on the last step, one undoable setSequence), the grip's live
  readout (⚠ / ↯ while dragging), and the seq chips (↯ for drift).
- **S16** is `StackNode::window_domain_` stamped by the LoopPoints /
  Segments appliers (`Edit::window_domain`, inverses restore the old
  stamp), suspended = sequence-domain ∧ sequence off ∧ a valid window
  (`activeTimeMap()` → none, metadata `windowDomain` /
  `windowSuspended`), persisted additively, dashed dim brackets +
  "window · suspended (sequence off)" chip.
- Tests: `sequencer_tests.cc` (audition ×3 incl. the full-callback
  S18 + epoch check, S16 ×2), `tests/take_undo_tests.cc` (6 sections),
  `ui/js/tests/audition.test.mjs`, `take_undo.test.mjs`,
  `frame_health.test.mjs`, e2e `sequencer.spec.js` ("STEP AUDITION":
  ⟲ → R → auto-gate → Ctrl+Z / Ctrl+Shift+Z → Esc; "FRAME-HEALTH
  BADGE": drift + snap). Suites after: C++ 284 sections green (sandbox;
  stereo_pan env-excluded as ever), JS units 32 files, Playwright
  58/58 twice.
- Deferred: an undone take leaves its mirrored .wav in the project
  folder (the already-open orphan-pruning item); the mock's undo
  snapshots carry `auditionStep` on stacks (monitoring state the
  engine's log never touches) — harmless, noted.

---

## Appendix: the first-draft options (history)

The 2026-08-19 first draft pitched three options: **A** — one
arrangement at the island root (gate schedule); **B** — sections as
scene nodes on a serial time-map (blocked on reference/aliasing
semantics); **C** — perform-the-arrangement capture. The fractal
reframe replaced A's root-level object with the per-stack Sequence
(root sequence ≡ A), dissolved B's aliasing problem (sequences gate
only their own children; nesting replaces cross-references; per-step
overrides stay the additive future), and left C intact as a capture
verb writing sequence data. Kept per the design_alternatives.md
tradition: options considered, and why the survivor won.
