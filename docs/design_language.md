# Celestrian Design Language

> Written 2026-07-07 from a full pass over `docs/`; adopted as canon
> through owner review (§5 records the rulings, Q1–Q17, with dates and
> quotes, and indexes the rulings recorded in other docs). Vocabulary,
> numbered invariants (I1–I9), worked examples in the house style, and
> the question record. Companion: `kernel.md`.
>
> Status: **spec** — the invariants are binding; violations are bugs
> (several have been found and fixed by citing them).

---

## 1. The Vocabulary

Every term below appears in the existing docs, but several are defined in
two or three places with drift. These are proposed as the canonical
one-line definitions.

| Term | Definition |
|---|---|
| **Quantum (Q)** | The atomic musical duration of an island, in samples. Established by the first committed take; the grid everything snaps to. "One bar." |
| **Island** | The scope within which Q is shared. One island = one song = one time grid. Distinct islands are musically unrelated universes on the same canvas. |
| **Origin** | The monotonic-clock moment a node's inner time 0 belongs to: for a clip, the performance-time at which `content[0]` occurred; for a stack, the zero of its inner timeline (Q18, composition.md). Stored once per node, never derived; launch point and lane x are projections of it. |
| **Performance time** | The frame the musician lives in: what they *heard*. Input arriving at master time `t` was performed at `t − C` (C = calibrated round trip). All musical positions are performance-time. |
| **Arrival time** | When audio physically reaches the input. Never a musical position; only capture plumbing (the pre-record ring) thinks in arrival time. |
| **Context loop** | The loop the performer was listening to when they hit record: the longest committed sibling (min Q). Determines how their intent wraps. |
| **Cycle (LCM)** | The period after which *every* member of a scope returns to phase 0 simultaneously: LCM of member periods. **A derived legibility device, not a modeling principle** — it exists to make I1 visible, never to constrain it (owner ruling, Q2). |
| **Launch point** | Derived: the playback offset that makes a clip honor its origin. `launch = (−origin) mod period`. |
| **Ghost** | The visual unrolling of a loop across the cycle: its AUDIBLE repetitions, drawn in the cool **echo tone** (Q14c: warm hues are reserved for material — the take tile, the live bar, the composite). For a windowed clip, ghosts echo the WINDOW segment (what sounds), never raw take material. Whole cycle-counts fold away; the performed phase is kept (Q14). |
| **Heard frame (`contextCycle`)** | The EFFECTIVE island cycle a take was performed against (E-C: active windows shorten it), recorded per take at capture start. The modulus that folds "which cycle" out of a take's display anchor (Q14) and the audible-equivalence step for the origin fold (Q15) — it makes take marks stable across frame growth and epoch re-bases. |
| **Echo** | A ghost tile's rendering: the audible repetition of a take (or of its window segment), in the echo tone. Full-take echoes are quiet (they duplicate the adjacent bright take); window echoes are more present (they are the only visible representation of what sounds there). |
| **One-shot** | A clip that sounds once per context cycle instead of looping at its own length. *(See Q5 — the current formula in design.md/recording.md is garbled.)* |
| **Composite** | A stack seen from outside: a virtual clip whose content is the sum of its children and whose period is their LCM. |
| **Loop window** | A `[start, end)` restriction on a node's cycle — a one-segment time-map. Active iff valid and not bypassed; independent of view state (time_maps.md, implemented 2026-07-09). |
| **Time-map** | THE mechanism that transforms time: an ordered segment list over a node's inner timeline, anchored at the node's own origin: `inner(t) = mapOffset((t − origin − a0) mod period)` (composition.md §2; the epoch-anchored stack form was retired by Q18). Loop windows, non-contiguous selections, and (future) warp and serial connections are all instances (time_maps.md). |
| **Hysteresis snap** | Gesture quantization with tolerance. ARM: the target is always the next Q boundary in the HEARD (latency-compensated, epoch-relative) frame — so ANY click before a boundary means that boundary; the old 25%-window deferral mechanism was deleted 2026-07-16 (it overshot by a full Q when compensation was small — Q14). STOP — **owner ruling 2026-07-10: always forward** — a stop request records on to the NEXT boundary (`nextStopBoundary`, computed by the audio thread; the UI shows "finishing…" via `isAwaitingStop`). The snap-BACK idea ("I hit stop a bit late" → keep the whole take, auto-add a loop window ending at the previous boundary) is deliberately deferred: *"too complicated — keep it simple for now; the user can post-hoc fix it by moving the boundary. Explore later if I hit it in practice."* |
| **Fractality** | The law that any subtree, collapsed, obeys exactly the laws of a clip. If a rule doesn't hold recursively, it isn't a rule yet. |

Convention proposal: **samples are the only engine unit; Q is the only
musical unit; pixels are the only UI unit** — and any statement in a doc
must name its unit. Most historical confusion in these docs (and two of
this week's field bugs) came from unlabeled frame mixing.

---

## 2. The Invariants

The docs contain these implicitly; stated here as numbered laws so tests,
code review, and future docs can cite them. Each should be executable —
several already are.

- **I1 — Audio Memory.** Recorded audio plays back aligned with what the
  performer heard while recording. The performer's timing is relative to
  what they heard; that relationship is preserved by default and broken
  only by explicit edits. *(Tested: `pre_record_tests.cc` — "note played
  on the heard beat lands at clip position 0".)*
  **Owner ruling (2026-07-07): I1 is THE prime invariant — every other
  timing rule (LCM, snapping, ghosts) is downstream machinery in service
  of it or of making it visually legible. The only sanctioned break is
  deliberate decoupling: dragging clips, editing launch points, or
  changing loop windows is the user *intentionally* detaching a
  performance from its recorded context.**
- **I2 — Simultaneity.** Two sounds that play simultaneously must draw at
  the same x, and vice versa. *(The 2026-07-07 waveform-scale bug was an
  I2 violation; no invariant test exists yet — it should.)*
- **I3 — Cycle Reset.** At any time `t` with `t ≡ epoch (mod LCM)`, every
  member of the scope is at phase 0. No member ever "jumps ahead."
- **I4 — Commit Stability.** Committing a take never audibly or visually
  moves any *other* clip. Ghost extents may grow; nothing shifts.
- **I5 — Fractality.** Every behavior specified for a clip must be
  specified (and equal) for a collapsed composite. A feature that only
  works at depth 0 is unfinished. *(Made true by construction for time
  by Q18: every node has an origin — composition.md. The list continues
  there as I10–I16.)*
- **I6 — Pure Projection.** Every pixel is a pure function of engine
  state. The UI holds no timing state of its own; identical state ⇒
  identical pixels. *(This is the precise form of "UI = Data" — the
  original phrasing conflicts with ui.md's pixels-belong-to-the-frontend
  rule; "UI = f(Data), f pure and shared" resolves it.)*
  **Owner ruling (2026-07-07) — corollary I6b, View Purity: view actions
  never change sound. Expanding or collapsing a stack is display-only.
  ✅ Enforced since 2026-07-09: the old Loop-on-Collapse model was
  replaced by time-map loop windows (time_maps.md phase 1); a unit test
  asserts expanded/collapsed output is sample-identical.**
- **I7 — Empirical Time.** Latency constants are measured on the user's
  hardware, never assumed from driver reports. *(Implemented:
  calibration + persistence, performance.md §7.)*
- **I8 — One Clock.** There is exactly one time authority per island.
  Any second counter (UI-side playhead math, internal transports,
  wrapped copies) must be derivable from it. *(Aspirational — see Q8.)*
- **I9 — The Degradation Contract** *(owner-ratified 2026-07-09)*. When
  an edit deliberately decouples a performance from its context (the
  sanctioned I1 exception), the design owes **predictable,
  non-destructive, reversible degradation** — never coherence, which no
  design can deliver, and never baked-in changes. Undoing the edit must
  restore full coherence. This is why rotation became virtual, why
  origins are stored rather than applied, and why through-map takes
  live in inner time (time_maps.md §3).

---

## 3. Worked Examples (new, in the house style)

The canonical examples live in recording.md (§Examples). These six extend
the set to cover principles the current examples skip. **Proposed
convention: every example carries a state table** — schematics drift
during refactors; tables pin exact expectations and convert directly into
golden vectors (`shared/timing_golden.json`).

Q = 1000 samples throughout.

### E-A. The Pickup (anticipatory start)

User hits record at 3.9Q while a 4Q context loops — 0.1Q before the
boundary, so intent = "the upcoming 1". *(Mechanism note, 2026-07-16:
no special window delivers this — the arm target is simply the next
boundary in the heard, latency-compensated frame, which any click
before a boundary already resolves to. The values below are unchanged.)*

```
Timeline:   |--Q--|--Q--|--Q--|--Q--|
Context:    [████████████████████████]   (4Q)
            record pressed ↑ 3.9Q
New clip:   [████████ ... starts at 4Q ≡ 0 (mod 4Q)
```

| clip | origin | period | launch | x |
|---|---|---|---|---|
| context | 0 | 4000 | 0 | 0 |
| new | 4000 (≡0 mod cycle) | 4000 | 0 | 0 |

Exercises: PLL tolerance, wrap-at-boundary intent ("record near the END
of the loop means you mean the top" — recording.md's loop-relative anchor
rationale, previously prose-only).

### E-B. Nested Polyrhythm (composite duration)

```
Outer stack (cycle = LCM(4Q, 6Q) = 12Q):
Clip A:      [████ 4Q ████][░░░ ghost ░░░][░░░ ghost ░░░]        ×3 = 12Q
Inner stack: [██████ 6Q composite ██████][░░░░░ ghost ░░░░░]      ×2 = 12Q
  (expanded: Clip B 2Q ×3, Clip C 3Q ×2 inside each 6Q)
```

| node | origin | period | contributes to parent |
|---|---|---|---|
| Clip A | 0 | 4000 | 4000 |
| Inner stack | 0 | 6000 (LCM 2Q,3Q) | 6000 |
| Outer cycle | — | **12000** | — |

Exercises: I5 (the inner stack IS a 6Q clip from outside), composite
duration = LCM-of-children (the rule `getIntrinsicDuration` currently
gets wrong — refactoring_proposal.md P0-3).

### E-C. Loop Window on a Composite (loop-on-collapse)

Same stack as E-B, collapsed, window `[2Q, 4Q)`:

```
Windowed:   ▒▒▒▒[░░ active 2Q ░░]▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
                 ↑2Q        ↑4Q       (dim = outside window)
Playhead cycles 2Q → 4Q → 2Q ...
Children hear: child_t = epoch + 2Q + ((t − epoch) mod 2Q)
               (frame preserved — see time_maps.md §2 warning)
```

Exercises: loop windows change *period* (a windowed composite behaves as
a 2Q clip in its parent's LCM!), and the window-epoch time-map.
✅ **Implemented per Q4's ruling (2026-07-09)**: activation is an
explicit active/bypassed state (⟳ toggle), independent of collapse;
phase is `(t − cycle_epoch) mod len` with the window re-basing the epoch
for its children (time_maps.md phase 1). Note the consequence: an
active window changes the parent cycle from 12Q to LCM(4Q, 2Q) = 4Q —
by data, never by view.

### E-D. One-Shot Growing into a Loop (progressive disclosure)

Recording from 3Q in a 4Q context:

```
t=3.0Q..3.8Q:  [┄┄ dashed: one-shot ┄┄]      period = context cycle (4Q)
t=4.2Q:        [████ solid: loop ████...]    period = own length
```

Exercises: the one-shot/loop distinction is a **period choice**, not an
intrinsic clip type — a one-shot is content shorter than its period. This
reframing fixes the garbled formula (Q5) and makes "convert one-shot ↔
loop" a togglable property rather than emergent behavior.

### E-E. The Clap (performance vs arrival frames)

The example the docs lacked until this week's latency work:

```
performance:  ──────B──────────────────       B = heard downbeat
arrival:      ────────────B+C────────────     clap reaches input C later
capture:      clip[0] ← input(B + C)          (arrival-time window)
playback:     clip[0] sounds at t ≡ B (mod)   → I1 holds
```

| quantity | value |
|---|---|
| C (calibrated) | 6679 samples @48k ≈ 139 ms |
| clip origin | B |
| capture window start (arrival) | B + C |

Exercises: I1, I7, and the performance/arrival frame split. Should be
folded into recording.md, which still describes capture as "starts
immediately" — pre-dating the arrival-time model.

### E-F. Two Islands

```
Island 1 (Q=1000):   Stack A  [████][░░░░]...     cursor α
Island 2 (Q=1700):   Stack B  [██████][░░░░░░]... cursor β  (unrelated)
```

No shared cursor, no shared cycle, no implied relationship. Exercises:
island scoping — and deliberately poses Q10's question: what does the
global play button even mean here?

---

## 4. Precision Defects in the Current Docs

Found during the 2026-07-07 pass; statuses updated 2026-07-09:

1. ~~The one-shot formula is garbled~~ — ✅ fixed: owner ratified the
   period-source definition (Q5); design.md §6 and recording.md §Clip
   Types now carry it.
2. ~~recording.md Example 2/3 collision~~ — ✅ fixed: Example 3 has its
   heading back.
3. ~~Rotation language is stale~~ — ✅ overtaken by events: rotation was
   deleted entirely (origin model); all rotation prose replaced.
4. ~~design.md numbering~~ — ✅ fixed: sections sequential.
5. **Islands are specified in triplicate** — still open: recording.md
   (inheritance rules, the most complete), implementation.md §8
   (membership rules), design.md §8 (inherit/new-song). recording.md's
   §Islands should be the canonical home; the others should shrink to
   pointers. Low urgency until multi-island work starts (Q10: one active
   island for now).
6. ~~nesting.md is a fossilized status journal~~ — ✅ fixed 2026-07-09:
   surviving content (per-stack LCM) folded into stacks.md; file deleted.
7. ~~test_harness.md stale references~~ — ✅ fixed 2026-07-09: rewritten
   with the current harness and the stale-binary gotcha.
8. ~~Doc-type headers~~ — ✅ adopted 2026-07-09: statuses in each doc and
   the docs/README.md index.

---

## 5. Provocative Questions

First review round: 2026-07-07 (owner answered Q1, Q2, Q4, Q7, Q8, Q9;
Q3, Q5, Q6, Q10 not yet reviewed).

### Rulings recorded elsewhere (index, 2026-09-01)

§5 is the ruling INDEX (docs/README.md ground rules): a ruling may live
in the doc that owns its feature, but each has a pointer here.

- **Q18 — every node has an origin** (2026-09-01): composition.md §0.
  Stacks store an origin (the moment their inner time 0 belongs to);
  one anchoring law for every node (`inner(t) = mapOffset((t − origin −
  a0) mod P)`); re-anchoring a node re-anchors its subtree; a stack can
  be a one-shot. Owner: *"I agree, groups should be able to be
  anchored. I could imagine recording drums (a group of 5 clips) as a
  one-shot for example."* Deletes the epoch-anchored stack law, the
  origin riders, `epochViewStep`, and the definer-stack twins of the
  Q13 paths (composition.md §8). Invariants I10–I16 are numbered there.

- **S1–S22 — the Sequencer** (2026-08-19 → 08-27): sequencer.md §0
  (S1–S7), §9 (S8–S15; S17 opened), §11 (S16–S19, implementation
  record §11.10), §13 (S20–S22 cue steps). §2 is the period /
  composition law: effective period = window ▸ active sequence ▸
  children's effective LCM.
- **Q-V1–V5 — VST3 hosting** (2026-08-15): vst3.md §9 (promote at
  first VST3 slot; no PDC for now; MidiClipNode → content kind; QTime
  notes in the save format; tests link the hosting code).
- **Map coherence is categorical** (2026-08-09): engine_lcm_guard.md —
  every map/window period is a whole multiple or exact divisor of Q,
  refused on both sides; free-length cuts abolished; the Q13 definer
  re-trim (clip or stack) is the sole exception.
- **Projects model** (2026-07-19f–j): projects.md — birth at first
  committed take, continuous mirror, per-track record (2026-07-19h),
  post-hoc groups by drag; the launch ritual is superseded by Q17.
- **Display laws 13 / 14** (2026-08-21 / 2026-08-27): ui_overhaul.md
  §6 — a window sets the part's length for groups exactly as for
  clips; the ruler is the seek surface.

### Resolved

**Q1. Why does take #1 get to be dictator forever?**
**RESOLVED — it should.** Owner: "while the first loop is 'throwaway' in
spirit, it sets the groove and every subsequent take is done off of
that. You can imagine muting the original quantum track after recording
a bass and drum loop over it. **The DNA of the original scratch track
remains.**" Consequences: (a) no Q re-seating feature; (b) **Q survives
its creator** — muting or even deleting the first clip must not change
Q. This settles the P0-3 policy question: Q (and the island epoch) is
stored at the island root, not derived from surviving clips. Today's
derived-min behavior, where deleting/shortening a clip silently changes
Q, is confirmed as a bug, not a feature.

**Refinement (2026-07-16, Q13 non-sticky):** "survives its creator"
applies to the *locked* Q — once a second take has committed against it,
the DNA is load-bearing and permanent. While still **provisional** (the
island's only committed content is the Q-definer), Q is not yet DNA:
deleting that sole clip reverts the island to no-Q (a blank slate), and
re-trimming its loop re-establishes Q. Survival and reversibility do not
conflict — they are the locked and provisional phases of the same rule
(see Q13).

**Q2. Is the LCM a fact about the music, or just a fact about the math?**
**RESOLVED — neither; it's a display device.** Owner: "the only goal of
LCM is a very simple overarching principle: all audio should play back
in sync with the music the musician was hearing while they were playing
it. All the math is downstream of that (and in service of making that
situation legible visually)." So: **I1 is the sole timing principle; the
LCM is derived legibility machinery** and must never constrain playback.
The sanctioned exception: explicit edits (dragging clips, changing
launch points or loop windows, non-contiguous ranges) are the user
*deliberately* decoupling a performance from its context. The
"polymetric guest" alternative is therefore moot as a model — but the
practical concern survives as UX: a 5Q take in a 4Q song still explodes
the *visual* cycle ×20 (tasks.md open question 5, warning UX).

**Q4. Is loop-on-collapse a mode error by design?**
**RESOLVED — collapse must be sound-neutral, which convicts the current
implementation.** Owner: "Collapsing just displays the full LCM of the
stack; the sound shouldn't change." That is now invariant **I6b (View
Purity)**. ⚠️ But the implemented and unit-tested Loop-on-Collapse model
(stacks.md §Stack Loop Processing; `stack_loop_tests.cc`) does the
opposite: the loop window and an internal transport activate on
collapse, audibly changing playback. **The implementation contradicts
the owner's intent and needs redesign** — most likely: the loop window
gets its own active/bypassed state independent of expansion (with
recording semantics inside an active window to be specified). Tracked in
tasks.md.

**Q8. Why does master time ever reset?**
**RESOLVED by principle.** "Mutating the master clock" is engine-internal
jargon (the transport currently resets/snaps/wraps itself at commit
boundaries); the owner's ruling on Q2 governs: any mechanism is fine iff
I1 holds. kernel.md's monotonic-clock design satisfies I1 by
construction, so the transport simplification is an implementation
choice needing no further design ruling.

### Second batch (Q7 resolved 2026-07-09; Q9 superseded by Q12)

**Q7. Recording is the only non-fractal verb.**
**RESOLVED (2026-07-09) — group arm.** The owner ruled via the drum
use-case: a "drums" stack holds ~5 tracks (one per kit mic, each with
its own input); *"I want to be able to arm the entire stack with one
button — I don't want to have to record each track individually."*
Canon: **arming a stack arms every armable child track; record captures
all of them simultaneously, each from its own input**, sharing one arm
target (the next Q boundary, Q11) and one committed duration (one
performance, N microphones). Refinement (owner, 2026-07-09): **arm
targets emptiness** — a clip that already has content cannot be
re-recorded (consistent with no-overdub-by-design), so group record
"should only record clips that don't already have content and just play
the other ones." Re-recording content is the *takes* feature, not arm. Record is thereby fractal: on a clip it records that
clip; on a stack it records the stack's members. Two companions ruled
at the same time: **templates** — a saved node subtree (structure +
names + input assignments) loadable into a session, so the drum stack
is one click, not five manual setups; and **takes** (direction only,
deferred until the core workflow lands) — re-recording a track must be
a first-class verb ("new take" on the record button, a take list per
clip to switch between), explicitly NOT the duplicate-track/mute-old
workaround. Take storage should slot into the clip model as alternate
content buffers sharing one origin/period — the kernel needs no change.

**Q9. Origins in samples will break under Warp.** **SUPERSEDED by Q12
(2026-07-16)** — the question was ruled in its larger form (rational
musical time) without waiting for warp. Original deferral kept below
for history. *(Owner: "I don't know
what 'warp' means yet — skip.")* TODO with the idea parked for later:
"Warp" is roadmap Segment 8 (design.md Challenges §1) — playing audio
faster/slower without pitch change so material recorded at one tempo can
live inside another (the WSOLA/time-stretch engine). The parked
question: when warp exists, a clip anchored "at sample 88200" is
ambiguous after stretching; anchoring "at beat 5/4 Q" is not. Whether
positions are stored in samples or Q-fractions is cheap to decide before
P0-3 and expensive after. Tracked in tasks.md.

### Second review round (2026-07-07, later)

**Q3. Grid honesty when snapping is disabled.**
**DEFERRED — the premise doesn't exist yet.** Owner wasn't familiar with
"auto-quantize" — clarification: it's this codebase's own term for the
always-snap-to-the-next-Q-boundary recording behavior (recording.md:
"Recording/stopping ALWAYS snaps to the next clean quantum boundary";
Future Features lists "Disable Auto-Quantize"). The question — should x
draw sample-precise origins honestly, or should the grid stay
authoritative — only becomes real if that disable-toggle is ever built.
Parked with that feature.

**Q5. What *is* a one-shot?**
**RESOLVED — the period-source definition.** Owner: "Your proposal
matches my intuition. It basically means that clip doesn't loop
continuously; it plays once when the larger LCM playhead crosses its
anchored location." Canonical definition: **a one-shot is a clip whose
period is the context cycle rather than its own length** — it sounds
once per cycle at its origin, then rests. The garbled inequality in
design.md/recording.md is superseded (both docs updated).
✅ **Implemented 2026-08-06** as the first-class knob
(`period_from_context_` / `setPeriodSource`, tasks.md Tier 3): the
context cycle is passed down per scope (lcm of the LOOPING siblings'
periods — one-shots are excluded from every composition fold, so they
adopt the cycle and never extend it), the ↺/1× rail chip toggles it
(undoable), and the display is the ratified dashed-tile-no-ghosts form.

**Q6. Serial composition semantics.**
**RESOLVED (provisionally).** Owner: chaining a 4Q box into a 6Q box
yields a 10Q total sequence, which loops — "we haven't really finalized
how boxes work." So the serial operator is **concatenation of periods**
(4Q ⧺ 6Q = 10Q cycle), pending full box design in Segment 9. In kernel
terms: a serial group is a composite whose time-map routes each child a
sub-range of the cycle — same primitive as everything else.

**Q11. Where does a mid-cycle record click anchor?**
**RESOLVED (2026-07-09).** Owner: "if you hit record mid-Q, the
recording should start at the next Q (or Q0 if you are in the middle of
the final Q of the LCM sequence)." Canon: **the arm target is always the
next Q boundary in the epoch frame** — the cycle top is not special; it
is simply the next boundary when you click within the cycle's final Q.
(Matches recording.md Example 4. Mechanism note 2026-07-16: the target
is computed in the HEARD — latency-compensated, epoch-relative — frame
via `timing::armTarget`, which makes "clicking just before a boundary
means that boundary" true with no extra tolerance machinery; the old
25% deferral window is deleted, Q14.)

**Q10. Transport with multiple islands.**
**RESOLVED (direction) — one active island at a time, for now.** Owner:
global play loops the *active* island. The long-term vision: build a
song in island A, let it play, establish a new Q for island B
(*"potentially while the existing island is still playing? this kind of
contradicts my first sentence"* — acknowledged as undefined), then
transition (e.g. crossfade) between songs. Ruling for now: **focus on
nailing a single island; the kernel must merely not make multiple
islands impossible.** The kernel satisfies this: an island is a subtree
with its own `(Q, epoch)`; concurrent islands are subtrees with
different epochs on the same monotonic clock — nothing global assumes
one Q. Cross-island transitions remain far-future (tasks.md).

### Third review round (2026-07-16)

**Q12. What is the unit of musical position in the engine?**
**RESOLVED — rational musical time, adopted now.** (Subsumes Q9, which
had deferred the sample-vs-Q-fraction question until warp; the
unification audit reframed it as the gate for warp, nested tempi,
time-map phases 2–3, and a device-independent Save/Load format —
unification_audit.md §4.) Owner ruling: **adopt now** (not deferred,
not format-only), represented as a **`QTime` exact rational**
`{int64 num, int64 den}` meaning `(num/den)·Q`, gcd-normalized — not
fixed PPQ ticks (free lengths don't lie on a grid), not float beats
(drift breaks exact LCM math). Adopted with the ruling, as
engineering defaults from the same audit section:

- **D-T3 — the sample/QTime boundary:** physical facts stay samples
  (monotonic clock `t`, epoch timestamps, pre-record ring, buffer
  lengths, calibration C); musical facts become QTime (origin as
  offset from epoch, period, window segments, arm targets, Q
  subdivisions). The island owns the exchange rate `Q_samples`
  (established at first commit, as today); warp later = a
  time-varying rate, nested tempi = per-subtree rates — the time-map
  rate term, same primitive.
- **D-T4 — one rounding law:** a single shared
  `toSamples(QTime, island)` used identically by capture and playback
  (I1 survives rounding because both sides round the same), pinned by
  golden vectors. This replaces today's silent integer-division
  lossiness (`Q/8` in `nextStopBoundary`).
- **D-T5 — unsnapped content stays sample-exact:** raw take lengths
  and free-length cuts are physical facts; QTime describes where
  content *belongs*, buffers describe what it *is*.

Sequencing: land before time_maps phases 2–3 and before Save/Load;
migrate mechanically alongside the kernel-completion field deletions
(tasks.md Tier 0/1).

**Q13. Can Q be corrected after the first take?**
**RESOLVED (2026-07-16) — Q re-trim before lock.** Owner (from field
use): *"Usually there is some dead air around the music and I need to
find the right loop region. We need some UX to be able to adjust the
loop regions of Q before recording new tracks. This should only be
possible when there is only the initial Q-defining clip in an island.
Once you start recording new tracks, Q becomes locked."* Canon:

- While the island's only committed content is the Q-defining clip,
  adjusting that clip's loop region **re-establishes the island's
  (Q, epoch)**: `Q_samples := window length`, `epoch := origin +
  window start` (the performance moment of the trimmed loop's top).
- **Lock is DERIVED, not sticky (owner ruling 2026-07-16):** Q is
  mutable ⟺ the island has **exactly one committed clip**; it is locked
  while ≥2 exist. So the lock is a pure function of committed-clip count,
  not a latched flag — if you later delete back down to one clip, Q
  **re-opens** (and whatever clip is now the sole survivor can redefine
  it). `setQuantum` becomes "re-settable while provisional"; the UI
  reflects the locked/unlocked state on the sole clip's loop handles.
- **Deleting the sole committed clip reverts (Q, epoch)** to
  unestablished — nothing defines Q anymore, so the next take
  establishes it fresh (companion to the re-open above; both are the
  count==1 boundary).
- All three transitions (re-trim, revert, re-open) ride the undo log:
  the LoopPoints / Remove edits carry the island `(Q, epoch)` so undo
  restores the grid, not just the clip or window.
- **Amendments (2026-07-19, from the two-cursors field bug):**
  (a) the epoch contract is now enforced in PLAYBACK — clip windows
  anchor at `origin + loopStart`, so island phase 0 audibly IS the
  trimmed loop's top (see time_maps.md phase-1-extension note; without
  this a sub-Q trim put the arm grid mid-loop). (b) In the trim view
  the ONE playhead (I8) maps into the selection (`selStart +
  islandPos`) and loops exactly over it; the lane draws no separate
  amber cursor. (c) Re-trim is gated on `!hasActiveTake()` — a
  performing take already plays against the grid, so a drag mid-take
  is an ordinary window edit, not a Q change.
- **Q13 FOR GROUPS (owner ruling 2026-08-21 — the fractal twin, from
  the field: "I started with drums" and a first take recorded as a
  group could not be trimmed at all):** a stack whose direct clip
  children are the island's ONLY committed content and were recorded
  as ONE take (identical origin and duration — N mics, ≥ 2 of them; a
  single clip keeps the clip path wherever it lives) is the island's
  **definer stack**, and its window re-establishes (Q, epoch) exactly
  as a sole clip's does (`AudioEngine definerStack`; mock
  `definerStackNode`; VM `definerStackOf`). Differences forced by the
  structure, not the law: the window lives on the STACK (it IS the
  part under the window law, ui_overhaul.md law 13) and the children
  stay whole. The members' ORIGINS re-anchor together with the epoch
  (`origin' := t0 − (pT − start)` for every member, `epoch := origin'`
  — the sole-clip math made fractal; CONTENT-FRAME LAW 2026-08-30,
  docs/archive/loop_region_audit.md §0: a stack window selects epoch-relative
  view positions while members read origin-relative, so solving the
  epoch alone — the 2026-08-21 form — made the trimmed loop jump by
  `start` on every release). **Lock-collapse, the group twin (audit
  2026-08-30 §3.5, reversing the 2026-08-21 "no collapse" line):** at
  the second arm the definer stack collapses to its window exactly as
  a sole clip does — every member's content base shifts by the window
  start, duration := len, the stack window is consumed; the members'
  ORIGINS stay (the group window anchored at the epoch == origin, so
  moving them would shift the audio — pinned render-level by
  `content_frame_tests`). Without it the raw inner cycle survived the
  lock incommensurate with Q and poisoned every LCM the arm math
  snapshots. RE-OPEN ⟹ UNCOLLAPSE has its group twin too
  (`Edit::CollapseGroup`, `collapseGroupNow`/`uncollapseGroupNow`).
  The trim view renders on the
  group lane (the composite, brackets, "sets tempo"); the mics draw
  whole beneath it in the same buffer frame. Lock remains derived:
  another take anywhere (a third mic recorded later, a new track)
  ends the definer state.
  **Two refinements (fresh audit 2026-08-31, fuzz-found —
  docs/archive/loop_region_audit.md §7):** (1) **ONLY GEOMETRY WINS** — a
  re-establishment moves the grid under every OTHER authored window or
  map in the island, stranding it permanently incoherent, so BOTH
  definer paths engage only while the definer's geometry is the
  island's only geometry (`hasActiveGeometryOutside`; a committed
  clip's full-span [0, D) is commit furniture, not geometry). Clear
  the other window and the definer power returns. (2) **the
  Q-ESTABLISHMENT SCRUB** — authoring windows/maps pre-Q is legal
  (parts can be authored before the first take), but a free length
  chosen with no grid can be incoherent with the Q the first take
  establishes; at establishment, `scrubIncoherentGeometry` clears
  whatever the new grid cannot carry, with a log. Windows also clear
  by re-establishing: emptying the definer's window restores Q := the
  whole take and epoch := origin (the base facts), instead of leaving
  the trimmed Q under a full-length loop.
  - **Members whole is an invariant, kept by the engine (2026-08-30,
    field video/dump 2026-08-29):** a group take committed against a
    Q the island already held (commitRecording's hysteresis snap puts
    the sub-region `[0, floor(L/Q)·Q)` — or `[0, Q/2)` — on each
    clip) is LIFTED at settle: the members' common commit-time region
    becomes the stack's window and the members go whole
    (`reconcileTakes → liftGroupWindow`, riding the take's undo entry
    as `Edit::windows`). A definer re-trim carries the same rider for
    members that still hold a window (pre-lift states). The trim view
    draws the RAW mixdown (composite `raw` mode: whole takes from 0,
    no window/epoch tiling) — the picture under the selection is
    exactly what the mics show beneath, and it never regenerates on a
    release. The VM's selection falls back to the members' common
    window when the stack has none, so an old state still reads what
    the ear hears.
  - **One island, one owner of (Q, epoch):** only the session root
    holds island facts. A stack assembled DETACHED (Combine builds the
    new stack before inserting it) was its own `rootNode()`, so
    `addChild`'s establishment stamped the first committed child's
    duration/origin onto it; attached, the subtree then ran on that
    private grid — after a delete-all reverted the root's Q, the next
    group take in that stack committed against the stale one (the
    2026-08-29 dump: children `[0, Q_stale/2)`, root Q = 0, UI and
    engine disagreeing on Q from then on). Every structural edit now
    scrubs nested facts (`AudioEngine::scrubNestedIslandFacts`).
- **LOCK-COLLAPSE (owner ruling 2026-07-19b — the unifying
  simplification):** the trim is a PRE-LOCK affordance, nothing more.
  The moment a second take ARMS, the definer's window **becomes the
  take** — `duration := Q`, `origin := the window top (= epoch)`,
  window consumed, content base shifted (`Edit::CollapseTake`,
  undoable) — *"as if the trimmed clip is the only content there, like
  I recorded it perfectly and didn't need to edit."* After lock the
  looper is an ORDINARY whole-Q looper: no incommensurate buffer
  survives to poison arm boundaries, context loops, heard/intrinsic
  cycle snapshots, or LCMs (field: take 2 anchored at origin − epoch =
  56298 ∉ Q·Z; frame exploded to 142336Q). The dead air is undo-only
  state — ⌘Z restores the full buffer and the trim; session save
  writes the collapsed take. The pre-Q-lock state is therefore the
  ONLY state where the model deviates from the plain looper, and it
  ends at arm.
- **Companions (2026-07-19c, field):** (a) **RE-OPEN ⟹ UNCOLLAPSE** —
  deleting back down to the sole take restores its full material with
  the old trim as the window (audio-neutral by construction: the
  windowed playback of the restored buffer is the identical loop), so
  the trim can grow again; rides the Remove edit (undo re-collapses
  via a uuid2 rider). (b) **PHASE-PRESERVING TRIM** — a provisional
  re-trim re-anchors the clip's origin so the buffer position sounding
  at the edit moment does not move (folded into the new window if cut
  off): `origin' := t0 − p_target`, epoch := origin' + start as ever.
  The audio and the cursor flow continuously while the handles are
  nudged; the bar line re-derives silently. Legitimate because the
  provisional grid is free — nothing else depends on it yet.
- This refines Q1 (Q survives its creator): survival applies to the
  *locked* Q — the DNA that later takes were performed against. Before
  lock, no other performance depends on Q, so re-trimming breaks
  nothing (I1 is vacuous over an audience of one).
- **QTime interaction (Q12): none — by design.** The Q-definer's
  window bounds are sample-exact physical facts (D-T5); they *define*
  the exchange rate rather than being expressed in it. Its period is
  exactly 1Q by definition before and after the trim, so a re-trim
  changes `Q_samples` and the epoch, never any stored QTime fact.

**Q14. Where does the take tile draw for a mid-cycle take?**
**RESOLVED (2026-07-16) — performed phase is kept; whole cycles fold
away.** Field report (owner): *"record clip 3 starting right before 2Q,
record 2Q in length, stop before end. Expected: clip 3 is anchored from
2Q to 4Q in the timeline. Actual: clip 3 jumps to 0Q-2Q."* This refines
the 2026-07-10 take-marking ruling (*"it doesn't matter how many times
I let clip 1 loop before recording clip 2"*): that ruling is about
whole CYCLE counts, which still fold away — but the performed PHASE
within the cycle is a real fact the display must keep. (The audio
cannot distinguish: a 2Q loop at 2Q sounds identical to one at 0Q —
this is purely take marking.) Canon:

- An **era take** (origin ≥ current epoch) marks its bright tile at its
  performed cycle position, `(origin − epoch) mod committed-cycle`.
- A **pre-epoch take** (the frame re-based after it committed) has no
  honest performed position in the current frame and marks the first
  full repetition (the 2026-07-10 behavior survives for exactly these).

Fixed alongside (same field flow, engine side): the anticipatory-window
DEFERRAL overshot the anchor by a full Q when latency compensation was
small (uncalibrated I/O) — deleted; `armTarget` over the heard
(latency-compensated) clock already lands any click before a boundary
ON that boundary, which is all the "pickup" ever needed. The vocabulary
entry's "clicking within 25% of Q before a boundary means that
boundary" holds trivially: ANY click before a boundary means that
boundary now.

**Q14b (2026-07-16, same session — the frame-explosion follow-up).**
Owner: *"record clip 4 0Q-5Q — the timeline blows up to a big LCM (as
expected) but the wrong section of clip 4 is highlighted"* (it drew at
12Q–17Q of the new 20Q frame — its raw position, the whole-cycle count
leaking back in once the fold modulus grew). Canon, completing Q14:

- Each take records its **heard frame** (`contextCycle`: the committed
  island cycle at its arm). The take tile marks at the tile ≡ its heard
  PHASE (mod contextCycle) — stable across frame growth and epoch
  re-bases, for positive and negative rel alike (this subsumes the
  era/pre-epoch split; takes with no contextCycle keep first-full-rep).
- **Every cycle growth re-bases the island epoch to the take's heard
  top** (origin floored to whole pre-take cycles). Whole-old-cycle
  moves are phase-neutral for all committed clips; the polyrhythmic
  keep-the-epoch rule is superseded — it predated the recording view's
  whole-cycle shift, and keeping the raw frame teleported the take at
  commit. "The cursor sails on" now refers to the WATCHED (shifted)
  cursor, which is continuous through commit by construction.

**Q14c (2026-07-16, same session): ghosts show what SOUNDS.** Owner
ratified the windowed-lane rendering rule: a windowed clip's ghost
tiles are ECHOES of the window segment at its audible repetitions,
in a visibly different (cool) tone — *"the missing piece … is
distinguishing between ghosts and original-audio-outside-current-
loop-window … maybe an entirely different color for ghosts."* The take
tile is the ONE place that renders recorded truth (original material,
dimmed outside the brackets — the standing visual proof that a window
edit is reversible, I9); everywhere else renders audible truth,
matching the composite (Q14b/D13). Window dims apply only to the take
tile on clip lanes.

Follow-up ruling (owner, same day): *"it seems like the ghosts of
clip 1 should be teal too"* — correct, and ratified as the uniform
color grammar: the echo tone marks **every** ghost tile (they are all
audible repetitions, windowed or not, clips and groups alike — I5);
warm tape hues are reserved for MATERIAL (the take tile, the live
recording bar, the group composite). Presence still differs: full-take
ghosts stay quiet (0.22 — they duplicate the adjacent bright take)
while window echoes are more present (0.38 — they are the only visible
representation of what sounds there).

**Q15. Where does a take anchor when windows shorten the heard cycle?**
**RESOLVED (2026-07-16) — the heard-frame origin fold.** Field report
(owner): with a 4Q clip windowed to [2,3), the heard cycle collapses to
1Q and the cursor loops 1Q; arming then anchored the take at a Q slot
of the intrinsic 4Q frame the performer could neither hear nor see —
*"I hit record… trying to start at 0Q. It started recording at 1Q
instead!"* Analysis: the heard world is exactly heard-cycle-periodic
(E-C is exact), so every anchor in `origin − k·heardCycle` is **audibly
identical**; the engine was die-rolling among equivalents and surfacing
the roll. Re-basing the epoch instead would rotate other lanes
(violates I4: whole-INTRINSIC-cycle moves are the only phase-neutral
ones); waiting for the 0-mod-intrinsic boundary would stall recording
up to a full frame (violates Q11 responsiveness). Canon: **capture
starts at the real next heard boundary (Q11 unchanged), but the STORED
origin is the equivalence-class representative folded back by whole
heard cycles into the first heard window of the intrinsic frame** —
the take anchors where the cursor actually sweeps. I1 holds exactly
(playback shifts by whole heard cycles); nothing else moves; a no-op
whenever heard == intrinsic (the windowless mainline). The island
snapshots BOTH cycles at arm: intrinsic (`lcm_before_take_` — re-base
baseline and fold frame; windows must not leak into epoch permanence)
and heard (`heard_cycle_at_arm_` — the fold step, and now the true
source of each take's `contextCycle`).

### Fourth review round (2026-08-13)

**Q16. What is per-node Play/Stop in a one-transport world?**
**RESOLVED (2026-08-13) — superseded; solo canon pinned.** design.md
§3's "Play/Stop: toggle playback of the specific node" predates Q10
(one active island; global play loops it as a whole) and the prime
invariant's everything-sounds-together model. In that world, "play
just this node" *is* solo + transport on, and "stop this node" *is*
mute — a third per-node play state would be a mute-shaped flag under
another name (the mock's vestigial `isPlaying`/`togglePlay` is exactly
that residue; it dies with this ruling). Owner ruled: **superseded** —
mute/solo plus the one transport ARE the per-node play controls. What
the checkbox still owes is solo semantics, ruled in the same pass:
**solo is island-wide** (any solo mutes every leaf without a soloed
ancestor, anywhere in the island — not just among siblings),
**additive** (multiple solos sum; never radio-button), and **fractal**
(solo on a group solos its subtree — I5, the same shape fx/gain/arm
took). Deserves the group-arm treatment: a C++ invariant test naming
all three properties, plus the mock twin.

**Q17. What does + create?**
**RESOLVED (2026-08-13) — every + is a template picker.** Owner, from
the field flow: *"almost always you will want to create a new track
and pick a template, even if the template is basically just a named
input (like Guitar – input 3)."* So the creation menu is not an
advanced-options escape hatch off a fast path — **templates are the
path, and the bare empty track is the degenerate template**. This also
dissolves the apparent tension with post-hoc grouping (2026-07-19h): a
"Drums" menu item is not an upfront structural decision but a
*recalled* one — the 5-mic decision was made once and saved; the
template replays it. Canon:

- **One control, no second button.** Every + affordance (top-level
  ＋ Track, group rail +, the add-row) opens the SAME menu; group
  entry points insert into their group. A separate "…" menu button
  was considered and rejected: its menu would be a strict superset of
  +, which is the tell that they are one control — splitting one verb
  across two targets makes every add a which-button decision.
- **Fixed default under the cursor.** The menu opens with a "Track"
  row (bare clip, default input) anchored directly under the pointer —
  click-click in place reproduces today's one-verb behavior. FIXED,
  not last-used: muscle memory needs the same thing under the cursor
  every time; an adaptive default sabotages the double-click habit.
- **Templates listed below** — the user's subtree library (Guitar,
  Bass, Drums…). Two clicks either way, and the template click
  *replaces* work rather than adding it: picking "Guitar – input 3"
  does the rename + input-pick (+ stereo pair) it saves.
- **Subtree templates (the Q7 companion, now landing).**
  Save-from-selection: a "Save as template" verb on any track or
  group. Capture = **structure + names + input assignments** (Q7's
  canon minimum; the on-disk format stays additive so fx/gain/pan can
  ride along later without migration). **Global library**, user-level
  — Guitar follows you into every project; deliberately distinct from
  projects.md's whole-session templates. A group template ("Drums" →
  5 named, routed tracks) lands as ONE undoable insert-subtree edit;
  Q7's group ● then gives arm-all-N for free.
- **The spark stays one gesture, keyboard-shaped.** With an empty
  project, `R` creates + arms the default track — the R canon's
  no-selection case extended down to zero lanes. Launch → R →
  recording.
- **Boot empty.** `ensureLaunchSession`'s seeded "Track 1" — and the
  auto-load-last-session-template behavior built around it — retires.
  Owner: *"when I am making real music, I'll decide which instrument
  I am using to form the Q."* Whole-session templates remain an
  explicit save-as / new-from choice in the projects UI.

End-state journeys: scratch spark = launch → `R` → recording (one
key); real music = + → Guitar → ● (three clicks, and the track is
already named and routed).

---

*Companion: `kernel.md` — the claim that one stored number per clip
(origin) plus one monotonic clock makes I1–I8 true by construction.*
