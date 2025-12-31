---
trigger: always_on
---

# Code Structure
* Split code into small, self-contained files with small, self-contained classes with clear responsibilities.
* Avoid large monolithic functions - in general, each function should only do one thing and should use each parameter exactly once (this last bit is a guideline, not a rule).
* Always add detailed comments to explain the purpose of each public function and class.

# Unit tests
* Always add unit tests while writing code.
* Aim for 90%+ test coverage.

# C++ Style Guidelines
* Class names are PascalCase
* Function names are camelCase. Exception: if overriding a virtual function from an external library, like JUCE, use the same name as the base class.
* Variable names are snake_case.
Exception: the JSON metadata we pass to the UI has camelCase keys.
* Do not do `using namespace` aliases
* Avoid hard-coded strings - use enums and/or constants instead
* Avoid boolean parameters - use enums instead
* Enum values are uppercase SNAKE_CASE.
* Use Foo* for pointers, not Foo * (with a space) - the * is part of the type, not the variable name. This rule also applies to references and other similar syntax.
* Try to ensure maximum const-correctness - use const where possible.
* Classes should not have public member variables, use getters instead.

# JS Style Guidelines
* Class names are PascalCase
* Function names are camelCase
* Variable names are camelCase
* Do not embed JS code in HTML as much as possible

# JUCE WebView & Bridge
* **The Three-Layer Handshake**: When adding a UI-triggered feature, you MUST update:
  1. **C++ Logic** (The implementation)
  2. **C++ Bridge** (Register with `withNativeFunction` in `MainComponent.cc` - **CRITICAL** or memory hangs)
  3. **JS Call** (`callNative(...)`)
* **Bridge Logging**: All native functions MUST log their invocation using `juce::Logger::writeToLog` for debugging (e.g., "[Bridge] togglePlay called").
