// AudioEngine — BRIDGE VERBS: node CRUD, track templates, rename /
// reorder / combine, input routing, pan and gain, the fx rack (slot
// enable, params, chain order, VST3 add / remove / revive), MIDI arm,
// the effect scope, solo, mute and the period source. Each verb either
// records an Edit (undoable) or writes a mixer atomic (not). Message
// thread only.

#include "../audio_engine.h"

#include "../clip_node.h"
#include "../stack_node.h"
#include "../track_template.h"

void AudioEngine::createNode(const juce::String& type,
                             const juce::String& parent_uuid) {
  // Find target parent stack
  celestrian::StackNode* target_stack = nullptr;

  if (!parent_uuid.isEmpty()) {
    // Use specified parent
    auto* parent_node = findNodeByUuid(root_node.get(), parent_uuid);
    target_stack = dynamic_cast<celestrian::StackNode*>(parent_node);
  } else {
    target_stack = root_node.get();  // default: the root
  }

  if (!target_stack) {
    juce::Logger::writeToLog("createNode: No valid stack target found");
    return;
  }

  std::unique_ptr<celestrian::AudioNode> new_node;
  if (type == "clip") {
    // Clip buffers and metadata carry the actual device rate.
    new_node = std::make_unique<celestrian::ClipNode>(
        "New Clip", cached_sample_rate_.load());
  } else if (type == "stack") {
    new_node = std::make_unique<celestrian::StackNode>("New Stack");
  } else {
    new_node = std::make_unique<celestrian::StackNode>("New Stack");
  }

  new_node->setParent(target_stack);
  // Visual positioning is handled by the frontend.
  // Backend only manages ordered list membership. Routed through the
  // edit log so create is undoable (the same node is retained and
  // re-inserted, so uuid/state survive undo→redo).
  celestrian::Edit e(celestrian::Edit::Kind::Insert);
  e.parentUuid = target_stack->getUuid();
  e.index = target_stack->getNumChildren();  // append
  e.node = std::move(new_node);
  record(std::move(e));
}

juce::var AudioEngine::captureTrackTemplate(const juce::String& uuid) const {
  auto* node = const_cast<AudioEngine*>(this)->findNodeByUuid(root_node.get(),
                                                              uuid);
  // The island root is a session, not a track — that is what
  // whole-session templates (projects.md) are for.
  if (node == nullptr || node == root_node.get()) return {};
  // Q rides along so a group's SEQUENCE captures as Q counts (S14).
  return celestrian::track_templates::capture(*node, root_node->getQuantum());
}

bool AudioEngine::insertTrackTemplate(const juce::var& tpl,
                                      const juce::String& parent_uuid) {
  // Same parent resolution as createNode: explicit parent, else the
  // focused stack (the island root in the single-level flow).
  celestrian::StackNode* target_stack = nullptr;
  if (!parent_uuid.isEmpty()) {
    target_stack = dynamic_cast<celestrian::StackNode*>(
        findNodeByUuid(root_node.get(), parent_uuid));
  } else {
    target_stack = root_node.get();
  }
  if (!target_stack) return false;

  auto built = celestrian::track_templates::build(
      tpl, cached_sample_rate_.load(), root_node->getQuantum());
  if (!built) return false;

  built->setParent(target_stack);
  // ONE undoable insert (Q17): a group template lands whole — 5 named,
  // routed tracks arrive and depart the undo log as a single edit.
  celestrian::Edit e(celestrian::Edit::Kind::Insert);
  e.parentUuid = target_stack->getUuid();
  e.index = target_stack->getNumChildren();  // append
  e.node = std::move(built);
  record(std::move(e));
  return true;
}

void AudioEngine::renameNode(const juce::String& uuid,
                             const juce::String& new_name) {
  celestrian::Edit e(celestrian::Edit::Kind::Rename);
  e.uuid = uuid;
  e.s1 = new_name;
  record(std::move(e));
}

void AudioEngine::reorderNode(const juce::String& node_uuid,
                              const juce::String& new_parent_uuid,
                              int new_index) {
  // Routed through the edit log (Move): the detach/insert dance and its
  // exact-inverse (back to the old parent/index) live in applyEdit.
  celestrian::Edit e(celestrian::Edit::Kind::Move);
  e.uuid = node_uuid;
  e.parentUuid = new_parent_uuid;
  e.index = new_index;
  record(std::move(e));
}

juce::String AudioEngine::combineNodes(const juce::String& dragged_uuid,
                                       const juce::String& target_uuid) {
  // The whole combine (detach both, build the stack target-first, insert
  // at the target's slot) lives in applyEdit(Combine); its inverse is an
  // Explode that restores each child to its original parent/index. We
  // record the inverse directly here (rather than via record()) so we can
  // still return the new stack's uuid to the frontend.
  celestrian::Edit e(celestrian::Edit::Kind::Combine);
  e.uuid = dragged_uuid;
  e.uuid2 = target_uuid;
  celestrian::Edit inv = applyEdit(std::move(e));
  if (inv.kind == celestrian::Edit::Kind::Nop) return {};
  const juce::String new_uuid = inv.uuid;  // Explode carries the new stack
  pushUndo(std::move(inv));
  juce::Logger::writeToLog("combineNodes: Combined " + dragged_uuid + " + " +
                           target_uuid + " into stack " + new_uuid);
  return new_uuid;
}

void AudioEngine::setNodeInput(const juce::String& uuid, int channel_index) {
  celestrian::Edit e(celestrian::Edit::Kind::Input);
  e.uuid = uuid;
  e.d1 = (double)channel_index;
  record(std::move(e));
}

void AudioEngine::setNodeInputRight(const juce::String& uuid,
                                    int channel_index) {
  celestrian::Edit e(celestrian::Edit::Kind::InputR);
  e.uuid = uuid;
  e.d1 = (double)channel_index;
  record(std::move(e));
}

void AudioEngine::setNodePan(const juce::String& uuid, double pan) {
  // A mixer knob, not an edit event: non-undoable by the same ruling as
  // effect params (dial drags would flood the undo log).
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    node->pan.store((float)juce::jlimit(-1.0, 1.0, pan));
  }
}

void AudioEngine::setNodeGain(const juce::String& uuid, double gain) {
  // A mixer knob like pan: non-undoable, clamped to [0, 1] (unity is
  // the ceiling — the no-boost law).
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    node->gain.store((float)juce::jlimit(0.0, 1.0, gain));
  }
}

void AudioEngine::prepareEffects(celestrian::AudioNode& node) const {
  double sample_rate = cached_sample_rate_.load();
  if (sample_rate <= 0) sample_rate = kFallbackSampleRate;
  node.fxChain()->prepare(sample_rate);
  node.fxScope().prepare(sample_rate);
}

void AudioEngine::setSlotEnabled(const juce::String& uuid,
                                 const juce::String& slot_uuid, bool enabled) {
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    // Prepare BEFORE the flag flips: the audio thread must never see an
    // enabled slot whose buffers aren't allocated. Idempotent per rate.
    prepareEffects(*node);
    if (auto* slot = node->fxChain()->findSlot(slot_uuid)) {
      slot->enabled.store(enabled);
      juce::Logger::writeToLog("AudioEngine: slot " + slot_uuid + " (" +
                               slot->typeId() + ") on " + uuid +
                               (enabled ? " ENABLED" : " DISABLED"));
    }
  }
}

void AudioEngine::setSlotParam(const juce::String& uuid,
                               const juce::String& slot_uuid,
                               const juce::String& key, double value) {
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    if (auto* slot = node->fxChain()->findSlot(slot_uuid)) {
      slot->setParam(key, value);
    }
  }
}

void AudioEngine::moveChainSlot(const juce::String& uuid,
                                const juce::String& slot_uuid, int new_index) {
  // Chain STRUCTURE is undoable (docs/vst3.md §6) — unlike the
  // enable/param knobs, order is an arrangement fact.
  celestrian::Edit e(celestrian::Edit::Kind::MoveSlot);
  e.uuid = uuid;
  e.s1 = slot_uuid;
  e.index = new_index;
  record(std::move(e));
}

void AudioEngine::addVst3SlotToChain(
    const juce::String& uuid, std::shared_ptr<celestrian::dsp::FxSlot> slot,
    int index) {
  if (slot == nullptr) return;
  // Prepare BEFORE publication: the audio thread must never see an
  // unprepared instance (prepareEffects' rule, applied to the arriving
  // slot; the node lookup also guards a node deleted mid-instantiate).
  auto* node = findNodeByUuid(root_node.get(), uuid);
  if (node == nullptr) return;
  double sample_rate = cached_sample_rate_.load();
  if (sample_rate <= 0) sample_rate = kFallbackSampleRate;
  slot->prepare(sample_rate);
  slot->enabled.store(true);  // an added plugin arrives audible
  celestrian::Edit e(celestrian::Edit::Kind::AddSlot);
  e.uuid = uuid;
  e.index = index;
  e.slot = std::move(slot);
  record(std::move(e));
}

void AudioEngine::removeChainSlot(const juce::String& uuid,
                                  const juce::String& slot_uuid) {
  // VST3 slots only for now: the built-in four are the panel's fixed
  // cards (docs/vst3.md §6 — removal UI exists on plugin chips alone).
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    auto* slot = node->fxChain()->findSlot(slot_uuid);
    if (slot == nullptr || juce::String(slot->typeId()) != "vst3") return;
  } else {
    return;
  }
  celestrian::Edit e(celestrian::Edit::Kind::RemoveSlot);
  e.uuid = uuid;
  e.s1 = slot_uuid;
  record(std::move(e));
}

celestrian::dsp::Vst3Slot* AudioEngine::vst3SlotFor(
    const juce::String& uuid, const juce::String& slot_uuid) {
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    return dynamic_cast<celestrian::dsp::Vst3Slot*>(
        node->fxChain()->findSlot(slot_uuid));
  }
  return nullptr;
}

void AudioEngine::forEachVst3Placeholder(
    const std::function<void(const juce::String& node_uuid,
                             const juce::String& slot_uuid,
                             const juce::String& plugin_uid)>& visit) {
  // Message-thread walk over the ownership tree (root included — the
  // master chain can carry plugins too).
  std::function<void(celestrian::AudioNode&)> walk =
      [&](celestrian::AudioNode& node) {
        for (const auto& slot : node.fxChain()->slots()) {
          if (auto* v = dynamic_cast<celestrian::dsp::Vst3Slot*>(slot.get()))
            if (v->isMissing())
              visit(node.getUuid(), v->slotUuid(), v->pluginUid());
        }
        if (auto* stack = dynamic_cast<celestrian::StackNode*>(&node))
          for (const auto& child : stack->ownedChildren()) walk(*child);
      };
  walk(*root_node);
}

void AudioEngine::reviveVst3Slot(
    const juce::String& uuid, const juce::String& slot_uuid,
    std::unique_ptr<juce::AudioPluginInstance> instance) {
  auto* node = findNodeByUuid(root_node.get(), uuid);
  if (node == nullptr || instance == nullptr) return;
  celestrian::dsp::FxChain* chain = node->fxChain();
  const int at = chain->indexOfSlot(slot_uuid);
  auto* placeholder =
      dynamic_cast<celestrian::dsp::Vst3Slot*>(chain->findSlot(slot_uuid));
  if (at < 0 || placeholder == nullptr || !placeholder->isMissing()) return;

  // A LIVE twin: same slot uuid + identity, the kept state applied
  // after prepare. Published as a successor chain; NOT an undo edit
  // (revival restores what the session already means).
  auto live = std::make_shared<celestrian::dsp::Vst3Slot>(
      std::move(instance), placeholder->pluginUid(),
      placeholder->displayName(), placeholder->fileOrIdentifier(),
      placeholder->isInstrument());
  live->setSlotUuid(placeholder->slotUuid());
  double sample_rate = cached_sample_rate_.load();
  if (sample_rate <= 0) sample_rate = kFallbackSampleRate;
  live->prepare(sample_rate);
  live->restoreState(placeholder->stateBlob());
  live->enabled.store(placeholder->enabled.load());

  auto slots = chain->slots();
  slots[(size_t)at] = std::move(live);
  retireOwned(std::unique_ptr<celestrian::dsp::FxChain>(node->exchangeFxChain(
      celestrian::dsp::FxChain::makeFromSlots(std::move(slots)).release())));
  juce::Logger::writeToLog("AudioEngine: revived plugin slot " + slot_uuid +
                           " on " + uuid);
}

void AudioEngine::setMidiArmed(const juce::String& uuid, bool on) {
  // Single-armed: clear the whole graph first (message-thread walk),
  // then set the target. Disarming just clears everything and stops.
  std::function<void(celestrian::AudioNode&)> clear_all =
      [&](celestrian::AudioNode& node) {
        node.midi_armed.store(false);
        if (auto* stack = dynamic_cast<celestrian::StackNode*>(&node))
          for (const auto& child : stack->ownedChildren()) clear_all(*child);
      };
  clear_all(*root_node);
  if (!on) return;
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    // Prepare first: the armed chain runs every block from the next
    // callback on (instrument included).
    prepareEffects(*node);
    node->midi_armed.store(true);
    juce::Logger::writeToLog("AudioEngine: MIDI armed on " + uuid);
  }
}

void AudioEngine::setEffectScope(const juce::String& uuid, bool active) {
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    if (active) {
      // The scope can open before any slot is enabled — prepare so the
      // ring exists when the audio thread starts capturing
      prepareEffects(*node);
    }
    node->fxScope().setActive(active);
  }
}

void AudioEngine::toggleSolo(const juce::String& uuid) {
  // Solo canon (Q16): per-node flag — island-wide,
  // ADDITIVE (multiple solos sum, never radio-button), fractal (a
  // soloed stack covers its subtree via snapshot ancestry). The audio
  // thread re-reads the flags every callback, so no republish and no
  // resolved-pointer cache — deleting a soloed node just removes its
  // flag from the scan. Not undoable (a monitoring gesture; matches
  // the mock's UNDOABLE set).
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    const bool now = !node->is_soloed.load();
    node->is_soloed.store(now);
    juce::Logger::writeToLog("AudioEngine: Solo " +
                             juce::String(now ? "on" : "off") + " for " +
                             uuid);
  }
}

// There is no per-node Play/Stop (Q16): mute/solo + the one transport
// are the per-node play controls. ClipNode::is_playing is the internal
// content-sounds gate only.

void AudioEngine::toggleMute(const juce::String& uuid) {
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    celestrian::Edit e(celestrian::Edit::Kind::Mute);
    e.uuid = uuid;
    e.b1 = !node->is_muted.load();  // toggle to the opposite state
    record(std::move(e));
  }
}

void AudioEngine::setPeriodSource(const juce::String& uuid,
                                  celestrian::PeriodSource source) {
  // The Q5 knob: one-shot ⟺ period := context cycle. A MUSICAL fact
  // (changes what sounds when), so unlike the mixer knobs it rides the
  // edit log. Clips and stacks alike (Q18: a stack fires from its
  // origin like a clip — composition.md §2, the drum group as a
  // one-shot).
  const bool from_context = source == celestrian::PeriodSource::CONTEXT_CYCLE;
  auto* node = findNodeByUuid(root_node.get(), uuid);
  if (!node) return;
  if (node->period_from_context_.load() == from_context) return;
  celestrian::Edit e(celestrian::Edit::Kind::PeriodSource);
  e.uuid = uuid;
  e.b1 = from_context;
  record(std::move(e));
}
