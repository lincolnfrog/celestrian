# Celestrian Technical Learnings & Reference

This document captures technical insights, "gotchas", and debugging strategies- **Use `log()` for Debugging**: In JS, always use `log()` instead of `console.log()` to ensure output writes to `celestrian_debug.log`.
- **Generic AudioNode Abstraction**: Logic should be generic on `AudioNode`. Avoid casting to `ClipNode` or `BoxNode` unless absolutely necessary. Arbitrary nesting (Box containing Boxes) is a core requirement.
- **State Dumps**: Use the "📦 Dump State" button in the UI (or `getGraphState()` in C++) to inspect the full JSON tree of the session for debugging.! Use `tail -100 celestrian_debug.log` and `cat celestrian_state.json`.

# Technology & Logic

## Debugging

### Logging Pipeline
To debug JS issues without a browser console:
1.  **Usage**: Import `log` from `bridge.js` (`import { log } from './bridge.js';`).
2.  **Call**: `log("Your message");` inside `app.js`.
3.  **Route**: JS `log` -> `callNative('nativeLog')` -> C++ `juce::Logger` -> `celestrian_debug.log`.
4.  **View**: Check `celestrian_debug.log` in the root directory.

*Note: Standard `console.log` only prints to the invisible browser console.*

## 1. Architecture & Audio Engine

### "Magnetic Quantum" Audio Recording
*   **Concept**: `ClipNode` uses a "magnetic" stop logic.
*   **Behavior**: When a user presses stop, the engine *continues* recording until it hits a "Quantum Boundary" (a multiple of the first clip's length).
*   **Purpose**: Ensures every clip is a perfect loop multiple of the project's rhythmic core, allowing for seamless looping without complex time-stretching in the early stages.

### Recursive Audio Graph
*   **BoxNode as Mixer**: Every `BoxNode` is a sub-mixer that sums its children.
*   **Local Scratch Buffer**: To prevent feedback and summing errors, each `BoxNode` sums children into a local `mixBuffer` before adding to the parent's buffer.
*   **Lazy Resizing**: Buffers are resized lazily inside `process()` to handle dynamic channel changes without constant reallocations.

### Thread Safety
*   **UI vs Audio**: Graph modifications (adding/removing nodes) happen on the Message Thread. Audio processing happens on the Realtime Thread.
*   **Strategy**: Currently using `std::mutex` in `BoxNode` to protect child lists processing. Future optimization: lock-free queues for parameter updates.

---

## 2. JUCE 8 & WebView Integration

### The "Invoke" Pattern (JS <-> C++)
JUCE 8's `withNativeFunction` uses an event-based handshake (not direct `window` exposure).

**JS Pattern** (see `ui/js/bridge.js`):
```javascript
async function callNative(name, ...args) {
    // 1. Generate unique result ID
    // 2. Listen for __juce__complete
    // 3. Emit __juce__invoke
}
```

> See `style.md` for the **Three-Layer Handshake** checklist when adding new bridge functions.

### Debugging & Logging
*   **Rule**: Use `log()` (imported from `bridge.js`), **NOT** `console.log()`.
*   **Why**: standard `console.log` messages in the WebView are often swallowed or not bridged to the native C++ stdout in production/release builds. The `log()` helper explicitly bridges the message to the C++ logger, ensuring it appears in your terminal.

### Resource Loading
*   **Problem**: CORS blocking local file access (`file://`).
*   **Solution**: Use `withResourceProvider` with a custom scheme (e.g., `http://celestrian.local/`).
*   **Mapping**: Map requests to the `ui/` directory relative to the executable (macOS Bundle support included).

### Permissions (macOS)
*   Required CMake Flag: `MICROPHONE_PERMISSION_ENABLED TRUE`
*   Required CMake Flag: `MICROPHONE_PERMISSION_ENABLED TRUE`
*   Effect: Automatically adds usage descriptions to `Info.plist`.

### Stale Bundle Resources
*   **Problem**: Changing JS/CSS files in `ui/` might not trigger a re-copy to the app bundle (`Celestrian.app/Contents/MacOS/ui`).
*   **Symptom**: `[JS]` logs missing new messages, behavior unchanged after edits.
*   **Fix**: Manually copy: `cp -r ui/ build/.../Celestrian.app/Contents/MacOS/ui/` or force a clean build.

---

## 3. UI Interaction & Rendering (WebView)

### Transport Event Handling
*   **Issue**: `click` events on buttons can be flaky or slow.
*   **Fix**: Use `mousedown` for transport controls (Play, Record, Solo). It's more responsive and reliable in the WebView environment.

### Global JS Hooks
*   **Issue**: Race conditions if C++ tries to call JS functions before they are defined.
*   **Fix**: Define global hooks (`window.togglePlayback`, etc.) at the **very top** of `app.js` or `bridge.js`, before any DOMContentLoaded listeners.

### Waveform Rendering
*   **Canvas Sizing**: `width="100%"` in HTML is not enough. You must explicitly set `canvas.width = clientWidth` in JS to avoid blurry rendering.
*   **Flexbox Clipping**: A canvas inside a `flex-grow` container often overflows. Use **CSS Grid** (`grid-template-rows: auto 1fr`) for robust vertical containment.
*   **Visibility Floor**: During silence, draw a 1px line so the user knows the system is working.

---

## 4. Debugging Cheatsheet

### "The UI is frozen / Loading..."
*   **Cause**: JS Error in the polling loop (`syncUI`) or Bridge timeout.
*   **Check**: Look at the terminal output. We pipe JS logs to C++ stdout via `log()`.
*   **Fix**: Wrap the `syncUI` loop in a `try/catch` block to prevent one error from killing the interface.

### "I can't see the Canvas"
*   **Diagnostic 1**: Apply `background: purple` to the canvas in CSS. If you don't see purple, it's a layout/size issue (0 height).
*   **Diagnostic 2**: Draw a hard-coded red "X" in the JS render loop. If you see purple but no X, the render loop isn't running.

### "Clicks aren't registering"
*   **Cause**: Transparent overlays (like `creation-ui`) might be covering the buttons.
*   **Fix**: Add `pointer-events: none` to container overlays, and `pointer-events: auto` to their interactive children.
