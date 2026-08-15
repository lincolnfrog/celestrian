#pragma once

#include <juce_core/juce_core.h>

#include <memory>

#include "clip_node.h"
#include "stack_node.h"

namespace celestrian::track_templates {

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
 *    children?: [...] }. Performance facts (audio, durations, origins,
 *  windows) are never captured — a template is pre-Q by construction,
 *  like its whole-session cousin. */
inline juce::var capture(const AudioNode& node) {
  auto* o = new juce::DynamicObject();
  o->setProperty("name", node.getName());
  if (auto* clip = dynamic_cast<const ClipNode*>(&node)) {
    o->setProperty("type", "clip");
    o->setProperty("inputChannel", clip->getInputChannel());
    o->setProperty("inputChannelR", clip->getInputChannelRight());
  } else if (auto* stack = dynamic_cast<const StackNode*>(&node)) {
    o->setProperty("type", "stack");
    juce::Array<juce::var> kids;
    // getChild is non-const; capture walks a const tree — go through
    // the const child list accessor instead.
    for (int i = 0; i < stack->getNumChildren(); ++i) {
      kids.add(capture(*const_cast<StackNode*>(stack)->getChild(i)));
    }
    o->setProperty("children", kids);
  }
  return juce::var(o);
}

/** Rebuild a fresh (empty, armable) subtree from a captured var. New
 *  uuids throughout — a template stamps COPIES, never aliases. Returns
 *  nullptr on an unrecognized shape. `sample_rate` seeds the clip
 *  buffers exactly like AudioEngine::createNode (P0-5). */
inline std::unique_ptr<AudioNode> build(const juce::var& v,
                                        double sample_rate) {
  const auto type = v.getProperty("type", juce::var()).toString();
  const auto name = v.getProperty("name", juce::var()).toString();
  if (type == "clip") {
    auto clip = std::make_unique<ClipNode>(
        name.isEmpty() ? juce::String("New Clip") : name, sample_rate);
    clip->setInputChannel((int)v.getProperty("inputChannel", 0));
    clip->setInputChannelRight((int)v.getProperty("inputChannelR", -1));
    return clip;
  }
  if (type == "stack") {
    auto stack = std::make_unique<StackNode>(
        name.isEmpty() ? juce::String("New Stack") : name);
    if (auto* kids = v.getProperty("children", juce::var()).getArray()) {
      for (const auto& k : *kids) {
        if (auto child = build(k, sample_rate)) {
          stack->addChild(std::move(child));
        }
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
