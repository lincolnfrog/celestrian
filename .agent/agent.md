---
trigger: always_on
---

# Agent Context & Guidelines

## Core Workflow
* **Living Documents**: This project uses a set of living documents in `.agent/` to maintain context.
    * `design.md`: High-level goals, UX flows, and feature specs.
    * `implementation.md`: Development roadmap, current status, and architectural choices.
    * `tech.md`: Technical learnings, "gotchas" (especially with JUCE 8/WebView), and debugging tips.
* **Update First**: When starting a complex task, check `design.md` and `implementation.md` first. When completing a task, update them to reflect reality.

## Coding Standards
* **C++ Style**:
    * **Class Names**: PascalCase (e.g., `AudioBuffer`).
    * **Method Names**: camelCase (e.g., `processAudio`).
    * **Member Variables**: snake_case with valid trailing underscore if private/protected (e.g., `write_pos`, `buffer_size_`).
        * *Note*: We are actively transitioning to this style. New code **must** use snake_case for members.
    * **Pointers**: Prefer `std::unique_ptr` and `std::shared_ptr` over raw pointers.
* **JavaScript Style**:
    * Modern ES6+ modules.
    * `async/await` for all Bridge calls.
    * **No Frameworks**: Vanilla JS/CSS is preferred for this project unless complexity demands otherwise.

## Architecture Principles
* **Bridge Communication**:
    * The C++ engine is the source of truth.
    * The JS UI is a "view" that polls state (`getGraphState`) or reacts to events.
    * **Avoid duplicating state** in JS if possible. Fetch it from C++.
* **Thread Safety**:
    * Audio rendering happens on a high-priority real-time thread.
    * UI calls happen on the Message Thread.
    * Use `std::mutex` where necessary, but aim for lock-free circular buffers for audio data transfer in the future.

## Debugging Habits
* **Bridge Logging**: standard `console.log` in WebView is often lost or hard to see. Use `log()` from `bridge.js` to tunnel messages to the C++ std::cout/terminal.
* **Canvas Visibility**: If a canvas isn't rendering, check CSS flexbox/grid layout. JUCE WebViews can be picky about explicit dimensions.