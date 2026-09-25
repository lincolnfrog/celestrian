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
 * stored as QTime — a clip's origin as an offset from the island zero,
 * its period, its window segments, and the take's contextCycle — through
 * the Phase A projection helpers. Physical facts (the island exchange
 * rate `qSamples`, the zero, the sample rate) are stored in samples and
 * used to reconstruct the sample-domain state on load at the SAME rate
 * (cross-rate resample is future; the QTime storage is what makes it
 * possible without a re-cut).
 *
 * CANONICAL (serialized): node type, uuid, name, child order,
 * inputChannel, mute, loop points + bypass, fx params, originQ/periodQ/
 * windowQ, contextCycle, a clip's top + re-time (loopTopQ/retimeQ,
 * additive), island quantum + zero, the Q hand-off's designation
 * (`definer`, additive — written only when set). The ROOT is one node
 * record like every stack (`root`, audit D7-3): the bundle level holds
 * only the island facts and the project identity.
 * DERIVED (never): launchPoint, anchors, cycle projections, clip x/y px.
 * TRANSIENT (never): island take-lifecycle counters, rec-state,
 * view-freeze bookkeeping.
 */

/** The bundle format version this build writes. A bundle whose
 * `version` is NEWER is refused on load (it may carry facts this build
 * cannot honor, and the 3 s mirror would then overwrite it with a
 * lossy re-serialization); older and unversioned bundles load.
 *   1  the root's facts at bundle level (`rootMuted`/`rootGain`/
 *      `rootPan`/`rootEffects`/`rootSequence`) beside `nodes`
 *   2  the root is ONE node record, `root` (audit D7-3): every fact a
 *      nested stack persists — window, map, bypass, period source,
 *      window domain, rack, sequence, output stage — persists on the
 *      root the same way. Version-1 bundles load (their bundle-level
 *      keys are read as the root's record).
 *   3  the island zero's key is `zero` (docs/frame.md §7: the
 *      "epoch" rename); a bundle's legacy `epoch` key still loads. */
constexpr int kSessionVersion = 3;

/** Result of a load: the island facts, the root's own record, and the
 * reconstructed top-level children (owned by the caller until swapped
 * into the root). */
struct LoadedSession {
  bool ok = false;
  int64_t q_samples = 0;
  int64_t zero = 0;
  double sample_rate = 44100.0;
  // The root's serialized record (the `root` block; synthesized from a
  // version-1 bundle's bundle-level keys). The engine applies it to
  // its LIVE root with applyNodeFacts — the root's identity never
  // changes across a load.
  juce::var root;
  // THE ROOT'S ANCHOR (docs/frame.md §4): a root that carried a song
  // was anchored at the zero the song was authored on; its record
  // stores it like any stack's (`anchored` + `originQ` from the
  // zero). Absent = unanchored (no song, or a bundle from before
  // 2026-09-17). Resolved here because the zero is a load-level fact.
  bool root_anchored = false;
  int64_t root_origin = 0;
  // THE Q HAND-OFF'S DESIGNATION (Q22): the uuid the bundle's `definer`
  // key names, empty when absent (none). An island fact beside the zero;
  // applied after the graph (one naming a missing node falls through,
  // engine_internal::definer).
  juce::String definer;
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
  // Q/zero). A template is a project with no performances — and since
  // Q is born from the first take, it is pre-Q by construction.
  bool strip_performances = false;
  // Mirror save: a committed take's audio is immutable (no overdub), so
  // skip rewriting a wav whose on-disk length already matches the
  // clip's duration. (A Q13 lock-collapse CHANGES the duration, so the
  // mismatch triggers the rewrite exactly when needed.)
  bool incremental = false;
};

/**
 * Serialize `root` (its island quantum/zero read from the node) to a
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
 * Install a sequence block (the `sequence` shape sequenceVar writes) on
 * `stack`, materialized against `q`. The old sequence pointer, if any,
 * goes to `retire` — the engine hands the reclaimer for a live root; a
 * pre-graph node deletes inline.
 */
void applySequenceVar(StackNode& stack, const juce::var& block, int64_t q,
                      SequenceScope scope,
                      const std::function<void(const Sequence*)>& retire);

/**
 * Apply a node record's FACTS to `node` — the tail every deserialized
 * node gets and the ONE path the live root takes on load: uuid, mute,
 * output stage, period source, window, map, bypass, window domain, the
 * rack, and (stacks) the sequence at `scope`. Content (takes, children,
 * a stack's anchored origin) is the caller's. `retire_fx` /
 * `retire_seq` take the displaced objects — the engine reclaimer for a
 * LIVE node, null for a pre-graph one (deleted inline). Message thread.
 */
void applyNodeFacts(AudioNode& node, const juce::var& record, int64_t q,
                    double sample_rate, SequenceScope scope,
                    const std::function<void(dsp::FxChain*)>& retire_fx,
                    const std::function<void(const Sequence*)>& retire_seq);

/** Rebuild a node's fx chain from a saved chain array (docs/vst3.md
 * §6; fillParams() keys match setParam() keys, so replay is generic).
 * Publishes a fresh chain and hands the OLD one to `retire` — pass the
 * engine reclaimer for a LIVE node (the root on load), or null for a
 * pre-graph node (deleted inline). Message thread. */
void applyEffects(AudioNode& node, const juce::var& blob, double sample_rate,
                  const std::function<void(dsp::FxChain*)>& retire);

}  // namespace celestrian::session_io
