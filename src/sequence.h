#pragma once

#include <juce_core/juce_core.h>

#include <cstdint>
#include <vector>

namespace celestrian {

/**
 * The SEQUENCER's core type (docs/sequencer.md — the fractal per-stack
 * Sequence): an ordered list of STEPS, each a whole span of the stack's
 * timeline, plus per-child GATE rows saying which children sound during
 * which steps.
 *
 * Semantics (all owner-ruled, sequencer.md §0/§9):
 *  - Gates are MUTE-SHAPED (S1): a gated-off child keeps its clock; an
 *    entrance lands exactly in phase. Nothing here transforms time.
 *  - An ACTIVE sequence sets the stack's effective period to `total`
 *    (the period law, §2) — steps CONCATENATE, they never LCM.
 *  - Absent uuid in `gates` = inherit ON everywhere (a track added
 *    after the sequence was written sounds until told otherwise).
 *  - The gate is applied PRE-FX with a fade (S7 smoothness law) — the
 *    envelope below is a PURE function of position, so render output
 *    never depends on block boundaries (render purity).
 *
 * Threading (the map_override_ / FxChain discipline): an immutable
 * heap object behind ONE atomic pointer on StackNode. The MESSAGE
 * thread builds a fresh Sequence (finalize() before publishing) and
 * retires the predecessor through the engine reclaimer; the audio
 * thread only loads the pointer and reads.
 */
struct Sequence {
  static constexpr int kMaxSteps = 64;  // gate rows are uint64 bitmasks

  struct Step {
    int64_t len = 0;  // samples (whole-Q by UI construction; engine
                      // accepts free lengths — S10: permitted, badged)
    juce::String name;
  };
  struct GateRow {
    juce::String uuid;      // a DIRECT child of the owning stack
    uint64_t mask = ~0ull;  // bit i set = sounds during step i
  };

  std::vector<Step> steps;
  std::vector<GateRow> gates;

  // Derived facts, computed once by finalize() on the message thread
  // before the object is published (the audio thread never writes).
  int64_t total = 0;                    // Σ len
  int64_t bounds[kMaxSteps + 1] = {0};  // bounds[i] = start of step i

  /** Compute total + step bounds. Call exactly once, before publish. */
  void finalize() {
    total = 0;
    const int n = numSteps();
    for (int i = 0; i < n; ++i) {
      bounds[i] = total;
      total += steps[(size_t)i].len > 0 ? steps[(size_t)i].len : 0;
    }
    bounds[n] = total;
  }

  int numSteps() const {
    return (int)(steps.size() > (size_t)kMaxSteps ? kMaxSteps : steps.size());
  }

  /** Step index at folded position `rel` ∈ [0, total). Linear scan —
   * n ≤ 64, audio-thread safe. */
  int stepAt(int64_t rel) const {
    const int n = numSteps();
    for (int i = 0; i < n; ++i) {
      if (rel < bounds[i + 1]) return i;
    }
    return n - 1;
  }

  /** The gate bitmask for a child uuid (absent = all ON). Linear scan
   * over a handful of rows; juce::String comparison allocates nothing. */
  uint64_t maskFor(const juce::String& uuid) const {
    for (const auto& row : gates) {
      if (row.uuid == uuid) return row.mask;
    }
    return ~0ull;
  }

  /** Whether step i is gated ON under `mask`. */
  bool on(uint64_t mask, int step) const {
    return step >= 0 && step < kMaxSteps && ((mask >> step) & 1ull) != 0;
  }

  /** Fold an arbitrary position onto the sequence cycle. */
  int64_t fold(int64_t rel) const {
    if (total <= 0) return 0;
    rel %= total;
    return rel < 0 ? rel + total : rel;
  }

  // --- THE GATE ENVELOPE (S7: fades, never hard cuts) ---
  //
  // For a child with gate mask m, the dry-signal gain at folded
  // position `rel` is a PURE piecewise-linear function of the step
  // schedule: 0 across off-steps, 1 across on-runs, with a linear ramp
  // of `fade` samples at each run edge (clamped to half the run when a
  // run is shorter than two fades). Contiguous on-steps merge into one
  // run, INCLUDING across the loop wrap (S3: the sequence loops).
  // Because this is schedule-derived — not integrator state — identical
  // (state, t) yields identical output regardless of block splits (I6).

  /** Gain ∈ [0, 1] for mask `m` at position `rel` (folded internally). */
  float gainAt(uint64_t m, int64_t rel, int64_t fade) const {
    const int n = numSteps();
    if (n <= 0 || total <= 0) return 1.0f;
    rel = fold(rel);
    const uint64_t full = n >= 64 ? ~0ull : ((1ull << n) - 1ull);
    if ((m & full) == full) return 1.0f;  // all on: constant (no run edges)
    if ((m & full) == 0) return 0.0f;     // all off: constant silence
    const int i = stepAt(rel);
    if (!on(m, i)) return 0.0f;
    // Run edges: walk to the first/last on-step of this run (wrapping).
    int first = i;
    while (on(m, (first + n - 1) % n)) first = (first + n - 1) % n;
    int last = i;
    while (on(m, (last + 1) % n)) last = (last + 1) % n;
    const int64_t run_start = bounds[first];
    int64_t run_len = 0;
    for (int k = first;; k = (k + 1) % n) {
      run_len += bounds[k + 1] - bounds[k];
      if (k == last) break;
    }
    const int64_t din = fold(rel - run_start);        // distance into run
    const int64_t dout = run_len - din;               // distance to run end
    const int64_t f = fade < run_len / 2 ? fade : run_len / 2;
    if (f <= 0) return 1.0f;
    const int64_t d = din < dout ? din : dout;
    return d >= f ? 1.0f : (float)d / (float)f;
  }

  /**
   * Samples from folded `rel` to the NEXT envelope corner (any mask):
   * corners live at step boundaries and boundaries ± fade, plus step
   * midpoints (covering runs shorter than two fades). Render splits
   * blocks here so each run has constant-slope gain — the (g0, g1)
   * endpoints the parent hands each child are then exact.
   */
  int64_t cornerDistance(int64_t rel, int64_t fade) const {
    const int n = numSteps();
    if (n <= 0 || total <= 0) return 1;
    int64_t best = total;
    auto consider = [&](int64_t c) {
      c = fold(c);
      int64_t d = c - rel;
      if (d <= 0) d += total;
      if (d < best) best = d;
    };
    for (int i = 0; i < n; ++i) {
      const int64_t b = bounds[i];
      consider(b);
      consider(b - fade);
      consider(b + fade);
      // Midpoint corner: where a short run's in/out ramps intersect.
      consider(b + (bounds[i + 1] - b) / 2);
    }
    return best > 0 ? best : 1;
  }

  /** The gate fade length (S7: ~10 ms anti-pop). */
  static int64_t fadeSamples(double sample_rate) {
    return (int64_t)(sample_rate * 0.010);
  }
};

}  // namespace celestrian
