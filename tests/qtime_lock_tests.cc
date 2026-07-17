/**
 * Provisional-Q mutability (design_language.md Q13, non-sticky) + its
 * undo integration.
 *
 * One derived rule: Q is re-establishable while the island has exactly
 * ONE committed clip; locked while ≥2; reverts at 0. All three
 * transitions ride the edit log so undo restores the GRID, not just the
 * clip/window.
 */

#include <juce_core/juce_core.h>

#include <functional>
#include <set>

#include "../src/audio_engine.h"

namespace celestrian {

namespace {
juce::Array<juce::var>* nodesOf(const juce::var& s) {
  return s.getProperty("nodes", juce::var()).getArray();
}
int64_t islandQ(AudioEngine& e) {
  return (int64_t)(double)e.getGraphState().getProperty("quantum", 0);
}
int64_t islandEp(AudioEngine& e) {
  return (int64_t)(double)e.getGraphState().getProperty("epoch", 0);
}
int64_t clipOrigin(AudioEngine& e, const juce::String& uuid) {
  const juce::var s = e.getGraphState();  // hold: getArray() dangles past it
  if (auto* n = nodesOf(s))
    for (auto& x : *n)
      if (x.getProperty("id", "").toString() == uuid)
        return (int64_t)(double)x.getProperty("origin", 0);
  return 0;
}
// Committed ⟺ not recording and has a duration. (getMetadata publishes
// live_duration as "duration" while recording, so gate on isRecording.)
bool clipCommitted(AudioEngine& e, const juce::String& uuid) {
  const juce::var s = e.getGraphState();
  if (auto* n = nodesOf(s))
    for (auto& x : *n)
      if (x.getProperty("id", "").toString() == uuid)
        return !(bool)x.getProperty("isRecording", false) &&
               (double)x.getProperty("duration", 0) > 0;
  return false;
}

// Create a clip and record `lengthSamples` into it through the real
// callback path, returning its uuid.
juce::String recordClip(AudioEngine& e, std::function<void(int)> process,
                        int lengthSamples) {
  std::set<juce::String> before;
  {
    const juce::var s = e.getGraphState();
    if (auto* n = nodesOf(s))
      for (auto& x : *n) before.insert(x.getProperty("id", "").toString());
  }
  e.createNode("clip");
  juce::String id;
  {
    const juce::var s = e.getGraphState();
    if (auto* n = nodesOf(s))
      for (auto& x : *n) {
        auto i = x.getProperty("id", "").toString();
        if (!before.count(i)) id = i;
      }
  }
  e.startRecordingInNode(id);
  process(100);
  process(lengthSamples);
  e.stopRecordingInNode(id);
  // A non-first clip pads forward to its next Q boundary before
  // committing (up to ~1Q away), so pump blocks until it actually
  // commits rather than a fixed count.
  for (int i = 0; i < 400 && !clipCommitted(e, id); ++i) process(512);
  return id;
}
}  // namespace

class QTimeLockTests : public juce::UnitTest {
 public:
  QTimeLockTests() : juce::UnitTest("Provisional Q mutability (Q13)") {}

  void runTest() override {
    const int Q = 44100;
    const int BLOCK = 512;
    std::vector<float> buf(BLOCK, 0.1f);  // nonzero so takes commit >0

    auto makeProcess = [&](AudioEngine& e) {
      return [&e, &buf, BLOCK](int total) {
        float* ins[] = {buf.data()};
        float* outs[] = {buf.data(), buf.data()};
        int remaining = total;
        while (remaining > 0) {
          int n = std::min(remaining, BLOCK);
          e.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          remaining -= n;
        }
      };
    };

    beginTest("sole clip: loop re-trim re-establishes (Q, epoch); undo restores");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);  // ~1Q take
      const int64_t q0 = islandQ(engine), ep0 = islandEp(engine);
      expect(q0 > 0, "Q established by the sole take");
      const int64_t origin = clipOrigin(engine, c1);

      // Trim to a sub-window [ws, ws+len): Q := len, epoch := origin+ws.
      const int64_t ws = 5000, len = 30000;
      engine.setLoopPoints(c1, ws, ws + len);
      expectEquals(islandQ(engine), len, "Q re-established to the window length");
      expectEquals(islandEp(engine), origin + ws, "epoch := origin + window start");

      engine.undo();
      expectEquals(islandQ(engine), q0, "undo restores the old Q");
      expectEquals(islandEp(engine), ep0, "undo restores the old epoch");

      engine.redo();
      expectEquals(islandQ(engine), len, "redo re-applies the re-trim");
    }

    beginTest("a 2nd committed clip LOCKS Q (re-trim is a no-op to Q)");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);
      const int64_t qLocked = islandQ(engine);
      recordClip(engine, process, 2 * Q);  // 2nd take → count 2 → locked
      expectEquals(islandQ(engine), qLocked, "Q unchanged by the 2nd commit");

      engine.setLoopPoints(c1, 1000, 20000);  // would re-trim if provisional
      expectEquals(islandQ(engine), qLocked, "locked: loop drag does not move Q");
    }

    beginTest("delete the sole Q-definer reverts Q; undo restores it");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);
      const int64_t q0 = islandQ(engine), ep0 = islandEp(engine);
      expect(q0 > 0, "Q established");

      engine.deleteNode(c1);
      expectEquals(islandQ(engine), (int64_t)0, "Q reverts to unestablished");
      expectEquals(islandEp(engine), (int64_t)0, "epoch reverts");

      engine.undo();
      expectEquals(islandQ(engine), q0, "undo restores Q with the clip");
      expectEquals(islandEp(engine), ep0, "undo restores epoch");

      engine.redo();
      expectEquals(islandQ(engine), (int64_t)0, "redo re-reverts");
    }

    beginTest("delete back down to one clip RE-OPENS Q (non-sticky)");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);        // Q := ~1Q
      auto c2 = recordClip(engine, process, 2 * Q);    // locks
      const int64_t qLocked = islandQ(engine);

      engine.setLoopPoints(c1, 0, 10000);  // locked: no effect on Q
      expectEquals(islandQ(engine), qLocked, "still locked with 2 clips");

      engine.deleteNode(c2);  // 2 → 1: Q untouched but re-opens
      expectEquals(islandQ(engine), qLocked, "delete 2→1 leaves Q as-is");

      engine.setLoopPoints(c1, 0, 12345);  // now provisional again
      expectEquals(islandQ(engine), (int64_t)12345, "Q re-opened: re-trim moves it");
    }
  }
};

static QTimeLockTests qtimeLockTests;

}  // namespace celestrian
