# Celestrian Design Language

> Written 2026-07-07 from a full pass over `docs/`. This is an attempt to
> extract the *implicit* design language of the existing docs into precise,
> quotable form: vocabulary, invariants, worked examples in the house
> style, and a set of deliberately provocative questions. Companion doc:
> `kernel.md` (the simplification proposal that falls out of this one).
>
> Status: **proposal** — nothing here is binding until adopted.

---

## 1. The Vocabulary

Every term below appears in the existing docs, but several are defined in
two or three places with drift. These are proposed as the canonical
one-line definitions.

| Term | Definition |
|---|---|
| **Quantum (Q)** | The atomic musical duration of an island, in samples. Established by the first committed take; the grid everything snaps to. "One bar." |
| **Island** | The scope within which Q is shared. One island = one song = one time grid. Distinct islands are musically unrelated universes on the same canvas. |
| **Origin** | The master-cycle moment a clip's content belongs to: the performance-time at which `content[0]` occurred. *(Today this is smeared across `anchor_phase`, `launch_point`, `recording_start_phase`, rotation, and `x_pos` — see kernel.md.)* |
| **Performance time** | The frame the musician lives in: what they *heard*. Input arriving at master time `t` was performed at `t − C` (C = calibrated round trip). All musical positions are performance-time. |
| **Arrival time** | When audio physically reaches the input. Never a musical position; only capture plumbing (the pre-record ring) thinks in arrival time. |
| **Context loop** | The loop the performer was listening to when they hit record: the longest committed sibling (min Q). Determines how their intent wraps. |
| **Cycle (LCM)** | The period after which *every* member of a scope returns to phase 0 simultaneously: LCM of member periods. **A derived legibility device, not a modeling principle** — it exists to make I1 visible, never to constrain it (owner ruling, Q2). |
| **Launch point** | Derived: the playback offset that makes a clip honor its origin. `launch = (−origin) mod period`. |
| **Ghost** | The visual unrolling of a loop across the cycle: repetitions of content that exist mathematically but not as separate audio. |
| **One-shot** | A clip that sounds once per context cycle instead of looping at its own length. *(See Q5 — the current formula in design.md/recording.md is garbled.)* |
| **Composite** | A stack seen from outside: a virtual clip whose content is the sum of its children and whose period is their LCM. |
| **Loop window** | A `[start, end)` restriction on a node's cycle. *(When it applies on composites is under redesign: the implemented loop-on-collapse ties it to collapse state, which violates I6b — see Q4.)* |
| **Hysteresis snap** | Gesture quantization with tolerance: stop-intent within 15% of a boundary means the boundary; outside it means "keep the raw take, snap the loop window." |
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
  works at depth 0 is unfinished.
- **I6 — Pure Projection.** Every pixel is a pure function of engine
  state. The UI holds no timing state of its own; identical state ⇒
  identical pixels. *(This is the precise form of "UI = Data" — the
  original phrasing conflicts with ui.md's pixels-belong-to-the-frontend
  rule; "UI = f(Data), f pure and shared" resolves it.)*
  **Owner ruling (2026-07-07) — corollary I6b, View Purity: view actions
  never change sound. Expanding or collapsing a stack is display-only.
  ⚠️ The implemented Loop-on-Collapse model (stacks.md) violates I6b —
  collapsed stacks currently apply their loop window and an internal
  transport, audibly changing playback. Flagged for redesign; see Q4.**
- **I7 — Empirical Time.** Latency constants are measured on the user's
  hardware, never assumed from driver reports. *(Implemented:
  calibration + persistence, performance.md §7.)*
- **I8 — One Clock.** There is exactly one time authority per island.
  Any second counter (UI-side playhead math, internal transports,
  wrapped copies) must be derivable from it. *(Aspirational — see Q8.)*

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
boundary, inside the 25% PLL tolerance, so intent = "the upcoming 1".

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
Collapsed:  ▒▒▒▒[░░ active 2Q ░░]▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
                 ↑2Q        ↑4Q       (dim = outside window)
Playhead cycles 2Q → 4Q → 2Q ...
Children hear: child_t = 2Q + ((t − collapse_epoch) mod 2Q)
```

Exercises: loop windows change *period* (a windowed composite behaves as
a 2Q clip in its parent's LCM!), and the window-epoch time-map.
⚠️ **This example describes the implemented behavior, which Q4's ruling
has since overruled**: activation must not be tied to collapse (I6b —
collapse is display-only). The window math above stays valid; *when* the
window applies moves to an explicit active/bypassed state (redesign
tracked in tasks.md). Note the consequence either way: an active window
changes the parent cycle from 12Q to LCM(4Q, 2Q) = 4Q.

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

Found during this pass; none require design decisions except (1):

1. **The one-shot formula is garbled** — design.md §7 and recording.md
   §Clip Types both say looping ⇔ `duration >= anchor_position %
   duration`. Since `x % d < d` always, every clip is "looping" and the
   one-shot condition is unsatisfiable as written. The prose intent
   (Example 3) is `duration < context remaining` / "doesn't fill the
   context." Needs an owner-approved correct statement (E-D proposes the
   period-based one).
2. **recording.md Example 2/3 collision** — Example 3's text ("Short clip
   recorded mid-timeline…") is fused onto the end of Example 2's buffer-
   rotation note with no heading; the Examples numbering skips 3.
3. **Rotation language is stale** — design.md §1 ("the buffer is
   cyclically shifted") and recording.md's rotation note describe the old
   *physical* rotation; since P0-2 rotation is virtual index math.
4. **design.md numbering** — Features run 1, 2, 6, 5, 6, 7, 7, 3, 4; two
   §6s and two §7s.
5. **Islands are specified in triplicate** — recording.md (inheritance
   rules 1–3), implementation.md §8 (membership rules), design.md §8
   (inherit/new-song). They mostly agree but drift in details (e.g.
   whether connection-after-Q is defined). One canonical islands section
   should own it.
6. **nesting.md is a fossilized status journal** — it declares drag-drop
   "Partially Implemented, Not Working" and "✅ Resolved" in the same
   file, and duplicates per-stack-LCM content now in stacks.md. Fold the
   two surviving sections (per-stack LCM, drop-zone design) into
   stacks.md and delete.
7. **test_harness.md references `ui/js/app_test.js`**, which no longer
   exists (also flagged in refactoring_proposal.md P3).
8. **Doc-type headers** — proposal: every doc opens with one of
   `Status: spec | journal | proposal`, so readers know whether drift
   from code is a doc bug (spec) or history (journal). Half the confusion
   in this review was telling those apart.

---

## 5. Provocative Questions

First review round: 2026-07-07 (owner answered Q1, Q2, Q4, Q7, Q8, Q9;
Q3, Q5, Q6, Q10 not yet reviewed).

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

### Deferred (TODO — discuss later)

**Q7. Recording is the only non-fractal verb.** *(Owner: "I don't
understand this question — skip for now.")* TODO, restated for next
time: every verb (play, loop, solo, mute, waveform) works on both clips
and stacks; *record* only works on clips. Question: what should the
record button on a *stack* do? Proposed answer to react to: "record a
new clip inside that stack, aligned to its cycle" — which would
naturally grow into take lanes/comping. Tracked in tasks.md.

**Q9. Origins in samples will break under Warp.** *(Owner: "I don't know
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
design.md/recording.md is superseded (both docs updated). Implementation
as a first-class `period source: own length | context` knob is future
work.

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
(Matches recording.md Example 4 and the implemented PLL; the anticipatory
tolerance — clicking within 25% of Q *before* a boundary means that
boundary — still applies on top.)

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

---

*Companion: `kernel.md` — the claim that one stored number per clip
(origin) plus one monotonic clock makes I1–I8 true by construction.*
