#include "audio_engine.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include "clip_node.h"
#include "rt_log.h"
#include "stack_node.h"
#include "timing.h"

// (The old scanCommitted lived here; the epoch re-base is now driven by
// the commit EVENT — StackNode::takeCommitted — not by callback edge
// detection. unification_audit.md §1.5.)

AudioEngine::AudioEngine() {
  // Start with an empty root stack
  auto root = std::make_unique<celestrian::StackNode>("SessionRoot");
  focused_node = root.get();
  root_node = std::move(root);
  publishGraph();

  // Pre-record ring: preallocated here so the audio thread never resizes it.
  prerecord_ring_.setSize(kPreRecordRingChannels, kPreRecordRingLen);
  prerecord_ring_.clear();
}

void AudioEngine::compactIdleTakes() {
  // D4 compaction (message thread): a committed take shrinks to exactly
  // its recorded material and the arm-time virtual reservation returns
  // to the OS. Safe under an actively RENDERING clip: content is
  // reached through one atomic pointer, and the old buffer retires
  // through the reclaimer (an in-flight callback may read it for ≤2
  // more callbacks — Step 3 lifetime discipline). Armed/recording
  // clips are never touched; keep = recordedLength (not duration!) so
  // a lock-collapsed definer keeps its dead air for uncollapse.
  const std::function<void(celestrian::StackNode &)> visit =
      [&](celestrian::StackNode &stack) {
        for (const auto &child : stack.ownedChildren()) {
          if (child->getNodeType() == celestrian::NodeType::Stack) {
            visit(static_cast<celestrian::StackNode &>(*child));
            continue;
          }
          auto &clip = static_cast<celestrian::ClipNode &>(*child);
          if (clip.isArmedOrRecording()) continue;
          const int64_t keep = std::max<int64_t>(
              clip.recordedLength(), (int64_t)clip.getSampleRate());
          // Compact only when the win is real (≥ ~4 MB of samples).
          if (clip.contentCapacity() - keep < (int64_t{1} << 20)) continue;
          auto fresh =
              std::make_unique<juce::AudioBuffer<float>>(1, (int)keep);
          fresh->copyFrom(0, 0, clip.getAudioBuffer(), 0, 0,
                          (int)std::min<int64_t>(
                              keep, clip.getAudioBuffer().getNumSamples()));
          juce::AudioBuffer<float> *old = clip.swapContent(std::move(fresh));
          retire([old] { delete old; });
        }
      };
  visit(*root_node);
}

void AudioEngine::publishGraph() {
  const auto *fresh = celestrian::buildGraphSnapshot(*root_node);
  const auto *old = graph_snapshot_.exchange(fresh, std::memory_order_acq_rel);
  // Publish-then-retire: an in-flight callback may still traverse the
  // old snapshot; the reclaimer's 2-callback grace covers it. (Nodes a
  // structural edit removed are retired by their own paths AFTER this
  // publish, so the old snapshot never outlives its referents.)
  if (old) retire([old] { delete old; });
}

void AudioEngine::initialiseAudioDevice() { init(1, 2); }

void AudioEngine::createDefaultSession() {
  // Create a default stack with one clip ready for recording
  createNode("stack");
  if (auto *stack = dynamic_cast<celestrian::StackNode *>(focused_node)) {
    if (stack->getNumChildren() > 0) {
      juce::String stack_uuid = stack->getChild(0)->getUuid();
      createNode("clip", stack_uuid);
    }
  }
}

AudioEngine::~AudioEngine() {
  device_manager.removeAudioCallback(this);
  // No callback can be in flight anymore.
  flushGraveyard();
  delete graph_snapshot_.exchange(nullptr);  // the final published snapshot
  celestrian::RtLog::instance().drain();
}

void AudioEngine::retire(std::function<void()> deleter) {
  const uint64_t now = callback_count_.load();
  std::vector<std::function<void()>> ready;
  {
    std::lock_guard<std::mutex> lock(graveyard_mutex_);
    graveyard_.push_back({now, std::move(deleter)});

    // Reap: an item retired at epoch E is unreachable once the callback
    // counter has advanced by 2 — every callback that could have loaded the
    // old snapshot has completed by then.
    auto still_pending = [now](const RetiredItem &item) {
      return item.epoch + 2 > now;
    };
    auto it =
        std::partition(graveyard_.begin(), graveyard_.end(), still_pending);
    for (auto i = it; i != graveyard_.end(); ++i)
      ready.push_back(std::move(i->free));
    graveyard_.erase(it, graveyard_.end());
  }
  for (auto &free_fn : ready) free_fn();
}

int64_t AudioEngine::islandEpoch() const { return root_node->getEpoch(); }

void AudioEngine::flushGraveyard() {
  std::vector<RetiredItem> pending;
  {
    std::lock_guard<std::mutex> lock(graveyard_mutex_);
    pending.swap(graveyard_);
  }
  for (auto &item : pending) item.free();
}

void AudioEngine::init(int inputs, int outputs) {
  // Try for 8 inputs, but default to whatever the hardware provides
  device_manager.initialiseWithDefaultDevices(8, outputs);
  auto *device = device_manager.getCurrentAudioDevice();
  if (device) {
    juce::Logger::writeToLog(
        "AudioEngine: Initialized with " +
        juce::String(device->getActiveInputChannels().countNumberOfSetBits()) +
        " input channels.");
  } else {
    juce::Logger::writeToLog(
        "AudioEngine: FAILED to get current audio device.");
  }
  device_manager.addAudioCallback(this);
}

celestrian::AudioNode *AudioEngine::findNodeByUuid(celestrian::AudioNode *node,
                                                   const juce::String &uuid) {
  return node ? node->findByUuid(uuid) : nullptr;
}

// ===================================================================
// Edits-as-events: apply / undo / redo (unification_audit.md §2.2 Step 1)
// Message thread only. applyEdit performs one mutation and returns its
// INVERSE (Nop if it could not apply); the undo stack is a list of
// inverses, redo a list of forwards. Symmetric per kind, so applying an
// inverse reproduces the forward (that is redo). Zero audio-thread
// changes — the existing imperative mutations, made reversible.
// ===================================================================

namespace {
using celestrian::Edit;
// Continuous drags (Position) collapse into ONE undo step: when the new
// inverse targets the same node/kind as the top of the stack, the older
// inverse already restores further back, so the new one is dropped.
bool editsCoalesce(const Edit &top, const Edit &fresh) {
  if (top.kind != fresh.kind || top.uuid != fresh.uuid) return false;
  return top.kind == Edit::Kind::Position;
}
}  // namespace

celestrian::StackNode *AudioEngine::parentOf(celestrian::AudioNode *node,
                                             int *index_out) const {
  if (index_out) *index_out = -1;
  if (!node) return nullptr;
  auto *parent = dynamic_cast<celestrian::StackNode *>(node->getParent());
  if (!parent) return nullptr;
  const auto &kids = parent->ownedChildren();  // message thread
  for (int i = 0; i < (int)kids.size(); ++i) {
    if (kids[i].get() == node) {
      if (index_out) *index_out = i;
      break;
    }
  }
  return parent;
}

namespace {
int countCommittedClips(const celestrian::AudioNode *node) {
  if (node->getNodeType() == celestrian::NodeType::Clip)
    return node->getIntrinsicDuration() > 0 ? 1 : 0;
  const auto *stack = static_cast<const celestrian::StackNode *>(node);
  int n = 0;
  for (const auto &child : stack->ownedChildren())
    n += countCommittedClips(child.get());
  return n;
}

celestrian::ClipNode *firstCommittedClip(celestrian::AudioNode *node) {
  if (node->getNodeType() == celestrian::NodeType::Clip) {
    return node->getIntrinsicDuration() > 0
               ? static_cast<celestrian::ClipNode *>(node)
               : nullptr;
  }
  auto *stack = static_cast<celestrian::StackNode *>(node);
  for (const auto &child : stack->ownedChildren()) {
    if (auto *c = firstCommittedClip(child.get())) return c;
  }
  return nullptr;
}
}  // namespace

int AudioEngine::islandCommittedClipCount() const {
  return root_node ? countCommittedClips(root_node.get()) : 0;
}

celestrian::Edit AudioEngine::applyEdit(celestrian::Edit e) {
  using K = celestrian::Edit::Kind;
  const K kind = e.kind;
  celestrian::Edit inv = applyEditImpl(std::move(e));
  // Structural mutations re-publish the whole-graph snapshot (Tier 3
  // Step 3): record/undo/redo all funnel through here, so this is the
  // one place topology changes become visible to the audio thread.
  if (inv.kind != K::Nop &&
      (kind == K::Insert || kind == K::Remove || kind == K::Move ||
       kind == K::Combine || kind == K::Explode)) {
    publishGraph();
  }
  return inv;
}

celestrian::Edit AudioEngine::applyEditImpl(celestrian::Edit e) {
  using celestrian::AudioNode;
  using celestrian::StackNode;
  using K = Edit::Kind;
  auto find = [&](const juce::String &u) {
    return findNodeByUuid(root_node.get(), u);
  };
  auto asStack = [&](const juce::String &u) {
    return dynamic_cast<StackNode *>(find(u));
  };

  switch (e.kind) {
    case K::Insert: {
      auto *parent = asStack(e.parentUuid);
      if (!parent || !e.node) return {};
      const juce::String uid = e.node->getUuid();
      const bool restoreIsland = e.setsIsland;
      const int64_t iq = e.iq, iepoch = e.iepoch;
      parent->insertChildAt(std::move(e.node), e.index);
      // Restore the island grid this insert carries (undo of a
      // provisional-Q-revert delete). The Remove inverse re-derives the
      // revert on redo, so it needs no island payload.
      if (restoreIsland) root_node->setQuantum(iq, iepoch);
      // Undo of a RE-OPENING delete (uuid2 = the definer that delete
      // uncollapsed): re-collapse it so the locked island is exactly as
      // it was. Same derivation as the forward CollapseTake; redo's
      // Remove re-derives the uncollapse, so no payload rides back.
      if (e.uuid2.isNotEmpty()) {
        if (auto *clip = dynamic_cast<celestrian::ClipNode *>(
                findNodeByUuid(root_node.get(), e.uuid2))) {
          const int64_t dur = clip->getIntrinsicDuration();
          const int64_t ls = clip->getLoopStart();
          const int64_t le = std::min(clip->getLoopEnd(), dur);
          if (le - ls > 0 && !(ls == 0 && le >= dur)) {
            clip->collapseToWindow(ls, le - ls);
          }
        }
      }
      Edit inv(K::Remove);
      inv.uuid = uid;
      return inv;
    }
    case K::Remove: {
      auto *node = find(e.uuid);
      if (!node || node == root_node.get()) return {};
      if (node->isArmedOrRecording()) return {};  // cancel is the verb
      int idx = -1;
      auto *parent = parentOf(node, &idx);
      if (!parent || idx < 0) return {};
      Edit inv(K::Insert);
      inv.parentUuid = parent->getUuid();
      inv.index = idx;
      inv.node = parent->removeChild(idx);  // non-retiring detach; owned here
      // Provisional Q revert (Q13 non-sticky): if this delete emptied the
      // island of committed content, Q is no longer defined by anything —
      // revert it, carrying the old (Q, epoch) so undo restores the grid
      // together with the clip. A delete that only drops 2→1 leaves Q
      // untouched (it just becomes re-mutable again — derived, no state).
      if (islandCommittedClipCount() == 0 && root_node->getQuantum() != 0) {
        inv.setsIsland = true;
        inv.iq = root_node->getQuantum();
        inv.iepoch = root_node->getEpoch();
        root_node->setQuantum(0, 0);
      }
      // RE-OPEN ⟹ UNCOLLAPSE (companion of collapse-at-arm, owner
      // ruling 2026-07-19b): if this delete brought the island back down
      // to its sole take and that take was lock-collapsed (there is
      // trimmed-away material beyond its duration), restore the full
      // buffer with the old trim as the window — audio-neutral by
      // construction (the windowed playback of the restored buffer is
      // sample-identical), and the user can trim LONGER again. The
      // inverse Insert carries uuid2 so undo re-collapses with the
      // re-inserted take; redo re-derives the uncollapse right here.
      if (islandCommittedClipCount() == 1) {
        if (auto *survivor = firstCommittedClip(root_node.get());
            survivor &&
            survivor->getWritePosition() > survivor->getIntrinsicDuration()) {
          survivor->uncollapseFromWindow(survivor->getContentBase(),
                                         survivor->getWritePosition());
          inv.uuid2 = survivor->getUuid();
        }
      }
      return inv;
    }
    case K::Move: {
      auto *node = find(e.uuid);
      auto *newParent = asStack(e.parentUuid);
      if (!node || !newParent) return {};
      int oldIdx = -1;
      auto *oldParent = parentOf(node, &oldIdx);
      if (!oldParent || oldIdx < 0) return {};
      auto owned = oldParent->removeChild(oldIdx);
      newParent->insertChildAt(std::move(owned), e.index);
      Edit inv(K::Move);
      inv.uuid = e.uuid;
      inv.parentUuid = oldParent->getUuid();
      inv.index = oldIdx;
      return inv;
    }
    case K::Combine: {
      auto *dragged = find(e.uuid);
      auto *target = find(e.uuid2);
      if (!dragged || !target || dragged == target) return {};
      int draggedIdx = -1, targetIdx = -1;
      auto *draggedParent = parentOf(dragged, &draggedIdx);
      auto *targetParent = parentOf(target, &targetIdx);
      if (!draggedParent || !targetParent) return {};
      auto draggedOwned = draggedParent->removeChild(draggedIdx);
      // Target index may have shifted if it shared a parent with dragged.
      int tIdx = -1;
      auto *tParent = parentOf(target, &tIdx);
      auto targetOwned = tParent->removeChild(tIdx);
      auto newStack = std::make_unique<StackNode>("Combined Stack");
      newStack->x_pos.store(targetOwned->x_pos.load());
      newStack->y_pos.store(targetOwned->y_pos.load());
      newStack->addChild(std::move(targetOwned));  // target first (index 0)
      newStack->addChild(std::move(draggedOwned));  // dragged second (index 1)
      const juce::String newUuid = newStack->getUuid();
      tParent->insertChildAt(std::move(newStack), tIdx);
      Edit inv(K::Explode);
      inv.uuid = newUuid;
      inv.parentUuid = targetParent->getUuid();  // child[0] restore
      inv.index = targetIdx;
      inv.parentUuid2 = draggedParent->getUuid();  // child[1] restore
      inv.index2 = draggedIdx;
      return inv;
    }
    case K::Explode: {
      auto *stack = asStack(e.uuid);
      if (!stack || stack->getNumChildren() != 2) return {};
      auto child0 = stack->removeChild(0);  // target
      auto child1 = stack->removeChild(0);  // dragged (now at 0)
      const juce::String draggedUuid = child1->getUuid();
      const juce::String targetUuid = child0->getUuid();
      auto *tParent = asStack(e.parentUuid);
      auto *dParent = asStack(e.parentUuid2);
      if (!tParent || !dParent) return {};
      // Reinsert in ascending index order so a shared parent reproduces
      // the exact original arrangement (inserting the lower slot first).
      const bool targetFirst = e.index <= e.index2;
      if (targetFirst) {
        tParent->insertChildAt(std::move(child0), e.index);
        dParent->insertChildAt(std::move(child1), e.index2);
      } else {
        dParent->insertChildAt(std::move(child1), e.index2);
        tParent->insertChildAt(std::move(child0), e.index);
      }
      // Remove the now-empty combined stack; retire it — an in-flight
      // callback may still traverse it via the outgoing graph snapshot.
      int stackIdx = -1;
      if (auto *stackParent = parentOf(stack, &stackIdx); stackParent &&
                                                          stackIdx >= 0) {
        auto owned = stackParent->removeChild(stackIdx);
        celestrian::AudioNode *n = owned.release();
        retire([n] { delete n; });
      }
      Edit inv(K::Combine);
      inv.uuid = draggedUuid;
      inv.uuid2 = targetUuid;
      return inv;
    }
    case K::Rename: {
      auto *node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Rename);
      inv.uuid = e.uuid;
      inv.s1 = node->getName();
      node->setName(e.s1);
      return inv;
    }
    case K::Mute: {
      auto *node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Mute);
      inv.uuid = e.uuid;
      inv.b1 = node->is_muted.load();
      node->is_muted.store(e.b1);
      return inv;
    }
    case K::LoopPoints: {
      auto *node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::LoopPoints);
      inv.uuid = e.uuid;
      inv.d1 = (double)node->getLoopStart();
      inv.d2 = (double)node->getLoopEnd();
      node->setLoopPoints((int64_t)e.d1, (int64_t)e.d2);
      // Q13 re-trim: if the forward edit carries an island re-establishment
      // (built by setLoopPoints when the target is the sole committed
      // clip), apply it and capture the old (Q, epoch) into the inverse so
      // undo restores the grid, not just the window.
      if (e.setsIsland) {
        inv.setsIsland = true;
        inv.iq = root_node->getQuantum();
        inv.iepoch = root_node->getEpoch();
        root_node->setQuantum(e.iq, e.iepoch);
      }
      // Phase-preserving trim: the re-anchored origin rides the same
      // edit (see setLoopPoints); the inverse restores the old one.
      if (e.setsOrigin) {
        inv.setsOrigin = true;
        inv.iorg = node->origin_samples.load();
        node->origin_samples.store(e.iorg);
      }
      return inv;
    }
    case K::CollapseTake: {
      // Q13 lock-collapse (owner ruling 2026-07-19): the trim is a
      // PRE-LOCK affordance — when a take arms against a provisionally
      // trimmed island, the trimmed region BECOMES the take, as if it
      // had been performed exactly (duration = window len, origin =
      // its own window top = the epoch, window consumed). (Q, epoch)
      // do not move: the collapse lands the clip exactly on the grid
      // the trim already established.
      auto *clip = dynamic_cast<celestrian::ClipNode *>(
          findNodeByUuid(root_node.get(), e.uuid));
      if (!clip) return {};
      Edit inv(K::CollapseTake);
      inv.uuid = e.uuid;
      if (!e.b1) {
        const int64_t dur = clip->getIntrinsicDuration();
        const int64_t ls = clip->getLoopStart();
        const int64_t le = std::min(clip->getLoopEnd(), dur);
        const int64_t len = le - ls;
        // Full-span (or invalid) window: nothing to collapse.
        if (len <= 0 || (ls == 0 && le >= dur)) return {};
        clip->collapseToWindow(ls, len);
        inv.b1 = true;  // inverse = uncollapse, carrying what it needs
        inv.iq = ls;
        inv.iepoch = dur;
      } else {
        clip->uncollapseFromWindow(e.iq, e.iepoch);
        // inverse of the inverse: the parameterless forward re-derives.
      }
      return inv;
    }
    case K::LoopBypass: {
      auto *node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::LoopBypass);
      inv.uuid = e.uuid;
      inv.b1 = node->isLoopWindowBypassed();
      node->setLoopWindowBypassed(e.b1);
      return inv;
    }
    case K::Input: {
      auto *clip = dynamic_cast<celestrian::ClipNode *>(find(e.uuid));
      if (!clip) return {};
      Edit inv(K::Input);
      inv.uuid = e.uuid;
      inv.d1 = (double)clip->getInputChannel();
      clip->setInputChannel((int)e.d1);
      return inv;
    }
    case K::Position: {
      auto *node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Position);
      inv.uuid = e.uuid;
      inv.d1 = node->x_pos.load();
      inv.d2 = node->y_pos.load();
      node->x_pos.store(e.d1);
      node->y_pos.store(e.d2);
      return inv;
    }
    case K::Nop:
      return {};
  }
  return {};
}

void AudioEngine::retireEdit(celestrian::Edit &&e) {
  // Never free a detached subtree inline — an in-flight callback may read
  // it for ≤2 more callbacks. Hand it to the same graveyard the graph
  // mutations use.
  if (e.node) {
    celestrian::AudioNode *n = e.node.release();
    retire([n] { delete n; });
  }
  if (e.node2) {
    celestrian::AudioNode *n = e.node2.release();
    retire([n] { delete n; });
  }
}

void AudioEngine::clearRedo() {
  for (auto &e : redo_) retireEdit(std::move(e));
  redo_.clear();
}

void AudioEngine::clearHistory() {
  for (auto &e : undo_) retireEdit(std::move(e));
  undo_.clear();
  clearRedo();
}

void AudioEngine::record(celestrian::Edit forward) {
  celestrian::Edit inv = applyEdit(std::move(forward));
  if (inv.kind == celestrian::Edit::Kind::Nop) return;  // did not apply
  if (!undo_.empty() && editsCoalesce(undo_.back(), inv)) {
    clearRedo();  // a fresh user action still invalidates the redo branch
    return;       // keep the older inverse (restores further back)
  }
  undo_.push_back(std::move(inv));
  while (undo_.size() > kUndoDepth) {
    retireEdit(std::move(undo_.front()));
    undo_.erase(undo_.begin());
  }
  clearRedo();
}

void AudioEngine::undo() {
  if (undo_.empty()) return;
  celestrian::Edit inv = std::move(undo_.back());
  undo_.pop_back();
  celestrian::Edit fwd = applyEdit(std::move(inv));
  if (fwd.kind != celestrian::Edit::Kind::Nop) redo_.push_back(std::move(fwd));
}

void AudioEngine::redo() {
  if (redo_.empty()) return;
  celestrian::Edit fwd = std::move(redo_.back());
  redo_.pop_back();
  celestrian::Edit inv = applyEdit(std::move(fwd));
  if (inv.kind != celestrian::Edit::Kind::Nop) undo_.push_back(std::move(inv));
}

void AudioEngine::deleteNode(const juce::String &uuid) {
  celestrian::Edit e(celestrian::Edit::Kind::Remove);
  e.uuid = uuid;
  record(std::move(e));
}

bool AudioEngine::saveSession(const juce::String &path) {
  return celestrian::session_io::save(*root_node, cached_sample_rate_.load(),
                                      juce::File(path));
}

bool AudioEngine::loadSession(const juce::String &path) {
  // Refuse mid-take: an in-flight capture is TRANSIENT, not saved, and
  // tearing the graph out from under it would corrupt the buffer.
  if (root_node->hasActiveTake()) return false;

  auto loaded =
      celestrian::session_io::load(juce::File(path), cached_sample_rate_.load());
  if (!loaded.ok) return false;

  // Swap the root's CONTENTS in place: root_node's identity never
  // changes, so the audio thread (which dereferences root_node) sees no
  // pointer race — only the child snapshot swaps, through the proven
  // reclaimer path. There is a ≤2-callback window of an empty root
  // (brief silence) during the load, which is acceptable for a load.
  // clearChildren DETACHES; retirement is ours — the audio thread may
  // still traverse the old graph snapshot for ≤2 callbacks after the
  // publish below.
  {
    auto removed = root_node->clearChildren();
    for (auto &node : removed) {
      celestrian::AudioNode *n = node.release();
      retire([n] { delete n; });
    }
  }
  for (auto &child : loaded.children) root_node->addChild(std::move(child));

  // Force the island facts. addChild may have transiently re-established
  // (Q, epoch) from the first committed clip using the CLIP's origin as
  // the epoch (wrong); this overrides it with the persisted values.
  root_node->setQuantum(loaded.q_samples, loaded.epoch);
  root_node->is_muted.store(loaded.root_muted);
  celestrian::session_io::applyEffects(*root_node, loaded.root_effects,
                                       loaded.sample_rate);
  publishGraph();  // the audio thread sees the loaded topology

  focused_node = root_node.get();
  soloed_node_uuid = "";
  soloed_node_ptr_.store(nullptr);
  clearHistory();  // a loaded session starts with no undo history

  juce::Logger::writeToLog("AudioEngine: session loaded from " + path);
  return true;
}

void AudioEngine::startRecordingInNode(const juce::String &uuid) {
  juce::Logger::writeToLog("AudioEngine: start_recording requested for " +
                           uuid);

  // If the whole song is stopped when clicking record, automatically play
  if (!is_playing_global.load()) {
    is_playing_global.store(true);
    juce::Logger::writeToLog(
        "AudioEngine: Auto-starting transport for recording.");
  }

  if (auto *clip = dynamic_cast<celestrian::ClipNode *>(
          findNodeByUuid(root_node.get(), uuid))) {
    juce::Logger::writeToLog("AudioEngine: Found clip, starting recording.");

    // Q13 LOCK-COLLAPSE (owner ruling 2026-07-19): arming a take
    // against a provisionally-trimmed island FINALIZES the trim — the
    // sole committed clip collapses to its window BEFORE the arm, so
    // every boundary computation (context loop, heard/intrinsic cycle
    // snapshots, LCMs) sees an ordinary whole-Q looper. Leaving the
    // incommensurate buffer alive poisoned them all: field 2026-07-19b,
    // take 2 anchored at origin − epoch = 56298 ∉ Q·Z. Undoable —
    // ⌘Z restores the full buffer and the trim.
    if (islandCommittedClipCount() == 1) {
      if (auto *definer = firstCommittedClip(root_node.get());
          definer && definer->getUuid() != uuid &&
          definer->isLoopWindowActive()) {
        celestrian::Edit e(celestrian::Edit::Kind::CollapseTake);
        e.uuid = definer->getUuid();
        record(std::move(e));  // no-op (not recorded) if already full-span
      }
    }

    // The clock is NEVER reset (kernel.md §2) — not even for the first
    // clip. What the old "Initial Recording Reset" actually provided was
    // the island epoch; that is now captured as data (epoch := arm
    // moment) in ClipNode's first-clip arm path, leaving the clock
    // untouched.
    clip->startRecording();
  } else {
    juce::Logger::writeToLog("AudioEngine: CLIP NOT FOUND for " + uuid);
  }
}

void AudioEngine::stopRecordingInNode(const juce::String &uuid) {
  juce::Logger::writeToLog("AudioEngine: stop_recording requested for " + uuid);
  if (auto *clip = dynamic_cast<celestrian::ClipNode *>(
          findNodeByUuid(root_node.get(), uuid))) {
    clip->stopRecording();
  }
}

void AudioEngine::togglePlayback() {
  // Pause/resume: stopping freezes the clock where it is; playing
  // resumes from the same phase. The clock is never reset (kernel.md).
  // (The old stop-reset only "restarted from the top" when the island
  // epoch happened to be 0; restart-from-top as a real feature is a
  // root time-map — tasks.md open question 8.)
  is_playing_global = !is_playing_global.load();
}

juce::var AudioEngine::getGraphState() const {
  // Forward any log lines queued by the audio thread (UI polls this
  // every ~50 ms, so this doubles as the RtLog drain point).
  celestrian::RtLog::instance().drain();

  // Cycle view of the monotonic clock (kernel.md step 3): the engine
  // never wraps its transport; the UI-facing masterPos is derived here.
  // Idle/playback: t mod LCM. Recording: frozen base + linear growth so
  // the cursor extends past the committed LCM.
  const int64_t t = global_transport_pos.load();
  double master_view;
  if (view_recording_.load()) {
    master_view = (double)(view_base_.load() + (t - view_anchor_t_.load()));
  } else {
    // Wrap on the EFFECTIVE cycle (E-C): active windows shorten what
    // is audible, and the playhead loops with what is heard.
    const int64_t cycle = calculateEffectiveCycleLength();
    const int64_t rel = t - islandEpoch();
    master_view = (double)(cycle > 0 ? ((rel % cycle) + cycle) % cycle : rel);
  }

  if (focused_node) {
    auto metadata = focused_node->getMetadata();
    auto *obj = metadata.getDynamicObject();
    obj->setProperty("isPlaying", (bool)is_playing_global.load());
    obj->setProperty("masterPos", master_view);
    // The island epoch is the UI's frame origin for every cycle-relative
    // projection (kernel.md one-frame rule). It is NOT the root node's
    // `origin` metadata — commit re-bases the epoch (see processBlock),
    // and the UI marking take-vs-ghost tiles needs the re-based value.
    obj->setProperty("islandEpoch", (double)islandEpoch());
    // NOTE: the focused stack's metadata already carries `quantum` (its
    // stored island Q, stack_node.cc) — the VM reads it as the top-level
    // Q fact instead of re-deriving min-over-nodes (P0-3 completion).
    obj->setProperty("soloedId", soloed_node_uuid);
    obj->setProperty("focusedId", focused_node->getUuid());
    obj->setProperty("canUndo", canUndo());
    obj->setProperty("canRedo", canRedo());
    obj->setProperty("perf", makePerfState());
    return metadata;
  }

  juce::DynamicObject::Ptr state = new juce::DynamicObject();
  state->setProperty("isPlaying", (bool)is_playing_global.load());
  state->setProperty("masterPos", master_view);
  state->setProperty("islandEpoch", (double)islandEpoch());
  state->setProperty("quantum",
                     (double)(root_node ? root_node->getQuantum() : 0));
  state->setProperty("soloedId", soloed_node_uuid);
  state->setProperty("canUndo", canUndo());
  state->setProperty("canRedo", canRedo());
  state->setProperty("nodes", juce::Array<juce::var>());
  state->setProperty("perf", makePerfState());
  return juce::var(state.get());
}

juce::var AudioEngine::getWaveform(const juce::String &uuid,
                                   int num_peaks) const {
  auto *self = const_cast<AudioEngine *>(this);
  if (auto *node = self->findNodeByUuid(root_node.get(), uuid)) {
    return node->getWaveform(num_peaks);
  }
  return juce::Array<juce::var>();
}

// --- Stack Expand/Collapse ---

void AudioEngine::toggleStackExpand(const juce::String &uuid) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    bool currentState = node->is_expanded.load();
    bool newState = !currentState;
    node->is_expanded.store(newState);

    // Purely visual (I6b): expansion changes nothing audible. Loop
    // window activation lives in its own state (toggleLoopWindow).
    juce::Logger::writeToLog(
        "AudioEngine: Toggled expand for " + uuid + " (New State: " +
        juce::String(newState ? "expanded" : "collapsed") + ")");
  }
}

void AudioEngine::createNode(const juce::String &type,
                             const juce::String &parent_uuid) {
  // Find target parent stack
  celestrian::StackNode *target_stack = nullptr;

  if (!parent_uuid.isEmpty()) {
    // Use specified parent
    auto *parent_node = findNodeByUuid(root_node.get(), parent_uuid);
    target_stack = dynamic_cast<celestrian::StackNode *>(parent_node);
  } else {
    // Default to focused_node
    target_stack = dynamic_cast<celestrian::StackNode *>(focused_node);
  }

  if (!target_stack) {
    juce::Logger::writeToLog("createNode: No valid stack target found");
    return;
  }

  std::unique_ptr<celestrian::AudioNode> new_node;
  if (type == "clip") {
    // Clip buffers and metadata carry the actual device rate (P0-5).
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

void AudioEngine::renameNode(const juce::String &uuid,
                             const juce::String &new_name) {
  celestrian::Edit e(celestrian::Edit::Kind::Rename);
  e.uuid = uuid;
  e.s1 = new_name;
  record(std::move(e));
}

void AudioEngine::reorderNode(const juce::String &node_uuid,
                              const juce::String &new_parent_uuid,
                              int new_index) {
  // Routed through the edit log (Move): the detach/insert dance and its
  // exact-inverse (back to the old parent/index) live in applyEdit.
  celestrian::Edit e(celestrian::Edit::Kind::Move);
  e.uuid = node_uuid;
  e.parentUuid = new_parent_uuid;
  e.index = new_index;
  record(std::move(e));
}

juce::String AudioEngine::combineNodes(const juce::String &dragged_uuid,
                                       const juce::String &target_uuid) {
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
  undo_.push_back(std::move(inv));
  while (undo_.size() > kUndoDepth) {
    retireEdit(std::move(undo_.front()));
    undo_.erase(undo_.begin());
  }
  clearRedo();
  juce::Logger::writeToLog("combineNodes: Combined " + dragged_uuid + " + " +
                           target_uuid + " into stack " + new_uuid);
  return new_uuid;
}

void AudioEngine::setNodePosition(const juce::String &node_uuid, double x,
                                  double y) {
  // Position drags coalesce into a single undo step (editsCoalesce).
  celestrian::Edit e(celestrian::Edit::Kind::Position);
  e.uuid = node_uuid;
  e.d1 = x;
  e.d2 = y;
  record(std::move(e));
}

juce::var AudioEngine::getInputList() const {
  juce::Array<juce::var> names;
  if (auto *device = device_manager.getCurrentAudioDevice()) {
    auto inputNames = device->getInputChannelNames();
    juce::Logger::writeToLog("AudioEngine: Found " +
                             juce::String(inputNames.size()) +
                             " input channel names.");
    for (const auto &name : inputNames) {
      names.add(name);
    }
  }
  juce::DynamicObject::Ptr obj = new juce::DynamicObject();
  obj->setProperty("inputs", names);
  return juce::var(obj.get());
}

void AudioEngine::setNodeInput(const juce::String &uuid, int channel_index) {
  celestrian::Edit e(celestrian::Edit::Kind::Input);
  e.uuid = uuid;
  e.d1 = (double)channel_index;
  record(std::move(e));
}

void AudioEngine::setEffectEnabled(const juce::String &uuid,
                                   const juce::String &fx, bool enabled) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    // Prepare BEFORE the flag flips: the audio thread must never see an
    // enabled effect whose buffers aren't allocated. Idempotent per rate.
    double sr = cached_sample_rate_.load();
    if (sr <= 0) sr = 44100.0;
    node->effects().prepare(sr);
    if (node->effects().setEnabled(fx, enabled)) {
      juce::Logger::writeToLog("AudioEngine: effect " + fx + " on " + uuid +
                               (enabled ? " ENABLED" : " DISABLED"));
    }
  }
}

void AudioEngine::setEffectParam(const juce::String &uuid,
                                 const juce::String &fx,
                                 const juce::String &key, double value) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    node->effects().setParam(fx, key, value);
  }
}

void AudioEngine::setEffectScope(const juce::String &uuid, bool active) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    if (active) {
      // The scope can open before any slot is enabled — prepare so the
      // ring exists when the audio thread starts capturing
      double sr = cached_sample_rate_.load();
      if (sr <= 0) sr = 44100.0;
      node->effects().prepare(sr);
    }
    node->effects().setScopeActive(active);
  }
}

void AudioEngine::setLoopPoints(const juce::String &uuid, int64_t start,
                                int64_t end) {
  juce::Logger::writeToLog("AudioEngine::setLoopPoints: uuid=" + uuid +
                           " start=" + juce::String(start) +
                           " end=" + juce::String(end));
  // Window phase is derived from the island clock (time_maps.md); nothing
  // to reset when the region changes. Undoable (LoopPoints).
  celestrian::Edit e(celestrian::Edit::Kind::LoopPoints);
  e.uuid = uuid;
  e.d1 = (double)start;
  e.d2 = (double)end;
  // Q13 — re-trim before lock: while the island's ONLY committed content
  // is the Q-definer, adjusting its loop region re-establishes the island
  // (Q, epoch): Q := window length, epoch := origin + window start (the
  // performance moment of the trimmed loop's top). Only provisional
  // (exactly one committed clip); once a 2nd take commits, count ≥ 2 and
  // this no longer fires — Q is locked (derived). The re-establishment
  // rides the LoopPoints edit so it undoes atomically with the window.
  if (auto *clip = dynamic_cast<celestrian::ClipNode *>(
          findNodeByUuid(root_node.get(), uuid))) {
    // A clip window selects recorded material — clamp to the buffer. A
    // fractional-Q drag rounded past the take's end once produced a
    // window (and a Q) longer than the content it loops.
    start = std::max((int64_t)0, start);
    end = std::min(end, clip->getIntrinsicDuration());
    e.d1 = (double)start;
    e.d2 = (double)end;
    // hasActiveTake: an armed/capturing take is already performing
    // against the current grid — committed-count alone would let a drag
    // re-establish Q mid-take (the count only rises at commit). While a
    // take is in flight this is an ordinary window edit.
    if (end > start && clip->getIntrinsicDuration() > 0 &&
        islandCommittedClipCount() == 1 && !root_node->hasActiveTake()) {
      // PHASE-PRESERVING TRIM (owner request 2026-07-19c): the loop must
      // keep flowing while its region is nudged. The provisional grid is
      // free (no other content depends on it), so re-anchor the clip's
      // origin such that the buffer position sounding RIGHT NOW does not
      // move: fold the current position into the new window and solve
      // origin' = t0 − p_target (playback is buffer[start + ((t −
      // origin − start) mod len)], so this pins pos(t0) = p_target).
      // Epoch := origin' + start as ever — the bar line re-derives
      // silently under continuous audio instead of re-timing it.
      const int64_t t0 = global_transport_pos.load();
      const int64_t oldStart = clip->getLoopStart();
      const int64_t oldEnd =
          std::min(clip->getLoopEnd(), clip->getIntrinsicDuration());
      const int64_t oldLen = oldEnd - oldStart;
      const int64_t oldOrg = clip->origin_samples.load();
      const int64_t len = end - start;
      const int64_t p0 =
          oldLen > 0
              ? oldStart + (((t0 - oldOrg - oldStart) % oldLen) + oldLen) %
                               oldLen
              : start;
      const int64_t pT = start + (((p0 - start) % len) + len) % len;
      e.setsOrigin = true;
      e.iorg = t0 - pT;
      e.setsIsland = true;
      e.iq = len;
      e.iepoch = e.iorg + start;
    }
  }
  record(std::move(e));
}

void AudioEngine::toggleLoopWindow(const juce::String &uuid) {
  // Fractal (I5): window state lives on AudioNode — clips toggle their
  // single-segment window exactly like stacks toggle their time-map.
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    celestrian::Edit e(celestrian::Edit::Kind::LoopBypass);
    e.uuid = uuid;
    e.b1 = !node->isLoopWindowBypassed();  // toggle to the opposite state
    record(std::move(e));
  }
}
void AudioEngine::audioDeviceIOCallbackWithContext(
    const float *const *input_channel_data, int num_input_channels,
    float *const *output_channel_data, int num_output_channels, int num_samples,
    const juce::AudioIODeviceCallbackContext &context) {
  juce::ScopedNoDenormals no_denormals;

  // Epoch for deferred reclamation (see retire()).
  callback_count_.fetch_add(1);

  // --- Instrumentation: entry gap (xrun detection) ---
  const int64_t entry_ticks = juce::Time::getHighResolutionTicks();
  if (last_entry_ticks_ != 0) {
    const double tps = (double)juce::Time::getHighResolutionTicksPerSecond();
    const double gap_s = (double)(entry_ticks - last_entry_ticks_) / tps;
    const double period_s =
        (double)num_samples / cached_sample_rate_.load();
    // Gaps well beyond one block period mean the device starved (ignore
    // long idle gaps — those are stop/start, not overruns).
    if (gap_s > 2.0 * period_s && gap_s < 0.5) xrun_count_.fetch_add(1);
  }
  last_entry_ticks_ = entry_ticks;

  for (int i = 0; i < num_output_channels; ++i) {
    if (output_channel_data[i] != nullptr)
      juce::FloatVectorOperations::clear(output_channel_data[i], num_samples);
  }

  // --- Latency calibration pass (docs/performance.md §7) ---
  // While capturing: mirror the input into the calibration buffer and emit
  // the click into the outputs. Same block index for both sides, so the
  // capture timeline and the emission timeline are identical by
  // construction. Everything here is preallocated and bounded.
  if (calibration_phase_.load() == (int)CalibrationPhase::Capturing) {
    const int cap_len = calibration_capture_.getNumSamples();
    int wp = calibration_write_pos_.load();
    const int n = std::min(num_samples, cap_len - wp);

    if (n > 0) {
      if (num_input_channels > 0 && input_channel_data[0] != nullptr) {
        calibration_capture_.copyFrom(0, wp, input_channel_data[0], n);
      }

      // Click: 128 samples, decaying from full scale, starting at
      // calibration_click_pos_ on the shared timeline.
      constexpr int kClickLen = 128;
      for (int i = 0; i < n; ++i) {
        const int t = wp + i;
        const int k = t - calibration_click_pos_;
        if (k >= 0 && k < kClickLen) {
          const float v = 0.9f * (1.0f - (float)k / (float)kClickLen);
          for (int ch = 0; ch < num_output_channels; ++ch) {
            if (output_channel_data[ch] != nullptr)
              output_channel_data[ch][i] += v;
          }
        }
      }

      wp += n;
      calibration_write_pos_.store(wp);
    }

    if (wp >= cap_len) {
      calibration_phase_.store((int)CalibrationPhase::Done);
    }
  }

  // --- Pre-record ring write (docs/performance.md §3) ---
  // Every input block lands in the ring unconditionally, keyed by the
  // monotonic input clock, so a recording that starts later can still
  // reach audio that has already arrived. Two bounded memcpys per channel.
  const int ring_channels =
      std::min(num_input_channels, (int)kPreRecordRingChannels);
  for (int ch = 0; ch < ring_channels; ++ch) {
    if (input_channel_data[ch] == nullptr) continue;
    const int idx = (int)(input_clock_ % kPreRecordRingLen);
    const int first = std::min(num_samples, kPreRecordRingLen - idx);
    prerecord_ring_.copyFrom(ch, idx, input_channel_data[ch], first);
    if (num_samples > first) {
      prerecord_ring_.copyFrom(ch, 0, input_channel_data[ch] + first,
                               num_samples - first);
    }
  }

  if (root_node) {
    celestrian::ProcessContext pc;
    pc.sample_rate = cached_sample_rate_.load();
    pc.num_samples = num_samples;
    pc.is_playing = is_playing_global;
    pc.is_recording = true;  // Enable recording capture from inputs
    pc.master_pos = global_transport_pos;
    if (ring_channels > 0) {
      pc.prerecord_ring = prerecord_ring_.getArrayOfReadPointers();
      pc.prerecord_ring_len = kPreRecordRingLen;
      pc.prerecord_ring_channels = ring_channels;
    }
    pc.input_clock = input_clock_;
    // Recording alignment: a measured round-trip (empirical calibration)
    // supersedes the driver-reported latencies, which are often wrong or
    // zero on consumer hardware.
    const int64_t measured = measured_latency_samples_.load();
    if (measured >= 0) {
      pc.input_latency = (int)measured;
      pc.output_latency = 0;
    } else {
      pc.input_latency = cached_input_latency_.load();
      pc.output_latency = cached_output_latency_.load();
    }
    pc.solo_node = soloed_node_ptr_.load();
    // Cycle-top of the island frame — loop-window time-maps phase off
    // this (time_maps.md); windowed stacks re-base it for their children.
    pc.cycle_epoch = islandEpoch();
    // Whole-graph snapshot + island facts (Tier 3 Step 3): ONE structure
    // load for the entire callback; leaves read island state from the
    // context instead of walking parents.
    pc.snap = graph_snapshot_.load(std::memory_order_acquire);
    pc.self = 0;
    pc.quantum = root_node->getQuantum();
    pc.island_epoch = pc.cycle_epoch;
    pc.island = root_node.get();

    // Update Global Quantum Propagation:
    // If focused box has no quantum, check if its children have a finished
    // recording.
    root_node->process(input_channel_data, output_channel_data,
                       num_input_channels, num_output_channels, pc);

    input_clock_ += num_samples;

    if (is_playing_global.load()) {
      // Monotonic transport (kernel.md step 3): the clock only moves
      // forward. Clips align by their stored origins, so commits have
      // nothing to wrap, snap, or reset — the old LCM-wrap /
      // LCM-growth-snap / polyrhythm / first-clip-snap branch pile is
      // gone. The cycle position shown to the UI is a DERIVED view
      // (see getGraphState), which during recording grows linearly from
      // a base frozen at record start so the cursor can extend past the
      // committed LCM (recording.md cursor table).
      const int64_t old_pos = global_transport_pos.load();

      // The take LIFECYCLE lives on the island root now (a counter fed
      // by arm/cancel/commit events); the per-block graph scan is gone,
      // and the epoch re-base runs inside the commit event itself
      // (StackNode::takeCommitted) — no more edge detection here.
      // What remains is purely VIEW upkeep: freeze the cycle view's
      // base when a take begins so the cursor extends past the
      // committed LCM while recording (recording.md cursor table).
      const bool is_recording = root_node->hasActiveTake();
      if (is_recording && !was_any_node_recording_) {
        // The frozen base continues the view the user was WATCHING —
        // the effective (window-aware) wrap. Snapshot-space math: this
        // runs on the AUDIO thread (graph_snapshot.h).
        const int64_t view_cycle = pc.snap
            ? celestrian::snapEffectiveCycle(
                  *pc.snap, root_node->getQuantum(),
                  (int64_t)cached_sample_rate_.load())
            : calculateEffectiveCycleLength();
        const int64_t rel = old_pos - islandEpoch();
        view_base_.store(view_cycle > 0 ? rel % view_cycle : rel);
        view_anchor_t_.store(old_pos);
      }
      was_any_node_recording_ = is_recording;
      view_recording_.store(is_recording);

      global_transport_pos.store(old_pos + num_samples);
    }
  }

  updatePerfMeters(entry_ticks, num_samples);
}

void AudioEngine::updatePerfMeters(int64_t entry_ticks, int num_samples) {
  const double tps = (double)juce::Time::getHighResolutionTicksPerSecond();
  const double duration_s =
      (double)(juce::Time::getHighResolutionTicks() - entry_ticks) / tps;
  const double period_s = (double)num_samples / cached_sample_rate_.load();

  const int64_t us = (int64_t)(duration_s * 1.0e6);
  if (us > max_block_us_.load()) max_block_us_.store(us);

  if (period_s > 0.0) {
    const double load = duration_s / period_s;
    // Single writer (audio thread): plain read-modify-write is fine.
    avg_dsp_load_.store(0.9 * avg_dsp_load_.load() + 0.1 * load);
  }
}

juce::var AudioEngine::makePerfState() const {
  juce::DynamicObject::Ptr perf = new juce::DynamicObject();
  perf->setProperty("maxBlockUs", (double)max_block_us_.load());
  perf->setProperty("avgLoadPct", avg_dsp_load_.load() * 100.0);
  perf->setProperty("xruns", (double)xrun_count_.load());

  const int64_t measured = measured_latency_samples_.load();
  const int64_t effective =
      measured >= 0
          ? measured
          : cached_input_latency_.load() + cached_output_latency_.load();
  perf->setProperty("latencyCompensationSamples", (double)effective);
  perf->setProperty("calibrated", measured >= 0);
  // The device's actual rate — the UI must use this (not 44100) for any
  // samples→ms display. The field found a 48 kHz device this way.
  perf->setProperty("sampleRate", cached_sample_rate_.load());
  return juce::var(perf.get());
}

// --- Latency Calibration (docs/performance.md §7) ---

void AudioEngine::startLatencyCalibration() {
  // Preallocate the capture buffer on the message thread BEFORE flipping
  // the phase — the audio thread only ever writes into existing storage.
  const double sr = cached_sample_rate_.load();
  const int capture_len = (int)(sr * 2.0);  // 2 s window
  calibration_capture_.setSize(1, capture_len, false, true, false);
  calibration_capture_.clear();
  calibration_click_pos_ = (int)(sr * 0.25);  // 250 ms of noise-floor lead-in
  calibration_write_pos_.store(0);
  measured_latency_samples_.store(-1);  // fall back to reported until done

  juce::Logger::writeToLog(
      "AudioEngine: Latency calibration started (capture " +
      juce::String(capture_len) + " samples, click at " +
      juce::String(calibration_click_pos_) + ")");

  calibration_phase_.store((int)CalibrationPhase::Capturing);
}

juce::var AudioEngine::getLatencyCalibration() {
  const double sr = cached_sample_rate_.load();

  // Run onset detection once, on the message thread, when capture is done.
  if (calibration_phase_.load() == (int)CalibrationPhase::Done &&
      measured_latency_samples_.load() < 0) {
    const float *data = calibration_capture_.getReadPointer(0);
    const int len = calibration_capture_.getNumSamples();
    const int click = calibration_click_pos_;

    // Noise floor from the lead-in, peak from the post-click region.
    float floor_level = 0.0f;
    for (int i = 0; i < click; ++i)
      floor_level = std::max(floor_level, std::abs(data[i]));
    float peak = 0.0f;
    for (int i = click; i < len; ++i)
      peak = std::max(peak, std::abs(data[i]));

    // Need a clear response well above the room/line noise.
    if (peak < std::max(0.02f, floor_level * 4.0f)) {
      calibration_phase_.store((int)CalibrationPhase::Failed);
      juce::Logger::writeToLog(
          "AudioEngine: Latency calibration FAILED — no loopback signal "
          "detected (peak=" +
          juce::String(peak) + ", floor=" + juce::String(floor_level) + ")");
    } else {
      const float threshold = std::max(floor_level * 4.0f, peak * 0.3f);
      for (int i = click; i < len; ++i) {
        if (std::abs(data[i]) >= threshold) {
          measured_latency_samples_.store(i - click);
          break;
        }
      }
      juce::Logger::writeToLog(
          "AudioEngine: Latency calibration DONE — round trip = " +
          juce::String(measured_latency_samples_.load()) + " samples (" +
          juce::String(measured_latency_samples_.load() / sr * 1000.0, 2) +
          " ms)");
      persistCalibration(measured_latency_samples_.load());
    }
  }

  juce::DynamicObject::Ptr result = new juce::DynamicObject();
  const int phase = calibration_phase_.load();
  const char *phase_name =
      phase == (int)CalibrationPhase::Capturing  ? "capturing"
      : phase == (int)CalibrationPhase::Done     ? "done"
      : phase == (int)CalibrationPhase::Failed   ? "failed"
                                                 : "idle";
  const int64_t measured = measured_latency_samples_.load();
  result->setProperty("phase", phase_name);
  result->setProperty("roundTripSamples", (double)measured);
  result->setProperty("roundTripMs",
                      measured >= 0 ? measured / sr * 1000.0 : -1.0);
  result->setProperty("calibrated", measured >= 0);
  return juce::var(result.get());
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice *device) {
  if (device) {
    cached_input_latency_.store(device->getInputLatencyInSamples());
    cached_output_latency_.store(device->getOutputLatencyInSamples());
    cached_sample_rate_.store(device->getCurrentSampleRate());
    cached_block_size_.store(device->getCurrentBufferSizeSamples());

    // Latency self-report (docs/performance.md §6.3): if the reported
    // latencies are zero, recording compensation is a no-op and empirical
    // calibration is the only trustworthy source.
    juce::Logger::writeToLog(
        "AudioEngine: Device started: '" + device->getName() +
        "' sr=" + juce::String(device->getCurrentSampleRate()) +
        " block=" + juce::String(device->getCurrentBufferSizeSamples()) +
        " inLatency=" + juce::String(device->getInputLatencyInSamples()) +
        " outLatency=" + juce::String(device->getOutputLatencyInSamples()));

    // A calibration is only valid for the exact device configuration it
    // was measured on.
    current_device_key_ = device->getName() + "|" +
                          juce::String(device->getCurrentSampleRate()) + "|" +
                          juce::String(device->getCurrentBufferSizeSamples());
    restoreCalibrationForCurrentDevice();
  }
}

// --- Calibration persistence (docs/performance.md §7) ---

juce::File AudioEngine::calibrationFile() const {
  if (calibration_file_override_ != juce::File()) {
    return calibration_file_override_;
  }
  return juce::File::getSpecialLocation(
             juce::File::userApplicationDataDirectory)
      .getChildFile("Celestrian")
      .getChildFile("calibration.json");
}

void AudioEngine::setCalibrationFile(const juce::File &file) {
  calibration_file_override_ = file;
}

void AudioEngine::persistCalibration(int64_t samples) {
  // No device key means no device ever started (unit tests) — a value
  // measured there is not attributable to hardware, so don't store it.
  if (current_device_key_.isEmpty() || samples < 0) return;

  auto file = calibrationFile();
  juce::var root;
  if (file.existsAsFile()) {
    root = juce::JSON::parse(file.loadFileAsString());
  }
  if (root.getDynamicObject() == nullptr) {
    root = juce::var(new juce::DynamicObject());
  }
  root.getDynamicObject()->setProperty(current_device_key_, (double)samples);

  file.getParentDirectory().createDirectory();
  file.replaceWithText(juce::JSON::toString(root, true));

  juce::Logger::writeToLog("AudioEngine: Calibration persisted for '" +
                           current_device_key_ + "' (" +
                           juce::String(samples) + " samples) -> " +
                           file.getFullPathName());
}

void AudioEngine::restoreCalibrationForCurrentDevice() {
  int64_t restored = -1;

  auto file = calibrationFile();
  if (current_device_key_.isNotEmpty() && file.existsAsFile()) {
    auto root = juce::JSON::parse(file.loadFileAsString());
    if (auto *obj = root.getDynamicObject()) {
      if (obj->hasProperty(current_device_key_)) {
        restored = (int64_t)(double)obj->getProperty(current_device_key_);
      }
    }
  }

  // Found -> use the empirical value from a previous session. Not found ->
  // reset: a value measured on a different device config must not carry
  // over (that would be silently wrong compensation).
  measured_latency_samples_.store(restored);

  if (restored >= 0) {
    juce::Logger::writeToLog(
        "AudioEngine: Calibration restored for '" + current_device_key_ +
        "': " + juce::String(restored) + " samples (" +
        juce::String(restored / cached_sample_rate_.load() * 1000.0, 2) +
        " ms)");
  } else {
    juce::Logger::writeToLog(
        "AudioEngine: No stored calibration for '" + current_device_key_ +
        "' — using device-reported latencies until calibrated.");
  }
}

void AudioEngine::audioDeviceStopped() {
  // The callback is no longer running; everything pending is safe to free.
  flushGraveyard();
}

void AudioEngine::toggleSolo(const juce::String &uuid) {
  if (soloed_node_uuid == uuid) {
    soloed_node_uuid = "";  // Unsolo
    soloed_node_ptr_.store(nullptr);
  } else {
    auto *node = findNodeByUuid(root_node.get(), uuid);
    soloed_node_uuid = node ? uuid : juce::String();
    soloed_node_ptr_.store(node);
  }
  juce::Logger::writeToLog("AudioEngine: Solo toggled for " + uuid +
                           " (Active Solo: " + soloed_node_uuid + ")");
}

void AudioEngine::togglePlay(const juce::String &uuid) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    if (auto *clip = dynamic_cast<celestrian::ClipNode *>(node)) {
      if (clip->isPlaying()) {
        clip->stopPlayback();
      } else {
        clip->startPlayback();
      }
      juce::Logger::writeToLog(
          "AudioEngine: Play toggled for " + uuid + " (New State: " +
          juce::String(clip->isPlaying() ? "true" : "false") + ")");
    }
  }
}
void AudioEngine::toggleMute(const juce::String &uuid) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    celestrian::Edit e(celestrian::Edit::Kind::Mute);
    e.uuid = uuid;
    e.b1 = !node->is_muted.load();  // toggle to the opposite state
    record(std::move(e));
  }
}

// --- LCM Timeline Helpers ---



int64_t AudioEngine::calculateEffectiveCycleLength() const {
  const int64_t one_second = (int64_t)cached_sample_rate_.load();
  if (!focused_node) return one_second;

  int64_t quantum = focused_node->getEffectiveQuantum();
  if (quantum <= 0) quantum = one_second;

  // The root is never windowed itself; its effective period is the LCM
  // of the children's effective periods (E-C, recursive).
  const int64_t p = focused_node->getEffectivePeriod();
  return p > 0 ? celestrian::timing::lcm(quantum, p) : quantum;
}

