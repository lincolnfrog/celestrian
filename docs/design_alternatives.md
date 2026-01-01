# Design Alternatives: Considered but Rejected

This document captures design options that were considered but not implemented, for future reference.

---

## Phase-Aligned Recording (2024-12-31)

### Visual Representation of Anchor Phase
**Chosen**: X-offset positioning (clip starts at visual X position = anchor phase)

**Rejected Alternative B**: Keep clips at X=0 with only a visual marker
- Reason: Less intuitive; harder to see relative timing at a glance

### Wrap-Around for Long Clips
**Chosen**: Clips extend off-screen (scroll to see full length)

**Rejected Alternative A**: Automatic multi-row wrapping
- Reason: Complex to implement, potential for confusion about which "row" is which part of the clip

**Rejected Alternative C**: "Folded" visualization showing clip wraps
- Concept: Visual indicator (like a fold mark) at the point where the clip would wrap back to the quantum grid start
- Reason: Deferred as potentially confusing; may revisit if simpler approaches prove inadequate

### Auto-Wrap Special Case
**Considered but Rejected**: If a clip recorded at quantum 2 is exactly 4 quantums, auto-wrap it to align visually with quantum 0
- Reason: Too special-case, could be confusing for users to predict when this behavior kicks in
