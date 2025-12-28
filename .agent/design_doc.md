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
