#pragma once

// Shared by the AudioEngine implementation files under src/engine/; not
// part of the engine's public surface:
//   - the block render context the audio callback and the offline
//     bounce share, and the callback's sizing facts (audio-thread safe);
//   - walks and queries over the OWNERSHIP tree — message thread only
//     (the audio thread traverses the snapshot, never the tree);
//   - the definer predicates (definer.cc) and the settle of a committed
//     take (take_service.cc, island_geometry.cc).
//
// THE ISLAND ROOT IS NEVER NULL: AudioEngine::root_node is created in
// the constructor and never replaced (a load swaps its contents), so no
// file under src/engine/ guards it.

#include <type_traits>
#include <vector>

#include "../clip_node.h"
#include "../edit.h"
#include "../graph_snapshot.h"
#include "../midi_input_queue.h"
#include "../midi_sequence.h"
#include "../stack_node.h"

class AudioEngine;

namespace celestrian::engine_internal {

/**
 * THE RENDER FACTS OF ONE BLOCK, built the one way (docs/bounce.md):
 * the island facts as one consistent triple, the snapshot, the clock as
 * both received and invariant position, the solo scan and the
 * context-cycle seed. The audio callback adds its live inputs (rings,
 * live MIDI, latencies); the bounce adds nothing, which is what makes a
 * bounce the live render, offline. Audio-thread safe: atomics and
 * snapshot reads only.
 */
inline ProcessContext renderContext(StackNode& root, const GraphSnapshot& snap,
                                    double sample_rate, int num_samples,
                                    int64_t clock, bool is_playing) {
  ProcessContext pc;
  pc.sample_rate = sample_rate;
  pc.num_samples = num_samples;
  pc.is_playing = is_playing;
  pc.master_pos = clock;
  const StackNode::IslandFacts island_facts = root.readIslandFacts();
  // The island frame's cycle top: a windowed stack re-bases it for its
  // children (time_maps.md).
  pc.frame_top = island_facts.zero;
  pc.snap = &snap;
  pc.self = 0;
  // Solo (Q16): one scan per block; leaves resolve their own ancestry.
  pc.any_solo = snapAnySolo(snap);
  pc.quantum = island_facts.quantum;
  pc.island_generation = island_facts.generation;
  pc.stop_generation = root.stopGeneration();
  pc.island_zero = pc.frame_top;
  pc.island = &root;
  // The invariant clock: mapping stacks fold master_pos on the way down,
  // never this.
  pc.island_pos = clock;
  // THE ISLAND'S AUDIBLE CYCLE (the period law over the snapshot): the
  // seed each stack replaces with its own scope's cycle (Q5).
  pc.context_cycle =
      snapEffectiveCycle(snap, pc.quantum, (int64_t)sample_rate);
  return pc;
}

/** THE RECORDING COMPENSATION in samples: a measured round trip
 * (calibration; negative = none) wins over the driver's reported
 * latencies, which are often wrong or zero on consumer hardware. */
inline int64_t recordingLatency(int64_t measured, int reported_in,
                                int reported_out) {
  return measured >= 0 ? measured : (int64_t)reported_in + reported_out;
}

/** The bytes one MidiInputQueue drain can append to a juce::MidiBuffer:
 * at most kCapacity events of kMidiBufferEventBytes each (the queue
 * drops anything longer than a channel message at push). The live MIDI
 * buffer is reserved to this before the device runs, so the drain never
 * allocates. */
constexpr size_t kLiveMidiDrainBytes =
    (size_t)MidiInputQueue::kCapacity * (size_t)kMidiBufferEventBytes;

// --- THE TREE WALKS (ownership tree; message thread) ------------------

/** `T`, const when `Node` is. */
template <typename Node, typename T>
using ConstAs = std::conditional_t<std::is_const_v<Node>, const T, T>;

/** `visit(node)` for `root` and every node beneath it, parents first,
 * children in order. A const root visits const nodes. `visit` must not
 * restructure the tree. */
template <typename Node, typename Visit>
void forEachNode(Node& root, Visit&& visit) {
  using Base = ConstAs<Node, AudioNode>;
  Base& node = root;
  visit(node);
  if (node.getNodeType() != NodeType::Stack) return;
  for (const auto& child :
       static_cast<const StackNode&>(node).ownedChildren()) {
    forEachNode<Base>(*child, visit);
  }
}

/** forEachNode over the clips only. */
template <typename Node, typename Visit>
void forEachClip(Node& root, Visit&& visit) {
  forEachNode(root, [&](ConstAs<Node, AudioNode>& node) {
    if (node.getNodeType() == NodeType::Clip) {
      visit(static_cast<ConstAs<Node, ClipNode>&>(node));
    }
  });
}

/** forEachNode over the stacks only. */
template <typename Node, typename Visit>
void forEachStack(Node& root, Visit&& visit) {
  forEachNode(root, [&](ConstAs<Node, AudioNode>& node) {
    if (node.getNodeType() == NodeType::Stack) {
      visit(static_cast<ConstAs<Node, StackNode>&>(node));
    }
  });
}

/** The nearest ancestor of `node` for which `pred(ancestor)` holds —
 * strictly below `stop`, when one is given — or null. */
template <typename Pred>
AudioNode* nearestAncestor(const AudioNode& node, Pred&& pred,
                           const AudioNode* stop = nullptr) {
  for (AudioNode* a = node.getParent(); a != nullptr && a != stop;
       a = a->getParent()) {
    if (pred(*a)) return a;
  }
  return nullptr;
}

/** Committed clips (intrinsic > 0) in `node`'s subtree, `node` included. */
int countCommittedClips(const AudioNode& node);

/** Does `node` STORE geometry that restricts what it plays (its bypass
 * ignored)? A cell map does; a window does unless it spans a clip's
 * whole take — that restricts nothing and is not geometry (a commit
 * writes none; an authored one reads the same). */
inline bool storesGeometry(const AudioNode& node) {
  const timing::TimeMap m = node.storedMap();
  if (m.n != 1) return m.n >= 2;
  const int64_t duration = node.getIntrinsicDuration();
  const bool whole_take = node.getNodeType() == NodeType::Clip &&
                          m.segs[0].start <= 0 && duration > 0 &&
                          m.segs[0].end >= duration;
  return m.segs[0].end > m.segs[0].start && !whole_take;
}

/** Install `fresh` (heap-owned and finalize()d, or null to clear) as
 * `stack`'s sequence. The displaced one retires through the reclaimer:
 * a callback in flight may still read it. */
inline void installSequence(GraphReclaimer& reclaimer, StackNode& stack,
                            const Sequence* fresh) {
  if (const Sequence* old = stack.exchangeSequence(fresh)) {
    reclaimer.retire([old] { delete old; });
  }
}

/** Retire a detached take record's content — buffer, notes, reserved
 * storage — through the reclaimer (never inline: a callback in flight
 * may still read it). */
inline void retireTake(GraphReclaimer& reclaimer, ClipNode::TakeState&& take) {
  const auto retire = [&reclaimer](auto owned) {
    if (auto* raw = owned.release()) reclaimer.retire([raw] { delete raw; });
  };
  retire(std::move(take.buffer));
  retire(std::move(take.midi));
  retire(std::move(take.storage));
}

// --- THE Q-DEFINER (definer.cc) ---------------------------------------

/**
 * Q13 FOR GROUPS (design_language.md Q13, the fractal twin of the sole
 * clip definer): the island's DEFINER STACK — a stack whose direct clip
 * children are the island's ONLY committed content and are ONE take (two
 * or more, one duration, one origin — the stack's own — none a
 * one-shot; a single committed clip keeps the clip-definer path,
 * whatever holds it), while its geometry is the island's only geometry
 * (ONLY GEOMETRY WINS, below). Its window then re-establishes (Q, zero)
 * exactly as a sole clip's does. Null otherwise. "One take" is read off
 * those facts: the engine keeps no record of which clips were performed
 * together.
 */
StackNode* definerStack(StackNode& root);

/**
 * A VALID DEFINER TARGET (Q22 — what a Q hand-off may name, and what a
 * stored designation must still be to count):
 *   - a CLIP: committed, not armed or recording, not a one-shot;
 *   - a STACK: not a one-shot, no active sequence, not armed or
 *     recording, and the definer stack's shape — its committed DIRECT
 *     clip children are one take, no nested stack holds committed
 *     content — without "the island's only content";
 *   - WARP GUARD: no ancestor strictly between it and `root` remaps
 *     time (an active map, an active sequence or a one-shot fold —
 *     every way a stack remaps its children's clock, heard::
 *     foldedClockAt), so its origin is a moment on the island's clock
 *     and (Q, zero) can be read off it.
 * Never the root itself.
 */
bool isDefinerTarget(const StackNode& root, const AudioNode& node);

/** SOLE: `node`'s subtree holds every committed clip of the island — the
 * Q13 definer (derived, or a designated one with no company). */
bool holdsAllCommittedContent(const StackNode& root, const AudioNode& node);

/**
 * THE Q-DEFINER, stated once: the ONE node whose window re-establishes
 * (Q, zero) and lock-collapses at the next arm. Null while a take is
 * armed or capturing (a take performs against the current grid). Then,
 * in order:
 *   1. the DESIGNATED definer (Q22 — the island root's
 *      definerDesignation, set by a setDefiner hand-off) while it names
 *      a valid definer target (a stack not under a step audition). No
 *      only-geometry-wins gate: other nodes' geometry drifts under its
 *      re-establishments instead of being stranded. A stale designation
 *      falls through, and stays stored: the undo that un-stales it
 *      revives it.
 *   2. THE DERIVED Q13 RULE: the island's sole committed clip, or its
 *      definer stack (unless a step audition overrides its map — a
 *      monitoring gesture is not a trim).
 * ONLY GEOMETRY WINS gates the derived rule: a re-establishment moves
 * the grid under every OTHER authored window or map, stranding geometry
 * that was coherent with the previous Q, so the derived definer stands
 * only while no node outside its subtree holds geometry in use
 * (storesGeometry; a BYPASSED map plays nothing and strands nothing).
 * EVERY gate lives here: the arm-time collapse, the map edits, the
 * Remove re-open, setTiming and the published `definerId` all ask this
 * and add nothing.
 */
AudioNode* definer(StackNode& root);

// --- THE TAKE SETTLE ---------------------------------------------------

/** One committed performance, as its settle logs it. */
struct CommittedTake {
  std::vector<ClipNode*> clips;  // the members that committed
  // The island facts the performance found: its undo restores the grid
  // with the content.
  int64_t q_before = 0;
  int64_t zero_before = 0;
  // A NEW TAKE of committed slots (docs/takes.md): per member, the take
  // that was active before it and — when the settle reset it — the
  // re-time the slot had (empty = the re-time stands).
  bool new_take = false;
  std::vector<int> prev_active;
  std::vector<int64_t> prev_retime;
};

/**
 * THE SETTLE OF A COMMITTED TAKE — recorded or imported, one home.
 * Returns the take's log entry for the caller to push: the INVERSE
 * (Untake), naming each member (a new take by its list index and the
 * take it displaced; a MIDI take with its instrument's state, docs/
 * vst3.md §8.4) and the island facts as they were before. A FIRST take of
 * its clips also settles the island around the new content, every
 * change riding the entry: the pre-Q geometry its establishment of Q
 * scrubs (AudioEngine::scrubIncoherentGeometry), then the anchors (so
 * undo and redo replay the two in one order), then a group take's
 * common region lifted onto the definer stack. Settled takes return
 * their reservation at once (AudioEngine::compactClipToHeap).
 */
Edit settleCommittedTake(AudioEngine& engine, StackNode& root,
                         const CommittedTake& take);

/** AudioEngine::settleAnchors, over an explicit island root. */
void settleAnchors(StackNode& root, Edit& inv);

}  // namespace celestrian::engine_internal
