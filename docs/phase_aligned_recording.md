# Phase-Aligned Recording: Design & Math

## Core Philosophy: Audio Memory Principle
> Recorded audio must always play back aligned with the audio the performer heard during recording. The performer's timing is relative to what they heard—this relationship is sacred.

---

## Quantum Fundamentals

### Establishing Quantum (Q)
The **first recorded clip** establishes the quantum:
- `Q = first_clip.duration` (in samples)
- All subsequent clips are measured/aligned relative to Q
- Quantum represents "one bar" or "one loop" of the rhythmic grid

### Clip Types
1. **Looping Clips**: `duration >= Q` → clip loops continuously
2. **One-Shot Clips**: `duration < anchor_position % duration` → triggered once per cycle

---

## Key Data Points

| Field | Description | Set When |
|-------|-------------|----------|
| `trigger_master_pos` | Raw master position when recording started | Recording starts |
| `anchor_phase_samples` | `= trigger_master_pos` (raw, no modulo) | Recording starts |
| `launch_point_samples` | Where playback starts within clip | Recording commits |
| `duration_samples` | Total clip length | Recording commits |
| `loop_start/end` | Playable region within clip | Recording commits |

---

## X-Offset Calculation

### Goal
Position clip so its **left edge** is at the horizontal position where the user started recording, **relative to the existing context**.

### Core Concept: Context Loop
When a clip starts recording, the **context loop** = longest existing clip's duration.
- If no clips exist → context_loop = Q (quantum, defined by first clip)
- If Clip 1 = 1Q, Clip 2 = 4Q exist → context_loop = 4Q

### Formula (calculated in C++ at recording start)
```cpp
context_loop = max(longest_sibling_duration, Q)
wrapped_anchor = anchor_phase % context_loop
quantum_offset = wrapped_anchor / Q
x_offset = quantum_offset * base_width  // base_width = 200px
x_pos = base_x + x_offset               // base_x = 100px (column position)
```

### Key Insight
The **context_loop determines wrapping behavior**:
- anchor=2Q, context=**1Q** → 2Q % 1Q = **0** → offset=0 (left-aligned!)
- anchor=2Q, context=**4Q** → 2Q % 4Q = **2Q** → offset=400px

### Architecture: C++ Owns the Data
- **C++** calculates `x_pos` at recording start and stores it
- **JS** displays `node.x` directly with NO transformation

---

## Scenarios

### Scenario 1: All Clips Start at 0
```
Context at each recording start:
Clip 1: Q=122368, anchor=0  → context=Q      → 0 % Q = 0     → offset=0
Clip 2: 4Q,       anchor=0  → context=Q      → 0 % Q = 0     → offset=0
Clip 3: 2Q,       anchor=0  → context=4Q     → 0 % 4Q = 0    → offset=0
```
All clips left-aligned (anchor=0 always wraps to 0).

### Scenario 2: User's Simple Case (1Q context, 2Q anchor)
```
Clip 1: 1Q,  anchor=0   → context=Q      → 0 % Q = 0      → offset=0
Clip 2: 3Q,  anchor=2Q  → context=1Q     → 2Q % 1Q = 0    → offset=0  ✓ LEFT!
```
**Key insight**: Context is 1Q (only Clip 1 exists), so 2Q wraps to 0!

### Scenario 3: Canonical Example (1Q, 4Q, 8Q@2Q)
```
Context at each recording start:
Clip 1: 1Q,  anchor=0   → context=Q      → 0 % Q = 0      → offset=0
Clip 2: 4Q,  anchor=0   → context=1Q     → 0 % 1Q = 0     → offset=0
Clip 3: 8Q,  anchor=2Q  → context=4Q     → 2Q % 4Q = 2Q   → offset=400px
```
**Key insight**: By the time Clip 3 records, context=4Q (Clip 2), so 2Q stays at 2Q!

### Scenario 4: Wrap with Very Long Context
```
Clip 1: 1Q,  anchor=0   → offset=0
Clip 2: 4Q,  anchor=0   → offset=0  
Clip 3: 8Q,  anchor=10Q → context=4Q → 10Q % 4Q = 2Q → offset=400px
```
Even starting at 10Q, it wraps to 2Q within the 4Q context.

---

## Launch Point Calculation

For clips where `anchor_position > 0`:
```
// Where in the clip should playback start when master=0?
// Answer: (duration - (anchor % duration)) % duration
launch_point = (duration - (anchor_phase % duration)) % duration
```

This ensures when master reaches `anchor_phase`, the clip is at position 0.

## Virtual Timeline Visualization

### Concept
Show the "unrolled" timeline as if clips were arranged in a traditional DAW:
- **Looping clips**: Show ghost/faded repetitions where the clip will actually play
- **One-shot clips**: No ghosts, just the single instance with dashed border

---

## Visual Design Decisions

### Ghost Repetitions (Looping Clips)
- **Waveform**: Faded at ~30% opacity, showing the loop's audio content
- **Quantum Markers**: Faded vertical lines at each Q boundary within ghosts
- **Main Loop**: Solid waveform, solid white playhead marker
- **Ghost Region**: Faded waveform + faded markers continuing rhythmically

### One-Shot Clips
- **Border**: Dashed border (vs solid for loops)
- **No Ghosts**: Only the main clip is shown, no repetitions
- **Background**: Same as loops (user-selectable color reserved for instrument tagging)

### User-Selectable Clip Colors
- Users can assign colors to clips for visual organization (e.g., drums=red, bass=blue)
- This is independent of loop/one-shot distinction
- One-shot = dashed border (regardless of color)

### Converting One-Shot to Loop
User can manually convert a one-shot to a looping clip (breaking Audio Memory alignment):
- The clip remains at its current X-position
- Ghosts extend **both backward and forward** to fill the timeline
- This indicates the loop now plays throughout, not just at the original anchor point

---

## Canonical Examples

### Example 1: Basic Looping Stack
```
Timeline:  |----Q----|----Q----|----Q----|----Q----|
Clip 1:    [████████][░░░░░░░░][░░░░░░░░][░░░░░░░░]  (1Q, loops)
Clip 2:    [████████████████████████████████████████] (4Q, fills timeline)
```
- Clip 1 (1Q): solid main + ghosts extending to longest clip
- Clip 2 (4Q): defines timeline width, no ghosts needed

### Example 2: Mid-Loop Recording (Canonical Example)
```
Timeline:  |--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|--Q--|
Clip 1:    [████][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░][░░░░]  (1Q @ 0)
Clip 2:    [████████████████][░░░░░░░░░░░░░░░░][░░░░░░░░░░░░░░░░][░░░░░]  (4Q @ 0)
Clip 3:          [██████████████████████████████████████████████████████]  (8Q @ 2Q)
                 ↑ X-offset = 2Q                       ↑ launch point = 6Q
```
**Key insight:** Timeline expands to 10Q (Clip 3 starts at 2Q + 8Q duration = 10Q extent).
All shorter clips' ghosts extend to fill this 10Q timeline.

**Math:**
- Clip 3 anchor = 2Q (raw trigger_master_pos)
- Clip 3 duration = 8Q
- wrapPeriod = max(8Q, Q) = 8Q
- wrappedAnchor = 2Q % 8Q = 2Q
- quantumNumber = floor(2Q / Q) = 2
- X-offset = 2 × baseWidth = 400px

**Launch Point:**
- launch_point = (8Q - 2Q) % 8Q = 6Q
- When master=0, Clip 3 starts playing from 6Q position
- When master=2Q, Clip 3 is at position 0 (aligned with recording!)

### Example 3: One-Shot at 3Q
```
Timeline:  |----Q----|----Q----|----Q----|----Q----|
Clip 1:    [████████][░░░░░░░░][░░░░░░░░][░░░░░░░░]  (1Q @ 0, loops)
Clip 2:    [████████████████████████████████████████] (4Q @ 0, loops)
Clip 3:                        [┄┄┄1Q┄┄┄]             (1Q @ 3Q, ONE-SHOT)
                               (dashed border, no ghost)
```
- Clip 3 is 1Q recorded at 3Q position
- It's a one-shot: plays once when master reaches 3Q, doesn't loop
- Visual: dashed border, no ghosts

### Example 4: Converted One-Shot to Loop
```
Timeline:  |----Q----|----Q----|----Q----|----Q----|
Clip 3:    [░░░░░░░░][░░░░░░░░][░░░░░░░░][████████]  (Originally ONE-SHOT @ 3Q)
           ←backward ghosts      solid    (now LOOP, user converted)
```
- User converted one-shot to loop
- Ghosts now extend backward (showing it loops into earlier quantums too)

---

## Implementation Checklist

### Data Model
- [x] Store raw `trigger_master_pos` as `anchor_phase_samples`
- [ ] Add `is_one_shot` flag (or derive from anchor vs duration)
- [ ] Add `user_color` property for clip customization

### X-Offset Calculation
- [ ] Calculate X-offset: `floor((anchor % max(dur, Q)) / Q) * baseWidth`
- [ ] Apply offset during AND after recording

### Playback
- [ ] Detect one-shot: `anchor_phase % duration > duration - Q`
- [ ] Calculate launch_point for aligned playback
- [ ] One-shots: trigger only when master reaches anchor position

### Visual
- [ ] Render ghost repetitions (faded waveform + quantum markers)
- [ ] Dashed border for one-shot clips
- [ ] Ghosts extend only where clip will actually play
- [ ] Convert one-shot to loop: bi-directional ghosts

