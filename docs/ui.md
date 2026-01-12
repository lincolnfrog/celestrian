# UI/Backend Separation of Concerns

This document defines the abstraction boundary between the Celestrian frontend (JavaScript) and backend (C++).

## Principles

### Backend Responsibilities (C++)
- Audio processing and playback
- Recording and buffer management  
- Transport state (samples, not pixels)
- Node graph structure (ordered lists, not positions)
- Loop points (in samples)
- Persistence-worthy state

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
| `startRecordingInNode` | uuid | Pure audio action |
| `stopRecordingInNode` | uuid | Pure audio action |
| `getGraphState` | none | Backend → Frontend data |
| `getWaveform` | uuid, numPeaks | Audio data for visualization |
| `toggleStackExpand` | uuid | UI state but persists across sessions |
| `renameNode` | uuid, name | Pure data change |
| `getInputList` | none | Hardware info |
| `setNodeInput` | uuid, channelIndex | Audio config |
| `setLoopPoints` | uuid, startSamples, endSamples | Correctly uses samples |
| `togglePlay` | uuid | Pure audio state |
| `toggleSolo` | uuid | Pure audio state |
| `toggleMute` | uuid | Pure audio state |

### ⚠️ TODO: Abstraction Violations

| Operation | Current Params | Problem | Fix |
|-----------|----------------|---------|-----|
| `createNode` | type, x, y, parentId | X/Y are pixel positions | Remove x,y; append to parent |
| `moveNode` | nodeId, parentId, newY | Y is a pixel position | Change to `reorderNode(nodeId, parentId, newIndex)` |
| `setNodePosition` | nodeId, x, y | X/Y for top-level stacks | **OK** - needed for persistence | NOTE: Stacks in particular should have {x, y} for their grid position.

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
