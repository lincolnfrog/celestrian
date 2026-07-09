#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <atomic>

namespace celestrian {

class AudioNode;

/**
 * Context for audio processing, passed down the recursive graph.
 * POD-only: this struct is copied per stack per block on the audio thread,
 * so it must never carry heap-owning members (e.g. juce::String).
 */
struct ProcessContext {
  // Default is a test-only fallback; the engine always overwrites this
  // with the actual device rate (cached in audioDeviceAboutToStart).
  double sample_rate = 44100.0;
  int num_samples = 0;
  bool is_playing = false;
  bool is_recording = false;

  // Global transport master position (in samples)
  int64_t master_pos = 0;

  // Latency compensation (in samples)
  int input_latency = 0;
  int output_latency = 0;

  // Solo state: resolved once by the engine on the message thread.
  // Null when nothing is soloed. Nodes compare pointers (never strings)
  // and walk their ancestor chain to honor soloed containers.
  const AudioNode *solo_node = nullptr;

  // --- Pre-record ring (docs/performance.md §3) ---
  // The engine continuously copies device input into a ring indexed by a
  // monotonic input clock (total input samples since engine start — unlike
  // master_pos it never wraps or resets). Recording clips read their
  // capture window from this ring instead of the live block, so a clip
  // position can map to any recent arrival time — including times earlier
  // in the current block or slightly in the past.
  // Null when no backend ring exists (unit tests driving nodes directly);
  // clips then fall back to live block capture.
  const float *const *prerecord_ring = nullptr;
  int prerecord_ring_len = 0;       // samples per channel
  int prerecord_ring_channels = 0;  // valid channels in the ring
  int64_t input_clock = 0;          // arrival index of this block's sample 0
};

/**
 * Enumeration of available node types in the Celestrian ecosystem.
 */
enum class NodeType { Clip, Stack, Unknown };

/**
 * Interface for all audio-producing or processing nodes in the Celestrian
 * graph.
 */
class AudioNode {
 public:
  AudioNode(juce::String node_name)
      : node_name(std::move(node_name)), node_uuid(juce::Uuid().toString()) {}
  virtual ~AudioNode() = default;

  /**
   * Processes audio into the provided output channels or captures from input.
   * @param input_channels Pointer to input samples.
   * @param output_channels Pointer to output samples to be filled.
   * @param num_input_channels Number of available hardware input channels.
   * @param num_output_channels Number of hardware output channels.
   * @param context Current processing context (sample rate, transport, etc.).
   */
  virtual void process(const float *const *input_channels,
                       float *const *output_channels, int num_input_channels,
                       int num_output_channels,
                       const ProcessContext &context) = 0;

  /**
   * Generates waveform peaks for visualization.
   * @param num_peaks The number of peak samples to return.
   */
  virtual juce::var getWaveform(int num_peaks) const = 0;

  /**
   * Returns a JSON object containing node metadata for UI rendering.
   */
  virtual juce::var getMetadata() const {
    auto *obj = new juce::DynamicObject();
    obj->setProperty("id", node_uuid);
    obj->setProperty("name", node_name);
    obj->setProperty("type", getNodeTypeString());
    obj->setProperty("x", (double)x_pos.load());
    obj->setProperty("y", (double)y_pos.load());
    obj->setProperty("w", (double)width.load());
    obj->setProperty("h", (double)height.load());
    obj->setProperty("currentPeak", (float)last_block_peak.load());
    if (isRecording())
      obj->setProperty("duration", (double)live_duration_samples.load());
    else
      obj->setProperty("duration", (double)duration_samples.load());
    obj->setProperty("loopStart", (double)loop_start_samples.load());
    obj->setProperty("loopEnd", (double)loop_end_samples.load());
    obj->setProperty("effectiveQuantum", (double)getEffectiveQuantum());
    obj->setProperty("playhead", (double)playhead_pos.load());
    obj->setProperty("isRecording", (bool)isRecording());
    obj->setProperty("isMuted", (bool)is_muted.load());
    obj->setProperty("anchorPhase", (double)anchor_phase_samples.load());
    obj->setProperty("launchPoint", (double)launch_point_samples.load());
    obj->setProperty("origin", (double)origin_samples.load());
    return juce::var(obj);
  }

  void setName(const juce::String &new_name) { node_name = new_name; }
  juce::String getName() const { return node_name; }
  juce::String getUuid() const { return node_uuid; }

  virtual NodeType getNodeType() const = 0;

  virtual juce::String getNodeTypeString() const {
    switch (getNodeType()) {
      case NodeType::Clip:
        return "clip";
      case NodeType::Stack:
        return "stack";
      default:
        return "unknown";
    }
  }

  virtual bool isRecording() const { return is_node_recording.load(); }

  /**
   * Returns the latest peak sample level for real-time visualization.
   */
  virtual float getCurrentPeak() const = 0;

  // Hierarchy
  void setParent(AudioNode *p) { parent.store(p); }
  AudioNode *getParent() const { return parent.load(); }

  void setLoopPoints(int64_t start, int64_t end) {
    loop_start_samples.store(start);
    loop_end_samples.store(end);
  }

  int64_t getLoopStart() const { return loop_start_samples.load(); }
  int64_t getLoopEnd() const { return loop_end_samples.load(); }

  // Quantum Logic
  virtual int64_t getIntrinsicDuration() const = 0;
  virtual int64_t getEffectiveQuantum() const {
    if (auto *p = parent.load()) return p->getEffectiveQuantum();
    return 0;
  }

  /**
   * The island's cycle epoch: the master-clock moment of the visual cycle
   * top. ALL cycle-relative projections (anchors, slots, effective
   * positions) must be computed relative to this — mixing epoch-relative
   * views with absolute-frame math re-splits audio from visuals.
   */
  virtual int64_t getIslandEpoch() const {
    if (auto *p = parent.load()) return p->getIslandEpoch();
    return 0;
  }

  // Spatial arrangement in the parent stack/plane
  std::atomic<double> x_pos{0.0}, y_pos{0.0};
  std::atomic<double> width{200.0}, height{100.0};

  // Transport state
  std::atomic<double> playhead_pos{0.0};          // 0.0 to 1.0 (normalized)
  std::atomic<int64_t> duration_samples{0};       // Length of the loop
  std::atomic<int64_t> live_duration_samples{0};  // Live count during recording
  std::atomic<int64_t> loop_start_samples{0};
  std::atomic<int64_t> loop_end_samples{0};
  std::atomic<bool> is_node_recording{false};
  std::atomic<bool> is_muted{false};
  std::atomic<bool> is_expanded{
      true};  // UI state: expanded (true) or collapsed (false)
  std::atomic<float> last_block_peak{0.0f};

  // Phase-aligned recording: where in the quantum grid this clip was recorded
  std::atomic<int64_t> anchor_phase_samples{0};
  // Launch point: DERIVED from origin at commit ((−origin) mod duration),
  // kept as a stored field only for UI/metadata compatibility.
  std::atomic<int64_t> launch_point_samples{0};
  // THE canonical timing fact (docs/kernel.md): the cycle moment this
  // node's content[0] belongs to, in performance-time samples. Set once
  // when recording starts. Launch point, anchor, and visual x are all
  // projections of this value.
  std::atomic<int64_t> origin_samples{0};

  // Atomic because the audio thread walks parent chains (quantum lookup,
  // solo ancestry) while the message thread reparents nodes during
  // reorder/combine operations.
  std::atomic<AudioNode *> parent{nullptr};

 protected:
  juce::String node_name;
  juce::String node_uuid;
};

}  // namespace celestrian
