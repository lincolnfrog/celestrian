// AudioEngine — the appliers of a node's FACTS: its name, mute, period
// source and input channels, a stack's sequence and its bypass, and the
// effect chain's structure (MoveSlot, AddSlot, RemoveSlot). Each swaps
// one value or one published object; the inverse carries what it
// displaced. Message thread only.

#include "../audio_engine.h"

#include "../clip_node.h"
#include "../dsp/fx_chain.h"
#include "../stack_node.h"
#include "edit_internal.h"
#include "engine_internal.h"

namespace {
using celestrian::AudioNode;
using celestrian::ClipNode;
using celestrian::Edit;
using celestrian::StackNode;
using celestrian::edit_internal::swapFact;
}  // namespace

Edit AudioEngine::applyRename(Edit e) {
  return swapFact<AudioNode>(
      findNodeByUuid(e.uuid), e, &Edit::s1,
      [](AudioNode& node) { return node.getName(); },
      [](AudioNode& node, const juce::String& name) { node.setName(name); });
}

Edit AudioEngine::applyMute(Edit e) {
  return swapFact<AudioNode>(
      findNodeByUuid(e.uuid), e, &Edit::b1,
      [](AudioNode& node) { return node.is_muted.load(); },
      [](AudioNode& node, bool muted) { node.is_muted.store(muted); });
}

Edit AudioEngine::applyPeriodSource(Edit e) {
  return swapFact<AudioNode>(
      findNodeByUuid(e.uuid), e, &Edit::b1,
      [](AudioNode& node) { return node.period_from_context_.load(); },
      [](AudioNode& node, bool from_context) {
        node.period_from_context_.store(from_context);
      });
}

Edit AudioEngine::applyInput(Edit e) {
  return swapFact<ClipNode>(
      findNodeByUuid(e.uuid), e, &Edit::i1,
      [](ClipNode& clip) { return (int64_t)clip.getInputChannel(); },
      [](ClipNode& clip, int64_t channel) {
        clip.setInputChannel((int)channel);
      });
}

Edit AudioEngine::applyInputR(Edit e) {
  return swapFact<ClipNode>(
      findNodeByUuid(e.uuid), e, &Edit::i1,
      [](ClipNode& clip) { return (int64_t)clip.getInputChannelRight(); },
      [](ClipNode& clip, int64_t channel) {
        clip.setInputChannelRight((int)channel);
      });
}

Edit AudioEngine::applySequenceBypass(Edit e) {
  return swapFact<StackNode>(
      findNodeByUuid(e.uuid), e, &Edit::b1,
      [](StackNode& stack) { return stack.isSequenceBypassed(); },
      [](StackNode& stack, bool bypassed) {
        stack.setSequenceBypassed(bypassed);
      });
}

std::unique_ptr<celestrian::Sequence> AudioEngine::swapSequence(
    StackNode& stack, const celestrian::Sequence* fresh) {
  std::unique_ptr<celestrian::Sequence> displaced;
  if (const celestrian::Sequence* old = stack.sequencePtr()) {
    displaced = std::make_unique<celestrian::Sequence>(*old);
  }
  celestrian::engine_internal::installSequence(
      *this, stack,
      fresh != nullptr ? new celestrian::Sequence(*fresh) : nullptr);
  return displaced;
}

Edit AudioEngine::applySequence(Edit e) {
  auto* stack = dynamic_cast<StackNode*>(findNodeByUuid(e.uuid));
  if (!stack) return {};
  Edit inv(Edit::Kind::Sequence);
  inv.uuid = e.uuid;
  // The step audition names a step by INDEX: it follows a resize, but a
  // change of step count would silently re-aim it at a neighbour.
  const celestrian::Sequence* old = stack->sequencePtr();
  const int steps_before = old != nullptr ? old->numSteps() : 0;
  const int steps_after = e.seq != nullptr ? e.seq->numSteps() : 0;
  if (steps_before != steps_after) stack->setAuditionStep(-1);
  // The inverse holds the RAW old sequence: a bypassed one survives undo.
  inv.seq = swapSequence(*stack, e.seq.get());
  return inv;
}

void AudioEngine::installSlots(
    AudioNode& node,
    std::vector<std::shared_ptr<celestrian::dsp::FxSlot>> slots) {
  retireOwned(std::unique_ptr<celestrian::dsp::FxChain>(node.exchangeFxChain(
      celestrian::dsp::FxChain::makeFromSlots(std::move(slots)).release())));
}

Edit AudioEngine::applyMoveSlot(Edit e) {
  auto* node = findNodeByUuid(e.uuid);
  if (!node) return {};
  auto slots = node->fxChain()->slots();
  const int from = node->fxChain()->indexOfSlot(e.s1);
  const int to = juce::jlimit(0, (int)slots.size() - 1, e.index);
  if (from < 0 || from == to) return {};
  Edit inv(Edit::Kind::MoveSlot);
  inv.uuid = e.uuid;
  inv.s1 = e.s1;
  inv.index = from;
  auto moved = slots[(size_t)from];
  slots.erase(slots.begin() + from);
  slots.insert(slots.begin() + to, std::move(moved));
  installSlots(*node, std::move(slots));
  return inv;
}

Edit AudioEngine::applyAddSlot(Edit e) {
  auto* node = findNodeByUuid(e.uuid);
  if (!node || e.slot == nullptr) return {};
  auto slots = node->fxChain()->slots();
  const int slot_count = (int)slots.size();
  const int to =
      e.index < 0 ? slot_count : juce::jlimit(0, slot_count, e.index);
  Edit inv(Edit::Kind::RemoveSlot);
  inv.uuid = e.uuid;
  inv.s1 = e.slot->slotUuid();
  // A slot the log held was out of the device-start sweep's reach: it
  // follows the device's rate before any chain holds it again.
  e.slot->followRate(currentSampleRateOrFallback());
  slots.insert(slots.begin() + to, e.slot);
  installSlots(*node, std::move(slots));
  return inv;
}

Edit AudioEngine::applyRemoveSlot(Edit e) {
  auto* node = findNodeByUuid(e.uuid);
  if (!node) return {};
  const int from = node->fxChain()->indexOfSlot(e.s1);
  if (from < 0) return {};
  auto slots = node->fxChain()->slots();
  Edit inv(Edit::Kind::AddSlot);
  inv.uuid = e.uuid;
  inv.index = from;
  inv.slot = slots[(size_t)from];  // the inverse keeps the instance alive
  slots.erase(slots.begin() + from);
  installSlots(*node, std::move(slots));
  return inv;
}
