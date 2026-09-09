#pragma once

// Tree queries shared by the AudioEngine implementation files under
// src/engine/ (defined in island_geometry.cc) — message thread only:
// they walk the OWNERSHIP tree, never the audio-thread snapshot — plus
// the block render-context builder (renderContext) the audio callback
// and the offline bounce share, which is audio-thread safe. Not part
// of the engine's public surface.

#include "../clip_node.h"
#include "../graph_snapshot.h"
#include "../stack_node.h"

namespace celestrian::engine_internal {

/**
 * THE RENDER FACTS OF ONE BLOCK, built the one way (docs/bounce.md):
 * the island facts read as one consistent triple, the snapshot, the
 * clock as both received and invariant position, the solo scan and the
 * context-cycle seed. The audio callback adds its per-callback inputs
 * (rings, live MIDI, latencies) on top; the bounce adds nothing — that
 * is what makes a bounce the live render, offline. Audio-thread safe:
 * atomics and snapshot reads only, no allocation.
 */
inline ProcessContext renderContext(StackNode& root, const GraphSnapshot& snap,
                                    double sample_rate, int num_samples,
                                    int64_t clock, bool is_playing) {
  ProcessContext pc;
  pc.sample_rate = sample_rate;
  pc.num_samples = num_samples;
  pc.is_playing = is_playing;
  pc.master_pos = clock;
  // (Q, epoch, generation) as ONE fact (StackNode::readIslandFacts —
  // a re-trim between separate reads would hand a block a mixed pair).
  const StackNode::IslandFacts island_facts = root.readIslandFacts();
  // Cycle-top of the island frame — loop-window time-maps phase off
  // this (time_maps.md); windowed stacks re-base it for their children.
  pc.cycle_epoch = island_facts.epoch;
  pc.snap = &snap;
  pc.self = 0;
  // Solo canon (Q16): one snapshot scan per block answers "is any solo
  // lit anywhere?" — leaves then resolve their own ancestry.
  pc.any_solo = snapAnySolo(snap);
  pc.quantum = island_facts.quantum;
  pc.island_generation = island_facts.generation;
  pc.stop_generation = root.stopGeneration();
  pc.island_epoch = pc.cycle_epoch;
  pc.island = &root;
  // The invariant monotonic clock (master_pos twin of island_epoch):
  // mapping stacks fold master_pos on the way down but never this.
  pc.island_pos = clock;
  // Context-cycle seed (Q5 one-shots): the island's audible cycle.
  // Each stack recomputes it for its own scope in childContext; this
  // seed is the fallback an all-one-shot ROOT scope inherits.
  pc.context_cycle =
      snapEffectiveCycle(snap, pc.quantum, (int64_t)sample_rate);
  return pc;
}

/**
 * Q13 FOR GROUPS (design_language.md Q13, the fractal twin of the sole
 * clip definer): the island's DEFINER STACK — a stack whose direct clip
 * children are the island's ONLY committed content and were recorded
 * as ONE take (identical origin and duration), two or more of them (a
 * single committed clip keeps the clip-definer path, whatever holds
 * it). Its window then re-establishes (Q, epoch) exactly as a sole
 * clip's does. Null otherwise.
 */
celestrian::StackNode* definerStack(celestrian::AudioNode* root);

/**
 * ONLY GEOMETRY WINS: a Q13 re-establishment moves the grid under every
 * OTHER authored window or map in the island — geometry coherent with
 * the previous Q is stranded permanently incoherent with the new one.
 * So the definer re-establishes only while its own geometry is the
 * island's ONLY geometry. Walks the island skipping the definer's
 * subtree; a window spanning a clip's whole take restricts nothing and
 * is not geometry.
 */
bool hasActiveGeometryOutside(celestrian::AudioNode* node,
                              celestrian::AudioNode* exclude);

/** The first committed clip in `node`'s subtree (ownership order), or
 * null when none is committed. */
celestrian::ClipNode* firstCommittedClip(celestrian::AudioNode* node);

/**
 * THE Q13 DEFINER, stated once: the ONE node whose window re-establishes
 * (Q, epoch) and lock-collapses at the next arm — the island's sole
 * committed clip, or its definer STACK (above) — and only while its
 * geometry is the island's ONLY geometry (hasActiveGeometryOutside),
 * no take is armed or capturing (a take performs against the current
 * grid), and no step audition overrides a stack's map (a monitoring
 * gesture is not a trim). Null otherwise. EVERY gate lives here: the
 * arm-time collapse, the map edits, the Remove re-open and the
 * published `definerId` all ask this and add nothing.
 */
celestrian::AudioNode* definer(celestrian::StackNode& root);

}  // namespace celestrian::engine_internal
