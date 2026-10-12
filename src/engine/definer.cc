// THE Q-DEFINER: the pure tree queries that decide which node, if any,
// re-establishes the island's (Q, zero) — declared, with their laws, in
// engine_internal.h. Message thread only.

#include "engine_internal.h"

namespace celestrian::engine_internal {

int countCommittedClips(const AudioNode& node) {
  int count = 0;
  forEachClip(node, [&](const ClipNode& clip) {
    if (clip.getIntrinsicDuration() > 0) ++count;
  });
  return count;
}

namespace {

/** The first committed clip under `node` (ownership order), or null. */
ClipNode* firstCommittedClip(AudioNode& node) {
  ClipNode* first = nullptr;
  forEachClip(node, [&](ClipNode& clip) {
    if (first == nullptr && clip.getIntrinsicDuration() > 0) first = &clip;
  });
  return first;
}

/** THE DEFINER STACK'S SHAPE on one stack: its committed DIRECT clip
 * children are ONE take — two or more, one duration, none a one-shot (a
 * one-shot reads its period from context, Q5, so the stack would not be
 * one take looping as one part), all at ONE origin, and that origin the
 * STACK's: a group take anchors its stack where it starts and every
 * re-anchor since has moved the subtree as one (composition.md §5), so
 * the stack's map addresses each member's content from its top. Members
 * that agree only with each other — one re-timed off the stack, another
 * recorded where it then stood — are not it. No nested stack holds
 * committed content. */
bool isOneTakeStack(const StackNode& stack) {
  int direct = 0;
  // A stack holds committed content unanchored only until its take
  // settles (settleAnchors): its members then agree with each other.
  const bool anchored = stack.isAnchored();
  int64_t origin = stack.origin_samples.load(), duration = 0;
  for (const auto& child : stack.ownedChildren()) {
    if (child->getNodeType() != NodeType::Clip) {
      if (countCommittedClips(*child) > 0) return false;
      continue;
    }
    if (child->getIntrinsicDuration() <= 0) continue;
    if (child->periodFromContext()) return false;
    if (direct == 0) {
      if (!anchored) origin = child->origin_samples.load();
      duration = child->getIntrinsicDuration();
    }
    if (child->origin_samples.load() != origin ||
        child->getIntrinsicDuration() != duration) {
      return false;  // not one take of this stack
    }
    ++direct;
  }
  return direct >= 2;
}

/** The one-take stack that holds every committed clip under `stack`:
 * `stack` itself, or the one reached through WRAPPERS — stacks with no
 * committed clip of their own and exactly one child stack that holds
 * content. Null when there is none. */
StackNode* oneTakeStackUnder(StackNode& stack) {
  if (isOneTakeStack(stack)) return &stack;
  StackNode* nested = nullptr;
  for (const auto& child : stack.ownedChildren()) {
    if (countCommittedClips(*child) == 0) continue;
    if (child->getNodeType() != NodeType::Stack || nested != nullptr) {
      return nullptr;
    }
    nested = static_cast<StackNode*>(child.get());
  }
  return nested != nullptr ? oneTakeStackUnder(*nested) : nullptr;
}

/** ONLY GEOMETRY WINS (definer, engine_internal.h): does a node under
 * `node`, outside `exclude`'s subtree, hold geometry in use? A wrapper
 * between the root and a definer stack is such a node, so no definer is
 * ever read through a warp. */
bool hasActiveGeometryOutside(const AudioNode& node, const AudioNode* exclude) {
  if (&node == exclude) return false;
  if (!node.isLoopWindowBypassed() && storesGeometry(node)) return true;
  if (node.getNodeType() != NodeType::Stack) return false;
  for (const auto& child :
       static_cast<const StackNode&>(node).ownedChildren()) {
    if (hasActiveGeometryOutside(*child, exclude)) return true;
  }
  return false;
}

}  // namespace

StackNode* definerStack(StackNode& root) {
  StackNode* stack = oneTakeStackUnder(root);
  return stack != nullptr && !hasActiveGeometryOutside(root, stack) ? stack
                                                                    : nullptr;
}

bool isDefinerTarget(const StackNode& root, const AudioNode& node) {
  if (&node == &root) return false;
  if (node.periodFromContext() || node.isArmedOrRecording()) return false;
  if (node.getNodeType() == NodeType::Clip) {
    if (node.getIntrinsicDuration() <= 0) return false;
  } else {
    const auto* stack = dynamic_cast<const StackNode*>(&node);
    if (stack == nullptr || stack->activeSequence() != nullptr ||
        !isOneTakeStack(*stack)) {
      return false;
    }
  }
  const auto remaps_time = [](const AudioNode& ancestor) {
    return ancestor.isLoopWindowActive() || ancestor.activeSequenceLen() > 0 ||
           ancestor.periodFromContext();
  };
  return nearestAncestor(node, remaps_time, &root) == nullptr;
}

bool holdsAllCommittedContent(const StackNode& root, const AudioNode& node) {
  const int inside = countCommittedClips(node);
  return inside > 0 && inside == countCommittedClips(root);
}

AudioNode* definer(StackNode& root) {
  if (root.hasActiveTake()) return nullptr;
  if (const juce::String& id = root.definerDesignation(); id.isNotEmpty()) {
    if (auto* d = root.findByUuid(id); d != nullptr && isDefinerTarget(root, *d)) {
      const auto* stack = dynamic_cast<const StackNode*>(d);
      if (stack == nullptr || !stack->auditionActive()) return d;
    }
  }
  if (countCommittedClips(root) == 1) {
    ClipNode* clip = firstCommittedClip(root);
    return hasActiveGeometryOutside(root, clip) ? nullptr : clip;
  }
  StackNode* stack = definerStack(root);
  return stack != nullptr && !stack->auditionActive() ? stack : nullptr;
}

}  // namespace celestrian::engine_internal
