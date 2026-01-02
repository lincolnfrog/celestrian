# Celestrian Architecture & Implementation Status

## 1. Physical Audio Engine (`src/audio_engine.cc`)
Responsible for hardware I/O and driving the root of the audio graph.
- [x] Hardware I/O callback
- [x] Mono recording buffer
- [ ] Multi-threaded root mixer
- [ ] Latency compensation logic

## 2. Hierarchical Audio Graph (New)
The recursive engine that processes "Boxes" and "Clips".

### `AudioNode` (Interface)
- **Purpose**: The universal contract for everything that produces or processes sounds. This is the core "DNA" of the hierarchical DAW.
- **Abstraction Principle**: Every operation available to the user (looping, multi-range slicing, volume automation, effects) must be defined on the `AudioNode` interface. This ensures that a single clip, a group of clips, or a nested box can all be "warped", "sliced", or "looped" as a single unit without the parent needing to know the internal structure.
- **Key Methods**: 
    - `process(context)`: Recursive audio rendering.
    - `getWaveform(peaks)`: Recursive aggregate peak generation.
    - `setPlaybackRange(ranges)`: Abstracted slicing/looping.
    - `setLooping(bool)`: Toggle repetition.
    - `setWarpFactor(float)`: Speed/timing offset.
- **Status**: [x] Base interface defined.

### `ClipNode` (Leaf)
- **Purpose**: Represents a single audio recording.
- **Features**: Multi-range slicing, Loop points, Seed BPM.
- **Status**: [/] Basic recording and playback implemented. Multi-range and deep editing pending.

### `BoxNode` (Container)
- **Purpose**: A sub-mixer that sums children.
- **Features**: Recursive `process()` calls, Aggregate Waveform generation, Warp Ratio calculation.
- **Status**: [/] Basic summing and container logic implemented.

## 3. DSP & Timing (`src/dsp/`)
The "Brain" of the alignment and warping logic.

### `WarpManager` (WSOLA)
- **Purpose**: Real-time time-stretching without pitch shift.
- **Solutions**: Primary-Relative Warping (Target BPM / Seed BPM).
- **Status**: [ ] Not Started

### `PhaseAligner`
- **Purpose**: Smooths splices between non-contiguous loop ranges.
- **Solutions**: Crossfade synthesis, Zero-crossing snapping.
- **Status**: [ ] Not Started

## Implementation Roadmap

To avoid overwhelming complexity, we are building in this specific order:

1.  **Segment 1: Foundation** (COMPLETE) - `AudioNode` + `ClipNode` + Unit Tests.
2.  **Segment 2: Recursive Mixing** (COMPLETE) - `BoxNode` + Summing logic + Aggregate waveforms.
3.  **Segment 3: Navigation & Transport Core** (COMPLETE) - JS Viewport, C++ Focus API, and Playhead Synchronization.
4.  **Segment 4: Focused Interaction** (IN PROGRESS) - Track Controls (Play/Solo/Record), Creation Menu, and Selective Recording.
5.  **Segment 5: Clip Manipulation** - Basic editing (moving clips in 2D space, resizing durations).
6.  **Segment 6: Save/Load** - Add ability to save the project to disk and load it back up.
7.  **Segment 7: Multi-Range Implementation** - Multi-slice selection and conserved loop length math.
8.  **Segment 8: Warp Manager** - WSOLA time-stretching and BPM discovery.
9.  **Segment 9: Connections between boxes** - Multi-box transitions and logic.

---

## Technical Details

### 4. State & Bridge Layer
The communication hub between C++ nodes and WebView.

#### `BridgeProtocol` (Navigation & State)
- `get_graph_state()`: Returns JSON containing the `focused_node`, `global_transport` state, and child metadata (including dynamic `playhead_pos`).
- `start_recording_in_node(uuid)`: Routes input to a specific node's buffer.
- `stop_recording_in_node(uuid)`: Stops recording for the specified node.
- `toggle_play(uuid)`: Toggles playback for a specific node.
- `toggle_solo(uuid)`: Toggles solo state for a specific node.
- `create_node(type)`: Instantiates a new `BoxNode` or `ClipNode` in the current focus.

### 5. UI Layer (`ui/`)
#### `ViewportController` (JS)
- **Creation Menu**: Top-aligned [+] button.
- **Interaction**: Spacebar toggles `global_transport`.

### 6. Logic & Timing (Revised)
#### Primary Quantum (C++)
- **First-Capture Rule**: If a box is empty (or defines the root context), the first recorded clip's final length sets the `primary_quantum` sample count for that entire container.
- **Quantum Buffering**: When a user stops recording on a subsequent clip, the engine continues to record into a temporary buffer until the next clean multiple of `primary_quantum` is reached.
- **Variable Style**: Transitioning all C++ member variables to `snake_case` (e.g., `write_pos`, `read_pos`, `is_recording`).

---

## 7. Waveform Rendering System (UI)

### Problem Statement
When recording Clip 2 against an established quantum (from Clip 1), the waveform peaks "vibrate" or drift instead of remaining fixed at their recorded positions. Clip 1 recording works perfectly - smooth growth, stable peaks.

### Core Principles

#### Principle 1: Quantum Establishes the Grid
- Clip 1's final duration becomes the **Quantum (Q)**.
- 1 Quantum = 200 pixels (baseWidth). This ratio is **FIXED** forever.
- All timing calculations derive from: `pixelsPerSample = 200 / Q`

#### Principle 2: Peaks Are Placed at the Cursor Position
- When sound is recorded at sample position `S`, the corresponding peak appears at pixel position `X = (S / Q) * 200`.
- This position is **immutable** - once placed, it never moves.

#### Principle 3: Cursor Grows Smoothly
- The cursor (and clip width) grows at a constant rate: `200 pixels per Q samples`.
- At any moment, cursor position = `(recordedSamples / Q) * 200`.

#### Principle 4: Canvas Width Follows Cursor
- The canvas width equals the cursor position (or baseWidth, whichever is larger).
- Width grows continuously - no jumping.

### Mathematical Model

Let:
- `Q` = Quantum (samples) - established by Clip 1
- `S` = Sample position of a peak
- `baseWidth` = 200 pixels

Then:
- **Peak position**: `X(S) = (S / Q) * baseWidth`
- **Canvas width at time T**: `W(T) = max(baseWidth, (recordedSamples(T) / Q) * baseWidth)`
- **Pixels per sample**: `pixelsPerSample = baseWidth / Q` (constant!)

### Implementation Requirements

#### Pre-Quantum Recording (First Clip in an Island)
- No quantum is established yet.
- Canvas stays at a fixed "user-friendly" width (e.g., `baseWidth` = 200px).
- Peaks fill from left to right at a fixed rate (e.g., 110 samples per peak).
- Waveform "compresses" as more peaks are added - this is the expected behavior.
- When recording completes, `Q = finalDuration` for this island.

#### Post-Quantum Recording (Subsequent Clips in Same Island)
- Quantum `Q` is already established from the first clip.
- Canvas starts at **zero width** and grows smoothly.
- Peaks are allocated at rate: `samplesPerPeak = Q / peaksPerQuantum`
- Peak `i` is drawn at pixel: `X = i * (baseWidth / peaksPerQuantum)`
- This position is **independent of canvas width** - it only depends on `i` and constants.
- Canvas width = `currentPeakCount / peaksPerPixel` (grows smoothly from 0).

### Key Insight: Pre-Quantum vs Post-Quantum

| Aspect | Pre-Quantum | Post-Quantum |
|--------|-------------|--------------|
| Canvas width | Fixed (200px) | Starts at 0, grows smoothly |
| Peaks fill... | Left to right, compressing | Left to right, NOT compressing |
| Q | Not established | Fixed from first clip in island |
| Expected behavior | Waveform fills fixed space | Waveform extends into new space |

---

## 8. Islands: Multi-Quantum Architecture

### Concept
An **Island** is a group of stacks/boxes that share the same quantum. Multiple islands can exist on screen simultaneously, each with their own independent quantum and time grid.

### Island Membership Rules
A new clip/box **inherits** an existing quantum (joins an island) if:
1. It is added to an existing stack with an established quantum.
2. It is inside a BoxNode that already has an established quantum.
3. It is connected via a "quantum-preserving sequence flow" to an established stack.

A new clip/box **establishes a new island** if:
1. It is created at the "top level" (not inside any box with an established quantum).
2. It is not connected to any existing quantum-bearing structure.

### Rendering Implications
Each island has its own:
- `islandQ`: The quantum for that island (in samples).
- `pixelsPerSample`: Derived from `baseWidth / islandQ`.
- Independent time grid for all members.

Two stacks with different quantums will have different visual "time dilation":
- A 2-second quantum island has half the `pixelsPerSample` of a 1-second quantum island.
- Visual width of 1 second = `200 * (sampleRate / Q)` pixels.

### Data Model Addition
```
Island {
  id: UUID
  quantum: int64 (samples) -- established by first clip
  stacks: [Stack references]
}

Stack / BoxNode {
  islandId: UUID (or null if pre-quantum)
}
```

---

## 9. Rendering Algorithm (Revised)

### For Pre-Quantum Clips
```javascript
// Fixed canvas, compressing waveform
const canvasWidth = baseWidth;  // Fixed at 200px
const samplesPerPeak = 110;     // Fixed rate
const index = Math.floor(recordedSamples / samplesPerPeak);
const step = canvasWidth / (index + 1);  // Dynamic, causes compression
```

### For Post-Quantum Clips
```javascript
// Growing canvas, stable waveform
const Q = islandQuantum;
const peaksPerPixel = 2;
const samplesPerPeak = Q / (baseWidth * peaksPerPixel);
const index = Math.floor(recordedSamples / samplesPerPeak);
const step = 1 / peaksPerPixel;  // FIXED at 0.5 pixels per peak
const canvasWidth = index * step;  // Grows from 0
```

### Key Difference
- **Pre-quantum**: `step` is calculated from `canvasWidth / peakCount` (dynamic).
- **Post-quantum**: `step` is a constant derived from the island's quantum (fixed).

---

## 10. Open Questions (Resolved)

1. **Pre-quantum vs Post-quantum distinction** ✓
   - The rendering mode depends on whether the island has an established quantum, not clip order.

2. **Correct behavior for post-quantum clips** ✓
   - **Option A confirmed**: Peaks stay at fixed pixel positions; canvas grows to reveal them.

3. **Resolution** ✓
   - Current: 400 peaks per quantum (2 per pixel at baseWidth).
   - Future: User zoom will allow seeing more detail.

4. **Zero-width start for post-quantum clips** ✓
   - True zero width is acceptable. The state only exists for a split second.
   - No special minimum-width case needed - simplifies implementation.

5. **Island data model** ✓
   - Island is an **implicit property** derived from node structure.
   - No explicit Island entity for now.
   - Future: May need explicit handling for "breaking out" a stack from an island.

6. **Seamless transition at Q establishment** ✓
   - When pre-quantum recording ends and Q is established, the rendering should naturally look the same.
   - The compressing waveform in a 200px canvas becomes the reference: `200px = 1Q`.
   - No visual "switch" should occur - the math should produce identical output.

---

## 11. Implementation Checklist

- [x] **Pre-quantum rendering**: Fixed canvas (200px), compressing waveform, dynamic step.
- [x] **Post-quantum rendering**: Growing canvas (from 0), fixed step based on island Q.
- [x] **Seamless transition**: Ensure pre-quantum final state matches post-quantum initial state.
- [ ] **Island Q derivation**: Derive Q from parent BoxNode's first completed clip. (Future)
- [x] **Fixed step in renderer**: Pass fixed step to `drawWaveform()` for post-quantum clips.

---

## 12. Future Considerations

### Zoom
- User can zoom in/out to see more/less detail.
- Zoom affects `pixelsPerSample` but not the underlying peak data.
- Consider: Store peaks at high resolution, downsample for display.

### Island Transitions
- When stacks are connected via sequence flow, they may need to align quantums.
- TBD: How to handle quantum mismatches between connected islands.

### Breaking Out Stacks
- If a stack is "broken out" from an island, it may need to duplicate the quantum-establishing clip.
- TBD: UX and implementation for this scenario.

