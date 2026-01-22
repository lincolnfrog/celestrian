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

When a stack is collapsed, it displays a **composite waveform** showing the summed audio of all children. This waveform is the primary visual representation of the stack's content.

**Implementation Details:**

1. **Waveform Generation**: Mix all child waveforms at their relative positions
2. **Cache Key**: `${targetPeaks}:${loopStart}:${loopEnd}:${childDurations.join(',')}`
3. **Invalidation**: Cache is invalidated when children change (add, remove, duration change)
4. **Visual Presentation**:
   - **Collapsed state**: Composite waveform at full opacity
   - **Expanded state**: Composite waveform at ~50% opacity (faded, ghost-like)

**CSS Implementation** (stack-styles.css):
```css
/* When collapsed, waveform is fully visible */
.stack-collapsed .stack-header-waveform {
    display: block;
    opacity: 1;
}

/* When expanded, waveform is faded to indicate loop is bypassed */
.stack-wrapper:not(.stack-collapsed) .stack-header-waveform {
    opacity: 0.5;
}
```

---

### Ghost Clips and Collapsed Stacks

**Ghost clips are NOT rendered when a stack is collapsed.** Since the collapsed view shows the stack as a single composite unit (like a clip), ghost repetitions are irrelevant.

**Implementation** (app.js ghost rendering):
```javascript
// Skip ghost rendering if stack is collapsed
if (!stack.isExpanded) {
    return; // No ghosts for collapsed stacks
}
```

**Rationale:**
- Collapsed stacks act like single clips
- Ghost repetitions apply to individual clips, not composites
- Reduces visual clutter and rendering overhead

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

### Phase 1: Core Data Model ✓
- [x] Update `StackNode` to accept child stacks
- [x] Recursive LCM calculation
- [x] Recursive solo/mute logic
- [x] Loop logic shared via `AudioNode` base class (loopStart, loopEnd, anchorPhase, launchPoint)

### Phase 2: UI Rendering (Partial ✓)
- [x] Collapsed sub-stack appearance (colored border)
- [x] Inline expansion with indent
- [x] Composite waveform header (always visible when expanded)
- [x] Hierarchical loop UI (loop handles, dim layers, launch marker)
- [x] Playhead synchronized with child clips
- [ ] Drill-in mode (double-click) - *Future*

### Phase 3: Drag-Drop Refactor ✓
- [x] Switch to "drop indicator line" UX (no live reorder)
- [x] Implement zone-based targeting (top/center/bottom thirds)
- [x] Center zone on stack = drop INTO stack
- [x] Center zone on clip = create stack containing both
- [x] Drag clip out of sub-stack to parent
- [x] Drag sub-stack to promote to top-level

### Phase 4: Composite Waveform ✓
- [x] Generate mixed waveform from children (with position alignment)
- [x] Waveform accounts for clip anchor offsets
- [x] Looping clips repeat waveform at correct positions
- [x] Canvas width matches LCM timeline
- [ ] Cache invalidation - *Pending: optimize performance*
- [ ] Render in collapsed view - *Future*

### Phase 5: Creation Flows ✓
- [x] "+button → New Stack" in parent
- [x] "+button → New Clip" in parent
- [ ] Multi-select → "Combine into Stack" - *Future*

---

## Recommended Next Steps

1. ~~**Loop Handle Dragging**: Wire up `mousedown` events on stack loop handles to allow users to adjust the loop region (calls `setLoopPoints`)~~ ✓ Implemented

2. **Collapsed Composite Waveform**: Show the composite waveform when a stack is collapsed (currently only shows when expanded)

3. ~~**Waveform Cache Invalidation**: Optimize by caching the composite waveform and only regenerating when children change~~ ✓ Implemented

4. **Keyboard Navigation**: Implement arrow keys to navigate into/out of stacks

5. **Multi-select Combine**: Allow selecting multiple clips and combining into a stack via right-click menu

---

## Stack Loop Processing (Implementation Details)

> [!IMPORTANT]
> This section documents the **Loop-on-Collapse** model for stack-level loop regions.

### Design Goals

1. **Non-destructive**: Child clips retain their own loop selections unchanged
2. **Hierarchical**: Each stack level applies its own loop independently
3. **Recording-friendly**: Recording works normally inside expanded stacks
4. **Intuitive**: Expand to work inside, collapse to hear the loop

---

### The "Loop-on-Collapse" Model

**Core Rule: Stack loop region is only active when the stack is COLLAPSED**

| Stack State | Loop Behavior | Recording |
|-------------|---------------|-----------|
| **Collapsed** | Loop region **ACTIVE** - constrains playback | N/A (can't record inside collapsed stack) |
| **Expanded** | Loop region **BYPASSED** - shown but not applied | Recording works normally |

**Mental model:** "Opening a container" disables its outer constraint. Expand to work inside, collapse to hear the looped output.

```
┌─ Stack (COLLAPSED) ─────────────────────────────────────────────────┐
│ ████▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓████████████████████████  ← Loop region ACTIVE │
│     [loopStart]     [loopEnd]                                       │
│     Playhead constrained to looped region                           │
│     Composite waveform: OPAQUE (normal)                             │
└─────────────────────────────────────────────────────────────────────┘

┌─ Stack (EXPANDED) ──────────────────────────────────────────────────┐
│ ▒▒▒▒░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  ← Loop region BYPASSED │
│     (handles visible but faded like a ghost)                        │
│     Composite waveform: FADED (ghost-like, ~50% opacity)            │
│                                                                     │
│ ┌─ Clip 1 ────────────────────────────────────────────────────────┐ │
│ │  Full playback, normal recording - no loop constraint          │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│ ┌─ Clip 2 ────────────────────────────────────────────────────────┐ │
│ │  Can record freely inside expanded stack                       │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

### Nested Stack Behavior

Each stack level applies its loop independently based on its own collapse state:

```
┌─ Outer Stack (COLLAPSED) ────────────────────────────────────────────┐
│ ████▓▓▓▓▓▓▓▓████████████  ← Outer loop ACTIVE (constrained 2Q-4Q)   │
│     [2Q]    [4Q]                                                     │
│     Global playhead loops within bars 2-4 of LCM                     │
└──────────────────────────────────────────────────────────────────────┘

┌─ Outer Stack (EXPANDED) ─────────────────────────────────────────────┐
│ ▒▒▒▒░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒  ← Outer loop BYPASSED (faded)             │
│                                                                      │
│   ┌─ Inner Stack (COLLAPSED) ──────────────────────────────────┐    │
│   │ ██▓▓▓▓██████████████  ← Inner loop ACTIVE (constrained)    │    │
│   │   [1Q][2Q]             Applies to THIS stack's children     │    │
│   └────────────────────────────────────────────────────────────┘    │
│                                                                      │
│   ┌─ Inner Stack (EXPANDED) ───────────────────────────────────┐    │
│   │ ▒▒░░░░▒▒▒▒▒▒▒▒▒▒▒▒▒▒  ← Inner loop BYPASSED (faded)        │    │
│   │                                                             │    │
│   │   ┌─ Clip A ─────────────────────────────────────────────┐ │    │
│   │   │  Plays full duration - both outer AND inner bypassed │ │    │
│   │   └──────────────────────────────────────────────────────┘ │    │
│   └─────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

**Key insight:** Expanding ANY level disables that level's loop. Nested loop behavior is hierarchical and independent.

---

### Visual Feedback

| State | Composite Waveform | Loop Handles | Dim Regions |
|-------|-------------------|--------------|-------------|
| Collapsed | **Opaque** (normal) | Solid, draggable | Visible |
| Expanded | **Faded** (~50% opacity, ghost-like) | Visible but faded | Faded |

The ghost-like fade when expanded signals "this loop is not currently active."

---

### C++ Implementation

```cpp
void StackNode::process(/* ... */, const ProcessContext &context) {
    int64_t effective_master_pos = context.master_pos;
    
    // === LOOP-ON-COLLAPSE MODEL ===
    // Only apply loop windowing when COLLAPSED
    if (!is_expanded.load()) {
        int64_t stack_loop_start = loop_start_samples.load();
        int64_t stack_loop_end = loop_end_samples.load();
        
        // Only apply if valid loop region is set
        if (stack_loop_end > stack_loop_start) {
            int64_t loop_duration = stack_loop_end - stack_loop_start;
            effective_master_pos = stack_loop_start + 
                                   (context.master_pos % loop_duration);
        }
    }
    // When expanded: pass through master_pos unchanged
    
    ProcessContext child_context = context;
    child_context.master_pos = effective_master_pos;
    
    for (const auto &child : children) {
        child->process(/* ... */, child_context);
        // Sum into output...
    }
}
```

---

### Anchor Phase Handling

Child anchor phases are **independent** of stack loop processing:

| Property | Behavior |
|----------|----------|
| `child.anchor_phase_samples` | Preserved unchanged |
| `child.loop_start/end` | Child's own loop - applied after receiving position |
| `child.x` position | Visual offset in UI - not affected by stack loop |

---

### Keyboard Shortcut

> [!TIP]
> **TODO**: Implement quick-toggle keyboard shortcut (e.g., `Space+Click` or `E`) to collapse/expand stack for rapid loop preview.

This allows quickly hearing the looped output without losing context of where you are in the expanded view.

---

### Non-Contiguous Loop Selection (Future)

> [!WARNING]
> Non-contiguous loop selection (e.g., bars 1-2 AND 5-6) introduces playhead "jumps."

**Proposed approach:** Since Loop-on-Collapse model means recording only happens when expanded (loop bypassed), non-contiguous selection is only relevant for collapsed playback:
- Collapsed: Playhead jumps between non-contiguous regions (no recording possible)
- Expanded: Full timeline, normal recording

---

### Testing Requirements

1. **C++ unit tests:**
   - Collapsed stack with loop region constrains children's master_pos
   - Expanded stack passes master_pos unchanged
   - Nested stacks: each level's collapse state independent
   - Default behavior (no loop set) = full LCM duration

2. **E2E tests:**
   - Composite waveform opacity changes on expand/collapse
   - Loop handles fade when expanded
   - Recording inside expanded stack works normally
   - Collapse stack → playhead constrained to loop region

