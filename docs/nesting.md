# Stack Nesting and Drag-and-Drop

## Overview
Implementation of visual stacks for organizing clips, with drag-and-drop reordering and nesting capabilities.

## Current Status

### ✅ Completed
- **Backend Stack Architecture**
  - Renamed `BoxNode` → `StackNode` throughout codebase
  - Stack creation via `createNode(type='stack')`
  - `moveNode(nodeId, newParentId, newY)` - Move clips between stacks
  - `setNodePosition(nodeId, x, y)` - Freeform positioning for top-level stacks
  - JavaScript bindings for all new methods

- **Stack UI Components**
  - `.stack-wrapper` with border and padding
  - `.stack-children` flexbox container for vertical layout
  - Expand/collapse handle (top-right)
  - "+" add button with menu (New Clip, New Stack, Load Template)
  - Smart menu positioning (flips above/below based on screen space)
  - Grab handles on all nodes (stacks and clips)

- **Visual Refinements**
  - Stack borders correctly encompass children
  - Clips in stacks have proper spacing (16px gap + 40px top padding)
  - Grab handles positioned on left, don't overlap
  - Stack children use relative positioning within flex container
  - Top-level stacks use absolute positioning for freeform placement

### 🔧 In Progress - Drag-and-Drop

**Backend**: ✅ Complete
- `moveNode()` and `setNodePosition()` implemented
- JavaScript bindings working

**Frontend**: ⚠️ Partially Implemented, Not Working
- Drag handlers attached via `initDragDrop(div, nodeData)`
- Position update logic in `onDragMove()`
  - Top-level: Updates `left`/`top` for freeform dragging
  - Stack children: DOM reordering for live preview
- Drop logic in `handleDrop()` calls backend methods

**Current Bugs**:
1. **Drag doesn't work** - Elements don't move when grabbing handles
2. **Ghost repetitions missing** - Loop visualization bars not showing

**Debug Status**:
- Added extensive logging to track:
  - `initDragDrop` calls and isTopLevel status
  - Grab handle detection
  - Mouse events
  - Ghost rendering logic
- Logs use `log()` function for JUCE stdout redirect

## Architecture

### Data Flow
```
User grabs handle
  → initDragDrop() attaches mousedown listener
  → startDrag() stores initial position
  → onDragMove() updates element position
  → handleDrop() calls backend to persist change
```

### File Structure
- `/ui/js/drag_drop.js` - Drag-and-drop module
- `/ui/css/drag-drop.css` - Drag visual feedback styles
- `/ui/css/stack-styles.css` - Stack wrapper and layout styles
- `/ui/js/app.js` - Stack rendering in `syncUI()`, drag init calls

### Key Functions

**`initDragDrop(nodeElement, nodeData)`**
- Attaches mousedown listener to `.grab-handle`
- Stores `nodeData: { id, type, parent, isTopLevel }`
- Prevents re-initialization via `data-drag-initialized` flag

**`onDragMove(e)`**
- **Top-level stacks**: Updates `style.left/top` to follow cursor
- **Stack children**: DOM reordering via `insertBefore()` for live preview

**`handleDrop(dropTarget)`**
- Top-level: Calls `setNodePosition(id, x, y)`
- Stack children: Calls `moveNode(id, parentId, newY)`

## Ghost Repetitions Bug

**Issue**: Loop visualization bars (ghosts) not rendering

**Root Cause** (partially diagnosed):
- Original check used `stacks.some(...)` which excluded ALL clips with parent relationships
- Fixed to use `clips.includes(node)` to only render top-level clips
- Still not working after fix

**Ghost Rendering Logic** (`app.js` lines 563-640):
1. Clean up old `.ghost-clip` elements
2. Check `effectiveQ > 1` (quantum established)
3. For each top-level clip:
   - Skip if recording or no duration
   - Skip if one-shot (`duration < effectiveQ`)
   - Calculate ghost positions and render

**Debug Logging Added**:
- `[Ghost] effectiveQ=X, nodes.length=Y, clips.length=Z`
- `[Ghost] Skipping {id} - not top-level clip`
- `[Ghost] Skipping {id} - one-shot`
- `[Ghost] Rendering ghosts for {id}`

## Known Issues

### ✅ Resolved (Previously Critical)
1. **Drag-and-drop** - Fixed with slide animation and proper DOM reordering
2. **Ghost repetitions** - Fixed with per-stack LCM rendering and collapsed stack handling

### ✅ Resolved (Discovered During Testing)
1. **Collapsed stack ghost display** - Ghosts are now hidden when stack is collapsed
2. **Composite waveform in collapsed state** - Now displays correctly with `display: block`

### To Investigate
- Possible event listener not attaching (despite logs showing attachment)
- Grab handle CSS might be blocking pointer events
- Ghost rendering might be hitting early return before creating elements
- `effectiveQ` might not be > 1 when expected

## Next Steps

### Immediate (On Hold - Building Test Harness)
1. Get terminal log output from user to diagnose:
   - Are `[DragInit]` logs appearing?
   - Are grab handles being found?
   - What are `effectiveQ` and `clips.length` values?
2. Fix drag handler attachment based on log insights
3. Fix ghost rendering based on log insights

### Test Harness (Current Priority)
Build mock backend framework to enable independent UI testing without JUCE rebuild cycle.

### Future Features
- Collapsed stack waveform (aggregate visualization)
- Drag stacks into other stacks (or prevent/merge)
- Keyboard shortcuts for stack operations
- Undo/redo for drag operations
- Visual feedback improvements (smooth animations, better drop indicators)

## Code References

### Backend
- [`src/stack_node.h`](file:///Users/lincolnfrog/code/celestrian/src/stack_node.h) - Stack node class
- [`src/stack_node.cc`](file:///Users/lincolnfrog/code/celestrian/src/stack_node.cc) - Stack implementation
- [`src/audio_engine.h:69-80`](file:///Users/lincolnfrog/code/celestrian/src/audio_engine.h#L69-L80) - moveNode, setNodePosition
- [`src/main_component.cc:106-125`](file:///Users/lincolnfrog/code/celestrian/src/main_component.cc#L106-L125) - JS bindings

### Frontend
- [`ui/js/drag_drop.js`](file:///Users/lincolnfrog/code/celestrian/ui/js/drag_drop.js) - Drag module
- [`ui/js/app.js:519-527`](file:///Users/lincolnfrog/code/celestrian/ui/js/app.js#L519-L527) - initDragDrop calls
- [`ui/js/app.js:563-640`](file:///Users/lincolnfrog/code/celestrian/ui/js/app.js#L563-L640) - Ghost rendering
- [`ui/css/stack-styles.css`](file:///Users/lincolnfrog/code/celestrian/ui/css/stack-styles.css) - Stack layout
- [`ui/css/drag-drop.css`](file:///Users/lincolnfrog/code/celestrian/ui/css/drag-drop.css) - Drag feedback

## Design Decisions

### Stack Children Positioning
- Use `position: relative` with flexbox for natural vertical layout
- Skip absolute positioning logic that applies to top-level nodes
- Prevents clips from "breaking out" of stack wrapper

### Drag Behavior Split
- **Top-level stacks**: Freeform 2D positioning (absolute left/top)
- **Stack children**: Vertical reordering only (DOM insertBefore)
- No stack-into-stack nesting (would be merge operation instead)

### Ghost Coordinate Mismatch
- Stack children have relative Y coordinates
- Ghosts are appended to global `nodeLayer` with absolute positioning
- Temporarily disabled ghosts for stack children to avoid misalignment
- Future: Calculate absolute position from parent stack's position

---

## Per-Stack LCM and Timeline

### LCM Scope
The LCM (Least Common Multiple) that determines timeline width is calculated **per-stack**, not globally:

```javascript
function calculateStackLCM(stack, effectiveQ) {
    let stackLCM = effectiveQ;
    
    for (const child of stack.nodes) {
        if (child.type === 'clip' && child.duration > 0) {
            stackLCM = lcm(stackLCM, child.duration);
        } else if (child.type === 'stack') {
            // Nested stack contributes its composite duration
            const childLCM = calculateStackLCM(child, effectiveQ);
            stackLCM = lcm(stackLCM, childLCM);
        }
    }
    
    return stackLCM;
}
```

### Why Per-Stack?

1. **Independent Timelines**: Multiple top-level stacks can have different LCMs and timeline widths
2. **Nested Composites**: Inner stacks contribute their LCM as a single duration to the parent's LCM
3. **Isolation**: Adding a clip to Stack A doesn't affect Stack B's timeline

### Nested Stack Composite Duration

When a stack is collapsed, it appears as a single "block" with duration equal to its internal LCM:

```
┌─────────────────────────────────────────────────────────────┐
│ Outer Stack (LCM = 12Q)                                      │
│                                                              │
│   [Clip 1 (4Q)]━━━━━━━━━━━━━[ghost]━━━━━━━━━━━━━[ghost]      │
│                                                              │
│   [Inner Stack ═══ 6Q composite ═══]━━━━[ghost]━━━━━         │
│   (when expanded: shows 2Q + 3Q clips internally)            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Ghost Rendering Per-Stack

Each stack renders its own ghosts based on its own LCM:

1. Calculate `stackLCM` for the stack
2. Calculate `stackTimelineWidth = (stackLCM / effectiveQ) * baseWidth`
3. For each clip in the stack, render ghosts to fill `stackTimelineWidth`
4. Ghosts are positioned relative to the stack's coordinate system
