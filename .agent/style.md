---
trigger: always_on
---

# General
* Do not do `using namespace` aliases

# Code Structure
* Split code into small, self-contained files with small, self-contained classes with clear responsibilities.
* Avoid large monolithic functions - in general, each function should only do one thing and should use each parameter exactly once (this last bit is a guideline, not a rule).
* Always add detailed comments to explain the purpose of each public function and class.