#pragma once

#include <juce_core/juce_core.h>

#include <memory>
#include <vector>

#include "audio_node.h"
#include "stack_node.h"

namespace celestrian::session_io {

/**
 * Save / Load (unification_audit.md §2.2 Step 2 — tasks.md). Plain
 * message-thread serialization of the graph; no snapshots. A session is a
 * BUNDLE directory:
 *
 *   <dir>/session.json      canonical state (below)
 *   <dir>/audio/<uuid>.wav  each committed clip's buffer (mono)
 *
 * The format is device-independent (Q12-ready): every musical fact is
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

/** Result of a load: the island facts + the reconstructed top-level
 * children (owned by the caller until swapped into the root). */
struct LoadedSession {
  bool ok = false;
  int64_t q_samples = 0;
  int64_t epoch = 0;
  double sample_rate = 44100.0;
  bool root_muted = false;
  juce::var root_effects;  // fx blob for the root stack (may be void)
  std::vector<std::unique_ptr<AudioNode>> children;
};

/**
 * Serialize `root` (its island quantum/epoch read from the node) to a
 * bundle at `dir`. `device_sample_rate` is stored so a clip's buffer can
 * be recreated at the right size on load. Returns false on I/O failure.
 */
bool save(const StackNode &root, double device_sample_rate,
          const juce::File &dir);

/** Parse a bundle. `ok` is false on any failure (missing/invalid json). */
LoadedSession load(const juce::File &dir, double device_sample_rate);

/** Replay an fx-params blob (from LoadedSession or a node's) onto a
 * node's rack. getMetadata() keys match setParam() keys, so it is
 * generic. Message thread. */
void applyEffects(AudioNode &node, const juce::var &blob, double sample_rate);

}  // namespace celestrian::session_io
