/**
 * Undo symmetry over the edit kinds (src/edit.h). One small fixture per
 * kind the engine's verbs can reach: the edit, undone, leaves the
 * published graph it found; redone, the graph it made; undone again, the
 * graph it found. The comparison is the WHOLE graph
 * (test_utils::graphFacts), so a rider an inverse forgot shows whichever
 * fact it was.
 */

#include <juce_core/juce_core.h>

#include <functional>
#include <initializer_list>
#include <memory>
#include <utility>

#include "../src/audio_engine.h"
#include "../src/dsp/vst3_slot.h"
#include "scenario_utils.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

using scenario::Island;
using scenario::seqPayload;

namespace {
constexpr int64_t Q = 20000;

/** A cell map over the given [start, end) spans. */
timing::TimeMap cells(
    std::initializer_list<std::pair<int64_t, int64_t>> spans) {
  timing::TimeMap map;
  for (const auto& [start, end] : spans) map.segs[map.n++] = {start, end};
  return map;
}
}  // namespace

class UndoSymmetryTests : public juce::UnitTest {
 public:
  UndoSymmetryTests()
      : juce::UnitTest("Undo symmetry (every edit kind)", "Undo") {}

  /** Expect the engine's published graph to be `want` (a graphFacts
   * capture); a failure names the first fact that differs. */
  void expectGraph(AudioEngine& engine, const juce::var& want,
                   const juce::String& label) {
    const juce::String diff =
        test_utils::firstDifference(want, test_utils::graphFacts(engine));
    expect(diff.isEmpty(), label + (diff.isEmpty() ? "" : " - " + diff));
  }

  /** Run `edit` — which logs `steps` undo entries — and expect: undone,
   * the graph it found; redone, the graph it made; undone again, the
   * graph it found. Leaves the edit applied. */
  void expectUndoRestores(AudioEngine& engine, const juce::String& label,
                          const std::function<void()>& edit, int steps = 1) {
    const juce::var found = test_utils::graphFacts(engine);
    edit();
    const juce::var made = test_utils::graphFacts(engine);
    expect(test_utils::firstDifference(found, made).isNotEmpty(),
           label + ": the edit changes the graph");
    const auto each = [&](bool (AudioEngine::*step)()) {
      for (int i = 0; i < steps; ++i) (engine.*step)();
    };
    each(&AudioEngine::undo);
    expectGraph(engine, found, label + ": undone");
    each(&AudioEngine::redo);
    expectGraph(engine, made, label + ": redone");
    each(&AudioEngine::undo);
    expectGraph(engine, found, label + ": undone again");
    each(&AudioEngine::redo);
  }

  void runTest() override {
    beginTest("structure and wiring: insert, rename, mute, inputs, period "
              "source, move, combine, remove, chain slots, a template");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String root = is.rootId();
      expectUndoRestores(engine, "Insert (a clip)",
                         [&] { engine.createNode("clip"); });
      expectUndoRestores(engine, "Insert (a stack)",
                         [&] { engine.createNode("stack"); });
      const juce::String a = is.childIds()[0];
      const juce::String group = is.childIds()[1];
      expectUndoRestores(engine, "Insert (into a stack)",
                         [&] { engine.createNode("clip", group); });
      const juce::String inner = is.childIds(group)[0];
      const juce::String b = is.createClip();
      const juce::String c = is.createClip();
      // root: [a, group[inner], b, c]
      expectUndoRestores(engine, "Rename",
                         [&] { engine.renameNode(a, "Bass"); });
      expectUndoRestores(engine, "Mute", [&] { engine.toggleMute(a); });
      expectUndoRestores(engine, "Input", [&] { engine.setNodeInput(a, 3); });
      expectUndoRestores(engine, "InputR",
                         [&] { engine.setNodeInputRight(a, 4); });
      expectUndoRestores(engine, "PeriodSource", [&] {
        engine.setPeriodSource(a, PeriodSource::CONTEXT_CYCLE);
      });
      expectUndoRestores(engine, "Move (within a parent)",
                         [&] { engine.reorderNode(c, root, 0); });
      // root: [c, a, group[inner], b]
      expectUndoRestores(engine, "Move (into a stack)",
                         [&] { engine.reorderNode(b, group, 0); });
      // root: [c, a, group[b, inner]]
      const juce::var tpl = engine.captureTrackTemplate(group);
      expectUndoRestores(engine, "Insert (a group template)",
                         [&] { engine.insertTrackTemplate(tpl, {}); });
      // root: [c, a, group[b, inner], template[..]]
      expectUndoRestores(engine, "Combine (a sibling between)",
                         [&] { engine.combineNodes(c, group); });
      // root: [a, S[group[b, inner], c], template[..]]
      expectUndoRestores(engine, "Combine (across parents)",
                         [&] { engine.combineNodes(a, inner); });
      // root: [S[group[b, T[inner, a]], c], template[..]]
      expectUndoRestores(engine, "Remove (an empty clip)",
                         [&] { engine.deleteNode(c); });
      expectUndoRestores(engine, "Remove (a group)",
                         [&] { engine.deleteNode(group); });

      const juce::String d = is.createClip();
      const juce::String first_slot = is.node(d)
                                          .getProperty("effects", juce::var())
                                          .getProperty("chain", juce::var())[0]
                                          .getProperty("slot", "")
                                          .toString();
      expect(first_slot.isNotEmpty(), "the clip's chain has slots");
      expectUndoRestores(engine, "MoveSlot",
                         [&] { engine.moveChainSlot(d, first_slot, 2); });
      auto plugin = std::make_shared<dsp::Vst3Slot>(
          std::make_unique<test_utils::StubPluginInstance>(0.5f), "Stub-uid",
          "Stub Gain", "/stub/StubGain.vst3");
      const juce::String plugin_slot = plugin->slotUuid();
      expectUndoRestores(engine, "AddSlot", [&] {
        engine.addPluginSlotToChain(d, plugin, 1);
      });
      expectUndoRestores(engine, "RemoveSlot",
                         [&] { engine.removeChainSlot(d, plugin_slot); });
    }

    beginTest("a locked island: maps and the bypass, the re-time, the period "
              "source, songs, takes, content moved and combined, the hand-off");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String root = is.rootId();
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      const juce::String c3 = is.record(8 * Q);
      is.drive(3 * Q + 777);  // playing mid-cycle: continuity riders are live

      expectUndoRestores(engine, "LoopPoints (a window)",
                         [&] { engine.setLoopPoints(c2, Q, 3 * Q); });
      expectUndoRestores(engine, "LoopBypass",
                         [&] { engine.toggleLoopWindow(c2); });
      expectUndoRestores(engine, "LoopPoints (a window under its bypass)",
                         [&] { engine.setLoopPoints(c2, 0, 2 * Q); });
      expectUndoRestores(engine, "LoopPoints (a clear drops the bypass)",
                         [&] { engine.setLoopPoints(c2, 0, 0); });
      expectUndoRestores(engine, "LoopBypass (a whole clip)",
                         [&] { engine.toggleLoopWindow(c1); });
      expectUndoRestores(engine, "LoopPoints (a window on a bypassed whole clip)",
                         [&] { engine.setLoopPoints(c1, 0, Q / 2); });
      engine.setLoopPoints(c1, 0, 0);  // whole and sounding again

      expectUndoRestores(engine, "Segments (a cell map)", [&] {
        engine.setSegments(c3, cells({{0, Q}, {2 * Q, 3 * Q}}));
      });
      expectUndoRestores(engine, "LoopPoints (a window replaces a cell map)",
                         [&] { engine.setLoopPoints(c3, 0, 2 * Q); });
      expectUndoRestores(engine, "LoopPoints (a clear)",
                         [&] { engine.setLoopPoints(c3, 0, 0); });
      expectUndoRestores(engine, "a live map drag is one step", [&] {
        engine.setLoopPoints(c3, 0, 4 * Q);
        engine.setLoopPoints(c3, 0, 7 * Q, /*live=*/true);
        engine.setSegments(c3, cells({{0, Q}, {2 * Q, 3 * Q}}), /*live=*/true);
      });
      engine.setLoopPoints(c3, 0, 0);  // whole again

      expectUndoRestores(engine, "Timing (a shift)",
                         [&] { engine.setTiming(c2, Q); });
      expectUndoRestores(engine, "a live re-time drag is one step", [&] {
        engine.setTiming(c2, Q / 2);
        engine.setTiming(c2, Q / 4, std::nullopt, /*live=*/true);
      });
      expectUndoRestores(engine, "Timing (a free shift with a top)",
                         [&] { engine.setTiming(c3, -Q / 4, 2 * Q); });
      expectUndoRestores(engine, "PeriodSource (a one-shot)", [&] {
        engine.setPeriodSource(c3, PeriodSource::CONTEXT_CYCLE);
      });

      expectUndoRestores(engine, "Sequence (a root song)", [&] {
        engine.setSequence(
            root, seqPayload({{4 * Q}, {4 * Q}}, {{c2, {true, false}}}));
      });
      expectUndoRestores(engine, "SequenceBypass",
                         [&] { engine.toggleSequence(root); });
      expectUndoRestores(engine, "Sequence (cleared)",
                         [&] { engine.setSequence(root, juce::var()); });

      expectUndoRestores(engine, "Take (a new take of a re-timed slot)", [&] {
        engine.newTake(c2);
        is.settle();
      });
      expectUndoRestores(engine, "SelectTake",
                         [&] { engine.selectTake(c2, 0); });
      expectUndoRestores(engine, "Comp",
                         [&] { engine.setComp(c2, {0, 1, 0, 1}); });
      expectUndoRestores(engine, "DeleteTake",
                         [&] { engine.deleteTake(c2, 1); });

      juce::String c4;
      expectUndoRestores(engine, "Insert + Take (a recorded clip)",
                         [&] { c4 = is.record(2 * Q); }, 2);
      expectUndoRestores(engine, "Remove (a committed clip)",
                         [&] { engine.deleteNode(c4); });

      const juce::String box = is.createStack();
      expectUndoRestores(engine, "Move (content anchors an empty stack)",
                         [&] { engine.reorderNode(c1, box, 0); });
      // root: [c2, c3, box[c1]]
      expectUndoRestores(engine, "Combine (content, a sibling between)",
                         [&] { engine.combineNodes(box, c2); });

      expectUndoRestores(engine, "Definer (a hand-off)",
                         [&] { engine.setDefiner(c2); });
      expectUndoRestores(engine, "Insert + Definer + Take (an arm ends the "
                                 "hand-off)",
                         [&] { is.record(4 * Q); }, 3);
    }

    beginTest("a sole definer: its re-trims, the lock-collapse at the next "
              "arm, the re-open, the island emptied");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String c1 = is.record(4 * Q);
      is.drive(Q + 333);

      expectUndoRestores(engine, "LoopPoints (the definer's re-trim)",
                         [&] { engine.setLoopPoints(c1, Q, 2 * Q); });
      expectUndoRestores(engine, "Segments (the definer's cell map)", [&] {
        engine.setSegments(c1, cells({{0, Q}, {2 * Q, 3 * Q}}));
      });
      expectUndoRestores(engine, "LoopPoints (the definer's clear)",
                         [&] { engine.setLoopPoints(c1, 0, 0); });

      engine.setLoopPoints(c1, Q, 2 * Q);  // the trim the next arm locks
      juce::String c2;
      expectUndoRestores(engine, "Insert + Collapse + Take (an arm on a "
                                 "trimmed island)",
                         [&] { c2 = is.record(2 * Q); }, 3);
      expectUndoRestores(engine, "Definer (a hand-off re-opens the collapsed "
                                 "take)",
                         [&] { engine.setDefiner(c1); });
      engine.undo();  // locked again
      expectUndoRestores(engine, "Remove (a delete that re-opens the survivor)",
                         [&] { engine.deleteNode(c2); });

      engine.setSequence(is.rootId(), seqPayload({{Q}, {Q}}));
      expectUndoRestores(engine, "Remove (the last content: Q and the song go)",
                         [&] { engine.deleteNode(c1); });
    }

    beginTest("a song rides a re-grid whole: the rescale rounds its fades, "
              "undo brings back the lengths it had");
    {
      // Each re-grid below scales the fade to a fraction of a sample and
      // rounds it; scaling the rounded value back would miss by one.
      const auto fadedSong = [](int64_t step, double fade) {
        juce::var song = seqPayload({{step}, {step}});
        song["steps"][0].getDynamicObject()->setProperty("fadeIn", fade);
        return song;
      };
      {
        Island is;
        AudioEngine& engine = is.engine;
        const juce::String c1 = is.record(4 * Q);
        engine.setSequence(is.rootId(), fadedSong(4 * Q, 441.0));
        expectUndoRestores(engine, "LoopPoints (a re-trim rescales the song)",
                           [&] { engine.setLoopPoints(c1, Q, Q + 30000); });
        expectUndoRestores(engine, "Segments (a cell map rescales the song)",
                           [&] {
                             engine.setSegments(
                                 c1, cells({{0, 7000}, {20000, 30000}}));
                           });
      }
      {
        Island is;
        AudioEngine& engine = is.engine;
        is.record(3 * Q);
        const juce::String b = is.record(3 * Q);
        engine.setLoopPoints(b, 0, Q);  // a third of Q
        engine.setSequence(is.rootId(), fadedSong(3 * Q, 100.0));
        expectUndoRestores(engine, "Definer (a hand-off rescales the song)",
                           [&] { engine.setDefiner(b); });
      }
    }

    beginTest("the first take establishes Q: the pre-Q geometry it scrubs "
              "comes back with its undo");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String window_box = is.createStack();
      engine.setLoopPoints(window_box, 0, 12345);
      const juce::String cell_box = is.createStack();
      engine.setSegments(cell_box, cells({{0, 5000}, {7000, 9345}}));
      expectEquals(is.iprop(window_box, "loopEnd"), (int64_t)12345,
                   "a pre-Q window of a free length");
      expect(is.node(cell_box).hasProperty("segments"), "a pre-Q cell map");
      expectUndoRestores(engine, "Insert + Take (the establishment scrub)",
                         [&] { is.record(Q); }, 2);
      expectEquals(is.iprop(window_box, "loopEnd"), (int64_t)0,
                   "the window cannot live on Q: scrubbed");
      expect(!is.node(cell_box).hasProperty("segments"),
             "nor can the cell map");
    }
    {
      // The stack the take anchors is the one whose window is scrubbed.
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String box = is.createStack();
      engine.setLoopPoints(box, 0, 12345);
      expectUndoRestores(engine, "Insert + Take (scrubbed and anchored)",
                         [&] { is.record(Q, box); }, 2);
      expect(is.bprop(box, "anchored") && is.iprop(box, "loopEnd") == 0,
             "the stack is anchored and its window scrubbed");
    }

    beginTest("the first take establishes Q: the songs authored before it "
              "stay through its undo and its redo");
    {
      // A take's undo is applied to the graph the take left, so every song
      // it meets was there before the take: the island reverting to no Q
      // takes none of them with it.
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String root = is.rootId();
      expect(engine.setSequence(root, seqPayload({{4 * Q}, {4 * Q}})),
             "a song on the root of an empty island");
      const juce::String box = is.createStack();
      expect(engine.setSequence(box, seqPayload({{2 * Q}, {Q}})),
             "...and one on an empty group");
      expectUndoRestores(engine, "Insert + Take (under songs authored first)",
                         [&] { is.record(Q); }, 2);
      expect(is.state().hasProperty("sequence") &&
                 is.node(box).hasProperty("sequence"),
             "both songs play under the take");
      engine.undo();
      engine.undo();
      expectEquals(is.Q(), (int64_t)0, "the take undone: no Q again");
      expect(is.state().hasProperty("sequence") &&
                 is.node(box).hasProperty("sequence"),
             "...and both songs still there");
    }
    {
      // The same through an import that establishes Q.
      Island is;
      AudioEngine& engine = is.engine;
      expect(engine.setSequence(is.rootId(), seqPayload({{4 * Q}, {4 * Q}})),
             "a song on the root of an empty island");
      const juce::String empty = is.createClip();
      const juce::String wav =
          test_utils::writeWav(test_utils::freshTempDir("undo_symmetry_song"),
                               "import.wav", 44100.0, 1, (int)(2 * Q))
              .getFullPathName();
      expectUndoRestores(engine, "Take (an import under a song authored first)",
                         [&] { engine.importAudio(empty, wav, 0); });
    }
    {
      // A first take aimed at a looping step gates itself into that step:
      // the song swaps with the take, both ways.
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String root = is.rootId();
      expect(engine.setSequence(root, seqPayload({{4 * Q}, {4 * Q}})),
             "a song on the root of an empty island");
      engine.auditionStep(root, 1);
      juce::String clip;
      expectUndoRestores(engine, "Insert + Take (a step take that gates itself)",
                         [&] { clip = is.record(Q); }, 2);
      const juce::var gates =
          is.state().getProperty("sequence", {}).getProperty("gates", {});
      expect(gates.hasProperty(clip), "the take is gated into its step");
    }

    beginTest("an import: onto a stack (the clip it makes and the take are "
              "one step), onto that clip (a new take), onto an empty clip");
    {
      Island is;
      AudioEngine& engine = is.engine;
      is.record(Q);
      const juce::String box = is.createStack();
      const juce::String empty = is.createClip();
      const juce::String wav =
          test_utils::writeWav(test_utils::freshTempDir("undo_symmetry"),
                               "import.wav", 44100.0, 1, (int)(2 * Q))
              .getFullPathName();
      expectUndoRestores(engine, "Insert + Take (an import onto a stack)", [&] {
        engine.importAudio(box, wav, is.zero() + Q);
      });
      const juce::String made = is.childIds(box)[0];
      expectUndoRestores(engine, "Take (an import onto a committed clip)",
                         [&] { engine.importAudio(made, wav, 0); });
      expectUndoRestores(engine, "Take (an import onto an empty clip)", [&] {
        engine.importAudio(empty, wav, is.zero() + 3 * Q);
      });
    }

    beginTest("a sole definer under a cell map: the arm splices it");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String c1 = is.record(4 * Q);
      engine.setSegments(c1, cells({{0, Q}, {2 * Q, 3 * Q}}));
      expectEquals(is.Q(), 2 * Q, "Q := the map's period");
      expectUndoRestores(engine, "Insert + Collapse + Take (a splice)",
                         [&] { is.record(2 * Q); }, 3);
    }

    beginTest("a bypassed map is not in use: the next arm locks nothing - a "
              "bypassed cut map stays stored, the take stays whole");
    for (const bool cut_map : {true, false}) {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String c1 = is.record(4 * Q);
      if (cut_map) {
        engine.setSegments(c1, cells({{0, Q}, {2 * Q, 3 * Q}}));
      } else {
        engine.setLoopPoints(c1, Q, 3 * Q);
      }
      engine.toggleLoopWindow(c1);
      expect(is.bprop(c1, "loopBypassed"), "the definer's map is bypassed");
      const juce::String label =
          cut_map ? "a bypassed cut map" : "a bypassed window";
      expectUndoRestores(engine, "Insert + Take (an arm over " + label + ")",
                         [&] { is.record(2 * Q); }, 2);
      expectEquals(is.dur(c1), 4 * Q, label + ": the take stays whole");
      expect(is.bprop(c1, "loopBypassed"), label + ": still bypassed");
      if (cut_map) {
        expect(is.node(c1).hasProperty("segments"),
               label + ": the map stays stored");
      } else {
        expectEquals(is.iprop(c1, "loopEnd"), 3 * Q,
                     label + ": the window stays stored");
      }
    }

    beginTest("a definer group: the group take, its re-trim, the collapse, "
              "the re-open, a member and the group removed");
    {
      Island is;
      AudioEngine& engine = is.engine;
      juce::String kit;
      expectUndoRestores(engine, "Insert x4 + Take (a group take)",
                         [&] { kit = is.recordGroup(3, 4 * Q); }, 5);
      is.drive(Q + 333);
      expectUndoRestores(engine, "LoopPoints (a definer group's re-trim)",
                         [&] { engine.setLoopPoints(kit, Q, 3 * Q); });
      juce::String c;
      expectUndoRestores(engine, "Insert + Collapse + Take (an arm on a "
                                 "trimmed group)",
                         [&] { c = is.record(2 * Q); }, 3);
      expectUndoRestores(engine, "Timing (a group's shift)",
                         [&] { engine.setTiming(kit, 2 * Q); });
      expectUndoRestores(engine, "Remove (a delete that re-opens the group)",
                         [&] { engine.deleteNode(c); });
      const juce::String mic = is.childIds(kit)[1];
      expectUndoRestores(engine, "Remove (one member)",
                         [&] { engine.deleteNode(mic); });
      expectUndoRestores(engine, "Remove (the group: the island empties)",
                         [&] { engine.deleteNode(kit); });
    }
  }
};

static UndoSymmetryTests undoSymmetryTests;

}  // namespace celestrian
