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
> landed 2026-08-20 — see §10 and tasks.md Tier 4b. Next: step 2
> (record into a step), gated on S16/S17.

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
