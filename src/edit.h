#pragma once

#include <juce_core/juce_core.h>

#include <memory>

#include "audio_node.h"

namespace celestrian {

/**
 * An Edit is one reversible mutation of the graph (unification_audit.md
 * §2.2, staged Step 1 — tasks.md). Edits are applied on the MESSAGE
 * thread through AudioEngine::applyEdit, which performs the mutation and
 * returns the INVERSE Edit; the undo stack is a list of inverses, the
 * redo stack a list of forwards. Zero audio-thread changes: this is the
 * existing imperative bridge, refactored so every mutation records how to
 * take it back.
 *
 * Why an owned-subtree inverse is SAFE (the property the risk analysis
 * missed): there is no overdub, so a committed clip buffer is written
 * once and never mutated again. A removed subtree is therefore inert —
 * the undo stack can simply HOLD it (same uuid, buffer, origin, params)
 * and re-insert the exact node on undo. Detachment goes through the
 * existing non-retiring removeChild(index); the audio thread may read the
 * just-detached node for ≤2 more callbacks, but the undo entry only
 * stores it, never frees or mutates it, so nothing races. When an undo
 * entry that owns a subtree is finally dropped (redo cleared / depth
 * cap), the node is handed to the reclaimer, never freed inline.
 *
 * In-flight (armed/capturing) takes are NEVER undoable — cancel is the
 * verb (guarded in applyEdit).
 *
 * Move-only: a structural inverse owns a std::unique_ptr<AudioNode>.
 */
struct Edit {
  enum class Kind {
    Nop,         // could not apply (node gone / armed / root) — not recorded
    Insert,      // add `node` under parentUuid at index
    Remove,      // detach `uuid`; inverse Insert owns the subtree
    Move,        // reparent/reorder `uuid` to (parentUuid, index)
    Combine,     // build a stack from (uuid = dragged, uuid2 = target)
    Explode,     // undo of Combine: dissolve stack `uuid`, restore kids
    Rename,      // s1 = name
    Mute,        // b1 = muted
    LoopPoints,  // d1 = start, d2 = end (samples); may carry a removed
                 // multi-segment override back on undo (setsMap/tmap)
    LoopBypass,  // b1 = bypassed
    Segments,    // tmap = the full multi-segment map (phase 3). Applied
                 // by NORMALIZATION: n≥2 installs an immutable override,
                 // n==1 writes the single-window atomics, n==0 clears
                 // both. The inverse captures the RAW old storage.
    PeriodSource,  // b1 = period from context (Q5 one-shot knob)
    Input,         // d1 = channel index (left / mono)
    InputR,        // d1 = right channel index of a stereo pair (−1 = mono)
    Position,      // d1 = x, d2 = y
    CollapseTake,  // Q13 lock-collapse: the clip's window BECOMES the
                   // take (duration = window len, origin += start,
                   // content base shifts; window consumed). Forward
                   // needs no payload (derived from the clip's window);
                   // the inverse sets b1 with iq = shift, iepoch = the
                   // old duration, restoring buffer view + trim.
  };
  // Effect enable/param edits are deliberately NOT undoable in this pass
  // (non-destructive knobs; slider drags would flood the log without
  // coalescing) — a documented follow-up. Delete + all structural edits,
  // the catastrophic cases, are fully covered.

  Kind kind = Kind::Nop;
  juce::String uuid;         // primary target (or dragged / created stack)
  juce::String uuid2;        // second structural target (combine target)
  juce::String parentUuid;   // structural: destination/source parent
  juce::String parentUuid2;  // Explode: second child's source parent
  int index = -1;            // structural: destination/source index
  int index2 = -1;           // Explode: second child's source index

  juce::String s1, s2;  // name / fx id / param key
  double d1 = 0.0, d2 = 0.0;
  bool b1 = false;

  // Island (Q, epoch) payload (Q13 / provisional Q mutability). While the
  // island's only committed clip is the Q-definer, a LoopPoints re-trim
  // re-establishes (Q, epoch) and a Remove that empties the island reverts
  // it — both must ride the same edit so undo restores the GRID, not just
  // the clip/window. applyEdit is a pure applier: it sets `iq/iepoch` when
  // `setsIsland` is true and captures the old values into the inverse. The
  // *decision* to touch Q is made where the forward edit is built.
  bool setsIsland = false;
  int64_t iq = 0;      // island quantum to set
  int64_t iepoch = 0;  // island epoch to set
  // Phase-preserving trim (rides LoopPoints with setsIsland): the
  // provisional re-trim RE-ANCHORS the clip's origin so the currently
  // sounding buffer position does not move — the grid re-derives, the
  // audio flows. The inverse captures the old origin the same way.
  bool setsOrigin = false;
  int64_t iorg = 0;  // clip origin to set

  // Multi-segment map payload (phase 3): the map value for Segments
  // edits, and the override a LoopPoints undo reinstalls (setsMap).
  // POD by design — edits stay move-only without custom machinery.
  bool setsMap = false;
  timing::TimeMap tmap{};

  // Insert (and Combine/Explode restore) own the subtree(s) to add.
  std::unique_ptr<AudioNode> node;
  std::unique_ptr<AudioNode> node2;
  // A multi-segment lock-collapse SPLICES the kept material into a new
  // buffer; its inverse OWNS the pre-splice buffer (same write-once
  // safety argument as owned subtrees). Retired, never freed inline.
  std::unique_ptr<juce::AudioBuffer<float>> buffer;

  Edit() = default;
  Edit(Kind k) : kind(k) {}
};

}  // namespace celestrian
