// AudioEngine — BRIDGE VERBS: node CRUD, track templates, rename /
// reorder / combine, input routing, pan and gain, the fx rack (slot
// enable, params, chain order, plugin add / remove / revive), MIDI arm,
// monitoring, the effect scope, solo, mute and the period source. A verb
// either records an Edit — undoable, and it answers whether the edit was
// applied — or writes a mixer atomic, which is not. Message thread only.

#include "../audio_engine.h"

#include "../clip_node.h"
#include "../stack_node.h"
#include "../track_template.h"
#include "engine_internal.h"

namespace {
using celestrian::Edit;
}  // namespace

// --- Structure --------------------------------------------------------

bool AudioEngine::appendNode(const juce::String& parent_uuid,
                             std::unique_ptr<celestrian::AudioNode> node) {
  auto* parent = parent_uuid.isEmpty()
                     ? root_node.get()
                     : dynamic_cast<celestrian::StackNode*>(
                           findNodeByUuid(parent_uuid));
  if (parent == nullptr || node == nullptr) return false;
  // One Insert: the same node is kept by the log and re-inserted, so its
  // uuid and state survive undo and redo.
  Edit e(Edit::Kind::Insert);
  e.parentUuid = parent->getUuid();
  e.index = parent->getNumChildren();
  e.node = std::move(node);
  return record(std::move(e));
}

bool AudioEngine::createNode(const juce::String& type,
                             const juce::String& parent_uuid,
                             juce::String* created) {
  std::unique_ptr<celestrian::AudioNode> node;
  if (type == "clip") {
    node = std::make_unique<celestrian::ClipNode>("New Clip",
                                                  cached_sample_rate_.load());
  } else {
    node = std::make_unique<celestrian::StackNode>("New Stack");
  }
  const juce::String uuid = node->getUuid();
  if (!appendNode(parent_uuid, std::move(node))) return false;
  if (created != nullptr) *created = uuid;
  return true;
}

juce::var AudioEngine::captureTrackTemplate(const juce::String& uuid) const {
  auto* node = findNodeByUuid(uuid);
  // The root is a session, not a track (docs/projects.md).
  if (node == nullptr || node == root_node.get()) return {};
  // Q rides along so a group's sequence captures as Q counts (S14).
  return celestrian::track_templates::capture(*node, root_node->getQuantum());
}

bool AudioEngine::insertTrackTemplate(const juce::var& tpl,
                                      const juce::String& parent_uuid) {
  // A group template lands, and leaves, as one edit (Q17).
  return appendNode(parent_uuid, celestrian::track_templates::build(
                                     tpl, cached_sample_rate_.load(),
                                     root_node->getQuantum()));
}

bool AudioEngine::deleteNode(const juce::String& uuid) {
  Edit e(Edit::Kind::Remove);
  e.uuid = uuid;
  return record(std::move(e));
}

// AN EDIT THAT WOULD CHANGE NOTHING IS NOT RECORDED: it would log an
// empty undo step and drop the redo branch (the map commit's law,
// engine/map_edits.cc commitMap). Each verb below that can be asked for
// what the node already has answers false first.

bool AudioEngine::renameNode(const juce::String& uuid,
                             const juce::String& new_name) {
  const auto* node = findNodeByUuid(uuid);
  if (node == nullptr || node->getName() == new_name) return false;
  Edit e(Edit::Kind::Rename);
  e.uuid = uuid;
  e.s1 = new_name;
  return record(std::move(e));
}

bool AudioEngine::reorderNode(const juce::String& node_uuid,
                              const juce::String& new_parent_uuid,
                              int new_index) {
  // The slot the node is in: the same parent, at the index it would
  // land on once it had left (an index past either end is that end).
  int index = -1;
  if (auto* parent = parentOf(findNodeByUuid(node_uuid), &index);
      parent != nullptr && parent->getUuid() == new_parent_uuid &&
      index == juce::jlimit(0, parent->getNumChildren() - 1, new_index)) {
    return false;
  }
  Edit e(Edit::Kind::Move);
  e.uuid = node_uuid;
  e.parentUuid = new_parent_uuid;
  e.index = new_index;
  return record(std::move(e));
}

juce::String AudioEngine::combineNodes(const juce::String& dragged_uuid,
                                       const juce::String& target_uuid) {
  Edit e(Edit::Kind::Combine);
  e.uuid = dragged_uuid;
  e.uuid2 = target_uuid;
  if (!record(std::move(e))) return {};
  return undo_.back().uuid;  // the entry it logged names the new stack
}

// --- Node facts -------------------------------------------------------

bool AudioEngine::setNodeInput(const juce::String& uuid, int channel_index) {
  const auto* clip = dynamic_cast<celestrian::ClipNode*>(findNodeByUuid(uuid));
  if (clip == nullptr || clip->getInputChannel() == channel_index) return false;
  Edit e(Edit::Kind::Input);
  e.uuid = uuid;
  e.i1 = channel_index;
  return record(std::move(e));
}

bool AudioEngine::setNodeInputRight(const juce::String& uuid,
                                    int channel_index) {
  const auto* clip = dynamic_cast<celestrian::ClipNode*>(findNodeByUuid(uuid));
  if (clip == nullptr || clip->getInputChannelRight() == channel_index) {
    return false;
  }
  Edit e(Edit::Kind::InputR);
  e.uuid = uuid;
  e.i1 = channel_index;
  return record(std::move(e));
}

bool AudioEngine::toggleMute(const juce::String& uuid) {
  auto* node = findNodeByUuid(uuid);
  if (node == nullptr) return false;
  Edit e(Edit::Kind::Mute);
  e.uuid = uuid;
  e.b1 = !node->is_muted.load();
  return record(std::move(e));
}

bool AudioEngine::setPeriodSource(const juce::String& uuid,
                                  celestrian::PeriodSource source) {
  // A musical fact — it changes what sounds when — so unlike the mixer
  // knobs it is an edit.
  const bool from_context = source == celestrian::PeriodSource::CONTEXT_CYCLE;
  auto* node = findNodeByUuid(uuid);
  if (node == nullptr || node->period_from_context_.load() == from_context) {
    return false;
  }
  // A one-shot adopts its scope's cycle, so a node holding ALL of the
  // island's committed content would leave nothing to define one.
  if (from_context && celestrian::engine_internal::holdsAllCommittedContent(
                          *root_node, *node)) {
    juce::Logger::writeToLog(
        "AudioEngine::setPeriodSource refused - " + uuid +
        " holds all of the island's committed content; something must "
        "define the cycle a one-shot fires in");
    return false;
  }
  Edit e(Edit::Kind::PeriodSource);
  e.uuid = uuid;
  e.b1 = from_context;
  return record(std::move(e));
}

// --- Mixer and monitoring (not edits) ---------------------------------

void AudioEngine::setNodePan(const juce::String& uuid, double pan) {
  if (auto* node = findNodeByUuid(uuid)) {
    node->pan.store((float)juce::jlimit(-1.0, 1.0, pan));
  }
}

void AudioEngine::setNodeGain(const juce::String& uuid, double gain) {
  // Unity is the ceiling (the no-boost law).
  if (auto* node = findNodeByUuid(uuid)) {
    node->gain.store((float)juce::jlimit(0.0, 1.0, gain));
  }
}

void AudioEngine::toggleSolo(const juce::String& uuid) {
  // The audio thread reads the flags every callback (Q16), so there is
  // nothing to republish.
  if (auto* node = findNodeByUuid(uuid)) {
    node->is_soloed.store(!node->is_soloed.load());
  }
}

bool AudioEngine::setMonitor(const juce::String& uuid, bool on) {
  auto* clip = dynamic_cast<celestrian::ClipNode*>(findNodeByUuid(uuid));
  if (clip == nullptr) return false;
  clip->setMonitoring(on);
  return true;
}

void AudioEngine::setMidiArmed(const juce::String& uuid, bool on) {
  // Single-armed: every flag clears first, then the target's sets.
  celestrian::engine_internal::forEachNode(
      *root_node,
      [](celestrian::AudioNode& node) { node.midi_armed.store(false); });
  if (!on) return;
  if (auto* node = findNodeByUuid(uuid)) {
    // Prepared first: the armed chain runs every block from the next
    // callback on, instrument included.
    prepareEffects(*node);
    node->midi_armed.store(true);
  }
}

// --- The fx rack ------------------------------------------------------

void AudioEngine::prepareEffects(celestrian::AudioNode& node) const {
  const double sample_rate = currentSampleRateOrFallback();
  node.fxChain()->prepare(sample_rate);
  node.fxScope().prepare(sample_rate);
}

bool AudioEngine::setSlotEnabled(const juce::String& uuid,
                                 const juce::String& slot_uuid, bool enabled) {
  auto* node = findNodeByUuid(uuid);
  if (node == nullptr) return false;
  // Prepared BEFORE the flag flips: the audio thread must never see an
  // enabled slot whose buffers are not allocated.
  prepareEffects(*node);
  auto* slot = node->fxChain()->findSlot(slot_uuid);
  if (slot == nullptr) return false;
  slot->enabled.store(enabled);
  return true;
}

void AudioEngine::setSlotParam(const juce::String& uuid,
                               const juce::String& slot_uuid,
                               const juce::String& key, double value) {
  if (auto* node = findNodeByUuid(uuid)) {
    if (auto* slot = node->fxChain()->findSlot(slot_uuid)) {
      slot->setParam(key, value);
    }
  }
}

void AudioEngine::setEffectScope(const juce::String& uuid, bool active) {
  if (auto* node = findNodeByUuid(uuid)) {
    // The scope can open before any slot is enabled: prepared here, the
    // ring exists when the audio thread starts capturing.
    if (active) prepareEffects(*node);
    node->fxScope().setActive(active);
  }
}

bool AudioEngine::moveChainSlot(const juce::String& uuid,
                                const juce::String& slot_uuid, int new_index) {
  Edit e(Edit::Kind::MoveSlot);
  e.uuid = uuid;
  e.s1 = slot_uuid;
  e.index = new_index;
  return record(std::move(e));
}

bool AudioEngine::addPluginSlotToChain(
    const juce::String& uuid, std::shared_ptr<celestrian::dsp::FxSlot> slot,
    int index) {
  // The node may have been deleted while the plugin instantiated.
  if (slot == nullptr || findNodeByUuid(uuid) == nullptr) return false;
  // Prepared before it is published, like every slot (setSlotEnabled).
  slot->prepare(currentSampleRateOrFallback());
  slot->enabled.store(true);  // an added plugin arrives audible
  Edit e(Edit::Kind::AddSlot);
  e.uuid = uuid;
  e.index = index;
  e.slot = std::move(slot);
  return record(std::move(e));
}

bool AudioEngine::removeChainSlot(const juce::String& uuid,
                                  const juce::String& slot_uuid) {
  // Plugin slots only: the built-in effects are the panel's fixed cards.
  auto* node = findNodeByUuid(uuid);
  auto* slot = node != nullptr ? node->fxChain()->findSlot(slot_uuid) : nullptr;
  if (slot == nullptr || juce::String(slot->typeId()) != "vst3") return false;
  Edit e(Edit::Kind::RemoveSlot);
  e.uuid = uuid;
  e.s1 = slot_uuid;
  return record(std::move(e));
}

celestrian::dsp::Vst3Slot* AudioEngine::vst3SlotFor(
    const juce::String& uuid, const juce::String& slot_uuid) {
  auto* node = findNodeByUuid(uuid);
  return node == nullptr ? nullptr
                         : dynamic_cast<celestrian::dsp::Vst3Slot*>(
                               node->fxChain()->findSlot(slot_uuid));
}

void AudioEngine::forEachVst3Placeholder(
    const std::function<void(const juce::String& node_uuid,
                             const juce::String& slot_uuid,
                             const juce::String& plugin_uid)>& visit) {
  // The root included: the master chain can carry plugins too.
  celestrian::engine_internal::forEachNode(
      *root_node, [&](celestrian::AudioNode& node) {
        for (const auto& slot : node.fxChain()->slots()) {
          auto* plugin = dynamic_cast<celestrian::dsp::Vst3Slot*>(slot.get());
          if (plugin != nullptr && plugin->isMissing()) {
            visit(node.getUuid(), plugin->slotUuid(), plugin->pluginUid());
          }
        }
      });
}

void AudioEngine::reviveVst3Slot(
    const juce::String& uuid, const juce::String& slot_uuid,
    std::unique_ptr<juce::AudioPluginInstance> instance) {
  auto* node = findNodeByUuid(uuid);
  if (node == nullptr || instance == nullptr) return;
  celestrian::dsp::FxChain* chain = node->fxChain();
  const int at = chain->indexOfSlot(slot_uuid);
  auto* placeholder =
      dynamic_cast<celestrian::dsp::Vst3Slot*>(chain->findSlot(slot_uuid));
  if (at < 0 || placeholder == nullptr || !placeholder->isMissing()) return;

  // A LIVE twin: the same slot uuid and identity, the kept state applied
  // after prepare. Not an edit — revival restores what the session
  // already means.
  auto live = std::make_shared<celestrian::dsp::Vst3Slot>(
      std::move(instance), placeholder->pluginUid(),
      placeholder->displayName(), placeholder->fileOrIdentifier(),
      placeholder->isInstrument(), placeholder->pluginFormat());
  live->setSlotUuid(placeholder->slotUuid());
  live->prepare(currentSampleRateOrFallback());
  live->restoreState(placeholder->stateBlob());
  live->enabled.store(placeholder->enabled.load());

  auto slots = chain->slots();
  slots[(size_t)at] = std::move(live);
  installSlots(*node, std::move(slots));
  juce::Logger::writeToLog("AudioEngine: revived plugin slot " + slot_uuid +
                           " on " + uuid);
}
