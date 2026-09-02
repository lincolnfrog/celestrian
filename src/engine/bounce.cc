// AudioEngine — BOUNCE (Q19, docs/bounce.md): the live render, offline.
// One effective cycle of the island root (or one effective period of
// any node) rendered through AudioNode::process with the same context
// the callback builds (engine_internal.h renderContext), then the
// effect tail, written as a stereo float WAV at the device rate.
// Message thread only; the device callback is detached for the render.

#include "../audio_engine.h"

#include <juce_audio_formats/juce_audio_formats.h>

#include <algorithm>
#include <cmath>
#include <memory>

#include "../clip_node.h"
#include "../graph_snapshot.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

namespace {

constexpr int kBounceBlock = 512;
/** The tail floor: a block whose peak stays under −90 dBFS is quiet. */
constexpr float kTailFloor = 3.1623e-5f;
constexpr double kTailQuietSeconds = 0.5;
constexpr double kTailCapSeconds = 10.0;

float blockPeak(const juce::AudioBuffer<float>& buffer, int start, int n) {
  float peak = 0.0f;
  for (int ch = 0; ch < buffer.getNumChannels(); ++ch) {
    peak = std::max(peak, buffer.getMagnitude(ch, start, n));
  }
  return peak;
}

/** The snapshot entry of `node`, or -1. */
int entryOf(const celestrian::GraphSnapshot& snap,
            const celestrian::AudioNode& node) {
  for (size_t i = 0; i < snap.entries.size(); ++i) {
    if (snap.entries[i].node == &node) return (int)i;
  }
  return -1;
}

bool writeStereoWav(const juce::File& file, double sample_rate,
                    const juce::AudioBuffer<float>& audio, int length) {
  file.getParentDirectory().createDirectory();
  file.deleteFile();
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::FileOutputStream> stream(file.createOutputStream());
  if (stream == nullptr || !stream->openedOk()) return false;
  // 32-bit float: the render, losslessly.
  std::unique_ptr<juce::AudioFormatWriter> writer(
      fmt.createWriterFor(stream.get(), sample_rate, 2, 32, {}, 0));
  if (writer == nullptr) return false;
  stream.release();  // the writer owns the stream now
  return writer->writeFromAudioSampleBuffer(audio, 0, length);
}

}  // namespace

bool AudioEngine::bounce(const juce::String& uuid,
                         const juce::String& wav_path) {
  // Refused mid-take: the render advances every leaf's control phase
  // on its own clock, which would corrupt a take's placement.
  if (root_node == nullptr) return false;
  if (root_node->hasActiveTake() || root_node->isArmedOrRecording()) {
    juce::Logger::writeToLog("AudioEngine: bounce refused - a take is live");
    return false;
  }
  celestrian::AudioNode* target = findNodeByUuid(root_node.get(), uuid);
  if (target == nullptr) {
    juce::Logger::writeToLog("AudioEngine: bounce refused - no node " + uuid);
    return false;
  }

  // THE SPAN (docs/bounce.md): the root renders one EFFECTIVE island
  // cycle from the island epoch; any other node one pass of its
  // effective period from its frame top, origin + a0 (a0 = its active
  // map's first segment start; an unanchored stack's frame is the
  // received island frame).
  const bool is_root = target == root_node.get();
  int64_t span = 0;
  int64_t top = 0;
  if (is_root) {
    span = islandCommittedClipCount() > 0 ? calculateEffectiveCycleLength() : 0;
    top = islandEpoch();
  } else {
    span = celestrian::StackNode::effectivePeriodOf(*target, nullptr);
    // A one-shot presents no period to its parent (Q5); its own pass is
    // its intrinsic length (the shot).
    if (span <= 0 && target->periodFromContext()) {
      span = target->getIntrinsicDuration();
    }
    const celestrian::timing::TimeMap map = target->activeTimeMap();
    const int64_t a0 = map.active() ? map.mapOffset(0) : 0;
    const bool anchored = target->getNodeType() == celestrian::NodeType::Clip ||
                          target->isAnchored();
    top = (anchored ? target->origin_samples.load() : islandEpoch()) + a0;
  }
  if (span <= 0) {
    juce::Logger::writeToLog("AudioEngine: bounce refused - " + uuid +
                             " has no committed content");
    return false;
  }

  // The device falls silent for the render: removeAudioCallback returns
  // only once no callback is in flight, so the graph's DSP scratch
  // (echo lines, plugin state) is advanced by exactly one renderer at a
  // time. Live effect tails are perturbed by the render (accepted).
  if (device_callback_registered_) device_manager.removeAudioCallback(this);

  // A FRESH snapshot for the render (the published one stays as it is;
  // it is immutable, so either would do — a private one keeps the
  // bounce's structure load independent of any concurrent republish).
  std::unique_ptr<celestrian::GraphSnapshot> snap(
      celestrian::buildGraphSnapshot(*root_node));
  const int self = entryOf(*snap, *target);
  jassert(self >= 0);

  const double sample_rate = cached_sample_rate_.load();
  const int64_t tail_cap = (int64_t)std::llround(kTailCapSeconds * sample_rate);
  const int64_t quiet_needed =
      (int64_t)std::llround(kTailQuietSeconds * sample_rate);
  juce::AudioBuffer<float> audio(2, (int)(span + tail_cap));
  audio.clear();

  // The render's own clock starts at the frame top: the monotonic
  // transport is untouched, so musical time never advances for the UI.
  int64_t clock = top;
  int64_t written = 0;
  auto renderBlock = [&](int n, bool content_silent) {
    celestrian::ProcessContext pc = celestrian::engine_internal::renderContext(
        *root_node, *snap, sample_rate, n, clock, /*is_playing=*/true);
    pc.self = self;
    pc.content_silent = content_silent;
    float* outs[2] = {audio.getWritePointer(0, (int)written),
                      audio.getWritePointer(1, (int)written)};
    target->process(nullptr, outs, 0, 2, pc);
    clock += n;
    written += n;
  };

  // The span, in whole blocks with a partial last one so the tail
  // begins exactly at the span's end.
  for (int64_t remaining = span; remaining > 0;) {
    const int n = (int)std::min<int64_t>(remaining, kBounceBlock);
    renderBlock(n, /*content_silent=*/false);
    remaining -= n;
  }

  // THE TAIL: content silent, racks ringing. Rendering continues until
  // the peak has stayed under the floor for half a second (or the cap);
  // the file keeps the tail through its FIRST block under the floor, so
  // a ringing tail ends below −90 dBFS and a node with nothing ringing
  // ends exactly at its span.
  int64_t kept = span;
  int64_t quiet_run = 0;
  bool close_pending = false;
  while (written - span < tail_cap && quiet_run < quiet_needed) {
    const int n = (int)std::min<int64_t>(tail_cap - (written - span),
                                         kBounceBlock);
    const int64_t block_start = written;
    renderBlock(n, /*content_silent=*/true);
    if (blockPeak(audio, (int)block_start, n) >= kTailFloor) {
      quiet_run = 0;
      kept = written;
      close_pending = true;
    } else {
      quiet_run += n;
      if (close_pending) {
        kept = written;
        close_pending = false;
      }
    }
  }
  if (written - span >= tail_cap) kept = written;  // capped: keep it all

  if (device_callback_registered_) device_manager.addAudioCallback(this);

  const juce::File file(wav_path);
  const bool ok = writeStereoWav(file, sample_rate, audio, (int)kept);
  juce::Logger::writeToLog(
      "AudioEngine: bounce of " + uuid + " -> " + file.getFullPathName() +
      (ok ? " (" + juce::String(span) + " span + " + juce::String(kept - span) +
                " tail samples @ " + juce::String(sample_rate) + ")"
          : " FAILED to write"));
  return ok;
}
