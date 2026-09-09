// AudioEngine — AUDIO FILE IMPORT (docs/import.md) and the MIDI note
// readout for the lane (docs/vst3.md §11). A WAV/AIFF/FLAC decodes on
// the message thread into an exact-size buffer at the device rate and
// commits like a take: a first take of an empty clip (placed on the Q
// grid, snapped by the hysteresis law, establishing Q on a pre-Q
// island) or a new take of a committed slot (cut to the period). Only
// the idle-clip buffer swap touches shared state. Message thread only.

#include "../audio_engine.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <vector>

#include "../clip_node.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

namespace {

/** Lagrange interpolation reads a few samples past the exact input
 * span; the source carries this much zero padding so it never reads
 * off the end. */
constexpr int kResampleGuardSamples = 16;

/**
 * The file decoded to a buffer at `target_rate`: channels beyond two
 * fold onto the stereo pair (odd channels left, even channels right,
 * equal weights), a mismatched file rate resamples every channel with
 * a Lagrange interpolator. Null on failure, with `error` saying why.
 */
std::unique_ptr<juce::AudioBuffer<float>> decodeAudioFile(
    const juce::File& file, double target_rate, juce::String& error) {
  if (!file.existsAsFile()) {
    error = "no such file";
    return nullptr;
  }
  juce::AudioFormatManager manager;
  manager.registerBasicFormats();
  std::unique_ptr<juce::AudioFormatReader> reader(
      manager.createReaderFor(file));
  if (reader == nullptr) {
    error = "not a readable WAV/AIFF/FLAC";
    return nullptr;
  }
  const int64_t length = (int64_t)reader->lengthInSamples;
  const int source_channels = (int)reader->numChannels;
  if (length <= 0 || source_channels <= 0) {
    error = "the file holds no audio";
    return nullptr;
  }
  if (length > celestrian::ClipNode::kMaxTakeSamples) {
    error = "the file is longer than a take may be";
    return nullptr;
  }
  juce::AudioBuffer<float> raw(source_channels, (int)length);
  if (!reader->read(raw.getArrayOfWritePointers(), source_channels, 0,
                    (int)length)) {
    error = "the file could not be read";
    return nullptr;
  }

  // Fold to the stereo pair (mono and stereo pass through).
  const int channels = source_channels >= 2 ? 2 : 1;
  juce::AudioBuffer<float> folded(channels, (int)length + kResampleGuardSamples);
  folded.clear();
  if (source_channels <= 2) {
    for (int c = 0; c < channels; ++c) folded.copyFrom(c, 0, raw, c, 0, (int)length);
  } else {
    int per_side[2] = {0, 0};
    for (int c = 0; c < source_channels; ++c) ++per_side[c % 2];
    for (int c = 0; c < source_channels; ++c) {
      folded.addFrom(c % 2, 0, raw, c, 0, (int)length,
                     1.0f / (float)per_side[c % 2]);
    }
  }

  const double source_rate = reader->sampleRate;
  const bool same_rate =
      source_rate <= 0 || std::abs(source_rate - target_rate) < 1e-6;
  if (same_rate) {
    auto out = std::make_unique<juce::AudioBuffer<float>>(channels, (int)length);
    for (int c = 0; c < channels; ++c) out->copyFrom(c, 0, folded, c, 0, (int)length);
    return out;
  }
  const int out_length =
      (int)std::llround((double)length * target_rate / source_rate);
  if (out_length <= 0) {
    error = "the file is too short to resample";
    return nullptr;
  }
  auto out = std::make_unique<juce::AudioBuffer<float>>(channels, out_length);
  out->clear();
  const double ratio = source_rate / target_rate;
  for (int c = 0; c < channels; ++c) {
    juce::LagrangeInterpolator interpolator;
    interpolator.reset();
    interpolator.process(ratio, folded.getReadPointer(c),
                         out->getWritePointer(c), out_length);
  }
  return out;
}

/** The nearest whole Q to a QTime rational (0 when the denominator is
 * degenerate). */
int64_t nearestWholeQ(int64_t num, int64_t den) {
  if (den == 0) return 0;
  return (int64_t)std::llround((double)num / (double)den);
}

}  // namespace

bool AudioEngine::importAudio(const juce::String& uuid,
                              const juce::String& path, int64_t at_q_num,
                              int64_t at_q_den) {
  if (root_node == nullptr) return false;
  if (root_node->hasActiveTake() || root_node->isArmedOrRecording()) {
    juce::Logger::writeToLog("AudioEngine: import refused - a take is live");
    return false;
  }
  celestrian::AudioNode* node = findNodeByUuid(root_node.get(), uuid);
  if (node == nullptr) {
    juce::Logger::writeToLog("AudioEngine: import refused - no node " + uuid);
    return false;
  }
  auto* clip = dynamic_cast<celestrian::ClipNode*>(node);
  auto* stack = clip == nullptr ? dynamic_cast<celestrian::StackNode*>(node)
                                : nullptr;
  if (clip != nullptr) {
    if (clip->isArmedOrRecording()) {
      juce::Logger::writeToLog("AudioEngine: import refused - " + uuid +
                               " has a take in flight");
      return false;
    }
    if (clip->isMidiClip()) {
      juce::Logger::writeToLog("AudioEngine: import refused - " + uuid +
                               " is a MIDI track (it takes notes, not audio)");
      return false;
    }
    if (clip->getIntrinsicDuration() > 0 &&
        clip->takeCount() >= celestrian::ClipNode::kMaxTakes) {
      juce::Logger::writeToLog("AudioEngine: import refused - " + uuid +
                               " holds the maximum number of takes");
      return false;
    }
  } else if (stack == nullptr) {
    return false;
  }

  // Decode first: a file that cannot be read leaves the graph untouched
  // (no empty clip, no log entry).
  const juce::File file(path);
  juce::String error;
  std::unique_ptr<juce::AudioBuffer<float>> audio =
      decodeAudioFile(file, currentSampleRateOrFallback(), error);
  if (audio == nullptr) {
    juce::Logger::writeToLog("AudioEngine: import refused - " + path + ": " +
                             error);
    return false;
  }

  const int64_t q = root_node->getQuantum();
  const int64_t epoch = root_node->getEpoch();

  if (stack != nullptr) {
    // A stack target gains a fresh clip child named after the file —
    // the createNode shape (one undoable Insert; the node object is
    // retained through the edit, so the pointer stays valid).
    auto fresh = std::make_unique<celestrian::ClipNode>(
        file.getFileNameWithoutExtension(), cached_sample_rate_.load());
    fresh->setParent(stack);
    clip = fresh.get();
    celestrian::Edit e(celestrian::Edit::Kind::Insert);
    e.parentUuid = stack->getUuid();
    e.index = stack->getNumChildren();
    e.node = std::move(fresh);
    record(std::move(e));
  }

  if (clip->getIntrinsicDuration() > 0) {
    // THE SECOND FORM: a new take of the slot (docs/takes.md) — the
    // file cut or zero-padded to the period, placed behind the shared
    // content base like a recorded new take, appended and made active.
    const int64_t period = clip->getIntrinsicDuration();
    const int64_t base = clip->getContentBase();
    const int channels = audio->getNumChannels();
    juce::AudioBuffer<float> cut(channels, (int)(base + period));
    cut.clear();
    const int copy = (int)std::min<int64_t>(period, audio->getNumSamples());
    for (int c = 0; c < channels; ++c) {
      cut.copyFrom(c, (int)base, *audio, c, 0, copy);
    }
    const int prev_active = clip->activeTake();
    clip->appendLoadedTake(cut);
    const int index = clip->takeCount() - 1;
    if (!clip->selectTake(index)) {
      juce::Logger::writeToLog("AudioEngine: import failed - the new take of " +
                               uuid + " could not be selected");
      return false;
    }
    celestrian::Edit inv(celestrian::Edit::Kind::Untake);
    celestrian::Edit::TakePayload tp;
    tp.uuid = clip->getUuid();
    tp.take_index = index;
    tp.prev_active = prev_active;
    inv.takes.push_back(std::move(tp));
    inv.setsIsland = true;
    inv.iq = q;
    inv.iepoch = epoch;
    reconcileTakes();  // log order: settled takes enter BEFORE this entry
    pushUndo(std::move(inv));
    clearRedo();
    juce::Logger::writeToLog("AudioEngine: imported " + file.getFileName() +
                             " as take " + juce::String(index + 1) + " of " +
                             uuid + " (cut to the slot's period)");
    return true;
  }

  // THE FIRST FORM: a first take of an empty clip. Placement is the
  // nearest Q boundary to the drop (Q11: arm targets are Q boundaries)
  // in the epoch frame; a pre-Q island takes the clock as the origin
  // and the file's length as Q, exactly as a first recorded take.
  const int64_t length = audio->getNumSamples();
  int64_t duration = length;
  // Like a recorded commit (audit D4-7) no map is authored on the take;
  // only an unsnapped length leaves the provisional [0, L) window
  // (0 = none).
  int64_t loop_end = 0;
  if (q > 0) {
    const celestrian::timing::SnapResult snap =
        celestrian::timing::snapCommittedDuration(length, q);
    duration = snap.duration;
    if (snap.loop_end < snap.duration) loop_end = snap.loop_end;
  }
  // A snap UP plays past the file's end: the buffer covers the whole
  // committed duration, zero where the file had nothing.
  const int64_t extent = std::max(length, duration);
  if (extent > length) {
    auto padded = std::make_unique<juce::AudioBuffer<float>>(
        audio->getNumChannels(), (int)extent);
    padded->clear();
    for (int c = 0; c < audio->getNumChannels(); ++c) {
      padded->copyFrom(c, 0, *audio, c, 0, (int)length);
    }
    audio = std::move(padded);
  }
  const int64_t origin = q > 0 ? epoch + nearestWholeQ(at_q_num, at_q_den) * q
                               : global_transport_pos.load();
  const int64_t context_cycle = q > 0 ? calculateEffectiveCycleLength() : 0;

  // Commit like a take: the island snapshots its pre-take cycles
  // (takeArmed), the content lands, the first take establishes the
  // island, and the commit event runs the growth re-base.
  root_node->takeArmed();
  retireOwned(clip->installImportedTake(std::move(audio), origin, duration,
                                        loop_end, context_cycle));
  if (q == 0) root_node->establishIsland(duration, origin);
  root_node->takeCommitted(origin, root_node->getIntrinsicDuration());

  // The log entry (reconcileTakes' shape): the inverse Untake names the
  // clip and carries the island facts as they were before the import.
  celestrian::Edit inv(celestrian::Edit::Kind::Untake);
  celestrian::Edit::TakePayload tp;
  tp.uuid = clip->getUuid();
  inv.takes.push_back(std::move(tp));
  inv.setsIsland = true;
  inv.iq = q;
  inv.iepoch = epoch;
  settleAnchors(inv);
  reconcileTakes();  // log order: settled takes enter BEFORE this entry
  pushUndo(std::move(inv));
  clearRedo();
  if (q <= 0 && root_node->getQuantum() > 0) {
    scrubIncoherentGeometry(root_node->getQuantum());
  }
  juce::Logger::writeToLog(
      "AudioEngine: imported " + file.getFileName() + " into " + uuid +
      " - origin " + juce::String(origin) + ", duration " +
      juce::String(duration) + (q == 0 ? " (establishes Q)" : ""));
  return true;
}

juce::var AudioEngine::getMidiNotes(const juce::String& uuid) const {
  juce::Array<juce::var> rows;
  auto* self = const_cast<AudioEngine*>(this);
  auto* clip = dynamic_cast<celestrian::ClipNode*>(
      self->findNodeByUuid(root_node.get(), uuid));
  if (clip == nullptr || clip->recState() != celestrian::ClipNode::RecState::Idle ||
      clip->contentKind() != celestrian::ClipNode::ContentKind::Midi) {
    return rows;
  }
  const int64_t duration = clip->getIntrinsicDuration();
  const int64_t q = root_node->getQuantum();
  if (duration <= 0 || q <= 0) return rows;
  const int64_t base = clip->getContentBase();
  const celestrian::MidiSequence& seq = clip->midiSequence();

  struct Note {
    int64_t pos = 0, len = 0;
    int note = 0, velocity = 0;
  };
  struct Open {
    int64_t pos = 0;
    int velocity = 0;
  };
  std::vector<Note> notes;
  std::map<int, std::vector<Open>> open;  // (channel, pitch) -> note-ons
  for (int i = 0; i < seq.count(); ++i) {
    const celestrian::MidiEvent& e = seq[i];
    const int64_t pos = e.pos - base;
    if (pos < 0 || pos >= duration) continue;
    const int key = e.channel0() * 128 + e.note();
    if (e.isNoteOn()) {
      open[key].push_back({pos, e.velocity()});
    } else if (e.isNoteOff()) {
      auto it = open.find(key);
      if (it == open.end() || it->second.empty()) continue;
      const Open on = it->second.back();
      it->second.pop_back();
      notes.push_back({on.pos, pos - on.pos, e.note(), on.velocity});
    }
  }
  // Unpaired note-ons run to the take end.
  for (const auto& [key, stack] : open) {
    for (const Open& on : stack) {
      notes.push_back({on.pos, duration - on.pos, key % 128, on.velocity});
    }
  }
  std::stable_sort(notes.begin(), notes.end(),
                   [](const Note& a, const Note& b) { return a.pos < b.pos; });
  for (const Note& n : notes) {
    const celestrian::timing::QTime pos = celestrian::timing::fromSamples(n.pos, q);
    const celestrian::timing::QTime len = celestrian::timing::fromSamples(n.len, q);
    juce::Array<juce::var> row;
    row.add((double)pos.num);
    row.add((double)pos.den);
    row.add(n.note);
    row.add(n.velocity);
    row.add((double)len.num);
    row.add((double)len.den);
    rows.add(juce::var(row));
  }
  return rows;
}
