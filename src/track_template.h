#pragma once

#include <juce_core/juce_core.h>

#include <cmath>
#include <memory>

#include "clip_node.h"
#include "stack_node.h"
#include "timing.h"

namespace celestrian::track_templates {

/** A step length in Q as the session format's EXACT rational ({num,
 * den}, through the one QTime serializer). */
inline juce::var qcountVar(int64_t samples, int64_t q_samples) {
  return AudioNode::qtimeVar(timing::fromSamples(samples, q_samples));
}

/** The inverse, materialized against `q_samples`. Reads both shapes a
 * template file may hold: a {num, den} object (what capture writes) and
 * a bare Q count. */
inline int64_t qcountSamples(const juce::var& v, int64_t q_samples) {
  if (auto* o = v.getDynamicObject()) {
    return timing::toSamples(
        timing::qtime((int64_t)(double)o->getProperty("num"),
                      (int64_t)(double)o->getProperty("den")),
        q_samples);
  }
  if (v.isDouble() || v.isInt() || v.isInt64())
    return (int64_t)std::llround((double)v * (double)q_samples);
  return 0;
}

/**
 * Subtree templates (design_language.md Q17 — the Q7 companion).
 *
 * A track template is a SAVED DECISION, not saved music: the node
 * structure, the names, and the input assignments of a track or group,
 * captured once ("Save as template") and replayed from the creation
 * menu ("Drums" → the 5-mic group, named and routed, in one undoable
 * insert). Capture is deliberately the Q7 canon minimum — structure +
 * names + inputs — and the format is ADDITIVE: fx/gain/pan can ride in
 * later as extra properties without a migration (absent = default,
 * exactly like session_io's persistence discipline).
 *
 * Distinct from projects.md WHOLE-SESSION templates (a project with no
 * performances): these are subtrees, they live in a global user-level
 * library (ProjectManager::trackTemplatesRoot), and they insert INTO
 * the current session rather than replacing it.
 *
 * Message thread only (plain graph walks, no atomicity games — the
 * built subtree is handed to the edit log before the audio thread can
 * see it).
 */

/** Serialize `node`'s structure + names + inputs to a var tree:
 *  { type: 'clip'|'stack', name, inputChannel?, inputChannelR?,
 *    monitor?, children?: [...], sequence?: {...} }. Input setup is
 *  the channels AND the Q20 monitoring toggle (`monitor`, additive:
 *  present only when on). Performance facts (audio, durations,
 *  origins, windows) are never captured — a template is pre-Q by
 *  construction, like its whole-session cousin.
 *
 *  SEQUENCES are the exception (S14, docs/sequencer.md §9): a song's
 *  shape is a saved decision, not saved music. Step lengths are
 *  stored as Q COUNTS (`lenQ`, qcountVar — device- and tempo-portable)
 *  and gates are keyed by CHILD INDEX (build stamps new uuids, so
 *  uuid keys would dangle). Pass the
 *  capturing island's `q_samples`; with no Q established the sequence
 *  is skipped (its lengths would be meaningless). */
inline juce::var capture(const AudioNode& node, int64_t q_samples = 0) {
  auto* o = new juce::DynamicObject();
  o->setProperty("name", node.getName());
  if (auto* clip = dynamic_cast<const ClipNode*>(&node)) {
    o->setProperty("type", "clip");
    o->setProperty("inputChannel", clip->getInputChannel());
    o->setProperty("inputChannelR", clip->getInputChannelRight());
    if (clip->isMonitoring()) o->setProperty("monitor", true);
  } else if (auto* stack = dynamic_cast<const StackNode*>(&node)) {
    o->setProperty("type", "stack");
    juce::Array<juce::var> kids;
    for (const auto& child : stack->ownedChildren()) {
      kids.add(capture(*child, q_samples));
    }
    o->setProperty("children", kids);
    if (const Sequence* s = stack->sequencePtr(); s != nullptr && q_samples > 0) {
      auto* so = new juce::DynamicObject();
      so->setProperty("bypassed", stack->isSequenceBypassed());
      juce::Array<juce::var> steps;
      for (const auto& st : s->steps) {
        auto* stepo = new juce::DynamicObject();
        stepo->setProperty("name", st.name);
        stepo->setProperty("lenQ", qcountVar(st.len, q_samples));
        if (st.cue) stepo->setProperty("cue", true);  // additive
        if (!st.next.empty())
          stepo->setProperty("next", Sequence::successorsVar(st));
        if (st.fade_in > 0)
          stepo->setProperty("fadeInQ", qcountVar(st.fade_in, q_samples));
        if (st.fade_out > 0)
          stepo->setProperty("fadeOutQ", qcountVar(st.fade_out, q_samples));
        steps.add(juce::var(stepo));
      }
      so->setProperty("steps", steps);
      if (s->seed != 0) so->setProperty("seed", (double)s->seed);
      // Gates by child INDEX: [{child: i, bits: [0/1...]}].
      juce::Array<juce::var> gates;
      for (int i = 0; i < stack->getNumChildren(); ++i) {
        const juce::String uuid = stack->ownedChildren()[(size_t)i]->getUuid();
        bool has_row = false;
        for (const auto& row : s->gates) {
          if (row.uuid == uuid) has_row = true;
        }
        if (!has_row) continue;  // absent = inherit ON (stays absent)
        const uint64_t m = s->maskFor(uuid);
        auto* g = new juce::DynamicObject();
        g->setProperty("child", i);
        juce::Array<juce::var> bits;
        for (int k = 0; k < s->numSteps(); ++k) bits.add(s->on(m, k));
        g->setProperty("bits", bits);
        gates.add(juce::var(g));
      }
      so->setProperty("gates", gates);
      o->setProperty("sequence", juce::var(so));
    }
  }
  return juce::var(o);
}

/** Rebuild a fresh (empty, armable) subtree from a captured var. New
 *  uuids throughout — a template stamps COPIES, never aliases. Returns
 *  nullptr on an unrecognized shape. `sample_rate` seeds the clip
 *  buffers exactly like AudioEngine::createNode. */
inline std::unique_ptr<AudioNode> build(const juce::var& v,
                                        double sample_rate,
                                        int64_t q_samples = 0) {
  const auto type = v.getProperty("type", juce::var()).toString();
  const auto name = v.getProperty("name", juce::var()).toString();
  if (type == "clip") {
    auto clip = std::make_unique<ClipNode>(
        name.isEmpty() ? juce::String("New Clip") : name, sample_rate);
    clip->setInputChannel((int)v.getProperty("inputChannel", 0));
    clip->setInputChannelRight((int)v.getProperty("inputChannelR", -1));
    clip->setMonitoring((bool)v.getProperty("monitor", false));
    return clip;
  }
  if (type == "stack") {
    auto stack = std::make_unique<StackNode>(
        name.isEmpty() ? juce::String("New Stack") : name);
    if (auto* kids = v.getProperty("children", juce::var()).getArray()) {
      for (const auto& k : *kids) {
        if (auto child = build(k, sample_rate, q_samples)) {
          stack->addChild(std::move(child));
        }
      }
    }
    // SEQUENCE (S14): materialize lenQ against the DESTINATION island's
    // Q, re-keying index gates onto the freshly stamped child uuids.
    // With no Q established yet the sequence is skipped (logged) — its
    // lengths have no exchange rate to land on.
    const juce::var block = v.getProperty("sequence", juce::var());
    if (auto* so = block.getDynamicObject()) {
      if (q_samples > 0) {
        // A LENIENT read (Sequence::fromVar): what the template spells
        // wrong is left out and the rest builds.
        Sequence::Dropped dropped;
        auto seq = Sequence::fromVar(
            block, Sequence::kQKeys,
            [q_samples](const juce::var& length) {
              return qcountSamples(length, q_samples);
            },
            dropped);
        if (dropped.any()) {
          juce::Logger::writeToLog(
              "track_templates::build - the sequence built in part - " +
              dropped.what());
        }
        if (seq != nullptr) {
          if (auto* gates = so->getProperty("gates").getArray()) {
            for (const auto& gv : *gates) {
              const int child = (int)gv.getProperty("child", -1);
              if (child < 0 || child >= stack->getNumChildren()) continue;
              const juce::var bits = gv.getProperty("bits", juce::var());
              seq->gates.push_back({stack->getChild(child)->getUuid(),
                                    Sequence::maskFromBits(bits)});
            }
          }
          // A template always builds a NESTED stack: a radio is root-
          // only (S12), so its successor graph is dropped here.
          if (seq->radio) {
            juce::Logger::writeToLog(
                "track_templates::build - template carries a radio; "
                "successors dropped (a radio is root-only, S12)");
            seq->linearize();
          }
          delete stack->exchangeSequence(seq.release());
          stack->setSequenceBypassed(
              (bool)so->getProperty("bypassed"));
        }
      } else {
        juce::Logger::writeToLog(
            "track_templates::build - template carries a sequence but the "
            "island has no Q yet; sequence skipped");
      }
    }
    return stack;
  }
  return nullptr;
}

/** Number of clip leaves a captured template would create (menu
 *  metadata: "Drums · 5 tracks"). */
inline int countClips(const juce::var& v) {
  if (v.getProperty("type", juce::var()).toString() == "clip") return 1;
  int n = 0;
  if (auto* kids = v.getProperty("children", juce::var()).getArray()) {
    for (const auto& k : *kids) n += countClips(k);
  }
  return n;
}

}  // namespace celestrian::track_templates
