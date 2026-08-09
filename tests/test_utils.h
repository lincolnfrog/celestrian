/**
 * Shared test fixtures for the Celestrian test suite.
 *
 * Home of the helpers that used to be copy-pasted across the test
 * files: the silent block driver for the real device callback, the
 * graph-state accessors, the record-a-take flow, the synthetic
 * loopback harness for latency calibration, the shared-file locator
 * for golden vectors, and fresh temp-directory setup.
 */
#pragma once

#include <juce_core/juce_core.h>

#include <algorithm>
#include <functional>
#include <set>
#include <vector>

#include "../src/audio_engine.h"

namespace celestrian {
namespace test_utils {

/**
 * Drives `total_samples` of silent input through the engine's real
 * device callback path (mono input, stereo output) in blocks of
 * `block_size`.
 */
inline void driveEngine(AudioEngine& engine, int64_t total_samples,
                        int block_size = 512) {
  std::vector<float> input_buffer((size_t)block_size, 0.0f);
  std::vector<float> output_left((size_t)block_size, 0.0f);
  std::vector<float> output_right((size_t)block_size, 0.0f);
  float* inputs[] = {input_buffer.data()};
  float* outputs[] = {output_left.data(), output_right.data()};
  int64_t remaining = total_samples;
  while (remaining > 0) {
    const int count = (int)std::min<int64_t>(remaining, block_size);
    engine.audioDeviceIOCallbackWithContext(inputs, 1, outputs, 2, count, {});
    remaining -= count;
  }
}

/** The top-level "nodes" array of a getGraphState() var (may be null). */
inline juce::Array<juce::var>* nodesOf(const juce::var& state) {
  return state.getProperty("nodes", juce::var()).getArray();
}

// Committed ⟺ not recording and has a duration. (getMetadata publishes
// live_duration as "duration" while recording, so gate on isRecording.)
inline bool isClipCommitted(const AudioEngine& engine,
                            const juce::String& uuid) {
  const juce::var state = engine.getGraphState();
  if (auto* nodes = nodesOf(state))
    for (auto& node : *nodes)
      if (node.getProperty("id", "").toString() == uuid)
        return !(bool)node.getProperty("isRecording", false) &&
               (double)node.getProperty("duration", 0) > 0;
  return false;
}

/**
 * Creates a clip and records `length_samples` into it through the
 * caller's block driver `process`, returning its uuid. A non-first
 * clip pads forward to its next Q boundary before committing (up to
 * ~1Q away), so this pumps blocks until it actually commits rather
 * than a fixed count.
 */
inline juce::String recordClip(AudioEngine& engine,
                               const std::function<void(int)>& process,
                               int64_t length_samples) {
  std::set<juce::String> before;
  {
    const juce::var state = engine.getGraphState();
    if (auto* nodes = nodesOf(state))
      for (auto& node : *nodes)
        before.insert(node.getProperty("id", "").toString());
  }
  engine.createNode("clip");
  juce::String id;
  {
    const juce::var state = engine.getGraphState();
    if (auto* nodes = nodesOf(state))
      for (auto& node : *nodes) {
        auto node_id = node.getProperty("id", "").toString();
        if (!before.count(node_id)) id = node_id;
      }
  }
  engine.startRecordingInNode(id);
  process(100);
  process((int)length_samples);
  engine.stopRecordingInNode(id);
  for (int i = 0; i < 400 && !isClipCommitted(engine, id); ++i) process(512);
  return id;
}

/**
 * Locates a repo file by `relative_path` (e.g. "shared/timing_golden.json"),
 * searching upward from both the working directory and the executable
 * location so tests work from the repo root or the build tree.
 */
inline juce::File findSharedFile(const juce::String& relative_path) {
  auto searchUpFrom = [&relative_path](juce::File directory) -> juce::File {
    for (int i = 0; i < 8; ++i) {
      auto candidate = directory.getChildFile(relative_path);
      if (candidate.existsAsFile()) return candidate;
      auto parent = directory.getParentDirectory();
      if (parent == directory) break;
      directory = parent;
    }
    return {};
  };

  auto from_working_directory =
      searchUpFrom(juce::File::getCurrentWorkingDirectory());
  if (from_working_directory.existsAsFile()) return from_working_directory;

  return searchUpFrom(
      juce::File::getSpecialLocation(juce::File::currentExecutableFile)
          .getParentDirectory());
}

/** Reads a numeric var property as int64 (vars store numbers as double). */
inline int64_t asInt64(const juce::var& value,
                       const juce::Identifier& property) {
  return (int64_t)(double)value.getProperty(property, 0);
}

/**
 * Feeds engine output back to engine input through a delay of
 * `delay_samples`, until the latency-calibration capture completes or
 * `max_blocks` is reached.
 */
inline void runLoopback(AudioEngine& engine, int delay_samples, int block_size,
                        int max_blocks) {
  std::vector<float> history;  // all output samples, global timeline
  history.reserve((size_t)(max_blocks * block_size));

  std::vector<float> input_buffer((size_t)block_size, 0.0f);
  std::vector<float> output_left((size_t)block_size, 0.0f);
  std::vector<float> output_right((size_t)block_size, 0.0f);
  const float* inputs[] = {input_buffer.data()};
  float* outputs[] = {output_left.data(), output_right.data()};

  for (int block_index = 0; block_index < max_blocks; ++block_index) {
    // input[i] at global sample g = output emitted at g - delay_samples
    const int64_t block_start = (int64_t)block_index * block_size;
    for (int i = 0; i < block_size; ++i) {
      const int64_t source = block_start + i - delay_samples;
      input_buffer[(size_t)i] =
          (source >= 0 && source < (int64_t)history.size())
              ? history[(size_t)source]
              : 0.0f;
    }

    std::fill(output_left.begin(), output_left.end(), 0.0f);
    std::fill(output_right.begin(), output_right.end(), 0.0f);
    engine.audioDeviceIOCallbackWithContext(inputs, 1, outputs, 2, block_size,
                                            {});
    history.insert(history.end(), output_left.begin(), output_left.end());

    auto status = engine.getLatencyCalibration();
    if (status.getDynamicObject()->getProperty("phase").toString() !=
        "capturing")
      return;
  }
}

/** A fresh (emptied) "celestrian_test_<name>" directory under the temp dir. */
inline juce::File freshTempDir(const juce::String& name) {
  auto directory = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("celestrian_test_" + name);
  directory.deleteRecursively();
  directory.createDirectory();
  return directory;
}

// --- Graph-state accessors (single top-level stack of clips) ---

/** The uuid of the first top-level node. */
inline juce::String firstNodeId(const AudioEngine& engine) {
  return engine.getGraphState()
      .getDynamicObject()
      ->getProperty("nodes")
      .getArray()
      ->getReference(0)
      .getDynamicObject()
      ->getProperty("id");
}

/** The metadata var of child `index` inside the first top-level stack. */
inline juce::var childVar(const AudioEngine& engine, int index) {
  return engine.getGraphState()
      .getDynamicObject()
      ->getProperty("nodes")
      .getArray()
      ->getReference(0)
      .getDynamicObject()
      ->getProperty("nodes")
      .getArray()
      ->getReference(index);
}

inline juce::String childId(const AudioEngine& engine, int index) {
  return childVar(engine, index).getDynamicObject()->getProperty("id");
}

inline int64_t childDuration(const AudioEngine& engine, int index) {
  return (int64_t)(double)childVar(engine, index)
      .getDynamicObject()
      ->getProperty("duration");
}

inline bool childIsRecording(const AudioEngine& engine, int index) {
  return (bool)childVar(engine, index)
      .getDynamicObject()
      ->getProperty("isRecording");
}

}  // namespace test_utils
}  // namespace celestrian
