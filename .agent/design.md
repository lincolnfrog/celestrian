# Celestrian DAW Design Document

## Project Overview
Celestrian is an open-source Digital Audio Workstation (DAW) built with JUCE and a WebView-based UI.

## Core Technologies
- **Framework**: [JUCE](https://juce.com/)
- **Build System**: CMake with [CPM.cmake](https://github.com/cpm-cmake/CPM.cmake)
- **UI Architecture**: WebView (HTML/CSS/JS) for the frontend, C++ for the engine.
- **Target Platforms**: macOS, Windows, Linux.

## Project Structure
- `src/`: C++ Source code (`snake_case`, `.h`/`.cc`).
- `ui/`: Frontend code (HTML, CSS, JS).
- `external/`: External dependencies (if not managed by CPM).
- `.agent/`: Agent-specific documentation and workflows.

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
* Boxes can be arranged in a graph of connections. The user can place boxes and connect them using various primitives, ex: loop, branch-with-chance, etc.
* Library of loops & clips - the user should be able to slowly build up a library of loops and clips that can be used in boxes. Loops, clips, and boxes should have associated metadata about their bpm, length, and music key. It should be possible to start building some automation features that can generate new music by combining existing clips and boxes in new ways.
* Thus there are sort of three modes of operation: 1) recording & creating new stacks of clips & boxes, 2) editing and designing flows of music through connections between boxes w/ transitions etc. and 3) runnning a large corpus of structure in a sort of "infinite playlist". The user should be able to bounce between (1) and (2) to create live music. (3) shoudl be able to create an infinite offline "radio station" of the user's clip & box catalog.

## Features

### 1. Recording & Live Creation
* **Ad-hoc Tempo Discovery**: Record audio without a pre-set BPM. The system derives the session tempo/quantum from the user's first defined loop length.
* **Latency Compensation**: Establish a baseline latency via a "click-track" calibration, ensuring overdubs align perfectly with existing material.
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
* **Recording Quantization**: All subsequent recordings in that structure are constrained to clean multiples (x2, x4) or divisions (/2, /4) of the Primary Quantum. 
    - If a user stops recording "early," the engine continues capturing until the next clean quantum threshold is met.
* **Stack Interaction**: 
    - **Creation Menu**: A floating **[+]** button at the bottom of the stack allows adding "New Clip" or "New Box". 
    - **Interaction**: The [+] button is a simple circle that reveals a creation dropdown on click.

### 7. Playback & Focus Logic
* **The Global Super-Structure**: Play/stop behaves as a single unit by default. 
* **Focus Playhead**: Selected nodes show a **Playhead Cursor** looping at `master_time % node_duration`.
* **Contextual Solo**: Users can solo the current box context while editing to hear it in isolation.

### 3. Advanced Loop Editing
* **Multi-range Selection**: Define a loop by selecting multiple non-contiguous ranges from a single audio clip.
* **Intelligent Edge Analysis**: Automatic waveform analysis to find optimal zero-crossing or low-transient points at selection boundaries to prevent pops/clicks.
* **Crossfade Synthesis**: Automatic smoothing and phase alignment between non-contiguous loop ranges.

### 4. Corpus & Automation
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