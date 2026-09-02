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
#include <memory>
#include <set>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/graph_snapshot.h"
#include "../src/stack_node.h"

namespace celestrian {
namespace test_utils {

/**
 * The test-side twin of the engine callback's ProcessContext fill
 * (AudioEngine::audioDeviceIOCallbackWithContext): a node-level test
 * drives process()/control()/render() with a REAL whole-graph snapshot
 * and the island facts the engine hands down, so the node under test
 * runs the one audio-thread law — nothing in src/ tolerates a missing
 * snapshot. Keep refresh() in lockstep with the callback.
 *
 * `root` is the island root the engine would process: a StackNode, or
 * a lone ClipNode standing as its own island (Q 0, epoch 0, no take
 * lifecycle — the first-take path). The snapshot pins STRUCTURE:
 * rebuild() after addChild/removeChild. The island facts are re-read
 * at every engine block top, so refresh() before a block whenever they
 * may have moved (a commit established Q, setQuantum, a solo toggle).
 * Test-authored overrides on `ctx` (cycle_epoch, map facts, rings,
 * MIDI) go AFTER the last refresh()/rebuild(), which overwrite the
 * engine-owned fields.
 */
struct NodeContext {
  AudioNode* root = nullptr;
  const AudioNode* target = nullptr;  // the node ctx.self addresses
  std::unique_ptr<GraphSnapshot> snap;
  ProcessContext ctx;

  /** Entry index of `node` in the snapshot, -1 when it is not there. */
  int indexOf(const AudioNode& node) const {
    for (size_t i = 0; i < snap->entries.size(); ++i) {
      if (snap->entries[i].node == &node) return (int)i;
    }
    return -1;
  }

  /** Aim ctx.self at `node` — the entry its parent stack would hand it
   * — for a test that drives a nested node directly. */
  void driveFrom(const AudioNode& node) {
    target = &node;
    ctx.self = indexOf(node);
    jassert(ctx.self >= 0);
  }

  /** Re-read the island facts into ctx exactly as the callback does. */
  void refresh() {
    ctx.snap = snap.get();
    ctx.island = root;
    if (const auto* stack = dynamic_cast<const StackNode*>(root)) {
      const StackNode::IslandFacts facts = stack->readIslandFacts();
      ctx.quantum = facts.quantum;
      ctx.island_epoch = facts.epoch;
      ctx.island_generation = facts.generation;
      ctx.stop_generation = stack->stopGeneration();
    } else {
      ctx.quantum = 0;
      ctx.island_epoch = 0;
      ctx.island_generation = 0;
      ctx.stop_generation = 0;
    }
    ctx.cycle_epoch = ctx.island_epoch;
    ctx.any_solo = snapAnySolo(*snap);
    ctx.context_cycle =
        snapEffectiveCycle(*snap, ctx.quantum, (int64_t)ctx.sample_rate);
  }

  /** Rebuild the snapshot after a structural edit, keep aiming at the
   * same node, then refresh(). */
  void rebuild() {
    snap.reset(buildGraphSnapshot(*root));
    refresh();
    driveFrom(*target);
  }
};

/** A NodeContext for `root` at `master_pos` (island_pos alongside, as
 * the engine sets both from one transport read), `num_samples` wide,
 * aimed at the root itself. */
inline NodeContext contextFor(AudioNode& root, int num_samples = 0,
                              int64_t master_pos = 0) {
  NodeContext nc;
  nc.root = &root;
  nc.target = &root;
  nc.snap.reset(buildGraphSnapshot(root));
  nc.ctx.num_samples = num_samples;
  nc.ctx.master_pos = master_pos;
  nc.ctx.island_pos = master_pos;
  nc.refresh();
  nc.driveFrom(root);
  return nc;
}

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
