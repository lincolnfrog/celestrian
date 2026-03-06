# Celestrian: Implementation Roadmap & Task List

> **Generated**: 2026-03-05 — Comprehensive audit of all design docs (`docs/*.md`) and codebase (`src/`, `ui/`, `tests/`).

Tasks are ordered by priority: **foundation stability first**, then expanding outward. Each section groups related work.

---

## Tier 0: Tech Debt & Cleanup (Stabilize Foundation)

These items address dead code, abstraction violations, and debug artifacts that should be resolved before building new features.

### Dead Code Removal
- [x] **Remove `BoxNode` class** — `box_node.h` / `box_node.cc` are a vestigial duplicate of `StackNode`. The rename from `BoxNode` → `StackNode` was done but the old files were never deleted. `NodeType::Unknown` enum value also refers to a removed `Box` type in `audio_node.h`.
- [x] **Remove `NodeType::Box` reference** — `box_node.h` still uses `NodeType::Box` but `audio_node.h` enum doesn't have it (it has `Clip, Stack, Unknown`). Dead code should be deleted and CMakeLists updated.
- [x] **Clean up debug logging** — Multiple `DEBUG` markers in production code:
- [x] `clip_node.cc`: Multiple DEBUG/verbose logs (7 calls removed, `debug_playback_logged_` member removed from header)
- [x] `stack_node.cc`: Throttled collapsed-transport debug log (audio thread noise)
- [x] `audio_engine.cc`: Throttled "Processing N samples" log every 100 blocks
- [x] `app.js`: Throttled `[SyncUI]` playhead debug log + per-frame ghost debug logs

### API Abstraction Violations (from `docs/ui.md`)
- [x] **Refactor `moveNode` → `reorderNode`** — Already done in prior work. `reorderNode(nodeId, parentId, index)` is the active API.
- [x] **Clean up `createNode` params** — Removed x/y parameters. Child nodes just append to parent; top-level stacks use `setNodePosition`.

### Code Quality
- [ ] **`app.js` is 1666 lines** — Consider splitting into modules: `syncUI` rendering, clip state management, stack rendering, waveform caching, ghost rendering. Currently a monolith that's hard to navigate and test.
- [ ] **Duplicate LCM/GCD logic** — `gcd`/`lcm` are defined inline in `app.js` `syncUI()` and also exist in `math_utils.js` and `stack_logic.js`. Consolidate to a single import.

---

## Tier 1: Missing Tests (Solidify What Exists)

### C++ Unit Tests
- [ ] **Stack loop-on-collapse tests** — `docs/stacks.md` L544-548 specifies 4 required C++ unit tests that should exist in `stack_loop_tests.cc`:
  - Collapsed stack with loop region constrains children's `master_pos`
  - Expanded stack passes `master_pos` unchanged
  - Nested stacks: each level's collapse state independent
  - Default behavior (no loop set) = full LCM duration
- [ ] **Verify existing test coverage** — Run `tests/` suite and catalog pass/fail. Some test files look ad-hoc (e.g., `repro_first_clip_bug.cc`) and may be outdated.

### E2E Tests (from `docs/stacks.md` L550-554)
- [ ] **Composite waveform opacity changes on expand/collapse**
- [ ] **Loop handles fade when expanded**
- [ ] **Recording inside expanded stack works normally**
- [ ] **Collapse stack → playhead constrained to loop region**

### JS Unit Tests
- [ ] **Audit test health** — Recent conversation history mentions `ghost_lcm_boundary.test.mjs` and `ghost_rendering.test.js` failures. Ensure all 12 unit tests and 11 E2E tests pass clean.
- [ ] **Add composite waveform cache invalidation tests** — Cache key logic in `app.js` is complex; no dedicated test coverage exists.

---

## Tier 2: Known Bugs & Partially-Working Features

### Recording Ghost Bugs (from `docs/recording.md` L666-679)
- [ ] **Ghost Extension Lag** — Ghosts are created based on `timelineWidth` but cursor position can exceed this during recording.
- [ ] **Cursor Jump at Commit** — When clip 3 (3Q) commits, cursor may jump unexpectedly (e.g., 3Q → 6Q).
- [ ] **Ghost/Cursor Abstraction Mismatch** — UI calculates cursor position and ghost extents separately, leading to race conditions. Need single source of truth for timeline extent.

### Drag-and-Drop (from `docs/nesting.md`)
- [ ] **Ghost coordinate mismatch for stack children** — Ghosts are appended to global `nodeLayer` with absolute positioning, but stack children have relative Y coordinates. Ghosts for stack children are currently disabled.
- [ ] **Verify drag-drop end-to-end** — `nesting.md` marks frontend as "⚠️ Partially Implemented, Not Working" with bugs around elements not moving when grabbing handles.

---

## Tier 3: Pending Feature Work (Implementation Roadmap)

### Segment 4: Focused Interaction (IN PROGRESS — `docs/implementation.md` L54)
- [ ] **Track Controls** — Play/Solo/Record buttons; partially done.
- [ ] **Creation Menu** — Contextual node creation; partially done.
- [ ] **Selective Recording** — Record into specific nodes.

### Stacks: Remaining Phase Work
- [ ] **Cache invalidation optimization** — `stacks.md` Phase 4: composite waveform cache currently regenerates too often.
- [ ] **Collapsed composite waveform rendering** — `stacks.md` Phase 4: "Render in collapsed view — *Future*". Currently only shows when expanded.
- [ ] **Multi-select → "Combine into Stack"** — `stacks.md` Phase 5: select multiple clips and combine via right-click menu.
- [ ] **Drill-in mode (double-click)** — `stacks.md` Phase 2: navigate into stack as full-screen view. Currently only expand/collapse inline.
- [ ] **Keyboard navigation for stacks** — Arrow keys to navigate into/out of stacks.
- [ ] **Quick-toggle keyboard shortcut** — `stacks.md` L525: e.g., `Space+Click` or `E` to collapse/expand for rapid loop preview.

### Segment 5: Clip Manipulation (`docs/implementation.md` L55)
- [ ] **Move clips in 2D space** — Freeform clip repositioning.
- [ ] **Resize durations** — UI handles for clip duration editing.

### Segment 6: Save/Load (`docs/implementation.md` L56)
- [ ] **Project persistence** — Save the project to disk and load it back up.
- [ ] **State serialization** — Define JSON or binary format for the complete audio graph.

---

## Tier 4: Advanced Audio Engine

### Multi-threading (`docs/implementation.md` L7-8)
- [ ] **Multi-threaded root mixer** — Separate threads for playback, recording, and processing.
- [ ] **Latency compensation logic** — User-calibrated latency baseline. `ProcessContext` has `input_latency` / `output_latency` fields but they're unused.

### Segment 7: Multi-Range Implementation (`docs/implementation.md` L57)
- [ ] **Multi-slice selection** — Define multiple `loopStart/End` pairs per clip.
- [ ] **Conserved loop length math** — Shifting Range A end auto-shifts Range B start.
- [ ] **Non-contiguous loop selection for stacks** — `stacks.md` L531-539: playhead jumps between non-contiguous regions when collapsed.

### Segment 8: Warp Manager (`docs/implementation.md` L58)
- [ ] **WSOLA time-stretching** — `WarpManager` class (`src/dsp/`) — Not Started.
- [ ] **BPM discovery** — Auto-detect tempo from recorded clips.
- [ ] **Primary-Relative Warping** — `Target BPM / Seed BPM` ratio for nested boxes with different tempos.

### DSP & Timing (`docs/implementation.md` L42-45)
- [ ] **`PhaseAligner`** — Smooths splices between non-contiguous loop ranges. Crossfade synthesis, zero-crossing snapping — Not Started.
- [ ] **Intelligent Edge Analysis** — Automatic waveform analysis for optimal loop boundary points (`design.md` L162).

---

## Tier 5: Future Vision Features

### Segment 9: Connections Between Boxes (`docs/implementation.md` L59)
- [ ] **Multi-box transitions and logic** — Graph-based connections between boxes.
- [ ] **Branch-with-Chance** — Non-deterministic flow for procedural music.
- [ ] **Smoothing Transitions** — Automated crossfades between boxes/ranges.

### Navigation & Viewport (ZUI) (`docs/design.md` L106-114)
- [ ] **Dive/Exit Mechanics** — Double-click zooms inside a child box.
- [ ] **Escape/Exit Button** — Zooms out to parent container.
- [ ] **Slick Transitions** — CSS/JS animations for spatial orientation during zoom.

### Islands & Multi-Stack (`docs/implementation.md` L153-198, `docs/design.md` L193-198)
- [ ] **Island Q derivation** — Derive Q from parent BoxNode's first completed clip (`implementation.md` L254).
- [ ] **Stack Independence** — Multiple stacks with independent quantum/time origins.
- [ ] **Quantum Inheritance model** — Inherit vs. "New Song" for new stacks.
- [ ] **Transport Reset** — First clip in a "New Song" stack resets transport to 0.
- [ ] **Island transitions** — Quantum mismatch handling between connected islands.

### Corpus & Automation (`docs/design.md` L165-170)
- [ ] **Loop/Box Library** — Metadata-rich catalog (BPM, length, music key).
- [ ] **Stack Templates** — Save/load reusable stack configurations (e.g., drum kit templates).
- [ ] **Procedural Automation** — Auto-combine library elements into new structures.
- [ ] **Infinite Radio Mode** — Offline generation of infinite music stream from catalog.

### UI Polish (`docs/design.md`)
- [ ] **Prettier Waveforms** — Discrete vertical bars at appropriate zoom granularity (`design.md` L51).
- [ ] **Zoom-dependent peak resolution** — Store peaks at high resolution, downsample for display (`implementation.md` L262-264).
- [ ] **Visual Growth during recording** — Clip grows proportionally when exceeding quantum length (`design.md` L102-104).
- [ ] **Stepped Zoom** — Auto-zoom in discrete steps to keep active recording visible (`design.md` L104).
- [ ] **Depth indicator for nested stacks** — Progressively darker borders (`stacks.md` L324).
- [ ] **Copy/paste for stacks** — Deep copy of all contents (`stacks.md` L327).
- [ ] **Undo/redo for drag operations** — (`nesting.md` L144).

### Recording Features (`docs/recording.md`)
- [ ] **Disable Auto-Quantize toggle** — Per-clip or global setting for fiddly overdubs (`recording.md` L685-688).
- [ ] **Mono → Stereo** — Current recording is mono only (`audio_engine.h`); stereo support needed.

---

## Open Design Questions (Unresolved)

These are documented questions without answers yet. Resolving them may spawn new tasks.

| # | Question | Source |
|---|----------|--------|
| 1 | Max practical nesting depth before UI gets unwieldy? | `stacks.md` L325 |
| 2 | How to handle quantum mismatches between connected islands? | `implementation.md` L267-268 |
| 3 | "Breaking out" a stack from an island — UX and implementation? | `implementation.md` L270-272 |
| 4 | Connecting stacks after Q is established — polyrhythmic interaction? | `recording.md` L69 |
| 5 | Warning UX for very large LCMs (coprime durations)? | `recording.md` L549 |
