# The Cyclic Kernel

> Written 2026-07-07, companion to `design_language.md`. This is the
> answer to "is there a simplified kernel that would make everything
> sing?" — and I believe the answer is yes, it's small, and the codebase
> has been converging on it all week without naming it.
>
> Status: **proposal** — with the underlying principles ratified by the
> owner on 2026-07-07 (see design_language.md §5):
>
> - **Q2 ruling** — Audio Memory is the *sole* timing principle; the LCM
>   is display machinery. The kernel's playback equation is a direct
>   transcription of that ruling, and the LCM correctly appears only in
>   UI derivations (§2 table), never in engine state.
> - **Q1 ruling** — "the DNA of the original scratch track remains": Q
>   and the island epoch survive their creating clip, which is exactly
>   why they live at the island root (§2, §4) instead of being derived
>   from surviving children.
> - **Q4 ruling** — collapse is display-only (I6b). §2's collapse
>   time-map therefore must be re-keyed from "is the stack collapsed" to
>   an explicit window active/bypassed state when the loop-window
>   redesign lands; the map math is unchanged.
> - **Q8** — resolved by principle: the transport simplification in §3
>   is an internal mechanism choice, valid iff I1 holds (it does, by
>   construction).
> - **Q9 (origin units under warp)** — deferred by owner until "warp"
>   is a real concept; §6's first risk stays open and gates step 2 of
>   the migration.

---

## 1. The problem, stated as a state inventory

What the engine currently stores *per clip* to answer one question —
"where does this content belong in time?":

| Field | Set when | Consumed by |
|---|---|---|
| `trigger_master_position` | record start | commit anchor math |
| `recording_start_phase` | record arm | launch-point calculation |
| `anchor_phase_samples` | arm + commit | UI marker, one-shot logic |
| `launch_point_samples` | commit | playback offset, playhead |
| `rotation_offset_` / `rotation_span_` | commit | playback + waveform reads |
| `x_pos` | arm + commit (in pixels!) | UI lane position |

Six encodings of **one musical fact**. They are computed at different
moments (arm vs commit), from different inputs (`compensated_pos` vs
`trigger % context_loop`), in different frames (performance, master,
pixels). Every documented bug class — cursor jumps, ghost misalignment,
waveform vibration, the first-clip reset, this week's visual/audio
mismatch — is a pair of these encodings disagreeing. The refactoring
proposal treats the symptoms (P0-3 stores Q, P0-4 tames the transport);
the kernel removes the disease.

On top of that, the engine stores *global* mutable time: a transport
that wraps at LCM, resets on first clip, snaps on LCM growth, and
deliberately doesn't snap on polyrhythmic growth — ~120 lines of the
highest-churn code in the callback (P0-4's motivation).

## 2. The kernel

Three definitions and two equations.

**Time.** One monotonic clock `t` per engine (the input clock built for
the pre-record ring is exactly this). It never wraps, never resets, and
is never mutated by musical events. Everything cyclic is a *derived
view*: `phase(t, period, epoch) = (t − epoch) mod period`.

**Node.** Every node is `(content, period, origin)`:

- `origin` — the moment on the master clock its content belongs to
  (design_language.md: the performance-time of `content[0]`).
- `period` — how often it recurs. A looping clip: its own length. A
  one-shot: its context's cycle. A composite: LCM of children periods.
  A windowed composite: its window length.
- `content` — samples (leaf) or children (composite).

**Playback** is one equation applied recursively:

```
out(node, t) = content[(t − origin) mod period]            — leaf
out(node, t) = Σ out(child, m(t))                          — composite
```

where `m` is the node's **time-map** — identity for an expanded stack,
`m(t) = window_start + ((t − collapse_epoch) mod window_len)` for a
collapsed one. Time-maps are the only mechanism that ever transforms
time, and they compose by nesting.

**Recording** is the same equation run backwards:

```
content[i] ← input(origin + i + C)        (C = calibrated round trip)
```

which is precisely the arrival-time capture window implemented this week
(performance.md §3) — the pre-record ring gives `input()` as a random-
access function of the recent past. Commit does exactly two things: snap
`length`, choose `period`.

That's the whole kernel. Everything else in the current model is a
projection of it:

| Today's concept | Kernel derivation |
|---|---|
| launch point | `(−origin) mod period` |
| anchor phase | `origin mod Q` (or mod context cycle) |
| virtual rotation | gone — content is stored in origin frame; reads need no remap |
| `x_pos` | `f(origin)` in the UI (I6), e.g. `(origin mod cycle)/Q · 200px` |
| playhead % | `phase(t, period, origin) / period` |
| ghost tiles | occurrences of `[origin + k·period, +length)` within the cycle |
| one-shot vs loop | `period := context cycle` vs `period := length` (a knob, not a formula) |
| loop window | `period := window_len`, content offset by `window_start` |
| internal transport | `t − collapse_epoch` (derived; the stored counter disappears) |
| stored Q (P0-3) | `island.Q`, one field at the island root |
| "island" | the scope sharing `(Q, epoch)` |

One stored `origin` per clip replaces six fields, and every alignment
invariant (I1–I4, I6) becomes true *by construction*: there is nothing
to drift because there is nothing derived-but-stored.

## 3. The transport dissolves

The P0-4 state machine was going to tame the transport branch-pile.
Under the kernel, each branch is examined and found to be compensating
for mutable global time:

| Current branch | Why it exists | Kernel replacement |
|---|---|---|
| Wrap `master_pos` at LCM | bounded counter for UI % math | UI derives `t mod LCM`; engine never wraps |
| Reset to 0 on first clip | so clip 1's math sees zero | clip 1 gets `origin := t_start`; nothing global moves |
| Snap to 0 when LCM grows | new longer clip would start mid-phase | new clip's `origin` IS its start; `(t − origin)` is continuous through commit by definition |
| Don't snap on polyrhythmic growth | snap would jump the cursor | nothing snaps, so nothing to suppress |
| `last_recording_duration_` guess | reconstruct "where were we" after mutation | `t` never mutated; nothing to reconstruct |

The recording lifecycle still deserves an explicit little state machine
(`Idle → Armed(origin) → Capturing → PendingStop(boundary) →
Committed`) — that part of P0-4 survives — but it becomes a *per-clip*
machine over an immutable clock, trivially unit-testable, with the
commit event carrying `origin` + `length` and nothing else. The
docs' scenario tables in recording.md map 1:1 onto golden vectors for it.

Sanity checks against the canonical examples (recording.md):

- **Example 2** (8Q recorded at 2Q in a 4Q context): `origin = 2Q`.
  Launch derives to `(−2Q) mod 8Q = 6Q` ✓ matches the documented value.
  x derives to `2 slots` ✓. No rotation ever computed.
- **LCM ghost extension** (4Q take in an 8Q context): commit changes no
  other node's `(origin, period)` → I4 holds with zero code.
- **Polyrhythmic 3Q into 4Q**: cycle view lengthens to 12Q; `t` sails on
  monotonically; the cursor "continues from 7Q" because nothing happened.

## 4. What it buys the roadmap

- **Save/Load (Segment 6):** the persistent state per clip is
  `{origin, length, period-source, window, buffer}` plus island
  `{Q, epoch}`. The serialization format writes itself.
- **Warp (Segment 8):** a rate-changing time-map
  `m(t) = origin + r·(t − origin)` — the same primitive as collapse,
  not a new subsystem. (Precondition: Q9 in design_language.md — store
  origins in Q-rationals, or warp breaks sample-anchors.)
- **Connections (Segment 9):** serial composition = a time-map that
  re-bases epochs per traversal (`branch-with-chance` = choosing which
  child's map is active this cycle). Parallel and serial finally share
  one algebra.
- **Multi-range loops (Segment 7):** a piecewise time-map over the
  window list. Conservation-of-loop-length (design.md) is a constraint
  on the pieces, checked in one place.
- **Islands:** an island is literally `(Q, epoch)` at a subtree root —
  the object P0-3 was looking for a home for.
- **View-model refactor (P2-10):** `deriveViewModel` becomes a direct
  transcription of §2's table — the UI never invents timing again.

## 5. Migration path (incremental, each step shippable)

The kernel is adoptable without a rewrite; most steps are deletions.

1. ✅ **Done (2026-07-07): Q + epoch stored at the island root** (= P0-3).
   `StackNode::quantum_samples_`/`epoch_samples_`, set once at first
   commit (or when committed content enters an empty island), never
   derived again. Q survives its creator (owner ruling): a shorter
   Q/2-snapped overdub no longer halves Q, and deleting the
   establishing clip leaves Q intact — both now pinned by unit tests.
   `getIntrinsicDuration()` on stacks is now composite duration
   (LCM of children, per recording.md) instead of the min.
2. ✅ **Done (2026-07-07): `origin` introduced** — `recording_start_phase`
   renamed to `origin_samples` (it already held the right value at arm
   time); playback derives launch per block via
   `timing::launchPointFor(origin, dur)`; `launch_point_samples` kept as
   a derived stored field for UI/metadata compat; **rotation deleted
   entirely** (it double-shifted playback on top of the launch point,
   contradicting recording.md Example 2 — the origin equation produces
   the documented behavior directly); waveforms read the raw buffer;
   `origin` exposed in metadata (C++ and mock). Remaining consolidation:
   `trigger_master_position` (feeds the x/slot math until P1-7) and
   `commit_master_pos` (transport bookkeeping until step 3).
   *(Guarded by the "Origin Alignment" unit test + full suite.)*
   **Correction (same day):** the origin must be stored **absolute**, not
   mod the context loop. The mod truncated which-cycle-of-the-context a
   take began in, which is invisible while a transport snap rebases the
   clock — and broke clips longer than their context once the transport
   went monotonic (field: 4Q take over a 1Q groove looped at 3Q).
   `launchPointFor` mods by the final duration, so the absolute value is
   always safe to store.
3. ✅ **Done (2026-07-07): monotonic master.** The transport only moves
   forward; the LCM wrap, LCM-growth snap, polyrhythm suppression
   branch, first-clip-snap early return, and the
   `lcm_before_recording_`/`last_recording_duration_` bookkeeping are
   all deleted (~90 lines from the callback). `masterPos` in
   `getGraphState` is a derived view: `t mod LCM` normally, frozen-base
   + linear growth while recording (so the cursor extends past the
   committed LCM per recording.md). ~~The once-per-island first-clip
   reset is retained — it IS the epoch capture, occurring before any
   content exists.~~ **Completed 2026-07-16 (unification_audit.md
   §1.1): the last two clock mutations are gone.** The first-clip
   reset was replaced by actual epoch capture — the first arm stores
   its moment as the island epoch (data), the clock untouched — and
   the stop-reset in `togglePlayback` by pause/resume (stop freezes
   the view, play resumes the phase; restart-from-top, if ever wanted,
   is a root time-map — tasks.md open question 8). §2's "never wraps,
   never resets, never mutated" now holds without exceptions; pinned
   by `tests/monotonic_clock_tests.cc`. The old "LCM Expansion Snap" survives as an **island
   epoch re-base**: at commit, if the cycle grew as a simple extension,
   the island epoch (root stack) moves to the newest committed origin so
   the cycle top is the new phrase's top — clock and audio untouched;
   polyrhythmic expansions keep the old epoch (cursor sails on, per
   recording.md).
   **One-frame rule (field-hardened):** every cycle-relative projection
   — the UI view AND the clip arm/commit math (anchors, slots, effective
   positions) — must be computed relative to `getIslandEpoch()`. Mixing
   absolute-frame math with the epoch-rebased view re-split audio from
   visuals (field: "clip 3 anchored at 3Q instead of 0Q"). Bonus of the
   epoch frame: every committed sibling's phase is simply
   `rel mod duration` (committed origins are ≡ epoch mod their
   durations), which deleted the arm-path sibling launch-point scans and
   playback offsets — a piece of P1-6 landed early. Also landed with step 1: island Q + epoch
   stored at the root (`StackNode::setQuantum`), established at first
   commit or when committed content enters an empty island; composite
   duration corrected from min-of-children to LCM-of-children.
4. **Time-maps** — 🔶 in progress: **phase 1 done (2026-07-09,
   time_maps.md)** — loop windows are the first named time-map
   (`(t − cycle_epoch) mod len` via `ProcessContext.cycle_epoch`;
   `internal_transport_` deleted; activation is data, collapse purely
   visual). Remaining: recording-through-map (phase 2), non-contiguous
   segments + cell/punch editor (phase 3); warp and serial connections
   later reuse the same primitive.

Estimated end-state deletions: the six-field clip timing block, the
rotation machinery, the transport branch-pile, `internal_transport_`,
and most of `clip_node.cc`'s arm-time context scanning (P1-6 falls out —
the parent computes the context once and passes it down).

## 6. Risks and open questions

- **Q-rational vs sample origins** (design_language.md Q9): decide
  before step 2; retrofitting units is the expensive path.
- **Origin of the first clip** defines the island epoch; deleting that
  clip must not orphan the epoch (same policy question as Q1's stored-Q
  orphan).
- **int64 monotonic time** at 48 kHz overflows after ~6 million years;
  no action required, but wrap-view math must use the epoch-relative
  form to keep intermediates small.
- **Behavioral diffs during migration**: the current LCM-snap produces a
  *user-visible* cursor jump-to-zero in the simple-extension case; the
  kernel produces continuous motion instead. recording.md's examples
  actually specify the continuous behavior ("the playhead does NOT loop
  back"), so this is a doc-compliant change — but it will *feel*
  different from today's app and should be field-tested (clap test +
  dump, as usual).
