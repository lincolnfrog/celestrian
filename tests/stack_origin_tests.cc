/**
 * Q18 — every node has an origin (docs/composition.md).
 *
 * The one anchoring law on STACKS, as origin facts: a group is anchored
 * at its first content's origin; a windowed empty group re-expresses
 * its map when it is anchored; a definer's re-anchor lifts its
 * ancestors; the anchor is adopted at a block top. (What the anchor
 * makes audible - a windowed group selecting inner positions from its
 * origin through a take elsewhere and a seek, a one-shot group firing
 * from its origin, Combine anchoring at the earliest member - is
 * scenarios S21, S25, S36, S38 and S43.)
 */

#include <juce_core/juce_core.h>

#include <functional>

#include "../src/audio_engine.h"
#include "../src/stack_node.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using scenario::BLOCK;
using scenario::Island;
using scenario::posmod;

class StackOriginTests : public juce::UnitTest {
 public:
  StackOriginTests() : juce::UnitTest("Stack origin (Q18, composition.md)") {}

  void runTest() override {
    const int64_t Q = 20000;

    beginTest("The first group take anchors its group at the take's origin (undoable)");
    {
      Island is;
      const juce::String g = is.createStack();
      const juce::String mic = is.createClip(g);
      is.createClip(g);
      expect(!is.bprop(g, "anchored"), "empty group: unanchored");
      is.engine.startRecordingInNode(g);
      is.drive(Q);
      is.engine.stopRecordingInNode(g);
      is.settle();
      const int64_t origin = is.origin(mic);
      expect(is.bprop(g, "anchored"), "group anchored at commit");
      expectEquals(is.origin(g), origin, "stack origin == the take's origin");
      is.engine.undo();  // the take
      expect(!is.bprop(g, "anchored"), "undo un-anchors");
      is.engine.redo();
      expect(is.bprop(g, "anchored"), "redo re-anchors");
      expectEquals(is.origin(g), origin, "the exact stored origin comes back");
    }

    beginTest("Anchoring a WINDOWED empty group re-expresses its map; undo "
              "of the first take puts the authored map back");
    {
      // Geometry authored while a stack is unanchored is measured from
      // its received cycle top; anchoring re-expresses it from the new
      // origin (settleAnchors). The anchor rider must carry the map it
      // replaced, or undo of the take leaves the rewritten geometry.
      Island is;
      // A solo take first: Q = 1Q, zero at 0 — so the group's later take
      // lands at a NON-ZERO phase from the zero (shift != 0).
      is.record(Q);
      const juce::String g = is.createStack();
      const juce::String mic = is.createClip(g);
      // The authored (pre-anchor) window on the EMPTY group.
      const int64_t ws = Q / 2, we = Q;
      is.window(g, ws, we);
      expectEquals(is.iprop(g, "loopStart"), ws,
                   "window authored on the empty group");
      expect(!is.bprop(g, "anchored"), "still unanchored");

      // Arm at a later phase so the take's origin is off the zero.
      is.drive(Q + Q / 2);
      is.engine.startRecordingInNode(g);
      is.drive(2 * Q);
      is.engine.stopRecordingInNode(g);
      is.settle();
      expect(is.bprop(g, "anchored"), "group anchored");
      expect(is.origin(g) > 0 && is.dur(mic) > 0, "take placed off the zero");
      const int64_t ls = is.iprop(g, "loopStart");
      const int64_t le = is.iprop(g, "loopEnd");
      expect(!(ls == ws && le == we),
             "anchoring re-expressed (or cleared) the authored map");

      is.engine.undo();  // the group take
      expect(!is.bprop(g, "anchored"), "undo un-anchors");
      expectEquals(is.iprop(g, "loopStart"), ws,
                   "undo restores the AUTHORED window start");
      expectEquals(is.iprop(g, "loopEnd"), we,
                   "undo restores the AUTHORED window end");

      is.engine.redo();
      expect(is.bprop(g, "anchored"), "redo re-anchors");
      expectEquals(is.iprop(g, "loopStart"), ls,
                   "redo re-applies the re-expressed map");
      expectEquals(is.iprop(g, "loopEnd"), le,
                   "redo re-applies the re-expressed map (end)");
    }

    beginTest("A definer re-anchor lifts its ancestors: the outer group follows the inner definer");
    {
      // Outer stack > inner stack > 2 mics (the island's only content):
      // the inner stack is the definer; a trim re-anchors it AND the
      // outer stack (anchored because of it), so the frame every
      // ancestor measures from stays congruent with the zero.
      Island is;
      const juce::String outer = is.createStack();
      const juce::String inner = is.recordGroup(2, Q, outer);
      const juce::StringArray mics = is.childIds(inner);
      const int64_t O = is.origin(inner);
      expect(is.bprop(outer, "anchored") && is.bprop(inner, "anchored"),
             "both groups anchored");
      expectEquals(is.origin(outer), O, "the outer anchored at the same content");
      is.drive(3 * BLOCK);
      const int64_t ws = Q / 4, we = (3 * Q) / 4;
      is.window(inner, ws, we);
      expectEquals(is.Q(), we - ws, "the inner is the definer");
      const int64_t O1 = is.origin(inner);
      expectEquals(is.origin(outer), O1,
                   "the outer's origin followed the definer's shift");
      expectEquals(is.origin(mics[0]), O1, "the members followed too");
      expectEquals(is.zero(), O1 + ws, "zero == origin + start");
      is.engine.undo();
      expectEquals(is.origin(outer), O, "undo: the outer's origin is back");
      expectEquals(is.origin(inner), O, "undo: the inner's too");
    }

    beginTest("The anchor is adopted at a block top, flag and origin together");
    {
      // The message thread anchors a stack while a callback is between
      // its two phases: the block in flight keeps the frame origin its
      // control phase read, and the next block top takes the new one.
      StackNode group("Group");
      auto block = test_utils::contextFor(group, 64);
      block.ctx.frame_top = 700;
      group.control(nullptr, 0, block.ctx);
      expectEquals(group.frameOrigin(block.ctx), (int64_t)700,
                   "unanchored: the received cycle top");
      group.setAnchor(true, 1234, 0);
      expect(group.isAnchored(), "the message thread reads its own write");
      expectEquals(group.frameOrigin(block.ctx), (int64_t)700,
                   "the block in flight keeps the origin it started with");
      group.control(nullptr, 0, block.ctx);
      expectEquals(group.frameOrigin(block.ctx), (int64_t)1234,
                   "the next block top adopts the anchor and its origin");

      // A gated write (one that moves with the island zero) lands only at
      // the block top that carries its generation - the flag with it.
      group.setAnchor(false, 0, /*gate=*/5);
      group.control(nullptr, 0, block.ctx);
      expectEquals(group.frameOrigin(block.ctx), (int64_t)1234,
                   "an older generation keeps the anchor");
      block.ctx.island_generation = 5;
      group.control(nullptr, 0, block.ctx);
      expectEquals(group.frameOrigin(block.ctx), (int64_t)700,
                   "the named generation clears it");
    }
  }
};

static StackOriginTests stackOriginTests;

}  // namespace celestrian
