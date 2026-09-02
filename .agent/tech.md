# Celestrian Technical Learnings & Reference

This document captures technical insights, gotchas, and debugging
strategies that are still true against the code (trued 2026-09-01).
Architecture and timing canon live in `docs/` (start at
`docs/design_language.md`); this file is only the practical tips.

## 1. Architecture & Audio Engine

### Stops run forward to the boundary
*   When the user presses stop, `ClipNode` keeps recording until the
    NEXT Q boundary (`nextStopBoundary`, chosen by the audio thread;
    the UI shows "finishing…" via `isAwaitingStop`). There is no
    downward snap (owner ruling 2026-07-10). Arms target the next Q
    boundary in the heard frame (Q11).

### Thread safety
*   Audio on the realtime thread, UI on the Message Thread. The audio
    thread is lock-free and allocation-free — `docs/performance.md §1`
    is the contract. Shared structures (content buffers, time-maps,
    sequences, fx chains) are swapped by the message thread through
    atomic pointers and retired via the reclaimer (the D4 discipline);
    parameters are atomics.
*   Nesting is generic on `AudioNode` (`ClipNode` / `StackNode`);
    context flows down through `ProcessContext`, never by casting.

---

## 2. JUCE 8 & WebView Integration

### The "Invoke" pattern (JS <-> C++)
JUCE 8's `withNativeFunction` uses an event-based handshake, not direct
`window` exposure — see `callNative` in `ui/js/bridge.js`
(`__juce__invoke` / `__juce__complete`). Adding a bridge method touches
three places (`protocol.js`, `main_component.cc`, `mock_backend.js`) or
the contract test fails — see `style.md`.

### Logging
*   Use `log()` (imported from `bridge.js`), **not** `console.log()`.
    Route: JS `log` → `callNative('nativeLog')` → `juce::Logger` →
    `celestrian_debug.log` in the project root (`src/main.cc`).
    `console.log` only reaches the invisible WebView console.
*   The nativeLog leg is failure-safe (a throwing bridge is swallowed).

### State dumps
*   The 📦 Dump State button writes `celestrian_state.json` (app cwd)
    with every node's timing fields and the `perf` block. Ask for a
    dump first for any alignment bug — it has settled every field bug
    so far in one glance (`docs/test_harness.md`, Field debugging).

### Resource loading
*   `file://` is blocked by CORS; the app serves `ui/` through
    `withResourceProvider` (`src/main_component.cc`) under a custom
    scheme, mapped relative to the executable (macOS bundle aware).

### Permissions (macOS)
*   CMake: `MICROPHONE_PERMISSION_ENABLED TRUE` (adds the usage
    description to `Info.plist`).

### Stale bundle resources
*   The app bundle's `ui/` copy is refreshed only on relink. JS/CSS-only
    edits can leave the field build running stale UI (symptom: `[JS]`
    logs missing new messages). Force a relink or sync `ui/` into
    `Celestrian.app/Contents/MacOS/ui/` by hand.

### Stale test binary
*   Run `build/CelestrianTests_artefacts/Debug/CelestrianTests`. A
    stale binary at the non-`Debug/` path once reported green for
    months (`docs/test_harness.md` gotcha 1).

---

## 3. UI Interaction & Rendering (WebView)

### Idempotent DOM writes
*   WebKit swallows a click whose mousedown-target text node was
    replaced before mouseup, and the 50 ms poll tick makes unconditional
    writes hit most human clicks. Never write a DOM value that has not
    changed (`setText`/`setHtml`/`setTitle` in `session_view/sv_util.js`;
    display law 2, `docs/ui_overhaul.md §6`).

### Canvas sizing
*   `width="100%"` in HTML is not enough: size the backing store in JS
    from the CSS box × devicePixelRatio (`fitCanvas` in `ui/js/theme.js`)
    or the render is blurry.

### Overlays and hit-testing
*   Overlay layers are `pointer-events: none` with `pointer-events:
    auto` on their interactive children (`ui/css/session.css`). New
    chrome inside an overlay must opt in or it cannot be grabbed —
    and synthetic-event tests bypass hit-testing, so verify
    interactive elements with real input in the browser harness.

### Motion
*   Every animation respects `prefers-reduced-motion` (`session.css`).
    Time-based glides use `setTimeout`, not rAF, when they must run
    while the tab is unfocused (webviews throttle rAF).
