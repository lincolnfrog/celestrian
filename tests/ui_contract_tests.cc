/**
 * UI Contract Capture Harness (docs/ui_overhaul.md §7)
 *
 * The UI cannot be driven headless (native WKWebView + live audio
 * input), so this is the testable seam: drive a scripted record→commit
 * through the REAL engine, capture every getGraphState() "poll", and
 *   1. assert the published-state contract here (masterPos view
 *      semantics, islandEpoch re-base, live duration growth), and
 *   2. dump the full poll sequence to shared/ui_contract_capture.json,
 *      which ui/js/tests/engine_replay.test.mjs replays through the
 *      actual deriveViewModel to assert DISPLAY invariants (frame
 *      stability, playhead continuity) against engine-real data.
 *
 * The scenario mirrors the 2026-07-10 field flow: first take establishes
 * Q, second take grows the cycle and is stopped just PAST a boundary
 * (inside the 15% hysteresis snap-down window — the "stretch then
 * squish" report).
 *
 * Regenerate the fixture by running CelestrianTests (Debug binary).
 */

#include <juce_core/juce_core.h>

#include <vector>

#include "../src/audio_engine.h"
#include "test_utils.h"

using celestrian::test_utils::childDuration;
using celestrian::test_utils::childId;
using celestrian::test_utils::childIsRecording;
using celestrian::test_utils::childVar;
using celestrian::test_utils::firstNodeId;

class UiContractTests : public juce::UnitTest {
 public:
  UiContractTests() : juce::UnitTest("UI Contract Capture", "Audio Engine") {}

  void runTest() override {
    beginTest("record->commit publishes a coherent display contract");

    const int Q = 1000;
    const int BLOCK = 100;  // fine-grained polls: one per block

    AudioEngine engine;
    juce::Array<juce::var> capture;

    auto poll = [&](const char* tag) {
      auto state = engine.getGraphState();
      state.getDynamicObject()->setProperty("_tag", tag);
      capture.add(state);
    };

    // --- Take 1: establishes Q = 1000 ---
    engine.createNode("stack");
    auto stackId = firstNodeId(engine);
    engine.createNode("clip", stackId);
    auto clipA = childId(engine, 0);
    poll("pre-rec-1");

    engine.startRecordingInNode(clipA);
    for (int i = 0; i < Q / BLOCK; ++i) {
      processSilence(engine, BLOCK);
      poll("rec-1");
    }
    engine.stopRecordingInNode(clipA);
    poll("commit-1");
    expectEquals(childDuration(engine, 0), (int64_t)Q,
                 "take 1 commits at 1Q and establishes the grid");

    // --- Loop a while (idle view must stay wrapped in [0, Q)) ---
    for (int i = 0; i < 7; ++i) {
      processSilence(engine, BLOCK);
      poll("looping");
      double mp = masterPosD(engine);
      expect(mp >= 0 && mp < (double)Q, "idle masterPos wrapped into cycle");
    }

    // --- Take 2: arm mid-loop, record past TWO boundaries, stop just
    //     past a boundary (inside the 15% snap-down window) ---
    engine.createNode("clip", stackId);
    auto clipB = childId(engine, 1);
    engine.startRecordingInNode(clipB);
    poll("armed-2");

    double lastView = masterPosD(engine);
    int64_t lastDur = 0;
    // 2Q of content + 100 samples past the next boundary (100 < 150)
    const int recBlocks = (2 * Q + 100 + (Q - (int)lastView % Q)) / BLOCK;
    for (int i = 0; i < recBlocks; ++i) {
      processSilence(engine, BLOCK);
      poll("rec-2");
      // Contract: the recording view grows monotonically, never wraps
      double mp = masterPosD(engine);
      expect(mp >= lastView, "recording masterPos is monotone (never wraps)");
      lastView = mp;
      int64_t dur = childDuration(engine, 1);
      expect(dur >= lastDur, "live duration is monotone");
      lastDur = dur;
    }

    const int64_t epochBefore = islandEpoch(engine);
    engine.stopRecordingInNode(clipB);
    poll("stop-requested");
    // CONTRACT (learned from this harness's first run): the engine has
    // NO downward snap — stopRecording always awaits the NEXT boundary
    // (nextStopBoundary), continuing to record until it lands. The UI
    // must treat isAwaitingStop as "finishing to a known boundary".
    expect(childAwaitingStop(engine, 1),
           "a mid-Q stop request enters awaiting-stop");

    int guard = 0;
    while (childIsRecording(engine, 1) && guard++ < 40) {
      processSilence(engine, BLOCK);
      poll("awaiting-stop");
    }
    expect(guard < 40, "awaiting-stop commits within a cycle");
    poll("committed");
    for (int i = 0; i < 8; ++i) {
      processSilence(engine, BLOCK);
      poll("post-commit");
    }

    // Committed at the NEXT boundary above the stop request: 3Q
    expectEquals(childDuration(engine, 1), (int64_t)(3 * Q),
                 "stop pads forward to the next boundary (no snap-down)");
    // Epoch re-bases ONLY on growth — to the newest committed origin
    const int64_t epochAfter = islandEpoch(engine);
    expect(epochAfter != epochBefore, "epoch re-bases when the cycle grows");
    expectEquals(epochAfter, childOrigin(engine, 1),
                 "epoch re-bases to the newest committed origin");

    // --- Dump the capture for the JS replay ---
    auto outFile = repoFile("shared/ui_contract_capture.json");
    juce::DynamicObject::Ptr root = new juce::DynamicObject();
    root->setProperty("meta", metaObject(Q, BLOCK));
    root->setProperty("polls", capture);
    outFile.replaceWithText(juce::JSON::toString(juce::var(root.get())));
    logMessage("capture: " + outFile.getFullPathName() + " (" +
               juce::String(capture.size()) + " polls)");
  }

 private:
  juce::var metaObject(int q, int block) {
    juce::DynamicObject::Ptr m = new juce::DynamicObject();
    m->setProperty("quantum", q);
    m->setProperty("block", block);
    m->setProperty("scenario",
                   "take1 1Q; loop; take2 grows cycle, stop 100 past "
                   "boundary (hysteresis snap-down window)");
    return juce::var(m.get());
  }

  juce::File repoFile(const juce::String& rel) {
    auto dir = juce::File::getCurrentWorkingDirectory();
    for (int i = 0; i < 8; ++i) {
      if (dir.getChildFile("shared").isDirectory())
        return dir.getChildFile(rel);
      dir = dir.getParentDirectory();
    }
    // Fall back to source-relative
    return juce::File(__FILE__)
        .getParentDirectory()
        .getParentDirectory()
        .getChildFile(rel);
  }

  void processBlock(AudioEngine& engine, const float* in, int n) {
    std::vector<float> outL((size_t)n, 0.0f), outR((size_t)n, 0.0f);
    const float* ins[] = {in};
    float* outs[] = {outL.data(), outR.data()};
    engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
  }

  void processSilence(AudioEngine& engine, int n) {
    std::vector<float> in((size_t)n, 0.0f);
    processBlock(engine, in.data(), n);
  }

  double masterPosD(AudioEngine& engine) {
    return (double)engine.getGraphState().getDynamicObject()->getProperty(
        "masterPos");
  }

  int64_t islandEpoch(AudioEngine& engine) {
    return (int64_t)(double)engine.getGraphState()
        .getDynamicObject()
        ->getProperty("islandEpoch");
  }

  int64_t childOrigin(AudioEngine& engine, int index) {
    return (int64_t)(double)childVar(engine, index)
        .getDynamicObject()
        ->getProperty("origin");
  }

  bool childAwaitingStop(AudioEngine& engine, int index) {
    return (bool)childVar(engine, index)
        .getDynamicObject()
        ->getProperty("isAwaitingStop");
  }
};

static UiContractTests uiContractTests;
