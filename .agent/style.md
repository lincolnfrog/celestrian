---
trigger: always_on
---

# Code Style Guide

## C++ Style
* **Classes**: PascalCase (e.g., `AudioBuffer`)
* **Functions**: camelCase (e.g., `processAudio`)
* **Variables**: snake_case (e.g., `write_pos`, `buffer_size_` for privates)
* **Enums**: Values use UPPER_SNAKE_CASE
* **Pointers**: `Foo*` not `Foo *` (type-aligned)
* Prefer `std::unique_ptr`/`std::shared_ptr` over raw pointers
* No `using namespace` aliases
* Avoid boolean params—use enums; avoid magic numbers—use constants
* Classes should not have public member variables—use getters
* Maximum const-correctness

## JS Style
* Class names: PascalCase, functions/variables: camelCase
* Modern ES6+ with `async/await` for Bridge calls
* Vanilla JS/CSS preferred (no frameworks)
* Avoid embedding JS in HTML

## Code Structure
* Small, single-responsibility files and classes
* Each function does one thing; detailed public API comments
* Aim for 90%+ test coverage

## JUCE WebView Bridge
> [!IMPORTANT]
> **Three-Layer Handshake**: New UI-triggered features require:
> 1. **C++ Logic** (implementation)
> 2. **C++ Bridge** (register via `withNativeFunction` in `MainComponent.cc`)
> 3. **JS Call** (`callNative(...)`)
>
> Missing step #2 causes JS promises to hang forever.

* All native functions MUST log invocation via `juce::Logger::writeToLog`
