# Composition: how nested loops compose time

> Written 2026-09-01 from the foundation audit. This is the recursive
> theory the canon docs stated in seven places (kernel.md §2,
> time_maps.md §2, sequencer.md §2/§9/§13, engine_lcm_guard.md,
> loop_region_audit.md §0, ui_overhaul.md law 13, design_language.md
> Q5/Q13/Q15) stated once, plus the ruling that makes it hold at every
> depth: **every node has an origin** (Q18, §0).
>
> Status: **spec**. Where an older doc disagrees with this one, this one
> wins; the older docs carry pointers. Companion: design_language.md
> (vocabulary, I1–I9, ruling index), kernel.md (the historical
> derivation).

---

## 0. The ruling (Q18, 2026-09-01): every node has an origin

The kernel says a node is `(content, period, origin)`. Until this
ruling only clips stored an origin; a stack anchored its time-map to the
epoch it received. The two anchoring laws agreed only while
`epoch ≡ origin (mod D)`, and every loop-region defect of August 2026
was a gesture that moved one without the other (loop_region_audit.md
§0). The fix that landed then — "content-selecting frames move
together", enforced by origin riders, `epochViewStep`, and a group twin
of every sole-clip path — was a stack reaching into its children to
simulate the origin it did not have.

**Owner ruling (2026-09-01):** *"I agree, groups should be able to be
anchored. I could imagine recording drums (a group of 5 clips) as a
one-shot for example."*

Canon:

- **A stack has an origin**: the monotonic-clock moment its inner
  time 0 belongs to, exactly as a clip's origin is the moment
  `content[0]` belongs to. It is stored, never derived (kernel.md §2).
- **One anchoring law for every node** (§2). A stack's time-map anchors
  at `origin + mapOffset(0)`, as a clip's does. The epoch no longer
  selects content anywhere in the render path.
- **Re-anchoring a node re-anchors its subtree** (§5): a node's content
  is its subtree, so an origin shift is applied recursively. This
  replaces the origin riders and makes seek, the definer trim,
  lock-collapse and continuity one operation each, for clips and
  stacks alike.
- **A stack can be a one-shot** (Q5 generalized): `periodSource =
  context` on a stack fires its subtree once per context cycle from its
  origin — the drum-group use case. Its children render only while the
  stack's phase is inside its inner cycle; the rest of the cycle is
  honest silence through the group's rack.

---

## 1. The node record

```
node = {
  content   : samples (leaf)  |  children (stack)
  origin    : int64 samples on the monotonic clock — the moment
              inner time 0 belongs to (clip: content[0]; stack: the
              inner timeline's zero). Stored. Set by the events in §5.
  intrinsic : D — clip: committed length; stack: LCM of the LOOPING
              children's intrinsic durations (one-shots excluded).
  map       : the active time-map, or none. Segments are INNER
              positions in [0, D). One implementation (time_map.h).
  periodSrc : own | context  (Q5 — loop at own period, or sound once
              per context cycle)
  sequence  : stacks only — steps + gates + cues (sequencer.md)
  stage     : gate (mute/solo/sequence, pre-fx, ramped) → fx →
              gain·pan → parent   (unification_audit §2.4, S7)
}
```

Units: every field above is samples (engine) or a rational of Q at the
metadata/persistence boundary (Q12). The island holds the exchange rate.

**Unanchored stacks.** A stack with no committed content in its subtree
has no origin yet (`anchored = false`). Until the first content arrives
its inner zero is the received cycle top (`origin := cycle_epoch` for
the block). No member exists to disagree, so this is not a second law;
it is the empty case. Pre-Q authored geometry on such a stack is
subject to the establishment scrub as before.

---

## 2. The one equation

For a node with origin `O`, active map `m` (or the full span `[0, D)`
when no map is active), map period `P = m.period()`, and
`a0 = m.mapOffset(0)` (the first segment's start):

```
inner(t)  = m.mapOffset((t − O − a0) mod P)          // an inner position in [0, D)
```

- **Leaf:** `out(t) = content[base + inner(t)]` (base = the
  lock-collapse content base, a storage detail).
- **Stack:** children render at `t_child = O + inner(t)`; the child
  frame's cycle top is `O + a0`. With no active map this is the identity
  `t_child = t`.
- **One-shot** (`periodSrc = context`, context cycle `C > P`): the fold
  runs on `C` instead of `P`:
  `h = (t − O − a0) mod C`; sound `inner = m.mapOffset(h)` while `h < P`,
  silence otherwise. A one-shot stack renders no children in its rest
  region (their state still advances; the group's fx rack keeps
  running, so tails ring).
- **Sequence** (stacks): the step lookup runs at the SONG position,
  which is `inner(t)` measured from the stack's frame top — the map
  selects song positions (S9). A CUED step re-bases the child clock to
  the step top: `t_child = O + a0 + (songRel − stepStart)`, a derived
  per-step map layered under the authored one (§13 of sequencer.md).
  Gates are looked up on the song timeline, never through the cue.

Consequences that used to be special cases:

- The single-segment map `[s, s+len)` gives `inner(t) = s + ((t − O − s)
  mod len)`: window content sounds at its own performed moment (the
  2026-07-19 clip law), now for stacks too.
- A windowed group of N mics recorded as one take (`O_member = O_stack`)
  renders sample-identically to each mic windowed alone. That is the
  content-frame law made true by construction instead of by riders.
- I1 is exact through any nesting: `content[k]` of a leaf at depth n
  sounds at `t` iff the composed maps select it, and every composed map
  is anchored to material, never to the display frame.

The message-thread statement of this equation is `heard_index.h`
(`nodeInner`, `leafIndex`); it is pinned against the render by a golden
test so the solvers (§5) can never restate it by hand again.

---

## 3. Periods and cycles

Two periods per node, four cycle notions per scope. This table is the
authority; the code's five effective-period implementations must agree
with it (and should become one).

| Quantity | Definition | Who consumes it |
|---|---|---|
| **intrinsic** `D` | clip: committed length. stack: LCM of looping children's intrinsic. | inner-position domain of the map; the growth baseline for the commit epoch re-base (`lcm_before_take_`); the Q15 fold frame |
| **effective** `P_eff` | active map ▸ active sequence length ▸ clip: `D` / stack: LCM of children's `P_eff` (one-shots excluded) | the parent's LCM; masterPos wrap; heard cycle at arm; the frame-health badge |
| **context loop** (`context_loop`) | the loop the performer hears while recording in this scope: map period ▸ sequence length ▸ longest committed sibling duration | arm targets (`armTarget`), stop boundaries, `contextCycle` snapshot on the take |
| **context cycle** (`context_cycle`) | the scope's cycle a one-shot adopts: map period ▸ sequence length ▸ `lcm(Q, looping children's P_eff)` ▸ inherited | one-shot playback fold (§2); one-shot echo display |
| **heard cycle** (`heard_cycle_at_arm_`) | `lcm(Q, P_eff(root))` at arm — E-C | the take's `contextCycle` (display fold, Q14); the Q15 audible-equivalence step |
| **intrinsic cycle** (`lcm_before_take_`) | `lcm(Q, D(root))` at arm | the epoch re-base at commit; the Q15 fold frame |

Rules:

- **Period law** (sequencer.md §2): an active sequence sets the stack's
  effective period to the sequence length; intrinsic is unchanged.
- **Q-coherence** (engine_lcm_guard.md): every authored period is `kQ`
  or `Q/k`, so every LCM above is finite. The sole exception is a
  definer re-trim (§5), which re-establishes Q instead of fighting it.
- **One-shot exclusion** (Q5): a one-shot node contributes nothing to
  any fold; it adopts the scope's cycle and never extends it.
- **Stochastic successors** (S12) have no period: root only.

---

## 4. The epoch

The island epoch is a **display and grid fact**, not a content fact
(Q2: the LCM and everything derived from it is legibility machinery).
After Q18 its consumers are exactly:

1. the fold of the monotonic clock into the published `masterPos`
   (`(t − epoch) mod cycle`) and the ruler;
2. the arm grid: targets are the next Q boundary in the epoch frame
   (Q11), so `epoch ≡ origin (mod Q)` for every committed take is what
   keeps arm targets and content on one grid;
3. take marks (`(origin − epoch) mod contextCycle`, Q14);
4. the cycle-top rule and two-anchor continuity, which MOVE the epoch so
   the loop that defines the cycle sits at the frame top.

No render-path consumer selects content by the epoch. Therefore:

- A whole-old-cycle epoch re-base at commit is phase-neutral for every
  node (their periods divide the old cycle) — as before, and now also
  for windowed stacks without any `epochViewStep` guard.
- A seek is `shiftOrigins(root, delta)` plus `epoch += delta`: the
  placement `origin − epoch` of every node is invariant and the phase
  jumps (§5).
- The agreement condition `epoch ≡ origin (mod D)` is no longer load-
  bearing. It is still true for every committed take on a locked
  island, and the trim view relies on it only for where to draw the
  brackets, not for what sounds.

---

## 5. Anchoring events

| Event | Effect on origins |
|---|---|
| First take under a stack commits | `stack.origin := take.origin` for every unanchored ancestor stack between the clip and the island root (rides the take's undo entry; Untake un-anchors) |
| Combine (post-hoc group) | `new.origin := min(member origins)`, anchored |
| Committed content inserted into an unanchored stack (Insert, Move, undo) | `stack.origin := child.origin` |
| Definer re-trim (Q13, clip or stack) | phase-preserving: `p0 = inner-now`, `pT = fold(p0)`, `O' = t0 − pT`; `shiftOrigins(node, O' − O)`; `epoch := O' + start`; `Q := len`. **One implementation** for clips and stacks. |
| Lock-collapse at the second arm (clip or stack definer) | leaves under the node: `base += s`, `D := len`; `shiftOrigins(node, s)`; node window consumed. Audio-neutral (§2). Re-open reverses it. |
| Map edit while playing (two-anchor continuity) | `shiftOrigins(node, O' − O)` with `O'` from `originForHeard`; epoch rides the whole-Q delta |
| Seek | `shiftOrigins(root, delta)`, `epoch += delta`, history absolutes shifted |
| Cycle growth at commit | epoch only, by whole old cycles — no origin moves |

`shiftOrigins(node, delta)` is recursive: it moves the node's origin and
every descendant's. For a clip it is `origin += delta`. Every origin
write from the message thread is gated on the island generation
(`setOriginGated`) so a block adopts new origins and the new epoch
together or neither.

---

## 6. Invariants (continuing design_language.md I1–I9)

- **I10 — One anchoring law.** Every node's map anchors at its own
  origin (§2). No node selects content by a frame it does not own.
- **I11 — Subtree anchoring.** Re-anchoring a node re-anchors its
  subtree; a node's origin is the only thing a parent may move in it.
- **I12 — Period chain.** A node's effective period is map ▸ sequence
  ▸ intrinsic, and a parent composes only effective periods (§3).
- **I13 — Q-coherence.** Every authored period is `kQ` or `Q/k`; the
  definer re-trim is the one edit that changes Q rather than obeying it.
- **I14 — One owner of island facts.** Only the island root stores
  `(Q, epoch)`; nested stacks never do.
- **I15 — Encapsulation.** A parent sees a child as `(origin, effective
  period, output)` and nothing else. (`epochViewStep` violated this by
  reading windowed stacks' inner cycles; it is deleted.)
- **I16 — Musical facts track Q.** Sequences rescale on a Q
  re-establishment; geometry the new grid cannot carry is scrubbed at
  establishment.

---

## 7. Worked examples (Q = 1000 samples)

### G-1. The drum group as definer (five mics, one take, trimmed)

Five mics armed as a group (Q7) on an empty island; the take runs 4Q
with dead air before the groove. Origins: every mic `O = 10000`, the
stack anchors at `O_s = 10000` at commit; `epoch = 10000`, `Q = 4000`
provisional.

Owner trims the GROUP window to `[1000, 2000)` while playing at
`t0 = 15400`.

| step | value |
|---|---|
| inner now | `(15400 − 10000) mod 4000 = 1400` |
| fold into window | `pT = 1000 + ((1400 − 1000) mod 1000) = 1400` |
| new origin | `O' = t0 − pT = 14000`; `shiftOrigins(stack, +4000)` → mics `14000` |
| island | `epoch := O' + start = 15000`, `Q := 1000` |

| node | origin | period | contributes to parent |
|---|---|---|---|
| mic 1..5 | 14000 | 4000 (D) | — (members of the windowed stack) |
| drums stack | 14000 | 1000 (window) | 1000 |
| island | — | 1000 | — |

Render check at `t0`: `inner = 1000 + ((15400 − 14000 − 1000) mod 1000)
= 1400` — the sample that was sounding keeps sounding. No rider touched
the mics individually; they moved because their parent moved.

Second arm (lock-collapse): each mic `base += 1000, D := 1000`;
`shiftOrigins(stack, +1000)` → mics and stack at `15000 = epoch`; stack
window consumed. The island is an ordinary whole-Q looper.

### G-2. The drum group as a one-shot (Q18's motivating case)

Locked 4Q island: bass loop (`O = 0`, D = 4000). Drums group (three
mics, one 2Q take at `O_s = 2000`), set `periodSource = context`.

| node | origin | intrinsic | periodSrc | contributes to parent |
|---|---|---|---|---|
| bass | 0 | 4000 | own | 4000 |
| drums stack | 2000 | 2000 | context | — (excluded) |
| island | — | cycle 4000 | | |

Context cycle for the drums' scope = `lcm(Q, 4000) = 4000`. Drums
render while `h = (t − 2000) mod 4000 < 2000`, i.e. at island phases
`[2000, 4000)`, silent at `[0, 2000)`: they fire once per bar from the
moment they were performed. Display: dashed group tile at `2Q`, no
ghosts, mics drawn whole beneath. Trimming the drums' window to
`[500, 1500)` fires the window segment once per cycle at `O_s + 500`.

---

## 8. What Q18 deletes

- `AudioEngine::epochViewStep` and both rider branches that step by it.
- `Edit::origins` riders on definer trims (the recursive shift is the
  edit's own origin field applied to a subtree).
- The definer-STACK twins of `setLoopPoints`, `setSegments`, Remove
  re-open, Insert re-collapse, arm-time collapse, `Edit::CollapseGroup`,
  `collapseGroupNow` / `uncollapseGroupNow`, `collapseToWindow(shift_origin=false)`.
- `heard::memberHeardIndex`'s second law (the group equation is the node
  equation composed).
- "CLIPS ONLY" in `setPeriodSource`; "a stack has no origin to anchor a
  firing to" (tasks.md); "groups tile from frame 0 — a composite is not
  a performance" (ui_overhaul law 9); "no origin re-anchor" (Q13 for
  groups).
- The `context_loop` carve-out "nested stacks contribute 0": a stack
  contributes its intrinsic duration like a clip.

---

## 9. Display twins

- **Group lanes get a take mark.** A stack's lane x is
  `(origin − epoch) mod frame`, exactly a clip's `takeStartQ`. Brackets
  and cut bands on a group lane are INNER positions offset by that mark.
- **Composite waveform** is unchanged: it already mixes each member's
  audible content at the member's own origin.
- **One-shot groups** draw as one-shot clips do: dashed composite tile,
  no ghost repetitions, members whole beneath.
- **Mock parity**: `mock/maps.js` and `mock/recording.js` carry the
  same anchoring events; `view_model.js` reads `origin` on stacks and
  never derives it.
