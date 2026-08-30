#pragma once

#include <juce_core/juce_core.h>

#include <memory>
#include <vector>

#include "audio_node.h"
#include "midi_sequence.h"
#include "sequence.h"

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
    MoveSlot,      // fx chain reorder (docs/vst3.md §6): s1 = slot
                   // uuid, index = destination. Applied by building a
                   // successor chain sharing the slot objects and
                   // retiring the predecessor (D4); the inverse is a
                   // MoveSlot back to the old index. Chain STRUCTURE
                   // is undoable; enable/params stay non-undoable.
    AddSlot,       // insert `slot` (a VST3 slot, phase 3) into the
                   // node's chain at `index` (clamped; <0 = append).
                   // Inverse: RemoveSlot. The shared_ptr payload keeps
                   // the plugin INSTANCE alive across undo/redo — the
                   // owned-subtree argument applies (write-once by our
                   // hands; the plugin's own state just persists).
    RemoveSlot,    // detach chain slot s1 (VST3 only for now — the UI
                   // offers removal on plugin chips alone). Inverse:
                   // AddSlot owning the slot at its old index.
    Sequence,      // install/replace/clear a stack's sequence
                   // (docs/sequencer.md): `seq` is the full new value
                   // (null = clear). Applied by copy-swap-retire (the
                   // Segments discipline); the inverse owns a copy of
                   // the RAW old sequence (bypassed geometry survives
                   // undo, like Segments).
    SequenceBypass,  // b1 = bypassed (the jam toggle — LoopBypass twin)
    Take,            // TAKES ARE UNDOABLE (owner ruling 2026-08-20,
                     // docs/sequencer.md §11.5): forward = reinstall the
                     // committed take(s) in `takes` (redo); inverse Untake
    Untake,          // strip the take(s) named in `takes` back to empty
                     // clips (undo), the inverse OWNING their content.
                     // A group take (Q7) is ONE entry. Island (Q, epoch)
                     // ride along via setsIsland: the first take's
                     // establishment and any growth re-base undo with it.
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
  // WINDOW RIDERS: further nodes whose single-window loop points this
  // edit sets alongside its main mutation (applied after it; the
  // inverse captures each node's old points the same way). Two
  // builders use them (Q13 FOR GROUPS, 2026-08-30): the GROUP-WINDOW
  // LIFT at a group take's commit (reconcileTakes — the members'
  // commit-time loop region moves onto the definer stack, the members
  // go whole) and the definer stack's re-trim (windowed members from a
  // pre-lift state go whole). Riders on Take/Untake and LoopPoints.
  struct WindowRider {
    juce::String uuid;
    int64_t start = 0, end = 0;
  };
  std::vector<WindowRider> windows;
  // ORIGIN RIDERS (2026-08-30, the content-frame law): the definer
  // STACK's re-trim re-anchors every member's origin together with the
  // epoch — a stack window selects epoch-relative view positions, and
  // members read their buffers origin-relative, so the two frames must
  // move together or the trimmed loop re-selects content (field video
  // 2026-08-29: the loop jumped by `start` on every release). Applied
  // after the main mutation; the inverse captures each old origin.
  struct OriginRider {
    juce::String uuid;
    int64_t origin = 0;
  };
  std::vector<OriginRider> origins;
  // S16 window domain (docs/sequencer.md §11.8), LoopPoints/Segments on
  // a STACK: −1 = derive from whether the sequence is active (forward
  // edits), 0/1 = set explicitly (inverses restore the old stamp).
  int window_domain = -1;

  // Multi-segment map payload (phase 3): the map value for Segments
  // edits, and the override a LoopPoints undo reinstalls (setsMap).
  // POD by design — edits stay move-only without custom machinery.
  bool setsMap = false;
  timing::TimeMap tmap{};

  // AddSlot (and RemoveSlot's inverse) own the chain slot to insert.
  // shared_ptr because chains share slot objects by design (D4).
  std::shared_ptr<dsp::FxSlot> slot;

  // Sequence edits (docs/sequencer.md): the full new value (forward)
  // or the captured old one (inverse). Null = no sequence.
  std::unique_ptr<celestrian::Sequence> seq;
  // SEQUENCES TRACK Q (owner ruling 2026-08-21): step lengths are
  // musical facts. A Q re-establishment RESCALES every sequence's
  // steps in place (reversible by the inverse's own re-establishment);
  // a revert to an EMPTY island CLEARS them — the cleared sequences
  // ride the inverse (Insert) here and are reinstalled on undo.
  struct SeqRider {
    juce::String uuid;  // the owning stack
    std::unique_ptr<celestrian::Sequence> seq;
  };
  std::vector<SeqRider> seq_riders;

  // TAKE payloads (Kind::Take / Kind::Untake): one per clip of the
  // performance. Take owns the content to reinstall; Untake names the
  // clips to strip (its inverse then owns what was stripped). Content
  // lifetimes follow the CollapseTake precedent: owned by the log,
  // retired (never freed inline) when displaced.
  struct TakePayload {
    juce::String uuid;
    std::unique_ptr<juce::AudioBuffer<float>> buffer;  // audio content
    std::unique_ptr<MidiSequence> midi;                // note content
    int64_t origin = 0, duration = 0, base = 0, recorded = 0;
    int64_t context_cycle = 0;
    int64_t loop_start = 0, loop_end = 0;
    int content_kind = 0;  // ClipNode::ContentKind
    bool cap_hit = false;
  };
  std::vector<TakePayload> takes;

  // Insert (and Combine/Explode restore) own the subtree(s) to add.
  std::unique_ptr<AudioNode> node;
  std::unique_ptr<AudioNode> node2;
  // A multi-segment lock-collapse SPLICES the kept material into a new
  // buffer; its inverse OWNS the pre-splice buffer (same write-once
  // safety argument as owned subtrees). Retired, never freed inline.
  std::unique_ptr<juce::AudioBuffer<float>> buffer;
  // The MIDI twin (phase 5): a note-clip splice displaces its sequence;
  // the inverse owns the pre-splice one. Retired, never freed inline.
  std::unique_ptr<MidiSequence> midi;

  Edit() = default;
  Edit(Kind k) : kind(k) {}
};

}  // namespace celestrian
