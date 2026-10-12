#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <vector>

#include "audio_node.h"
#include "clip_node.h"
#include "dsp/vst3_slot.h"
#include "edit.h"
#include "midi_input_queue.h"
#include "graph_snapshot.h"
#include "heard_index.h"
#include "session_io.h"
#include "stack_node.h"

/**
 * The engine: device callback, transport, graph ownership, edit log and
 * the object-lifetime reclaimer — the seam between the two threads.
 *
 * THREADING (docs/performance.md §1): every public method is MESSAGE
 * THREAD only unless it says otherwise; the AUDIO thread runs one entry
 * point (audioDeviceIOCallbackWithContext), takes no locks and never
 * allocates. The two sides share state three ways:
 *   - per-node atomics for continuous facts (durations, origins, mixer
 *     knobs, effect params);
 *   - the whole-graph snapshot for STRUCTURE, rebuilt on the message
 *     thread after every structural edit (publishGraph) and loaded once
 *     per callback;
 *   - the reclaimer (retire) for lifetime: whatever the audio thread
 *     might still read is freed two callbacks after its retirement.
 *
 * A VERB THAT CAN BE REFUSED ANSWERS WHETHER IT APPLIED: false means
 * nothing changed — the graph, the log and the transport are as the call
 * found them. An undoable verb records an Edit (src/edit.h), and an edit
 * that would change nothing is not applied: it logs no step and keeps
 * the redo branch. THE LIVE-TAKE GATE refuses every edit that changes
 * what sounds when while a take is armed or capturing
 * (refusedUnderLiveTake).
 *
 * TESTS drive the callback by hand and never open a device (see
 * initialiseAudioDevice): that is what makes the engine deterministic
 * under test.
 */
class AudioEngine : public juce::AudioIODeviceCallback,
                    public juce::MidiInputCallback,
                    public celestrian::GraphReclaimer {
 public:
  AudioEngine();
  ~AudioEngine() override;

  // --- Transport (docs/kernel.md) ---
  /** Starts or pauses the one transport. False for a pause while a take
   * is armed or capturing: it performs against the running clock. */
  bool togglePlayback();
  bool isPlaying() const { return is_playing_global; }
  /** The monotonic clock: it moves while the transport plays and through
   * a stop's fade-out tail (after isPlaying() turns false). */
  int64_t transportClock() const { return global_transport_pos.load(); }

  /**
   * SEEK (docs/frame.md): advance the playing PHASE by `delta_samples`
   * (negative moves it back). The clock itself is never touched: the
   * island's zero moves, and every origin with it, so placement holds.
   * The view computes the advance against the frame zero it seated and
   * names the transport reading it used as `at_clock`; the engine
   * corrects for the clock having moved since (absent: no correction).
   * `applied` receives the advance applied and the reading it was applied
   * at. Works stopped or playing; a zero advance is accepted. Not
   * undoable. Refused (false) while a take is armed or capturing — takes
   * place audio by this clock.
   */
  struct SeekResult {
    int64_t advance = 0;  // the phase advance applied
    int64_t clock = 0;    // the transport reading it was applied at
  };
  bool seekTransport(double delta_samples,
                     std::optional<int64_t> at_clock = std::nullopt,
                     SeekResult* applied = nullptr);

  // --- Recording (docs/recording.md) ---
  /** ARM a first take on `uuid`: an empty clip, or every empty clip under
   * a stack as ONE performance (Q7). True when the take is armed. False
   * (logged, nothing changed) for an unknown node, while another take is
   * armed or capturing, with no empty clip there, and where an active
   * map above a target cannot place the take. */
  bool startRecordingInNode(const juce::String& uuid);
  /** ASK every live take at or under `uuid` to stop. An armed one
   * cancels here. A capturing one is the audio thread's to end, at a
   * block top: on to its boundary, or — the island's first take, which
   * has none — at that top, as long as it then is. So a take may still
   * be live when this returns: `isRecording` and the commit follow at
   * the next block, and the take's undo step at the poll after it. (A
   * host that runs the blocks on the calling thread has no block in
   * flight: there the first take is ended before this returns.) False
   * when there was no live take. */
  bool stopRecordingInNode(const juce::String& uuid);

  // --- State ---
  /** The UI poll: ticks, then publishes the whole state. */
  juce::var getGraphState();
  /** Housekeeping that must not depend on the poll's cadence: drain the
   * RtLog, settle committed takes into the log, keep every live take's
   * storage ahead of its write head. Called from every getGraphState and
   * from the app's heartbeat. */
  void tick();
  /** Peak data for node `uuid`. */
  juce::var getWaveform(const juce::String& uuid, int num_peaks) const;

  /**
   * Opens the hardware device and registers this engine as its callback.
   * The app shell calls it at startup; tests must NOT — a live callback
   * running beside their hand-driven one would corrupt their sample
   * counts.
   */
  void initialiseAudioDevice();

  // --- Structure. A fresh engine is the boot state (Q17): empty. ---
  /** Appends a new empty "clip" (any other `type`: a stack) to stack
   * `parent_uuid`, or to the root; `created` receives its uuid.
   * Undoable. False when the parent is not a stack. */
  bool createNode(const juce::String& type,
                  const juce::String& parent_uuid = "",
                  juce::String* created = nullptr);
  /** Undoable. False for an unknown node and for the name it has. */
  bool renameNode(const juce::String& uuid, const juce::String& new_name);
  /** Moves a node to `new_index` of stack `new_parent_uuid` (the view
   * computes the index; one past either end is that end). Undoable.
   * False for an unknown node or parent, the root, a destination inside
   * the moved subtree, the slot the node is in, and under a live take. */
  bool reorderNode(const juce::String& node_uuid,
                   const juce::String& new_parent_uuid, int new_index);
  /**
   * Combines two nodes into a new stack at the target's position (target
   * first, then dragged) and returns its uuid. Undoable. Empty when
   * refused: a missing node, a node with itself or with a node that
   * holds it, and under a live take.
   */
  juce::String combineNodes(const juce::String& dragged_uuid,
                            const juce::String& target_uuid);
  /** Deletes a node and its subtree. Undoable: the log keeps the subtree
   * and undo re-inserts the same nodes. False for the root, an unknown
   * node, and under a live take (cancel is that verb). */
  bool deleteNode(const juce::String& uuid);

  /** Flips a node's solo flag (Q16: island-wide, additive, fractal).
   * Not undoable. There is no per-node play/stop: mute, solo and the one
   * transport are the play controls. */
  void toggleSolo(const juce::String& uuid);
  /** Undoable. False for an unknown node. */
  bool toggleMute(const juce::String& uuid);

  // --- Track templates (Q17, src/track_template.h) ---
  /** A node's structure, names and inputs as a template var; void for an
   * unknown node or the root. */
  juce::var captureTrackTemplate(const juce::String& uuid) const;
  /** Builds an empty subtree from a template and appends it under
   * `parent_uuid` (empty = the root) as ONE undoable edit. False for a
   * malformed template or a parent that is not a stack. */
  bool insertTrackTemplate(const juce::var& tpl,
                           const juce::String& parent_uuid);

  // --- Undo / redo (src/edit.h, engine/edit_log.cc) ---
  /** Apply the newest undo (redo) entry. False when there is none, when
   * a take is armed or capturing (the entry is kept), or when the entry
   * no longer applies. */
  bool undo();
  bool redo();
  /**
   * CANCEL THE OPEN GESTURE (loop_selection.md §14): a drag the user
   * abandoned puts node `uuid` back where the gesture found it and
   * leaves NO trace in the log — its entry is applied and dropped, never
   * moved to redo, and the redo branch that entry invalidated stands
   * again. True when the node is as the gesture found it: its entry was
   * taken back, or it had logged none. False when what the drag did
   * stands: no gesture is open on `uuid`, a take is armed or capturing
   * (the entry is kept, like undo's), or the entry no longer applied.
   */
  bool cancelGesture(const juce::String& uuid);
  bool canUndo() const { return !undo_.empty(); }
  bool canRedo() const { return !redo_.empty(); }
  /** TEST/TOOLING: whether a performance is still waiting to settle
   * into the log (PendingTake). */
  bool hasPendingTakes() const { return !pending_takes_.empty(); }

  /** TEST-ONLY: the published whole-graph snapshot. */
  const celestrian::GraphSnapshot* currentGraphSnapshotForTest() const {
    return graph_snapshot_.load();
  }
  /** TEST-ONLY: a node by uuid. */
  celestrian::AudioNode* findNodeByUuidForTest(const juce::String& uuid) {
    return findNodeByUuid(uuid);
  }

  // --- Save / Load (src/session_io.h) ---
  // A session is a bundle directory (session.json + audio/*.wav),
  // device-independent and QTime-based. Load swaps the root's CONTENTS in
  // place — the root node's identity never changes, so the audio thread
  // sees no pointer race — and starts with an empty history; a load is
  // refused (false) while a take is armed or capturing.
  bool saveSession(const juce::String& path);
  bool loadSession(const juce::String& path);
  /** Project-model save (docs/projects.md): the options carry the display
   * name, the template strip and the incremental mirror. */
  bool saveSessionTo(const juce::File& dir,
                     const celestrian::session_io::SaveOptions& opts) {
    return celestrian::session_io::save(*root_node, cached_sample_rate_.load(),
                                        dir, opts);
  }

  /**
   * BOUNCE (Q19, docs/bounce.md): render node `uuid` offline, through the
   * real render path, to a stereo 32-bit float WAV at the device rate —
   * one effective cycle of the root or one effective period of any other
   * node, then the effect tail. `start` (absolute samples) names where
   * the render begins; absent, the node's frame top (plus its ↺'s heard
   * offset for a clip or an anchored group). The device callback is
   * detached for the duration; the transport does not move. Refused
   * (false) while a take is armed or capturing, with no committed
   * content, or when the file cannot be written.
   */
  bool bounce(const juce::String& uuid, const juce::String& wav_path,
              std::optional<int64_t> start = std::nullopt);
  /**
   * IMPORT (docs/import.md): a WAV/AIFF/FLAC becomes a committed take,
   * decoded on the message thread (extra channels fold onto the stereo
   * pair; another rate resamples to the device's). On an EMPTY clip — or
   * a stack, which gains a clip named after the file — it is a first
   * take at `origin_samples` snapped to the island's Q grid (Q11), and
   * on an island without Q it establishes Q. On a COMMITTED clip it is a
   * NEW TAKE of the slot, cut or padded to the slot's period; the origin
   * is ignored. One undoable step either way. Refused (false, logged)
   * while a take is armed or capturing, on a MIDI track, on a full take
   * list, or when the file cannot be decoded.
   */
  bool importAudio(const juce::String& uuid, const juce::String& path,
                   int64_t origin_samples);
  /**
   * A MIDI clip's notes for the piano-roll tile (docs/vst3.md §8.5):
   * [[posQnum, posQden, note, velocity, lenQnum, lenQden], ...], note-on
   * paired with its note-off, positions as QTime inside the committed
   * span; an unpaired note-on runs to the take's end. Empty for an audio
   * clip, an empty clip, or a clip with a live take.
   */
  juce::var getMidiNotes(const juce::String& uuid) const;
  bool hasActiveTake() const { return root_node->hasActiveTake(); }
  /** The island frame the root receives (heard_index.h): the zero, the
   * audible island cycle and Q. */
  celestrian::heard::Scope rootScope() const;

  // --- Takes and comping (docs/takes.md) ---
  /**
   * NEW TAKE: arm a further take of a COMMITTED clip — or of every
   * committed direct clip child of a stack, as one performance (Q7). The
   * slot keeps its origin, period, map and base; each member arms at its
   * own next top, captures exactly one period and finishes by itself; a
   * stop before that cancels it. Logged as one entry once settled: undo
   * restores the take that was active. True when the take is armed.
   * False (logged, nothing changed) for an unknown node, while another
   * take is armed or capturing, with no committed target, under an
   * active ancestor map, on a one-shot, on a full take list, or when the
   * take's kind would differ from the slot's.
   */
  bool newTake(const juce::String& uuid);
  /** Make take `index` the clip's active take. Undoable. False for
   * anything but a clip, an index out of range, the take already active,
   * and under a live take. */
  bool selectTake(const juce::String& uuid, int index);
  /** Remove take `index` (never a slot's last); the comp drops the cells
   * naming it. Undoable. False for anything but a clip, a slot's last
   * take, an index out of range, and under a live take. */
  bool deleteTake(const juce::String& uuid, int index);
  /** Set the clip's comp: one take index per Q cell of its period
   * (−1 = the active take); empty clears it. Undoable. False for
   * anything but an audio clip with a committed period, a wrong cell
   * count, a take index out of range, the comp it has, and under a live
   * take. */
  bool setComp(const juce::String& uuid, const std::vector<int>& cells);
  /** Peaks of take `index` of a clip. */
  juce::var getTakeWaveform(const juce::String& uuid, int index,
                            int num_peaks) const;
  /** Shrink idle committed takes to their recorded material (an atomic
   * content swap; the old buffer retires). Driven by the app heartbeat. */
  void compactIdleTakes();
  /** Clears any authored window or map whose period is incoherent with
   * the just-established Q. What it clears rides `inv` — the entry of the
   * take or import that established Q — as window riders. */
  void scrubIncoherentGeometry(int64_t q, celestrian::Edit& inv);
  /** Shrink one idle clip's content to an exact heap copy and retire the
   * old buffer with its reserved storage (take_storage.h). */
  void compactClipToHeap(celestrian::ClipNode& clip);
  /** Committed clips in the island (duration > 0), recursive. */
  int islandCommittedClipCount() const;

  // --- The map (docs/time_maps.md) ---
  /**
   * Sets node `uuid`'s loop window to [start, end): RAW positions, in
   * samples, in the node's own content — a clip's take, a stack's inner
   * cycle — wherever the loop plays. `end <= start` clears it (the node
   * plays whole). The window is CLAMPED to the material: a clip's to its
   * take, the definer stack's to its inner cycle. One undoable edit;
   * `live` marks a mid-drag commit, which joins its gesture's undo entry
   * (engine/edit_log.cc).
   *
   * Refused (false, logged, nothing recorded): an unknown node; the
   * window already stored — judged as clamped, so a drag past the
   * material is the window that ends at it; any other stack's window
   * past its inner cycle; a window on the root of an empty island (the
   * root's map is the island's loop region, composition.md §4, and an
   * island with no Q has none — clearing a stored one is not refused); a
   * length that is neither a whole multiple nor an exact divisor of Q
   * (COHERENCE, time_maps.md §4); anything while a take is armed or
   * capturing.
   *
   * THE Q-DEFINER's window is exempt from coherence: it RE-ESTABLISHES
   * the island's (Q, zero) — Q := the window's length — in the same undo
   * step (Q13, composition.md §5). On any other node that is playing,
   * the origin re-anchors so the sounding sample keeps sounding
   * (time_maps.md §5).
   */
  bool setLoopPoints(const juce::String& uuid, int64_t start, int64_t end,
                     bool live = false);
  /**
   * Sets node `uuid`'s map to the cells of `map`: setLoopPoints' commit
   * for a multi-segment map, with the same refusals, re-establishment and
   * `live`. No segment or one segment IS setLoopPoints. The list must be
   * WELL-FORMED — ordered, disjoint, each non-empty, inside the node's
   * inner cycle — and is refused, never clamped, when it is not; so are
   * cells on an empty clip.
   */
  bool setSegments(const juce::String& uuid,
                   const celestrian::timing::TimeMap& map, bool live = false);
  /** Flips whether the node's map applies (bypassed = the node plays
   * whole; the map stays stored). Undoable. False for an unknown node,
   * for the root of an empty island (no loop region to bypass) and
   * under a live take. */
  bool toggleLoopWindow(const juce::String& uuid);

  /**
   * THE RE-TIME (loop_selection.md §9): move node `uuid`'s origin by
   * `shift` samples — any amount, sub-Q included — and count it into the
   * node's re-time (its cumulative user shift; 0 = as played). A clip or
   * a group, whose shift moves its whole subtree. With `top`, also store
   * the node's top: a raw content position, which must lie in its kept
   * set. One undoable edit; `live` as for setLoopPoints. Nothing is
   * re-folded and no island fact moves.
   * Refused (false, logged): the root or an unknown node, nothing
   * committed there, the Q-definer, a `top` outside the kept set, a zero
   * shift with no new top, and anything while a take is armed or
   * capturing.
   */
  bool setTiming(const juce::String& uuid, int64_t shift,
                 std::optional<int64_t> top = std::nullopt, bool live = false);

  /**
   * THE Q HAND-OFF (Q22): make node `uuid` the island's Q-definer — the
   * designated one engine_internal::definer answers first. One undoable
   * edit: a lock-collapsed node re-opens, a clip's stored top clears, and
   * the grid is read off the node (Q := its own period, zero := its
   * origin + its map's top). Nothing moves; from then on its trims
   * re-grid the island until the next arm locks it.
   * Refused (false, logged): under a live take, before Q exists, for an
   * unknown node or the root, for a node that is not a valid definer
   * target (engine_internal::isDefinerTarget) or has no period, and for
   * the node that already defines Q.
   */
  bool setDefiner(const juce::String& uuid);

  // --- The sequence (docs/sequencer.md) ---
  /**
   * Install, replace or clear a stack's SEQUENCE. `payload` is the
   * bridge shape { steps: [{name, len, cue, fadeIn, fadeOut, next}],
   * gates: {uuid: [0/1 per step]}, seed } with lengths in samples; a void
   * payload, or one with no steps, clears. Undoable.
   * A song authored on the ROOT anchors it at `zero` — the absolute
   * sample the view had seated the frame's zero on, snapped to the Q
   * grid; the island zero when absent — and clearing it un-anchors the
   * root (docs/frame.md §4). Nested stacks ignore `zero`.
   * Refused (false, logged): not a stack; more than 64 steps, a
   * non-positive length or a successor out of range; a radio anywhere
   * but the root (S12); a clear where no song is stored; anything while
   * a take is armed or capturing.
   */
  bool setSequence(const juce::String& uuid, const juce::var& payload,
                   std::optional<int64_t> zero = std::nullopt);
  /** Flips the sequence's bypass (bypassed = everything sounds; the song
   * stays stored). Undoable. False for anything but a stack, for a stack
   * with no song — the bypass is a fact of the song, saved with it — and
   * under a live take. */
  bool toggleSequence(const juce::String& uuid);
  /**
   * THE STEP AUDITION (docs/sequencer.md §11.2): loop step `step` of the
   * stack's active sequence (−1 = stop). A monitoring gesture — not
   * undoable, not persisted; recording under it records into the step.
   * False (logged) for anything but a stack, under a live take and for a
   * step the active program does not reach.
   */
  bool auditionStep(const juce::String& uuid, int step);

  // --- Inputs, mixer, period source ---
  /** The available hardware audio inputs. */
  juce::var getInputList() const;
  /** A clip's input channel (left / mono). Undoable. False for anything
   * but a clip and for the channel it has. */
  bool setNodeInput(const juce::String& uuid, int channel_index);
  /** The RIGHT input of a stereo pair (−1 = mono); a take's channel
   * count is fixed at its arm. Undoable. False for anything but a clip
   * and for the channel it has. */
  bool setNodeInputRight(const juce::String& uuid, int channel_index);
  /** Pan / balance, −1 (hard left) .. +1 (hard right). A mixer knob: not
   * undoable. */
  void setNodePan(const juce::String& uuid, double pan);
  /** The volume fader, 0 (silent) .. 1 (unity: attenuate only), applied
   * at the node's output stage after its rack. Not undoable. */
  void setNodeGain(const juce::String& uuid, double gain);
  /**
   * The period-source knob (Q5), clip or stack: CONTEXT_CYCLE makes the
   * node a ONE-SHOT — it sounds once per cycle of its scope, at its
   * origin, then rests; OWN_LENGTH restores the loop. Undoable. False
   * for an unknown node, the source it already has, a node holding all
   * of the island's committed content (something must define the cycle),
   * and under a live take.
   */
  bool setPeriodSource(const juce::String& uuid,
                       celestrian::PeriodSource source);

  // --- The effect chain (dsp/fx_chain.h, docs/vst3.md) ---
  // Enable and params are knobs, not edits; the chain's STRUCTURE is
  // undoable. A slot is always prepared before the audio thread can see
  // it enabled.
  /** False for an unknown node or slot. */
  bool setSlotEnabled(const juce::String& uuid, const juce::String& slot_uuid,
                      bool enabled);
  void setSlotParam(const juce::String& uuid, const juce::String& slot_uuid,
                    const juce::String& key, double value);
  /** Undoable. False for an unknown node or slot, and a slot already at
   * `new_index`. */
  bool moveChainSlot(const juce::String& uuid, const juce::String& slot_uuid,
                     int new_index);
  /** Inserts a plugin slot (VST3 or AudioUnit) at `index` (< 0 appends),
   * prepared here and ENABLED. Undoable. False for a null slot or an
   * unknown node. */
  bool addPluginSlotToChain(const juce::String& uuid,
                            std::shared_ptr<celestrian::dsp::FxSlot> slot,
                            int index);
  /** Removes a PLUGIN slot (the built-in effects are the panel's fixed
   * cards). Undoable: the log keeps the slot, and its plugin instance,
   * until history drops it. False for anything else. */
  bool removeChainSlot(const juce::String& uuid,
                       const juce::String& slot_uuid);
  /** The live Vst3Slot for (node, slot), or null. */
  celestrian::dsp::Vst3Slot* vst3SlotFor(const juce::String& uuid,
                                         const juce::String& slot_uuid);
  /** Visits every MISSING plugin slot in the graph, the root's included
   * (the load-time revival sweep). */
  void forEachVst3Placeholder(
      const std::function<void(const juce::String& node_uuid,
                               const juce::String& slot_uuid,
                               const juce::String& plugin_uid)>& visit);
  /** Swaps a live instance into a placeholder slot (same uuid, the kept
   * state applied). Not undoable. */
  void reviveVst3Slot(const juce::String& uuid, const juce::String& slot_uuid,
                      std::unique_ptr<juce::AudioPluginInstance> instance);
  /** The device rate, or the fallback before any device has started. */
  double currentSampleRateOrFallback() const {
    const double rate = cached_sample_rate_.load();
    return rate > 0 ? rate : kFallbackSampleRate;
  }
  /** Fired at the end of every successful loadSession — every load path
   * funnels through it. */
  void setOnSessionLoaded(std::function<void()> hook) {
    on_session_loaded_ = std::move(hook);
  }
  /** Panel open/closed: gates ALL scope capture and telemetry for a node. */
  void setEffectScope(const juce::String& uuid, bool active);

  // --- Live MIDI and monitoring (docs/vst3.md §8) ---
  /** Arms `uuid` as THE live play-through target (single-armed: every
   * other flag clears first); `on` false disarms. A monitoring gesture:
   * not undoable, not persisted. */
  void setMidiArmed(const juce::String& uuid, bool on);
  /** Software input monitoring (Q20): the clip renders its input
   * channels from the pre-record ring through its own rack, gate, gain
   * and pan, whether idle, armed or capturing. Not undoable; persisted
   * and captured by templates. False for anything but a clip. */
  bool setMonitor(const juce::String& uuid, bool on);
  /** Opens every available MIDI input and (once) registers this engine
   * as their callback. The app shell calls it at startup and on its
   * heartbeat, so hot-plugged keyboards join; the engine never does —
   * tests stay device-free. */
  void refreshMidiInputs();
  /** {devices: [name], dropped: n}. */
  juce::var getMidiInputs() const;
  /** MidiInputCallback (the OS MIDI thread): push into the lock-free
   * queue the audio callback drains once per block. */
  void handleIncomingMidiMessage(juce::MidiInput* source,
                                 const juce::MidiMessage& message) override;

  // --- AudioIODeviceCallback ---
  void audioDeviceIOCallbackWithContext(
      const float* const* input_channel_data, int num_input_channels,
      float* const* output_channel_data, int num_output_channels,
      int num_samples,
      const juce::AudioIODeviceCallbackContext& context) override;
  void audioDeviceAboutToStart(juce::AudioIODevice* device) override;
  void audioDeviceStopped() override;

  // --- Latency calibration (docs/performance.md §7) ---
  /** Arms a round-trip measurement: the next callbacks emit a click
   * while capturing the input, and with a loopback path in place the
   * click's arrival offset IS the end-to-end latency. False while a run
   * is capturing: it is left to finish. */
  bool startLatencyCalibration();
  /** { phase, roundTripSamples, roundTripMs, calibrated }. Once the
   * capture has completed, this call detects the onset, stores the
   * measured value and persists it for the current device config; from
   * then on recording compensation uses it instead of the latencies the
   * device reports. */
  juce::var getLatencyCalibration();
  /** Overrides where calibration is persisted (tests). */
  void setCalibrationFile(const juce::File& file);

  // --- Audio device selection (docs/performance.md §4) ---
  /**
   * The picker payload:
   *   { types: string[], currentType: string,
   *     devices: string[], currentDevice: string,
   *     sampleRates: number[], currentSampleRate: number,
   *     bufferSizes: number[], currentBufferSize: number,
   *     inputChannels: number, outputChannels: number,
   *     asioAvailable: bool, error: string }
   * `error` is non-empty when the last open failed.
   */
  juce::var getAudioDeviceState() const;
  /** Opens `device` under driver `type`, enables every input channel it
   * exposes and persists the setup. A zero rate or buffer keeps what the
   * device prefers. Returns "" on success, else a readable error. */
  juce::String setAudioDevice(const juce::String& type,
                              const juce::String& device, double sample_rate,
                              int buffer_size);
  /** Overrides where the device selection is persisted (tests). */
  void setAudioDeviceFile(const juce::File& file);

  /** GraphReclaimer: defers a deleter until no callback that could have
   * loaded the object is still running (two callbacks). */
  void retire(std::function<void()> deleter) override;

 private:
  std::function<void()> on_session_loaded_;

  // Live MIDI: the OS-thread → audio-thread mailbox and the per-block
  // buffer the context points at, reserved before the device runs so the
  // drain never allocates. The queue is declared BEFORE device_manager:
  // the destructor does not unregister the MIDI callback, so the queue
  // must outlive the inputs that push into it.
  celestrian::MidiInputQueue midi_input_queue_;
  juce::MidiBuffer live_midi_buffer_;
  // One slice's share of it, when a device block is longer than the
  // graph's ceiling (renderBlock); reserved alike.
  juce::MidiBuffer slice_midi_buffer_;
  // Every drained event with its input-clock arrival index — the note
  // twin of the pre-record ring; recording clips capture from it. Audio
  // thread only.
  celestrian::MidiHistory midi_history_;
  bool midi_callback_registered_ = false;
  /** Runs every pending deleter. Only when no callback can be in flight
   * (device stopped, or after removeAudioCallback). */
  void flushGraveyard();
  /** Opens the stored device, else the default, with `outputs` output
   * channels and every input the hardware has (up to the ring's width). */
  void init(int outputs);
  /** The node `uuid` names anywhere in the session, the root included,
   * or null. */
  celestrian::AudioNode* findNodeByUuid(const juce::String& uuid) const {
    return root_node->findByUuid(uuid);
  }

  // --- THE EDIT LOG (src/edit.h, engine/edit_log.cc) ---
  /** Performs one Edit and answers its INVERSE, or Nop having changed
   * nothing. Around the kind's applier it applies the edit's anchor
   * riders, settles the anchoring and republishes the graph, as the kind
   * requires (KindTraits::Touches); an edit with a `then` applies both
   * and composes the inverse the other way round. It neither gates nor
   * logs: record, undo and redo do. */
  celestrian::Edit applyEdit(celestrian::Edit e);

  /** What the log knows about an edit kind — ONE row per kind (traitsOf). */
  struct KindTraits {
    /** What applyEdit owes the graph once the applier has answered:
     * FACTS nothing; ROOT_ANCHOR the edit's anchor riders (a song on the
     * root anchors it, docs/frame.md §4); CONTENT those and the anchoring
     * settle (Q18); STRUCTURE those and a republished graph. */
    enum class Touches { FACTS, ROOT_ANCHOR, CONTENT, STRUCTURE };
    /** While a take is armed or capturing (refusedUnderLiveTake). */
    enum class UnderTake { WAITS, LIVE };
    /** Live commits coalesce only within one family (record). */
    enum class Gesture { NONE, MAP, TIMING };
    const char* name;  // for the origin-drift log
    celestrian::Edit (AudioEngine::*apply)(celestrian::Edit);
    Touches touches;
    UnderTake under_take;
    Gesture gesture;
  };
  static KindTraits traitsOf(celestrian::Edit::Kind kind);

  // THE APPLIERS, one per kind: each performs its mutation and answers
  // the inverse, or Nop having changed nothing. Reached through applyEdit
  // alone. Structure: engine/edit_structure.cc.
  celestrian::Edit applyInsert(celestrian::Edit e);
  celestrian::Edit applyRemove(celestrian::Edit e);
  celestrian::Edit applyMove(celestrian::Edit e);
  celestrian::Edit applyCombine(celestrian::Edit e);
  celestrian::Edit applyExplode(celestrian::Edit e);
  // Geometry: engine/edit_geometry.cc.
  celestrian::Edit applyLoopPoints(celestrian::Edit e);
  celestrian::Edit applySegments(celestrian::Edit e);
  celestrian::Edit applyLoopBypass(celestrian::Edit e);
  celestrian::Edit applyCollapse(celestrian::Edit e);
  celestrian::Edit applyTiming(celestrian::Edit e);
  celestrian::Edit applyDefiner(celestrian::Edit e);
  // Takes: engine/edit_takes.cc (Take and Untake are one applier).
  celestrian::Edit applyTake(celestrian::Edit e);
  celestrian::Edit applySelectTake(celestrian::Edit e);
  celestrian::Edit applyDeleteTake(celestrian::Edit e);
  celestrian::Edit applyComp(celestrian::Edit e);
  // Node facts, the sequence and the rack: engine/edit_facts.cc.
  celestrian::Edit applyRename(celestrian::Edit e);
  celestrian::Edit applyMute(celestrian::Edit e);
  celestrian::Edit applyPeriodSource(celestrian::Edit e);
  celestrian::Edit applyInput(celestrian::Edit e);
  celestrian::Edit applyInputR(celestrian::Edit e);
  celestrian::Edit applySequence(celestrian::Edit e);
  celestrian::Edit applySequenceBypass(celestrian::Edit e);
  celestrian::Edit applyMoveSlot(celestrian::Edit e);
  celestrian::Edit applyAddSlot(celestrian::Edit e);
  celestrian::Edit applyRemoveSlot(celestrian::Edit e);

  /** Copy-swap-retire a stack's sequence: a copy of `fresh` (null = none)
   * goes live, the displaced one retires through the reclaimer, and a
   * copy of it comes back for the inverse (null when there was none). */
  std::unique_ptr<celestrian::Sequence> swapSequence(
      celestrian::StackNode& stack, const celestrian::Sequence* fresh);
  /** Publish `slots` as the node's chain — a successor sharing the slot
   * objects, so their DSP state survives — and retire the predecessor. */
  void installSlots(
      celestrian::AudioNode& node,
      std::vector<std::shared_ptr<celestrian::dsp::FxSlot>> slots);
  /** Apply an edit's WINDOW RIDERS (Edit::windows): each named node's
   * map is replaced and its top rides it; the inverse captures the raw
   * map and the stored top it displaced. */
  void applyWindowRiders(const celestrian::Edit& e, celestrian::Edit& inv);
  /** The tail of a map or re-time edit: its origin (applySetsOrigin) and
   * the island facts (applySetsIsland) land in ONE block, the origins
   * gated on the generation the facts publish. */
  void applyOriginAndIsland(celestrian::AudioNode& node, celestrian::Edit& e,
                            celestrian::Edit& inv);
  /** The lock-collapse of a clip under a CELL MAP: the kept cells become
   * the take (every take of the slot, and a MIDI take's notes), and `inv`
   * owns what the splice displaced. unspliceAtLock puts it back. */
  void spliceAtLock(celestrian::ClipNode& clip, celestrian::Edit& inv);
  void unspliceAtLock(celestrian::ClipNode& clip, celestrian::Edit& e);
  /** Append `node` under stack `parent_uuid` (empty = the root) as one
   * recorded Insert. False when the parent is not a stack or `node` is
   * null. */
  bool appendNode(const juce::String& parent_uuid,
                  std::unique_ptr<celestrian::AudioNode> node);
  /** undo / redo: apply the top of `from` and push what it yields onto
   * `onto`. False when there was nothing, a take is live (the entry is
   * kept), or the entry no longer applied (it is dropped). */
  bool replay(std::vector<celestrian::Edit>& from,
              std::vector<celestrian::Edit>& onto, const char* verb);
  /** THE ONE WAY A VERB EDITS: settle any finished take into the log
   * first, pass the live-take gate, apply `forward` and log its inverse —
   * a live commit joins its gesture's entry instead — dropping the redo
   * branch. False when it was refused or did not apply: nothing changed
   * and nothing was logged. */
  bool record(celestrian::Edit forward);
  /** A NON-LIVE map or re-time commit opens its gesture as it arrives —
   * before any gate, so a first commit that records nothing still ends
   * the previous gesture. */
  void openGesture(const juce::String& uuid, celestrian::Edit::Kind kind);
  /** Push an inverse onto the undo stack, enforcing kUndoDepth and
   * dropping the redo branch; ends any open gesture. The tail of record,
   * and of the paths that log an inverse they applied themselves (a
   * settled take, an import, an arm's edits). */
  void pushUndo(celestrian::Edit&& inverse);
  /** retire() an owned object with its type intact. */
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
  /** Retire a DETACHED graph node. Unlike retireOwned this PARKS it: it
   * enters the graveyard, stamped, only from the next publishGraph —
   * after the snapshot that still lists it has been exchanged. Every
   * path that detaches a node without handing it to an inverse edit uses
   * this, never retireOwned. */
  void retireNode(std::unique_ptr<celestrian::AudioNode> node);
  /** The parent stack of `node` and its index in it (null / −1 when it
   * has none). */
  celestrian::StackNode* parentOf(celestrian::AudioNode* node,
                                  int* index_out) const;
  /** THE LIVE-TAKE GATE (design_language.md §5): while any take is armed
   * or capturing, whatever changes what sounds when — structure,
   * geometry, sequences, takes, the period source, undo and redo, a
   * pause, a second arm — is refused, and `verb` is logged. Only wiring
   * stays live: rename, mute, the inputs of the NEXT arm, the rack's
   * structure and a new empty track. True when refusing. A node that is
   * armed or recording implies its island counts a live take, so this
   * one question covers every per-node case. */
  bool refusedUnderLiveTake(const char* verb) const;
  /** The gate for an edit of `kind`: it never refuses a kind that stays
   * live under a take (KindTraits::UnderTake). record asks this; undo,
   * redo and cancelGesture replay whatever the log holds and ask the
   * plain form. */
  bool refusedUnderLiveTake(celestrian::Edit::Kind kind,
                            const char* verb) const;
  /** Hands everything a dropped edit owns to the reclaimer. */
  void retireEdit(celestrian::Edit&& e);
  void clearRedo();
  /** Empties undo and redo (a load and teardown discard history). */
  void clearHistory();

  std::vector<celestrian::Edit> undo_;
  std::vector<celestrian::Edit> redo_;
  static constexpr size_t kUndoDepth = 128;
  // THE OPEN GESTURE (the law is at engine/edit_log.cc): the drag whose
  // live commits coalesce into one undo entry — its node, its kind (Nop =
  // none open) and whether it has logged that entry yet.
  struct Gesture {
    juce::String uuid;
    celestrian::Edit::Kind kind = celestrian::Edit::Kind::Nop;
    bool logged = false;
  };
  Gesture gesture_;
  // The redo branch the open gesture's entry invalidated, kept for as
  // long as the gesture can still be cancelled.
  std::vector<celestrian::Edit> gesture_redo_;
  /** End the open gesture, retiring the redo branch it held. */
  void endGesture();

  // --- TAKES ARE UNDOABLE (docs/sequencer.md §11.5). A commit is an
  // AUDIO-thread event, so a take cannot be logged where it happens:
  // every arm registers a PENDING performance here (a group take is one
  // performance, one undo step) and the message thread RECONCILES it into
  // the log once every member has settled — on every poll and before any
  // log operation, so an undo right after a take undoes that take.
  struct PendingTake {
    std::vector<juce::String> uuids;
    int64_t q_before = 0, zero_before = 0;  // island facts at arm
    // Step-record auto-gate (docs/sequencer.md §11.5, S19): the
    // auditioning DIRECT parent and its step, when the arm was aimed at
    // a looping step; empty = a plain take.
    juce::String gate_stack;
    int gate_step = -1;
    // A NEW TAKE of committed slots (docs/takes.md): prev_active[i] is
    // member i's active take before the arm.
    bool retake = false;
    std::vector<int> prev_active;
  };
  std::vector<PendingTake> pending_takes_;
  void reconcileTakes();
  void applyAutoGate(const juce::String& stack_uuid, int step,
                     const std::vector<celestrian::ClipNode*>& committed);
  /** Keep committed pages ahead of every live take's write head
   * (take_storage.h); called from tick. */
  void growLiveTakes();

  /** The AUDIBLE island cycle: the cycle the published masterPos wraps
   * on, so the playhead loops with what is heard — a node with an active
   * map contributes its map's period. Commit logic stays on the
   * INTRINSIC length: a map is a reversible view of time, not committed
   * material. */
  int64_t calculateEffectiveCycleLength() const;

  juce::AudioDeviceManager device_manager;
  // True once initialiseAudioDevice registered this engine as the
  // device callback — a bounce detaches and re-attaches exactly that
  // registration (tests register nothing).
  bool device_callback_registered_ = false;
  // The thread the last block ran on (null: none has run). A host that
  // drives the callback itself — the headless server's clock, a test —
  // registers nothing, so this is how the engine tells one whose blocks
  // run on the calling thread from one whose blocks run beside it.
  std::atomic<juce::Thread::ThreadID> callback_thread_{nullptr};
  /** WHO RUNS THE BLOCKS: true when a thread other than the caller's may
   * be inside one — a device callback is registered, or the last block
   * ran on another thread. False only for a host that drives the callback
   * on the calling thread: no block is in flight then, and none comes
   * unless the caller runs it (stopRecordingInNode). Message thread. */
  bool blocksRunElsewhere() const;

  // The root of the graph — always a stack: the island root, which owns
  // Q, the zero and the count of live takes. Never null, and never
  // replaced: a load swaps its contents.
  std::unique_ptr<celestrian::StackNode> root_node;

  // The transport (docs/kernel.md): MONOTONIC. The clock only moves
  // forward while playing and is never reset or rebased — not by a
  // commit, a first clip or a stop. Clips align by their stored origins;
  // every cyclic view is derived.
  std::atomic<bool> is_playing_global{false};
  std::atomic<int64_t> global_transport_pos{0};

  /** The island zero: the first take's origin — Q's grid phase — which
   * no commit or map edit moves (docs/frame.md). */
  int64_t islandZero() const;
  /** THE ROOT'S FRAME TOP: its own origin while it carries a song
   * (docs/frame.md §4), else the island zero. The cursor fold, the
   * recording view base, a seek and the root's bounce all measure from
   * here — where the root's song folds from on the audio thread
   * (AudioNode::frameOrigin). */
  int64_t rootFrameTop() const;

  // --- THE ORIGIN DRIFT LOG: every committed node's origin as of the
  // last check (message thread). A check after each applied edit, take
  // settle and poll logs any step after which the tracks did NOT all
  // move by the same amount, naming the step — a seek moves every origin
  // together and logs nothing; a re-time or a lock-collapse moves one
  // subtree and logs.
  struct OriginMark {
    int64_t origin = 0;
    juce::String name;
  };
  std::map<juce::String, OriginMark> origin_marks_;
  /** Compare every committed node's origin with the last check, log
   * relative movement under `cause`, and remember the new state. */
  void noteOriginDrift(const juce::String& cause);

  bool was_any_node_recording_ = false;  // audio thread only (view upkeep)
  // THE TRANSPORT FADES (audio thread only; docs/kernel.md §3). Start:
  // the master output ramps in over the declick length. Stop: the audio
  // thread keeps rendering, and the clock keeps moving, for one declick
  // length and ramps the master out; `stop_tail_pos_` counts the tail's
  // samples, −1 when none runs.
  bool was_playing_ = false;
  int64_t play_fade_pos_ = 0;
  int64_t stop_tail_pos_ = -1;

 public:
  /** The transport fades' switch: on in the app, off in the test runner
   * (its oracles read the samples around a start or a stop exactly;
   * tests/seam_fade_tests.cc pins the fades). Process-wide. */
  static inline std::atomic<bool> transport_fades_enabled{true};

 private:
  // The cycle view the UI is published (derived): (t − frame top) mod
  // cycle; while recording, base + (t − anchor) — linear growth, so the
  // cursor extends past the committed cycle (docs/recording.md). With Q
  // the pair is frozen as the take begins: (this block's place in the
  // audible cycle, the clock then). During a FIRST take — no Q yet — it
  // is (0, the island zero the arm stored), written every block: the
  // cursor is the take's own position.
  std::atomic<int64_t> view_base_{0};
  std::atomic<int64_t> view_anchor_t_{0};
  std::atomic<bool> view_recording_{false};

  /** The rate assumed before any device reports one. ONE constant for
   * every "no device yet" path, or DSP state would be built at one rate
   * and read at another. */
  static constexpr double kFallbackSampleRate = 44100.0;

  // Device latencies and rate, cached in audioDeviceAboutToStart so the
  // callback never queries the device per block.
  std::atomic<int> cached_input_latency_{0};
  std::atomic<int> cached_output_latency_{0};
  std::atomic<double> cached_sample_rate_{kFallbackSampleRate};

  /** The transport / undo / VU / perf properties of the getGraphState
   * result. */
  void attachTransportState(juce::DynamicObject& state, double master_view,
                            double island_view) const;

  /** ONE BLOCK THROUGH THE GRAPH, at most the graph's ceiling
   * (kMaxBlockSamples) long: the transport fades, the block's context,
   * the root's process, the clocks and the cursor view. The callback
   * renders a device block within the ceiling as one of these and a
   * longer one as consecutive slices, so no node's scratch ever grows.
   * `live_midi` is the block's own live events, timed from its top.
   * Audio thread. */
  void renderBlock(const float* const* input_channel_data,
                   int num_input_channels, float* const* output_channel_data,
                   int num_output_channels, int num_samples,
                   const celestrian::GraphSnapshot& snap,
                   const juce::MidiBuffer& live_midi, int ring_channels);
  /** The most channels each way a SLICED device block carries to the
   * graph (channels past it stay silent; a block within the ceiling
   * passes the device's own arrays, whatever their width). */
  static constexpr int kSliceChannels = 64;

  // --- Callback instrumentation (docs/performance.md §6) ---
  /** The "perf" object attached to every getGraphState result. */
  juce::var makePerfState() const;
  /** Updates duration / load / xrun counters at every callback exit. */
  void updatePerfMeters(int64_t entry_ticks, int num_samples);

  std::atomic<int64_t> max_block_us_{0};   // worst callback duration seen
  std::atomic<double> avg_dsp_load_{0.0};  // decaying avg of duration/period
  std::atomic<int64_t> xrun_count_{0};     // suspicious inter-callback gaps
  int64_t last_entry_ticks_ = 0;           // audio thread only

  // The master output's level per channel: a rectified envelope
  // follower run on the audio thread (fast attack, slow release —
  // engine/audio_callback.cc), so the UI's poll drives the needles
  // directly.
  std::atomic<float> master_vu_l_{0.0f};
  std::atomic<float> master_vu_r_{0.0f};

  // --- Pre-record ring (docs/performance.md §3): device input captured
  // continuously, so a recording clip maps its positions to input ARRIVAL
  // times (trigger and latency compensation). Preallocated; written at
  // the top of every callback; indexed by input_clock_, which never wraps
  // or resets. Sized for a real multi-channel interface — every input the
  // device exposes is enabled, and a channel the ring cannot reach is one
  // the user cannot arm.
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
  // The measured round trip in samples; −1 = uncalibrated. When >= 0 it
  // overrides the cached latencies in the recording compensation.
  std::atomic<int64_t> measured_latency_samples_{-1};

  /** `<user app data>/Celestrian/<file_name>`, unless a test override is
   * set. */
  static juce::File appDataFile(const juce::File& override_file,
                                const juce::String& file_name);

  // --- The map commit (engine/map_edits.cc) ---
  /** COHERENCE: a period may only be a whole multiple or an exact
   * divisor of Q (lcm(Q, Q/k) = Q, so a sub-Q loop cannot explode the
   * effective cycle). False for a non-positive period; no Q yet counts
   * as coherent. */
  static bool isPeriodCoherentWithQuantum(int64_t period, int64_t quantum);
  /** THE CONTINUITY RIDER (time_maps.md §5; continuityOrigin in
   * engine/island_geometry.cc): while playing, a map edit re-anchors the
   * node's origin so the sounding sample keeps sounding. Stopped, or
   * under a bypass, nothing moves; no island fact ever does. Attaches
   * setsOrigin to `e` only when the origin moves. */
  void attachMapEditRiders(celestrian::Edit& e,
                           const celestrian::AudioNode& node,
                           const celestrian::timing::TimeMap& new_map);
  /** THE MAP COMMIT behind setLoopPoints and setSegments: replace
   * `target`'s map with `map` (none, one window, or cells) as one
   * recorded edit. False when it was an identity, incoherent with Q, a
   * map for the root of an empty island, or refused by the log. */
  bool commitMap(celestrian::AudioNode& target,
                 const celestrian::timing::TimeMap& map, bool live);

  // --- Origins, anchoring and the island facts (Q18, composition.md §5) ---
  /** The ancestors anchored ON `node` — each one, nearest first, while
   * `node`'s subtree holds all of its committed content — move by
   * `delta`, gated like the node's own origins: what a definer's
   * re-anchor, a collapse and a splice owe them. An ancestor that holds
   * other content stays on it, and so does everything above. */
  void liftAncestorsGated(celestrian::AudioNode& node, int64_t delta,
                          uint32_t gate);
  /** The raw facts that undo a lock-collapse. */
  struct CollapseFacts {
    int64_t shift = 0, old_duration = 0, win_start = 0, win_end = 0;
  };
  /** Q13 LOCK-COLLAPSE of a definer node, clip or stack: its window
   * becomes the take (the law is at engine/edit_geometry.cc). False,
   * nothing changed, with no single window to collapse. */
  bool collapseNode(celestrian::AudioNode& node, CollapseFacts& f);
  /** The exact inverse of collapseNode from its raw facts. */
  void uncollapseNode(celestrian::AudioNode& node, int64_t shift,
                      int64_t old_duration, int64_t win_start,
                      int64_t win_end);
  /** RE-OPEN a lock-collapsed node from its collapse markers: the full
   * takes return with the old trim as its window. Only while nothing was
   * authored on the node or its leaves since the lock. Returns whether
   * it re-opened. */
  bool reopenCollapsed(celestrian::AudioNode& node);
  /** THE ARM'S OWN EDITS, each an undo step of its own:
   *   - the lock-collapse of the island's definer, unless it IS `exclude`
   *     — the node being armed, which only a definer STACK armed through
   *     its own record button can be;
   *   - then the end of a Q hand-off (Q22): the designation clears. Not
   *     when it names a node no longer in the island (the undo that
   *     revives the node needs it), and not for a NEW TAKE whose
   *     `retakes` all lie in the designated node's subtree.
   * applyArmEdits APPLIES them and returns their inverses (Nop where
   * there was nothing to do) without logging: the arm judges its
   * refusals against the graph they leave, then logs them (logArmEdits)
   * or — refused — puts them back (revertArmEdits), so a refused arm
   * leaves the graph and the log as it found them. */
  struct ArmEdits {
    celestrian::Edit collapse_inverse;
    celestrian::Edit release_inverse;
  };
  ArmEdits applyArmEdits(const celestrian::AudioNode* exclude,
                         const std::vector<celestrian::ClipNode*>* retakes);
  void logArmEdits(ArmEdits&& edits);
  void revertArmEdits(ArmEdits&& edits);
  /** Move a node's origin and EVERY descendant's by `delta`, gated on
   * the island generation `gate` (0 = adopted at the next block top). */
  void shiftOriginsGated(celestrian::AudioNode& node, int64_t delta,
                         uint32_t gate);
  /** Apply an edit's setsOrigin / iorg to `node` as a subtree shift,
   * capturing the old origin into the inverse. No-op unless e.setsOrigin. */
  void applySetsOrigin(celestrian::AudioNode& node, const celestrian::Edit& e,
                       celestrian::Edit& inv, uint32_t gate);
  /** Apply an edit's setsIsland / iq / izero, capturing the old (Q, zero)
   * into the inverse. Sequences track Q by a ROUNDED rescale, so a
   * re-establishment's inverse also carries every song as it was and the
   * edit's own are reinstalled whole: undo restores the songs, it never
   * rescales them back. No-op unless e.setsIsland. */
  void applySetsIsland(celestrian::Edit& e, celestrian::Edit& inv,
                       uint32_t generation);
  /** Set the island (Q, zero) and keep every sequence musically true:
   * Q → Q' rescales step lengths; Q → 0 (a delete that empties the
   * island) clears the sequences, each captured into `inv.seq_riders`.
   * A take's undo is not such a revert: it sets the bare facts and
   * leaves the songs it found (applyTake). */
  void setIslandQuantum(int64_t q, int64_t zero, celestrian::Edit& inv,
                        uint32_t generation = 0);
  /** Reinstall the sequences an edit carries (Edit::seq_riders). */
  void reinstallSequenceRiders(celestrian::Edit& e);
  /** THE ANCHORING SETTLE: a stack whose subtree just gained its first
   * committed content anchors at the earliest descendant's origin; one
   * whose last content left un-anchors. An anchored stack's origin is
   * never derived again. Changes ride `inv.anchors`. Runs after every
   * structural or take edit and after a load; never on the root, whose
   * anchor rides its song. */
  void settleAnchors(celestrian::Edit& inv);
  /** Apply an edit's anchor riders, capturing the current anchoring
   * into the inverse. */
  void applyAnchorRiders(const celestrian::Edit& e, celestrian::Edit& inv);
  /** prepare() a node's rack at the device rate — before any enable. */
  void prepareEffects(celestrian::AudioNode& node) const;

  // --- Calibration persistence (docs/performance.md §7): a measured
  // value is valid only for the device configuration it was measured on,
  // so it is stored keyed by name|sampleRate|bufferSize and restored, or
  // reset, whenever a device starts.
  juce::File calibrationFile() const;
  void persistCalibration(int64_t samples);
  void restoreCalibrationForCurrentDevice();

  juce::String current_device_key_;  // empty when no device has started
  juce::File calibration_file_override_;

  // --- Device selection persistence: AudioDeviceManager's own XML,
  // round-tripped through createStateXml / initialise.
  juce::File audioDeviceFile() const;
  void persistAudioDevice();
  /** Turns ON every input channel the open device exposes. Without it a
   * 16-in interface presents 2: the callback's channel indices are
   * ACTIVE-channel indices, so an inactive channel is not addressable at
   * all. May restart the device. */
  void enableAllInputChannels();

  juce::File audio_device_file_override_;
  juce::String device_error_;  // last open failure, surfaced to the picker

  // --- The whole-graph snapshot: the one structure the audio thread
  // traverses, loaded once per callback. A replaced snapshot retires
  // through the reclaimer like any graph object.
  std::atomic<const celestrian::GraphSnapshot*> graph_snapshot_{nullptr};
  /** Rebuild and atomically publish the snapshot from the ownership
   * tree; retires the predecessor and stamps the nodes retireNode
   * parked. After any structural change (applyEdit does it for
   * structural kinds). */
  void publishGraph();
  /** A seek re-frames every absolute time in the session; the undo and
   * redo logs, which store absolute origins and zeros, ride the same
   * delta so undo restores PLACEMENT. */
  void shiftHistoryAbsolutes(int64_t delta);

  // The graveyard: a retired item is freed once the callback counter has
  // advanced two callbacks past its retirement.
  struct RetiredItem {
    uint64_t epoch;
    std::function<void()> free;
  };
  std::atomic<uint64_t> callback_count_{0};
  std::mutex graveyard_mutex_;
  std::vector<RetiredItem> graveyard_;
  // Detached nodes awaiting the publish that makes them unreachable
  // (retireNode → publishGraph). Message thread only.
  std::vector<std::unique_ptr<celestrian::AudioNode>> parked_nodes_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioEngine)
};
