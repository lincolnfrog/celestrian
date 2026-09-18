#pragma once

#include <juce_core/juce_core.h>

#include <cstdint>
#include <vector>

#include "qtime.h"

namespace celestrian {

/**
 * The SEQUENCER's core type (docs/sequencer.md — the fractal per-stack
 * Sequence): an ordered list of STEPS, each a whole span of the stack's
 * timeline, plus per-child GATE rows saying which children sound during
 * which steps, plus the SUCCESSOR GRAPH and its SEED (§6, §14) that
 * turn the step list into a PROGRAM.
 *
 * Semantics (sequencer.md §0/§9/§14):
 *  - Gates are MUTE-SHAPED (S1): a gated-off child keeps its clock; an
 *    entrance lands exactly in phase. Nothing here transforms time.
 *  - Steps advance by a SUCCESSOR FUNCTION: each step names weighted
 *    successors (`Step::next`; empty = the loop successor (i+1) mod n,
 *    S3). The PROGRAM is the walk from step 0 — a list of VISITS, each
 *    a step with a length — and the program is what the timeline IS:
 *    positions, gates, cues and the period all read through it.
 *  - The walk is PURE: draws come from a counter hash of the SEED and
 *    the visit index, so (sequence, seed) unrolls to one program every
 *    time (I6 — the audio thread derives "which step at t" from
 *    snapshot + clock alone). Re-roll = a new seed = a new edit.
 *  - PERIODIC vs RADIO: when every visited step has exactly one
 *    successor and the walk returns to step 0, the program is the loop
 *    and `total` is its period (a plain song is this with the default
 *    successors). Otherwise the sequence is a RADIO — it has no
 *    period, so it is legal on the ROOT only (S12, composition.md §3)
 *    — and the program is the walk unrolled to the HORIZON
 *    (kMaxVisits visits), after which it repeats; the horizon total is
 *    what the frame folds on.
 *  - An ACTIVE sequence sets the stack's effective period to `total`
 *    (the period law, §2) — visits CONCATENATE, they never LCM.
 *  - Absent uuid in `gates` = inherit ON everywhere (a track added
 *    after the sequence was written sounds until told otherwise).
 *  - The gate is applied PRE-FX with a fade (S7 smoothness law) — the
 *    envelope below is a PURE function of position, so render output
 *    never depends on block boundaries (render purity).
 *
 * Threading (the FxChain discipline): an immutable
 * heap object behind ONE atomic pointer on StackNode. The MESSAGE
 * thread builds a fresh Sequence (finalize() before publishing) and
 * retires the predecessor through the engine reclaimer; the audio
 * thread only loads the pointer and reads.
 */
struct Sequence {
  static constexpr int kMaxSteps = 64;  // gate rows are uint64 bitmasks
  /** The radio HORIZON: how many visits a period-less program unrolls
   * before it repeats (sequencer.md §14). A periodic program never
   * needs more than kMaxSteps. */
  static constexpr int kMaxVisits = 256;

  struct Successor {
    int to = 0;      // a step index
    int weight = 1;  // relative chance (>= 1)
  };
  struct Step {
    int64_t len = 0;  // samples (whole-Q by UI construction; engine
                      // accepts free lengths — S10: permitted, badged)
    juce::String name;
    // CUE (S11, docs/sequencer.md §3 — the Q6 serial primitive): a cued
    // step re-bases the subtree's received frame to the visit top —
    // children hear t' = zero + (songRel - visitStart), so a cued
    // child starts from its own top on every entrance (verse-box then
    // chorus-box; the radio's song-after-song). Playback-only here:
    // the envelope below treats cued-visit edges as hard cuts (S20);
    // the re-base itself lives in StackNode::childContext.
    bool cue = false;
    // The successor graph (§6): empty = the loop successor (i+1) mod n.
    std::vector<Successor> next;
    // PER-STEP FADES (S13, §15): musical ramp lengths in samples. A
    // gate run that STARTS on this step ramps in over fade_in; one that
    // ENDS on it ramps out over fade_out. 0 = the anti-pop micro-fade
    // only (the ramp is never shorter than that).
    int64_t fade_in = 0;
    int64_t fade_out = 0;
  };
  struct GateRow {
    juce::String uuid;      // a DIRECT child of the owning stack
    uint64_t mask = ~0ull;  // bit i set = sounds during step i
  };

  std::vector<Step> steps;
  std::vector<GateRow> gates;
  uint32_t seed = 0;  // the radio's performance — data (§6)

  // Derived facts, computed once by finalize() on the message thread
  // before the object is published (the audio thread never writes).
  int64_t total = 0;                     // Σ visit lengths (the program)
  int visit_count = 0;                   // program length in visits
  int visit_step[kMaxVisits] = {0};      // visit k plays this step
  int64_t bounds[kMaxVisits + 1] = {0};  // bounds[k] = start of visit k
  int first_visit[kMaxSteps] = {0};      // per step: first visit, −1 = none
  uint64_t reachable = 0;                // bit i = step i is in the program
  bool any_cue = false;                  // some VISIT is cued (audio-thread
                                         // fast-path guard; a cued step the
                                         // program never visits is not a cue)
  bool radio = false;                    // period-less (root only, S12)

  /** Compute the program, total, bounds and the derived flags. Call
   * exactly once, before publish. */
  void finalize() {
    const int n = numSteps();
    total = 0;
    visit_count = 0;
    reachable = 0;
    any_cue = false;
    radio = false;
    for (int i = 0; i < kMaxSteps; ++i) first_visit[i] = -1;
    bounds[0] = 0;
    if (n <= 0) return;
    // `any_cue` is derived INSIDE the walk (per visit, below), never from
    // the step list: a cued step the program does not reach is an orphan,
    // and an orphan cue that still set the flag would make `runAround`
    // walk forever on a mask that is on across every visit (no off
    // visit, no cued visit — nothing to stop at). The fast paths in
    // gainAt/cornerDistance and the cue re-base all key off this flag.
    // THE WALK (§14): from step 0, one visit per iteration. It stops
    // early only when it is deterministic so far AND returns to step
    // 0 — the loop closed, the program is periodic. Any draw, or a
    // deterministic return to a step other than 0 (an intro that is
    // never replayed), makes the program period-less: the walk runs
    // to the horizon and the sequence is a radio.
    bool deterministic = true;
    int step = 0;
    while (visit_count < kMaxVisits) {
      const int k = visit_count++;
      visit_step[k] = step;
      bounds[k] = total;
      total += steps[(size_t)step].len > 0 ? steps[(size_t)step].len : 0;
      reachable |= (1ull << step);
      if (steps[(size_t)step].cue) any_cue = true;
      if (first_visit[step] < 0) first_visit[step] = k;
      bool branched = false;
      const int next = successorOf(step, k, branched);
      if (branched) deterministic = false;
      if (deterministic && next == 0) break;  // periodic: the loop closed
      if (deterministic && first_visit[next] >= 0) radio = true;  // an intro
      step = next;
    }
    bounds[visit_count] = total;
    if (!deterministic) radio = true;
    if (deterministic && !radio && visit_count >= kMaxVisits) radio = true;
  }

  /** Drop every explicit successor (the sequence becomes the plain
   * loop) and re-finalize — how a radio is demoted where it is not
   * legal (a nested stack, S12). */
  void linearize() {
    for (auto& st : steps) st.next.clear();
    finalize();
  }

  /** Whether the walk from step 0 is a plain 0,1,…,n−1 loop (no
   * explicit successor changes the order). */
  bool isPlainLoop() const {
    const int n = numSteps();
    if (visit_count != n) return false;
    for (int k = 0; k < n; ++k) {
      if (visit_step[k] != k) return false;
    }
    return !radio;
  }

  // --- THE SUCCESSOR FUNCTION (§6, §14) ---

  /** The counter hash behind every draw: lowbias32 over the seed and
   * the visit index. Integer-only so the JS mirror
   * (ui/js/sequence_program.js) reproduces it bit for bit. */
  static uint32_t mix32(uint32_t x) {
    x ^= x >> 16;
    x *= 0x7feb352du;
    x ^= x >> 15;
    x *= 0x846ca68bu;
    x ^= x >> 16;
    return x;
  }
  static uint32_t draw(uint32_t seed, int visit) {
    return mix32(seed ^ mix32((uint32_t)visit * 0x9e3779b9u + 0x7f4a7c15u));
  }

  /** The step the walk moves to from `step` at visit `visit`. Sets
   * `branched` when a draw decided it (more than one candidate). Out-
   * of-range or non-positive-weight entries are ignored; no valid
   * entry = the loop successor. */
  int successorOf(int step, int visit, bool& branched) const {
    const int n = numSteps();
    branched = false;
    if (n <= 0) return 0;
    // Candidates: explicit entries, merged by target (a target listed
    // twice adds its weights).
    int cand_to[kMaxSteps];
    int64_t cand_weight[kMaxSteps];
    int cand_count = 0;
    int64_t weight_sum = 0;
    for (const auto& s : steps[(size_t)step].next) {
      if (s.to < 0 || s.to >= n || s.weight <= 0) continue;
      int c = 0;
      while (c < cand_count && cand_to[c] != s.to) ++c;
      if (c == cand_count) {
        cand_to[cand_count] = s.to;
        cand_weight[cand_count] = 0;
        ++cand_count;
      }
      cand_weight[c] += s.weight;
      weight_sum += s.weight;
    }
    if (cand_count == 0) return (step + 1) % n;
    if (cand_count == 1) return cand_to[0];
    branched = true;
    int64_t r = (int64_t)(draw(seed, visit) % (uint32_t)weight_sum);
    for (int c = 0; c < cand_count; ++c) {
      if (r < cand_weight[c]) return cand_to[c];
      r -= cand_weight[c];
    }
    return cand_to[cand_count - 1];
  }

  // --- LOOKUPS (audio-thread safe: no allocation, O(log visits)) ---

  int numSteps() const {
    return (int)(steps.size() > (size_t)kMaxSteps ? kMaxSteps : steps.size());
  }

  /** Visit index at folded position `rel` ∈ [0, total). Binary search
   * over the visit bounds. */
  int visitAt(int64_t rel) const {
    if (visit_count <= 0) return 0;
    int lo = 0, hi = visit_count - 1;
    while (lo < hi) {
      const int mid = (lo + hi + 1) / 2;
      if (bounds[mid] <= rel) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Step index at folded position `rel` ∈ [0, total). */
  int stepAt(int64_t rel) const { return visit_step[visitAt(rel)]; }

  /** Whether step i is CUED (bounds-checked; out of range = false). */
  bool cueAt(int i) const {
    return i >= 0 && i < numSteps() && steps[(size_t)i].cue;
  }

  /** Whether visit k plays a cued step (bounds-checked). */
  bool cueOfVisit(int k) const {
    return k >= 0 && k < visit_count && cueAt(visit_step[k]);
  }

  /** The length of visit k in samples (0 out of range). */
  int64_t visitLen(int k) const {
    return (k >= 0 && k < visit_count) ? bounds[k + 1] - bounds[k] : 0;
  }

  /** Whether step i appears in the program (an unreachable step never
   * sounds and cannot be auditioned). */
  bool reachableStep(int i) const {
    return i >= 0 && i < numSteps() && ((reachable >> i) & 1ull) != 0;
  }

  /**
   * S20: the boundary between ADJACENT visits a -> b (b = (a+1) mod
   * visits, including the wrap) is a HARD CUT when either side is
   * cued — the child clock jumps there (re-base in or out), so the
   * gate envelope must dip through zero (the ~10 ms anti-pop micro-
   * fade) even for a child gated ON across it. Musical crossfades
   * between cued children (S13) are not built.
   */
  bool cutBetween(int a, int b) const {
    return cueOfVisit(a) || cueOfVisit(b);
  }

  /**
   * THE CUE MAP (docs/sequencer.md §3): song position -> content
   * position. Identity on plain visits; a cued visit selects the song
   * TOP span [0, len) — the per-visit zero re-base (Q6: a serial group
   * is a composite whose time-map routes each child a sub-range of the
   * cycle). `rel` is folded internally.
   */
  int64_t songToContent(int64_t rel) const {
    rel = fold(rel);
    const int k = visitAt(rel);
    return cueOfVisit(k) ? rel - bounds[k] : rel;
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

  /** Whether visit k is gated ON under `mask`. */
  bool onVisit(uint64_t mask, int k) const {
    return k >= 0 && k < visit_count && on(mask, visit_step[k]);
  }

  /** Fold an arbitrary position onto the program cycle (0 when there
   * is no program). */
  int64_t fold(int64_t rel) const {
    return total > 0 ? timing::posMod(rel, total) : 0;
  }

  // --- THE GATE ENVELOPE (S7: fades, never hard cuts; S13: per-step
  // musical fades) ---
  //
  // For a child with gate mask m, the dry-signal gain at folded
  // position `rel` is a PURE piecewise-linear function of the program:
  // 0 across off-visits, 1 across on-runs, with a linear ramp at each
  // run edge — the anti-pop `fade`, or the step's own fade_in (at the
  // run's first step) / fade_out (at its last step) when longer. When
  // the two ramps do not fit the run they shrink proportionally so they
  // meet. Contiguous on-visits merge into one run, INCLUDING across the
  // wrap (S3: the program loops). Because this is schedule-derived —
  // not integrator state — identical (state, t) yields identical output
  // regardless of block splits (I6).

  /** The on-run of mask `m` around visit `k` (which must be on): its
   * first/last visits, start and length — wrapping, broken at cue
   * seams (S20). */
  struct Run {
    int first = 0;
    int last = 0;
    int64_t start = 0;
    int64_t len = 0;
  };
  Run runAround(uint64_t m, int k) const {
    const int n = visit_count;
    Run r;
    // Both walks are bounded by n − 1 steps as a defensive invariant:
    // the callers' fast paths guarantee an off or cued visit exists, but
    // this runs on the audio thread and must terminate regardless.
    r.first = k;
    for (int guard = 1; guard < n; ++guard) {
      const int prev = (r.first + n - 1) % n;
      if (!onVisit(m, prev) || cutBetween(prev, r.first)) break;
      r.first = prev;
    }
    r.last = k;
    for (int guard = 1; guard < n; ++guard) {
      const int next = (r.last + 1) % n;
      if (!onVisit(m, next) || cutBetween(r.last, next)) break;
      r.last = next;
    }
    r.start = bounds[r.first];
    for (int v = r.first;; v = (v + 1) % n) {
      r.len += bounds[v + 1] - bounds[v];
      if (v == r.last) break;
    }
    return r;
  }

  /** The run's two ramp lengths: max(anti-pop, the step's fade), then
   * shrunk proportionally so f_in + f_out ≤ run length. */
  void rampsOf(const Run& r, int64_t fade, int64_t& f_in,
               int64_t& f_out) const {
    const int64_t in = steps[(size_t)visit_step[r.first]].fade_in;
    const int64_t out = steps[(size_t)visit_step[r.last]].fade_out;
    f_in = in > fade ? in : fade;
    f_out = out > fade ? out : fade;
    if (f_in < 0) f_in = 0;
    if (f_out < 0) f_out = 0;
    const int64_t sum = f_in + f_out;
    if (sum > r.len && sum > 0) {
      f_in = f_in * r.len / sum;
      f_out = r.len - f_in;
    }
  }

  /** Gain ∈ [0, 1] for mask `m` at position `rel` (folded internally). */
  float gainAt(uint64_t m, int64_t rel, int64_t fade) const {
    const int n = visit_count;
    if (n <= 0 || total <= 0) return 1.0f;
    rel = fold(rel);
    // All reachable steps on: constant 1 — UNLESS a cued step exists
    // (S20): its edges are hard cuts the envelope must still dip
    // through.
    if ((m & reachable) == reachable && !any_cue) return 1.0f;
    if ((m & reachable) == 0) return 0.0f;  // all off: constant silence
    const int k = visitAt(rel);
    if (!onVisit(m, k)) return 0.0f;
    const Run r = runAround(m, k);
    int64_t f_in = 0, f_out = 0;
    rampsOf(r, fade, f_in, f_out);
    const int64_t din = fold(rel - r.start);  // distance into run
    const int64_t dout = r.len - din;         // distance to run end
    float g = 1.0f;
    if (f_in > 0 && din < f_in) g = (float)din / (float)f_in;
    if (f_out > 0 && dout < f_out) {
      const float go = (float)dout / (float)f_out;
      if (go < g) g = go;
    }
    return g;
  }

  /**
   * Samples from folded `rel` to the NEXT envelope corner for mask
   * `m`: every visit boundary (the cue re-base and the step lookup are
   * per visit, so no run may straddle one), plus — inside an on-run —
   * the two ramp corners. Render splits blocks here so each run has
   * constant-slope gain: the (g0, g1) endpoints the parent hands each
   * child are then exact. O(log visits) plus the run walk.
   */
  int64_t cornerDistance(int64_t rel, int64_t fade, uint64_t m) const {
    const int n = visit_count;
    if (n <= 0 || total <= 0) return 1;
    rel = fold(rel);
    const int k = visitAt(rel);
    int64_t best = bounds[k + 1] - rel;  // the next visit boundary
    if (best <= 0) best = 1;
    const bool constant =
        ((m & reachable) == reachable && !any_cue) || (m & reachable) == 0;
    if (constant || !onVisit(m, k)) return best;
    const Run r = runAround(m, k);
    int64_t f_in = 0, f_out = 0;
    rampsOf(r, fade, f_in, f_out);
    auto consider = [&](int64_t c) {
      c = fold(c);
      int64_t d = c - rel;
      if (d <= 0) d += total;
      if (d < best) best = d;
    };
    consider(r.start + f_in);
    consider(r.start + r.len - f_out);
    return best > 0 ? best : 1;
  }

  /** The gate fade length (S7: ~10 ms anti-pop). */
  static int64_t fadeSamples(double sample_rate) {
    return (int64_t)(sample_rate * 0.010);
  }

  // --- THE SUCCESSOR WIRE FORMAT: [{to, w}] on a step (metadata,
  // session, template — one shape everywhere) ---

  static juce::var successorsVar(const Step& st) {
    juce::Array<juce::var> next;
    for (const auto& s : st.next) {
      auto* o = new juce::DynamicObject();
      o->setProperty("to", s.to);
      o->setProperty("w", s.weight);
      next.add(juce::var(o));
    }
    return next;
  }

  /** Read a step's `next` array; entries out of the step range or with
   * a non-positive weight are dropped (finalize ignores them anyway). */
  static void readSuccessors(const juce::var& step_var, Step& st) {
    st.next.clear();
    auto* next = step_var.getProperty("next", juce::var()).getArray();
    if (next == nullptr) return;
    for (const auto& nv : *next) {
      Successor s;
      s.to = (int)nv.getProperty("to", -1);
      s.weight = (int)nv.getProperty("w", 1);
      if (s.to < 0 || s.to >= kMaxSteps || s.weight <= 0) continue;
      st.next.push_back(s);
    }
  }
};

}  // namespace celestrian
