# Recording: Design & Math

> Status: **spec** — the worked examples here are executable
> (shared/timing_golden.json pins them in both C++ and JS).

## Core Philosophy: Audio Memory Principle
> Recorded audio must always play back aligned with the audio the performer heard during recording. The performer's timing is relative to what they heard—this relationship is sacred.

> [!IMPORTANT]
> **Principle hierarchy (owner ruling 2026-07-07):** Audio Memory is the
> *only* timing principle. Everything else in this document — LCM
> timelines, quantum snapping, anchors, launch points, ghosts — is
> downstream machinery in service of it, or of making it visually
> legible. The one sanctioned exception: explicit edits (dragging clips,
> changing launch points or loop windows) are the user deliberately
> decoupling a performance from its recorded context.
> See `design_language.md` (invariants I1–I8) for the full statement.

---

## Visual Feedback During Recording

### Quantum Grid Marks ✨
While recording Clip 2+, faint vertical lines appear at each Q boundary:
- Shows exactly where quantum boundaries are relative to your recording
- Helps you see if you're approaching a clean stop point
- Only visible when `effectiveQuantum` is established (Clip 1 defines Q)

### Orange Launch Marker

> **SUPERSEDED (session view, 2026-07-09; `anchorPhase` deleted
> 2026-07-16).** There is no launch marker in the session view: a
> clip's tiles sit at their origin phase on the shared time axis, which
> IS the information the marker carried. Launch point derives at read
> time (`(−origin) mod period`).

~~Shows where playback will start for clips recorded mid-loop:~~
- ~~Only appears when `anchorPhase > 0`~~
- ~~Position = `(launchPoint / duration) * 100%`~~
- ~~Hidden for clips recorded at 0Q (anchor=0)~~

---

## Quantum Fundamentals

### Establishing Quantum (Q)
The **first recorded clip** establishes the quantum:
- `Q = first_clip.duration` (in samples)
- All subsequent clips are measured/aligned relative to Q
- Quantum represents "one bar" or "one loop" of the rhythmic grid

> [!IMPORTANT]
> **Q survives its creator (owner ruling 2026-07-07).** The first take
> sets the groove; muting or even deleting it must NOT change Q — "the
> DNA of the original scratch track remains." Q is island state, not a
> derivation from surviving clips. (The current implementation derives Q
> from the minimum child duration, so deleting/shortening clips silently
> changes it — that is a confirmed bug, fixed by refactoring_proposal.md
> P0-3 storing Q explicitly.)

---

## Islands (Songs) and Quantum Inheritance

### The Islands Model
An **Island** is a group of connected stacks that share a common quantum (Q). Think of each island as a separate "song" that can coexist on the same canvas.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Island A (Q = 44100 samples ≈ 1 second @ 44.1kHz)                   │
│                                                                      │
│   ┌─────────────┐     ┌─────────────┐                               │
│   │   Stack 1   │────▶│   Stack 2   │   (connected = same Q)        │
│   └─────────────┘     └─────────────┘                               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Island B (Q = 88200 samples ≈ 2 seconds @ 44.1kHz)                  │
│                                                                      │
│   ┌─────────────┐                                                    │
│   │   Stack 3   │   (independent = own Q)                           │
│   └─────────────┘                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Quantum Inheritance Rules

1. **New stack, connected before recording**: Inherits Q from the connected stack
   - User creates Stack B, connects it to Stack A
   - Stack B inherits Stack A's quantum
   - Both stacks are now part of the same island

2. **New stack, first clip recorded without connection**: Establishes its own Q
   - User creates Stack C, immediately records a clip
   - The clip's duration becomes Stack C's quantum
   - Stack C becomes a new island

3. **Connecting after Q established**: Not yet defined (potential polyrhythmic interaction)

### Per-Stack LCM

Within each stack, the **LCM (Least Common Multiple)** of all clip durations determines the timeline length for that stack:

```javascript
stack.timelineLength = LCM(clip1.duration, clip2.duration, ..., clipN.duration)
```

This LCM is calculated **per-stack**, not globally. Different stacks in the same island share Q but may have different LCMs based on their clip compositions.

**Example:**
```
Island A (Q = 1 second):
├── Stack 1: clips of 1Q, 4Q     → LCM = 4Q
├── Stack 2: clips of 2Q, 3Q     → LCM = 6Q
└── Stack 3: clips of 1Q, 2Q, 4Q → LCM = 4Q
```

### Nested Stacks and Composite Duration

When a stack is nested inside another stack, its **internal LCM becomes its composite duration** for the parent's LCM calculation:

```
Outer Stack:
├── Clip 1 (4Q)
├── Inner Stack (internal LCM = 6Q) ← contributes 6Q to outer LCM
│   ├── Clip 2 (2Q)
│   └── Clip 3 (3Q)
└── Outer LCM = LCM(4Q, 6Q) = 12Q
```

### Clip Types
1. **Looping Clips**: period = own duration → clip loops continuously
2. **One-Shot Clips**: period = **context cycle** → plays once when the
   LCM playhead crosses its anchored location, then rests until the next
   cycle. *(Owner-ratified definition 2026-07-07, replacing a garbled
   formula — design_language.md Q5.)*

---

## Key Data Points

*(Table trued 2026-09-01. `launch_point_samples`, `anchor_phase_samples`
and `trigger_master_position` were deleted 2026-07-16 — kernel.md §5
step 2; `launchPoint` in metadata derives at read time.)*

| Field | Description | Set When |
|-------|-------------|----------|
| **`origin`** | **THE canonical timing fact** (kernel.md): the absolute performance moment the clip's `content[0]` belongs to (samples on the monotonic clock; QTime offset from the island epoch in the save format, Q12). Every other timing quantity — launch point `(−origin) mod period`, tile x, playhead — is a projection of it. | Recording arms (folded per Q15 / re-anchored per Q13 at edits) |
| `duration` | Total clip length, samples (heard-time snap to the next boundary; live written length while recording) | Recording commits |
| `periodSource` | `own` (loops at `duration`) or `context` (one-shot: period = the context cycle, Q5) — a knob, not a formula | Default `own`; the ↺/1× chip toggles it (undoable) |
| window / map | The node's time-map: single-segment loop points (`loop_start/end` + bypass flag) or a multi-segment `segments` override; active iff valid and not bypassed (time_maps.md). Periods are whole multiples or exact divisors of Q (engine_lcm_guard.md) | Commit sets the full span; edits thereafter |
| `contextCycle` | The heard frame the take was performed against (effective island cycle at arm) — the fold modulus for take marking (Q14b) | Recording arms |
| buffer | The content: a dense sample buffer in origin frame (no rotation, no remap); immutable after commit | Recording commits |

Island facts `(Q, epoch)` live once, at the session root (Q1, Q13).

### The Epoch Frame (one frame for everything)

All cycle-relative reasoning — anchors, slots, effective positions, the
UI's masterPos view — happens in the **island epoch frame**:
`rel = t − island_epoch`. The epoch re-bases to the newest
cycle-defining origin on simple-extension commits (the visual successor
of the old transport snap), and windowed stacks re-base it again for
their children (time_maps.md). Mixing absolute-frame math with the
epoch frame has caused field bugs; don't.

**Why loop-relative intent?**
- You might listen to Clip 1 looping for 5 minutes before recording Clip 2
- The monotonic clock keeps ticking, but your INTENT is relative to the cycle you hear
- Pressing record near the END of the cycle means the upcoming top (Q11 ruling: the arm target is always the next Q boundary in the epoch frame — the cycle top is just what that boundary is in the final Q)

**Formula (current, epoch-relative — sibling launch offsets are gone;
in the epoch frame every committed sibling's phase is simply
`rel mod duration`):**
```cpp
rel           = compensated_pos - island_epoch
effective_pos = rel % context_loop          // what the user perceived
next_q_rel    = snap-forward-to-Q(...)      // Q11: next boundary
origin        = island_epoch + next_q_rel   // stored ABSOLUTE
```

---

## X-Offset Calculation

### Goal
Position clip so its **left edge** is at the horizontal position where the user started recording, **relative to the existing context**.

### Core Concept: Context Loop
When a clip starts recording, the **context loop** = longest existing clip's duration.
- If no clips exist → context_loop = Q (quantum, defined by first clip)
- If Clip 1 = 1Q, Clip 2 = 4Q exist → context_loop = 4Q

### Formula (calculated in C++ at recording start — epoch frame)
```cpp
context_loop   = max(longest_sibling_duration, Q)
rel            = compensated_pos - island_epoch
next_q_rel     = snap rel forward to the next Q boundary (Q11)
slot           = (next_q_rel % context_loop) / Q
x_pos          = base_x + slot * base_width
anchor_phase   = (next_q_rel % context_loop) % Q
origin         = island_epoch + next_q_rel   // absolute; launch derives
```
No sibling launch-point offsets: in the epoch frame every committed
sibling plays phase `rel mod duration`, so "what the user perceived" is
just `rel % context_loop`.

### Key Insight
The **context_loop determines wrapping behavior**:
- Recording at end of 1Q loop (0.97Q) → anchor = 0.97Q in context 1Q
- Recording at 2Q in 4Q context → anchor = 2Q

### Architecture: C++ Owns the Data
- **C++** calculates `x_pos` at recording start and stores it
- **JS** displays `node.x` directly with NO transformation

---

## Slot Positioning (Visual X-Offset)

### Concept: Quantum Slots
When a clip starts recording, it is placed at a **slot** in the visual timeline. Each slot represents one quantum (Q) width.

```
Slot:      |  0  |  1  |  2  |  3  |  4  | ...
Position:  0Q   1Q   2Q   3Q   4Q   5Q
```

### Formula
```cpp
next_q_boundary = ceil(current_master_pos / Q) * Q  // Next Q boundary after record pressed
slot = next_q_boundary / Q
x_pos = base_x + slot * base_width
```

### Slots Are Cycle-Relative (superseded "No Modulo" rule)

> **Superseded (2026-07-07).** An earlier version of this section
> prescribed the raw absolute slot (`next_q / Q`, no modulo) to make a
> single-clip context "extend the timeline." Two things killed it:
> (1) it contradicted this document's own Example 4 (mid-loop record in
> a 1Q context → boundary ≡ 0 mod context → anchor 0, x 0) and
> invariant I2 (audio anchored at cycle 0 must draw at x 0 — the old
> commit-time x converged to 0 anyway, so the absolute arm-time slot was
> a transient visual/audio mismatch); and (2) under the monotonic
> transport (kernel.md step 3) the absolute master grows without bound,
> so the raw slot pushed recording clips thousands of pixels off-screen
> (field bug: "no waveform while recording clip 2").

The visual slot is always computed in the cycle frame:

```cpp
slot = (next_q_boundary % context_loop) / Q
x_pos = base_x + slot * base_width
```

Timeline *extent* (how far ghosts/lanes stretch) still grows with clip
durations and the LCM — extent is a property of committed content, not
of how long the transport has been running.

---

## Examples

### Example 1: Basic Looping Stack
Two clips recorded at 0Q, both looping:
```
Timeline:  |----Q----|----Q----|----Q----|----Q----|
Clip 1:    [████████][░░░░░░░░][░░░░░░░░][░░░░░░░░]  (1Q @ 0, loops)
Clip 2:    [████████████████████████████████████████]  (4Q @ 0, defines timeline)
```
- Clip 1 (1Q): solid + 3 ghosts extending to match Clip 2
- Clip 2 (4Q): defines timeline width, no ghosts needed
- Both have launch_point = 0 (no offset needed)

---

### Invariants
1. **Perceptual Alignment**: Clips must ALWAYS play back such that they align with what the performer heard while recording. If I record starting at "Phrase A", playback must start with "Phrase A" aligned to that same musical moment.
2. **Visual Stability**: Clips should not "jump" visually when recording ends. If a clip is recorded starting at the beginning of the context (0Q), it should remain anchored at 0Q, even if its internal phase differs from the global transport.

### Example 2: Mid-Loop Recording (Core Example)
The canonical example demonstrating phase alignment:
```
Timeline:  |--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|
Clip 1:    [████][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░]  (1Q @ 0)
Clip 2:    [████████████████][░░░░░░░░░░░░░░░░][░░░░░░░░░░░░░░░░][░░░░░]  (4Q @ 0)
Clip 3:          [██████████████████████████████████████████████████████]  (8Q @ 2Q)
                 ↑ X-offset = 400px                    ↑ launch_point = 6Q
```
**Key points:**
- Clip 3 recorded when playhead was at 2Q position in the 4Q context
- X-offset = 2 quantums × 200px = 400px (Matches alignment relative to context)
- **launch_point = (8Q - 2Q) % 8Q = 6Q** 
- When master=0, Clip 3 plays from 6Q position
- When master=2Q, Clip 3 is at position 0 (**aligned with recording!**)

**Note on Rotation (removed entirely, 2026-07-07):**
There is no buffer rotation — physical or virtual. Content is stored in
the **origin frame**: `content[0]` belongs to the clip's origin, and
playback offsets every read by the origin (`content[(t − origin) mod
duration]`, docs/kernel.md). Historical note: the original physical
rotation was first made virtual (audio-thread safety, performance.md
§1), then removed altogether when it was found to double-shift playback
on top of the launch point, contradicting Example 2 above (an 8Q clip
recorded at 2Q must play position 0 at master ≡ 2Q — which the origin
equation produces directly).

---

### Example 3: One-Shot (doesn't fill context)
Short clip recorded mid-timeline, doesn't fill context:
```
Timeline:  |----Q----|----Q----|----Q----|----Q----|
Clip 1:    [████████][░░░░░░░░][░░░░░░░░][░░░░░░░░]  (1Q @ 0, loops)
Clip 2:    [██████████████████████████████████████]  (4Q @ 0, loops)
Clip 3:                        [┄┄┄1Q┄┄┄]             (1Q @ 3Q, ONE-SHOT)
                               ↑ dashed border, no ghosts
```
- Clip 3 duration < remaining context → treated as one-shot *(superseded by Q5: one-shot is a period-source knob — `periodSource: context` — not a duration rule; the values in this example are unchanged)*
- Plays once when master reaches 3Q, doesn't loop
- Visual: dashed border, no ghost repetitions

---

### Example 4: Auto-Quantize Start
Recording always starts at the next quantum boundary:
```
Timeline:  |----Q----|----Q----|----Q----|----Q----|
           0      0.62Q    1Q                      4Q
Clip 1:    [████████]  (1Q @ 0)
Clip 2:    [███████████████████████████████████████]  (4Q @ 0 AFTER snap)
           ↑ Snapped from 0.62Q to 1Q (= 0 mod 1Q context)
```
- User pressed record at 0.62Q
- **Auto-Quantize**: anchor snaps from 0.62Q → 1Q (next Q boundary)
- 1Q % 1Q (context) = 0 → anchor = 0
- launch_point = 0 (no offset needed)

> **Note**: Recording/stopping ALWAYS snaps to the next clean quantum boundary. This keeps loops in sync with the rhythmic grid.
> **Owner-ratified general rule (2026-07-09, design_language.md Q11):**
> the arm target is the next Q boundary *in the epoch frame* — never the
> cycle top specifically. Clicking within the final Q of the LCM cycle
> anchors at Q0 simply because that IS the next boundary.

---

### Example 5: Context Wrapping
Recording at 10Q with 4Q context:
```
Context at record time: 4Q (from Clip 2)
anchor = 10Q → 10Q % 4Q = 2Q → X-offset = 400px

Timeline:  |----Q----|----Q----|----Q----|----Q----|----...
Clip 3:          [██████████████████████████████████████████████]  (8Q @ 2Q)
                 ↑ Same position as Example 2
```
- Even at 10Q global time, position wraps to 2Q within context
- This is why "global time" doesn't matter - only context-relative position

---

## Visual Ghosts & Timeline Wrapping

The "Ghost" system visualizes the cyclical nature of loops on a linear timeline.

### 1. The "Unrolled" Timeline
Imagine unrolling the loop infinitely. "Ghosts" are simply the repetitions of the clip that appear before and after the "primary" instance.
- **Primary Instance**: The visual block representing the actual recorded buffer.
- **Right Ghosts**: Future repetitions (Loop 2, Loop 3...).
- **Left Ghosts (Wrapping)**: Past repetitions (Loop -1, Loop 0...).

### 2. Wrapping Logic (The "Left Ghost")
If a clip is recorded with an **Anchor Offset** (e.g., recorded starting at Q=2 in a 4Q loop):
- The Primary Instance appears at Q=2.
- The timeline from Q=0 to Q=2 is empty *unless* we wrap.
- Since it is a loop, the "Tail" of the clip (Q=2 to Q=4) logically wraps around to fill Q=0.
- A **Ghost** is drawn at `x = start_x - timeline_width` to visualize this wrap.

### 3. The "First Clip" Case
- **Ideal State**: The first clip defines the timeline origin (Q=0). It should have **Anchor Offset = 0**.
- **Result**: Primary Instance at 0. No gap at the start. **No Left Ghost**.
- ~~**Edge Case**: If the transport is running *before* the first recording, the first clip might capture a non-zero anchor… bug/artifact of an un-reset transport.~~ **Superseded (2026-07-16):** the transport is never reset at all (kernel.md §2 holds without exceptions); the first clip's arm moment is captured as the ISLAND EPOCH instead, so anchor 0 holds **by construction** no matter how long the transport ran first — the edge case cannot occur. Pinned by `tests/monotonic_clock_tests.cc`.

---

## LCM-Based Timeline Model

### The Problem with Global Time
A naive implementation uses a "global clock" that counts up forever (0, 1, 2, 3...). Each clip calculates its playhead as `(global_time + offset) % clip_duration`. This creates synchronization problems:

- A 1Q clip and 4Q clip have different loop periods
- When you stop recording at an arbitrary global time, your new clip's playhead won't be at 0%
- The clips drift apart visually

### The Solution: LCM Timeline

The timeline wraps at the **Least Common Multiple (LCM)** of all clip durations. This ensures:

1. **All clips reach 0% simultaneously** when the timeline completes a full cycle
2. **Each clip loops at its own rate** (1Q loops 4 times while 4Q loops once)
3. **No infinite global time** - the range is bounded by LCM

### Mathematical Foundation

```
timeline_length = LCM(duration_1, duration_2, ..., duration_n)
current_position = global_transport % timeline_length
clip_i_phase = (current_position + launch_point_i) % duration_i
clip_i_playhead = clip_i_phase / duration_i
```

### Example: 1Q + 4Q Clips

```
Durations: 1Q, 4Q
LCM = 4Q (timeline loops every 4Q)

Timeline:  |----Q----|----Q----|----Q----|----Q----|  (wraps to 0)
Clip 1:    [████████][████████][████████][████████]   (1Q × 4 = 4Q)
Clip 2:    [██████████████████████████████████████]   (4Q × 1 = 4Q)

At position 0Q: Clip 1 = 0%, Clip 2 = 0%
At position 1Q: Clip 1 = 0%, Clip 2 = 25%
At position 2Q: Clip 1 = 0%, Clip 2 = 50%
At position 3Q: Clip 1 = 0%, Clip 2 = 75%
At position 4Q → 0Q: Both reset to 0%
```

### Example: 1Q + 4Q + 8Q Clips (Example 2 Extended)

```
Durations: 1Q, 4Q, 8Q
LCM = 8Q

Timeline:  |--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|  (wraps to 0)
Clip 1:    [████][████][████][████][████][████][████][████]  (1Q × 8)
Clip 2:    [████████████████][████████████████]              (4Q × 2)
Clip 3:          [██████████████████████████████████████████████]  (8Q @ 2Q offset)

Clip 3 has launch_point = 6Q (from Example 2):
- At timeline=2Q: Clip 3 phase = (2 + 6) % 8 = 0 (aligned with recording!)
- At timeline=0Q: Clip 3 phase = (0 + 6) % 8 = 6Q = 75%
```

### Example: LCM Ghost Extension (1Q + 8Q + 4Q)

This example demonstrates the **LCM Ghost Principle**: when a shorter clip finishes recording, ghosts automatically extend it to fill the LCM cycle.

```
Scenario:
1. Record Clip 1 (1Q) - establishes Q
2. Record Clip 2 (8Q) - establishes 8Q context
3. Record Clip 3 (4Q) - recorded from 0Q, stops between 3Q-4Q, snaps to 4Q

Durations: 1Q, 8Q, 4Q
LCM = 8Q

Timeline:  |--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|  (wraps at 8Q → 0)
Clip 1:    [████][████][████][████][████][████][████][████]  (1Q × 8)
Clip 2:    [██████████████████████████████████████████████]  (8Q × 1)
Clip 3:    [██████████████████████][░░░░░░░░░░░░░░░░░░░░░░]  (4Q solid + 4Q ghost)
                                        ↑ Ghost appears at 4Q to fill LCM

When Clip 3 commits at 4Q:
- The playhead does NOT loop back to 0Q
- A ghost instantly appears for the next 4Q
- Timeline continues to 8Q, THEN all clips loop to 0Q together
```

### Transport Model: Monotonic Clock, Derived Cycle View

> **Superseded (2026-07-07, kernel.md step 3; completed 2026-07-16).**
> The engine transport is now **monotonic** and NEVER mutated: not by
> commits, not by first clips (the island epoch is captured as data at
> the first arm), not by stop (pause/resume — stop freezes the view,
> play resumes the phase).
>
> The old model mutated the clock on commit — snap-to-0 when the LCM
> grew, a suppression branch for polyrhythmic expansions, a special
> first-clip snap, plus the idle LCM wrap. All of that existed to repair
> phase bookkeeping that stored-origin playback makes unnecessary:
> clips align by `content[(t − origin) mod duration]`, which is
> continuous through any commit *by construction*. Nothing to snap.
>
> The UI-facing `masterPos` is a **derived view** computed in
> `getGraphState`: `t mod LCM` normally; while recording, a base frozen
> at record start plus linear growth, so the cursor extends past the
> committed LCM exactly as the cursor table below specifies.

### Example: Large LCM (1Q + 8Q + 3Q)

When clip durations have no common factors, the LCM can be very large.

```
Scenario:
1. Record Clip 1 (1Q)
2. Record Clip 2 (8Q)
3. Record Clip 3 (3Q)

Durations: 1Q, 8Q, 3Q
LCM = 24Q (8 × 3 = 24)

Timeline (24Q):
Clip 1:    [█]×24  (1Q repeats 24 times)
Clip 2:    [████████]×3  (8Q repeats 3 times)
Clip 3:    [███]×8  (3Q repeats 8 times)

At 24Q, ALL clips simultaneously return to 0%
```

**Key Insight: The LCM is the True Loop Point**

Individual clips don't loop at their own duration. ALL clips loop together at the LCM boundary. This ensures:
1. All clips reach 0% playhead simultaneously
2. The visual representation (ghosts) matches the audio behavior
3. No clip "jumps ahead" of another when looping

**Invariant**: At `timeline_position = LCM`, ALL clips are at playhead = 0%.

### Example: Shorter Clip Mid-Cycle (1Q + 4Q + 2Q)

This demonstrates that when a **shorter** clip finishes recording, it must NOT cause early looping.

```
Scenario:
1. Record Clip 1 (1Q) - establishes Q
2. Record Clip 2 (4Q) - LCM = 4Q
3. Start Clip 3 at 0Q, stop between 1Q-2Q → snaps to 2Q

Durations: 1Q, 4Q, 2Q
LCM = 4Q (unchanged, since 2Q divides 4Q)

Timeline:  |--Q--|--Q--|--Q--|--Q--|  (wraps at 4Q → 0)
Clip 1:    [████][████][████][████]  (1Q × 4)
Clip 2:    [████████████████████████████████]  (4Q × 1)
Clip 3:    [████████████][░░░░░░░░░░░░]  (2Q solid + 2Q ghost)
                        ↑ Clip 3 ends at 2Q but timeline continues to 4Q

When Clip 3 commits at 2Q:
- The playhead does NOT loop back to 0Q
- Clip 2 continues playing (2Q → 4Q)
- A ghost of Clip 3 appears (2Q → 4Q)
- At 4Q, ALL clips loop to 0Q together
```

### Example: LCM Expansion (1Q + 4Q + 3Q)

When a clip's duration doesn't divide the existing LCM, the LCM expands.

```
Scenario:
1. Record Clip 1 (1Q) - establishes Q
2. Record Clip 2 (4Q) - LCM = 4Q
3. Record Clip 3, stop at 3Q - LCM expands to 12Q (LCM of 4 and 3)

Durations: 1Q, 4Q, 3Q
LCM = 12Q

Timeline (12Q):
Clip 1:    [█]×12  (1Q × 12)
Clip 2:    [████████]×3  (4Q × 3 = 12Q)
Clip 3:    [██████]×4  (3Q × 4 = 12Q)

When Clip 3 commits at 3Q (transport at ~7Q):
- **Polyrhythmic Expansion**: Since 3Q is not a multiple of the previous LCM (4Q), the engine explicitly **disables** the snap-to-boundary logic.
- **Result**: Transport continues naturally from 7Q → 8Q → ... → 12Q (end of new LCM).
- **Looping**: At 12Q, ALL clips (1Q, 4Q, 3Q) loop to 0 simultaneously.
```

### The User's Bug Case (Fixed!)

```
Durations: 1Q (Clip 1), 4Q (Clip 2)
LCM = 4Q

Clip 2 recorded when Clip 1 was at position 0 (trigger % context = 0)
→ ideal_anchor = 0
→ launch_point = (4Q - 0) % 4Q = 0
→ x_pos = 0

At timeline=0: Clip 2 phase = (0 + 0) % 4Q = 0 = 0%  ✓
At timeline=2Q: Clip 2 phase = (2Q + 0) % 4Q = 2Q = 50%

When you stop recording at timeline=6Q:
→ Current position = 6Q % 4Q = 2Q (within LCM cycle)
→ Clip 2 playhead = 50%
→ But timeline CONTINUES and at 8Q (= 0 mod LCM), Clip 2 resets to 0%!
```

### Implementation Requirements

> **SUPERSEDED (kernel.md, 2026-07-07/16):** the clock is monotonic and
> never wraps; `global_transport_pos % timeline_length` below is the
> old model. The published `masterPos` is a DERIVED view — `t mod
> effective cycle` while idle/playing, growing linearly while recording
> (ui.md "masterPos contract"). The LCM is recomputed as described but
> over EFFECTIVE periods (window ▸ sequence ▸ children).

1. **Calculate Timeline Length**:
   ```cpp
   int64_t timeline_length = LCM(all_clip_durations);
   ```

2. **Wrap Global Transport**:
   ```cpp
   global_transport_pos = global_transport_pos % timeline_length;
   ```

3. **Recalculate LCM When Clips Change**:
   - When a new clip is added
   - When a clip's duration changes
   - When a clip is deleted

### Edge Cases

| Scenario | LCM | Behavior |
|----------|-----|----------|
| Single 1Q clip | 1Q | Loops every quantum |
| 1Q + 4Q | 4Q | 1Q loops 4×, 4Q loops 1× |
| 3Q + 5Q | 15Q | Large cycle, rare full reset |
| Prime durations | product | Very large LCM |

> **Note**: For very long LCMs (e.g., clips with coprime durations), we may want to warn the user or offer a "force sync" option.

---

## Ghost Timeline Design

Ghosts are the visual repetitions of clips that show how they tile across the LCM timeline. This section defines the precise behavior of ghost creation and cursor display.

### Core Invariants

1. **Minimal Ghosts**: Only create the minimum ghosts necessary for a coherent shared timeline
2. **LCM-Boundary Expansion**: During recording, ghosts only expand when the recording crosses the **committed LCM** boundary
3. **Stability After Recording**: When not recording, the ghost timeline should be stable and static
4. **Cursor Alignment**: All clip cursors must be vertically aligned at the same timeline position at all times

### Ghost Creation Rules

#### During Recording
When clip N is recording, ghosts for committed clips expand ONLY when recording crosses the **committed LCM boundary**:

- **Committed LCM** = LCM of all non-recording clips
- New ghosts are added in LCM-sized chunks (not Q-sized)
- If recording stops before crossing the LCM, NO new ghosts are added during recording

**Example: 1Q + 4Q committed, clip 3 starts recording**
- Committed LCM = 4Q
- Timeline extent = 4Q initially (800px)

```
Recording clip 3 at 0Q-3Q (before LCM boundary):
Timeline:  |--Q--|--Q--|--Q--|--Q--|
Clip 1:    [████][░░░░][░░░░][░░░░]  (1Q + 3 ghosts = 4Q total)
Clip 2:    [████████████████████████]  (4Q, no ghosts needed)
Clip 3:            [░░░░░░recording...]  (3Q so far)
                                   ↑ No new ghosts - haven't crossed 4Q

Recording clip 3 at 4Q+ (crossing LCM boundary):
Timeline:  |--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|
Clip 1:    [████][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░]  (+4 ghosts = 8Q total)
Clip 2:    [████████████████████████][░░░░░░░░░░░░░░░░░░░░]  (+1 ghost = 8Q total)
Clip 3:            [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░recording...]  (5Q+ so far)
                                   ↑ Ghosts added at 4Q boundary
```

#### After Recording (Commit)
When a clip commits:
- LCM is recalculated immediately to include the new clip
- All ghosts for all clips are updated to fill the new LCM
- **No animation or delay** - ghosts snap to final positions

**Example: Clip 3 commits at 3Q**
- Old LCM = 4Q (clips 1+2)
- New LCM = 12Q (clips 1+2+3: lcm(1,4,3) = 12)
- Ghosts instantly expand: Clip 1 → 12 repetitions, Clip 2 → 3 repetitions, Clip 3 → 4 repetitions

### Cursor Display Rules

The playback cursor shows the current position in the **LCM timeline**. All clips share one logical cursor.

#### Key Formula
```javascript
cursorPosPx = (masterPos % longestDuration) / effectiveQ * baseWidth
```

Where:
- `masterPos` = global transport position (samples)
- `longestDuration` = LCM of all committed clip durations
- `effectiveQ` = quantum (first clip's duration)
- `baseWidth` = 200px (width of 1Q in pixels)

#### Cursor Behavior
| Mode | Cursor Behavior |
|------|-----------------|
| **Playback** | derived view = `t % LCM`, wraps at LCM boundary |
| **Recording** | derived view grows linearly (frozen base + elapsed) until commit |
| **Commit** | view switches back to `t % LCM` of the *new* cycle — no clock mutation; clip alignment comes from stored origins |

#### Visual Alignment Invariant
> **All clip cursors must appear at the same horizontal position at all times.**

This means:
- If cursor is at 150px in clip 1's main area, clip 2's cursor is at 150px too
- If cursor is at 250px (in clip 1's first ghost), clip 2's cursor is at 250px (still in clip 2's main area if clip 2 is 4Q)

### Example: 1Q + 4Q + 3Q Scenario

This is the canonical test case for ghost behavior:

```
Step 1: Record Clip 1 (1Q)
- Clip 1: [████] (main clip only, no ghosts)
- Timeline = 1Q

Step 2: Start recording Clip 2
- As recording passes 1Q: Clip 1 ghost #1 appears
- As recording passes 2Q: Clip 1 ghost #2 appears
- Cursor moves through: main → ghost1 → ghost2 → ghost3...

Step 3: Stop Clip 2 at 4Q
- Clip 1: [█][░][░][░] (main + 3 ghosts)
- Clip 2: [████████████████] (main only, fills 4Q)
- Timeline = LCM(1,4) = 4Q
- Cursor wraps at 4Q

Step 4: Start recording Clip 3
- As recording passes each Q: new ghosts appear for Clip 1 & 2

Step 5: Stop Clip 3 at 3Q
- Timeline = LCM(1,4,3) = 12Q
- Clip 1: 12 repetitions (11 ghosts)
- Clip 2: 3 repetitions (2 ghosts)
- Clip 3: 4 repetitions (3 ghosts)
- Cursor continues from position 3Q → 4Q → 5Q... (no snap)
- At 12Q, cursor loops to 0Q
```

> **Refined (2026-07-16, ruling Q14b):** the cursor continuity above is
> the **watched** cursor. While recording, the view shifts by whole
> committed cycles to the cycle the take started in; at commit the
> island epoch re-bases to the take's HEARD top (origin floored to
> whole pre-take cycles — phase-neutral for every committed clip), so
> the shifted frame the performer watched persists. The old rule
> ("polyrhythmic expansions keep the epoch") predated the recording
> view shift and teleported the new take to its raw frame position at
> commit (field: a 5Q take from a heard top displayed at 12Q–17Q of
> the exploded 20Q frame).

### Current Implementation Issues

*(historical; all items closed by the 2026-07 kernel migration — one
`deriveViewModel` derives ghost extent and cursor from the same state,
ui_overhaul.md §4.)*

---

## Future Features

### Disable Auto-Quantize (for fiddly overdubs)
- Add a setting to disable the auto-snap-to-next-Q behavior
- Use case: user needs precise control for overdubs or non-loop-aligned recordings
- Could be a per-clip toggle or global setting

