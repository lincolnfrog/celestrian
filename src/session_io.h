#pragma once

#include <juce_core/juce_core.h>

#include <functional>
#include <memory>
#include <vector>

#include "audio_node.h"
#include "stack_node.h"

namespace celestrian::session_io {

/**
 * Save / Load. Plain message-thread serialization of the graph; no
 * snapshots. A session is a BUNDLE directory:
 *
 *   <dir>/session.json      canonical state (below)
 *   <dir>/audio/<uuid>.wav  each committed clip's buffer (32-bit float;
 *                           channel count follows the content — stereo
 *                           takes save as stereo WAVs)
 *
 * The format is device-independent (Q12): every musical fact is
 * stored as QTime — a clip's origin as an offset from the island epoch,
 * its period, its window segments, and the take's contextCycle — through
 * the Phase A projection helpers. Physical facts (the island exchange
 * rate `qSamples`, the epoch, the sample rate) are stored in samples and
 * used to reconstruct the sample-domain state on load at the SAME rate
 * (cross-rate resample is future; the QTime storage is what makes it
 * possible without a re-cut).
 *
 * CANONICAL (serialized): node type, uuid, name, child order,
 * inputChannel, mute, loop points + bypass, fx params, originQ/periodQ/
 * windowQ, contextCycle, island quantum + epoch.
 * DERIVED (never): launchPoint, anchors, cycle projections, clip x/y px.
 * TRANSIENT (never): island take-lifecycle counters, rec-state,
 * view-freeze bookkeeping.
 */

/** The bundle format version this build writes. A bundle whose
 * `version` is NEWER is refused on load (it may carry facts this build
 * cannot honor, and the 3 s mirror would then overwrite it with a
 * lossy re-serialization); older and unversioned bundles load. */
constexpr int kSessionVersion = 1;

/** Result of a load: the island facts + the reconstructed top-level
 * children (owned by the caller until swapped into the root). */
struct LoadedSession {
  bool ok = false;
  int64_t q_samples = 0;
  int64_t epoch = 0;
  double sample_rate = 44100.0;
  bool root_muted = false;
  // The root's output stage — the MASTER fader and balance (B5). Absent
  // in the bundle reads as unity / center.
  float root_gain = 1.0f;
  float root_pan = 0.0f;
  juce::var root_effects;  // fx blob for the root stack (may be void)
  // The root's own sequence block (may be void) — applied by the
  // engine once Q is set on the root (applySequenceVar, ROOT scope).
  juce::var root_sequence;
  std::vector<std::unique_ptr<AudioNode>> children;
  juce::String display_name;  // project display name (docs/projects.md)
  juce::String created;       // creation stamp, echoed verbatim
};

/** Project-model options (docs/projects.md). */
struct SaveOptions {
  juce::String display_name;  // stored as "name" — rename never moves dirs
  juce::String created;       // stored as "created"
  // Template save: keep STRUCTURE (names, order, inputs, mute, fx) and
  // drop every PERFORMANCE fact (audio, durations, origins, windows,
  // Q/epoch). A template is a project with no performances — and since
  // Q is born from the first take, it is pre-Q by construction.
  bool strip_performances = false;
  // Mirror save: a committed take's audio is immutable (no overdub), so
  // skip rewriting a wav whose on-disk length already matches the
  // clip's duration. (A Q13 lock-collapse CHANGES the duration, so the
  // mismatch triggers the rewrite exactly when needed.)
  bool incremental = false;
};

/**
 * Serialize `root` (its island quantum/epoch read from the node) to a
 * bundle at `dir`. `device_sample_rate` is stored so a clip's buffer can
 * be recreated at the right size on load. Returns false on I/O failure.
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

/** Parse a bundle. `ok` is false on any failure (missing/invalid json). */
LoadedSession load(const juce::File& dir, double device_sample_rate);

/** Where a sequence block lands: the island ROOT may carry a radio
 * (S12); a NESTED stack may not — its successors are dropped. */
enum class SequenceScope { ROOT, NESTED };

/**
 * Install a sequence block (the `sequence` / `rootSequence` shape
 * sequenceVar writes) on `stack`, materialized against `q`. The old
 * sequence pointer, if any, goes to `retire` — the engine hands the
 * reclaimer for a live root; a pre-graph node deletes inline.
 */
void applySequenceVar(StackNode& stack, const juce::var& block, int64_t q,
                      SequenceScope scope,
                      const std::function<void(const Sequence*)>& retire);

/** Rebuild a node's fx chain from a saved chain array (docs/vst3.md
 * §6; fillParams() keys match setParam() keys, so replay is generic).
 * Publishes a fresh chain and hands the OLD one to `retire` — pass the
 * engine reclaimer for a LIVE node (the root on load), or null for a
 * pre-graph node (deleted inline). Message thread. */
void applyEffects(AudioNode& node, const juce::var& blob, double sample_rate,
                  const std::function<void(dsp::FxChain*)>& retire);

}  // namespace celestrian::session_io
