# Nested Stacks Design

## Overview

Stacks can contain other stacks to unlimited depth. A nested stack ("sub-stack") behaves identically to a top-level stack:
- Can contain clips and other stacks
- Shows composite waveform when collapsed  
- Supports recording, solo, mute
- Duration = LCM of its children

**Q Islands**: All stacks within the same hierarchy share Q from the first recorded clip.

---

## Hierarchical / Fractal Design (Core Principle)

**The key foundation of Celestrian**: Every level of the stack hierarchy behaves identically. A stack is not just a container - it's a **composite** that acts like a clip at its nesting level.

### What This Means

| Feature | Clip | Stack (Composite) |
|---------|------|-------------------|
| Waveform display | ✓ Own audio | ✓ Mixed child audio |
| Playhead | ✓ Shows position | ✓ Shows position |
| Loop region handles | ✓ Adjustable | ✓ Adjustable |
| Dim layers | ✓ Outside loop region | ✓ Outside loop region |
| Anchor / Launch marker | ✓ Recording start point | ✓ Composite anchor |
| Looping behavior | ✓ Loops at duration | ✓ Loops at LCM duration |

### User Control

Users can modify the **loop region** of a composite (stack) to control which portion is used during playback:
- Drag loop handles to set start/end points
- Dimmed regions show audio outside the active loop
- This works recursively at every nesting level

### Visual Example

```
┌─ Stack Composite ──────────────────────────────────────────────────────────┐
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │▒▒▒│░░░░░░░░░░░░░░░░░░░░|░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│▒▒▒▒▒▒▒▒▒│ │
│ │   ↑ loopStart          ↑ playhead                loopEnd ↑           │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
│  ▒▒▒ = dimmed (outside loop)   ░░░ = active loop region                   │
└────────────────────────────────────────────────────────────────────────────┘
```

### Implementation Notes

**C++ Architecture**: All loop/anchor logic is in the base `AudioNode` class:
- `loop_start_samples`, `loop_end_samples` - shared by ClipNode and StackNode
- `anchor_phase_samples`, `launch_point_samples` - shared inheritance
- `setLoopPoints()`, `getLoopStart()`, `getLoopEnd()` - shared API

**Frontend (JS)**:
1. Stack header waveform includes: loop handles, dim layers, playhead, launch marker
2. Loop handles are draggable (same interaction as clip loop handles)
3. Default loop region = full duration (loopStart=0, loopEnd=LCM)


---

## Visual Design: Always-Visible Stack Waveform


Every stack displays a composite waveform header that shows the combined audio of all its children. This waveform is **always visible** - both when collapsed and expanded - providing a canonical playhead reference at that nesting level.

### Key Insight

The stack's composite waveform acts as a "sync reference" for the entire group. Even though child clips have shifted X positions due to nesting borders, users can:
1. **Glance at the stack header** to see overall progress
2. **Ignore individual playheads** within expanded children
3. **Collapse the stack** when they want the clean single-waveform view

---

### Collapsed Child Stack (Perfect Alignment)

When a child stack is collapsed, it appears as a single waveform - perfectly aligned with sibling clips:

```
┌─ Parent Stack ─────────────────────────────────────────────────────────┐
│ ┌───────────────────────────────────────────────────────────────────┐  │
│ │ ░░░░░░░░░░░░░░░░░░░░░░|░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (composite)  │  │
│ └───────────────────────|───────────────────────────────────────────┘  │
│                         ↑ Parent stack playhead at 50%                 │
│                                                                        │
│ ┌─ Clip 1 ──────────────────────────────────────────────────────────┐  │
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   │  │
│ └───────────────────────────────────────────────────────────────────┘  │
│                         ↑ 50% - ALIGNED                                │
│                                                                        │
│ ┌─ Child Stack [─] ─────────────────────────────────────────────────┐  │
│ │ ░░░░░░░░░░░░░░░░░░░░░░|░░░░░░░░░░░░░░░░░░░░░░░  (collapsed view)  │  │
│ └───────────────────────────────────────────────────────────────────┘  │
│                         ↑ 50% - ALIGNED                                │
└────────────────────────────────────────────────────────────────────────┘
                          │
                  All playheads perfectly aligned!
```

---

### Expanded Child Stack (Header Waveform Aligned)

When the child stack is expanded, its **header waveform** stays aligned with sibling clips (same left edge) for vertical playhead alignment. The child clips are indented below, creating a "flag" shape:

```
┌─ Parent Stack ─────────────────────────────────────────────────────────┐
│ ┌───────────────────────────────────────────────────────────────────┐  │
│ │ ░░░░░░░░░░░░░░░░░░░░░░|░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (composite)  │  │
│ └───────────────────────|───────────────────────────────────────────┘  │
│                         ↑ Parent playhead at 50%                       │
│                                                                        │
│ ┌─ Clip 1 ──────────────────────────────────────────────────────────┐  │
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   │  │
│ └───────────────────────────────────────────────────────────────────┘  │
│                         ↑ 50% - ALIGNED                                │
│                                                                        │
│ ┌─ Child Stack [+] ─────────────────────────────────────────────────┐  │
│ │ ░░░░░░░░░░░░░░░░░░░░░░|░░░░░░░░░░░░░░░░░░░░░░░░░  (composite)     │  │
│ ├────────────────────────────────────────────────────────────────── │  │
│ │                       ↑ Child stack header - ALIGNED              │  │
│ │                                                                   │  │
│ │     ┌─ Child A ───────────────────────────────────────────────┐   │  │
│ │     │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │   │  │
│ │     └─────────────────────────────────────────────────────────┘   │  │
│ │                             ↑ NOT aligned (shifted right)         │  │
│ │                                                                   │  │
│ │     ┌─ Child B ───────────────────────────────────────────────┐   │  │
│ │     │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │   │  │
│ │     └─────────────────────────────────────────────────────────┘   │  │
│ │                             ↑ NOT aligned (shifted right)         │  │
│ └───────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
```

**Key insight**: The child stack's composite waveform shares the same left edge as `Clip 1`, keeping playheads vertically aligned. Below the waveform, child clips are indented - like a flag hanging from a pole.

**What this achieves:**
- Stack header waveforms are always aligned with their parent context
- No complex margin calculations needed
- Composite waveform reused from collapsed view
- Natural visual hierarchy: header shows "the whole", children show "the parts"

**Future Enhancement**: Make stack waveform height configurable or collapsible to "thin" mode for power users who want minimal chrome.


---

## Visual Distinction

| State | Appearance |
|-------|-----------|
| Collapsed sub-stack | Clip-like with **colored border** (e.g., purple) |
| Expanded sub-stack | Container with indent + expand toggle |

---

## Key CUJs

### CUJ 1: Create Empty Sub-Stack
1. User clicks "+" in parent stack
2. Menu shows: "New Clip" / "New Stack"
3. User picks "New Stack"
4. Empty sub-stack appears, user can drag clips into it

### CUJ 2: Combine Clips into Stack
1. User multi-selects clips (Shift+click or Cmd+click)
2. Right-click → "Combine into Stack"
3. Selected clips move into new sub-stack

### CUJ 3: Drag Clip into Sub-Stack

**Zone-Based Drop Targeting** (avoids hidden hotkeys):
```
┌──────────────────┐
│   TOP THIRD      │ → Drop ABOVE this node
├──────────────────┤
│  CENTER THIRD    │ → COMBINE into stack (if target is clip/stack)
├──────────────────┤
│  BOTTOM THIRD    │ → Drop BELOW this node
└──────────────────┘
```

**Implementation Notes**:
1. Switch from "live reorder during drag" to "drop indicator line" UX
2. Show horizontal line for above/below zones
3. Show glow/highlight for center zone (combine)
4. If target is already a stack, center zone = "drop INTO stack"
5. If target is a clip, center zone = "create new stack containing both"

### CUJ 4: Drag Clip Out of Sub-Stack
1. User expands sub-stack inline
2. Drags clip from sub-stack to parent
3. Clip moves to parent level

### CUJ 5: Promote Sub-Stack to Top Level
1. User drags sub-stack out of parent
2. Stack becomes top-level stack

### CUJ 6: Record into Sub-Stack
1. User clicks record on clip inside sub-stack
2. Recording respects Q from root stack (Q island)
3. Commit works normally

---

## Multi-Select Behavior

**Level-Scoped Selection**: Multi-select only works within one nesting level.
- Shift/Cmd+click selects siblings only
- Selecting an expanded stack selects the whole stack (not its contents)
- Cannot select items across different nesting depths simultaneously

---

## Empty Stacks

**Empty stacks are allowed**. Users can create an empty stack via the "+" menu and later drag clips into it. Empty stacks display with placeholder visual (dashed outline, "Empty" label).

---

## Audio Behavior

### Solo/Mute Cascade
```
if (stack.isMuted) → all children muted
if (stack.isSoloed) → all children play (unless individually muted)
if (child.isMuted) → that child muted regardless of parent
if (child.isSoloed) → only that child plays (within its context)
```

### Composite Waveform
When collapsed, sub-stack shows summed waveform of all children:
- Mix all child waveforms at their relative positions
- Respect loop regions
- Cache and invalidate on child change

---

## Technical Architecture

### Data Model Changes

```cpp
// stack_node.h
class StackNode : public AudioNode {
    std::vector<std::unique_ptr<AudioNode>> children;  // Can be Clip or Stack
    bool isExpanded = false;
    
    // Composite waveform cache
    juce::AudioBuffer<float> compositeWaveform;
    bool compositeInvalid = true;
    
    int64_t getIntrinsicDuration() override {
        return calculateLCM(children);  // Recursive for nested stacks
    }
};
```

### UI Changes

```javascript
// app.js
function renderNode(node, parentStack) {
    if (node.type === 'stack') {
        if (node.isExpanded) {
            renderExpandedStack(node, parentStack);
        } else {
            renderCollapsedStack(node);  // Shows composite waveform
        }
    } else {
        renderClip(node);
    }
}
```

---

## Open Questions

1. **Depth indicator**: Show nesting level visually (e.g., progressively darker borders)?
2. **Performance**: Max practical depth before UI gets unwieldy?
3. **Keyboard nav**: How to navigate into/out of stacks with keyboard?
4. **Copy/paste**: Copy stack = deep copy of all contents?

---

## Implementation Phases

### Phase 1: Core Data Model
- [ ] Update `StackNode` to accept child stacks
- [ ] Recursive LCM calculation
- [ ] Recursive solo/mute logic

### Phase 2: UI Rendering
- [ ] Collapsed sub-stack appearance (colored border)
- [ ] Inline expansion with indent
- [ ] Drill-in mode (double-click)

### Phase 3: Drag-Drop Refactor
- [ ] Switch to "drop indicator line" UX (no live reorder)
- [ ] Implement zone-based targeting (top/center/bottom thirds)
- [ ] Center zone on stack = drop INTO stack
- [ ] Center zone on clip = create stack containing both
- [ ] Drag clip out of sub-stack to parent
- [ ] Drag sub-stack to promote to top-level

### Phase 4: Composite Waveform
- [ ] Generate mixed waveform from children
- [ ] Cache invalidation
- [ ] Render in collapsed view

### Phase 5: Creation Flows
- [ ] "+button → New Stack" in parent
- [ ] Multi-select → "Combine into Stack"
