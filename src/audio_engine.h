#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include <functional>
#include <memory>
#include <mutex>
#include <vector>

#include "audio_node.h"
#include "clip_node.h"
#include "dsp/vst3_slot.h"
#include "edit.h"
#include "midi_input_queue.h"
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
                    public juce::MidiInputCallback,
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

  /**
   * Seeks the transport to `pos_samples` — a position in the SAME
   * domain the published masterPos wraps in: relative to the island
   * epoch, folded on the audible cycle (E-C; under a root audition
   * that cycle IS the step). The monotonic clock is never touched
   * (kernel.md): a seek RE-BASES the island epoch so the current
   * clock reads as the requested phase — the same lever the commit
   * re-base uses, applied as a transport gesture. Works stopped or
   * playing; NOT undoable (a monitoring gesture, like auditionStep).
   *
   * Refused (returns false) while any take is live or armed: takes
   * place audio by this clock, and moving it mid-take would corrupt
   * the take's placement (owner ruling 2026-08-27, ruler scrub).
   */
  bool seekTransport(double pos_samples);

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

  // (createDefaultSession was deleted with Q17's boot-empty rule — it
  // was already call-less after the launch ritual took over, and the
  // ritual itself is now retired. A fresh engine IS the boot state.)

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

  /**
   * Flips a node's solo flag (Q16 canon: island-wide, additive,
   * fractal — resolved per callback from the snapshot). Per-node
   * Play/Stop was deleted with the same ruling: mute/solo + the one
   * transport ARE the per-node play controls.
   */
  void toggleSolo(const juce::String& uuid);
  void toggleMute(const juce::String& uuid);

  // --- Track templates (design_language.md Q17 — the Q7 companion) ---
  /**
   * Captures a node's structure + names + inputs as a template var
   * (src/track_template.h). Void var when the node is missing or is
   * the island root (whole-session templates cover that).
   */
  juce::var captureTrackTemplate(const juce::String& uuid) const;

  /**
   * Builds a fresh empty subtree from a template var and inserts it
   * under `parent_uuid` (empty = the focused stack, i.e. top level) as
   * ONE undoable edit — a "Drums" group lands, and un-lands, whole.
   */
  bool insertTrackTemplate(const juce::var& tpl,
                           const juce::String& parent_uuid);

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
  /** TEST/TOOLING: whether a performance is still waiting to settle
   * into the log (see PendingTake). */
  bool hasPendingTakes() const { return !pending_takes_.empty(); }

  /** TEST-ONLY: the currently published whole-graph snapshot (pins the
   * publish discipline in graph_snapshot_tests). */
  const celestrian::GraphSnapshot* currentGraphSnapshotForTest() const {
    return graph_snapshot_.load();
  }
  /** TEST-ONLY: a node by uuid (message thread), for asserting node
   * facts that metadata summarizes. */
  celestrian::AudioNode* findNodeByUuidForTest(const juce::String& uuid) {
    return findNodeByUuid(root_node.get(), uuid);
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
  /** Set the island (Q, epoch) from an edit applier AND keep every
   * sequence musically true (owner ruling 2026-08-21, sequences track
   * Q): Q → Q' rescales step lengths by Q'/Q; Q → 0 (empty island)
   * clears them, capturing each into `inv.seq_riders` so the inverse
   * reinstalls them. Message thread; the one path appliers use. */
  void setIslandQuantum(int64_t q, int64_t epoch, celestrian::Edit& inv);
  /** Reinstall sequences an inverse carries (undo of a clearing
   * revert). */
  void reinstallSequenceRiders(celestrian::Edit& e);

  /**
   * Toggles a stack's loop window between active and bypassed
   * (time_maps.md). Activation is data, not view state: expansion no
   * longer affects whether the window applies.
   */
  void toggleLoopWindow(const juce::String& uuid);

  /**
   * Install/replace/clear a stack's SEQUENCE (docs/sequencer.md).
   * `payload` is the bridge shape: { steps: [{name, len}], gates:
   * {uuid: [0/1 per step]} } — lengths in samples; a void/empty
   * payload clears. Undoable (Edit::Sequence); refused while a take is
   * armed/recording in the subtree (the mid-take gate) and on
   * malformed payloads (0 or >64 steps, non-positive lengths).
   */
  void setSequence(const juce::String& uuid, const juce::var& payload);

  /** The sequence's jam toggle (bypass), the loop-window twin:
   * bypassed = today's everything-sounds behavior, geometry kept. */
  void toggleSequence(const juce::String& uuid);

  /**
   * THE STEP AUDITION (docs/sequencer.md §11.2): loop step `step` of
   * the stack's active sequence (−1 = stop). A monitoring gesture —
   * not undoable, not persisted; the stack's time-map becomes the
   * step's span (derived) for as long as it is on. Recording under it
   * is Mode-2 "record into a step". Refused mid-take and for a step
   * that does not exist in an active sequence.
   */
  void auditionStep(const juce::String& uuid, int step);

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
   * The period-source knob (Q5): CONTEXT_CYCLE makes the clip a
   * ONE-SHOT (period := context cycle — sounds once per scope cycle at
   * its origin, then rests); OWN_LENGTH restores the loop. Clips only;
   * undoable (a musical fact).
   */
  void setPeriodSource(const juce::String& uuid,
                       celestrian::PeriodSource source);

  // The effect chain (dsp/fx_chain.h, docs/vst3.md phase 2): slot-uuid
  // keyed edits from the UI. Message thread; prepare() runs before the
  // enable flag flips so the audio thread never sees an unprepared
  // slot. Enable/param are non-undoable knobs; MOVE is chain structure
  // and records an undoable Edit (Kind::MoveSlot).
  void setSlotEnabled(const juce::String& uuid, const juce::String& slot_uuid,
                      bool enabled);
  void setSlotParam(const juce::String& uuid, const juce::String& slot_uuid,
                    const juce::String& key, double value);
  void moveChainSlot(const juce::String& uuid, const juce::String& slot_uuid,
                     int new_index);
  /**
   * Inserts a PREPARED-by-us VST3 slot (docs/vst3.md phase 3) as an
   * undoable AddSlot edit; index < 0 appends. The slot arrives from
   * MainComponent's async instantiation completion (the engine owns no
   * format manager) and lands ENABLED — an added plugin is audible.
   * Message thread.
   */
  void addVst3SlotToChain(const juce::String& uuid,
                          std::shared_ptr<celestrian::dsp::FxSlot> slot,
                          int index);
  /** Undoable RemoveSlot edit; VST3 slots only (the built-in four are
   * the panel's fixed cards). The undo entry owns the removed slot —
   * and its plugin instance — until history drops it (reclaimer). */
  void removeChainSlot(const juce::String& uuid,
                       const juce::String& slot_uuid);
  /** The live Vst3Slot for (node, slot), or null — the editor-window
   * lookup. Message thread. */
  celestrian::dsp::Vst3Slot* vst3SlotFor(const juce::String& uuid,
                                         const juce::String& slot_uuid);
  /** Visits every MISSING vst3 slot in the graph (root included) —
   * the load-time revival sweep's discovery pass. Message thread. */
  void forEachVst3Placeholder(
      const std::function<void(const juce::String& node_uuid,
                               const juce::String& slot_uuid,
                               const juce::String& plugin_uid)>& visit);
  /** Swaps a live instance into a placeholder slot (same uuid, kept
   * state applied). Not undoable — revival restores what the session
   * already means. Message thread. */
  void reviveVst3Slot(const juce::String& uuid, const juce::String& slot_uuid,
                      std::unique_ptr<juce::AudioPluginInstance> instance);
  /** The device rate, or the fallback before any device started — the
   * rate plugin instantiation should request. Message thread. */
  double currentSampleRateOrFallback() const {
    const double rate = cached_sample_rate_.load();
    return rate > 0 ? rate : kFallbackSampleRate;
  }
  /** Fired at the end of every successful loadSession (bridge, chooser,
   * and project-manager loads all funnel through it) — the plugin
   * revival sweep's trigger. Message thread. */
  void setOnSessionLoaded(std::function<void()> hook) {
    on_session_loaded_ = std::move(hook);
  }

  // --- Live MIDI (docs/vst3.md §8, phase 4) ---
  /**
   * Arms `uuid` as THE live play-through target (its chain's
   * instrument slot receives incoming MIDI) — single-armed: every
   * other node's flag clears first. `on` false disarms. A monitoring
   * gesture like solo: not undoable, not persisted. Message thread.
   */
  void setMidiArmed(const juce::String& uuid, bool on);
  /**
   * Opens every available MIDI input through the device manager and
   * (once) registers this engine as the all-devices callback. Called
   * by the app shell at startup and on its heartbeat so hot-plugged
   * keyboards join without a restart. NOT called by the engine itself:
   * headless tests stay device-free. Message thread.
   */
  void refreshMidiInputs();
  /** {devices: [name], dropped: n} for the UI's diagnostics readout. */
  juce::var getMidiInputs() const;
  /** MidiInputCallback (the OS MIDI thread): push into the lock-free
   * queue; the audio callback drains it once per block. */
  void handleIncomingMidiMessage(juce::MidiInput* source,
                                 const juce::MidiMessage& message) override;
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
  std::function<void()> on_session_loaded_;

  // Live MIDI (phase 4): the OS-thread → audio-thread mailbox and the
  // per-block buffer the context points at. The buffer is ensureSize'd
  // at construction (message thread) so the drain never allocates.
  celestrian::MidiInputQueue midi_input_queue_;
  juce::MidiBuffer live_midi_buffer_;
  // MIDI arrival history (phase 5): the note twin of the pre-record
  // ring — every drained event with its input-clock arrival index;
  // recording clips capture from it. Audio-thread only.
  celestrian::MidiHistory midi_history_;
  bool midi_callback_registered_ = false;
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

  // --- TAKES ARE UNDOABLE (owner ruling 2026-08-20, docs/sequencer.md
  // §11.5). Commit is an AUDIO-thread event, so a take cannot be logged
  // where it happens; instead every arm registers a PENDING performance
  // here (one entry per startRecordingInNode call — a Q7 group take is
  // one performance, one undo step) and the message thread RECONCILES
  // it into the log as soon as every member has settled (committed or
  // cancelled): at the top of every getGraphState poll and before any
  // log operation, so ⌘Z right after a take undoes THAT take.
  struct PendingTake {
    std::vector<juce::String> uuids;
    int64_t q_before = 0, epoch_before = 0;  // island facts at arm
    // Step-record auto-gate (docs/sequencer.md §11.5, S19): the
    // auditioning DIRECT parent + its step, when the arm was aimed at
    // a looping step; empty = plain take.
    juce::String gate_stack;
    int gate_step = -1;
  };
  std::vector<PendingTake> pending_takes_;
  void reconcileTakes();
  void applyAutoGate(const juce::String& stack_uuid, int step,
                     const std::vector<celestrian::ClipNode*>& committed);

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

  // (Solo state lives on the nodes themselves since Q16 — per-node
  // atomic flags, scanned from the snapshot each callback. No resolved
  // pointer to cache, nothing to clear on load or delete.)

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
   * the clip's origin so the sounding sample keeps sounding (while
   * playing), then place the island epoch by the CYCLE-TOP RULE
   * (2026-08-18): if the clip DEFINES the island's cycle after the edit
   * (its new period is a multiple of Q and of every other loop's
   * period) and the loop's heard top (origin' + mapOffset(0)) sits a
   * whole number of Qs from the current epoch, the epoch moves TO that
   * top — the loop you just shaped fills the frame from its own top,
   * exactly as a cycle-extending commit and the Q13 sole-definer
   * re-trim already do. Otherwise (a sub-loop under someone else's
   * cycle, or an off-grid ⌥-slid top) the two-anchor delta ride keeps
   * the edited clip's frame position (owner ruling 2026-08-09).
   * Nothing audible moves in either case: origins are absolute; the
   * epoch is the visual cycle top and the arm grid, which whole-Q
   * moves preserve.
   * `quantum` is supplied by the caller because the two paths
   * historically judge the delta against different scopes (setLoopPoints
   * against the root's Q, setSegments against the TARGET's effective Q —
   * these differ for clips inside combine-created stacks that carry
   * their own quantum). Attaches setsOrigin/setsIsland to `e`; no-op
   * when the origin doesn't move. */
  void attachMapEditRiders(celestrian::Edit& e,
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
