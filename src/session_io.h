#pragma once

#include <juce_core/juce_core.h>

#include <functional>
#include <limits>
#include <memory>
#include <vector>

#include "audio_node.h"
#include "stack_node.h"

namespace celestrian::session_io {

/**
 * Save / Load: plain message-thread serialization of the graph. A
 * session is a BUNDLE directory:
 *
 *   <dir>/session.json           the island facts and the node tree
 *                                (a MIDI take's notes are inline)
 *   <dir>/audio/<uuid>.wav       an audio clip's take 0 (32-bit float,
 *                                as many channels as the take)
 *   <dir>/audio/<uuid>.take<k>.wav   its later takes
 *
 * THE BUNDLE LEVEL holds only the project identity and the ISLAND facts
 * (Q, the zero, the Q hand-off's designation, the sample rate). THE
 * ROOT IS ONE NODE RECORD like every stack beneath it (`root`): each
 * node's record is every key serializeNode writes, and every key is
 * additive — absent, it loads as the node's default.
 *
 * The format is device-independent (Q12): musical facts are stored as
 * QTime (an origin as an offset from the island zero); only the island
 * facts are in samples. Nothing derived or transient is stored — no
 * launch point, no cycle, no view state, no take in flight.
 */

/** The bundle format version this build writes. A bundle whose
 * `version` is NEWER is refused on load (it may carry facts this build
 * cannot honor, and the mirror would then overwrite it with a lossy
 * re-serialization); older and unversioned bundles load.
 *   1  the root's facts at bundle level (`rootMuted`/`rootGain`/
 *      `rootPan`/`rootEffects`/`rootSequence`) beside `nodes`; read as
 *      the root's record
 *   2  the root is one node record, `root`
 *   3  the island zero's key is `zero` (docs/frame.md §7); an earlier
 *      bundle's `epoch` key still loads. */
constexpr int kSessionVersion = 3;

/** Result of a load: the island facts, the root's own record, and the
 * reconstructed top-level children (owned by the caller until swapped
 * into the root). */
struct LoadedSession {
  bool ok = false;
  int64_t q_samples = 0;
  int64_t zero = 0;
  // The rate the bundle's takes were recorded at (its `sampleRate`; the
  // device's when the bundle names none) — a loaded clip's own rate.
  // NOT the rate racks run at: that is the device's.
  double sample_rate = 44100.0;
  // The root's record, for the engine to apply to its LIVE root
  // (applyNodeFacts): the root node itself is never replaced by a load.
  juce::var root;
  // The root's anchor (docs/frame.md §4), from its record's `anchored`
  // and `originQ`; resolved here because the zero is a load-level fact.
  bool root_anchored = false;
  int64_t root_origin = 0;
  // The Q hand-off's designation (Q22): the uuid the bundle's `definer`
  // names, empty for none. Applied after the graph; one naming a
  // missing node falls through (engine_internal::definer).
  juce::String definer;
  std::vector<std::unique_ptr<AudioNode>> children;
};

/** Project-model options (docs/projects.md). */
struct SaveOptions {
  juce::String display_name;  // stored as "name" — rename never moves dirs
  juce::String created;       // stored as "created"
  // Template save (docs/projects.md rule 2): keep STRUCTURE (names,
  // order, inputs, mute, fx) and drop every PERFORMANCE fact (audio,
  // durations, origins, windows, tops, Q and the zero).
  bool strip_performances = false;
  // The MIRROR's save: committed audio is immutable, so a take's wav
  // that exists is left alone unless its clip marks its files dirty
  // (ClipNode::takeFilesDirty), and a save that wrote every take clears
  // the mark. Any other save rewrites every wav and leaves the mark —
  // it says nothing about the mirror's files.
  bool incremental = false;
};

/**
 * Serialize `root` (its island Q and zero read from the node) to a
 * bundle at `dir`; `device_sample_rate` is stored as the takes' rate.
 * False when session.json or any take's wav could not be written.
 */
bool save(const StackNode& root, double device_sample_rate,
          const juce::File& dir, const SaveOptions& opts = {});

/** Peek a bundle's identity without loading it (recents listings,
 * post-load name recovery). Cheap: parses session.json only. */
struct BundleInfo {
  bool ok = false;
  juce::String name;
  juce::String created;
};
BundleInfo readBundleInfo(const juce::File& dir);

/** Parse a bundle. `ok` is false on any failure (missing or invalid
 * json, a newer version). `device_sample_rate` is the rate the device
 * runs at: the children's racks are prepared for it. `clock` is the
 * live transport clock: the saved zero is an ABSOLUTE clock reading
 * from the run that saved it, so one AHEAD of `clock` (a relaunch
 * restarts the clock) is seated AT `clock` — the island loads at its
 * top, and every origin, stored zero-relative, rides along. A zero at
 * or behind the clock loads as saved. */
LoadedSession load(const juce::File& dir, double device_sample_rate,
                   int64_t clock = std::numeric_limits<int64_t>::max());

/** Where a sequence block lands: the island ROOT may carry a radio
 * (S12); a NESTED stack may not — its successors are dropped. */
enum class SequenceScope { ROOT, NESTED };

/**
 * Apply a node record's FACTS to `node`: everything in the record but
 * its content (takes, children, a stack's anchored origin — the
 * caller's). Every deserialized node ends here, and it is the ONE path
 * the live root takes on load.
 *
 * The record REPLACES what the node carried, key by key: an absent key
 * is the node's default (no window, no top, the default rack, no song —
 * only an absent `id` leaves the uuid alone), so nothing of a previous
 * session stays on a live root. The rack's
 * slots are prepared at `rack_rate`, the rate the device runs at.
 * `retire_fx` / `retire_seq` take the displaced objects — the engine
 * reclaimer for a LIVE node, null for a pre-graph one (deleted
 * inline). Message thread.
 */
void applyNodeFacts(AudioNode& node, const juce::var& record, int64_t q,
                    double rack_rate, SequenceScope scope,
                    const std::function<void(dsp::FxChain*)>& retire_fx,
                    const std::function<void(const Sequence*)>& retire_seq);

}  // namespace celestrian::session_io
