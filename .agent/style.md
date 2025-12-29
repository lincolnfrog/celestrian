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
* Function names are PascalCase (even simple "getters and setters")
* Variable names are snake_case
* Do not do `using namespace` aliases
* Avoid hard-coded strings - use enums and/or constants instead
* Avoid boolean parameters - use enums instead

# JS Style Guidelines
* Class names are PascalCase
* Function names are camelCase
* Variable names are camelCase
* Do not embed JS code in HTML as much as possible
