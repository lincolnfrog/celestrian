/**
 * Shared test fixtures for the Celestrian test suite — whatever more
 * than one test file needs (scenario_utils.h holds the ramp-driven
 * Island):
 *   - NodeContext, the node-level twin of the callback's context fill;
 *   - the silent block driver for the real device callback, the
 *     record-a-take flow, and EngineRig, a raw engine fed an input that
 *     encodes its own clock;
 *   - the published graph's accessors and graphFacts / firstDifference;
 *   - node-level fixtures: committed and loaded clips, one rendered block;
 *   - signals and measurements;
 *   - session bundles, WAV files, temp directories, the shared-file
 *     locator for golden vectors and captures;
 *   - the loopback harness for latency calibration, a device that is
 *     never opened.
 */
#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <functional>
#include <memory>
#include <set>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/graph_snapshot.h"
#include "../src/session_io.h"
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
 * a lone ClipNode standing as its own island (Q 0, zero at 0, no take
 * lifecycle — the first-take path). The snapshot pins STRUCTURE:
 * rebuild() after addChild/removeChild. The island facts are re-read
 * at every engine block top, so refresh() before a block whenever they
 * may have moved (a commit established Q, setQuantum, a solo toggle).
 * Test-authored overrides on `ctx` (frame_top, map facts, rings,
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
      ctx.island_zero = facts.zero;
      ctx.island_generation = facts.generation;
      ctx.stop_generation = stack->stopGeneration();
    } else {
      ctx.quantum = 0;
      ctx.island_zero = 0;
      ctx.island_generation = 0;
      ctx.stop_generation = 0;
    }
    ctx.frame_top = ctx.island_zero;
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

/**
 * The published graph without the facts that move on their own — the
 * transport position, the meters, the log's own flags — so two captures
 * are equal exactly when the session they describe is the same.
 */
inline juce::var graphFacts(const juce::var& state) {
  // On the root: the transport, the master meters, the log's flags.
  static const juce::StringArray transport{
      "isPlaying", "masterPos", "islandPos", "masterVuL",
      "masterVuR", "perf",      "canUndo",   "canRedo"};
  // On every node: its own meters.
  static const juce::StringArray meters{"playhead", "currentPeak"};
  const std::function<juce::var(const juce::var&)> copy =
      [&](const juce::var& value) -> juce::var {
    if (auto* object = value.getDynamicObject()) {
      juce::DynamicObject::Ptr out = new juce::DynamicObject();
      for (const auto& property : object->getProperties()) {
        if (meters.contains(property.name.toString())) continue;
        out->setProperty(property.name, copy(property.value));
      }
      return juce::var(out.get());
    }
    if (auto* array = value.getArray()) {
      juce::Array<juce::var> out;
      for (const auto& item : *array) out.add(copy(item));
      return out;
    }
    return value;
  };
  juce::var facts = copy(state);
  if (auto* root = facts.getDynamicObject()) {
    for (const auto& key : transport) root->removeProperty(key);
  }
  return facts;
}
inline juce::var graphFacts(AudioEngine& engine) {
  return graphFacts(engine.getGraphState());
}

/** Where two graphFacts captures first differ — "nodes[1].origin: 5 vs
 * 7" — or empty when they are the same. */
inline juce::String firstDifference(const juce::var& a, const juce::var& b,
                                    const juce::String& path = "graph") {
  auto* object_a = a.getDynamicObject();
  auto* object_b = b.getDynamicObject();
  if (object_a != nullptr && object_b != nullptr) {
    for (const auto& property : object_a->getProperties()) {
      const juce::String at = path + "." + property.name.toString();
      if (!object_b->hasProperty(property.name)) return at + ": gone";
      const juce::String inner = firstDifference(
          property.value, object_b->getProperty(property.name), at);
      if (inner.isNotEmpty()) return inner;
    }
    for (const auto& property : object_b->getProperties()) {
      if (!object_a->hasProperty(property.name))
        return path + "." + property.name.toString() + ": new";
    }
    return {};
  }
  auto* array_a = a.getArray();
  auto* array_b = b.getArray();
  if (array_a != nullptr && array_b != nullptr) {
    if (array_a->size() != array_b->size()) {
      return path + ": " + juce::String(array_a->size()) + " vs " +
             juce::String(array_b->size()) + " entries";
    }
    for (int i = 0; i < array_a->size(); ++i) {
      const juce::String inner = firstDifference(
          (*array_a)[i], (*array_b)[i], path + "[" + juce::String(i) + "]");
      if (inner.isNotEmpty()) return inner;
    }
    return {};
  }
  const juce::String text_a = juce::JSON::toString(a, true);
  const juce::String text_b = juce::JSON::toString(b, true);
  return text_a == text_b ? juce::String() : path + ": " + text_a + " vs " + text_b;
}

// Committed ⟺ not recording and has a duration. (getMetadata publishes
// live_duration as "duration" while recording, so gate on isRecording.)
inline bool isClipCommitted(AudioEngine& engine,
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

/** An AudioIODevice that is never opened: it reports a name and a
 * sample rate (stereo out, one input, 512-sample blocks), so a test can
 * walk the engine through a device start — audioDeviceAboutToStart —
 * without hardware. */
class FakeDevice : public juce::AudioIODevice {
 public:
  explicit FakeDevice(const juce::String& name, double sample_rate = 44100.0)
      : juce::AudioIODevice(name, "Test"), sample_rate_(sample_rate) {}

  juce::StringArray getOutputChannelNames() override { return {"L", "R"}; }
  juce::StringArray getInputChannelNames() override { return {"In"}; }
  juce::Array<double> getAvailableSampleRates() override {
    return {sample_rate_};
  }
  juce::Array<int> getAvailableBufferSizes() override { return {512}; }
  int getDefaultBufferSize() override { return 512; }
  juce::String open(const juce::BigInteger&, const juce::BigInteger&, double,
                    int) override {
    return {};
  }
  void close() override {}
  bool isOpen() override { return true; }
  void start(juce::AudioIODeviceCallback*) override {}
  void stop() override {}
  bool isPlaying() override { return false; }
  juce::String getLastError() override { return {}; }
  int getCurrentBufferSizeSamples() override { return 512; }
  double getCurrentSampleRate() override { return sample_rate_; }
  int getCurrentBitDepth() override { return 24; }
  juce::BigInteger getActiveOutputChannels() const override {
    juce::BigInteger channels;
    channels.setRange(0, 2, true);
    return channels;
  }
  juce::BigInteger getActiveInputChannels() const override {
    juce::BigInteger channels;
    channels.setBit(0);
    return channels;
  }
  int getOutputLatencyInSamples() override { return 0; }
  int getInputLatencyInSamples() override { return 0; }

 private:
  double sample_rate_;
};

/** A fresh (emptied) "celestrian_test_<name>" directory under the temp dir. */
inline juce::File freshTempDir(const juce::String& name) {
  auto directory = juce::File::getSpecialLocation(juce::File::tempDirectory)
                       .getChildFile("celestrian_test_" + name);
  directory.deleteRecursively();
  directory.createDirectory();
  return directory;
}

/** Writes a float WAV of `frames` frames at `rate`: every channel holds
 * the constant `level` (channel c at level + c/100, so a stereo file's
 * sides differ). */
inline juce::File writeWav(const juce::File& dir, const juce::String& name,
                           double rate, int channels, int frames,
                           float level = 0.5f) {
  const juce::File file = dir.getChildFile(name);
  file.deleteFile();
  juce::AudioBuffer<float> audio(channels, frames);
  for (int c = 0; c < channels; ++c) {
    for (int i = 0; i < frames; ++i) {
      audio.setSample(c, i, level + (float)c / 100.0f);
    }
  }
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::FileOutputStream> stream(file.createOutputStream());
  std::unique_ptr<juce::AudioFormatWriter> writer(
      fmt.createWriterFor(stream.get(), rate, (unsigned)channels, 32, {}, 0));
  stream.release();
  writer->writeFromAudioSampleBuffer(audio, 0, frames);
  writer.reset();
  return file;
}

// --- Graph-state accessors (single top-level stack of clips) ---

/** The uuid of the first top-level node. */
inline juce::String firstNodeId(AudioEngine& engine) {
  return engine.getGraphState()
      .getDynamicObject()
      ->getProperty("nodes")
      .getArray()
      ->getReference(0)
      .getDynamicObject()
      ->getProperty("id");
}

/** The metadata var of child `index` inside the first top-level stack. */
inline juce::var childVar(AudioEngine& engine, int index) {
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

inline juce::String childId(AudioEngine& engine, int index) {
  return childVar(engine, index).getDynamicObject()->getProperty("id");
}

inline int64_t childDuration(AudioEngine& engine, int index) {
  return (int64_t)(double)childVar(engine, index)
      .getDynamicObject()
      ->getProperty("duration");
}

inline bool childIsRecording(AudioEngine& engine, int index) {
  return (bool)childVar(engine, index)
      .getDynamicObject()
      ->getProperty("isRecording");
}

// ---- The published graph of a raw AudioEngine --------------------------
// (An Island answers the same questions through its own members.)

/** The node var with uuid `id` at or under `node`; void when absent. */
inline juce::var findVar(const juce::var& node, const juce::String& id) {
  if (node.getProperty("id", "").toString() == id) return node;
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray()) {
    for (const auto& kid : *kids) {
      juce::var hit = findVar(kid, id);
      if (!hit.isVoid()) return hit;
    }
  }
  return {};
}

/** A numeric fact of node `id`, wherever it sits; 0 when absent. */
inline double deepProp(AudioEngine& engine, const juce::String& id,
                       const char* key) {
  const juce::var node = findVar(engine.getGraphState(), id);
  return node.isVoid() ? 0.0 : (double)node.getProperty(key, 0.0);
}

/** A boolean fact of node `id`; false when absent. */
inline bool deepBool(AudioEngine& engine, const juce::String& id,
                     const char* key) {
  const juce::var node = findVar(engine.getGraphState(), id);
  return !node.isVoid() && (bool)node.getProperty(key, false);
}

/** A numeric fact of the root record (quantum, islandZero, masterPos). */
inline int64_t rootProp(AudioEngine& engine, const char* key) {
  return (int64_t)(double)engine.getGraphState().getProperty(key, 0);
}

/** Every clip id at or under `node`, in tree order. */
inline void clipIdsUnder(const juce::var& node, juce::StringArray& out) {
  if (node.getProperty("type", "").toString() == "clip") {
    out.add(node.getProperty("id", "").toString());
    return;
  }
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray()) {
    for (const auto& kid : *kids) clipIdsUnder(kid, out);
  }
}

/** The uuid of the last top-level node ("" on an empty island): the node
 * a createNode with no parent just made. */
inline juce::String lastTopLevelId(AudioEngine& engine) {
  const juce::var state = engine.getGraphState();
  auto* nodes = nodesOf(state);
  if (nodes == nullptr || nodes->isEmpty()) return {};
  return nodes->getLast().getProperty("id", "").toString();
}

/** a mod m, in [0, m). */
inline int64_t mod(int64_t a, int64_t m) { return ((a % m) + m) % m; }

// ---- Node-level fixtures (no engine) ------------------------------------

/** Ask `clip`'s live take to stop and run the block top that takes the
 * request up — ClipNode::control over a block of no samples, under the
 * context `ctx` the take's blocks ran in — as the next audio block's top
 * would. An island's first take is committed when this returns; a take
 * with a boundary to reach has it chosen, and captures on in the blocks
 * that follow. */
inline void stopAtBlockTop(ClipNode& clip, const ProcessContext& ctx) {
  clip.stopRecording();
  ProcessContext top = ctx;
  top.num_samples = 0;
  clip.control(nullptr, 0, top);
}

/** A committed mono clip of `len` samples, already playing, whose
 * content is fill(i): one take recorded through the node's own
 * first-take path, the clip standing as its own island (no Q, zero 0). */
inline std::unique_ptr<ClipNode> committedClip(
    const char* name, double sample_rate, int64_t len,
    const std::function<float(int64_t)>& fill) {
  auto clip = std::make_unique<ClipNode>(name, sample_rate);
  std::vector<float> in((size_t)len);
  for (int64_t i = 0; i < len; ++i) in[(size_t)i] = fill(i);
  float* const ins[] = {in.data()};
  NodeContext rec = contextFor(*clip, (int)len);
  clip->startRecording();
  clip->process(ins, nullptr, 1, 0, rec.ctx);
  stopAtBlockTop(*clip, rec.ctx);
  return clip;
}

/** The same clip holding the constant `level`. */
inline std::unique_ptr<ClipNode> committedClip(const char* name,
                                               double sample_rate, int64_t len,
                                               float level) {
  return committedClip(name, sample_rate, len,
                       [level](int64_t) { return level; });
}

/** One stereo block of output. */
struct StereoBlock {
  std::vector<float> left, right;

  /** The peak absolute sample over both channels. */
  float peak() const {
    float peak = 0.0f;
    for (float v : left) peak = std::max(peak, std::abs(v));
    for (float v : right) peak = std::max(peak, std::abs(v));
    return peak;
  }
};

/** Which passes of a block renderBlock runs. */
enum class BlockPass {
  ControlThenRender,  // process(): the callback's order
  RenderOnly,         // the const render() alone: no control pass first
};

/** One block of `node`, standing as its island root, at `master_pos`
 * with the transport playing. */
inline StereoBlock renderBlock(AudioNode& node, int num_samples,
                               int64_t master_pos = 0,
                               BlockPass pass = BlockPass::ControlThenRender) {
  StereoBlock out{std::vector<float>((size_t)num_samples, 0.0f),
                  std::vector<float>((size_t)num_samples, 0.0f)};
  float* outs[] = {out.left.data(), out.right.data()};
  NodeContext nc = contextFor(node, num_samples, master_pos);
  nc.ctx.is_playing = true;
  if (pass == BlockPass::RenderOnly) {
    static_cast<const AudioNode&>(node).render(outs, 2, nc.ctx);
  } else {
    node.process(nullptr, outs, 0, 2, nc.ctx);
  }
  return out;
}

/** The SETTLED block at `master_pos`: mute and solo edges fade over
 * ~10 ms (sequencer.md §9), so the block that carries a toggle is a
 * ramp. Renders the block twice and answers the second pass. */
inline StereoBlock renderSettled(AudioNode& node, int num_samples,
                                 int64_t master_pos = 0) {
  renderBlock(node, num_samples, master_pos);
  return renderBlock(node, num_samples, master_pos);
}

// ---- Signals and measurements -------------------------------------------

/** `length` samples of a sine at `frequency` Hz, from phase 0. */
inline std::vector<float> makeSine(double frequency, double sample_rate,
                                   int length, float amplitude = 1.0f) {
  std::vector<float> samples((size_t)length);
  for (int i = 0; i < length; ++i) {
    samples[(size_t)i] =
        amplitude * (float)std::sin(2.0 * juce::MathConstants<double>::pi *
                                    frequency * (double)i / sample_rate);
  }
  return samples;
}

/** The peak absolute sample of samples[from, to), the range clamped to
 * the vector; the whole vector when no range is given. */
inline float peakOf(const std::vector<float>& samples, size_t from = 0,
                    size_t to = (size_t)-1) {
  float peak = 0.0f;
  for (size_t i = from; i < to && i < samples.size(); ++i) {
    peak = std::max(peak, std::abs(samples[i]));
  }
  return peak;
}

/** Sleeps until `service` (a PluginHostService: its scan runs on its
 * own thread) is no longer scanning, `max_ms` at most; answers whether
 * the scan ended. */
template <typename Service>
bool waitForScan(Service& service, int max_ms) {
  const int step_ms = 10;
  for (int waited = 0; waited < max_ms && service.isScanning();
       waited += step_ms) {
    juce::Thread::sleep(step_ms);
  }
  return !service.isScanning();
}

// ---- Session bundles and files ------------------------------------------

/** One committed take of `length` samples of silence on a new top-level
 * clip, through the real device callback: something for a project to
 * hold. Answers the clip's uuid. (recordClip with driveEngine as its
 * block driver.) */
inline juce::String recordSilentTake(AudioEngine& engine, int64_t length) {
  return recordClip(
      engine, [&engine](int total) { driveEngine(engine, total); }, length);
}

/** A clip as a session load builds it, not yet in a graph: a committed
 * mono take of `length` samples at `origin` whose sample i is fill(i)
 * (ClipNode::loadCommitted; no recording pass). */
inline std::unique_ptr<ClipNode> loadedClip(
    const char* name, double sample_rate, int64_t origin, int64_t length,
    const std::function<float(int64_t)>& fill, int64_t context_cycle = 0) {
  auto clip = std::make_unique<ClipNode>(name, sample_rate);
  clip->origin_samples.store(origin);
  clip->duration_samples.store(length);
  juce::AudioBuffer<float> audio(1, (int)length);
  for (int64_t i = 0; i < length; ++i) audio.setSample(0, (int)i, fill(i));
  clip->loadCommitted(audio, context_cycle);
  return clip;
}

/** The same clip holding the constant `level`. */
inline std::unique_ptr<ClipNode> loadedClip(const char* name,
                                            double sample_rate, int64_t origin,
                                            int64_t length, float level,
                                            int64_t context_cycle = 0) {
  return loadedClip(
      name, sample_rate, origin, length, [level](int64_t) { return level; },
      context_cycle);
}

/** A bundle on disk and what it loads back as. */
struct RoundTrip {
  juce::File dir;
  session_io::LoadedSession loaded;
};

/** `root` saved at `sample_rate` to the fresh bundle freshTempDir(name)
 * and loaded back from it. The bundle stays in `dir`; `saved` (when
 * given) takes the save's own answer. */
inline RoundTrip roundTrip(const StackNode& root, double sample_rate,
                           const juce::String& name,
                           const session_io::SaveOptions& options = {},
                           bool* saved = nullptr) {
  RoundTrip trip{freshTempDir(name), {}};
  const bool save_ok = session_io::save(root, sample_rate, trip.dir, options);
  if (saved != nullptr) *saved = save_ok;
  trip.loaded = session_io::load(trip.dir, sample_rate);
  return trip;
}

/** The WAV at `file`, every channel and sample (its rate into `rate_out`
 * when asked); an empty buffer when it cannot be read. */
inline juce::AudioBuffer<float> readWav(const juce::File& file,
                                        double* rate_out = nullptr) {
  auto stream = file.createInputStream();
  if (stream == nullptr) return {};
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::AudioFormatReader> reader(
      fmt.createReaderFor(stream.release(), true));
  if (reader == nullptr) return {};
  if (rate_out != nullptr) *rate_out = reader->sampleRate;
  juce::AudioBuffer<float> audio((int)reader->numChannels,
                                 (int)reader->lengthInSamples);
  reader->read(&audio, 0, (int)reader->lengthInSamples, 0, true, true);
  return audio;
}

/** Where a capture the JS tests replay is written: `name` in the repo's
 * shared/ folder, beside the golden vectors (a capture is git-ignored,
 * so it may not exist yet; the golden file always does). */
inline juce::File sharedCaptureFile(const juce::String& name) {
  return findSharedFile("shared/timing_golden.json").getSiblingFile(name);
}

/** What a bundle written before `keys` existed loads as: the bundle at
 * `dir`, loaded with those keys taken out of the record of top-level
 * node `node_index`. session.json is put back as it was, so each call
 * strips from the bundle as saved. `had_keys` (when given) says whether
 * every key was there to take out. */
inline session_io::LoadedSession reloadWithoutKeys(
    const juce::File& dir, int node_index, const juce::StringArray& keys,
    double sample_rate, bool* had_keys = nullptr) {
  const juce::File json_file = dir.getChildFile("session.json");
  const juce::String saved_text = json_file.loadFileAsString();
  const juce::var bundle = juce::JSON::parse(saved_text);
  bool all_present = false;
  const juce::var nodes =
      bundle.getProperty("root", {}).getProperty("nodes", {});
  if (auto* records = nodes.getArray();
      records != nullptr && node_index < records->size()) {
    if (auto* record = (*records)[node_index].getDynamicObject()) {
      all_present = true;
      for (const auto& key : keys) {
        all_present = all_present && record->hasProperty(juce::Identifier(key));
        record->removeProperty(juce::Identifier(key));
      }
    }
  }
  if (had_keys != nullptr) *had_keys = all_present;
  json_file.replaceWithText(juce::JSON::toString(bundle, true));
  session_io::LoadedSession loaded = session_io::load(dir, sample_rate);
  json_file.replaceWithText(saved_text);
  return loaded;
}

// ---- A raw AudioEngine: its nodes, and the rig that drives it -----------

/** The clip with uuid `id`; null when it is absent or not a clip. */
inline ClipNode* clipOf(AudioEngine& engine, const juce::String& id) {
  return dynamic_cast<ClipNode*>(engine.findNodeByUuidForTest(id));
}

/** A numeric fact of node `id` that tells 0 from absent: -1 when the
 * node, or the key, is not published. */
inline double presentProp(AudioEngine& engine, const juce::String& id,
                          const char* key) {
  return (double)findVar(engine.getGraphState(), id).getProperty(key, -1.0);
}

/** The island root's uuid. */
inline juce::String rootId(AudioEngine& engine) {
  return engine.getGraphState().getProperty("id", "").toString();
}

/** A new empty `type` node ("clip" or "stack") under `parent` ("" = the
 * top level); answers its uuid. */
inline juce::String addNode(AudioEngine& engine, const char* type,
                            const juce::String& parent = {}) {
  juce::String id;
  engine.createNode(type, parent, &id);
  return id;
}

/** What an EngineRig feeds the device's one input. */
enum class RigInput { Ramp, Silence };

/** A raw AudioEngine behind its device callback, fed an input that
 * encodes its own clock, both output sides kept: the fixture of the
 * takes, bounce, monitor, import, take-undo and take-capacity suites.
 * (An Island is the analytic twin: one side, its clock the transport's.)
 * The engine is on the heap: by value it is ~130 KB of the runTest frame
 * that holds it. */
struct EngineRig {
  static constexpr int BLOCK = 512;
  static constexpr int64_t RAMP_P = int64_t{1} << 22;  // longer than any take

  /** The ramp input at clock `t`: every sample says when it arrived. It
   * steps 1.9e-7 a sample, so a comparison within 1e-7 is sample-exact. */
  static float rampAt(int64_t t) {
    return 0.1f + 0.8f * (float)((double)(t % RAMP_P) / (double)RAMP_P);
  }

  /** What a run sounded like: sample i of each side was heard at clock
   * `start + i`. */
  struct Heard {
    int64_t start = 0;
    std::vector<float> left, right;
  };

  std::unique_ptr<AudioEngine> owner = std::make_unique<AudioEngine>();
  AudioEngine& engine = *owner;
  /** The clock the next input sample encodes: the samples driven so far,
   * until syncClock() puts it on the transport. */
  int64_t clock = 0;

  /** Drives `total` samples through the device callback, appending what
   * sounded to `heard` when given. */
  void drive(int64_t total, Heard* heard = nullptr,
             RigInput input = RigInput::Ramp) {
    std::vector<float> in((size_t)BLOCK), l((size_t)BLOCK), r((size_t)BLOCK);
    float* ins[] = {in.data()};
    float* outs[] = {l.data(), r.data()};
    if (heard != nullptr && heard->left.empty()) heard->start = clock;
    for (int64_t remaining = total; remaining > 0;) {
      const int n = (int)std::min<int64_t>(remaining, BLOCK);
      for (int i = 0; i < n; ++i) {
        in[(size_t)i] = input == RigInput::Ramp ? rampAt(clock + i) : 0.0f;
      }
      engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
      if (heard != nullptr) {
        heard->left.insert(heard->left.end(), l.begin(), l.begin() + n);
        heard->right.insert(heard->right.end(), r.begin(), r.begin() + n);
      }
      clock += n;
      remaining -= n;
    }
  }

  /** drive(), answering what sounded. */
  Heard hear(int64_t total, RigInput input = RigInput::Ramp) {
    Heard heard;
    drive(total, &heard, input);
    return heard;
  }

  /** Puts the clock on the engine's transport: from here a take's capture
   * clock and the engine's own positions are one timeline. */
  void syncClock() { clock = engine.transportClock(); }

  /** Drives blocks until no take is armed, capturing or finishing, then
   * polls (the poll settles the take into the undo log). */
  void settle(Heard* heard = nullptr) {
    for (int i = 0; i < 4000 && engine.hasActiveTake(); ++i) {
      drive(BLOCK, heard);
    }
    engine.getGraphState();
  }

  /** Drives blocks until a clip at or under `target` is capturing;
   * answers whether one is. */
  bool driveUntilCapturing(const juce::String& target) {
    juce::StringArray clips;
    clipIdsUnder(findVar(engine.getGraphState(), target), clips);
    const auto capturing = [&] {
      for (const auto& id : clips) {
        const ClipNode* clip = clipOf(engine, id);
        if (clip != nullptr && clip->isRecording()) return true;
      }
      return false;
    };
    for (int i = 0; i < 4000 && !capturing(); ++i) drive(BLOCK);
    return capturing();
  }

  /** One ramp take of `len` samples on `target`: an empty clip, or a group
   * of them. The island's first take captures from the next block and
   * commits where it is stopped; a later one starts on the next Q line
   * and, stopped a block short, runs on to the line `len` names (whole
   * Qs). Returns with the take settled and the clock on the transport. */
  void record(const juce::String& target, int64_t len) {
    const bool first = rootProp(engine, "quantum") <= 0;
    engine.startRecordingInNode(target);
    if (!first) driveUntilCapturing(target);
    drive(first ? len : len - BLOCK);
    engine.stopRecordingInNode(target);
    drive(BLOCK);
    settle();
    syncClock();
  }

  /** record() on a new top-level clip; answers its uuid. */
  juce::String recordClip(int64_t len) {
    const juce::String id = addNode(engine, "clip");
    record(id, len);
    return id;
  }
};

}  // namespace test_utils
}  // namespace celestrian
