# JUCE 8 Web-Native Integration Learnings

This document captures technical insights discovered while resolving the audio input and JS-C++ bridge issues in Celestrian.

## Architecture

- **Magnetic Quantum**: ClipNode uses a "magnetic" stop logic where it continues recording until it hits a quantum boundary (set by the first clip in a box) for perfect loop alignment.

## Interaction & Rendering Lessons

### 1. Transport Event Handling
- **Problem**: Mouse clicks on transport buttons were inconsistent compared to the spacebar.
- **Solution**: Use `mousedown` instead of `click`. JUCE's `WebBrowserComponent` (especially on certain platforms) can be picky about click release timing. `mousedown` provides immediate feedback and higher reliability.
- **Problem**: JS Global Hooks race conditions.
- **Solution**: Always assign global hooks (e.g., `window.togglePlayback`) at the very top of `app.js` to ensure they are available before the UI starts rendering or polling.

### 2. UI Conflict & Hit Areas
- **Problem**: Overlapping transparent overlays (like the Creation UI) can "steal" mouse events from the header or other nodes even if they look empty.
- **Solution**: Use `pointer-events: none` on container overlays and `pointer-events: auto` only on specific interactive children. Ensure `z-index` hierarchies are explicit and standard.

### 3. Waveform Rendering Pipeline
- **Problem**: Real-time waveform drawing is expensive and sensitive to canvas sizing.
- **Solution**: Always validate canvas dimensions before drawing. Implement a "visibility floor" (e.g., a tiny 1-2px line during recording) to provide visual heartbeat even when audio signals are low or silence is being recorded.
- **Critical**: JS `ReferenceError` or `TypeError` in the drawing loop will crash the entire `syncUI` polling, making the whole app feel "frozen" or "unresponsive." Always use robust checks.

### 4. Debugging Invisibility & Layout Clipping
- **The Flexbox Trap**: Using `height: 100%` on a canvas within a `flex-grow: 1` container can cause the canvas to inherit the *parent's full height* instead of the remaining space. This results in the canvas bottom (and its center) being clipped by the parent `overflow: hidden`.
- **The Grid Fix**: Switching to `display: grid` with `grid-template-rows: auto 1fr` provides strict vertical containment, ensuring the canvas mid-line is actually visible.
- **Radical Proof-of-Life**: When elements are invisible despite valid data, use "Nuclear" diagnostics:
    - **Purple BG**: Fill the canvas with a unique color *inside* the data-processing loop.
    - **Spatial Markers**: Draw a solid "X" through the entire canvas and 10px borders to detect clipping.
- **Terminal Bridge**: Implement a native C++ `native_log` function to tunnel JavaScript logs to the host terminal. This bypasses browser console limitations and provides immediate visibility into dimension/loop math.
## 1. Native Integration Bridge (JUCE 8)

### Invisibility of Registered Functions
In JUCE 8, using `withNativeFunction` in `WebBrowserComponent::Options` does **not** automatically add functions to the `window.__JUCE__.backend` object in a way that is immediately callable via `backend.myFunction()`.

### The "Invoke" Handshake
Native functions are invoked via a low-level event system:
1.  **Frontend** emits an event named `__juce__invoke`.
2.  **Payload** must contain:
    - `name`: (String) The name of the registered native function.
    - `params`: (Array) The arguments for the function.
    - `resultId`: (Int) A unique identifier for this call.
3.  **Backend** processes the function and emits a `__juce__complete` event.
4.  **Frontend** listens for `__juce__complete` and resolves the promise matching the `promiseId`.

#### Implementation Example (JS):
```javascript
async function callNative(name, ...args) {
    return new Promise((resolve) => {
        const resultId = Date.now();
        window.__JUCE__.backend.addEventListener('__juce__complete', (res) => {
            if (res.promiseId === resultId) resolve(res.result);
        });
        window.__JUCE__.backend.emitEvent('__juce__invoke', {
            name: name, params: args, resultId: resultId
        });
    });
}
```

## 2. Resource Loading & Security

### ResourceProvider
The most stable way to load local content in JUCE 8 is via `withResourceProvider`.
- Use a custom URL scheme (e.g., `http://celestrian.local/`) to map requests to local files.
- This bypasses CORS and `file://` protocol restrictions.
- In `main_component.cc`, we implement a lambda that maps these URLs to the `ui/` directory.

### UI Modularity
For maintainability, the WebView frontend is split into:
- `css/style.css`: Central design system.
- `js/bridge.js`: Native-JS communication layer.
- `js/canvas_renderer.js`: Specialized audio visualization.
- `js/viewport.js`: ZUI logic (Pan/Zoom).
- `js/app.js`: Main state synchronization and DOM orchestration.

### Platform-Specific Paths
In a macOS bundle, the `ui/` folder should be placed inside `Contents/MacOS/` alongside the executable for easy path resolution:
```cpp
auto exe_dir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
auto ui_file = exe_dir.getChildFile("ui/index.html");
```

## 3. WebBrowserComponent API Updates
- **Calling JS from C++**: Use `evaluateJavascript(script)` instead of the older `executeJavaScript`.
- **Bridge Object**: The default object name is `__JUCE__`, but it can be customized.

## 4. Permissions (macOS)
JUCE 8 specific CMake flags for permissions:
- `MICROPHONE_PERMISSION_ENABLED TRUE`
- These automatically populate the `Info.plist` with necessary usage descriptions.

## 5. Recursive Audio Mixing & Thread Safety

### Hierarchical Processing
In a "boxes-within-boxes" architecture, each `BoxNode` acts as a sub-mixer.
1. **Local Scratch Buffer**: To prevent direct feedback or summing errors, each `BoxNode` uses a local `mixBuffer` to capture the output of its children.
2. **Summing**: The output of each child is summed into the parent's `outputChannels` using `juce::FloatVectorOperations::add`.
3. **Lazy Resizing**: Buffers should be resized lazily in the `process()` call to avoid reallocations while still handling dynamic channel/sample changes.

### Thread Safety (Audio vs. Message)
Modifying the graph (adding/removing tracks) from the UI thread while the Audio thread is processing:
- **Mutex Protection**: Use a `std::mutex` in `BoxNode` around child additions and the `process()` loop.
- **Lock-Free Guidelines**: While mutexes are used for now to ensure structural integrity during layout changes, performance-critical nodes should transition to lock-free queues for realtime parameter updates.
