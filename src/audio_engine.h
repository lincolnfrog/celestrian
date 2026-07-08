#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include <functional>
#include <memory>
#include <mutex>
#include <vector>

#include "audio_node.h"
#include "clip_node.h"
#include "stack_node.h"

class AudioEngine : public juce::AudioIODeviceCallback,
                    public celestrian::GraphReclaimer {
 public:
  AudioEngine();
  ~AudioEngine() override;

  // Global Transport
  /**
   * Toggles global audio playback.
   */
  void togglePlayback();

  /**
   * Returns true if the transport is currently running.
   */
  bool isPlaying() const { return is_playing_global; }

  // Node Recording
  /**
   * Enables recording mode for a specific clip node.
   */
  void startRecordingInNode(const juce::String &uuid);

  /**
   * Disables recording mode for a specific clip node.
   */
  void stopRecordingInNode(const juce::String &uuid);

  // State API
  /**
   * Returns a JSON-compatible representation of the entire audio graph.
   */
  juce::var getGraphState() const;

  /**
   * Returns peak data for the specified node.
   */
  juce::var getWaveform(const juce::String &uuid, int num_peaks) const;

  // Stack Management
  /**
   * Toggles the expand/collapse state of a stack.
   */
  void toggleStackExpand(const juce::String &uuid);

  /**
   * Creates a new node of the specified type.
   * If parent_uuid is provided, adds to that stack; otherwise uses
   * focused_node. The node is appended to the end of the parent's children.
   * Visual positioning is handled by the frontend.
   */
  void createNode(const juce::String &type,
                  const juce::String &parent_uuid = "");

  /**
   * Populates a fresh engine with the default session graph: one stack
   * containing one empty clip ready for recording. Called by the app shell
   * on startup; tests construct a bare engine and build their own graph.
   */
  void createDefaultSession();

  /**
   * Opens the hardware audio device and registers this engine as its
   * callback. Called by the app shell on startup. Tests must NOT call this:
   * they drive audioDeviceIOCallbackWithContext manually, and a live device
   * callback running concurrently would corrupt their sample counts.
   */
  void initialiseAudioDevice();

  /**
   * Renames a specific node.
   */
  void renameNode(const juce::String &uuid, const juce::String &new_name);

  /**
   * Reorders a node within its parent stack or moves to a new parent at the
   * specified index. Frontend calculates the index from drag position; backend
   * simply inserts at that index.
   */
  void reorderNode(const juce::String &node_uuid,
                   const juce::String &new_parent_uuid, int new_index);

  /**
   * Updates a node's position (for freeform positioning of top-level stacks).
   */
  void setNodePosition(const juce::String &node_uuid, double x, double y);

  /**
   * Combines two sibling-level nodes into a new stack placed at the target's
   * position (target first, then dragged). Returns the new stack's UUID, or
   * an empty string on failure. Mirrors the mock backend's combineNodes.
   */
  juce::String combineNodes(const juce::String &dragged_uuid,
                            const juce::String &target_uuid);

  void toggleSolo(const juce::String &uuid);
  void togglePlay(const juce::String &uuid);
  void toggleMute(const juce::String &uuid);

  /**
   * Returns a list of available hardware audio inputs.
   */
  juce::var getInputList() const;

  /**
   * Sets the input channel index for a specific node.
   */
  void setNodeInput(const juce::String &uuid, int channel_index);

  /**
   * Sets the non-destructive loop points for a specific node.
   */
  void setLoopPoints(const juce::String &uuid, int64_t start, int64_t end);

  // AudioIODeviceCallback methods
  void audioDeviceIOCallbackWithContext(
      const float *const *input_channel_data, int num_input_channels,
      float *const *output_channel_data, int num_output_channels,
      int num_samples,
      const juce::AudioIODeviceCallbackContext &context) override;

  void audioDeviceAboutToStart(juce::AudioIODevice *device) override;
  void audioDeviceStopped() override;

  /**
   * GraphReclaimer: defers destruction of graph objects (child snapshots,
   * removed nodes) until the audio thread can no longer be reading them.
   * Message thread only.
   */
  void retire(std::function<void()> deleter) override;

 private:
  /**
   * Runs every pending deleter. Only call when no audio callback can be in
   * flight (device stopped, or after removeAudioCallback in the dtor).
   */
  void flushGraveyard();
  void init(int inputs, int outputs);
  celestrian::AudioNode *findNodeByUuid(celestrian::AudioNode *node,
                                        const juce::String &uuid);

  // LCM Timeline: Calculate the length at which the timeline wraps
  // Returns LCM of all clip durations in focused_node
  int64_t calculateTimelineLength() const;

  // Returns true if any clip in focused_node is actively recording
  bool isAnyNodeRecording() const;

  juce::AudioDeviceManager device_manager;

  // The root of the hierarchical audio graph
  std::unique_ptr<celestrian::AudioNode> root_node;

  // Navigation focus (no stack needed for single-level editing)
  celestrian::AudioNode *focused_node = nullptr;

  // Global Transport
  std::atomic<bool> is_playing_global{false};
  std::atomic<int64_t> global_transport_pos{0};

  // Track when recording just ended for LCM snap
  bool was_any_node_recording_ = false;
  // Track LCM before recording started - used to detect if LCM grew
  int64_t lcm_before_recording_ = 0;
  // Track the duration of the most recent recording for transport continuity
  int64_t last_recording_duration_ = 0;

  // Message-thread copy for the UI (getGraphState) …
  juce::String soloed_node_uuid;
  // … and the resolved pointer the audio thread actually uses. Cleared /
  // re-resolved on toggleSolo; nodes are never freed while a callback might
  // read them (see retire()).
  std::atomic<celestrian::AudioNode *> soloed_node_ptr_{nullptr};

  // Device latencies, cached in audioDeviceAboutToStart so the callback
  // never queries the device object per block.
  std::atomic<int> cached_input_latency_{0};
  std::atomic<int> cached_output_latency_{0};

  // Deferred destruction: retired items are freed once the callback counter
  // has advanced two callbacks past their retirement, guaranteeing no
  // in-flight callback still references them.
  struct RetiredItem {
    uint64_t epoch;
    std::function<void()> free;
  };
  std::atomic<uint64_t> callback_count_{0};
  std::mutex graveyard_mutex_;
  std::vector<RetiredItem> graveyard_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioEngine)
};
