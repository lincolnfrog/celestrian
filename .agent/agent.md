---
trigger: always_on
---

# Agent Context

## Workflow
* **Living Documents**:
    * `docs/` contains project context — the index is `docs/README.md`;
      **start with `docs/design_language.md`** (vocabulary, invariants
      I1–I9, the ruling index Q1–Q17). Canon: kernel.md, recording.md,
      time_maps.md, sequencer.md, engine_lcm_guard.md, performance.md.
      `docs/tasks.md` is the tracker. `docs/archive/` is history.
    * `.agent/` contains agent context:
        * `agent.md`: Agent context
        * `glossary.md`: Terminology (a copy of design_language.md §1)
        * `tech.md`: Technical learnings and debugging tips
        * `style.md`: Code style rules (C++, JS, JUCE patterns)
* **Update First**: Check these docs before complex tasks; update them after.

## Architecture
* **C++ engine is source of truth** - JS UI polls state via bridge
* **Thread Safety**: Audio on the realtime thread, UI on the Message
  Thread. `docs/performance.md §1` is the audio-thread contract and
  project law: the audio thread is **lock-free and allocation-free**
  (no mutexes, no heap, no logging on it). Shared state crosses via
  atomics and message-thread-swapped atomic pointers with deferred
  reclamation (the D4 discipline).
* The C++ test binary is under `build/CelestrianTests_artefacts/Debug/`
  — the non-Debug path is stale.

## Debugging
* **Bridge Logging**: Use `log()` from `bridge.js` to tunnel to C++ stdout
* **Canvas Issues**: Check CSS layout; JUCE WebViews need explicit dimensions
* **Log File**: Check `celestrian_debug.log` in **project root** (not build dir)

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
# Open http://localhost:8080/index_test.html
```

**Usage**:
1. Click scenario buttons in the sidebar to load test cases
2. Open devtools (F12) for console logs
3. Edit JS/CSS files, refresh browser (Cmd+R) - changes appear instantly
4. Use browser subagent to test interactions visually

**Files**:
- `ui/js/mock_backend.js` (+ `ui/js/mock/*.js`) - Simulates the JUCE bridge; state + protocol only, all timing math imported from `timeline_model.js`
- `ui/js/backend.js` - The facade that selects mock vs JUCE bridge (`?mock=true` exposes `window.__celestrianTest`)
- `ui/index_test.html` - Test harness page (dynamically imports `app.js`)

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
1. **Specify exact URL first**: Always start with `Navigate to http://localhost:8080/index_test.html`
2. **Give explicit step-by-step actions**: List each click, wait, or inspection action clearly
3. **Define clear return conditions**: Explicitly state what information to report and when to stop
4. **Request screenshots**: Always ask for a screenshot at key points

**Example Task (GOOD)**:
```
Navigate to http://localhost:8080/index_test.html. Wait for the page to fully load.
Click the 'Stack with 3 Clips' button in the scenario sidebar.
Wait 1 second for rendering. Take a screenshot.
Inspect the DOM for elements matching '.rep.ghost'.
Report: (1) how many ghost elements exist, (2) their visibility/opacity styles,
(3) their positions. Return with findings.
```

**Example Task (BAD - causes about:blank)**:
```
Debug the ghost clip rendering issue.
```

**Common mistake**: Trying to debug visual/rendering issues purely from code inspection. Always use the browser subagent first to understand what's actually happening visually. Synthetic-event tests bypass hit-testing — real-input verification is the law for interactive elements (time_maps.md journal).

## Coding Principles
* **No Duplication**: Never duplicate logic in multiple places. Extract shared functionality into helper functions. This prevents regressions when one copy is updated but another is forgotten.
* **Unit Tests (REQUIRED)**: Every code change MUST include corresponding unit tests.
  Do not wait for user to request tests. Tests should verify:
  - The fix works as intended
  - Edge cases are covered
  - The bug cannot regress
* **Timing math lives in two mirrors** (`src/timing.h` ↔ `ui/js/timeline_model.js`), pinned by `shared/timing_golden.json`. A bridge method lives in three places (`protocol.js` ↔ `main_component.cc` ↔ `mock_backend.js`), pinned by the contract test.

## Reference
* **Glossary**: `.agent/glossary.md` (copy of `docs/design_language.md §1`)
