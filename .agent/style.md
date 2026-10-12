---
trigger: always_on
---

# Code Style Guide

## General

- Avoid truncated words like "pos" for "position" and "num" for number. Example: instead of "read_pos", just use "read_position". Also consider more legible alternatives, for example "num_peaks" should be "peak_count" instead.

## C++ Style

- **Classes**: PascalCase (e.g., `AudioBuffer`)
- **Functions**: camelCase (e.g., `processAudio`)
- **Variables**: snake_case (e.g., `write_pos`, `buffer_size_` for privates)
- **Enums**: Values use UPPER_SNAKE_CASE
- **Pointers**: `Foo*` not `Foo *` (type-aligned)
- Prefer `std::unique_ptr`/`std::shared_ptr` over raw pointers
- No `using namespace` aliases
- Avoid boolean params—use enums; avoid magic numbers—use constants
- Classes should not have public member variables—use getters
- Maximum const-correctness

## JS Style

- Class names: PascalCase, functions/variables: camelCase
- Modern ES6+ with `async/await` for Bridge calls
- Vanilla JS/CSS preferred (no frameworks)
- Avoid embedding JS in HTML

## Code Structure

- Small, single-responsibility files and classes
- Each function does one thing; detailed public API comments
- Aim for 90%+ test coverage

## Comments describe what IS (owner rule, 2026-09-01)

- A comment states the present law: what the code does and the standing
  constraint that makes it necessary. Never the history of how it got
  there.
- No dates, audit item numbers, "field video", "previously / used to /
  the old X", "supersedes", "round N". History lives in docs/ (and
  docs/archive/), which already carry it.
- Cite rulings and docs by NAME and section — `(Q18, composition.md §2)`,
  `(S7, sequencer.md §5)`, `(I5)` — never by date.
- Keep a hazard, drop the story: "X must …, otherwise Y" stays; "Y broke
  on 2026-08-29 when …" goes.
- Test references are present-tense facts and stay ("pinned by
  tests/content_frame_tests.cc").
- Length follows subtlety: a one-line fact gets one line.

## JUCE WebView Bridge

> [!IMPORTANT]
> **A bridge method lives in three places**, or the contract test
> (`ui/js/tests/protocol_contract.test.mjs`) fails:
> 1. **`ui/js/protocol.js`** — the canonical list; add the method here first
> 2. **`src/bridge_dispatch.cc`** — its entry in the table both hosts serve (the app shell and the headless engine server). A verb that needs a window (a file chooser, a plugin editor) is bound in `src/main_component.cc` with `bindWindowVerb` instead
> 3. **`ui/js/mock_backend.js`** — its handler in the `handlers` table
>
> A name with no C++ registration leaves the page's promise hanging forever.

- **An entry's KIND is its answer**, and the three places must agree on it (the contract test parses the C++ registrations and calls the mock for every verb). Write a table entry with one of the three forms in `src/bridge_dispatch.h`:
  - `boolMethod` — a verb the engine can REFUSE answers whether it applied: `true` it did; `false` it was refused and nothing changed (also for missing arguments). `protocol.js`: `returns: 'bool — …'`.
  - `valueMethod` — the value the page reads (a state, a list, a new node's uuid). `protocol.js`: `returns` with any other text; add `read: true` for a query that changes nothing (the only calls the HTTP bridge may send twice).
  - `voidMethod` — a knob or a notification nothing can refuse; answered `true` once it ran. `protocol.js`: no `returns`.
- **An edit that would change nothing is not applied**: it records no undo step, keeps the redo branch, and answers `false`. A new undoable verb checks for the identity before it calls `record()`.
- **The status line reads the answer.** In the shell every user verb goes through `call` / `callEach` (`ui/js/shell_io.js`) with a `failMsg`; never write a success line ahead of the answer.
- Optional arguments go through `strArg` / `optSamples` / `flagArg`. The forms trace the call through `bridge::logCall`, in DEBUG builds only — do not add per-call release logging (log spam; owner ruling). Functional logging (e.g. `nativeLog` relaying the JS payload, `dumpStateToFile` recording its target path) is separate and stays in all builds. A hand-written handler (async, several branches) calls `logCall` itself.

## Timing mirrors

- Timing math is written twice — C++ for the engine, JS for the view and the mock — and pinned to the same numbers by `shared/timing_golden.json`. Change one side, change its twin, add a golden case. The pairs: `src/timing.h` ↔ `ui/js/time_map.js` + `ui/js/timeline_model.js`; `src/period_law.h` ↔ `ui/js/period_law.js`; `src/heard_index.h` ↔ `ui/js/mock/heard.js`; `src/sequence.h` ↔ `ui/js/sequence_program.js`; `src/qtime.h` ↔ `ui/js/qtime.js` + `ui/js/math_utils.js`. The table is in `docs/test_harness.md` "Adding timing math".
