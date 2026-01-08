# Mock Backend Test Harness

## Purpose
Independent UI testing framework for Celestrian that runs in a regular browser without requiring the JUCE C++ backend.

## Files
- **`ui/js/mock_backend.js`** - Simulates native C++ bridge with in-memory state
- **`ui/js/app_test.js`** - Modified app.js that uses mock backend
- **`ui/index_test.html`** - Test harness page with scenario selector

## Usage

### 1. Start Local Server
```bash
cd ui
python3 -m http.server 8000
```

### 2. Open Test Harness
Navigate to: `http://localhost:8000/index_test.html`

### 3. Test Scenarios
Use the sidebar to load different scenarios:
- **Empty Canvas** - Start fresh
- **Single Clip** - One top-level clip with ghost repetitions  
- **Stack with 3 Clips** - Test stack rendering and vertical layout
- **Multiple Stacks** - Test freeform positioning

### 4. Test Features
- **Drag-and-drop**: Grab the handle (dots on left) and drag
- **Collapse/expand**: Click the handle on stack top-right
- **Create nodes**: Click "+ New Stack" button
- **Stack menu**: Click "+" on stack to add clips

## Benefits
✅ Instant UI iteration without C++ rebuild
✅ Test specific scenarios easily
✅ Debug drag-and-drop visually in browser devtools
✅ Automated testing possible

## Adding New Scenarios

Edit `ui/js/mock_backend.js` and add a new case to `loadScenario()`:

```javascript
case 'my-scenario':
    state.nodes = [
        {
            id: 'clip-1',
            name: 'Test Clip',
            type: 'clip',
            x: 100,
            y: 100,
            w: 400,
            h: 100,
            duration: 2.0,
            effectiveQuantum: 2.0,
            isRecording: false,
            // ... other properties
        }
    ];
    break;
```

Then add a button in `index_test.html`:
```html
<button onclick="loadScenario('my-scenario')">My Scenario</button>
```

## Limitations
- No actual audio playback/recording
- Waveform data is simulated
- State resets on page reload
- File:// protocol won't work due to CORS - must use HTTP server

## Debugging
Open browser devtools (F12) to see:
- `[MockBackend]` logs for backend calls
- `[App]` logs for UI lifecycle
- `[DragInit]` logs for drag-and-drop setup
- `[Ghost]` logs for ghost rendering logic
