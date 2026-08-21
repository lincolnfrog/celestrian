#include "audio_engine.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <cmath>

#include "clip_node.h"
#include "rt_log.h"
#include "stack_node.h"
#include "timing.h"
#include "track_template.h"

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

  // Live MIDI buffer (phase 4): preallocated so the per-callback drain
  // never grows it on the audio thread.
  live_midi_buffer_.ensureSize(8192);
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
  const std::function<void(celestrian::StackNode&)> visit =
      [&](celestrian::StackNode& stack) {
        for (const auto& child : stack.ownedChildren()) {
          if (child->getNodeType() == celestrian::NodeType::Stack) {
            visit(static_cast<celestrian::StackNode&>(*child));
            continue;
          }
          auto& clip = static_cast<celestrian::ClipNode&>(*child);
          if (clip.isArmedOrRecording()) continue;
          // Through-map takes store a dense [0, C) buffer with the
          // content folded past the heard length — keep the full
          // committed duration, not just recordedLength.
          const int64_t keep = std::max<int64_t>(
              {clip.recordedLength(), clip.duration_samples.load(),
               (int64_t)clip.getSampleRate()});
          // Compact only when the win is real (≥ ~4 MB of samples).
          if (clip.contentCapacity() - keep < (int64_t{1} << 20)) continue;
          const int chans = std::max(1, clip.getAudioBuffer().getNumChannels());
          auto fresh =
              std::make_unique<juce::AudioBuffer<float>>(chans, (int)keep);
          for (int c = 0; c < chans; ++c) {
            fresh->copyFrom(c, 0, clip.getAudioBuffer(), c, 0,
                            (int)std::min<int64_t>(
                                keep, clip.getAudioBuffer().getNumSamples()));
          }
          retireOwned(clip.swapContent(std::move(fresh)));
        }
      };
  visit(*root_node);
}

void AudioEngine::publishGraph() {
  const auto* fresh = celestrian::buildGraphSnapshot(*root_node);
  const auto* old = graph_snapshot_.exchange(fresh, std::memory_order_acq_rel);
  // Publish-then-retire: an in-flight callback may still traverse the
  // old snapshot; the reclaimer's 2-callback grace covers it. (Nodes a
  // structural edit removed are retired by their own paths AFTER this
  // publish, so the old snapshot never outlives its referents.)
  retireOwned(old);
}

void AudioEngine::initialiseAudioDevice() { init(1, 2); }

// (createDefaultSession deleted — Q17 boot-empty; see the header note.)

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
    auto still_pending = [now](const RetiredItem& item) {
      return item.epoch + 2 > now;
    };
    auto it =
        std::partition(graveyard_.begin(), graveyard_.end(), still_pending);
    for (auto i = it; i != graveyard_.end(); ++i)
      ready.push_back(std::move(i->free));
    graveyard_.erase(it, graveyard_.end());
  }
  for (auto& free_fn : ready) free_fn();
}

int64_t AudioEngine::islandEpoch() const { return root_node->getEpoch(); }

void AudioEngine::flushGraveyard() {
  std::vector<RetiredItem> pending;
  {
    std::lock_guard<std::mutex> lock(graveyard_mutex_);
    pending.swap(graveyard_);
  }
  for (auto& item : pending) item.free();
}

void AudioEngine::init(int inputs, int outputs) {
  // Restore the last chosen device before falling back to the OS default.
  // The default is the wrong answer on a music machine: on Windows it is a
  // 2-channel WASAPI endpoint, and a multi-channel interface's own driver
  // splits the box into stereo endpoints — the interface only appears
  // whole under ASIO, which is never the default type.
  std::unique_ptr<juce::XmlElement> saved;
  auto file = audioDeviceFile();
  if (file.existsAsFile()) {
    saved = juce::parseXML(file);
    if (saved == nullptr) {
      juce::Logger::writeToLog("AudioEngine: stored device setup at " +
                               file.getFullPathName() +
                               " is unreadable — ignoring it.");
    }
  }

  // Ask for the ring's full width, not 8: `initialise` negotiates DOWN to
  // what the hardware has, so the request is a ceiling, not a demand.
  device_error_ = device_manager.initialise(kPreRecordRingChannels, outputs,
                                            saved.get(), true);

  if (device_error_.isNotEmpty() && saved != nullptr) {
    // The stored device is gone (interface unplugged, driver uninstalled).
    // Don't strand the user with no audio — fall back to the default and
    // keep the stored setup on disk so plugging the box back in restores it.
    juce::Logger::writeToLog("AudioEngine: stored device failed to open (" +
                             device_error_ +
                             ") — falling back to the default device.");
    device_error_ = device_manager.initialise(kPreRecordRingChannels, outputs,
                                              nullptr, true);
  }

  if (device_error_.isNotEmpty()) {
    juce::Logger::writeToLog("AudioEngine: device open FAILED: " +
                             device_error_);
  }

  enableAllInputChannels();

  if (auto* device = device_manager.getCurrentAudioDevice()) {
    juce::Logger::writeToLog(
        "AudioEngine: Initialized on '" + device->getName() + "' (" +
        device_manager.getCurrentAudioDeviceType() + ") with " +
        juce::String(device->getActiveInputChannels().countNumberOfSetBits()) +
        " of " + juce::String(device->getInputChannelNames().size()) +
        " input channels.");
  } else {
    juce::Logger::writeToLog(
        "AudioEngine: FAILED to get current audio device.");
  }
  device_manager.addAudioCallback(this);
}

void AudioEngine::enableAllInputChannels() {
  auto* device = device_manager.getCurrentAudioDevice();
  if (device == nullptr) return;

  const int available = device->getInputChannelNames().size();
  if (available <= 0) return;

  auto setup = device_manager.getAudioDeviceSetup();
  juce::BigInteger wanted;
  wanted.setRange(0, available, true);
  if (setup.inputChannels == wanted && !setup.useDefaultInputChannels) return;

  setup.inputChannels = wanted;
  setup.useDefaultInputChannels = false;  // else the mask is ignored
  auto err = device_manager.setAudioDeviceSetup(setup, true);
  if (err.isNotEmpty()) {
    juce::Logger::writeToLog("AudioEngine: could not enable all " +
                             juce::String(available) +
                             " input channels: " + err);
  }
}

celestrian::AudioNode* AudioEngine::findNodeByUuid(celestrian::AudioNode* node,
                                                   const juce::String& uuid) {
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
bool editsCoalesce(const Edit& top, const Edit& fresh) {
  if (top.kind != fresh.kind || top.uuid != fresh.uuid) return false;
  // Position drags and LIVE map-edit drags (seam slides stream
  // throttled setSegments commits so the splice is AUDIBLE while
  // dragging — time_maps.md, field 2026-07-23c) both flood; keep the
  // oldest inverse so one gesture is one undo step.
  return top.kind == Edit::Kind::Position || top.kind == Edit::Kind::Segments;
}
}  // namespace

celestrian::StackNode* AudioEngine::parentOf(celestrian::AudioNode* node,
                                             int* index_out) const {
  if (index_out) *index_out = -1;
  if (!node) return nullptr;
  auto* parent = dynamic_cast<celestrian::StackNode*>(node->getParent());
  if (!parent) return nullptr;
  const auto& kids = parent->ownedChildren();  // message thread
  for (int i = 0; i < (int)kids.size(); ++i) {
    if (kids[i].get() == node) {
      if (index_out) *index_out = i;
      break;
    }
  }
  return parent;
}

namespace {
int countCommittedClips(const celestrian::AudioNode* node) {
  if (node->getNodeType() == celestrian::NodeType::Clip)
    return node->getIntrinsicDuration() > 0 ? 1 : 0;
  const auto* stack = static_cast<const celestrian::StackNode*>(node);
  int n = 0;
  for (const auto& child : stack->ownedChildren())
    n += countCommittedClips(child.get());
  return n;
}

/**
 * Q13 FOR GROUPS (owner ruling 2026-08-21, the fractal twin of the sole
 * clip definer): the island's DEFINER STACK — a stack whose direct clip
 * children are the island's ONLY committed content and were recorded
 * as ONE take (identical origin and duration), two or more of them (a
 * single committed clip keeps the clip-definer path, whatever holds
 * it). Its window then re-establishes (Q, epoch) exactly as a sole
 * clip's does. Null otherwise. Message thread.
 */
celestrian::StackNode* definerStack(celestrian::AudioNode* node) {
  if (node->getNodeType() != celestrian::NodeType::Stack) return nullptr;
  auto* stack = static_cast<celestrian::StackNode*>(node);
  // Every committed clip below must be a DIRECT child of one stack.
  int direct = 0;
  int64_t origin = 0, duration = 0;
  celestrian::StackNode* nested = nullptr;
  for (const auto& child : stack->ownedChildren()) {
    if (child->getNodeType() == celestrian::NodeType::Clip) {
      auto* c = static_cast<celestrian::ClipNode*>(child.get());
      if (c->getIntrinsicDuration() <= 0) continue;
      if (direct == 0) {
        origin = c->origin_samples.load();
        duration = c->getIntrinsicDuration();
      } else if (c->origin_samples.load() != origin ||
                 c->getIntrinsicDuration() != duration) {
        return nullptr;  // two takes, not one
      }
      ++direct;
    } else if (countCommittedClips(child.get()) > 0) {
      if (nested != nullptr || direct > 0) return nullptr;
      nested = static_cast<celestrian::StackNode*>(child.get());
    }
  }
  if (nested != nullptr) return direct == 0 ? definerStack(nested) : nullptr;
  return direct >= 2 ? stack : nullptr;
}

celestrian::ClipNode* firstCommittedClip(celestrian::AudioNode* node) {
  if (node->getNodeType() == celestrian::NodeType::Clip) {
    return node->getIntrinsicDuration() > 0
               ? static_cast<celestrian::ClipNode*>(node)
               : nullptr;
  }
  auto* stack = static_cast<celestrian::StackNode*>(node);
  for (const auto& child : stack->ownedChildren()) {
    if (auto* c = firstCommittedClip(child.get())) return c;
  }
  return nullptr;
}

// TWO-ANCHOR CONTINUITY (owner ruling 2026-08-09, superseding both
// the 2026-07-25h origin-only re-anchor AND the brief anchor-stable
// interlude): "there is no such thing as island 3.5 — that is 0.5Q.
// The master transport is an implementation detail and should never
// bleed into the design." Requirements: (1) trims/cuts on a playing
// clip must not jump unless the edit removes the audio under the
// cursor; (2) the edited timeline is the source of truth — the seam
// renders where the cut was made.
//
// The old law satisfied (1) by moving the clip's ORIGIN alone, which
// rotated the clip's picture in the frame — the runaway was actually
// the FOLD: the monotonic transport folded by the new cycle moved the
// cursor, and the origin re-anchor chased it (field 2026-08-09,
// "split handle on the far left"). The fix is that there are TWO
// anchors — the clip's origin and the island epoch (where the fold
// starts) — and they move TOGETHER by the same whole-Q delta: audio
// continuity pins the origin exactly as before, and the epoch rider
// re-labels the fold so the edited clip's frame position is UNCHANGED.
// The cursor readout lands on the sounding material's new timeline
// home; the Q grid and every Q-period sibling are untouched (delta is
// whole-Q by the coherence guard). Longer-period siblings may show a
// whole-Q shift — the honest new cyclic alignment continuity implies.
//
// continuityOrigin: when a clip's map changes while playing, the
// origin' at which the buffer position sounding RIGHT NOW keeps
// sounding — as long as the new map still COVERS it. When the edit
// REMOVED the sounding region, origin stays FIXED (an audible jump is
// expected — you deleted what you were hearing; 2026-07-25i) and the
// epoch stays with it. An inactive map on either side is its
// full-span form. The Q13 sole-definer riders keep their own
// field-hardened algebra (island re-establish included) and win when
// they apply.
int64_t continuityOrigin(const celestrian::ClipNode& clip,
                         const celestrian::timing::TimeMap& new_map,
                         int64_t t0) {
  using TimeMap = celestrian::timing::TimeMap;
  const int64_t dur = clip.getIntrinsicDuration();
  auto effective = [dur](const TimeMap& m) {
    return m.active() ? m : TimeMap::single(0, dur);
  };
  const TimeMap oldm = effective(clip.activeTimeMap());
  const TimeMap newm = effective(new_map);
  const int64_t period = newm.period();
  const int64_t old_org = clip.origin_samples.load();
  if (period <= 0 || oldm.period() <= 0) return old_org;
  const int64_t p0 = oldm.mapOffset(t0 - old_org - oldm.mapOffset(0));
  const int64_t h_new = newm.heardOffsetOf(p0);
  if (h_new < 0) return old_org;  // sounding region removed: stay put
  return t0 - newm.mapOffset(0) - h_new;
}
}  // namespace

bool AudioEngine::isPeriodCoherentWithQuantum(int64_t period, int64_t quantum) {
  if (period <= 0) return false;
  if (quantum <= 0) return true;  // no grid yet — nothing to cohere with
  return period % quantum == 0 || quantum % period == 0;
}

namespace {
/** The island's audible period WITHOUT `skip` (message thread): the
 * effective-period fold of stack_node.cc with one clip left out — the
 * "everyone else" a map edit is judged against. A mapped stack's period
 * stands whole (its map defines the subtree's cycle). 0 = no other
 * looping content. */
int64_t periodExcluding(const celestrian::AudioNode& node,
                        const celestrian::AudioNode* skip) {
  if (&node == skip || node.periodFromContext()) return 0;  // Q5 one-shots
  if (const auto* stack = dynamic_cast<const celestrian::StackNode*>(&node)) {
    if (const auto map = stack->activeTimeMap(); map.active())
      return map.period();
    int64_t composite = 0;
    for (const auto& child : stack->ownedChildren())
      composite = celestrian::timing::foldPeriod(
          composite, periodExcluding(*child, skip));
    return composite;
  }
  return node.getEffectivePeriod();
}
}  // namespace

void AudioEngine::attachMapEditRiders(
    celestrian::Edit& e, const celestrian::ClipNode& clip,
    const celestrian::timing::TimeMap& new_map, int64_t quantum) {
  const int64_t origin = clip.origin_samples.load();
  // Audio continuity is a PLAYING concern: stopped, the origin stays.
  const int64_t origin_new =
      is_playing_global.load()
          ? continuityOrigin(clip, new_map, global_transport_pos.load())
          : origin;
  if (origin_new != origin) {
    e.setsOrigin = true;
    e.iorg = origin_new;
  }
  const int64_t delta = origin_new - origin;
  const int64_t epoch = root_node->getIslandEpoch();

  // CYCLE-TOP RULE (owner question 2026-08-18, "if my first track is
  // 1Q, why the mid-lane split?"): the loop that DEFINES the cycle
  // after this edit puts its heard top at the frame top — the visual
  // successor of "epoch re-bases to the newest cycle-defining origin"
  // (commits) and of the Q13 sole-definer re-trim (epoch := origin +
  // window start), now on a LOCKED island too. Definer = its period is
  // a multiple of Q and of every other loop's period. Whole-Q from the
  // current epoch only: the Q grid never moves (an off-grid ⌥-slid top
  // stays mid-phase — honestly). Nothing audible changes: origins are
  // absolute; the epoch is the visual top + the arm grid.
  const int64_t a0 = new_map.active() ? new_map.mapOffset(0) : 0;
  const int64_t top = origin_new + a0;
  const int64_t new_period =
      new_map.active() ? new_map.period() : clip.getIntrinsicDuration();
  const int64_t others = celestrian::timing::foldPeriod(
      quantum > 0 ? quantum : 0, periodExcluding(*root_node, &clip));
  const bool definer =
      new_period > 0 && (others <= 0 || new_period % others == 0);
  // …and only when the top is not ALREADY at the frame top: the definer's
  // period is the cycle, so a top ≡ epoch (mod period) draws identically
  // and a re-base would be pure churn (a 1Q loop under a 1Q Q: every
  // whole-Q epoch is the same frame).
  const bool top_off_frame =
      definer && (((top - epoch) % new_period) + new_period) % new_period != 0;
  if (quantum > 0 && top_off_frame && (top - epoch) % quantum == 0) {
    e.setsIsland = true;
    e.iq = quantum;  // Q unchanged — only the frame top moves
    e.iepoch = top;
    return;
  }
  // Otherwise: TWO-ANCHOR CONTINUITY (owner ruling 2026-08-09) — the
  // epoch rides the origin's whole-Q delta so the edited clip's frame
  // position is unchanged (the fold, not the clip, absorbs it).
  if (delta != 0 && quantum > 0 && delta % quantum == 0) {
    e.setsIsland = true;
    e.iq = quantum;
    e.iepoch = epoch + delta;
  }
}

int AudioEngine::islandCommittedClipCount() const {
  return root_node ? countCommittedClips(root_node.get()) : 0;
}

namespace {
void forEachStack(celestrian::AudioNode* node,
                  const std::function<void(celestrian::StackNode&)>& f) {
  if (node->getNodeType() != celestrian::NodeType::Stack) return;
  auto* stack = static_cast<celestrian::StackNode*>(node);
  f(*stack);
  for (const auto& child : stack->ownedChildren()) forEachStack(child.get(), f);
}
}  // namespace

void AudioEngine::setIslandQuantum(int64_t q, int64_t epoch,
                                   celestrian::Edit& inv) {
  const int64_t old_q = root_node->getQuantum();
  root_node->setQuantum(q, epoch);
  if (q == old_q) return;
  // SEQUENCES TRACK Q (owner ruling 2026-08-21): a step is "5Q", not
  // "220500 samples" — re-establishing Q (a definer trim) keeps every
  // step's Q value; reverting to an empty island (q == 0) clears the
  // sequences (a song over nothing has no meaning — and keeping it
  // produced a 6.52Q step when the next take set a new Q, field
  // 2026-08-21). Cleared sequences ride the inverse for undo.
  forEachStack(root_node.get(), [&](celestrian::StackNode& stack) {
    const celestrian::Sequence* cur = stack.sequencePtr();
    if (cur == nullptr) return;
    if (q <= 0) {
      celestrian::Edit::SeqRider r;
      r.uuid = stack.getUuid();
      r.seq = std::make_unique<celestrian::Sequence>(*cur);
      inv.seq_riders.push_back(std::move(r));
      stack.setAuditionStep(-1);
      if (const auto* old = stack.exchangeSequence(nullptr)) retireOwned(old);
      return;
    }
    if (old_q <= 0) return;  // nothing musical to scale from
    auto* fresh = new celestrian::Sequence(*cur);
    for (auto& st : fresh->steps) {
      st.len = (int64_t)std::llround((double)st.len * (double)q / (double)old_q);
    }
    fresh->finalize();
    if (const auto* old = stack.exchangeSequence(fresh)) retireOwned(old);
  });
}

void AudioEngine::reinstallSequenceRiders(celestrian::Edit& e) {
  for (auto& r : e.seq_riders) {
    auto* stack = dynamic_cast<celestrian::StackNode*>(
        findNodeByUuid(root_node.get(), r.uuid));
    if (stack == nullptr || !r.seq) continue;
    auto* fresh = new celestrian::Sequence(*r.seq);
    fresh->finalize();
    if (const auto* old = stack->exchangeSequence(fresh)) retireOwned(old);
  }
  e.seq_riders.clear();
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

namespace {
/** S16 (docs/sequencer.md §11.8): a window edit on a STACK stamps the
 * window's domain — sequence when authored over an active sequence
 * timeline (explicit on inverses) — and the inverse captures the old
 * stamp. Clips have no sequence: no-op. */
void stampWindowDomain(celestrian::AudioNode* node, const celestrian::Edit& e,
                       celestrian::Edit& inv) {
  auto* stack = dynamic_cast<celestrian::StackNode*>(node);
  if (stack == nullptr) return;
  inv.window_domain = (int)stack->windowDomain();
  const int fresh = e.window_domain >= 0
                        ? e.window_domain
                        : (stack->activeSequence() != nullptr ? 1 : 0);
  stack->setWindowDomain((celestrian::StackNode::WindowDomain)fresh);
}
}  // namespace

celestrian::Edit AudioEngine::applyEditImpl(celestrian::Edit e) {
  using celestrian::AudioNode;
  using celestrian::StackNode;
  using K = Edit::Kind;
  auto find = [&](const juce::String& u) {
    return findNodeByUuid(root_node.get(), u);
  };
  auto asStack = [&](const juce::String& u) {
    return dynamic_cast<StackNode*>(find(u));
  };

  switch (e.kind) {
    case K::Insert: {
      auto* parent = asStack(e.parentUuid);
      if (!parent || !e.node) return {};
      const juce::String uid = e.node->getUuid();
      const bool restoreIsland = e.setsIsland;
      const int64_t iq = e.iq, iepoch = e.iepoch;
      parent->insertChildAt(std::move(e.node), e.index);
      // Restore the island grid this insert carries (undo of a
      // provisional-Q-revert delete). The Remove inverse re-derives the
      // revert on redo, so it needs no island payload.
      Edit inv(K::Remove);
      inv.uuid = uid;
      if (restoreIsland) setIslandQuantum(iq, iepoch, inv);
      // Undo of a clearing revert: the sequences come back with the clip.
      reinstallSequenceRiders(e);
      // Undo of a RE-OPENING delete (uuid2 = the definer that delete
      // uncollapsed): re-collapse it so the locked island is exactly as
      // it was. Same derivation as the forward CollapseTake; redo's
      // Remove re-derives the uncollapse, so no payload rides back.
      if (e.uuid2.isNotEmpty()) {
        if (auto* clip = dynamic_cast<celestrian::ClipNode*>(
                findNodeByUuid(root_node.get(), e.uuid2))) {
          const int64_t dur = clip->getIntrinsicDuration();
          const int64_t ls = clip->getLoopStart();
          const int64_t le = std::min(clip->getLoopEnd(), dur);
          if (le - ls > 0 && !(ls == 0 && le >= dur)) {
            clip->collapseToWindow(ls, le - ls);
          }
        }
      }
      return inv;
    }
    case K::Remove: {
      auto* node = find(e.uuid);
      if (!node || node == root_node.get()) return {};
      if (node->isArmedOrRecording()) return {};  // cancel is the verb
      int idx = -1;
      auto* parent = parentOf(node, &idx);
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
        setIslandQuantum(0, 0, inv);  // + clears sequences into inv
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
        if (auto* survivor = firstCommittedClip(root_node.get());
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
      auto* node = find(e.uuid);
      auto* newParent = asStack(e.parentUuid);
      if (!node || !newParent) return {};
      int oldIdx = -1;
      auto* oldParent = parentOf(node, &oldIdx);
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
      auto* dragged = find(e.uuid);
      auto* target = find(e.uuid2);
      if (!dragged || !target || dragged == target) return {};
      int draggedIdx = -1, targetIdx = -1;
      auto* draggedParent = parentOf(dragged, &draggedIdx);
      auto* targetParent = parentOf(target, &targetIdx);
      if (!draggedParent || !targetParent) return {};
      auto draggedOwned = draggedParent->removeChild(draggedIdx);
      // Target index may have shifted if it shared a parent with dragged.
      int tIdx = -1;
      auto* tParent = parentOf(target, &tIdx);
      auto targetOwned = tParent->removeChild(tIdx);
      auto newStack = std::make_unique<StackNode>("Combined Stack");
      newStack->x_pos.store(targetOwned->x_pos.load());
      newStack->y_pos.store(targetOwned->y_pos.load());
      newStack->addChild(std::move(targetOwned));   // target first (index 0)
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
      auto* stack = asStack(e.uuid);
      if (!stack || stack->getNumChildren() != 2) return {};
      auto child0 = stack->removeChild(0);  // target
      auto child1 = stack->removeChild(0);  // dragged (now at 0)
      const juce::String draggedUuid = child1->getUuid();
      const juce::String targetUuid = child0->getUuid();
      auto* tParent = asStack(e.parentUuid);
      auto* dParent = asStack(e.parentUuid2);
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
      if (auto* stackParent = parentOf(stack, &stackIdx);
          stackParent && stackIdx >= 0) {
        retireOwned(stackParent->removeChild(stackIdx));
      }
      Edit inv(K::Combine);
      inv.uuid = draggedUuid;
      inv.uuid2 = targetUuid;
      return inv;
    }
    case K::Rename: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Rename);
      inv.uuid = e.uuid;
      inv.s1 = node->getName();
      node->setName(e.s1);
      return inv;
    }
    case K::Mute: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Mute);
      inv.uuid = e.uuid;
      inv.b1 = node->is_muted.load();
      node->is_muted.store(e.b1);
      return inv;
    }
    case K::PeriodSource: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::PeriodSource);
      inv.uuid = e.uuid;
      inv.b1 = node->period_from_context_.load();
      node->period_from_context_.store(e.b1);
      return inv;
    }
    case K::LoopPoints: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::LoopPoints);
      inv.uuid = e.uuid;
      inv.d1 = (double)node->getLoopStart();
      inv.d2 = (double)node->getLoopEnd();
      // Phase 3: an explicit single-window edit SUPERSEDES a
      // multi-segment override; the inverse carries the removed map
      // back (setsMap) so undo restores it.
      if (const auto* old = node->exchangeMapOverride(nullptr)) {
        inv.setsMap = true;
        inv.tmap = *old;
        retireOwned(old);
      }
      node->setLoopPoints((int64_t)e.d1, (int64_t)e.d2);
      if (e.setsMap && e.tmap.n >= 2) {
        // Undo path: reinstall the override this edit had removed.
        const auto* fresh = new celestrian::timing::TimeMap(e.tmap);
        if (const auto* prev = node->exchangeMapOverride(fresh)) {
          retireOwned(prev);
        }
      }
      stampWindowDomain(node, e, inv);
      // Q13 re-trim: if the forward edit carries an island re-establishment
      // (built by setLoopPoints when the target is the sole committed
      // clip), apply it and capture the old (Q, epoch) into the inverse so
      // undo restores the grid, not just the window.
      if (e.setsIsland) {
        inv.setsIsland = true;
        inv.iq = root_node->getQuantum();
        inv.iepoch = root_node->getEpoch();
        setIslandQuantum(e.iq, e.iepoch, inv);
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
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          findNodeByUuid(root_node.get(), e.uuid));
      if (!clip) return {};
      Edit inv(K::CollapseTake);
      inv.uuid = e.uuid;
      if (!e.b1) {
        // MULTI-SEGMENT definer (phase 3): the collapse is a SPLICE —
        // the kept cells become the take; the inverse owns the
        // pre-splice buffer + map + facts (write-once safety, the
        // owned-subtree argument).
        if (const auto* m = clip->mapOverride()) {
          inv.b1 = true;
          inv.setsMap = true;
          inv.tmap = *m;
          inv.iq = clip->origin_samples.load();
          inv.iepoch = clip->getIntrinsicDuration();
          inv.d1 = (double)clip->getContentBase();
          inv.d2 = (double)clip->recordedLength();
          // MIDI content splices its note sequence too (phase 5) —
          // BEFORE spliceToMap rewrites the shared facts (base).
          if (clip->contentKind() == celestrian::ClipNode::ContentKind::Midi)
            inv.midi = clip->spliceMidiToMap(*m);
          inv.buffer = clip->spliceToMap(*m);
          if (const auto* old = clip->exchangeMapOverride(nullptr)) {
            retireOwned(old);
          }
          return inv;
        }
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
      } else if (e.setsMap) {
        // Un-splice: reinstall the pre-splice buffer + facts, retire
        // the displaced spliced buffer, and put the map back.
        retireOwned(clip->unspliceFromMap(std::move(e.buffer), e.iq, e.iepoch,
                                          (int64_t)e.d1, (int64_t)e.d2));
        if (e.midi) retireOwned(clip->unspliceMidi(std::move(e.midi)));
        const auto* fresh = new celestrian::timing::TimeMap(e.tmap);
        if (const auto* prev = clip->exchangeMapOverride(fresh)) {
          retireOwned(prev);
        }
        // Inverse of the inverse: the parameterless forward re-derives
        // (the override is present again).
      } else {
        clip->uncollapseFromWindow(e.iq, e.iepoch);
        // inverse of the inverse: the parameterless forward re-derives.
      }
      return inv;
    }
    case K::LoopBypass: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::LoopBypass);
      inv.uuid = e.uuid;
      inv.b1 = node->isLoopWindowBypassed();
      node->setLoopWindowBypassed(e.b1);
      return inv;
    }
    case K::Segments: {
      // Multi-segment map (time_maps.md phase 3). Applied by
      // NORMALIZATION so undo round-trips through every state pair:
      // n≥2 installs an immutable override; n==1 writes the
      // single-window atomics (clearing the override); n==0 clears
      // both. The inverse captures the RAW old storage — never
      // activeTimeMap(), which reads empty under bypass and would
      // lose a bypassed node's geometry on undo.
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Segments);
      inv.uuid = e.uuid;
      inv.setsMap = true;
      if (const auto* old = node->mapOverride()) {
        inv.tmap = *old;
      } else {
        inv.tmap = celestrian::timing::TimeMap::single(node->getLoopStart(),
                                                       node->getLoopEnd());
      }
      stampWindowDomain(node, e, inv);
      if (e.tmap.n >= 2) {
        const auto* fresh = new celestrian::timing::TimeMap(e.tmap);
        if (const auto* old = node->exchangeMapOverride(fresh)) {
          retireOwned(old);
        }
      } else {
        if (const auto* old = node->exchangeMapOverride(nullptr)) {
          retireOwned(old);
        }
        if (e.tmap.n == 1) {
          node->setLoopPoints(e.tmap.segs[0].start, e.tmap.segs[0].end);
        } else {
          node->setLoopPoints(0, 0);
        }
      }
      // Q13 riders (multi-segment definer re-trim): identical shape to
      // LoopPoints — the grid and the phase re-anchor undo atomically
      // with the map.
      if (e.setsIsland) {
        inv.setsIsland = true;
        inv.iq = root_node->getQuantum();
        inv.iepoch = root_node->getEpoch();
        setIslandQuantum(e.iq, e.iepoch, inv);
      }
      if (e.setsOrigin) {
        inv.setsOrigin = true;
        inv.iorg = node->origin_samples.load();
        node->origin_samples.store(e.iorg);
      }
      return inv;
    }
    case K::Sequence: {
      // The SEQUENCER (docs/sequencer.md): install/replace/clear the
      // stack's sequence by copy-swap-retire (the Segments/map
      // discipline). The inverse owns a copy of the RAW old sequence —
      // bypassed geometry survives undo, like Segments.
      auto* stack = dynamic_cast<celestrian::StackNode*>(find(e.uuid));
      if (!stack) return {};
      Edit inv(K::Sequence);
      inv.uuid = e.uuid;
      if (const celestrian::Sequence* old = stack->sequencePtr()) {
        inv.seq = std::make_unique<celestrian::Sequence>(*old);
      }
      const celestrian::Sequence* fresh =
          e.seq ? new celestrian::Sequence(*e.seq) : nullptr;
      // The step audition names a step by INDEX: it follows a resize
      // (same count) but cannot survive a shape change (a delete
      // would silently re-aim it at the neighbour) — clear it then.
      {
        const int before = inv.seq ? inv.seq->numSteps() : 0;
        const int after = fresh ? fresh->numSteps() : 0;
        if (before != after) stack->setAuditionStep(-1);
      }
      if (const celestrian::Sequence* old = stack->exchangeSequence(fresh)) {
        retireOwned(old);
      }
      return inv;
    }
    case K::Take:
    case K::Untake: {
      // TAKES ARE UNDOABLE (docs/sequencer.md §11.5). Untake strips the
      // named clips to empty, the inverse Take OWNING their content;
      // Take reinstalls it. Island (Q, epoch) ride via setsIsland in
      // both directions (the first take's establishment, a growth
      // re-base), captured into the inverse. An optional sequence rider
      // (`seq` + `b1`, the step-record auto-gate) swaps with the same
      // copy-swap-retire discipline so take + gates undo as one.
      if (root_node->hasActiveTake()) return {};  // never under a live take
      const bool strip = e.kind == K::Untake;
      Edit inv(strip ? K::Take : K::Untake);
      // Every named clip must exist and be idle, or the edit is a Nop
      // (a deleted clip's take is gone with it — Remove owns that).
      std::vector<celestrian::ClipNode*> clips;
      for (const auto& tp : e.takes) {
        auto* clip = dynamic_cast<celestrian::ClipNode*>(find(tp.uuid));
        if (!clip || clip->isArmedOrRecording()) return {};
        if (strip && clip->duration_samples.load() <= 0) return {};
        if (!strip && clip->duration_samples.load() > 0) return {};
        clips.push_back(clip);
      }
      // Island facts: capture current, then set the payload's.
      inv.setsIsland = true;
      inv.iq = root_node->getQuantum();
      inv.iepoch = root_node->getEpoch();
      for (size_t i = 0; i < clips.size(); ++i) {
        Edit::TakePayload out;
        out.uuid = e.takes[i].uuid;
        if (strip) {
          celestrian::ClipNode::TakeState s = clips[i]->stripTake();
          out.buffer = std::move(s.buffer);
          out.midi = std::move(s.midi);
          out.origin = s.origin;
          out.duration = s.duration;
          out.base = s.base;
          out.recorded = s.recorded;
          out.context_cycle = s.context_cycle;
          out.loop_start = s.loop_start;
          out.loop_end = s.loop_end;
          out.content_kind = s.content_kind;
          out.cap_hit = s.cap_hit;
        } else {
          celestrian::ClipNode::TakeState s;
          s.buffer = std::move(e.takes[i].buffer);
          s.midi = std::move(e.takes[i].midi);
          s.origin = e.takes[i].origin;
          s.duration = e.takes[i].duration;
          s.base = e.takes[i].base;
          s.recorded = e.takes[i].recorded;
          s.context_cycle = e.takes[i].context_cycle;
          s.loop_start = e.takes[i].loop_start;
          s.loop_end = e.takes[i].loop_end;
          s.content_kind = e.takes[i].content_kind;
          s.cap_hit = e.takes[i].cap_hit;
          if (!s.buffer) return {};
          auto displaced = clips[i]->restoreTake(std::move(s));
          retireOwned(displaced.first.release());
          retireOwned(displaced.second.release());
        }
        inv.takes.push_back(std::move(out));
      }
      if (e.setsIsland) setIslandQuantum(e.iq, e.iepoch, inv);
      // The sequence rider (auto-gate).
      if (e.b1 && e.uuid.isNotEmpty()) {
        if (auto* stack = dynamic_cast<celestrian::StackNode*>(find(e.uuid))) {
          inv.b1 = true;
          inv.uuid = e.uuid;
          if (const celestrian::Sequence* old = stack->sequencePtr()) {
            inv.seq = std::make_unique<celestrian::Sequence>(*old);
          }
          const celestrian::Sequence* fresh =
              e.seq ? new celestrian::Sequence(*e.seq) : nullptr;
          if (const celestrian::Sequence* old = stack->exchangeSequence(fresh)) {
            retireOwned(old);
          }
        }
      }
      return inv;
    }
    case K::SequenceBypass: {
      auto* stack = dynamic_cast<celestrian::StackNode*>(find(e.uuid));
      if (!stack) return {};
      Edit inv(K::SequenceBypass);
      inv.uuid = e.uuid;
      inv.b1 = stack->isSequenceBypassed();
      stack->setSequenceBypassed(e.b1);
      return inv;
    }
    case K::Input: {
      auto* clip = dynamic_cast<celestrian::ClipNode*>(find(e.uuid));
      if (!clip) return {};
      Edit inv(K::Input);
      inv.uuid = e.uuid;
      inv.d1 = (double)clip->getInputChannel();
      clip->setInputChannel((int)e.d1);
      return inv;
    }
    case K::InputR: {
      auto* clip = dynamic_cast<celestrian::ClipNode*>(find(e.uuid));
      if (!clip) return {};
      Edit inv(K::InputR);
      inv.uuid = e.uuid;
      inv.d1 = (double)clip->getInputChannelRight();
      clip->setInputChannelRight((int)e.d1);
      return inv;
    }
    case K::Position: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Position);
      inv.uuid = e.uuid;
      inv.d1 = node->x_pos.load();
      inv.d2 = node->y_pos.load();
      node->x_pos.store(e.d1);
      node->y_pos.store(e.d2);
      return inv;
    }
    case K::MoveSlot: {
      auto* node = find(e.uuid);
      if (!node) return {};
      celestrian::dsp::FxChain* chain = node->fxChain();
      const int from = chain->indexOfSlot(e.s1);
      const int slot_count = (int)chain->slots().size();
      const int to = juce::jlimit(0, slot_count - 1, e.index);
      if (from < 0 || from == to) return {};
      Edit inv(K::MoveSlot);
      inv.uuid = e.uuid;
      inv.s1 = e.s1;
      inv.index = from;
      // Successor chain sharing the slot objects (DSP state survives);
      // publish, then retire the predecessor (D4 — an in-flight render
      // may read it for <= 2 more callbacks).
      auto slots = chain->slots();
      auto moved = slots[(size_t)from];
      slots.erase(slots.begin() + from);
      slots.insert(slots.begin() + to, std::move(moved));
      retireOwned(std::unique_ptr<celestrian::dsp::FxChain>(
          node->exchangeFxChain(
              celestrian::dsp::FxChain::makeFromSlots(std::move(slots))
                  .release())));
      return inv;
    }
    case K::AddSlot: {
      auto* node = find(e.uuid);
      if (!node || e.slot == nullptr) return {};
      celestrian::dsp::FxChain* chain = node->fxChain();
      auto slots = chain->slots();
      const int slot_count = (int)slots.size();
      const int to =
          e.index < 0 ? slot_count : juce::jlimit(0, slot_count, e.index);
      Edit inv(K::RemoveSlot);
      inv.uuid = e.uuid;
      inv.s1 = e.slot->slotUuid();
      slots.insert(slots.begin() + to, e.slot);
      retireOwned(std::unique_ptr<celestrian::dsp::FxChain>(
          node->exchangeFxChain(
              celestrian::dsp::FxChain::makeFromSlots(std::move(slots))
                  .release())));
      return inv;
    }
    case K::RemoveSlot: {
      auto* node = find(e.uuid);
      if (!node) return {};
      celestrian::dsp::FxChain* chain = node->fxChain();
      const int from = chain->indexOfSlot(e.s1);
      if (from < 0) return {};
      auto slots = chain->slots();
      Edit inv(K::AddSlot);
      inv.uuid = e.uuid;
      inv.index = from;
      inv.slot = slots[(size_t)from];  // the undo entry OWNS the slot
      slots.erase(slots.begin() + from);
      retireOwned(std::unique_ptr<celestrian::dsp::FxChain>(
          node->exchangeFxChain(
              celestrian::dsp::FxChain::makeFromSlots(std::move(slots))
                  .release())));
      return inv;
    }
    case K::Nop:
      return {};
  }
  return {};
}

void AudioEngine::retireEdit(celestrian::Edit&& e) {
  // Never free a detached subtree inline — an in-flight callback may read
  // it for ≤2 more callbacks. Hand it to the same graveyard the graph
  // mutations use.
  retireOwned(std::move(e.buffer));
  retireOwned(std::move(e.node));
  retireOwned(std::move(e.node2));
  // Take content (Kind::Take payloads) rides the same grace.
  for (auto& tp : e.takes) {
    retireOwned(std::move(tp.buffer));
    retireOwned(std::move(tp.midi));
  }
  // A chain slot rides the same grace: the chain that referenced it was
  // itself just retired, so an in-flight callback may still process the
  // slot. The deleter holds the shared_ptr until the grace passes.
  if (e.slot != nullptr) {
    retire([slot = std::move(e.slot)] {});
  }
}

void AudioEngine::clearRedo() {
  for (auto& e : redo_) retireEdit(std::move(e));
  redo_.clear();
}

void AudioEngine::clearHistory() {
  for (auto& e : undo_) retireEdit(std::move(e));
  undo_.clear();
  clearRedo();
  pending_takes_.clear();
}

void AudioEngine::pushUndo(celestrian::Edit&& inverse) {
  undo_.push_back(std::move(inverse));
  while (undo_.size() > kUndoDepth) {
    retireEdit(std::move(undo_.front()));
    undo_.erase(undo_.begin());
  }
  clearRedo();
}

void AudioEngine::record(celestrian::Edit forward) {
  reconcileTakes();  // a settled take logs BEFORE any later edit
  celestrian::Edit inv = applyEdit(std::move(forward));
  if (inv.kind == celestrian::Edit::Kind::Nop) return;  // did not apply
  if (!undo_.empty() && editsCoalesce(undo_.back(), inv)) {
    clearRedo();  // a fresh user action still invalidates the redo branch
    return;       // keep the older inverse (restores further back)
  }
  pushUndo(std::move(inv));
}

namespace {
bool isTakeEdit(const celestrian::Edit& e) {
  return e.kind == celestrian::Edit::Kind::Take ||
         e.kind == celestrian::Edit::Kind::Untake;
}
}  // namespace

void AudioEngine::undo() {
  reconcileTakes();
  if (undo_.empty()) return;
  // A take edit moves island facts (Q, epoch, the committed cycle):
  // never under a live take. Refuse and KEEP the entry (a Nop would
  // drop it from the log).
  if (isTakeEdit(undo_.back()) && root_node->hasActiveTake()) {
    juce::Logger::writeToLog(
        "AudioEngine::undo refused - a take is armed/recording (finish or "
        "cancel it first)");
    return;
  }
  celestrian::Edit inv = std::move(undo_.back());
  undo_.pop_back();
  celestrian::Edit fwd = applyEdit(std::move(inv));
  if (fwd.kind != celestrian::Edit::Kind::Nop) redo_.push_back(std::move(fwd));
}

void AudioEngine::redo() {
  reconcileTakes();
  if (redo_.empty()) return;
  if (isTakeEdit(redo_.back()) && root_node->hasActiveTake()) {
    juce::Logger::writeToLog(
        "AudioEngine::redo refused - a take is armed/recording (finish or "
        "cancel it first)");
    return;
  }
  celestrian::Edit fwd = std::move(redo_.back());
  redo_.pop_back();
  celestrian::Edit inv = applyEdit(std::move(fwd));
  if (inv.kind != celestrian::Edit::Kind::Nop) undo_.push_back(std::move(inv));
}

void AudioEngine::deleteNode(const juce::String& uuid) {
  celestrian::Edit e(celestrian::Edit::Kind::Remove);
  e.uuid = uuid;
  record(std::move(e));
}

bool AudioEngine::saveSession(const juce::String& path) {
  return celestrian::session_io::save(*root_node, cached_sample_rate_.load(),
                                      juce::File(path));
}

bool AudioEngine::loadSession(const juce::String& path) {
  // Refuse mid-take: an in-flight capture is TRANSIENT, not saved, and
  // tearing the graph out from under it would corrupt the buffer.
  if (root_node->hasActiveTake()) return false;

  auto loaded = celestrian::session_io::load(juce::File(path),
                                             cached_sample_rate_.load());
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
    for (auto& node : root_node->clearChildren()) {
      retireOwned(std::move(node));
    }
  }
  for (auto& child : loaded.children) root_node->addChild(std::move(child));

  // Force the island facts. addChild may have transiently re-established
  // (Q, epoch) from the first committed clip using the CLIP's origin as
  // the epoch (wrong); this overrides it with the persisted values.
  root_node->setQuantum(loaded.q_samples, loaded.epoch);
  root_node->is_muted.store(loaded.root_muted);
  celestrian::session_io::applyEffects(
      *root_node, loaded.root_effects, loaded.sample_rate,
      [this](celestrian::dsp::FxChain* old) { retireOwned(old); });
  publishGraph();  // the audio thread sees the loaded topology

  focused_node = root_node.get();
  clearHistory();  // a loaded session starts with no undo history

  juce::Logger::writeToLog("AudioEngine: session loaded from " + path);
  // The ONE post-load hook (all load paths funnel through here —
  // bridge, chooser, project manager): MainComponent uses it for the
  // plugin revival sweep (docs/vst3.md §6).
  if (on_session_loaded_) on_session_loaded_();
  return true;
}

namespace {

/** Q7 GROUP ARM (owner ruling 2026-07-09): record is fractal — on a
 * clip it records that clip; on a stack it records the stack's members.
 * These helpers walk the OWNERSHIP tree (message thread only — this is
 * type discrimination on a user-supplied target, not audio-thread
 * traversal).
 *
 * "Arm targets emptiness" (Q7 refinement): a clip that already has
 * content cannot be re-recorded — group record arms only the EMPTY
 * clips; the full ones just play. Re-recording content is the *takes*
 * feature, not arm. */
void collectArmTargets(celestrian::AudioNode* node,
                       std::vector<celestrian::ClipNode*>& out) {
  if (node->getNodeType() == celestrian::NodeType::Clip) {
    auto* clip = static_cast<celestrian::ClipNode*>(node);
    if (clip->recState() == celestrian::ClipNode::RecState::Idle &&
        clip->getIntrinsicDuration() == 0) {
      out.push_back(clip);
    }
    return;
  }
  if (auto* stack = dynamic_cast<celestrian::StackNode*>(node)) {
    for (const auto& child : stack->ownedChildren()) {
      collectArmTargets(child.get(), out);
    }
  }
}

/** Every clip in `node`'s subtree with a live take (armed / capturing /
 * pending stop) — the group-stop set. */
void collectHotClips(celestrian::AudioNode* node,
                     std::vector<celestrian::ClipNode*>& out) {
  if (node->getNodeType() == celestrian::NodeType::Clip) {
    auto* clip = static_cast<celestrian::ClipNode*>(node);
    if (clip->recState() != celestrian::ClipNode::RecState::Idle) {
      out.push_back(clip);
    }
    return;
  }
  if (auto* stack = dynamic_cast<celestrian::StackNode*>(node)) {
    for (const auto& child : stack->ownedChildren()) {
      collectHotClips(child.get(), out);
    }
  }
}

}  // namespace

void AudioEngine::startRecordingInNode(const juce::String& uuid) {
  juce::Logger::writeToLog("AudioEngine: start_recording requested for " +
                           uuid);

  // If the whole song is stopped when clicking record, automatically play
  if (!is_playing_global.load()) {
    is_playing_global.store(true);
    juce::Logger::writeToLog(
        "AudioEngine: Auto-starting transport for recording.");
  }

  auto* node = findNodeByUuid(root_node.get(), uuid);
  if (node == nullptr) {
    juce::Logger::writeToLog("AudioEngine: NODE NOT FOUND for " + uuid);
    return;
  }

  // Q13 LOCK-COLLAPSE (owner ruling 2026-07-19): arming a take
  // against a provisionally-trimmed island FINALIZES the trim — the
  // sole committed clip collapses to its window BEFORE the arm, so
  // every boundary computation (context loop, heard/intrinsic cycle
  // snapshots, LCMs) sees an ordinary whole-Q looper. Leaving the
  // incommensurate buffer alive poisoned them all: field 2026-07-19b,
  // take 2 anchored at origin − epoch = 56298 ∉ Q·Z. Undoable —
  // ⌘Z restores the full buffer and the trim. (A stack target can
  // never BE the definer clip, so the != uuid guard stays correct for
  // group arms.)
  if (islandCommittedClipCount() == 1) {
    if (auto* definer = firstCommittedClip(root_node.get());
        definer && definer->getUuid() != uuid &&
        definer->isLoopWindowActive()) {
      celestrian::Edit e(celestrian::Edit::Kind::CollapseTake);
      e.uuid = definer->getUuid();
      record(std::move(e));  // no-op (not recorded) if already full-span
    }
  }

  // Q7 GROUP ARM: resolve the whole arm set — a clip records itself, a
  // stack records its EMPTY clip descendants — and arm it in THIS one
  // message-thread call. One call means the group shares one arm target
  // and one committed duration (one performance, N microphones): the
  // per-clip bridge loop this replaces could straddle an audio block
  // and split the group across two boundaries.
  std::vector<celestrian::ClipNode*> targets;
  collectArmTargets(node, targets);
  if (targets.empty()) {
    juce::Logger::writeToLog(
        "AudioEngine: record refused — no empty clip to arm under " + uuid +
        " (arm targets emptiness, Q7; re-recording is the takes feature)");
    return;
  }

  // THROUGH-MAP ARM (time_maps.md phase 2): an ACTIVE map on an
  // ancestor shapes each take — the take records THROUGH it (heard
  // arm math, one-period cap, dense [0, C) commit). The walk runs on
  // the message thread (parent chains are legal here); C = the
  // mapping node's full inner cycle, snapshotted at arm (map edits
  // are gated while the take is live). Computed per target (an
  // intermediate stack's map shapes only the clips beneath it); ANY
  // refusal refuses the WHOLE group — a group take is one performance,
  // and arming half of it would be worse than arming none.
  std::vector<int64_t> through_map_cycles(targets.size(), 0);
  for (size_t i = 0; i < targets.size(); ++i) {
    int active_maps = 0;
    celestrian::AudioNode* mapping = nullptr;
    for (auto* a = targets[i]->getParent(); a != nullptr;
         a = a->getParent()) {
      if (a->activeTimeMap().active()) {
        ++active_maps;
        if (mapping == nullptr) mapping = a;  // nearest wins
      }
    }
    if (active_maps > 1) {
      // Composed active maps are a multi-segment PRODUCT — outside
      // the ratified phase-2 scope (single map). Refuse the arm.
      juce::Logger::writeToLog(
          "AudioEngine: record refused — nested active loop windows "
          "(bypass one to record through the other)");
      return;
    }
    if (mapping != nullptr && root_node->getQuantum() > 0) {
      const int64_t period = mapping->activeTimeMap().period();
      // S18 (ruled 2026-08-20, docs/sequencer.md §11.4): under an
      // ACTIVE SEQUENCE on the mapping node the take is a STEP-SIZED
      // PART — C = the map period, no silence inserted ("we should not
      // be in the business of inserting silence"); the gate decides
      // where it plays. Without a sequence the phase-2 rule stands:
      // the mapping node's full inner cycle, dense.
      const int64_t C = mapping->activeSequenceLen() > 0
                            ? period
                            : std::max(mapping->getIntrinsicDuration(), period);
      if (C > celestrian::ClipNode::kMaxTakeSamples / 2) {
        juce::Logger::writeToLog(
            "AudioEngine: record refused — the mapped cycle is too "
            "large for a dense take buffer");
        return;
      }
      through_map_cycles[i] = C;
    }
  }

  // The clock is NEVER reset (kernel.md §2) — not even for the first
  // clip. What the old "Initial Recording Reset" actually provided was
  // the island epoch; that is now captured as data (epoch := arm
  // moment) in ClipNode's first-clip arm path, leaving the clock
  // untouched.
  for (size_t i = 0; i < targets.size(); ++i) {
    targets[i]->startRecording(through_map_cycles[i]);
  }

  // MIDI takes (phase 5): recording a MIDI track means "my keyboard
  // goes here" — MIDI-arm it so the performer hears the instrument
  // they are recording into (single-armed: the first MIDI target of a
  // group takes it; capture itself reads the input regardless).
  for (auto* target : targets) {
    if (target->contentKind() == celestrian::ClipNode::ContentKind::Midi) {
      if (!target->midi_armed.load()) setMidiArmed(target->getUuid(), true);
      break;
    }
  }

  // TAKES ARE UNDOABLE: register the performance; reconcileTakes logs
  // it once every member has settled (see PendingTake).
  {
    PendingTake p;
    for (auto* target : targets) p.uuids.push_back(target->getUuid());
    p.q_before = root_node->getQuantum();
    p.epoch_before = root_node->getEpoch();
    // Aimed at a looping step? The nearest auditioning ancestor that is
    // the DIRECT parent of a target (§11.5) names the auto-gate.
    for (auto* target : targets) {
      auto* parent = dynamic_cast<celestrian::StackNode*>(target->getParent());
      if (parent != nullptr && parent->auditionActive()) {
        p.gate_stack = parent->getUuid();
        p.gate_step = parent->auditionStep();
        break;
      }
    }
    pending_takes_.push_back(std::move(p));
  }
}

void AudioEngine::reconcileTakes() {
  // See PendingTake (audio_engine.h). Message thread only.
  for (size_t i = 0; i < pending_takes_.size();) {
    PendingTake& p = pending_takes_[i];
    bool settled = true;
    std::vector<celestrian::ClipNode*> committed;
    for (const auto& u : p.uuids) {
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          findNodeByUuid(root_node.get(), u));
      if (clip == nullptr) continue;  // deleted/cancelled: nothing to log
      if (clip->isArmedOrRecording()) {
        settled = false;
        break;
      }
      if (clip->duration_samples.load() > 0) committed.push_back(clip);
    }
    if (!settled) {
      ++i;
      continue;
    }
    PendingTake done = std::move(p);
    pending_takes_.erase(pending_takes_.begin() + (long)i);
    if (committed.empty()) continue;  // the whole performance cancelled

    // The log entry is the INVERSE (Untake): it names the clips and
    // carries the island facts as they were BEFORE the performance, so
    // undo restores the grid with the content. applyEdit on Untake
    // builds the forward Take (owning the stripped content) for redo.
    celestrian::Edit inv(celestrian::Edit::Kind::Untake);
    for (auto* clip : committed) {
      celestrian::Edit::TakePayload tp;
      tp.uuid = clip->getUuid();
      inv.takes.push_back(std::move(tp));
    }
    inv.setsIsland = true;
    inv.iq = done.q_before;
    inv.iepoch = done.epoch_before;
    pushUndo(std::move(inv));
    clearRedo();  // a new performance invalidates the redo branch
    juce::Logger::writeToLog(
        "AudioEngine: take logged (undoable) - " +
        juce::String((int)committed.size()) + " clip(s)");

    // STEP-RECORD AUTO-GATE (docs/sequencer.md §11.5, S19): the take
    // was aimed at a looping step — gate each committed DIRECT child of
    // the auditioning stack ON in that step, OFF elsewhere, as ONE
    // Edit::Sequence that COALESCES with the take's entry, so one ⌘Z
    // removes take + gates together.
    if (done.gate_stack.isNotEmpty() && done.gate_step >= 0) {
      applyAutoGate(done.gate_stack, done.gate_step, committed);
    }
  }
}

void AudioEngine::applyAutoGate(
    const juce::String& stack_uuid, int step,
    const std::vector<celestrian::ClipNode*>& committed) {
  auto* stack = dynamic_cast<celestrian::StackNode*>(
      findNodeByUuid(root_node.get(), stack_uuid));
  if (stack == nullptr) return;
  const celestrian::Sequence* cur = stack->sequencePtr();
  if (cur == nullptr || step >= cur->numSteps()) return;
  auto fresh = std::make_unique<celestrian::Sequence>(*cur);
  bool changed = false;
  for (auto* clip : committed) {
    // Direct children only (§11.5): a deeper take must not gate its
    // whole group off in every other section.
    if (clip->getParent() != stack) continue;
    const uint64_t mask = 1ull << step;
    bool found = false;
    for (auto& row : fresh->gates) {
      if (row.uuid == clip->getUuid()) {
        row.mask = mask;
        found = true;
      }
    }
    if (!found) {
      celestrian::Sequence::GateRow row;
      row.uuid = clip->getUuid();
      row.mask = mask;
      fresh->gates.push_back(std::move(row));
    }
    changed = true;
  }
  if (!changed) {
    juce::Logger::writeToLog(
        "AudioEngine: step-take landed ungated (not a direct child of the "
        "looping stack) - gate it by hand");
    return;
  }
  fresh->finalize();
  celestrian::Edit e(celestrian::Edit::Kind::Sequence);
  e.uuid = stack_uuid;
  e.seq = std::move(fresh);
  e.b1 = true;  // auto-gate marker: coalesces onto the take's log entry
  celestrian::Edit inv = applyEdit(std::move(e));
  if (inv.kind == celestrian::Edit::Kind::Nop) return;
  // Compose: the Untake entry on top of the log absorbs the gate
  // inverse — undo applies the sequence restore, then the strip.
  if (!undo_.empty() && undo_.back().kind == celestrian::Edit::Kind::Untake) {
    undo_.back().seq = std::move(inv.seq);
    undo_.back().uuid = stack_uuid;
    undo_.back().b1 = true;
  } else {
    pushUndo(std::move(inv));
  }
}

void AudioEngine::stopRecordingInNode(const juce::String& uuid) {
  juce::Logger::writeToLog("AudioEngine: stop_recording requested for " + uuid);
  auto* node = findNodeByUuid(root_node.get(), uuid);
  if (node == nullptr) return;
  // Q7: stop is fractal like arm — a stack target stops every live take
  // beneath it in ONE message-thread pass, so the audio thread sees all
  // the stop requests at the same block top and the group commits at
  // one shared boundary (one committed duration).
  std::vector<celestrian::ClipNode*> hot;
  collectHotClips(node, hot);
  // Snapshot the island-Q fact BEFORE any stop runs: a first-take group
  // stop commits its first clip immediately, which ESTABLISHES Q — read
  // after that, the siblings would flip onto the record-to-next-boundary
  // path and run a full extra Q (one performance, one duration).
  const bool had_quantum = root_node->getQuantum() > 0;
  for (auto* clip : hot) {
    clip->stopRecording(had_quantum);
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
  // The poll is also where settled takes enter the undo log (see
  // PendingTake): message-thread bookkeeping on a const read path —
  // the one sanctioned const_cast, for the same reason the RtLog drain
  // lives here.
  const_cast<AudioEngine*>(this)->reconcileTakes();

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
  // The RAW island clock (epoch-relative, unwrapped): masterPos above is
  // folded on the CURRENT audible cycle, so its fold point jumps when a
  // live map edit changes that cycle mid-gesture. The UI folds this
  // invariant clock on its own (pinned) frame for a continuous cursor.
  const double island_view = (double)(t - islandEpoch());

  if (focused_node) {
    auto metadata = focused_node->getMetadata();
    auto* obj = metadata.getDynamicObject();
    attachTransportState(*obj, master_view, island_view);
    // NOTE: the focused stack's metadata already carries `quantum` (its
    // stored island Q, stack_node.cc) — the VM reads it as the top-level
    // Q fact instead of re-deriving min-over-nodes (P0-3 completion).
    obj->setProperty("focusedId", focused_node->getUuid());
    return metadata;
  }

  juce::DynamicObject::Ptr state = new juce::DynamicObject();
  attachTransportState(*state, master_view, island_view);
  state->setProperty("quantum",
                     (double)(root_node ? root_node->getQuantum() : 0));
  state->setProperty("nodes", juce::Array<juce::var>());
  return juce::var(state.get());
}

void AudioEngine::attachTransportState(juce::DynamicObject& state,
                                       double master_view,
                                       double island_view) const {
  state.setProperty("isPlaying", (bool)is_playing_global.load());
  state.setProperty("masterPos", master_view);
  state.setProperty("islandPos", island_view);
  // The island epoch is the UI's frame origin for every cycle-relative
  // projection (kernel.md one-frame rule). It is NOT the root node's
  // `origin` metadata — commit re-bases the epoch (see processBlock),
  // and the UI marking take-vs-ghost tiles needs the re-based value.
  state.setProperty("islandEpoch", (double)islandEpoch());
  // Master monitor: smoothed output RMS per channel (linear 0..1) —
  // the transport VU section reads these off the state poll.
  state.setProperty("masterVuL", (double)master_vu_l_.load());
  state.setProperty("masterVuR", (double)master_vu_r_.load());
  state.setProperty("canUndo", canUndo());
  state.setProperty("canRedo", canRedo());
  state.setProperty("perf", makePerfState());
}

juce::var AudioEngine::getWaveform(const juce::String& uuid,
                                   int num_peaks) const {
  auto* self = const_cast<AudioEngine*>(this);
  if (auto* node = self->findNodeByUuid(root_node.get(), uuid)) {
    return node->getWaveform(num_peaks);
  }
  return juce::Array<juce::var>();
}

// --- Stack Expand/Collapse ---

void AudioEngine::toggleStackExpand(const juce::String& uuid) {
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
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

void AudioEngine::createNode(const juce::String& type,
                             const juce::String& parent_uuid) {
  // Find target parent stack
  celestrian::StackNode* target_stack = nullptr;

  if (!parent_uuid.isEmpty()) {
    // Use specified parent
    auto* parent_node = findNodeByUuid(root_node.get(), parent_uuid);
    target_stack = dynamic_cast<celestrian::StackNode*>(parent_node);
  } else {
    // Default to focused_node
    target_stack = dynamic_cast<celestrian::StackNode*>(focused_node);
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
    target_stack = dynamic_cast<celestrian::StackNode*>(focused_node);
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

void AudioEngine::setNodePosition(const juce::String& node_uuid, double x,
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
  if (auto* device = device_manager.getCurrentAudioDevice()) {
    auto inputNames = device->getInputChannelNames();
    const auto active = device->getActiveInputChannels();
    // Only ACTIVE channels, in active order: the callback's
    // input_channel_data is indexed by active channel, so listing an
    // inactive one would hand the UI an index that addresses a different
    // channel (or none). enableAllInputChannels normally makes these the
    // same list — this stays correct when it can't.
    for (int i = 0; i < inputNames.size(); ++i) {
      if (active[i]) names.add(inputNames[i]);
    }
    juce::Logger::writeToLog("AudioEngine: Found " +
                             juce::String(names.size()) + " active of " +
                             juce::String(inputNames.size()) +
                             " input channels on '" + device->getName() + "'.");
  }
  juce::DynamicObject::Ptr obj = new juce::DynamicObject();
  obj->setProperty("inputs", names);
  return juce::var(obj.get());
}

// --- Device selection (docs/performance.md §4) ---

juce::var AudioEngine::getAudioDeviceState() const {
  juce::DynamicObject::Ptr obj = new juce::DynamicObject();

  // const_cast: every accessor used here is logically const, but
  // AudioDeviceManager does not mark them so.
  auto& mgr = const_cast<juce::AudioDeviceManager&>(device_manager);

  juce::Array<juce::var> types;
  bool asio_available = false;
  for (auto* type : mgr.getAvailableDeviceTypes()) {
    types.add(type->getTypeName());
    if (type->getTypeName().containsIgnoreCase("ASIO")) asio_available = true;
  }
  obj->setProperty("types", types);
  obj->setProperty("currentType", mgr.getCurrentAudioDeviceType());
  obj->setProperty("asioAvailable", asio_available);

  juce::Array<juce::var> devices;
  if (auto* type = mgr.getCurrentDeviceTypeObject()) {
    type->scanForDevices();  // hot-plug: the picker is opened on demand
    for (const auto& name : type->getDeviceNames(false)) devices.add(name);
  }
  obj->setProperty("devices", devices);

  juce::Array<juce::var> rates, buffers;
  auto* device = mgr.getCurrentAudioDevice();
  if (device != nullptr) {
    obj->setProperty("currentDevice", device->getName());
    for (double r : device->getAvailableSampleRates()) rates.add(r);
    for (int b : device->getAvailableBufferSizes()) buffers.add(b);
    obj->setProperty("currentSampleRate", device->getCurrentSampleRate());
    obj->setProperty("currentBufferSize",
                     device->getCurrentBufferSizeSamples());
    obj->setProperty("inputChannels",
                     device->getActiveInputChannels().countNumberOfSetBits());
    obj->setProperty("outputChannels",
                     device->getActiveOutputChannels().countNumberOfSetBits());
    // What the picker shows as the payoff of switching drivers.
    obj->setProperty("availableInputChannels",
                     device->getInputChannelNames().size());
  } else {
    obj->setProperty("currentDevice", juce::String());
    obj->setProperty("currentSampleRate", 0.0);
    obj->setProperty("currentBufferSize", 0);
    obj->setProperty("inputChannels", 0);
    obj->setProperty("outputChannels", 0);
    obj->setProperty("availableInputChannels", 0);
  }
  obj->setProperty("sampleRates", rates);
  obj->setProperty("bufferSizes", buffers);
  obj->setProperty("error", device_error_);

  return juce::var(obj.get());
}

juce::String AudioEngine::setAudioDevice(const juce::String& type,
                                         const juce::String& device,
                                         double sample_rate, int buffer_size) {
  // Switching driver type first: the device list is scoped to the type, so
  // a name from the new type is meaningless until the type is current.
  if (type.isNotEmpty() && type != device_manager.getCurrentAudioDeviceType()) {
    device_manager.setCurrentAudioDeviceType(type, true);
  }

  auto setup = device_manager.getAudioDeviceSetup();
  if (device.isNotEmpty()) {
    setup.inputDeviceName = device;
    setup.outputDeviceName = device;
  }
  // 0 = "whatever the device prefers" — which is what a type switch leaves
  // behind, and forcing a stale rate onto new hardware just fails the open.
  if (sample_rate > 0) setup.sampleRate = sample_rate;
  if (buffer_size > 0) setup.bufferSize = buffer_size;
  setup.useDefaultInputChannels = true;  // negotiate first…
  setup.useDefaultOutputChannels = true;

  device_error_ = device_manager.setAudioDeviceSetup(setup, true);
  if (device_error_.isNotEmpty()) {
    juce::Logger::writeToLog("AudioEngine: setAudioDevice('" + type + "', '" +
                             device + "') FAILED: " + device_error_);
    return device_error_;
  }

  enableAllInputChannels();  // …then widen to every channel it has
  persistAudioDevice();

  if (auto* opened = device_manager.getCurrentAudioDevice()) {
    juce::Logger::writeToLog(
        "AudioEngine: device set to '" + opened->getName() + "' (" +
        device_manager.getCurrentAudioDeviceType() +
        ") sr=" + juce::String(opened->getCurrentSampleRate()) + " block=" +
        juce::String(opened->getCurrentBufferSizeSamples()) + " inputs=" +
        juce::String(opened->getActiveInputChannels().countNumberOfSetBits()));
  }
  return {};
}

juce::File AudioEngine::audioDeviceFile() const {
  return appDataFile(audio_device_file_override_, "audio_device.xml");
}

void AudioEngine::setAudioDeviceFile(const juce::File& file) {
  audio_device_file_override_ = file;
}

void AudioEngine::persistAudioDevice() {
  auto state = device_manager.createStateXml();
  if (state == nullptr) {
    // Null means "nothing but defaults" — there is no selection worth
    // storing, and writing an empty file would just shadow a later one.
    return;
  }
  auto file = audioDeviceFile();
  file.getParentDirectory().createDirectory();
  if (state->writeTo(file)) {
    juce::Logger::writeToLog("AudioEngine: device setup persisted -> " +
                             file.getFullPathName());
  } else {
    juce::Logger::writeToLog("AudioEngine: FAILED to persist device setup to " +
                             file.getFullPathName());
  }
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

void AudioEngine::refreshMidiInputs() {
  for (const auto& device : juce::MidiInput::getAvailableDevices()) {
    if (!device_manager.isMidiInputDeviceEnabled(device.identifier))
      device_manager.setMidiInputDeviceEnabled(device.identifier, true);
  }
  if (!midi_callback_registered_) {
    // Empty identifier = every enabled device routes here.
    device_manager.addMidiInputDeviceCallback({}, this);
    midi_callback_registered_ = true;
  }
}

juce::var AudioEngine::getMidiInputs() const {
  juce::Array<juce::var> names;
  for (const auto& device : juce::MidiInput::getAvailableDevices())
    names.add(device.name);
  auto* out = new juce::DynamicObject();
  out->setProperty("devices", names);
  out->setProperty("dropped", midi_input_queue_.droppedCount());
  return juce::var(out);
}

void AudioEngine::handleIncomingMidiMessage(juce::MidiInput*,
                                            const juce::MidiMessage& message) {
  midi_input_queue_.push(message);
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

void AudioEngine::setLoopPoints(const juce::String& uuid, int64_t start,
                                int64_t end) {
  juce::Logger::writeToLog("AudioEngine::setLoopPoints: uuid=" + uuid +
                           " start=" + juce::String(start) +
                           " end=" + juce::String(end));
  // MID-TAKE MAP-EDIT GATE (time_maps.md phase 2, owner-ruled): a take
  // recording THROUGH this node's map froze the map's geometry at arm
  // (anchor, seams, commit cycle) — editing the window under it would
  // change time under the recorder. Refuse until the take commits.
  // Sibling windows stay editable (they don't shape this recorder's
  // clock; their heard-cycle effect was snapshotted at arm).
  if (auto* target = findNodeByUuid(root_node.get(), uuid);
      target && target->getNodeType() == celestrian::NodeType::Stack &&
      target->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::setLoopPoints refused — a take is recording "
        "through this window (finish or cancel it first)");
    return;
  }
  // COHERENCE GUARD (owner ruling 2026-08-09): a window length off the
  // Q grid is refused — categorical, both sides (the UI snaps; the
  // engine enforces). One incoherent map period LCM'd the effective
  // cycle to 66187Q (field video 2026-08-08) and blanked the timeline.
  // The sole exception is the Q13 sole-definer re-trim below, where
  // the window length *re-establishes* Q rather than fighting it.
  // Lengths are checked post-clamp (the same clamp the clip branch
  // applies), so the judged window is the one that would be stored.
  if (auto* target = findNodeByUuid(root_node.get(), uuid)) {
    const int64_t c_start = std::max((int64_t)0, start);
    int64_t c_end = end;
    auto* clip = dynamic_cast<celestrian::ClipNode*>(target);
    if (clip != nullptr) c_end = std::min(end, clip->getIntrinsicDuration());
    const bool clip_definer = clip != nullptr &&
                              clip->getIntrinsicDuration() > 0 &&
                              islandCommittedClipCount() == 1;
    // Q13 for groups (2026-08-21): the definer STACK's window
    // re-establishes Q too.
    const bool stack_definer =
        clip == nullptr && definerStack(root_node.get()) == target;
    const bool q13_retrim = c_end > c_start &&
                            (clip_definer || stack_definer) &&
                            !root_node->hasActiveTake();
    const int64_t q = target->getEffectiveQuantum();
    const int64_t len = c_end - c_start;
    if (!q13_retrim && q > 0 && len > 0 &&
        !isPeriodCoherentWithQuantum(len, q)) {
      juce::Logger::writeToLog(
          "AudioEngine::setLoopPoints refused — window length " +
          juce::String(len) + " is neither a whole multiple nor an " +
          "exact divisor of Q " + juce::String(q) +
          " (coherence is categorical)");
      return;
    }
  }
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
  if (auto* clip = dynamic_cast<celestrian::ClipNode*>(
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
              ? oldStart +
                    (((t0 - oldOrg - oldStart) % oldLen) + oldLen) % oldLen
              : start;
      const int64_t pT = start + (((p0 - start) % len) + len) % len;
      e.setsOrigin = true;
      e.iorg = t0 - pT;
      e.setsIsland = true;
      e.iq = len;
      e.iepoch = e.iorg + start;
    } else if (clip->getIntrinsicDuration() > 0 && !root_node->hasActiveTake()) {
      // CYCLE-TOP RULE + TWO-ANCHOR CONTINUITY (see attachMapEditRiders).
      attachMapEditRiders(e, *clip,
                          end > start
                              ? celestrian::timing::TimeMap::single(start, end)
                              : celestrian::timing::TimeMap::none(),
                          root_node->getEffectiveQuantum());
    }
  } else if (auto* stack = dynamic_cast<celestrian::StackNode*>(
                 findNodeByUuid(root_node.get(), uuid));
             stack != nullptr && definerStack(root_node.get()) == stack &&
             !root_node->hasActiveTake()) {
    // Q13 FOR GROUPS (owner ruling 2026-08-21): the definer STACK's
    // window re-establishes the island exactly as a sole clip's does —
    // Q := window length, epoch := the performance moment of the
    // trimmed loop's top — but the window lives on the STACK (it IS
    // the part, per the window law) and the children stay whole: no
    // origin re-anchor, no lock-collapse later (a 1Q-long stack window
    // is coherent by construction once Q = its length). PHASE-
    // PRESERVING like the clip path: the inner position sounding right
    // now folds into the new window, and the epoch is solved so that
    // position does not move: pos(t) = start + ((t − epoch) mod len).
    const int64_t inner = stack->getIntrinsicDuration();
    start = std::max((int64_t)0, start);
    if (inner > 0) end = std::min(end, inner);
    e.d1 = (double)start;
    e.d2 = (double)end;
    if (end > start && inner > 0) {
      const int64_t t0 = global_transport_pos.load();
      const int64_t epoch0 = root_node->getEpoch();
      const int64_t len = end - start;
      const celestrian::timing::TimeMap old_map = stack->activeTimeMap();
      int64_t p0;
      if (old_map.active() && old_map.n == 1) {
        const int64_t os = old_map.segs[0].start;
        const int64_t ol = old_map.period();
        p0 = ol > 0 ? os + (((t0 - epoch0 - os) % ol) + ol) % ol : start;
      } else {
        p0 = (((t0 - epoch0) % inner) + inner) % inner;
      }
      const int64_t pT = start + (((p0 - start) % len) + len) % len;
      e.setsIsland = true;
      e.iq = len;
      e.iepoch = t0 - (pT - start);
    }
  }
  record(std::move(e));
}

void AudioEngine::setSegments(const juce::String& uuid,
                              const celestrian::timing::TimeMap& map) {
  using TimeMap = celestrian::timing::TimeMap;
  auto* target = findNodeByUuid(root_node.get(), uuid);
  if (target == nullptr) return;

  // MID-TAKE MAP-EDIT GATE (owner-ruled, phase 2): a take recording
  // through this map froze its geometry at arm. Any armed/recording
  // target refuses (a stack answers for its subtree).
  if (target->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::setSegments refused — a take is armed/recording "
        "here (finish or cancel it first)");
    return;
  }

  // Structural sanity only (time_maps.md §4: the EDITOR owns coherence
  // — seam theorem; the engine owns well-formedness): ordered,
  // disjoint, each non-empty, within the node's inner cycle.
  const int64_t intrinsic = target->getIntrinsicDuration();
  int64_t prev_end = 0;
  for (int i = 0; i < map.n; ++i) {
    const auto& s = map.segs[i];
    if (s.end <= s.start || s.start < prev_end ||
        (intrinsic > 0 && s.end > intrinsic)) {
      juce::Logger::writeToLog(
          "AudioEngine::setSegments refused — malformed segment list");
      return;
    }
    prev_end = s.end;
  }

  // n ≤ 1 is the single-window form: ONE code path — setLoopPoints
  // owns the Q13 machinery and clears any override.
  if (map.n == 0) {
    setLoopPoints(uuid, 0, 0);
    return;
  }
  if (map.n == 1) {
    setLoopPoints(uuid, map.segs[0].start, map.segs[0].end);
    return;
  }

  // COHERENCE GUARD (owner ruling 2026-08-09): the map's PERIOD must
  // be a whole multiple of Q — categorical, both sides (the UI snaps;
  // the engine enforces). One incoherent period LCM'd the effective
  // cycle to 66187Q (field video 2026-08-08) and blanked the timeline.
  // The sole exception is the Q13 sole-definer re-trim below, where
  // the period *re-establishes* Q rather than fighting it. (The n ≤ 1
  // delegations above are guarded inside setLoopPoints.)
  {
    const bool q13_retrim =
        dynamic_cast<celestrian::ClipNode*>(target) != nullptr &&
        intrinsic > 0 && islandCommittedClipCount() == 1 &&
        !root_node->hasActiveTake();
    const int64_t q = target->getEffectiveQuantum();
    const int64_t p = map.period();
    if (!q13_retrim && q > 0 && !isPeriodCoherentWithQuantum(p, q)) {
      juce::Logger::writeToLog(
          "AudioEngine::setSegments refused — period " + juce::String(p) +
          " is neither a whole multiple nor an " + "exact divisor of Q " +
          juce::String(q) + " (coherence is categorical)");
      return;
    }
  }

  celestrian::Edit e(celestrian::Edit::Kind::Segments);
  e.uuid = uuid;
  e.setsMap = true;
  e.tmap = map;

  // Q13 — multi-segment re-trim before lock (the punch/cell twin of
  // the provisional window trim): while the island's ONLY committed
  // content is this clip, the map re-establishes (Q := period,
  // epoch := origin' + mapOffset(0)), with the phase-preserving origin
  // re-anchor generalized through the map: the buffer position
  // sounding RIGHT NOW keeps sounding (inverse-mapped when still
  // covered; the old heard phase folds into the new period when the
  // cut removed it).
  if (auto* clip = dynamic_cast<celestrian::ClipNode*>(target);
      clip != nullptr && intrinsic > 0 && islandCommittedClipCount() == 1 &&
      !root_node->hasActiveTake()) {
    const int64_t t0 = global_transport_pos.load();
    const TimeMap old_map = clip->activeTimeMap();
    const int64_t period = map.period();
    const int64_t a0 = map.mapOffset(0);
    int64_t h_new = 0;
    if (old_map.active() && old_map.period() > 0) {
      const int64_t old_org = clip->origin_samples.load();
      const int64_t p0 = old_map.mapOffset(t0 - old_org - old_map.mapOffset(0));
      const int64_t inv_h = map.heardOffsetOf(p0);
      if (inv_h >= 0) {
        h_new = inv_h;
      } else {
        const int64_t h0 = old_map.heardOffsetOf(p0);  // ≥ 0 by constr.
        h_new = ((h0 % period) + period) % period;
      }
    }
    const int64_t origin_new = t0 - a0 - h_new;
    e.setsOrigin = true;
    e.iorg = origin_new;
    e.setsIsland = true;
    e.iq = period;
    e.iepoch = origin_new + a0;
  } else if (auto* clip = dynamic_cast<celestrian::ClipNode*>(target);
             clip != nullptr && intrinsic > 0 && !root_node->hasActiveTake()) {
    // CYCLE-TOP RULE + TWO-ANCHOR CONTINUITY (see attachMapEditRiders).
    attachMapEditRiders(e, *clip, map, target->getEffectiveQuantum());
  }

  record(std::move(e));
}

void AudioEngine::toggleLoopWindow(const juce::String& uuid) {
  // Fractal (I5): window state lives on AudioNode — clips toggle their
  // single-segment window exactly like stacks toggle their time-map.
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    // MID-TAKE MAP-EDIT GATE (see setLoopPoints): flipping a stack's
    // map under a live take would change time under the recorder.
    if (node->getNodeType() == celestrian::NodeType::Stack &&
        node->isArmedOrRecording()) {
      juce::Logger::writeToLog(
          "AudioEngine::toggleLoopWindow refused — a take is recording "
          "in this subtree (finish or cancel it first)");
      return;
    }
    celestrian::Edit e(celestrian::Edit::Kind::LoopBypass);
    e.uuid = uuid;
    e.b1 = !node->isLoopWindowBypassed();  // toggle to the opposite state
    record(std::move(e));
  }
}

void AudioEngine::setSequence(const juce::String& uuid,
                              const juce::var& payload) {
  auto* stack = dynamic_cast<celestrian::StackNode*>(
      findNodeByUuid(root_node.get(), uuid));
  if (stack == nullptr) {
    juce::Logger::writeToLog(
        "AudioEngine::setSequence refused — target is not a stack");
    return;
  }
  // MID-TAKE GATE (docs/sequencer.md §9 S5 / the setSegments precedent):
  // a take recording in this subtree hears the sequence as its frame —
  // editing it mid-take would change the heard world under the recorder.
  if (stack->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::setSequence refused — a take is armed/recording "
        "in this subtree (finish or cancel it first)");
    return;
  }

  celestrian::Edit e(celestrian::Edit::Kind::Sequence);
  e.uuid = uuid;

  // A void/empty payload clears the sequence (e.seq stays null).
  if (auto* o = payload.getDynamicObject()) {
    auto seq = std::make_unique<celestrian::Sequence>();
    if (auto* steps = o->getProperty("steps").getArray()) {
      for (const auto& sv : *steps) {
        if ((int)seq->steps.size() >= celestrian::Sequence::kMaxSteps) {
          juce::Logger::writeToLog(
              "AudioEngine::setSequence refused — more than 64 steps");
          return;
        }
        celestrian::Sequence::Step st;
        st.len = (int64_t)(double)sv.getProperty("len", {});
        st.name = sv.getProperty("name", {}).toString();
        if (st.len <= 0) {
          juce::Logger::writeToLog(
              "AudioEngine::setSequence refused — non-positive step length");
          return;
        }
        seq->steps.push_back(std::move(st));
      }
    }
    if (auto* g = o->getProperty("gates").getDynamicObject()) {
      for (const auto& p : g->getProperties()) {
        celestrian::Sequence::GateRow row;
        row.uuid = p.name.toString();
        row.mask = 0;
        if (auto* bits = p.value.getArray()) {
          for (int i = 0;
               i < bits->size() && i < celestrian::Sequence::kMaxSteps; ++i) {
            if ((bool)(*bits)[i]) row.mask |= (1ull << i);
          }
        }
        seq->gates.push_back(std::move(row));
      }
    }
    if (!seq->steps.empty()) {
      seq->finalize();
      e.seq = std::move(seq);
    }
    // NOTE (S10, ruled): step lengths are NOT gated on Q coherence —
    // steps CONCATENATE (never LCM), free lengths are deliberate and
    // badged in the UI; the frame-health warning is display machinery.
  }
  record(std::move(e));
}

void AudioEngine::auditionStep(const juce::String& uuid, int step) {
  // THE STEP AUDITION (docs/sequencer.md §11.2): "loop this step". A
  // monitoring gesture, not an edit — nothing is recorded, nothing
  // persists. The derived window appears through activeTimeMap() on
  // the stack; −1 clears it. Refused while a take is live in the
  // subtree: the window IS the take's heard frame (the mid-take
  // map-edit refusal, inherited).
  auto* stack = dynamic_cast<celestrian::StackNode*>(
      findNodeByUuid(root_node.get(), uuid));
  if (stack == nullptr) {
    juce::Logger::writeToLog(
        "AudioEngine::auditionStep refused — target is not a stack");
    return;
  }
  if (stack->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::auditionStep refused — a take is armed/recording "
        "in this subtree (finish or cancel it first)");
    return;
  }
  if (step >= 0) {
    const celestrian::Sequence* s = stack->activeSequence();
    if (s == nullptr || step >= s->numSteps()) {
      juce::Logger::writeToLog(
          "AudioEngine::auditionStep refused — no such step in an active "
          "sequence");
      return;
    }
  }
  stack->setAuditionStep(step < 0 ? -1 : step);
  juce::Logger::writeToLog("AudioEngine: audition step " + juce::String(step) +
                           " on " + uuid);
}

void AudioEngine::toggleSequence(const juce::String& uuid) {
  auto* stack = dynamic_cast<celestrian::StackNode*>(
      findNodeByUuid(root_node.get(), uuid));
  if (stack == nullptr) return;
  if (stack->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::toggleSequence refused — a take is armed/recording "
        "in this subtree (finish or cancel it first)");
    return;
  }
  celestrian::Edit e(celestrian::Edit::Kind::SequenceBypass);
  e.uuid = uuid;
  e.b1 = !stack->isSequenceBypassed();
  record(std::move(e));
}

void AudioEngine::audioDeviceIOCallbackWithContext(
    const float* const* input_channel_data, int num_input_channels,
    float* const* output_channel_data, int num_output_channels, int num_samples,
    const juce::AudioIODeviceCallbackContext& context) {
  juce::ScopedNoDenormals no_denormals;

  // Epoch for deferred reclamation (see retire()).
  callback_count_.fetch_add(1);

  // --- Instrumentation: entry gap (xrun detection) ---
  const int64_t entry_ticks = juce::Time::getHighResolutionTicks();
  if (last_entry_ticks_ != 0) {
    const double tps = (double)juce::Time::getHighResolutionTicksPerSecond();
    const double gap_s = (double)(entry_ticks - last_entry_ticks_) / tps;
    const double period_s = (double)num_samples / cached_sample_rate_.load();
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

  // --- Live MIDI drain (docs/vst3.md §8, phases 4–5) ---
  // One drain per callback: everything that arrived since the last
  // block, spread across it by arrival timestamp (sub-block onsets for
  // play-through AND recording). The buffer is preallocated; addEvent
  // never grows it here. Every event then joins the arrival history
  // (input-clock indexed) that recording clips capture from — the
  // note twin of the pre-record ring write above.
  live_midi_buffer_.clear();
  midi_input_queue_.drainTo(live_midi_buffer_, num_samples,
                            juce::Time::getMillisecondCounterHiRes() * 0.001);
  midi_history_.pushBlock(live_midi_buffer_, input_clock_);

  if (root_node) {
    celestrian::ProcessContext pc;
    pc.sample_rate = cached_sample_rate_.load();
    pc.num_samples = num_samples;
    pc.is_playing = is_playing_global;
    pc.is_recording = true;  // Enable recording capture from inputs
    pc.master_pos = global_transport_pos;
    pc.live_midi = &live_midi_buffer_;
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
    // MIDI compensation (phase 5): a key pressed on the HEARD beat
    // arrives output-latency after the callback that rendered it — no
    // input-side device delay. The driver's output report is the
    // estimate; when the round trip was measured and the driver reports
    // no output figure, half the round trip is the honest guess.
    {
      const int out_reported = cached_output_latency_.load();
      pc.midi_latency = out_reported > 0 ? out_reported
                        : measured >= 0  ? (int)(measured / 2)
                                         : 0;
    }
    pc.midi_history = &midi_history_;
    // Solo canon (Q16): one snapshot scan per callback answers "is any
    // solo lit anywhere?" — leaves then resolve their own ancestry.
    // (The scan happens below once `snap` is loaded.)
    // Cycle-top of the island frame — loop-window time-maps phase off
    // this (time_maps.md); windowed stacks re-base it for their children.
    pc.cycle_epoch = islandEpoch();
    // Whole-graph snapshot + island facts (Tier 3 Step 3): ONE structure
    // load for the entire callback; leaves read island state from the
    // context instead of walking parents.
    pc.snap = graph_snapshot_.load(std::memory_order_acquire);
    pc.self = 0;
    pc.any_solo = pc.snap ? celestrian::snapAnySolo(*pc.snap) : false;
    pc.quantum = root_node->getQuantum();
    pc.island_epoch = pc.cycle_epoch;
    pc.island = root_node.get();
    // The invariant monotonic clock (master_pos twin of island_epoch):
    // mapping stacks fold master_pos on the way down but never this.
    pc.island_pos = global_transport_pos;
    // Context-cycle seed (Q5 one-shots): the island's audible cycle.
    // Each stack recomputes it for its own scope in childContext; this
    // seed is the fallback an all-one-shot ROOT scope inherits.
    pc.context_cycle = pc.snap
                           ? celestrian::snapEffectiveCycle(
                                 *pc.snap, pc.quantum, (int64_t)pc.sample_rate)
                           : calculateEffectiveCycleLength();

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
        const int64_t view_cycle =
            pc.snap ? celestrian::snapEffectiveCycle(
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

  // --- Master output monitor (transport VU meters) ---
  // The output buffers now hold exactly what reaches the device — the
  // master bus. ENVELOPE FOLLOWER metering: per-sample rectified
  // follower with ~15 ms attack and ~400 ms release. The two earlier
  // ballistics both missed: 300 ms-smoothed RMS buried transients
  // (snaps metered −44 dB), raw block peak slammed the dial on every
  // click (a 3 ms snap read like a hot mix — field 2026-08-08c/d). A
  // 15 ms attack integrates just long enough that sparse clicks read
  // mid-dial while sustained material reads its true level. A mono
  // device mirrors channel 0 into the right meter.
  {
    const double sr = cached_sample_rate_.load() > 0
                          ? cached_sample_rate_.load()
                          : kFallbackSampleRate;
    const float ka = (float)(1.0 - std::exp(-1.0 / (sr * 0.015)));  // attack
    const float kr = (float)std::exp(-1.0 / (sr * 0.4));            // release
    for (int ch = 0; ch < 2; ++ch) {
      const int src =
          (ch < num_output_channels && output_channel_data[ch] != nullptr) ? ch
                                                                           : 0;
      auto& meter = ch == 0 ? master_vu_l_ : master_vu_r_;
      float env = meter.load(std::memory_order_relaxed);
      if (src < num_output_channels && output_channel_data[src] != nullptr) {
        const float* d = output_channel_data[src];
        for (int i = 0; i < num_samples; ++i) {
          const float a = std::abs(d[i]);
          env = a > env ? env + (a - env) * ka : env * kr;
        }
      } else {
        for (int i = 0; i < num_samples; ++i) env *= kr;
      }
      meter.store(env, std::memory_order_relaxed);
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
  const int64_t effective = measured >= 0 ? measured
                                          : cached_input_latency_.load() +
                                                cached_output_latency_.load();
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
  calibration_capture_.setSize(1, capture_len, /*keepExistingContent=*/false,
                               /*clearExtraSpace=*/true,
                               /*avoidReallocating=*/false);
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
    const float* data = calibration_capture_.getReadPointer(0);
    const int len = calibration_capture_.getNumSamples();
    const int click = calibration_click_pos_;

    // Noise floor from the lead-in, peak from the post-click region.
    float floor_level = 0.0f;
    for (int i = 0; i < click; ++i)
      floor_level = std::max(floor_level, std::abs(data[i]));
    float peak = 0.0f;
    for (int i = click; i < len; ++i) peak = std::max(peak, std::abs(data[i]));

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
  const char* phase_name = phase == (int)CalibrationPhase::Capturing
                               ? "capturing"
                           : phase == (int)CalibrationPhase::Done   ? "done"
                           : phase == (int)CalibrationPhase::Failed ? "failed"
                                                                    : "idle";
  const int64_t measured = measured_latency_samples_.load();
  result->setProperty("phase", phase_name);
  result->setProperty("roundTripSamples", (double)measured);
  result->setProperty("roundTripMs",
                      measured >= 0 ? measured / sr * 1000.0 : -1.0);
  result->setProperty("calibrated", measured >= 0);
  return juce::var(result.get());
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device) {
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

juce::File AudioEngine::appDataFile(const juce::File& override_file,
                                    const juce::String& file_name) {
  if (override_file != juce::File()) return override_file;
  return juce::File::getSpecialLocation(
             juce::File::userApplicationDataDirectory)
      .getChildFile("Celestrian")
      .getChildFile(file_name);
}

juce::File AudioEngine::calibrationFile() const {
  return appDataFile(calibration_file_override_, "calibration.json");
}

void AudioEngine::setCalibrationFile(const juce::File& file) {
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
                           current_device_key_ + "' (" + juce::String(samples) +
                           " samples) -> " + file.getFullPathName());
}

void AudioEngine::restoreCalibrationForCurrentDevice() {
  int64_t restored = -1;

  auto file = calibrationFile();
  if (current_device_key_.isNotEmpty() && file.existsAsFile()) {
    auto root = juce::JSON::parse(file.loadFileAsString());
    if (auto* obj = root.getDynamicObject()) {
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

void AudioEngine::toggleSolo(const juce::String& uuid) {
  // Solo canon (Q16, ruled 2026-08-13): per-node flag — island-wide,
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

// (Per-node togglePlay was deleted with Q16: per-node Play/Stop is
// SUPERSEDED — mute/solo + the one transport are the per-node play
// controls. ClipNode::is_playing survives as the internal
// content-sounds gate; the user verb is gone.)

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
  // edit log. CLIPS ONLY for now — a stack has no origin to anchor a
  // once-per-cycle firing to (fractal one-shot groups are future work).
  const bool from_context = source == celestrian::PeriodSource::CONTEXT_CYCLE;
  auto* node = findNodeByUuid(root_node.get(), uuid);
  if (!node || node->getNodeType() != celestrian::NodeType::Clip) return;
  if (node->period_from_context_.load() == from_context) return;
  celestrian::Edit e(celestrian::Edit::Kind::PeriodSource);
  e.uuid = uuid;
  e.b1 = from_context;
  record(std::move(e));
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
