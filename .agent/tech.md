# JUCE 8 Web-Native Integration Learnings

This document captures technical insights discovered while resolving the audio input and JS-C++ bridge issues in Celestrian.

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
- Use `juce::WebBrowserComponent::getResourceProviderRoot()` to get the correct URL (e.g., `juce://juce.backend/` on Mac).
- This provides a "Virtual Server" origin that allows native integration to function without cross-origin or `file://` security restrictions.

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
- `CAMERA_PERMISSION_ENABLED TRUE`
- These automatically populate the `Info.plist` with necessary usage descriptions.
