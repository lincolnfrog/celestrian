/**
 * UI Contract Capture Harness (docs/session_view.md §7)
 *
 * The UI cannot be driven headless (native WKWebView + live audio
 * input), so this is the testable seam: drive a scripted record→commit
 * through the REAL engine, capture every getGraphState() "poll", and
 *   1. assert the published-state contract here (masterPos view
 *      semantics, the island zero staying, live duration growth), and
 *   2. dump the full poll sequence to shared/ui_contract_capture.json,
 *      which ui/js/tests/engine_replay.test.mjs replays through the
 *      actual deriveViewModel to assert DISPLAY invariants (frame
 *      stability, playhead continuity) against engine-real data.
 *
 * The scenario: the transport runs a while, then the first take
 * establishes Q; the second grows the cycle and is stopped just PAST a
 * boundary, so it runs on to the next one.
 *
 * Regenerate the fixture by running CelestrianTests (Debug binary).
 */

#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "test_utils.h"

using celestrian::test_utils::rootProp;
using celestrian::test_utils::childDuration;
using celestrian::test_utils::childId;
using celestrian::test_utils::childIsRecording;
using celestrian::test_utils::childVar;
using celestrian::test_utils::driveEngine;
using celestrian::test_utils::firstNodeId;

class UiContractTests : public juce::UnitTest {
 public:
  UiContractTests() : juce::UnitTest("UI Contract Capture", "Audio Engine") {}

  void runTest() override {
    beginTest("record->commit publishes a coherent display contract");

    const int Q = 1000;
    const int BLOCK = 100;  // fine-grained polls: one per block
    const int PRE_ROLL = 44100 + 370;  // one second and a bit, at 44.1 kHz

    AudioEngine engine;
    juce::Array<juce::var> capture;

    auto poll = [&](const char* tag) {
      auto state = engine.getGraphState();
      state.getDynamicObject()->setProperty("_tag", tag);
      capture.add(state);
    };

    // --- Take 1: establishes Q = 1000. The transport has already run
    //     for no whole number of seconds, so the pre-Q cursor (folded on
    //     one second) stands mid-second when the take is armed. ---
    engine.createNode("stack");
    auto stackId = firstNodeId(engine);
    engine.createNode("clip", stackId);
    auto clipA = childId(engine, 0);
    engine.togglePlayback();
    driveEngine(engine, PRE_ROLL);
    poll("pre-rec-1");

    engine.startRecordingInNode(clipA);
    for (int i = 0; i < Q / BLOCK; ++i) {
      driveEngine(engine, BLOCK);
      poll("rec-1");
      // Contract: before Q the view draws the cursor from masterPos, and
      // the first take's cursor is the take's own position.
      expectEquals((int64_t)masterPosD(engine), childDuration(engine, 0),
                   "the first take's cursor is the take's length");
    }
    engine.stopRecordingInNode(clipA);
    poll("commit-1");
    expectEquals(childDuration(engine, 0), (int64_t)Q,
                 "take 1 commits at 1Q and establishes the grid");

    // --- Loop a while (idle view must stay wrapped in [0, Q)) ---
    for (int i = 0; i < 7; ++i) {
      driveEngine(engine, BLOCK);
      poll("looping");
      double mp = masterPosD(engine);
      expect(mp >= 0 && mp < (double)Q, "idle masterPos wrapped into cycle");
    }

    // --- Take 2: arm mid-loop, record past TWO boundaries, stop just
    //     past a boundary ---
    engine.createNode("clip", stackId);
    auto clipB = childId(engine, 1);
    engine.startRecordingInNode(clipB);
    poll("armed-2");

    double lastView = masterPosD(engine);
    int64_t lastDur = 0;
    // 2Q of content + 100 samples past the next boundary
    const int recBlocks = (2 * Q + 100 + (Q - (int)lastView % Q)) / BLOCK;
    for (int i = 0; i < recBlocks; ++i) {
      driveEngine(engine, BLOCK);
      poll("rec-2");
      // Contract: the recording view grows monotonically, never wraps
      double mp = masterPosD(engine);
      expect(mp >= lastView, "recording masterPos is monotone (never wraps)");
      lastView = mp;
      int64_t dur = childDuration(engine, 1);
      expect(dur >= lastDur, "live duration is monotone");
      lastDur = dur;
    }

    const int64_t zeroBefore = rootProp(engine, "islandZero");
    engine.stopRecordingInNode(clipB);
    poll("stop-requested");
    // CONTRACT: the engine has NO downward snap — stopRecording always
    // awaits the NEXT boundary (nextStopBoundary), continuing to record
    // until it lands. The UI must treat isAwaitingStop as "finishing to
    // a known boundary".
    expect(childAwaitingStop(engine, 1),
           "a mid-Q stop request enters awaiting-stop");

    int guard = 0;
    while (childIsRecording(engine, 1) && guard++ < 40) {
      driveEngine(engine, BLOCK);
      poll("awaiting-stop");
    }
    expect(guard < 40, "awaiting-stop commits within a cycle");
    poll("committed");
    for (int i = 0; i < 8; ++i) {
      driveEngine(engine, BLOCK);
      poll("post-commit");
    }

    // Committed at the NEXT boundary above the stop request: 3Q
    expectEquals(childDuration(engine, 1), (int64_t)(3 * Q),
                 "stop pads forward to the next boundary (no snap-down)");
    // No commit moves the island zero (docs/frame.md): the JS replay
    // seats the new take from the lanes.
    const int64_t zeroAfter = rootProp(engine, "islandZero");
    expectEquals(zeroAfter, zeroBefore, "the zero stays through growth");

    // --- Dump the capture for the JS replay ---
    auto outFile = celestrian::test_utils::sharedCaptureFile(
        "ui_contract_capture.json");
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

  double masterPosD(AudioEngine& engine) {
    return (double)engine.getGraphState().getDynamicObject()->getProperty(
        "masterPos");
  }

  bool childAwaitingStop(AudioEngine& engine, int index) {
    return (bool)childVar(engine, index)
        .getDynamicObject()
        ->getProperty("isAwaitingStop");
  }
};

static UiContractTests uiContractTests;
