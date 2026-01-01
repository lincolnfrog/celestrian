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
