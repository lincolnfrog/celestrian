// AudioEngine — the ISLAND GEOMETRY LAW (message thread only): the Q
// hand-off (setDefiner, Q22), the continuity rider (attachMapEditRiders),
// Q18 origins and anchoring (settleAnchors, applySetsOrigin), the island
// (Q, zero) writes (setIslandQuantum), the scrub that keeps pre-Q
// geometry coherent, and the origin drift log.
//
// THE FRAME IS NOT PLACED HERE (docs/frame.md): the engine reads no
// frame — the view seats the frame's zero from the lanes — and only the
// island root holds (Q, zero).

#include "../audio_engine.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "../clip_node.h"
#include "../heard_index.h"
#include "../period_law.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

using celestrian::engine_internal::countCommittedClips;
using celestrian::engine_internal::forEachClip;
using celestrian::engine_internal::forEachNode;
using celestrian::engine_internal::forEachStack;
using celestrian::engine_internal::installSequence;
using celestrian::engine_internal::storesGeometry;

celestrian::StackNode* AudioEngine::parentOf(celestrian::AudioNode* node,
                                             int* index_out) const {
  if (index_out) *index_out = -1;
  if (!node) return nullptr;
  auto* parent = dynamic_cast<celestrian::StackNode*>(node->getParent());
  if (!parent) return nullptr;
  const auto& kids = parent->ownedChildren();
  for (int i = 0; i < (int)kids.size(); ++i) {
    if (kids[i].get() == node) {
      if (index_out) *index_out = i;
      break;
    }
  }
  return parent;
}

bool AudioEngine::setDefiner(const juce::String& uuid) {
  juce::Logger::writeToLog("AudioEngine::setDefiner: uuid=" + uuid);
  const auto refuse = [](const juce::String& why) {
    juce::Logger::writeToLog("AudioEngine::setDefiner refused - " + why);
    return false;
  };
  if (root_node->getQuantum() <= 0) {
    return refuse("no Q is established (the first take defines it)");
  }
  auto* node = findNodeByUuid(uuid);
  if (node == nullptr) return refuse("no node " + uuid);
  if (node == root_node.get()) {
    return refuse("the island root is the grid, not a track on it");
  }
  if (!celestrian::engine_internal::isDefinerTarget(*root_node, *node)) {
    return refuse(uuid +
                  " cannot define Q (a committed loop, or a group recorded "
                  "as one take, heard through no window or song above it)");
  }
  // Q := the period the node plays on a grid of its OWN — no drift
  // clause (quantum 0): it is judged against the Q this hand-off
  // replaces. A lock-collapsed node the edit re-opens plays the same
  // period from the same top, so the facts read here are the facts
  // after it.
  const int64_t own = celestrian::period_law::ownPeriodOf(*node, nullptr, 0);
  if (own <= 0) return refuse(uuid + " has no period");
  if (celestrian::engine_internal::definer(*root_node) == node) {
    return refuse(uuid + " already defines Q");
  }
  // zero := the node's frame top, its origin + a0 (Q13).
  const celestrian::timing::TimeMap map = node->activeTimeMap();
  celestrian::Edit e(celestrian::Edit::Kind::Definer);
  e.uuid = uuid;
  e.s1 = uuid;
  e.setsIsland = true;
  e.iq = own;
  e.izero = node->origin_samples.load() + (map.active() ? map.mapOffset(0) : 0);
  // The definer's "1" is its region start (Q13): a clip's stored ↺ top
  // (loop_selection.md §9) is cleared, and the inverse restores it.
  if (dynamic_cast<celestrian::ClipNode*>(node) != nullptr) {
    e.setsTop = true;
    e.itop = celestrian::timing::kNoTop;
  }
  return record(std::move(e));
}

namespace {
/** THE CONTINUITY RE-ANCHOR (time_maps.md §5): the origin at which the
 * position sounding at clock `t0` keeps sounding under `new_map` — the
 * old origin when the edit removed that position or nothing sounds, and
 * otherwise the least move that keeps it (the algebra and its
 * nearest-representative rule: heard::continuityOriginFor). One
 * implementation for clips and stacks: the node's RECEIVED clock and
 * scope are the frame its origin lives in, and an inactive map on
 * either side reads as the node's full span. */
int64_t continuityOrigin(const celestrian::AudioNode& node,
                         const celestrian::timing::TimeMap& new_map,
                         int64_t t0, const celestrian::heard::Scope& root) {
  using TimeMap = celestrian::timing::TimeMap;
  const int64_t dur = node.getIntrinsicDuration();
  auto effective = [dur](const TimeMap& m) {
    return m.active() ? m : TimeMap::single(0, dur);
  };
  const TimeMap oldm = effective(node.activeTimeMap());
  const TimeMap newm = effective(new_map);
  const celestrian::heard::Received rec =
      celestrian::heard::receivedAt(node, t0, root);
  return celestrian::heard::continuityOriginFor(
      oldm, newm, celestrian::heard::frameOriginOf(node, rec.scope), rec.clock,
      celestrian::heard::ownFold(node, oldm, rec.scope),
      celestrian::heard::ownFold(node, newm, rec.scope));
}
}  // namespace

celestrian::heard::Scope AudioEngine::rootScope() const {
  celestrian::heard::Scope s;
  s.frame_top = islandZero();
  s.quantum = root_node->getQuantum();
  s.context_cycle = calculateEffectiveCycleLength();
  return s;
}

bool AudioEngine::isPeriodCoherentWithQuantum(int64_t period, int64_t quantum) {
  return period > 0 && !celestrian::period_law::periodDrifts(period, quantum);
}

void AudioEngine::attachMapEditRiders(
    celestrian::Edit& e, const celestrian::AudioNode& node,
    const celestrian::timing::TimeMap& new_map) {
  // Nothing re-anchors when nothing heard changes: a BYPASSED node plays
  // whole on both sides of the edit, an unanchored stack holds no
  // content, and a stopped transport sounds nothing to keep.
  if (node.isLoopWindowBypassed() || !node.isAnchored() ||
      !is_playing_global.load()) {
    return;
  }
  const int64_t origin = continuityOrigin(
      node, new_map, global_transport_pos.load(), rootScope());
  if (origin != node.origin_samples.load()) {
    e.setsOrigin = true;
    e.iorg = origin;
  }
}

// --- Q18: origins on every node (composition.md §5) ---

void AudioEngine::shiftOriginsGated(celestrian::AudioNode& node, int64_t delta,
                                    uint32_t gate) {
  forEachNode(node, [&](celestrian::AudioNode& n) {
    n.setOriginGated(n.origin_samples.load() + delta, gate);
  });
}

void AudioEngine::applySetsOrigin(celestrian::AudioNode& node,
                                  const celestrian::Edit& e,
                                  celestrian::Edit& inv, uint32_t gate) {
  if (!e.setsOrigin) return;
  const int64_t old_origin = node.origin_samples.load();
  inv.setsOrigin = true;
  inv.iorg = old_origin;
  // The gated origins land FIRST; the island facts naming their
  // generation publish after, in the callers.
  const int64_t delta = e.iorg - old_origin;
  shiftOriginsGated(node, delta, gate);
  if (e.liftsAncestors) {
    inv.liftsAncestors = true;
    liftAncestorsGated(node, delta, gate);
  }
}

namespace {
/** The received cycle top `node`'s frame is measured from — the
 * message-thread twin of ProcessContext::frame_top at that node: the
 * island zero, re-based by each mapped ancestor from that ancestor's
 * frame origin. (heard::receivedAt's descent without the cue re-base.) */
int64_t cycleTopOf(const celestrian::AudioNode& node, int64_t island_zero) {
  const auto* parent =
      dynamic_cast<const celestrian::StackNode*>(node.getParent());
  if (parent == nullptr) return island_zero;
  celestrian::heard::Scope scope;
  scope.frame_top = cycleTopOf(*parent, island_zero);
  const celestrian::timing::TimeMap map = parent->activeTimeMap();
  if (!map.active()) return scope.frame_top;
  return celestrian::heard::frameOriginOf(*parent, scope) + map.mapOffset(0);
}

/** The earliest committed clip's origin under `node` (INT64_MAX when
 * none). */
int64_t earliestCommittedOrigin(const celestrian::AudioNode& node) {
  int64_t best = std::numeric_limits<int64_t>::max();
  forEachClip(node, [&](const celestrian::ClipNode& clip) {
    if (clip.getIntrinsicDuration() > 0) {
      best = std::min(best, clip.origin_samples.load());
    }
  });
  return best;
}
}  // namespace

void celestrian::engine_internal::settleAnchors(celestrian::StackNode& root,
                                                celestrian::Edit& inv) {
  forEachStack(root, [&](celestrian::StackNode& stack) {
    // THE ROOT NEVER SETTLES: its anchor is owned by its SONG, not by
    // content (docs/frame.md §4; setSequence). Without a song its frame
    // origin is the received cycle top — the island zero.
    if (&stack == &root) return;
    const bool has = countCommittedClips(stack) > 0;
    if (has == stack.isAnchored()) return;  // nothing to settle
    celestrian::Edit::AnchorRider back;
    back.uuid = stack.getUuid();
    back.anchored = stack.isAnchored();
    back.origin = stack.origin_samples.load();
    if (!has) {
      inv.anchors.push_back(std::move(back));
      stack.setAnchor(false, 0, 0);
      return;
    }
    // ANCHOR at the earliest content's origin. Geometry authored while
    // the stack was unanchored was expressed from its received cycle
    // top: re-express it from the new origin so nothing audible moves.
    // A window that would wrap the inner cycle is cleared instead.
    const int64_t old_top = cycleTopOf(stack, root.getZero());
    const int64_t origin = earliestCommittedOrigin(stack);
    const int64_t shift = origin - old_top;  // inner positions move by −shift
    const int64_t inner = stack.getIntrinsicDuration();
    if (shift != 0 && inner > 0) {
      const int64_t d = celestrian::timing::posMod(shift, inner);
      auto shifted = [&](int64_t s, int64_t e2, int64_t& ns, int64_t& ne) {
        ns = s - d;
        ne = e2 - d;
        if (ns < 0) {
          ns += inner;
          ne += inner;
        }
        return ne <= inner;  // representable without wrapping
      };
      const celestrian::timing::TimeMap m = stack.storedMap();
      if (m.n > 0) {
        // The rider carries the pre-anchor map: undo puts the authored
        // geometry back, not the re-expressed (or cleared) one.
        back.setsMap = true;
        back.tmap = m;
        celestrian::timing::TimeMap fresh;
        bool ok = true;
        for (int i = 0; i < m.n && ok; ++i) {
          int64_t ns = 0, ne = 0;
          ok = shifted(m.segs[i].start, m.segs[i].end, ns, ne);
          fresh.segs[i] = {ns, ne};
          fresh.n = i + 1;
        }
        if (ok) {
          // A shift can rotate segment order.
          std::sort(fresh.segs, fresh.segs + fresh.n,
                    [](const auto& a, const auto& b) { return a.start < b.start; });
          stack.setMap(fresh);
        } else {
          stack.setLoopPoints(0, 0);
          juce::Logger::writeToLog("AudioEngine: cleared a pre-anchor map on " +
                                   stack.getUuid() +
                                   " - it cannot be re-expressed from the "
                                   "stack's new origin");
        }
      }
    }
    stack.setAnchor(true, origin, 0);
    inv.anchors.push_back(std::move(back));
  });
}

void AudioEngine::settleAnchors(celestrian::Edit& inv) {
  celestrian::engine_internal::settleAnchors(*root_node, inv);
}

void AudioEngine::applyAnchorRiders(const celestrian::Edit& e,
                                    celestrian::Edit& inv) {
  for (const auto& r : e.anchors) {
    auto* stack = dynamic_cast<celestrian::StackNode*>(
        findNodeByUuid(r.uuid));
    if (stack == nullptr) continue;
    celestrian::Edit::AnchorRider back;
    back.uuid = r.uuid;
    back.anchored = stack->isAnchored();
    back.origin = stack->origin_samples.load();
    if (r.setsMap) {
      // Copy-swap like every rider: the inverse carries the map this
      // one displaces.
      back.setsMap = true;
      back.tmap = stack->storedMap();
      stack->setMap(r.tmap);
    }
    inv.anchors.push_back(std::move(back));
    stack->setAnchor(r.anchored, r.origin, 0);
  }
}

int AudioEngine::islandCommittedClipCount() const {
  return countCommittedClips(*root_node);
}

void AudioEngine::setIslandQuantum(int64_t q, int64_t zero,
                                   celestrian::Edit& inv, uint32_t generation) {
  const int64_t old_q = root_node->getQuantum();
  root_node->setIslandFacts(
      q, zero, generation != 0 ? generation : root_node->islandGeneration());
  if (q == old_q) return;
  // SEQUENCES TRACK Q (sequencer.md): a step is "5Q", not a sample
  // count. A re-established Q keeps every step's Q value; an island
  // reverting to empty (q == 0) clears its songs — one kept over nothing
  // would land off-Q when the next take sets a new Q — and they ride the
  // inverse.
  forEachStack(*root_node, [&](celestrian::StackNode& stack) {
    const celestrian::Sequence* cur = stack.sequencePtr();
    if (cur == nullptr) return;
    if (q <= 0) {
      celestrian::Edit::SeqRider r;
      r.uuid = stack.getUuid();
      r.seq = std::make_unique<celestrian::Sequence>(*cur);
      // The ROOT's anchor rides its song (docs/frame.md §4): the song
      // goes, so does the anchor; the rider brings both back.
      if (&stack == root_node.get() && stack.isAnchored()) {
        r.anchored = true;
        r.origin = stack.origin_samples.load();
        stack.setAnchor(false, 0, 0);
      }
      inv.seq_riders.push_back(std::move(r));
      stack.setAuditionStep(-1);
      installSequence(*this, stack, nullptr);
      return;
    }
    if (old_q <= 0) return;  // nothing musical to scale from
    auto* fresh = new celestrian::Sequence(*cur);
    const auto scale = [&](int64_t v) {
      return (int64_t)std::llround((double)v * (double)q / (double)old_q);
    };
    for (auto& st : fresh->steps) {
      st.len = scale(st.len);
      st.fade_in = scale(st.fade_in);  // fades are musical too (S13)
      st.fade_out = scale(st.fade_out);
    }
    fresh->finalize();
    installSequence(*this, stack, fresh);
  });
}

void AudioEngine::reinstallSequenceRiders(celestrian::Edit& e) {
  for (auto& r : e.seq_riders) {
    auto* stack = dynamic_cast<celestrian::StackNode*>(
        findNodeByUuid(r.uuid));
    if (stack == nullptr || !r.seq) continue;
    auto* fresh = new celestrian::Sequence(*r.seq);
    fresh->finalize();
    installSequence(*this, *stack, fresh);
    // The root's anchor comes back with its song (docs/frame.md §4).
    if (r.anchored && stack == root_node.get()) {
      stack->setAnchor(true, r.origin, 0);
    }
  }
  e.seq_riders.clear();
}

void AudioEngine::scrubIncoherentGeometry(int64_t q, celestrian::Edit& inv) {
  // Geometry is legal to author before Q exists, at any length; what the
  // just-established grid cannot carry (an incoherent active map
  // LCM-explodes the effective cycle, and the coherence guard only
  // judges later edits) is cleared here, each node's map and top riding
  // `inv` as a window rider.
  forEachNode(*root_node, [&](celestrian::AudioNode& node) {
    const celestrian::timing::TimeMap m = node.storedMap();
    if (!storesGeometry(node) || isPeriodCoherentWithQuantum(m.period(), q)) {
      return;
    }
    celestrian::Edit::WindowRider back;
    back.uuid = node.getUuid();
    back.start = node.getLoopStart();
    back.end = node.getLoopEnd();
    back.setsMap = true;
    back.tmap = m;
    back.setsTop = true;
    back.top = node.storedTop();
    inv.windows.push_back(std::move(back));
    node.setLoopPoints(0, 0);
    juce::Logger::writeToLog(
        juce::String("AudioEngine: cleared a pre-Q ") +
        (m.n >= 2 ? "map" : "window") + " on " + node.getUuid() +
        " - its period cannot live on the established Q " + juce::String(q));
  });
}

void AudioEngine::noteOriginDrift(const juce::String& cause) {
  // Every COMMITTED node below the root: a clip with content, a stack
  // anchored by its content. (Empty arms and unanchored stacks carry
  // placeholder origins that nothing plays against.)
  const auto committed = [this](const celestrian::AudioNode& n) {
    if (&n == root_node.get()) return false;
    return n.getNodeType() == celestrian::NodeType::Stack
               ? n.isAnchored()
               : n.getIntrinsicDuration() > 0;
  };
  // NOTHING MOVED is the answer at almost every poll: settle it against
  // the last check without building anything.
  size_t seen = 0;
  bool changed = false;
  forEachNode(*root_node, [&](const celestrian::AudioNode& n) {
    if (!committed(n)) return;
    ++seen;
    const auto mark = origin_marks_.find(n.getUuid());
    changed = changed || mark == origin_marks_.end() ||
              mark->second.origin != n.origin_samples.load();
  });
  if (!changed && seen == origin_marks_.size()) return;

  std::map<juce::String, OriginMark> now;
  forEachNode(*root_node, [&](const celestrian::AudioNode& n) {
    if (committed(n)) now[n.getUuid()] = {n.origin_samples.load(), n.getName()};
  });
  // Group the nodes seen both times by how far they moved: one group is
  // the island moving together (nothing, or a seek); two or more is a
  // track moving against the others.
  std::map<int64_t, juce::StringArray> by_delta;
  for (const auto& [id, mark] : now) {
    const auto it = origin_marks_.find(id);
    if (it == origin_marks_.end()) continue;
    by_delta[mark.origin - it->second.origin].add(mark.name + " [" +
                                                   id.substring(0, 6) + "]");
  }
  if (by_delta.size() > 1) {
    const int64_t q = root_node->getQuantum();
    juce::String line = "ORIGIN DRIFT after " + cause + ":";
    for (const auto& [delta, names] : by_delta) {
      line += "  moved " + juce::String(delta) + " samples";
      if (q > 0) line += " (" + juce::String((double)delta / (double)q, 3) + "Q)";
      line += ": " + names.joinIntoString(", ") + ";";
    }
    juce::Logger::writeToLog(line);
  }
  origin_marks_ = std::move(now);
}
