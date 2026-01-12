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

## Frontend Development & UI Testing

### Mock Backend Test Harness
**When to use**: For ANY frontend/UI work (drag-drop, rendering, layout, styling, etc.)

**Why**: 
- ⚡ **5 second** iteration vs 5 minute rebuild
- 🔍 Full browser devtools (inspect, breakpoints, console)
- 🎯 Reproducible test scenarios
- 🚀 Independent of C++ backend

**Setup**:
```bash
cd ui
python3 -m http.server 8001
# Open http://localhost:8001/index_test.html
```

**Usage**:
1. Click scenario buttons to load test cases (Empty, Single Clip, Stack, Multiple Stacks)
2. Open devtools (F12) for console logs
3. Edit JS/CSS files, refresh browser (Cmd+R) - changes appear instantly
4. Use browser subagent to test interactions visually

**Files**:
- `ui/js/mock_backend.js` - Simulates JUCE bridge
- `ui/js/app_test.js` - App with mock backend
- `ui/index_test.html` - Test harness page

**Adding scenarios**: Edit `loadScenario()` in `mock_backend.js`

**Workflow**:
1. Reproduce issue in test harness by creating scenario
2. Debug with browser devtools (inspect elements, set breakpoints)
3. Fix code and test instantly
4. Once fixed, rebuild C++ app to verify integration
5. Remember: `app.js` is production, `app_test.js` is test version
6. Always restart the HTTP server after making changes to JS files to avoid caching issues

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
1. **Specify exact URL first**: Always start with `Navigate to http://localhost:8000/index_test.html` (or port 8001)
2. **Give explicit step-by-step actions**: List each click, wait, or inspection action clearly
3. **Define clear return conditions**: Explicitly state what information to report and when to stop
4. **Request screenshots**: Always ask for a screenshot at key points

**Example Task (GOOD)**:
```
Navigate to http://localhost:8000/index_test.html. Wait for the page to fully load.
Click the 'Stack with 3 Clips' button in the test controls panel on the right.
Wait 1 second for rendering. Take a screenshot.
Inspect the DOM for elements with class 'ghost-repetition'.
Report: (1) how many ghost elements exist, (2) their visibility/display styles,
(3) their positions. Return with findings.
```

**Example Task (BAD - causes about:blank)**:
```
Debug the ghost clip rendering issue.
```

**Common mistake**: Trying to debug visual/rendering issues purely from code inspection. Always use the browser subagent first to understand what's actually happening visually.

## Coding Principles
* **No Duplication**: Never duplicate logic in multiple places. Extract shared functionality into helper functions. This prevents regressions when one copy is updated but another is forgotten.
* **Unit Tests (REQUIRED)**: Every code change MUST include corresponding unit tests. 
  Do not wait for user to request tests. Tests should verify:
  - The fix works as intended
  - Edge cases are covered  
  - The bug cannot regress

## Reference
* **Glossary**: See `.agent/glossary.md` for terminology alignment (Quantum, Launch Point, etc.)