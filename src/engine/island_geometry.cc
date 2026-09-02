// AudioEngine — the ISLAND GEOMETRY LAW: the definer (sole clip or
// definer stack) and its re-establishment riders, two-anchor continuity
// and the cycle-top rule (attachMapEditRiders), Q18 origins and
// anchoring (settleAnchors, applySetsOrigin), island (Q, epoch) writes
// (setIslandQuantum) and the scrubs that keep nested stacks and pre-Q
// geometry coherent. Message thread only.

#include "../audio_engine.h"

#include "../heard_index.h"

#include <algorithm>
#include <cmath>
#include <limits>

#include "../clip_node.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

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
 * Q13 FOR GROUPS (design_language.md Q13, the fractal twin of the sole
 * clip definer): the island's DEFINER STACK — a stack whose direct clip
 * children are the island's ONLY committed content and were recorded
 * as ONE take (identical origin and duration), two or more of them (a
 * single committed clip keeps the clip-definer path, whatever holds
 * it). Its window then re-establishes (Q, epoch) exactly as a sole
 * clip's does. Null otherwise. Message thread.
 */
celestrian::StackNode* definerStackImpl(celestrian::AudioNode* node) {
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
      // A one-shot member reads its period from CONTEXT (Q5) — the
      // stack is not "one take looping as one part", so it cannot
      // re-establish Q (the VM's oneTakeDuration and definerStackOf
      // agree).
      if (c->period_from_context_.load()) return nullptr;
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
  if (nested != nullptr) {
    if (direct != 0) return nullptr;
    // WRAPPER WARP GUARD: a stack on the path that remaps time — an
    // active map override or its own engaged window — sits between the
    // island clock and the definer, so the definer's window would
    // re-establish (Q, epoch) through a warp the Q13 equation ignores.
    // No definer through a warp.
    if (stack->hasSegmentMap() ||
        (!stack->isLoopWindowBypassed() &&
         stack->getLoopEnd() > stack->getLoopStart())) {
      return nullptr;
    }
    return definerStackImpl(nested);
  }
  return direct >= 2 ? stack : nullptr;
}
}  // namespace

namespace celestrian::engine_internal {

celestrian::StackNode* definerStack(celestrian::AudioNode* root) {
  auto* ds = definerStackImpl(root);
  // ONLY GEOMETRY WINS (see hasActiveGeometryOutside): a sibling's
  // authored window — even a coherent one on an empty stack — would be
  // stranded off-grid by this definer's re-establishment.
  if (ds != nullptr && hasActiveGeometryOutside(root, ds)) return nullptr;
  return ds;
}

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
                              celestrian::AudioNode* exclude) {
  if (node == exclude) return false;
  if (node->hasSegmentMap()) return true;
  const int64_t ls = node->getLoopStart();
  const int64_t le = node->getLoopEnd();
  const int64_t D = node->getIntrinsicDuration();
  const bool restricting = le > ls && !(ls <= 0 && D > 0 && le >= D &&
                                        node->getNodeType() ==
                                            celestrian::NodeType::Clip);
  if (restricting && !node->isLoopWindowBypassed()) return true;
  if (auto* stack = dynamic_cast<celestrian::StackNode*>(node)) {
    for (const auto& child : stack->ownedChildren()) {
      if (hasActiveGeometryOutside(child.get(), exclude)) return true;
    }
  }
  return false;
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

}  // namespace celestrian::engine_internal

namespace {
// TWO-ANCHOR CONTINUITY (time_maps.md §6): "there is no such thing as
// island 3.5 — that is 0.5Q. The master transport is an implementation
// detail and should never bleed into the design." Requirements: (1)
// trims/cuts on a playing clip must not jump unless the edit removes
// the audio under the cursor; (2) the edited timeline is the source of
// truth — the seam renders where the cut was made.
//
// Moving the clip's ORIGIN alone would rotate the clip's picture in the
// frame: the monotonic transport folded by the new cycle moves the
// cursor, and an origin-only re-anchor chases it. So there are TWO
// anchors — the clip's origin and the island epoch (where the fold
// starts) — and they move TOGETHER by the same whole-Q delta: the
// origin pins audio continuity, and the epoch rider re-labels the fold
// so the edited clip's frame position is UNCHANGED. The Q grid and
// every Q-period sibling are untouched (the delta is whole-Q by the
// coherence guard); longer-period siblings may show a whole-Q shift —
// the honest new cyclic alignment continuity implies.
//
// continuityOrigin: when a node's map changes while playing, the
// origin' at which the buffer position sounding RIGHT NOW keeps
// sounding — as long as the new map still COVERS it. When the edit
// REMOVED the sounding region, the origin stays FIXED (an audible jump
// is expected — you deleted what you were hearing) and the epoch stays
// with it. An inactive map on either side is its full-span form. The
// Q13 sole-definer riders keep their own algebra (island re-establish
// included) and win when they apply.
// Q18: one implementation for clips and stacks — the node's inner
// position now (heard::nodeInner) re-anchored under the new map. For a
// stack the returned origin moves its whole subtree (applySetsOrigin).
int64_t continuityOrigin(const celestrian::AudioNode& node,
                         const celestrian::timing::TimeMap& new_map,
                         int64_t t0, int64_t fallback_origin) {
  using TimeMap = celestrian::timing::TimeMap;
  const int64_t dur = node.getIntrinsicDuration();
  auto effective = [dur](const TimeMap& m) {
    return m.active() ? m : TimeMap::single(0, dur);
  };
  const TimeMap oldm = effective(node.activeTimeMap());
  const TimeMap newm = effective(new_map);
  const int64_t period = newm.period();
  const bool anchored =
      node.getNodeType() == celestrian::NodeType::Clip || node.isAnchored();
  const int64_t old_org = anchored ? node.origin_samples.load() : fallback_origin;
  if (period <= 0 || oldm.period() <= 0) return old_org;
  const int64_t p0 = celestrian::heard::nodeInner(node, t0, fallback_origin);
  if (newm.heardOffsetOf(p0) < 0) return old_org;  // region removed: stay put
  return celestrian::heard::originForHeard(newm, t0, p0, 0);
}
}  // namespace

bool AudioEngine::isPeriodCoherentWithQuantum(int64_t period, int64_t quantum) {
  if (period <= 0) return false;
  if (quantum <= 0) return true;  // no grid yet — nothing to cohere with
  return period % quantum == 0 || quantum % period == 0;
}

void AudioEngine::attachMapEditRiders(
    celestrian::Edit& e, const celestrian::AudioNode& node,
    const celestrian::timing::TimeMap& new_map, int64_t quantum) {
  // Q18: a stack's frame is its own origin once anchored, else its
  // received cycle top; the riders below then apply to clips and
  // stacks alike (an unanchored stack has no content — nothing moves).
  const bool anchored =
      node.getNodeType() == celestrian::NodeType::Clip || node.isAnchored();
  const int64_t fallback = cycleTopOf(node);
  const int64_t origin = anchored ? node.origin_samples.load() : fallback;
  // Audio continuity is a PLAYING concern: stopped, the origin stays.
  const int64_t origin_new =
      is_playing_global.load()
          ? continuityOrigin(node, new_map, global_transport_pos.load(),
                             fallback)
          : origin;
  if (origin_new != origin && anchored) {
    e.setsOrigin = true;
    e.iorg = origin_new;
  }
  const int64_t delta = anchored ? origin_new - origin : 0;
  const int64_t epoch = root_node->getIslandEpoch();

  // CYCLE-TOP RULE (time_maps.md §6): the loop that DEFINES the cycle
  // after this edit puts its heard top at the frame top — the same law
  // as the commit re-base (epoch := the newest cycle-defining origin)
  // and the Q13 sole-definer re-trim (epoch := origin + window start),
  // on a LOCKED island too. Definer = its period is a multiple of Q and
  // of every other loop's period. Whole-Q from the current epoch only:
  // the Q grid never moves (an off-grid ⌥-slid top stays mid-phase —
  // honestly). Nothing audible changes: origins are absolute; the epoch
  // is the visual top + the arm grid.
  const int64_t a0 = new_map.active() ? new_map.mapOffset(0) : 0;
  const int64_t top = origin_new + a0;
  const int64_t new_period =
      new_map.active() ? new_map.period() : node.getIntrinsicDuration();
  const int64_t others = celestrian::timing::foldPeriod(
      quantum > 0 ? quantum : 0,
      celestrian::StackNode::effectivePeriodOf(*root_node, &node));
  const bool definer =
      new_period > 0 && (others <= 0 || new_period % others == 0);
  // …and only when the top is not ALREADY at the frame top: the definer's
  // period is the cycle, so a top ≡ epoch (mod period) draws identically
  // and a re-base would be pure churn (a 1Q loop under a 1Q Q: every
  // whole-Q epoch is the same frame).
  const bool top_off_frame =
      definer && (((top - epoch) % new_period) + new_period) % new_period != 0;
  // The epoch moves in whole Qs. (Q18: a stack's map anchors at the
  // stack's OWN origin, so an epoch move never re-selects content
  // anywhere — no windowed-group guard is needed.)
  const int64_t step = quantum > 0 ? quantum : 0;
  if (step > 0 && top_off_frame && (top - epoch) % step == 0) {
    e.setsIsland = true;
    e.iq = quantum;  // Q unchanged — only the frame top moves
    e.iepoch = top;
    return;
  }
  // Otherwise: TWO-ANCHOR CONTINUITY (time_maps.md §6) — the epoch
  // rides the origin's whole-Q delta so the edited clip's frame
  // position is unchanged (the fold, not the clip, absorbs it).
  if (delta != 0 && step > 0 && delta % step == 0) {
    e.setsIsland = true;
    e.iq = quantum;
    e.iepoch = epoch + delta;
  }
}

// --- Q18: origins on every node (composition.md §5) ---

namespace {
void forEachStack(celestrian::AudioNode* node,
                  const std::function<void(celestrian::StackNode&)>& f);
bool hasCommittedContent(const celestrian::AudioNode& node) {
  if (node.getNodeType() == celestrian::NodeType::Clip)
    return node.getIntrinsicDuration() > 0;
  const auto& stack = static_cast<const celestrian::StackNode&>(node);
  for (const auto& child : stack.ownedChildren())
    if (hasCommittedContent(*child)) return true;
  return false;
}
/** The earliest committed descendant's origin (INT64_MAX when none). */
int64_t earliestCommittedOrigin(const celestrian::AudioNode& node) {
  if (node.getNodeType() == celestrian::NodeType::Clip) {
    return node.getIntrinsicDuration() > 0 ? node.origin_samples.load()
                                           : std::numeric_limits<int64_t>::max();
  }
  const auto& stack = static_cast<const celestrian::StackNode&>(node);
  int64_t best = std::numeric_limits<int64_t>::max();
  for (const auto& child : stack.ownedChildren())
    best = std::min(best, earliestCommittedOrigin(*child));
  return best;
}
}  // namespace

void AudioEngine::shiftOriginsGated(celestrian::AudioNode& node, int64_t delta,
                                    uint32_t gate) {
  node.setOriginGated(node.origin_samples.load() + delta, gate);
  if (node.getNodeType() != celestrian::NodeType::Stack) return;
  auto& stack = static_cast<celestrian::StackNode&>(node);
  for (const auto& child : stack.ownedChildren())
    shiftOriginsGated(*child, delta, gate);
}

void AudioEngine::applySetsOrigin(celestrian::AudioNode& node,
                                  const celestrian::Edit& e,
                                  celestrian::Edit& inv, uint32_t gate) {
  if (!e.setsOrigin) return;
  const int64_t old_origin = node.origin_samples.load();
  inv.setsOrigin = true;
  inv.iorg = old_origin;
  // GATED: the gated origins land FIRST; the island facts naming their
  // generation publish after, in the callers.
  const int64_t delta = e.iorg - old_origin;
  shiftOriginsGated(node, delta, gate);
  if (e.liftsAncestors) {
    inv.liftsAncestors = true;
    for (auto* p = node.getParent(); p != nullptr; p = p->getParent()) {
      if (p->isAnchored()) p->setOriginGated(p->origin_samples.load() + delta, gate);
    }
  }
}

int64_t AudioEngine::cycleTopOf(const celestrian::AudioNode& node) const {
  const auto* parent =
      dynamic_cast<const celestrian::StackNode*>(node.getParent());
  if (parent == nullptr) return root_node ? root_node->getEpoch() : 0;
  const int64_t top = cycleTopOf(*parent);
  const celestrian::timing::TimeMap map = parent->activeTimeMap();
  if (!map.active()) return top;
  const int64_t O = parent->isAnchored() ? parent->origin_samples.load() : top;
  return O + map.mapOffset(0);
}

void AudioEngine::settleAnchors(celestrian::Edit& inv) {
  forEachStack(root_node.get(), [&](celestrian::StackNode& stack) {
    const bool has = hasCommittedContent(stack);
    if (has == stack.isAnchored()) return;  // nothing to settle
    celestrian::Edit::AnchorRider back;
    back.uuid = stack.getUuid();
    back.anchored = stack.isAnchored();
    back.origin = stack.origin_samples.load();
    inv.anchors.push_back(std::move(back));
    if (!has) {
      stack.setAnchor(false, 0, 0);
      return;
    }
    // ANCHOR at the earliest content's origin. Geometry authored while
    // the stack was unanchored was expressed from its received cycle
    // top; re-express it from the new origin so nothing audible moves
    // (a window that would wrap the inner cycle is cleared instead —
    // the establishment-scrub discipline, with a log).
    const int64_t old_top = cycleTopOf(stack);
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
        celestrian::timing::TimeMap fresh;
        bool ok = true;
        for (int i = 0; i < m.n && ok; ++i) {
          int64_t ns = 0, ne = 0;
          ok = shifted(m.segs[i].start, m.segs[i].end, ns, ne);
          fresh.segs[i] = {ns, ne};
          fresh.n = i + 1;
        }
        if (ok) {
          // Re-sort by start (a shift can rotate segment order).
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
  });
}

void AudioEngine::applyAnchorRiders(const celestrian::Edit& e,
                                    celestrian::Edit& inv) {
  for (const auto& r : e.anchors) {
    auto* stack = dynamic_cast<celestrian::StackNode*>(
        findNodeByUuid(root_node.get(), r.uuid));
    if (stack == nullptr) continue;
    celestrian::Edit::AnchorRider back;
    back.uuid = r.uuid;
    back.anchored = stack->isAnchored();
    back.origin = stack->origin_samples.load();
    inv.anchors.push_back(std::move(back));
    stack->setAnchor(r.anchored, r.origin, 0);
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
                                   celestrian::Edit& inv, uint32_t generation) {
  const int64_t old_q = root_node->getQuantum();
  root_node->setIslandFacts(
      q, epoch, generation != 0 ? generation : root_node->islandGeneration());
  if (q == old_q) return;
  // SEQUENCES TRACK Q (sequencer.md): a step is "5Q", not "220500
  // samples" — re-establishing Q (a definer trim) keeps every step's Q
  // value; reverting to an empty island (q == 0) clears the sequences
  // (a song over nothing has no meaning, and a kept one would land
  // off-Q when the next take sets a new Q). Cleared sequences ride the
  // inverse for undo.
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

/**
 * ONE ISLAND, ONE OWNER OF (Q, epoch): only the session root holds
 * island facts. A stack assembled while DETACHED (Combine builds the
 * new stack before inserting it; a subtree held by the undo log is
 * detached) is its own rootNode(), so addChild's establishment stamps
 * the CHILD's duration/origin onto that stack as if it were an island.
 * Attached, getEffectiveQuantum()/getIslandEpoch() stop at the first
 * stored value, so such a subtree would run on a private grid: a group
 * take inside it commits against a stale Q, and the UI (which reads the
 * nested Q when the root's is 0) and the engine disagree on Q from
 * then on. Every structural edit re-asserts the invariant.
 */
void AudioEngine::scrubNestedIslandFacts() {
  forEachStack(root_node.get(), [&](celestrian::StackNode& stack) {
    if (&stack == root_node.get()) return;
    if (stack.getQuantum() != 0 || stack.getEpoch() != 0) {
      juce::Logger::writeToLog(
          "AudioEngine: scrubbed island facts from nested stack " +
          stack.getUuid() + " (Q=" + juce::String(stack.getQuantum()) +
          " epoch=" + juce::String(stack.getEpoch()) + ")");
      stack.setQuantum(0, 0);
    }
  });
}

void AudioEngine::scrubIncoherentGeometry(int64_t q) {
  // Message thread. Clears any authored window or map override whose
  // period is neither a whole multiple nor an exact divisor of Q —
  // pre-Q authored geometry that the just-established grid cannot
  // carry (an incoherent active map LCM-explodes the effective
  // cycle). Committed clips' full-span windows are
  // commit furniture and never touched.
  const std::function<void(celestrian::AudioNode*)> visit =
      [&](celestrian::AudioNode* node) {
        const auto coherent = [q](int64_t p) {
          return p > 0 && (p % q == 0 || q % p == 0);
        };
        const celestrian::timing::TimeMap m = node->storedMap();
        if (m.n >= 2 && !coherent(m.period())) {
          node->setLoopPoints(0, 0);
          juce::Logger::writeToLog(
              "AudioEngine: cleared a pre-Q map on " + node->getUuid() +
              " - its period cannot live on the established Q " +
              juce::String(q));
        } else if (m.n < 2) {
          const int64_t ls = node->getLoopStart();
          const int64_t le = node->getLoopEnd();
          const int64_t D = node->getIntrinsicDuration();
          const bool full_span_clip =
              node->getNodeType() == celestrian::NodeType::Clip &&
              ls <= 0 && D > 0 && le >= D;
          if (le > ls && !full_span_clip && !coherent(le - ls)) {
            node->setLoopPoints(0, 0);
            juce::Logger::writeToLog(
                "AudioEngine: cleared a pre-Q window on " + node->getUuid() +
                " - its length cannot live on the established Q " +
                juce::String(q));
          }
        }
        if (auto* stack = dynamic_cast<celestrian::StackNode*>(node)) {
          for (const auto& child : stack->ownedChildren()) visit(child.get());
        }
      };
  visit(root_node.get());
}
