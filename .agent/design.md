# Celestrian DAW Design Document

## Project Overview
Celestrian is an open-source Digital Audio Workstation (DAW) built with JUCE and a WebView-based UI.

## Core Technologies
- **Framework**: [JUCE](https://juce.com/)
- **Build System**: CMake with [CPM.cmake](https://github.com/cpm-cmake/CPM.cmake)
- **UI Architecture**: WebView (HTML/CSS/JS) for the frontend, C++ for the engine.
- **Target Platforms**: macOS, Windows, Linux.

## Project Structure
- `src/`: C++ Source code
- `ui/`: Frontend code (HTML, CSS, JS)
- `external/`: External dependencies (if not managed by CPM)
- `.agent/`: Agent-specific documentation and workflows

## Build System Details
We use CMake as the primary build system. CPM.cmake is used for dependency management to keep the project setup simple and reproducible.

## Audio Strategy
The audio engine handles low-latency recording and playback.
- **Recording**: Uses `juce::AudioDeviceManager` to capture input into a memory buffer.
- **Playback**: Uses `juce::AudioSourcePlayer` to play back the recorded buffer.
- **Waveform Visualization**: C++ calculates min/max peaks from the audio buffer and exposes them to the WebView as a JSON array for rendering.

## UI Strategy
The UI will be hosted in a native WebView component provided by JUCE (WebBrowserComponent).
- Communication between C++ and JS is handled via JUCE 8's `withNativeFunction` and `evaluateJavascript`.
- JS triggers recording and playback, while C++ feeds waveform data back to JS.

## Performance
It is critical that audio can be recorded in parallel with existing audio clips being played back and at the lowest possible latency. That said, the actual requirement is alignment between what the user hears and what the user records.
* Possible "latency compensation" feature - direct user to establish a latency baseline somehow - i.e. ask them to record a short "click track" clip while listening to playback of a click track clip. After that, all recorded clips would automatically be shifted by that baseline latency. Maybe this can be done more automatically somehow?
* Most professional audio hardware will have a CPU with multiple cores, so Celestrian should be built to be multi-threaded. Playback and recording processes should certainly be run on separate threads, and likely any audio processing should be run on separate threads as well.

## Core Design Philosophy
Celestrian is a nested, "boxes-and-lines" DAW experience. It is a typical single-song, "session"-view experience. It is designed for the following key UX flows:
* Building a song from live loops - the user should be able to record without first choosing a tempo. The user can then select a range of the clip to act as the loop. That loop length should be used as the core quantum & bpm for the rest of the clips in that group.
* There is no such thing as an isolated song, only nested grooves or "boxes". An audio clip is the lowest possible "leaf" element. Audio clips can be stacked in parallel to create music. Those stacks can then be bundled into a node (think the user "stepping outside" or "wrapping the current groove into a box"). Bundled boxes can also be stacked in parallel with new audio clips or other boxed grooves. The user can "step inside" a box to edit its contents. It should be very easy to navigate the nested structure of boxes.
* **Layout**: Nodes are arranged in vertical stacks. New clips are appended to the bottom of the stack where the user clicks (+).

## Roadmap / Future Considerations

- [ ] **Prettier Waveforms**: Replace the simple line renderer with discrete vertical bars at a granularity appropriate for the zoom level (e.g., 16 bars per clip). This will make them more legible and professional.
- [ ] **Visual Loop Snapping**: (Implemented) Real-time ghosts and snap markers during loop dragging provide clear rhythmic guidance.
- [ ] **Drag and Drop**: Reorder clips within stacks or move them between stacks.
- [ ] **Non-Contiguous Loop Regions**:
    - **Idea: Clip Splitting**: Add a "Slice" tool or hotkey (e.g., 'Cmd+E') to split a `ClipNode` at the playhead. The resulting nodes can then be looped independently, effectively allowing non-contiguous playback of the same source audio.
    - **Idea: Multi-Region Selection**: Allow the user to define multiple `loopStart/End` pairs. The engine would cycle through these regions in order.
    - **Idea: Masking/Muting**: Instead of choosing what plays, allow the user to select regions of the clip to "mute" or "skip" while the rest plays normally.
- [ ] **Multiple Stacks in Boxes**: Support side-by-side stacks within a single box container.
* Boxes can be arranged in a graph of connections. The user can place boxes and connect them using various primitives, ex: loop, branch-with-chance, etc.
* Library of loops & clips - the user should be able to slowly build up a library of loops and clips that can be used in boxes. Loops, clips, and boxes should have associated metadata about their bpm, length, and music key. It should be possible to start building some automation features that can generate new music by combining existing clips and boxes in new ways.
* Thus there are sort of three modes of operation: 1) recording & creating new stacks of clips & boxes, 2) editing and designing flows of music through connections between boxes w/ transitions etc. and 3) runnning a large corpus of structure in a sort of "infinite playlist". The user should be able to bounce between (1) and (2) to create live music. (3) shoudl be able to create an infinite offline "radio station" of the user's clip & box catalog.

## Features

### 1. Recording & Live Creation
* **Phase-Locked Loop (PLL) Recording**:
    - **Instant Capture**: New recordings begin immediately on user request to capture the creative spark.
    - **Cyclic Alignment**: The system anchors the recording to the master quantum phase. Upon completion, the buffer is cyclically shifted (rotated) so that its internal phase matches the global transport.
    - **Hysteresis-Based Snapping**:
        - **Anticipatory Stop (Early)**: If the user stops within the tolerance *before* a clean boundary, recording continues until that boundary is reached to avoid cutting off audio.
        - **Late Snap (Late)**: If the user stops within the tolerance *after* a clean boundary, recording ends immediately and the clip is truncated to that boundary.
        - **Instant Stop (Future: Loop Region)**: If stopped outside the tolerance, recording ends immediately. The **Loop Region** is automatically set to the previous clean multiple, preserving the "tail" for later editing.
* **Multi-threaded Parallel Processing**: High-performance audio engine that leverages multi-core CPUs for simultaneous recording, playback, and effect processing.

### 2. Nesting & Arrangement
* **Nested "Groove Boxes"**: A recursive structural model where audio clips are "leaf" nodes that can be bundled into "Boxes." Boxes can contain clips or other boxes, allowing for infinite nesting.
* **Graph-based Logic**: Connect boxes using a "lines-and-boxes" interface. Primitives include:
    - **Looping**: Standard repetition logic.
    - **Branch-with-Chance**: Non-deterministic flow for procedural music.
    - **Smoothing Transitions**: Automated crossfades between boxes and ranges.
* **Stacking Logic**: Boxes and clips can be stacked in parallel, creating vertical "stacks" that can then be collapsed into a single box.
* **Editing**: When a user zooms out of the inside of a box to see the box as a single unit, that box displays an **Aggregate Waveform** (a recursive mixdown of all child nodes). 
    - **Unitized Editing**: Loop ranges and cuts applied to a Box affect the timing of all internal clips simultaneously as a single logical block.
    - **Hierarchical Automation**: Automation envelopes applied to a Box act as a global "VCA" or offset for all internal child automation/parameters.

### 6. Interaction & UI Design
* **The Plus (+) Button**:
    - **Contextual Spawning**: Clips and Boxes should spawn near the originating interaction point.
    - **Stack-Specific (+)**: Every vertical stack has its own `(+)` button anchored to its base. This button adds a new clip to that specific stack.
    - **Box (+)**: Boxes have a global `(+)` button that spawns new child elements (Clips, Stacks, or smaller Boxes).
* **Grid-Based Arrangement**: New elements snap to a dynamic grid layout, keeping the workspace organized automatically.

* **Automatic Spatiotemporal Scaling (Growing Clips)**: 
    - **Visual Growth**: During recording, if the performance exceeds the initial quantum length (e.g., 3x quantum), the clip's horizontal representation in the UI grows proportionally to reflect its actual content.
    - **Stepped Stepping Zoom**: If a growing clip starts to exceed the bounds of the current viewport, the system automatically "zooms out" in discrete steps (rather than a jarring continuous zoom) to ensure the entire active recording remains visible.

### 5. Navigation & Viewport (ZUI)
* **Contextual Zoom**: The screen represents the "Current Active Box."
* **Dive/Exit Mechanics**: 
    - **Double-Click**: Zooms "inside" a child box, making it the new context.
    - **Escape/Exit Button**: Zooms "out" to the parent container.
* **Navigation Controls**:
    - **Pan**: Click-and-drag empty space or use **[W, A, S, D]** keys.
    - **Zoom**: Mouse wheel or **[Q, E]** keys.
* **Slick Transitions**: Modern CSS/JS animations to maintain spatial orientation during zooms.

### 6. The "Stack" Architecture
Within a Box, all clips and sub-boxes are displayed in a vertical **Stack**.
* **Primary Quantum**: The first clip recorded in an empty structure defines the **Quantum Length** (in samples).
* **Phase-Locked Arrangement**: All subsequent recordings in that structure are anchored to the Primary Quantum's phase.
    - **Seamless Rotation**: Recordings utilize "Cyclic Shift" logic: they start immediately but are post-processed via buffer rotation to align with the master loop's start point.
* **Stack Interaction**: 
    - **Creation Menu**: A floating **[+]** button at the bottom of the stack allows adding "New Clip" or "New Box". 
    - **Interaction**: The [+] button is a simple circle that reveals a creation dropdown on click.
* **Stack Templates**: The user can create a template for a stack and save it to the corpus. Example: the user has a drum kit with 5 microphones. The user can create a template for a drum kit with 5 microphones and save it to the corpus. The user can then create a new drum kit by clicking the [+] button and selecting "Templates" -> "Drum Kit" from the dropdown.
    

### 7. Playback & Focus Logic
* **The Global Super-Structure**: Play/stop behaves as a single unit by default. 
* **Focus Playhead**: Selected nodes show a **Playhead Cursor** looping at `master_time % node_duration`.
* **Contextual Solo**: Users can solo the current box context while editing to hear it in isolation.

### 3. Loop Region Selection
* **Decoupled Playback**: Every `ClipNode` maintains a distinct **Loop Start** and **Loop End** (in samples).
* **Automatic Provisioning**: Upon capture, these are set based on the Hysteresis Snap logic (see Section 1).
* **Manual Manipulation**: The UI provides handles to resize or slide the loop region within the larger recorded buffer.
* **Multi-range Selection**: Define a complex loop by selecting multiple non-contiguous ranges from a single audio clip.
* **Intelligent Edge Analysis**: Automatic waveform analysis to find optimal zero-crossing or low-transient points at selection boundaries to prevent pops/clicks.
* **Crossfade Synthesis**: Automatic smoothing and phase alignment between non-contiguous loop ranges.

### 4. Corpus & Automation
* **Global Settings**: A centralized store for user-tunable engine parameters.
    - **Hysteresis Tolerance**: Percentage (default 15%) determining if a recording stop should snap to the nearest quantum boundary.
* **Loop/Box Library**: A metadata-rich catalog storing BPM, length, and music key for every asset.
* **Procedural Automation**: Features to automatically combine existing library elements into new structures.
* **Infinite Radio Mode**: An offline operation mode that generates an infinite stream of music from the user’s clip and box catalog.

## Challenges

1. **The Recursive Clock Problem**: Since users can record without a pre-set BPM, each "Box" may have its own natural tempo. Nesting a Box with one BPM inside another with a different BPM requires sophisticated real-time time-stretching or sample-rate conversion to maintain musical alignment.

#### Proposed Solutions:
* **Seed BPM Retention**: Every clip and box retains its "Seed BPM" (original recorded tempo).
* **Primary-Relative Warping**: When a Box is placed into a "Parent Box" or connected to a "Groove Master," it calculates a **Warp Ratio** (`Target BPM / Seed BPM`).
* **Elastic Audio Engine**: The playback engine uses real-time resampling or phase-vocoding (WSOLA) to warp the buffers to the Primary clock while preserving original metadata for future portability.

2. **Dynamic Phase Alignment**: Maintaining phase coherence when switching between non-contiguous loop ranges or branching between boxes is critical. Without interpolation or phase-alignment, "splices" will cause audible thumps or timbre shifts.

#### Proposed Solutions:
* **Grid-Aware Selection**: Clips utilize a musical grid based on their Seed BPM and meter (i.e. 4/4). 
* **Conservation of Loop Length**: When editing non-contiguous ranges, shifting the "End" of Range A automatically shifts the "Start" of Range B by the inverse amount, ensuring the total musical duration remains a constant quantum.
* **Zero-Crossing Synchronization**: Automatic micro-snapping to waveform zero-crossings or low-transient points at selection boundaries to eliminate DC-offset thumps.

3. **Recursive Audio Mixers**: Efficiently rendering nested structures requires an audio graph where each Box is a sub-mixer. We must manage signal summation and effect processing across deep nests with minimal overhead.
4. **WebView Scheduling Jitter**: Web browsers lack sample-accurate timing. We must implement a "Lookahead Wrapper" where the JS UI schedules events in advance, and the C++ engine executes them with 100% sample precision.
5. **Data Model Scalability & Persistence**: Representing a nested, non-deterministic graph of audio states requires a robust data model that can handle large corpora of structures without performance degradation.
6. **UI Information Density**: Navigating "boxes-within-boxes" requires a high-fidelity navigation system (e.g., zoomable interface or deep breadcrumbs) to prevent user disorientation in complex projects.