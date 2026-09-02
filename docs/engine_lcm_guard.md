# Map coherence is categorical (owner ruling 2026-08-09)

**Status: RULED AND IMPLEMENTED, both sides.**

## The ruling

> "Edits can only snap to Q unless I am modifying the original
> Q-defining clip. If there is some case where it is possible to make
> an edit that is non-Q aligning, that shouldn't exist. We should
> prevent this on both sides of the engine categorically."

This supersedes the earlier "deliberately freed (⚠, never silent)"
carve-out in the seam-theorem language of time_maps.md §4: there is no
free mode. The ⚠ badge machinery remains as defensive display only.

## The incident that forced the ruling (field video 2026-08-08)

3Q take → 1Q cut, slid freely (position is free by design; length is
not) → loop end trimmed. The trim snapped the **bound** to a whole Q,
but over a fractional seam a whole-Q bound is not a whole-Q **period**:
a 0.6546…Q period committed, `lcm(quantum, period)` exploded the
effective cycle to **66187Q**, and the timeline blanked. The same class
previously hit the display path ("142336Q", field 2026-07-19b) and was
guarded only there (`commensuratePeriod`, timeline_model.js).

## What enforces it now

Editor (the UI snaps — every gesture lands on a whole-Q period):

- **Trims** snap the PERIOD, not the bound: `trimBoundForPeriod`
  (map_edit.js) walks the covered set to the raw bound where the kept
  total is exactly the rounded target. Regression-pinned in
  map_edit.test.mjs against the video's exact scenario.
- **Cut resizes** have no free mode (the ⌥ escape hatch is removed)
  and are capped by the room to the neighbouring gap.
- **Slides** stay position-free but are clamped to the cut's kept
  neighbourhood (`cutBounds`): a cut meets a neighbouring gap only at
  exact adjacency — whole ∪ whole stays whole — never by fractional
  overlap (which silently removed fractional kept material).
- **Commit guard**: `commitBandSegs` refuses any fractional-period
  map outright (console warning), so a future gesture bug degrades to
  "the edit didn't take", never a cycle explosion.

Engine (refusal, mirrored in the mock for parity):

- `AudioEngine::setSegments` refuses a map whose period is neither a
  whole multiple nor an exact divisor of Q. (Divisors are first-class:
  short takes commit at Q/2 · Q/4 · Q/8 via SUBDIVISIONS, and
  lcm(Q, Q/k) = Q, so they can never explode the cycle.)
- `AudioEngine::setLoopPoints` refuses a window (post-clamp) whose
  length is neither a whole multiple nor an exact divisor of Q.
- Sole exception, per the ruling's own carve-out: the Q13
  sole-definer re-trim — the definer CLIP (one committed clip on the
  island, no take in flight) or, since Q13-for-groups (design_language
  Q13, 2026-08-21), the definer STACK (its direct clip children are the
  island's only committed content, recorded as one take) — where the
  edit *re-establishes* Q rather than fighting it. One-shots (`periodSource: context`) never contribute a
  period to the LCM in the first place (Q5) and need no exception.
- Mock parity: `mock_backend.js setSegments` / `setLoopPoints` refuse
  identically, so the harness cannot drift from the engine on this.

## Note for a future golden vector

The refusal rule (period % Q ≠ 0 ⇒ refuse, except Q13 re-trim) is
behavioral, not numeric, so it isn't pinned in
`shared/timing_golden.json` yet. If either side grows a new map-edit
entry point, consider adding refusal cases to the shared vectors so
the two implementations cannot diverge silently.
