# The Cyclic Kernel

> Status: **spec — implemented.** One monotonic clock, one playback
> equation, one stored `origin` per clip. Companion to
> `design_language.md`; the recursive composition of nested nodes is
> composition.md.
>
> **Section numbers are API.** `src/`, `tests/` and `ui/js/` cite
> `kernel.md §2` and `§3` from code comments, as `.agent/style.md`
> requires. Renumber nothing without fixing the callers
> (`grep -rn 'kernel.md §' src tests ui/js docs`).
>
> §6 records what the kernel replaced and the designs rejected on the
> way. It is the only backward-looking section.

**Contents**

1. [The problem it solves](#1-the-problem-it-solves)
2. [The kernel](#2-the-kernel)
3. [The transport and the recording lifecycle](#3-the-transport-and-the-recording-lifecycle)
4. [What it buys the roadmap](#4-what-it-buys-the-roadmap)
5. [Migration record](#5-migration-record)
6. [Appendix — what the kernel replaced](#6-appendix--what-the-kernel-replaced)

---

## 1. The problem it solves

One musical fact — *where does this content belong in time?* — used to
be stored six ways per clip, computed at different moments, from
different inputs, in different frames (performance, master, pixels).
Every documented bug class of that era — cursor jumps, ghost
misalignment, waveform vibration, the first-clip reset, visual/audio
mismatch — was a pair of those encodings disagreeing.

The kernel stores the fact **once**. There is nothing to drift because
there is nothing derived-but-stored. §6 lists what went.

---

## 2. The kernel

Three definitions and two equations.

**Time.** One monotonic clock `t` per engine — the same clock the
pre-record ring is built on. It never wraps, never resets, and is never
mutated by musical events. Everything cyclic is a *derived view*:
`phase(t, period, zero) = (t − zero) mod period`.

**Node.** Every node is `(content, period, origin)`:

- `origin` — the moment on the master clock its content belongs to
  (design_language.md: the performance-time of `content[0]`). Stored
  **absolute**, never mod the context loop.
- `period` — how often it recurs, in precedence: **active map period ▸
  active sequence length ▸ LCM of the children's effective periods**
  (sequencer.md §2; `AudioNode::getEffectivePeriod`). A looping clip:
  its own length. A one-shot: its context's cycle.
- `content` — samples (leaf) or children (composite).

**Playback** is one equation applied recursively:

```text
out(node, t) = content[(t − origin) mod period]            — leaf
out(node, t) = Σ out(child, m(t))                          — composite
```

where `m` is the node's **time-map** — identity for a node with no
active map, and for a node with an ACTIVE map, one law for clips and
stacks alike, anchored at the node's OWN origin (Q18,
composition.md §2):

```text
inner(t) = mapOffset((t − origin − a0) mod period)     a0 = mapOffset(0)
m(t)     = origin + inner(t)
```

Activation is data, independent of collapse (I6b). **Time-maps are the
only mechanism that ever transforms time, and they compose by
nesting.**

**Recording** is the same equation run backwards:

```text
content[i] ← input(origin + i + C)        (C = calibrated round trip)
```

which is the arrival-time capture window (performance.md §3) — the
pre-record ring gives `input()` as a random-access function of the
recent past. Commit does exactly two things: snap `length`, choose
`period`.

That is the whole kernel. Everything else is a projection of it:

| Concept | Kernel derivation |
|---|---|
| launch point | `(−origin) mod period` |
| anchor phase | `origin mod Q` (or mod context cycle) |
| `x_pos` | `f(origin)` in the UI (I6), e.g. `(origin mod cycle)/Q · 200px` |
| playhead % | `phase(t, period, origin) / period` |
| ghost tiles | occurrences of `[origin + k·period, +length)` within the cycle |
| one-shot vs loop | `period := context cycle` vs `period := length` — a knob, not a formula |
| loop window | `period := window_len`, content offset by `window_start` |
| stored Q | `island.Q`, one field at the island root |
| "island" | the scope sharing `(Q, zero)` |

Every alignment invariant (I1–I4, I6) is true **by construction**.

### The one-frame rule (field-hardened)

Every cycle-relative projection — the UI view AND the clip arm/commit
math (anchors, slots, effective positions) — is computed relative to
`getIslandZero()`. Mixing absolute-frame math with the zero-rebased
view re-splits audio from visuals.

A bonus of the island frame: every committed sibling's phase is simply
`rel mod duration`, because committed origins are ≡ zero mod their
durations. That deleted the arm-path sibling launch-point scans and the
playback offsets entirely.

---

## 3. The transport and the recording lifecycle

**The transport only moves forward.** `masterPos` in `getGraphState` is
a derived view: `t mod LCM` normally, frozen-base + linear growth while
recording, so the cursor extends past the committed LCM. The clock
itself is never wrapped, reset, or snapped — pinned by
`tests/monotonic_clock_tests.cc`.

**The island zero is data, not the clock.** The first arm stores its
moment provisionally and the first commit makes the take's origin the
island zero (`islandZero` in code); stop freezes the view and play
resumes the phase. No commit moves it (`StackNode::takeCommitted`):
where a new take sits on screen is the view's seating from the lanes
(frame.md), which puts it in the cycle it started in without anything
here moving. Each take stores its heard frame (`contextCycle`) for
display take-marking (Q14).

**The recording lifecycle is an explicit per-clip state machine** over
that immutable clock — `ClipNode::RecState`, where Committed is
Idle-with-content:

```text
Idle → Armed(origin) → Capturing → PendingStop(boundary) → Committed
```

The arm-target math is pure in `timing.h` (`armTarget`,
`inAnticipatoryWindow` — both golden-vectored, both zero-frame), and
stop boundaries are chosen by the audio thread from its own write
position. The commit event carries `origin` + `length` and nothing
else. recording.md's scenario tables map 1:1 onto golden vectors for
it.

### Sanity checks against the canonical examples

- **Example 2** (8Q recorded at 2Q in a 4Q context): `origin = 2Q`.
  Launch derives to `(−2Q) mod 8Q = 6Q` ✓ matches the documented value.
  x derives to 2 slots ✓. No rotation is ever computed.
- **LCM ghost extension** (4Q take in an 8Q context): commit changes no
  other node's `(origin, period)`, so I4 holds with zero code.
- **Polyrhythmic 3Q into 4Q**: the cycle view lengthens to 12Q and `t`
  sails on monotonically. The cursor continues because nothing
  happened to the clock — and it is the *watched* cursor that
  continues, since the view seats the take in the cycle it started in
  (frame.md; Q14b).

---

## 4. What it buys the roadmap

- **Save/Load:** the persistent state per clip is
  `{origin, length, period-source, window, buffer}` plus island
  `{Q, zero}`. The serialization format writes itself.
- **Warp:** a rate-changing time-map `m(t) = origin + r·(t − origin)` —
  the same primitive, not a new subsystem. Q12's rational `QTime`
  removed its blocker.
- **Connections:** serial composition is a time-map that re-bases
  zeros per traversal, and branch-with-chance is choosing which
  child's map is active this cycle. Both shipped as cue steps and
  successor graphs (sequencer.md §13, §14). Parallel and serial share
  one algebra.
- **Multi-range loops:** a piecewise time-map over the window list
  (time_maps.md). Conservation-of-loop-length is a constraint on the
  pieces, checked in one place.
- **Islands:** an island is literally `(Q, zero)` at a subtree root.
- **The view model:** `deriveViewModel` is a direct transcription of
  §2's table — the UI never invents timing.

---

## 5. Migration record

All four steps complete; the estimated end-state deletions all landed.

| Step | What it did |
|---|---|
| 1 ✅ 2026-07-07 | **Q + zero stored at the island root** (`StackNode::quantum_samples_` / `zero_samples_`), set once at first commit and never derived again. Q survives its creator: a Q/2-snapped overdub no longer halves Q, and deleting the establishing clip leaves Q intact. Composite duration corrected from min-of-children to LCM-of-children. |
| 2 ✅ 2026-07-07 | **`origin` introduced**, playback deriving launch per block via `timing::launchPointFor(origin, dur)`; rotation deleted entirely. Consolidation completed 2026-07-16: `launch_point_samples`, `anchor_phase_samples` and `trigger_master_position` deleted, `launchPoint` derived at read time, the pixel x/slot math out of C++ entirely. **One stored `origin` per clip**, as §2 specifies. |
| 3 ✅ 2026-07-07 | **Monotonic master** — the LCM wrap, LCM-growth snap, polyrhythm suppression, first-clip-snap and the `lcm_before_recording_` / `last_recording_duration_` bookkeeping all deleted (~90 lines from the callback). Completed 2026-07-16: the last two clock mutations went, so §2's "never wraps, never resets, never mutated" holds without exception. |
| 4 ✅ 2026-07-09/21/22 | **Time-maps** — phase 1 (loop windows, `internal_transport_` deleted), phase 2 (recording through an active map on the reified `TimeMap`), phase 3 (multi-segment maps, fully fractal). See time_maps.md. |

As of 2026-07-16 the clip's timing state is exactly `origin`; the clock
is never mutated; the recording lifecycle is an explicit state machine;
commits are events handled by the island root; traversal is cast-free;
and context flows down through `ProcessContext`.

---

## 6. Appendix — what the kernel replaced

Kept so it is not re-proposed, and so the shape of the old code is
legible to anyone reading history.

**The six-field clip timing block.** Per clip, the engine stored
`trigger_master_position` (record start → commit anchor math),
`recording_start_phase` (arm → launch-point calculation),
`anchor_phase_samples` (arm + commit → UI marker, one-shot logic),
`launch_point_samples` (commit → playback offset, playhead),
`rotation_offset_` / `rotation_span_` (commit → playback and waveform
reads), and `x_pos` — *in pixels* — (arm + commit → UI lane position).
Six encodings of one fact. **Replaced** by one stored `origin`; every
consumer became a derivation (§2's table).

**Virtual rotation.** Content was stored rotated and un-rotated on
read. **Deleted:** it double-shifted playback on top of the launch
point, contradicting recording.md Example 2. Content is stored in the
origin frame, and reads need no remap.

**Origin stored mod the context loop.** Tried on the day origin was
introduced. **Corrected the same day:** the mod truncated which cycle
of the context a take began in — invisible while a transport snap
rebased the clock, and broken once the transport went monotonic (field:
a 4Q take over a 1Q groove looped at 3Q). `launchPointFor` mods by the
final duration, so the absolute value is always safe to store.

**The mutable-transport branch pile.** ~120 lines of the
highest-churn code in the callback, each branch compensating for
mutable global time:

| Branch | Why it existed | What replaced it |
|---|---|---|
| Wrap `master_pos` at LCM | a bounded counter for UI % math | the UI derives `t mod LCM`; the engine never wraps |
| Reset to 0 on first clip | so clip 1's math saw zero | clip 1 gets `origin := t_start`; nothing global moves |
| Snap to 0 when LCM grows | a new longer clip would start mid-phase | the new clip's `origin` IS its start, so `(t − origin)` is continuous through commit by definition |
| Don't snap on polyrhythmic growth | the snap would jump the cursor | nothing snaps, so there is nothing to suppress |
| `last_recording_duration_` guess | reconstruct "where were we" after mutation | `t` is never mutated; there is nothing to reconstruct |

**The once-per-island first-clip clock reset.** Retained through step 3
as "it IS the zero capture". **Replaced 2026-07-16** by actual zero
capture — the first arm stores its moment as data, the clock untouched
— and the stop-reset in `togglePlayback` by pause/resume.

**Restart-from-top is not an engine concept.** `togglePlayback` is a
pure pause/resume and the clock is never reset; what a user experiences
as "play from the top" is UI policy composed over `togglePlayback` +
`seekTransport` (session_view.md display law 15). If restart-from-top
were ever wanted *in the engine*, it would be a root time-map — the
same primitive as everything else that transforms time — not a second
clock mutation.

**Polyrhythmic expansions keeping the old zero** ("the cursor sails
on"). **Refined 2026-07-16** after the field report that a 5Q take
teleported to 12Q of an exploded 20Q frame: every cycle growth moved
the stored zero to the take's heard top. **Superseded 2026-09-16:** the
zero is no longer stored or moved; the view seats the take in the
cycle it started in (frame.md). The "cursor sails on" intent survives —
it is the watched cursor that sails on.

**Loop-on-collapse as the playback equation's map.** The original §2
keyed `m` to whether a stack was collapsed. **Convicted by I6b**
(2026-07-09): a view action must not change the sound. Activation
became data. The zero-anchored stack form that replaced it was itself
**retired by Q18** (2026-09-01) — a stack now stores an origin like a
clip, so there is one anchoring law (time_maps.md §8 carries that
entry).

**Risks that resolved.** Q9, "store origins in Q-rationals or warp
breaks sample-anchors", gated step 2 until **Q12** adopted rational
`QTime` (2026-07-16) and nothing gated the migration. "Deleting the
first clip orphans the zero" resolved under Q1/Q13 — Q and zero
survive their creating clip, and re-open when the island falls back to
one committed clip. int64 monotonic time at 48 kHz overflows after ~6
million years; no action required, though wrap-view math uses the
zero-relative form to keep intermediates small.
