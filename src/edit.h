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
    LoopPoints,  // d1 = start, d2 = end (samples)
    LoopBypass,  // b1 = bypassed
    Input,       // d1 = channel index
    Position,    // d1 = x, d2 = y
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

  // Insert (and Combine/Explode restore) own the subtree(s) to add.
  std::unique_ptr<AudioNode> node;
  std::unique_ptr<AudioNode> node2;

  Edit() = default;
  Edit(Kind k) : kind(k) {}
};

}  // namespace celestrian
