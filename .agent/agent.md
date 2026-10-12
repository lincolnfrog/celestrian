---
trigger: always_on
---

# Agent Context

## Workflow

- **Living Documents**:
    - `docs/` contains project context — the index is `docs/README.md`;
      **start with `docs/design_language.md`** (vocabulary, invariants
      I1–I9, the ruling index Q1–Q17). Canon: kernel.md, recording.md,
      time_maps.md, sequencer.md, engine_lcm_guard.md, performance.md.
      `docs/tasks.md` is the tracker. `docs/archive/` is history.
    - `.agent/` contains agent context:
        - `agent.md`: Agent context
        - `glossary.md`: Terminology (a copy of design_language.md §1)
        - `tech.md`: Technical learnings and debugging tips
        - `style.md`: Code style rules (C++, JS, JUCE patterns)
- **Update First**: Check these docs before complex tasks; update them after.

## Architecture

- **C++ engine is source of truth** - JS UI polls state via bridge
- **Thread Safety**: Audio on the realtime thread, UI on the Message
  Thread. `docs/performance.md §1` is the audio-thread contract and
  project law: the audio thread is **lock-free and allocation-free**
  (no mutexes, no heap, no logging on it). Shared state crosses via
  atomics and message-thread-swapped atomic pointers with deferred
  reclamation (the D4 discipline).
- The C++ test binary is under `build/CelestrianTests_artefacts/Debug/`
  — the non-Debug path is stale.

## Tests: the layers, and when to run which

`docs/test_harness.md` is the full write-up. All `npm` commands run in
`ui/`. Beside the C++ suite there are four JS-side layers; the fourth,
the differential, is the one that compares the mock with the engine.

| Layer | Command | Run it when |
|---|---|---|
| C++ engine | `cmake --build build --target CelestrianTests -j6`, then `build/CelestrianTests_artefacts/Debug/CelestrianTests` (`--category=<name>` for one suite) | anything under `src/` or `tests/` changed |
| JS unit | `npm test` (= `node --test js/tests/*.test.mjs`; one file: `node js/tests/<name>.test.mjs`) | anything under `ui/js/` changed |
| Mock-page e2e | `npm run test:playwright` (serves `ui/` on 8080 itself, or reuses a running server) | the session view, the shell, the mock, or a spec changed |
| Engine e2e | `npm run test:engine` (needs `CelestrianHeadless` built) | the engine's published state or the view's reading of it changed |
| Differential | `npm run test:diff` (needs `CelestrianHeadless` built; exit 77 = skipped, engine not built) | the mock (`ui/js/mock/**`, `mock_backend.js`) or an engine verb's behaviour changed |

`npm run test:all` runs the four JS-side layers in that order. Mock-page
specs boot through `boot` in `ui/e2e/helpers.js` (the shared recipes;
real input is the law; no `waitForTimeout`). Under test the mock's
clock is STEPPED — a test moves time with `advanceBy`, never by
polling.

- **Mock-vs-engine parity is pinned by the differential, not by unit
  tests.** `npm test` passing does not show the mock still matches the
  engine; `npm run test:diff` does. Do not add a unit test that replays
  an engine sequence on the mock — add a journey to
  `ui/differential/journeys.mjs`.
- **Deleting a test as redundant needs a named twin** that asserts the
  same fact in the same situation, and the twin then stays: a case
  deleted on a twin always leaves a kept twin.
- C++ categories: `--category=Scenarios` (the catalog,
  `docs/scenarios.md`), `--category=Golden` (the golden-fixture
  readers).

## Debugging

- **Bridge Logging**: Use `log()` from `backend.js` to tunnel to C++ stdout
- **Canvas Issues**: Check CSS layout; JUCE WebViews need explicit dimensions
- **Log File**: Check `celestrian_debug.log` in **project root** (not build dir)

## Frontend Development & UI Testing

### Mock Backend Test Harness

**When to use**: For ANY frontend/UI work (drag-drop, rendering, layout, styling, etc.)

**Why**:
- ⚡ **5 second** iteration vs 5 minute rebuild
- 🔍 Full browser devtools (inspect, breakpoints, console)
- 🎯 Reproducible test scenarios
- 🚀 Independent of C++ backend

**Setup** (port 8080 — `.claude/launch.json` config `celestrian-ui`,
also what `playwright.config.js` serves):
```bash
cd ui
npx serve . -p 8080
# Open http://localhost:8080/?mock=true&harness=1
```

**Usage**:
1. Click scenario buttons in the sidebar to load test cases
2. Open devtools (F12) for console logs
3. Edit JS/CSS files, refresh browser (Cmd+R) - changes appear instantly
4. Use browser subagent to test interactions visually

**Files**:
- `ui/js/mock_backend.js` (+ `ui/js/mock/*.js`) - Simulates the JUCE bridge; state + protocol only, all timing math imported from the mirror modules (below)
- `ui/js/backend.js` - The facade that selects the backend: `?mock=true` (the mock, with `window.__celestrianTest`), `?engine=true` (the headless engine server), else the JUCE bridge
- `ui/js/harness_sidebar.js` - The scenario sidebar, mounted beside the app under `&harness=1` (`ui/index_test.html` only redirects to `/?mock=true&harness=1`)

**Adding scenarios**: Edit `ui/js/mock/scenarios.js`

**Workflow**:
1. Reproduce issue in test harness by creating scenario
2. Debug with browser devtools (inspect elements, set breakpoints)
3. Fix code and test instantly
4. Once fixed, rebuild C++ app to verify integration
5. Always restart the HTTP server after making changes to JS files to avoid caching issues

**See**: [`docs/test_harness.md`](file:///Users/lincolnfrog/code/celestrian/docs/test_harness.md) for full documentation

### ES Module Cache Busting

When testing JS changes, the browser may cache ES modules aggressively. If changes don't appear:
1. **Restart the HTTP server** - kills any server-side caching
2. **Add cache-bust query params** won't work for ES module imports (only works for the HTML page)
3. **Use DevTools** → Network tab → check "Disable cache" while DevTools is open
4. **Hard refresh** (Cmd+Shift+R on Mac) after restarting server

### Browser Subagent for Visual Debugging

**CRITICAL TOOL**: When debugging UI issues (especially rendering, DOM structure, CSS, or visual layout problems), use the browser subagent to:
- Navigate to the test harness URL
- Inspect DOM elements visually
- Inject clicks to test interactions
- Capture screenshots for debugging
- Read computed styles and element positions

**Why use browser subagent**:
- ✅ See what the user sees (visual confirmation)
- ✅ Inspect DOM directly in context
- ✅ Debug CSS positioning issues
- ✅ Test click handlers and interactions
- ✅ Capture evidence of bugs

**Required Task Structure for Browser Subagent**:
1. **Specify exact URL first**: Always start with `Navigate to http://localhost:8080/?mock=true&harness=1`
2. **Give explicit step-by-step actions**: List each click, wait, or inspection action clearly
3. **Define clear return conditions**: Explicitly state what information to report and when to stop
4. **Request screenshots**: Always ask for a screenshot at key points

**Example Task (GOOD)**:
```text
Navigate to http://localhost:8080/?mock=true&harness=1. Wait for the page to fully load.
Click the 'Stack with 3 Clips' button in the scenario sidebar.
Wait 1 second for rendering. Take a screenshot.
Inspect the DOM for elements matching '.rep.ghost'.
Report: (1) how many ghost elements exist, (2) their visibility/opacity styles,
(3) their positions. Return with findings.
```

**Example Task (BAD - causes about:blank)**:
```text
Debug the ghost clip rendering issue.
```

**Common mistake**: Trying to debug visual/rendering issues purely from code inspection. Always use the browser subagent first to understand what's actually happening visually. Synthetic-event tests bypass hit-testing — real-input verification is the law for interactive elements (time_maps.md journal).

## Coding Principles

- **No Duplication**: Never duplicate logic in multiple places. Extract shared functionality into helper functions. This prevents regressions when one copy is updated but another is forgotten.
- **Unit Tests (REQUIRED)**: Every code change MUST include corresponding unit tests.
  Do not wait for user to request tests. Tests should verify:
  - The fix works as intended
  - Edge cases are covered
  - The bug cannot regress
- **Timing math lives in two mirrors**, pinned to the same numbers by `shared/timing_golden.json`. Change one side, change its twin and add a golden case:
  - `src/timing.h` ↔ `ui/js/time_map.js` (the node equation `innerAt`, `stackFold`, the top) and `ui/js/timeline_model.js` (`armTarget`, `nextStopBoundary`, `snapCommittedDuration`, `launchPointFor`)
  - `src/period_law.h` ↔ `ui/js/period_law.js` (own period, contribution, drift, island cycle, scope cycle)
  - `src/heard_index.h` ↔ `ui/js/mock/heard.js` (the heard-position walk and the continuity origin)
  - `src/sequence.h` ↔ `ui/js/sequence_program.js`; `src/qtime.h` ↔ `ui/js/qtime.js`, `ui/js/math_utils.js` (`posMod`)
- **A bridge method lives in three places** (`ui/js/protocol.js` ↔ `src/bridge_dispatch.cc` ↔ `ui/js/mock_backend.js`; a verb that needs a window is bound in `src/main_component.cc`), pinned by `ui/js/tests/protocol_contract.test.mjs`.
- **`ui/js/view_model.js` and `ui/js/timeline_model.js` are facades**: the view model's parts live in `ui/js/vm/*`, the app shell's in `session_facts.js`, `shell_io.js`, `content_cache.js`, `edit_verdict.js`, `record_verbs.js`, `structure_verbs.js`, `project_menu.js`. Put new code in the part that owns it, not in the facade.

## Reference

- **Glossary**: `.agent/glossary.md` (copy of `docs/design_language.md §1`)
