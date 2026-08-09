#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include <functional>
#include <memory>
#include <mutex>
#include <vector>

#include "audio_node.h"
#include "clip_node.h"
#include "edit.h"
#include "graph_snapshot.h"
#include "session_io.h"
#include "stack_node.h"

/**
 * The engine: device callback, transport, graph ownership, edit log,
 * and the object-lifetime reclaimer — the seam between the two threads
 * that matter here.
 *
 * THREADING MODEL (docs/performance.md): every public method is MESSAGE
 * THREAD only unless its comment says otherwise; the AUDIO thread runs
 * exactly one entry point (audioDeviceIOCallbackWithContext), takes no
 * locks, and never allocates. The two sides share state three ways:
 *   - per-node atomics for continuous facts (durations, origins, mixer
 *     knobs, effect params);
 *   - the whole-graph snapshot for STRUCTURE — rebuilt on the message
 *     thread after every structural edit (publishGraph), loaded once
 *     per callback;
 *   - the reclaimer (retire) for lifetime: anything the audio thread
 *     might still be reading is freed only after the callback counter
 *     has advanced two callbacks past its retirement.
 *
 * TESTS drive the callback manually and must never open a real device
 * (see initialiseAudioDevice) — that discipline is what makes the whole
 * engine deterministic under test.
 */
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
  void startRecordingInNode(const juce::String& uuid);

  /**
   * Disables recording mode for a specific clip node.
   */
  void stopRecordingInNode(const juce::String& uuid);

  // State API
  /**
   * Returns a JSON-compatible representation of the entire audio graph.
   */
  juce::var getGraphState() const;

  /**
   * Returns peak data for the specified node.
   */
  juce::var getWaveform(const juce::String& uuid, int num_peaks) const;

  // Stack Management
  /**
   * Toggles the expand/collapse state of a stack.
   */
  void toggleStackExpand(const juce::String& uuid);

  /**
   * Creates a new node of the specified type.
   * If parent_uuid is provided, adds to that stack; otherwise uses
   * focused_node. The node is appended to the end of the parent's children.
   * Visual positioning is handled by the frontend.
   */
  void createNode(const juce::String& type,
                  const juce::String& parent_uuid = "");

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
  void renameNode(const juce::String& uuid, const juce::String& new_name);

  /**
   * Reorders a node within its parent stack or moves to a new parent at the
   * specified index. Frontend calculates the index from drag position; backend
   * simply inserts at that index.
   */
  void reorderNode(const juce::String& node_uuid,
                   const juce::String& new_parent_uuid, int new_index);

  /**
   * Updates a node's position (for freeform positioning of top-level stacks).
   */
  void setNodePosition(const juce::String& node_uuid, double x, double y);

  /**
   * Combines two sibling-level nodes into a new stack placed at the target's
   * position (target first, then dragged). Returns the new stack's UUID, or
   * an empty string on failure. Mirrors the mock backend's combineNodes.
   */
  juce::String combineNodes(const juce::String& dragged_uuid,
                            const juce::String& target_uuid);

  void toggleSolo(const juce::String& uuid);
  void togglePlay(const juce::String& uuid);
  void toggleMute(const juce::String& uuid);

  /**
   * Deletes a node (and its subtree) — the user-facing verb the undo
   * system exists to protect (a mis-click deleting a take is otherwise
   * fatal, unification_audit.md §2.2). A no-op on the root or on a node
   * that is armed/recording (cancel is that verb). Undoable.
   */
  void deleteNode(const juce::String& uuid);

  // --- Undo / redo (edits-as-events, Step 1). Message thread only.
  // The undo stack holds inverse edits; redo holds forwards. Structural
  // inverses OWN the detached subtree (safe: no-overdub ⇒ write-once
  // buffers). See src/edit.h.
  void undo();
  void redo();
  bool canUndo() const { return !undo_.empty(); }
  bool canRedo() const { return !redo_.empty(); }

  /** TEST-ONLY: the currently published whole-graph snapshot (pins the
   * publish discipline in graph_snapshot_tests). */
  const celestrian::GraphSnapshot* currentGraphSnapshotForTest() const {
    return graph_snapshot_.load();
  }

  // --- Save / Load (edits-as-events, Step 2). Message thread only.
  // A session is a bundle directory (session.json + audio/*.wav);
  // device-independent, QTime-based (src/session_io.h). Load swaps the
  // root's contents in place through the existing safe child-snapshot
  // path — the root node's identity never changes, so the audio thread
  // sees no pointer race.
  bool saveSession(const juce::String& path);
  bool loadSession(const juce::String& path);
  /** Project-model save (docs/projects.md): options carry display name
   * / template-strip / incremental-mirror. Message thread. */
  bool saveSessionTo(const juce::File& dir,
                     const celestrian::session_io::SaveOptions& opts) {
    return celestrian::session_io::save(*root_node, cached_sample_rate_.load(),
                                        dir, opts);
  }
  bool hasActiveTake() const { return root_node->hasActiveTake(); }
  /** D4 compaction: shrink idle committed takes to their recorded
   * material (atomic content swap + reclaimer retire). Message thread;
   * driven by the app heartbeat (ProjectManager::tick) and tests. */
  void compactIdleTakes();
  /** Number of COMMITTED clips in the island (ClipNode, duration>0),
   * recursive. Drives provisional-Q mutability (Q13 non-sticky) and the
   * project-birth trigger (ProjectManager). Message thread. */
  int islandCommittedClipCount() const;

  /**
   * Toggles a stack's loop window between active and bypassed
   * (time_maps.md). Activation is data, not view state: expansion no
   * longer affects whether the window applies.
   */
  void toggleLoopWindow(const juce::String& uuid);

  /**
   * Returns a list of available hardware audio inputs.
   */
  juce::var getInputList() const;

  /**
   * Sets the input channel index for a specific node (left / mono).
   */
  void setNodeInput(const juce::String& uuid, int channel_index);

  /**
   * Sets the RIGHT input of a stereo pair (−1 reverts the clip to
   * mono). The channel count of a take is fixed at arm.
   */
  void setNodeInputRight(const juce::String& uuid, int channel_index);

  /**
   * Sets a node's stereo pan/balance, −1 (hard left) .. +1 (hard
   * right). Non-undoable (mixer knob — the effect-param ruling).
   */
  void setNodePan(const juce::String& uuid, double pan);

  /**
   * Sets a node's volume fader, 0 (silent) .. 1 (unity — the default;
   * attenuate-only per the pan no-boost law). Applied at the node's
   * output stage after fx. Non-undoable (mixer knob).
   */
  void setNodeGain(const juce::String& uuid, double gain);

  /**
   * The period-source knob (Q5): from_context = true makes the clip a
   * ONE-SHOT (period := context cycle — sounds once per scope cycle at
   * its origin, then rests); false restores the loop (period := own
   * length). Clips only; undoable (a musical fact).
   */
  void setPeriodSource(const juce::String& uuid, bool from_context);

  // Built-in effects (dsp/effects.h): enable/param edits from the UI.
  // Message thread; prepare() runs before the enable flag flips so the
  // audio thread never sees an unprepared effect.
  void setEffectEnabled(const juce::String& uuid, const juce::String& fx,
                        bool enabled);
  void setEffectParam(const juce::String& uuid, const juce::String& fx,
                      const juce::String& key, double value);
  /** Panel open/closed: gates ALL scope capture + telemetry for a node. */
  void setEffectScope(const juce::String& uuid, bool active);

  /**
   * Sets the non-destructive loop points for a specific node.
   */
  void setLoopPoints(const juce::String& uuid, int64_t start, int64_t end);

  /**
   * Installs a multi-segment time-map on a node (time_maps.md phase 3).
   * Validates well-formedness only (the editor owns coherence);
   * n ≤ 1 delegates to setLoopPoints (the single-window path, which
   * owns Q13); undoable (Edit::Segments). Message thread.
   */
  void setSegments(const juce::String& uuid,
                   const celestrian::timing::TimeMap& map);

  // AudioIODeviceCallback methods
  void audioDeviceIOCallbackWithContext(
      const float* const* input_channel_data, int num_input_channels,
      float* const* output_channel_data, int num_output_channels,
      int num_samples,
      const juce::AudioIODeviceCallbackContext& context) override;

  void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
  void audioDeviceStopped() override;

  // --- Latency Calibration (see docs/performance.md §7) ---
  /**
   * Arms an empirical round-trip latency measurement: the next callbacks
   * emit a click into the outputs while capturing the input. With a
   * loopback path in place (cable, or speaker→mic), the click's arrival
   * offset in the capture IS the true end-to-end latency — superseding
   * whatever the device driver claims. Message thread only.
   */
  void startLatencyCalibration();

  /**
   * Returns { phase, roundTripSamples, roundTripMs, calibrated }. When the
   * capture has completed, this call runs the onset detection (message
   * thread), stores the measured value, and persists it for the current
   * device config; from then on recording compensation uses the empirical
   * number instead of the device-reported latencies.
   */
  juce::var getLatencyCalibration();

  /**
   * Overrides where calibration persistence is stored (tests). Defaults to
   * <user app data>/Celestrian/calibration.json.
   */
  void setCalibrationFile(const juce::File& file);

  // --- Audio device selection (docs/performance.md §4) ---
  /**
   * The full picker payload: available driver types, the devices under the
   * current type, and the rate/buffer choices the open device supports —
   * plus what is selected right now. Shape:
   *
   *   { types: string[], currentType: string,
   *     devices: string[], currentDevice: string,
   *     sampleRates: number[], currentSampleRate: number,
   *     bufferSizes: number[], currentBufferSize: number,
   *     inputChannels: number, outputChannels: number,
   *     asioAvailable: bool, error: string }
   *
   * `error` is non-empty when the last open failed (device unplugged,
   * ASIO channel already owned by another app). Message thread only.
   */
  juce::var getAudioDeviceState() const;

  /**
   * Opens `device` under driver `type` at the given rate/buffer, enables
   * every input channel it exposes, and persists the whole setup so the
   * next launch comes back on the same hardware. A zero/absent rate or
   * buffer means "keep whatever the device prefers". Returns "" on
   * success, else a human-readable error. Message thread only.
   */
  juce::String setAudioDevice(const juce::String& type,
                              const juce::String& device, double sample_rate,
                              int buffer_size);

  /**
   * Overrides where the device selection is persisted (tests). Defaults to
   * <user app data>/Celestrian/audio_device.xml.
   */
  void setAudioDeviceFile(const juce::File& file);

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
  celestrian::AudioNode* findNodeByUuid(celestrian::AudioNode* node,
                                        const juce::String& uuid);

  // --- Edits-as-events plumbing (message thread) ---
  /**
   * Performs one Edit and returns its INVERSE (Nop if it could not apply
   * — node gone, armed take, root delete). Symmetric per kind, so
   * applying an inverse yields the forward again (that is how redo
   * works). Structural removes hand the detached subtree to the inverse.
   */
  celestrian::Edit applyEdit(celestrian::Edit e);
  celestrian::Edit applyEditImpl(celestrian::Edit e);
  /** Apply `forward`, push its inverse to the undo stack, clear redo. */
  void record(celestrian::Edit forward);
  /** Push an inverse onto the undo stack, enforcing kUndoDepth (evicted
   * entries retire any owned subtree) and invalidating the redo branch.
   * The tail shared by record() and combineNodes(). */
  void pushUndo(celestrian::Edit&& inverse);
  /** retire() an owned object with type intact: the graveyard's deleter
   * runs after the 2-callback grace like every other retirement. */
  template <typename T>
  void retireOwned(T* owned) {
    if (owned != nullptr) {
      retire([owned] { delete owned; });
    }
  }
  template <typename T>
  void retireOwned(std::unique_ptr<T> owned) {
    retireOwned(owned.release());
  }
  /** The parent stack of `node` and its index within it (nullptr/−1 if
   * top-level unknown). */
  celestrian::StackNode* parentOf(celestrian::AudioNode* node,
                                  int* index_out) const;
  /** Frees any subtree an about-to-be-dropped edit owns via the reclaimer
   * (never inline — an in-flight callback may still read a just-detached
   * node). */
  void retireEdit(celestrian::Edit&& e);
  void clearRedo();
  /** Empties both undo and redo, retiring any owned subtrees (load and
   * teardown discard history). */
  void clearHistory();

  std::vector<celestrian::Edit> undo_;
  std::vector<celestrian::Edit> redo_;
  static constexpr size_t kUndoDepth = 128;

  /**
   * The AUDIBLE island cycle (E-C): the LCM of clip periods where a
   * node with an active loop window contributes its window length
   * (AudioNode::getEffectivePeriod). This is the cycle the published
   * masterPos wraps on — the playhead must loop with what is heard
   * (field 2026-07-11: it sailed past an active window). Commit and
   * epoch re-base logic (now in StackNode::takeCommitted) stay on the
   * INTRINSIC length: windows are reversible view-of-time state, not
   * committed material.
   */
  int64_t calculateEffectiveCycleLength() const;

  juce::AudioDeviceManager device_manager;

  // The root of the hierarchical audio graph — always a stack (it is
  // the island root: owns Q, epoch, and the take-lifecycle counter).
  std::unique_ptr<celestrian::StackNode> root_node;

  // Navigation focus (no stack needed for single-level editing)
  celestrian::AudioNode* focused_node = nullptr;

  // Global Transport (kernel.md step 3): MONOTONIC. The clock only moves
  // forward while playing and is NEVER reset or rebased — not by
  // commits, not by first clips (the island epoch is captured as data
  // instead), not by stop (pause/resume). Clips align by their stored
  // origins; every cyclic view is derived.
  std::atomic<bool> is_playing_global{false};
  std::atomic<int64_t> global_transport_pos{0};

  // Cycle view for the UI (derived, not authoritative): normally
  // (t − island epoch) mod LCM; while recording, frozen base + linear
  // growth so the cursor extends past the committed LCM (recording.md
  // cursor table). The island epoch (stored on the root stack) re-bases
  // to the newest committed origin when the cycle grows as a simple
  // extension — the visual successor of the old transport snap, without
  // mutating the clock or the audio. Clip arm/commit math reads the same
  // epoch (AudioNode::getIslandEpoch), keeping ONE cycle frame everywhere.
  int64_t islandEpoch() const;

  bool was_any_node_recording_ = false;  // audio thread only (view upkeep)
  std::atomic<int64_t> view_base_{0};
  std::atomic<int64_t> view_anchor_t_{0};
  std::atomic<bool> view_recording_{false};

  // Message-thread copy for the UI (getGraphState) …
  juce::String soloed_node_uuid;
  // … and the resolved pointer the audio thread actually uses. Cleared /
  // re-resolved on toggleSolo; nodes are never freed while a callback might
  // read them (see retire()).
  std::atomic<celestrian::AudioNode*> soloed_node_ptr_{nullptr};

  // Device latencies, cached in audioDeviceAboutToStart so the callback
  // never queries the device object per block.
  /** Assumed rate before any device reports one (fresh engine, unit
   * tests). One constant for every "no device yet" path — the effect
   * prepare fallback, the VU ballistics fallback, and the cache init
   * below must agree, or pre-device DSP state is built at one rate and
   * interpreted at another. */
  static constexpr double kFallbackSampleRate = 44100.0;

  std::atomic<int> cached_input_latency_{0};
  std::atomic<int> cached_output_latency_{0};
  std::atomic<double> cached_sample_rate_{kFallbackSampleRate};
  std::atomic<int> cached_block_size_{512};

  /** Attaches the transport/undo/VU/perf properties every getGraphState
   * shape carries (focused-node and empty-fallback branches must publish
   * the same set — this is the one place it is defined). */
  void attachTransportState(juce::DynamicObject& state, double master_view,
                            double island_view) const;

  // --- Callback instrumentation (docs/performance.md §6) ---
  /** Builds the "perf" object attached to every getGraphState result. */
  juce::var makePerfState() const;
  /** Updates duration/load/xrun counters; called at every callback exit. */
  void updatePerfMeters(int64_t entry_ticks, int num_samples);

  std::atomic<int64_t> max_block_us_{0};   // worst callback duration seen
  std::atomic<double> avg_dsp_load_{0.0};  // decaying avg of duration/period
  std::atomic<int64_t> xrun_count_{0};     // suspicious inter-callback gaps
  int64_t last_entry_ticks_ = 0;           // audio thread only

  // --- Master output monitor (transport VU meters) ---
  // Block RMS of the summed master output, per channel, smoothed on the
  // audio thread with VU-ish ballistics (~300 ms integration) so the
  // UI's 50 ms poll can drive the needles directly. Written only by the
  // audio callback; read by getGraphState on the message thread.
  std::atomic<float> master_vu_l_{0.0f};
  std::atomic<float> master_vu_r_{0.0f};

  // --- Pre-record ring (docs/performance.md §3) ---
  // Continuously captures device input so recording clips can map clip
  // positions to input *arrival times* (trigger + latency compensation)
  // instead of "whatever arrived after capture started". Preallocated in
  // the constructor; written at the top of every callback; indexed by
  // input_clock_ (monotonic, never wraps/resets — unlike the transport).
  // Sized for a real multi-channel interface, not the built-in stereo
  // endpoint: an 8-analog + 8-ADAT MOTU is 16 in, and every input the
  // device exposes is enabled (enableAllInputChannels), so a channel the
  // ring cannot reach is a channel the user cannot arm. 32 ch × 96000 ×
  // 4 B = 12 MB of preallocation, and the per-block copy is bounded by
  // the device's ACTUAL channel count, not this cap.
  static constexpr int kPreRecordRingChannels = 32;
  static constexpr int kPreRecordRingLen = 96000;  // 2 s @ 48 kHz per channel

  juce::AudioBuffer<float> prerecord_ring_;
  int64_t input_clock_ = 0;  // audio thread only

  // --- Latency calibration state ---
  enum class CalibrationPhase : int { Idle = 0, Capturing, Done, Failed };

  std::atomic<int> calibration_phase_{(int)CalibrationPhase::Idle};
  juce::AudioBuffer<float> calibration_capture_;  // sized on message thread
  std::atomic<int> calibration_write_pos_{0};
  int calibration_click_pos_ = 0;  // written before phase flips, then const
  // Empirical round-trip latency in samples; -1 = uncalibrated. When >= 0
  // it supersedes cached_*_latency_ in the recording compensation.
  std::atomic<int64_t> measured_latency_samples_{-1};

  // --- Calibration persistence (docs/performance.md §7) ---
  // The measured value is only valid for the device configuration it was
  // measured on, so it is stored keyed by name|sampleRate|bufferSize and
  // restored (or reset) whenever a device starts.
  /** `<user app data>/Celestrian/<file_name>`, unless a test override is
   * set — the shared shape of every per-user persistence file. */
  static juce::File appDataFile(const juce::File& override_file,
                                const juce::String& file_name);
  /** The coherence predicate (owner ruling 2026-08-09) shared by
   * setLoopPoints and setSegments: a map/window period may only be a
   * whole multiple OR an exact divisor of Q (lcm(Q, Q/k) = Q, so sub-Q
   * loops can never explode the effective cycle). False for
   * non-positive periods; q <= 0 (no grid yet) counts as coherent. */
  static bool isPeriodCoherentWithQuantum(int64_t period, int64_t quantum);
  /** TWO-ANCHOR CONTINUITY riders (see the continuityOrigin note in
   * audio_engine.cc), shared by setLoopPoints and setSegments: re-anchor
   * the clip's origin so the sounding sample keeps sounding, and — when
   * the delta is a whole multiple of `quantum` — ride the island epoch
   * by the same delta so the edited clip's frame position is unchanged.
   * `quantum` is supplied by the caller because the two paths
   * historically judge the delta against different scopes (setLoopPoints
   * against the root's Q, setSegments against the TARGET's effective Q —
   * these differ for clips inside combine-created stacks that carry
   * their own quantum). Attaches setsOrigin/setsIsland to `e`; no-op
   * when the origin doesn't move. */
  void attachContinuityRiders(celestrian::Edit& e,
                              const celestrian::ClipNode& clip,
                              const celestrian::timing::TimeMap& new_map,
                              int64_t quantum);
  /** prepare() a node's rack at the device rate (falling back to
   * kFallbackSampleRate before any device has started) — the
   * prepare-BEFORE-enable ordering every effect mutation must follow. */
  void prepareEffects(celestrian::AudioNode& node) const;

  juce::File calibrationFile() const;
  void persistCalibration(int64_t samples);
  void restoreCalibrationForCurrentDevice();

  juce::String current_device_key_;  // empty when no device has started
  juce::File calibration_file_override_;

  // --- Device selection persistence ---
  // AudioDeviceManager's own XML (type, device name, rate, buffer, channel
  // masks) round-tripped through createStateXml/initialise — the same
  // format JUCE's AudioDeviceSelectorComponent writes, so nothing here has
  // to know the field layout.
  juce::File audioDeviceFile() const;
  void persistAudioDevice();
  /**
   * Turns ON every input channel the open device exposes. Without this the
   * device opens with only the channels `initialise` asked for, and a
   * 16-in interface silently presents 2 — the callback's channel indices
   * are ACTIVE-channel indices, so an inactive channel is not addressable
   * at all. Message thread only; may restart the device.
   */
  void enableAllInputChannels();

  juce::File audio_device_file_override_;
  juce::String device_error_;  // last open failure, surfaced to the picker

  // --- Whole-graph snapshot (unification_audit §2.2, Tier 3 Step 3) ---
  // The one structure the audio thread traverses: rebuilt on the message
  // thread after every structural mutation (publishGraph), loaded ONCE
  // per callback into ProcessContext.snap. Superseded snapshots retire
  // through the reclaimer like any graph object.
  std::atomic<const celestrian::GraphSnapshot*> graph_snapshot_{nullptr};
  /** Rebuild + atomically publish the snapshot from the current
   * ownership tree; retires the predecessor. Message thread, after any
   * structural change (applyEdit does this for structural kinds). */
  void publishGraph();

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
