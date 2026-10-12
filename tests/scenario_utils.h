#pragma once

/**
 * SCENARIO HARNESS (docs/scenarios.md): drive the real AudioEngine
 * through its device callback with a RAMP input whose every sample
 * encodes its own clock, so any committed sample says when it was
 * captured and the whole island's output can be checked against an
 * ANALYTIC expectation — no pan law, latency or gain constant leaks in
 * (center is unity, the test rate has no device latency).
 *
 * Laws the checks rest on (pinned by scenario S1 itself):
 *   content[k] of a take == rampAt(capture_origin + k)
 *   output(t)            == Σ over sounding clips of content[inner(t)]
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <functional>
#include <initializer_list>
#include <map>
#include <memory>
#include <set>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/heard_index.h"
#include "../src/period_law.h"
#include "../src/time_map.h"
#include "test_utils.h"

namespace celestrian::scenario {

constexpr int BLOCK = 512;
constexpr int64_t RAMP_P = int64_t{1} << 20;  // ~52 Q at Q = 20000

/** The input at monotonic clock `t`: a sawtooth whose step (4.8e-7) is
 * resolvable in float after summing a handful of clips, so a check is
 * sample-exact. */
inline float rampAt(int64_t t) {
  const int64_t k = ((t % RAMP_P) + RAMP_P) % RAMP_P;
  return 0.5f * (float)((double)k / (double)RAMP_P);
}

inline int64_t posmod(int64_t a, int64_t m) { return ((a % m) + m) % m; }

/** The gate ramp at a song's step seam, in samples (10 ms at 44.1 kHz,
 * each side of the seam). */
constexpr int64_t GATE_FADE = 441;

/** A time map of the given inner segments, in order. */
inline timing::TimeMap mapOf(
    std::initializer_list<timing::TimeMap::Segment> segments) {
  timing::TimeMap map;
  for (const auto& segment : segments) map.segs[map.n++] = segment;
  return map;
}

/** A sequence payload for the engine's setSequence verb. */
struct StepSpec {
  int64_t len = 0;
  bool cue = false;
  std::vector<int> next;  // successor step indices (weight 1)
};
inline juce::var seqPayload(
    const std::vector<StepSpec>& steps,
    const std::map<juce::String, std::vector<bool>>& gates = {},
    int seed = 0) {
  auto* payload = new juce::DynamicObject();
  juce::Array<juce::var> arr;
  for (size_t i = 0; i < steps.size(); ++i) {
    auto* s = new juce::DynamicObject();
    s->setProperty("name", "s" + juce::String((int)i));
    s->setProperty("len", (double)steps[i].len);
    if (steps[i].cue) s->setProperty("cue", true);
    if (!steps[i].next.empty()) {
      juce::Array<juce::var> next;
      for (int to : steps[i].next) {
        auto* n = new juce::DynamicObject();
        n->setProperty("to", to);
        n->setProperty("w", 1);
        next.add(juce::var(n));
      }
      s->setProperty("next", next);
    }
    arr.add(juce::var(s));
  }
  payload->setProperty("steps", arr);
  if (!gates.empty()) {
    auto* g = new juce::DynamicObject();
    for (const auto& [uuid, bits] : gates) {
      juce::Array<juce::var> b;
      for (bool x : bits) b.add(x);
      g->setProperty(uuid, b);
    }
    payload->setProperty("gates", juce::var(g));
  }
  if (seed != 0) payload->setProperty("seed", seed);
  return juce::var(payload);
}

struct Island {
  // On the HEAP: an engine carries its MIDI rings inline (~130 KB), and
  // a suite's runTest holds dozens of islands in one frame — MSVC does
  // not overlap sibling scopes' slots, so by value the frame outgrew
  // Windows' 1 MB main-thread stack.
  std::unique_ptr<AudioEngine> engine_storage = std::make_unique<AudioEngine>();
  AudioEngine& engine = *engine_storage;
  int64_t clock = 0;  // mirror of the engine's monotonic transport
  bool has_input = true;  // false: drive() runs a device with no inputs
  // What each committed take holds: content[k] == rampAt(captured[id] + k).
  std::map<juce::String, int64_t> captured;
  // Per-clip facts CACHED for the per-sample expectation lambdas (a
  // getGraphState per sample is minutes per check); refreshed at the
  // top of every mismatches() run. An expectation reads these — or facts
  // it captured before the run — never the live graph: mismatches()
  // fails a check whose expectation fetched the state (state_fetches).
  struct ClipFacts {
    int64_t origin = 0, dur = 0, captured = 0;
  };
  std::map<juce::String, ClipFacts> cache;
  int state_fetches = 0;  // getGraphState reads made through state()

  // ---- driving ----
  /** Drive `total` samples of ramp (or silent) input; append (clock, L)
   * pairs to `out` when given. The clock mirror follows the engine's
   * clock: it advances while the transport plays (and through a stop's
   * fade-out tail). */
  void drive(int64_t total, std::vector<std::pair<int64_t, float>>* out = nullptr,
             bool silent = false) {
    std::vector<float> in((size_t)BLOCK), l((size_t)BLOCK), r((size_t)BLOCK);
    float* ins[] = {in.data()};
    float* outs[] = {l.data(), r.data()};
    int64_t remaining = total;
    while (remaining > 0) {
      const int n = (int)std::min<int64_t>(remaining, BLOCK);
      const int64_t before = engine.transportClock();
      for (int i = 0; i < n; ++i) in[(size_t)i] = silent ? 0.0f : rampAt(clock + i);
      engine.audioDeviceIOCallbackWithContext(has_input ? ins : nullptr,
                                              has_input ? 1 : 0, outs, 2, n,
                                              {});
      if (out != nullptr)
        for (int i = 0; i < n; ++i) out->push_back({clock + i, l[(size_t)i]});
      clock += engine.transportClock() - before;
      remaining -= n;
    }
  }
  void blocks(int n) { drive((int64_t)n * BLOCK); }

  // ---- state ----
  juce::var state() {
    ++state_fetches;
    return engine.getGraphState();
  }
  static juce::var findVar(const juce::var& node, const juce::String& id) {
    if (node.getProperty("id", "").toString() == id) return node;
    if (auto* kids = node.getProperty("nodes", juce::var()).getArray())
      for (auto& k : *kids) {
        juce::var hit = findVar(k, id);
        if (!hit.isVoid()) return hit;
      }
    return {};
  }
  juce::var node(const juce::String& id) { return findVar(state(), id); }
  double prop(const juce::String& id, const char* key) {
    const juce::var n = node(id);
    return n.isVoid() ? 0.0 : (double)n.getProperty(key, 0.0);
  }
  int64_t iprop(const juce::String& id, const char* key) {
    return (int64_t)prop(id, key);
  }
  bool bprop(const juce::String& id, const char* key) {
    const juce::var n = node(id);
    return !n.isVoid() && (bool)n.getProperty(key, false);
  }
  juce::String sprop(const juce::String& id, const char* key) {
    const juce::var n = node(id);
    return n.isVoid() ? juce::String() : n.getProperty(key, "").toString();
  }
  int64_t rootProp(const char* key) {
    return (int64_t)(double)state().getProperty(key, 0);
  }
  juce::String rootId() { return state().getProperty("id", "").toString(); }
  int64_t Q() { return rootProp("quantum"); }
  int64_t zero() { return rootProp("islandZero"); }
  int64_t islandPos() { return rootProp("islandPos"); }
  int64_t masterPos() { return rootProp("masterPos"); }
  /** Seek to the published phase `phase`: the engine takes a phase
   * ADVANCE (docs/frame.md; the view computes it), so a test names the
   * phase it wants and advances by the difference. */
  bool seekToPhase(int64_t phase) {
    return engine.seekTransport((double)(phase - masterPos()));
  }
  int64_t dur(const juce::String& id) { return iprop(id, "duration"); }
  int64_t origin(const juce::String& id) { return iprop(id, "origin"); }
  /** The audible island cycle by THE PERIOD LAW over the live tree,
   * judged against the island Q (drifting nodes extend nothing, Q22). */
  int64_t cycle() {
    auto* root = engine.findNodeByUuidForTest(rootId());
    const int64_t q = Q();
    return period_law::islandCycle(period_law::TreeProvider{q}, root, q,
                                   (int64_t)44100);
  }
  AudioNode* nodePtr(const juce::String& id) {
    return engine.findNodeByUuidForTest(id);
  }
  /** Every clip id under `holder` ("" = the whole island), tree order. */
  void clipIds(juce::StringArray& out, const juce::String& holder = "") {
    const juce::var s = state();
    std::function<void(const juce::var&)> walk = [&](const juce::var& n) {
      if (n.getProperty("type", "").toString() == "clip") {
        out.add(n.getProperty("id", "").toString());
        return;
      }
      if (auto* kids = n.getProperty("nodes", juce::var()).getArray())
        for (auto& k : *kids) walk(k);
    };
    walk(holder.isEmpty() ? s : findVar(s, holder));
  }
  /** Direct children ids of `holder` ("" = top level). */
  juce::StringArray childIds(const juce::String& holder = "") {
    juce::StringArray out;
    const juce::var s = state();
    const juce::var h = holder.isEmpty() ? s : findVar(s, holder);
    if (auto* kids = h.getProperty("nodes", juce::var()).getArray())
      for (auto& k : *kids) out.add(k.getProperty("id", "").toString());
    return out;
  }
  juce::String lastChild(const juce::String& holder = "") {
    const juce::StringArray ids = childIds(holder);
    return ids.isEmpty() ? juce::String() : ids[ids.size() - 1];
  }

  // ---- structure ----
  juce::String createClip(const juce::String& parent = "") {
    engine.createNode("clip", parent);
    return lastChild(parent);
  }
  juce::String createStack(const juce::String& parent = "") {
    engine.createNode("stack", parent);
    return lastChild(parent);
  }

  // ---- waiting ----
  /** Drive blocks until `pred()` holds (or `max_blocks`); returns it. */
  bool waitFor(const std::function<bool()>& pred, int max_blocks = 4000) {
    for (int i = 0; i < max_blocks; ++i) {
      if (pred()) return true;
      drive(BLOCK);
    }
    return pred();
  }
  bool anyHot() {
    if (engine.hasActiveTake()) return true;
    const juce::var s = state();  // ONE fetch
    bool hot = false;
    std::function<void(const juce::var&)> walk = [&](const juce::var& n) {
      if (hot) return;
      if ((bool)n.getProperty("isRecording", false) ||
          (bool)n.getProperty("isPendingStart", false) ||
          (bool)n.getProperty("isAwaitingStop", false)) {
        hot = true;
        return;
      }
      if (auto* kids = n.getProperty("nodes", juce::var()).getArray())
        for (auto& k : *kids) walk(k);
    };
    walk(s);
    return hot;
  }
  /** Refresh the cached (origin, duration, capture clock) of every clip. */
  void refresh() {
    cache.clear();
    const juce::var s = state();
    std::function<void(const juce::var&)> walk = [&](const juce::var& n) {
      if (n.getProperty("type", "").toString() == "clip") {
        const juce::String id = n.getProperty("id", "").toString();
        const auto take = captured.find(id);
        cache[id] = {(int64_t)(double)n.getProperty("origin", 0.0),
                     (int64_t)(double)n.getProperty("duration", 0.0),
                     take != captured.end() ? take->second : 0};
        return;
      }
      if (auto* kids = n.getProperty("nodes", juce::var()).getArray())
        for (auto& k : *kids) walk(k);
    };
    walk(s);
  }
  /** Cached origin / duration (for expectation lambdas). */
  int64_t o(const juce::String& id) { return cache.at(id).origin; }
  int64_t d(const juce::String& id) { return cache.at(id).dur; }
  /** Drive until no take is armed, capturing or finishing; then poll
   * (the settle that logs the take). */
  void settle() {
    waitFor([&] { return !anyHot(); });
    engine.tick();
    engine.getGraphState();
  }
  /** Drive until the island phase is just short of `phase` (so an arm
   * now targets exactly `phase` as its next Q boundary). Requires a
   * cycle; `phase` must be on the Q grid. */
  void driveToPhase(int64_t phase) {
    const int64_t C = cycle();
    const int64_t e = zero();  // idle playback: neither moves
    for (int i = 0; i < 100000; ++i) {
      const int64_t p = posmod(clock - e, C);
      const int64_t to = posmod(phase - p, C);
      if (to > 0 && to <= BLOCK) return;  // the next block crosses it
      drive(BLOCK);
    }
  }
  /** Drive to EXACTLY the next top of the island cycle, measured from
   * the zero: two runs started here are aligned sample for sample. */
  void driveToCycleTop() { drive(posmod(zero() - clock, cycle())); }

  // ---- recording ----
  /** Record a take of `len` samples into a fresh clip under `parent`
   * (arm now: the take lands on the NEXT Q boundary), stop, settle.
   * Returns the clip id and remembers what it captured. */
  juce::String record(int64_t len, const juce::String& parent = "") {
    const juce::String id = createClip(parent);
    recordInto(id, len);
    return id;
  }
  void recordInto(const juce::String& id, int64_t len) {
    const bool first = Q() <= 0;
    engine.startRecordingInNode(id);
    waitFor([&] { return bprop(id, "isRecording"); });
    // The block that started the capture already holds `live` samples
    // (the published duration is the live write head). A first take
    // commits at the stop, exactly; later takes pad forward to the
    // boundary — stop a block short so the pad lands ON `len`.
    const int64_t live = iprop(id, "duration");
    // content[0] was captured when the capture began — the real Q
    // boundary. Measured from the clock, not read back from the origin,
    // so the scenarios can PIN that the stored origin is this boundary
    // (never folded: S3, S32).
    captured[id] = clock - live;
    const int64_t more = len - live - (first ? 0 : BLOCK);
    if (more > 0) drive(more);
    engine.stopRecordingInNode(id);
    settle();
  }
  /** A group take: `mics` empty clips in a fresh stack under `parent`,
   * armed as one performance. Returns the stack id. */
  juce::String recordGroup(int mics, int64_t len, const juce::String& parent = "") {
    const juce::String stack = createStack(parent);
    juce::StringArray ids;
    for (int i = 0; i < mics; ++i) ids.add(createClip(stack));
    const bool first = Q() <= 0;
    engine.startRecordingInNode(stack);
    waitFor([&] { return bprop(ids[0], "isRecording"); });
    const int64_t live = iprop(ids[0], "duration");
    for (const auto& id : ids) captured[id] = clock - live;
    const int64_t more = len - live - (first ? 0 : BLOCK);
    if (more > 0) drive(more);
    engine.stopRecordingInNode(stack);
    settle();
    return stack;
  }

  // ---- expectations ----
  /** What content index k of take `id` holds. */
  float val(const juce::String& id, int64_t k) { return rampAt(captured.at(id) + k); }
  /** The plain loop law for a whole take: content[(t − origin) mod D]
   * (cached facts — call inside an expectation lambda). */
  float loopVal(const juce::String& id, int64_t t) {
    const ClipFacts& f = cache.at(id);
    return rampAt(f.captured + posmod(t - f.origin, f.dur));
  }
  /** Drive `span` samples and count samples whose output differs from
   * `expected(t)` by more than `tol`. Skips the first `skip` samples
   * (a block of settle) and every sample `ignore` names (nearSeam: the
   * gate ramps). Refreshes the fact cache first. An expectation that
   * fetches the live graph fails the whole span at once. */
  int mismatches(int64_t span, const std::function<float(int64_t)>& expected,
                 float tol = 2.0e-7f, int64_t skip = 0,
                 const std::function<bool(int64_t)>& ignore = nullptr) {
    refresh();
    const int64_t zero_now = zero();  // for the mismatch log only
    std::vector<std::pair<int64_t, float>> out;
    drive(span, &out);
    const int fetches_before = state_fetches;
    int bad = 0;
    int logged = 0;
    for (const auto& [t, v] : out) {
      if (t < out.front().first + skip) continue;
      if (ignore != nullptr && ignore(t)) continue;
      const float want = expected(t);
      if (state_fetches != fetches_before) {
        juce::Logger::writeToLog(
            "  scenario: the expectation read the live graph per sample - "
            "read each fact once, before the run (or use the cached o/d)");
        return (int)out.size();
      }
      if (std::abs(want - v) > tol) {
        if (logged++ < 3) {
          juce::Logger::writeToLog(
              "  scenario mismatch at t=" + juce::String(t) + " (t-zero=" +
              juce::String(t - zero_now) + "): want " + juce::String(want, 7) +
              " got " + juce::String(v, 7));
        }
        ++bad;
      }
    }
    return bad;
  }
  /** The samples within the gate ramp of a step seam, for a song whose
   * steps are each `step` long and fold from `anchor`: an expectation
   * that states the gates as on or off leaves these out. */
  static std::function<bool(int64_t)> nearSeam(int64_t anchor, int64_t step) {
    return [anchor, step](int64_t t) {
      const int64_t into = posmod(t - anchor, step);
      return std::min(into, step - into) <= GATE_FADE;
    };
  }
  /** Σ of the plain loop law over `ids` — the expectation for an island
   * of untrimmed loops. */
  std::function<float(int64_t)> sumOfLoops(const juce::StringArray& ids) {
    return [this, ids](int64_t t) {
      float s = 0.0f;
      for (const auto& id : ids) s += loopVal(id, t);
      return s;
    };
  }

  // ---- geometry helpers ----
  void window(const juce::String& id, int64_t start, int64_t end) {
    engine.setLoopPoints(id, start, end);
  }
  /** The windowed loop law: content[ws + ((t − origin − ws) mod len)]
   * (cached facts). */
  float windowVal(const juce::String& id, int64_t t, int64_t ws, int64_t len) {
    const ClipFacts& f = cache.at(id);
    return rampAt(f.captured + ws + posmod(t - f.origin - ws, len));
  }
};

}  // namespace celestrian::scenario
