---
trigger: always_on
---

# Agent Context

## Workflow
* **Living Documents**:
    * `docs/` contains project context:
        * `design.md`: Goals, UX flows, feature specs
        * `implementation.md`: Roadmap, status, architecture
        * `recording.md`: Recording workflow
    * `.agent/` contains agent context:
        * `agent.md`: Agent context
        * `glossary.md`: Terminology alignment (Quantum, Launch Point, etc.)
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
* **Log File**: Check `celestrian_debug.log` in **project root** (not build dir)

## Coding Principles
* **No Duplication**: Never duplicate logic in multiple places. Extract shared functionality into helper functions. This prevents regressions when one copy is updated but another is forgotten.
* **Unit Tests (REQUIRED)**: Every code change MUST include corresponding unit tests. 
  Do not wait for user to request tests. Tests should verify:
  - The fix works as intended
  - Edge cases are covered  
  - The bug cannot regress

## Reference
* **Glossary**: See `.agent/glossary.md` for terminology alignment (Quantum, Launch Point, etc.)