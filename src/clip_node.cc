// ClipNode — the leaf (clip_node.h maps its four files). Here:
// construction, the content swaps, and what the UI reads — the metadata
// and the peaks. Message thread.

#include "clip_node.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <array>
#include <cmath>

namespace celestrian {

ClipNode::ClipNode(juce::String node_name, double source_sample_rate)
    : AudioNode(std::move(node_name)), sample_rate(source_sample_rate) {
  // A leaf is anchored by construction: its frame is always its own
  // origin.
  setAnchor(true, 0, 0);
  swapContent(makeEmptyContent());
  swapMidi(std::make_unique<MidiSequence>(0));
  // What the const render must never grow: the scratch pair, held for
  // the block ceiling, and the block's MIDI, for the most a block hands
  // it.
  fx_scratch_.resize(kMaxBlockSamples, 0.0f);
  fx_scratch2_.resize(kMaxBlockSamples, 0.0f);
  render_midi_.ensureSize((size_t)kMaxRenderMidiEvents * kMidiBufferEventBytes);
}

std::unique_ptr<juce::AudioBuffer<float>> ClipNode::makeEmptyContent() const {
  // The engine may construct a clip before a device reports its rate.
  auto empty = std::make_unique<juce::AudioBuffer<float>>(
      1, std::max(1, (int)sample_rate));
  empty->clear();
  return empty;
}

std::unique_ptr<juce::AudioBuffer<float>> ClipNode::swapContent(
    std::unique_ptr<juce::AudioBuffer<float>> fresh) {
  std::unique_ptr<juce::AudioBuffer<float>> displaced =
      std::move(content_owned_);
  content_owned_ = std::move(fresh);
  content_.store(content_owned_.get());
  return displaced;
}

std::unique_ptr<MidiSequence> ClipNode::swapMidi(
    std::unique_ptr<MidiSequence> fresh) {
  std::unique_ptr<MidiSequence> displaced = std::move(midi_owned_);
  midi_owned_ = std::move(fresh);
  midi_.store(midi_owned_.get());
  return displaced;
}

std::unique_ptr<TakeStorage> ClipNode::releaseStorage() {
  storage_rt_.store(nullptr);
  return std::move(take_storage_);
}

bool ClipNode::isMidiClip() const {
  if (contentKind() == ContentKind::Midi) return true;
  return duration_samples.load() <= 0 && !isArmedOrRecording() &&
         fxChain()->hasInstrumentSlot();
}

void ClipNode::startPlayback() {
  if (duration_samples.load() > 0) is_playing.store(true);
}

juce::var ClipNode::getMetadata() const {
  auto base = AudioNode::getMetadata();
  auto* obj = base.getDynamicObject();
  obj->setProperty("sampleRate", sample_rate);
  obj->setProperty("inputChannel", preferred_input_channel.load());
  obj->setProperty("inputChannelR", preferred_input_channel_right.load());
  obj->setProperty("monitor", (bool)monitor_.load());
  // 2 when the content is stereo, or the next take will be.
  obj->setProperty("channels",
                   contentChannels() >= 2 || isStereoInput() ? 2 : 1);
  obj->setProperty("isPendingStart", isPendingStart());
  obj->setProperty("isAwaitingStop", isAwaitingStop());
  obj->setProperty("contextCycle", (double)take_context_cycle_.load());
  obj->setProperty("isPlaying", (bool)is_playing.load());
  obj->setProperty("contentKind", isMidiClip() ? "midi" : "audio");
  obj->setProperty("midiEvents", midi_.load()->count());
  // A live new take shows in `isRecording` beside `takes`.
  obj->setProperty("takes", takeCount());
  obj->setProperty("activeTake", activeTake());
  juce::Array<juce::var> comp;
  for (const int c : compCells()) comp.add(c);
  obj->setProperty("comp", comp);
  // Cell k covers the content positions [compOffset + k·compCellLen,
  // compOffset + (k + 1)·compCellLen), in samples (0 and 0: no comp).
  obj->setProperty("compCellLen", (double)compCellLength());
  obj->setProperty("compOffset", (double)compCellOffset());
  return base;
}

juce::var ClipNode::getWaveform(int num_peaks) const {
  // The Idle load is the publication point: a commit stores Idle after
  // its last capture write, and only this thread arms. A read bounded by
  // the write head would not be safe mid-take — a through-map fold
  // scatters its writes across [0, C).
  if (recState() != RecState::Idle) return juce::Array<juce::var>();
  const int total_samples = (int)duration_samples.load();
  if (total_samples <= 0) return juce::Array<juce::var>();
  const int64_t base = content_base_.load();
  if (contentKind() == ContentKind::Midi) {
    return midiPeaks(*midi_.load(), base, total_samples, num_peaks);
  }
  return audioPeaks(*content_.load(), base, total_samples, num_peaks);
}

juce::var ClipNode::getTakeWaveform(int k, int num_peaks) const {
  if (recState() != RecState::Idle) return juce::Array<juce::var>();
  if (k < 0 || k >= takeCount()) return juce::Array<juce::var>();
  if (k == activeTake()) return getWaveform(num_peaks);
  const int total_samples = (int)duration_samples.load();
  if (total_samples <= 0) return juce::Array<juce::var>();
  const int64_t base = content_base_.load();
  const TakeState& s = takes_[(size_t)k];
  if (s.content_kind == (int)ContentKind::Midi && s.midi != nullptr) {
    return midiPeaks(*s.midi, base, total_samples, num_peaks);
  }
  if (s.buffer == nullptr) return juce::Array<juce::var>();
  return audioPeaks(*s.buffer, base, total_samples, num_peaks);
}

juce::var ClipNode::midiPeaks(const MidiSequence& seq, int64_t base,
                              int total_samples, int num_peaks) {
  // A MIDI take draws as a VELOCITY ENVELOPE in the peak lane: each
  // bucket's value is the loudest note sounding in it (held notes
  // sustain their velocity, releases drop it). Events before the base
  // only prime the held state.
  juce::Array<juce::var> peaks;
  peaks.ensureStorageAllocated(std::max(0, num_peaks));
  std::array<juce::uint8, 128> held{};
  held.fill(0);
  int cursor = 0;
  auto step = [&](int64_t until, int& cur) {
    while (cursor < seq.count() && seq[cursor].pos < until) {
      const MidiEvent& e = seq[cursor++];
      if (e.isNoteOn()) {
        held[(size_t)e.note()] = (juce::uint8)e.velocity();
        cur = std::max(cur, e.velocity());
      } else if (e.isNoteOff()) {
        held[(size_t)e.note()] = 0;
      }
    }
  };
  int dummy = 0;
  step(base, dummy);
  // The buckets are consecutive and gap-free: the cursor walks the take
  // once.
  for (int i = 0; i < num_peaks; ++i) {
    const PeakBucket b = peakBucket(i, total_samples, num_peaks);
    int cur = 0;
    for (const auto v : held) cur = std::max(cur, (int)v);
    step(base + b.end, cur);
    peaks.add((float)cur / 127.0f);
  }
  return peaks;
}

juce::var ClipNode::audioPeaks(const juce::AudioBuffer<float>& buffer,
                               int64_t base, int total_samples,
                               int num_peaks) {
  juce::Array<juce::var> peaks;
  peaks.ensureStorageAllocated(std::max(0, num_peaks));
  const int64_t cap = buffer.getNumSamples();
  const int chans = buffer.getNumChannels();
  // Base-relative reads: the cut material of a collapsed take never
  // draws. Stereo content draws the per-bucket max of both channels.
  for (int i = 0; i < num_peaks; ++i) {
    const PeakBucket b = peakBucket(i, total_samples, num_peaks);
    float peak = 0.0f;
    for (int c = 0; c < chans; ++c) {
      const float* data = buffer.getReadPointer(c);
      for (int64_t s = b.start; s < b.end; ++s) {
        const int64_t idx = base + s;
        if (idx < cap) peak = std::max(peak, std::abs(data[idx]));
      }
    }
    peaks.add(peak);
  }
  return peaks;
}

}  // namespace celestrian
