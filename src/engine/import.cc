// AudioEngine — AUDIO FILE IMPORT (docs/import.md). A WAV/AIFF/FLAC
// decodes on the message thread into an exact-size buffer at the device
// rate and commits like a take: a first take of an empty clip, or a new
// take of a committed slot. Only the idle-clip buffer swap touches
// shared state. Message thread only.

#include "../audio_engine.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>
#include <cmath>
#include <memory>

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
  // The take ceiling binds the file as stored AND as it will be at the
  // device's rate — judged from the header, before anything is decoded.
  const double source_rate = reader->sampleRate;
  const bool same_rate =
      source_rate <= 0 || std::abs(source_rate - target_rate) < 1e-6;
  const int64_t out_length =
      same_rate ? length
                : (int64_t)std::llround((double)length * target_rate /
                                        source_rate);
  if (std::max(length, out_length) > celestrian::ClipNode::kMaxTakeSamples) {
    error = "the file is longer than a take may be";
    return nullptr;
  }
  if (out_length <= 0) {
    error = "the file is too short to resample";
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

  if (same_rate) {
    auto out = std::make_unique<juce::AudioBuffer<float>>(channels, (int)length);
    for (int c = 0; c < channels; ++c) out->copyFrom(c, 0, folded, c, 0, (int)length);
    return out;
  }
  auto out =
      std::make_unique<juce::AudioBuffer<float>>(channels, (int)out_length);
  out->clear();
  const double ratio = source_rate / target_rate;
  for (int c = 0; c < channels; ++c) {
    juce::LagrangeInterpolator interpolator;
    interpolator.reset();
    interpolator.process(ratio, folded.getReadPointer(c),
                         out->getWritePointer(c), (int)out_length);
  }
  return out;
}

}  // namespace

bool AudioEngine::importAudio(const juce::String& uuid,
                              const juce::String& path,
                              int64_t origin_samples) {
  const auto refuse = [](const juce::String& why) {
    juce::Logger::writeToLog("AudioEngine: import refused - " + why);
    return false;
  };
  if (root_node->hasActiveTake() || root_node->isArmedOrRecording()) {
    return refuse("a take is live");
  }
  celestrian::AudioNode* node = findNodeByUuid(uuid);
  if (node == nullptr) return refuse("no node " + uuid);
  auto* clip = dynamic_cast<celestrian::ClipNode*>(node);
  auto* stack = clip == nullptr ? dynamic_cast<celestrian::StackNode*>(node)
                                : nullptr;
  if (clip != nullptr) {
    if (clip->isMidiClip()) {
      return refuse(uuid + " is a MIDI track (it takes notes, not audio)");
    }
    if (clip->getIntrinsicDuration() > 0 &&
        clip->takeCount() >= celestrian::ClipNode::kMaxTakes) {
      return refuse(uuid + " holds the maximum number of takes");
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
  if (audio == nullptr) return refuse(path + ": " + error);

  celestrian::engine_internal::CommittedTake take;
  take.q_before = root_node->getQuantum();
  take.zero_before = root_node->getZero();
  const int64_t q = take.q_before;
  const int64_t zero = take.zero_before;

  // Settled takes enter the log BEFORE this import's entry.
  reconcileTakes();

  // A stack target gains a fresh clip child named after the file — the
  // createNode shape (the node object is retained through the edit, so
  // the pointer stays valid). The Insert is applied here and logged with
  // the take as ONE entry: its inverse rides the take's as the edit that
  // follows it (Edit::then), so one undo removes the take and the clip.
  celestrian::Edit insert_inverse;
  if (stack != nullptr) {
    auto fresh = std::make_unique<celestrian::ClipNode>(
        file.getFileNameWithoutExtension(), cached_sample_rate_.load());
    fresh->setParent(stack);
    clip = fresh.get();
    celestrian::Edit e(celestrian::Edit::Kind::Insert);
    e.parentUuid = stack->getUuid();
    e.index = stack->getNumChildren();
    e.node = std::move(fresh);
    insert_inverse = applyEdit(std::move(e));
    if (insert_inverse.kind == celestrian::Edit::Kind::Nop) return false;
  }
  take.clips = {clip};

  if (clip->getIntrinsicDuration() > 0) {
    // THE SECOND FORM: a new take of the slot (docs/takes.md) — the
    // file cut or zero-padded to the period, placed behind the shared
    // content base like a recorded new take, appended and made active.
    // Its re-time stands: a file was not performed against the slot.
    const int64_t period = clip->getIntrinsicDuration();
    const int64_t base = clip->getContentBase();
    const int channels = audio->getNumChannels();
    juce::AudioBuffer<float> cut(channels, (int)(base + period));
    cut.clear();
    const int copy = (int)std::min<int64_t>(period, audio->getNumSamples());
    for (int c = 0; c < channels; ++c) {
      cut.copyFrom(c, (int)base, *audio, c, 0, copy);
    }
    take.new_take = true;
    take.prev_active = {clip->activeTake()};
    clip->appendLoadedTake(cut);
    if (!clip->selectTake(clip->takeCount() - 1)) {
      juce::Logger::writeToLog("AudioEngine: import failed - the new take of " +
                               uuid + " could not be selected");
      return false;
    }
    pushUndo(celestrian::engine_internal::settleCommittedTake(*this, *root_node,
                                                             take));
    juce::Logger::writeToLog("AudioEngine: imported " + file.getFileName() +
                             " as take " + juce::String(clip->takeCount()) +
                             " of " + uuid + " (cut to the slot's period)");
    return true;
  }

  // THE FIRST FORM: a first take of an empty clip, at `origin_samples`
  // snapped to the nearest Q boundary of the island grid (Q11); a pre-Q
  // island takes the clock as the origin and the file's length as Q, as
  // a first recorded take does. Like a recorded commit it authors no
  // map: only an unsnapped length leaves the provisional [0, L) window
  // (loop_end 0 = none).
  const int64_t length = audio->getNumSamples();
  int64_t duration = length;
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
  const int64_t origin =
      q > 0 ? zero + (int64_t)std::llround((double)(origin_samples - zero) /
                                            (double)q) *
                          q
            : global_transport_pos.load();
  const int64_t context_cycle = q > 0 ? calculateEffectiveCycleLength() : 0;

  // Commit like a take: the island counts one while the content lands
  // and a first take establishes the island. (A callback that falls
  // inside the bracket reads a live take and holds the cursor view's
  // base for that block.)
  root_node->takeArmed();
  retireOwned(clip->installImportedTake(std::move(audio), origin, duration,
                                        loop_end, context_cycle));
  if (q == 0) root_node->establishIsland(duration, origin);
  root_node->takeCommitted();

  celestrian::Edit inv = celestrian::engine_internal::settleCommittedTake(
      *this, *root_node, take);
  if (insert_inverse.kind != celestrian::Edit::Kind::Nop) {
    inv.then = std::make_unique<celestrian::Edit>(std::move(insert_inverse));
  }
  pushUndo(std::move(inv));
  juce::Logger::writeToLog(
      "AudioEngine: imported " + file.getFileName() + " into " + uuid +
      " - origin " + juce::String(origin) + ", duration " +
      juce::String(duration) + (q == 0 ? " (establishes Q)" : ""));
  return true;
}
