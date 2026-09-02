#pragma once

// Tree queries shared by the AudioEngine implementation files under
// src/engine/ (defined in island_geometry.cc). Message thread only:
// they walk the OWNERSHIP tree, never the audio-thread snapshot. Not
// part of the engine's public surface.

#include "../clip_node.h"
#include "../stack_node.h"

namespace celestrian::engine_internal {

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
 * subtree; a committed clip's full-span [0, D) window is commit
 * furniture, not geometry.
 */
bool hasActiveGeometryOutside(celestrian::AudioNode* node,
                              celestrian::AudioNode* exclude);

/** The first committed clip in `node`'s subtree (ownership order), or
 * null when none is committed. */
celestrian::ClipNode* firstCommittedClip(celestrian::AudioNode* node);

}  // namespace celestrian::engine_internal
