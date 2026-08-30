# UI/Backend Separation of Concerns

> Status: **spec**. The canonical bridge method list lives in
> `ui/js/protocol.js` (contract-tested against C++ and the mock); this
> doc owns the *placement rules* for what belongs on which side.

This document defines the abstraction boundary between the Celestrian frontend (JavaScript) and backend (C++).

## Principles

### Backend Responsibilities (C++)
- Audio processing and playback
- Recording and buffer management  
- Transport state (samples, not pixels)
- Node graph structure (ordered lists, not positions)
- Loop points (in samples)
- Persistence-worthy state

### The masterPos contract

`getGraphState().masterPos` is a **derived display position**, never the
raw monotonic clock (kernel.md step 3): wrapped to the cycle while
idle/playing, and **growing linearly past the committed LCM while
recording** (from a base frozen at record start), so the cursor extends
into new Qs. Consumers must not re-wrap it — re-deriving with
`mod cycle` in the UI caused the "recording loops the old cycle" field
bug (2026-07-09). The mock mirrors this contract exactly
(`mock_backend.viewMasterPos`). Similarly, a recording clip's
`duration` is the live written length (`live_duration_samples`), 0
while pending start.

### Frontend Responsibilities (JavaScript)
- Visual layout and rendering
- Pixel positions and dimensions
- Drag & drop interactions
- User input handling
- Converting backend state to visual representation

---

## API Operations

### ✅ Correctly Placed

| Operation | Params | Notes |
|-----------|--------|-------|
| `togglePlayback` | none | Pure backend state |
| `seekTransport` | posSamples | Ruler scrub (2026-08-27): epoch re-base in the published-masterPos domain; refused mid-take; not undoable |
| `startRecordingInNode` | uuid | Pure audio action |
| `stopRecordingInNode` | uuid | Pure audio action |
| `getGraphState` | none | Backend → Frontend data |
| `getWaveform` | uuid, numPeaks | Audio data for visualization |
| `toggleStackExpand` | uuid | UI state but persists across sessions |
| `renameNode` | uuid, name | Pure data change |
| `getInputList` | none | Hardware info |
| `setNodeInput` | uuid, channelIndex | Audio config |
| `setLoopPoints` | uuid, startSamples, endSamples | Correctly uses samples |
| `toggleLoopWindow` | uuid | Window activation is data, not view state (time_maps.md) |
| `startLatencyCalibration` / `getLatencyCalibration` | — | Hardware measurement (performance.md §7) |
| `togglePlay` | uuid | Pure audio state |
| `toggleSolo` | uuid | Pure audio state |
| `toggleMute` | uuid | Pure audio state |

### ✅ Previously Abstraction Violations (Resolved)

| Operation | Status | Resolution |
|-----------|--------|------------|
| `createNode` | ✅ Fixed | Removed x,y params; child nodes append to parent. Top-level stacks use `setNodePosition` separately. |
| `moveNode` | ✅ Fixed | Replaced with `reorderNode(nodeId, parentId, newIndex)` — frontend calculates index from drop position. |
| `setNodePosition` | ✅ OK | Acceptable for top-level stacks (persistence-worthy visual state). |

---

## Detailed Fixes Required

### 1. `moveNode` → `reorderNode` (Critical for Drag & Drop)

**Current (BROKEN):**
```javascript
// Frontend calculates pixel Y, backend converts to index
await callNative('moveNode', id, parentId, index * 120);
```

**Proposed:**
```javascript
// Frontend calculates index directly from drop position
await callNative('reorderNode', id, parentId, dropIndex);
```

Backend receives the index directly and inserts at that position.

### 2. `createNode` Cleanup

For child nodes (clips in stacks), remove x/y:
```javascript
await callNative('createNode', 'clip', parentId);  // Appends to parent
```

For top-level stacks that need positioning:
```javascript
const id = await callNative('createNode', 'stack');
await callNative('setNodePosition', id, x, y);
```

---

## Notes on `setNodePosition`

This is acceptable for **top-level stacks only**:
- Stack position in the grid needs to persist across sessions
- This is "persistence-worthy" visual state
- Should NOT be used for clips within stacks (those are array-ordered)
