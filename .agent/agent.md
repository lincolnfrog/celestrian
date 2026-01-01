---
trigger: always_on
---

# Agent Context

## Workflow
* **Living Documents**: `.agent/` contains project context:
    * `design.md`: Goals, UX flows, feature specs
    * `implementation.md`: Roadmap, status, architecture
    * `tech.md`: Technical learnings and debugging tips
    * `style.md`: Code style rules (C++, JS, JUCE patterns)
* **Update First**: Check these docs before complex tasks; update them after.

## Architecture
* **C++ engine is source of truth** - JS UI polls state via bridge
* **Thread Safety**: Audio on realtime thread, UI on Message Thread
* Use `std::mutex` for shared state; aim for lock-free audio buffers

## Debugging
* **Bridge Logging**: Use `log()` from `bridge.js` to tunnel to C++ stdout
* **Canvas Issues**: Check CSS layout; JUCE WebViews need explicit dimensions

## Coding Principles
* **No Duplication**: Never duplicate logic in multiple places. Extract shared functionality into helper functions. This prevents regressions when one copy is updated but another is forgotten.
* **Unit Tests**: Add tests for critical logic paths to prevent recurring regressions.