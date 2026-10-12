#pragma once

#include <juce_core/juce_core.h>

#include <memory>
#include <vector>

#include "audio_node.h"
#include "clip_node.h"
#include "midi_sequence.h"
#include "take_storage.h"
#include "sequence.h"

namespace celestrian {

/**
 * An Edit is one reversible mutation of the graph. AudioEngine::applyEdit
 * performs it on the MESSAGE thread and answers the INVERSE edit: the
 * undo stack is a list of inverses, the redo stack a list of forwards
 * (engine/edit_log.cc). The appliers are engine/edit_*.cc.
 *
 * AN INVERSE MAY OWN what its forward displaced — a detached subtree, a
 * take's content, a chain slot. That is safe because nothing overdubs: a
 * committed buffer is written once, so what the log holds is inert, and
 * the same object comes back on undo with its uuid and state. Whatever
 * an entry owns is retired through the reclaimer when the entry is
 * dropped, never freed inline (AudioEngine::retireEdit).
 *
 * Not edits: a take that is armed or capturing (cancel is its verb), and
 * effect enable / params (knobs; a slider drag would flood the log).
 *
 * Move-only.
 */
struct Edit {
  // Each kind names the fields it reads. An inverse is the kind named, or
  // the same kind holding the old values.
  enum class Kind {
    Nop,     // nothing applied; never logged
    Insert,  // `node` under parentUuid at index. Undoing a Remove it may
             // carry setsIsland (the grid the delete reverted), seq_riders
             // (the songs that went with it), uuid2 (a definer to collapse
             // again). Inverse: Remove.
    Remove,  // detach uuid. Inverse: the Insert owning the subtree.
    Move,    // uuid to (parentUuid, index)
    Combine,  // a new stack from uuid (dragged) and uuid2 (target) at the
              // target's slot; `node` = the emptied stack a redo reuses.
              // Inverse: Explode.
    Explode,  // dissolve stack uuid: its first child back to (parentUuid,
              // index), its second to (parentUuid2, index2). Inverse: the
              // Combine owning the stack.
    Rename,      // s1 = the name
    Mute,        // b1 = muted
    LoopPoints,  // the map as ONE window: i1 = start, i2 = end, in samples
                 // (end <= start = none), with the map riders below.
                 // Inverse: setsMap/tmap = the raw old map, any shape.
    LoopBypass,  // b1 = bypassed
    Segments,    // tmap = the whole map (any n), with the map riders below
    PeriodSource,  // b1 = period from context (a one-shot, Q5)
    Input,         // i1 = the input channel (left / mono)
    InputR,        // i1 = the right input channel (−1 = mono)
    Collapse,  // the lock-collapse of definer uuid (AudioEngine::
               // collapseNode). The forward carries nothing: it derives
               // from the node's map. Inverse (b1): shift, old_duration,
               // win_start, win_end — or, for a clip's cell-map SPLICE,
               // setsMap/tmap, iorg, old_duration, i1/i2 = content base /
               // recorded length, collapsed_from, itop, cells, buffer,
               // midi, other_takes.
    MoveSlot,    // s1 = the slot's uuid, index = its destination
    AddSlot,     // `slot` into the chain at index (< 0 appends)
    RemoveSlot,  // s1 = the slot's uuid. Inverse: the AddSlot owning the
                 // slot, and its plugin instance, at its old index.
    Sequence,  // seq = the stack's whole sequence (null = none); anchors =
               // the root's anchor riding its song (docs/frame.md §4)
    SequenceBypass,  // b1 = bypassed
    Take,    // reinstall the content `takes` holds, one payload per clip
             // of the performance. Inverse: Untake.
    Untake,  // strip the clips `takes` names. Inverse: the Take owning
             // their content. Both carry what rides a performance:
             // setsIsland (a first take's establishment), windows,
             // anchors, and the step-record auto-gate — uuid + seq under
             // b1 (the stack whose sequence swaps with it). No song
             // rides one: a take's undo keeps every song it meets.
    SelectTake,  // index = the take to make active
    DeleteTake,  // index = the take to remove. Inverse: takes[0] = its
                 // record, to reinsert.
    Comp,        // cells, cell_len, cell_off = the comp (no cells = none)
    Timing,   // the re-time (AudioEngine::setTiming), clip or group:
              // setsOrigin/iorg, setsRetime/iretime and optionally
              // setsTop/itop — all absolute values
    Definer,  // the Q hand-off (AudioEngine::setDefiner): s1 = the
              // designation to store (empty = none), setsIsland = the
              // grid. With uuid: the node to re-open (b1: to collapse
              // again), setsTop/itop = a clip's top.
  };

  Kind kind = Kind::Nop;
  juce::String uuid;         // the node edited
  juce::String uuid2;        // a second node (Combine, Insert)
  juce::String parentUuid;   // structural: the parent
  juce::String parentUuid2;  // Explode: the second child's parent
  int index = -1;            // a child slot, a chain slot or a take
  int index2 = -1;           // Explode: the second child's slot

  juce::String s1;
  int64_t i1 = 0, i2 = 0;
  bool b1 = false;

  // A mid-gesture commit: it joins its gesture's undo entry
  // (AudioEngine::record).
  bool live = false;
  // THE BYPASS RIDES THE MAP (LoopPoints, Segments): `restoresBypass`
  // sets the node's bypass to `bypassed` with the map — every inverse
  // does. A forward leaves it false, and a map it clears drops a stale
  // bypass with it.
  bool restoresBypass = false;
  bool bypassed = false;
  // THE ISLAND'S FACTS: set (Q, zero) to (iq, izero). They ride whatever
  // moves the grid — the definer's map edit (its window re-establishes
  // Q), a Remove's inverse, a first take, a hand-off — so undo restores
  // the grid with it. The verb that builds the forward decides; only a
  // Remove derives its own (a delete that empties the island reverts Q).
  bool setsIsland = false;
  int64_t iq = 0;
  int64_t izero = 0;
  // THE ORIGIN: set the node's origin to iorg, its subtree moving with
  // it. Rides a map edit (a re-anchor keeps the sounding sample
  // sounding), a Timing, and a splice's inverse.
  bool setsOrigin = false;
  int64_t iorg = 0;
  // The node's anchored ancestors move by the same amount: a sole
  // definer's, which were anchored on it (Q18). Never under other
  // content, which owns those ancestors.
  bool liftsAncestors = false;
  // THE TOP RIDES THE MAP (loop_selection.md §9): `setsTop` stores itop
  // exactly — an inverse, a Timing, a Definer. A forward map edit leaves
  // it false and the applier RECONCILES the top instead, from topBase
  // under `hasTopBase`: the top its gesture started with. A raw content
  // position (AudioNode::storedTop; timing::kNoTop = never set), which a
  // seek never touches.
  bool setsTop = false;
  int64_t itop = 0;
  bool hasTopBase = false;
  int64_t topBase = 0;
  // Timing: the node's re-time to set — its cumulative user shift, in
  // samples.
  bool setsRetime = false;
  int64_t iretime = 0;
  // WINDOW RIDERS: further nodes whose map this edit replaces after its
  // own mutation — a definer stack's members going whole with its
  // re-trim, a group take's common region lifting onto its stack, the
  // geometry an establishment of Q scrubs. The inverse rider holds the
  // raw map and the top it displaced.
  struct WindowRider {
    juce::String uuid;
    int64_t start = 0, end = 0;  // the window (end <= start = none)
    bool setsMap = false;        // tmap is the map to set, when n >= 2
    timing::TimeMap tmap{};
    bool setsTop = false;  // store `top` exactly; else reconcile it
    int64_t top = 0;
  };
  std::vector<WindowRider> windows;
  // ANCHOR RIDERS (Q18, composition.md §5): stacks whose anchoring the
  // edit changed, captured by AudioEngine::settleAnchors so undo restores
  // the exact stored origin, never a derivation.
  struct AnchorRider {
    juce::String uuid;
    bool anchored = false;
    int64_t origin = 0;
    // Anchoring re-expresses, or clears, geometry authored while the
    // stack was unanchored: the map it replaced.
    bool setsMap = false;
    timing::TimeMap tmap{};
  };
  std::vector<AnchorRider> anchors;
  // S16 (sequencer.md §11.8), a map edit on a STACK: −1 = derive the
  // window's domain from whether a sequence is active (a forward), 0 / 1
  // = set it (an inverse restores the old stamp).
  int window_domain = -1;

  // The map: a Segments edit's value, and under `setsMap` the map an
  // inverse puts back.
  bool setsMap = false;
  timing::TimeMap tmap{};

  // AddSlot: the slot to insert. Chains share slot objects, and so does
  // the log.
  std::shared_ptr<dsp::FxSlot> slot;

  // Sequence: the whole value (null = none).
  std::unique_ptr<celestrian::Sequence> seq;
  // SEQUENCE RIDERS: songs to reinstall with the edit. Sequences track Q
  // (AudioEngine::setIslandQuantum): a re-establishment rescales them
  // with rounding and a revert to an empty island clears them, so the
  // inverse holds each song as it was.
  struct SeqRider {
    juce::String uuid;  // the owning stack
    std::unique_ptr<celestrian::Sequence> seq;
    // The root's anchor rides its song (docs/frame.md §4): cleared with
    // it, and back at the same stored origin.
    bool anchored = false;
    int64_t origin = 0;
  };
  std::vector<SeqRider> seq_riders;

  // TAKE PAYLOADS (Take, Untake, DeleteTake): one per clip.
  struct TakePayload {
    juce::String uuid;
    ClipNode::TakeState state;  // the take exactly as it was detached
    // A take of a multi-take slot (docs/takes.md): its list index and the
    // index active before it. −1 = the clip's whole content.
    int take_index = -1;
    int prev_active = -1;
    // The clip's comp before the list changed, restored with the take.
    bool setsComp = false;
    std::vector<int> cells;
    int64_t cell_len = 0;
    int64_t cell_off = 0;
    // The slot's re-time to set after the list change: a new take plays
    // as performed, so its settle zeroes the re-time and its Untake
    // restores the one before it. A whole-clip strip carries it in
    // `state`.
    bool setsRetime = false;
    int64_t retime = 0;
    // A MIDI take's instrument (docs/vst3.md §8.4): the slot and its state
    // as the take sounded. Empty for an audio take.
    juce::String instrument_slot;
    juce::MemoryBlock instrument_state;
  };
  std::vector<TakePayload> takes;
  // THE COMP: one take index per cell (−1 = the active take), the cell
  // length in samples and where cell 0 starts in the content
  // (ClipNode::compCells). Also the comp a splice consumed.
  std::vector<int> cells;
  int64_t cell_len = 0;
  int64_t cell_off = 0;
  // A splice's inverse: the pre-splice records of the slot's other
  // takes, by list index, and the collapse marker the splice cleared
  // (ClipNode::collapsedFrom).
  std::vector<std::pair<int, ClipNode::TakeState>> other_takes;
  int64_t collapsed_from = 0;
  // A collapse's inverse: what it shifted the content and the origins
  // by, the leaves' duration before it, and the window it consumed. All
  // relative: a seek never touches them.
  int64_t shift = 0;
  int64_t old_duration = 0;
  int64_t win_start = 0;
  int64_t win_end = 0;

  // Insert: the subtree to add. Combine: the emptied stack to reuse.
  std::unique_ptr<AudioNode> node;
  // A splice's inverse: the pre-splice buffer, and a MIDI take's notes.
  std::unique_ptr<juce::AudioBuffer<float>> buffer;
  std::unique_ptr<MidiSequence> midi;

  // A COMPOSED step: `then` is applied right after this edit, the two
  // being ONE log entry. The inverse comes back composed the other way
  // round, so an import onto a stack (an Insert, then the take) undoes as
  // the Untake, then the Remove.
  std::unique_ptr<Edit> then;

  Edit() = default;
  Edit(Kind k) : kind(k) {}
};

}  // namespace celestrian
