# Recording: Design & Math

## Core Philosophy: Audio Memory Principle
> Recorded audio must always play back aligned with the audio the performer heard during recording. The performer's timing is relative to what they heard—this relationship is sacred.

---

## Visual Feedback During Recording

### Quantum Grid Marks ✨
While recording Clip 2+, faint vertical lines appear at each Q boundary:
- Shows exactly where quantum boundaries are relative to your recording
- Helps you see if you're approaching a clean stop point
- Only visible when `effectiveQuantum` is established (Clip 1 defines Q)

### Orange Launch Marker
Shows where playback will start for clips recorded mid-loop:
- Only appears when `anchorPhase > 0`
- Position = `(launchPoint / duration) * 100%`
- Hidden for clips recorded at 0Q (anchor=0)

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
| `anchor_phase_samples` | **LOOP-RELATIVE** position where user pressed record | Recording starts |
| `launch_point_samples` | Where playback starts within clip | Recording commits |
| `duration_samples` | Total clip length | Recording commits |
| `loop_start/end` | Playable region within clip | Recording commits |

### Loop-Relative Anchor Model

The anchor is NOT the global master position. It's **where the playhead was in the context loop** when you pressed record.

**Why loop-relative?**
- You might listen to Clip 1 looping for 5 minutes before recording Clip 2
- Global time keeps ticking, but your INTENT is relative to the loop
- If you press record near the END of the loop, you're intending to start at 0Q (the loop is about to restart)

**Formula:**
```cpp
effective_pos = (master_pos + playback_offset) % context_loop
anchor_phase_samples = effective_pos  // LOOP-RELATIVE!
```

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
effective_pos = (master_pos + playback_offset) % context_loop
quantum_offset = effective_pos / Q
x_pos = base_x + quantum_offset * base_width
anchor_phase = effective_pos  // Store loop-relative position
```

### Key Insight
The **context_loop determines wrapping behavior**:
- Recording at end of 1Q loop (0.97Q) → anchor = 0.97Q in context 1Q
- Recording at 2Q in 4Q context → anchor = 2Q

### Architecture: C++ Owns the Data
- **C++** calculates `x_pos` at recording start and stores it
- **JS** displays `node.x` directly with NO transformation

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
- X-offset = 2 quantums × 200px = 400px
- **launch_point = (8Q - 2Q) % 8Q = 6Q** 
- When master=0, Clip 3 plays from 6Q position
- When master=2Q, Clip 3 is at position 0 (**aligned with recording!**)

---

### Example 3: One-Shot at 3Q
Short clip recorded mid-timeline, doesn't fill context:
```
Timeline:  |----Q----|----Q----|----Q----|----Q----|
Clip 1:    [████████][░░░░░░░░][░░░░░░░░][░░░░░░░░]  (1Q @ 0, loops)
Clip 2:    [████████████████████████████████████████]  (4Q @ 0, loops)
Clip 3:                        [┄┄┄1Q┄┄┄]             (1Q @ 3Q, ONE-SHOT)
                               ↑ dashed border, no ghosts
```
- Clip 3 duration < remaining context → treated as one-shot
- Plays once when master reaches 3Q, doesn't loop
- Visual: dashed border, no ghost repetitions

---

### Example 4: Auto-Quantize Start
Recording always starts at the next quantum boundary:
```
Timeline:  |----Q----|----Q----|----Q----|----Q----|
           0      0.62Q    1Q                      4Q
Clip 1:    [████████]  (1Q @ 0)
Clip 2:    [████████████████████████████████████████]  (4Q @ 0 AFTER snap)
           ↑ Snapped from 0.62Q to 1Q (= 0 mod 1Q context)
```
- User pressed record at 0.62Q
- **Auto-Quantize**: anchor snaps from 0.62Q → 1Q (next Q boundary)
- 1Q % 1Q (context) = 0 → anchor = 0
- launch_point = 0 (no offset needed)

> **Note**: Recording/stopping ALWAYS snaps to the next clean quantum boundary. This keeps loops in sync with the rhythmic grid.

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
- **Edge Case**: If the transport is running *before* the first recording, the first clip might capture a non-zero anchor. This causes it to appear offset (e.g., at Q=2) and generate a Left Ghost. This is visually confusing for the first clip and is considered a bug/artifact of an un-reset transport.

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

---

## Future Features

### Disable Auto-Quantize (for fiddly overdubs)
- Add a setting to disable the auto-snap-to-next-Q behavior
- Use case: user needs precise control for overdubs or non-loop-aligned recordings
- Could be a per-clip toggle or global setting
